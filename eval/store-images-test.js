#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · 删除故事与原图归属测试
 *
 * 只测数据层，不开浏览器、不联网：
 *   同一份带图备份导入两次、或「导出故事 → 再导入」，两个故事的 scene 会共用同一个 imageId。
 *   删除其中一个时，**只能释放没有其它故事再引用的原图**，否则另一个故事的画面只剩缩略图。
 *   这里用真实 store（IndexedDB 分支）跑一遍：共用图留下、独占图释放、log / tree 里的引用同样算数。
 *
 * 跑法：node eval/store-images-test.js（任一不过 → 退出码 1）
 *
 * 说明：Node 没有 IndexedDB。storage.ts 只在**模块加载时**做一次能力检测，所以先放一个
 * indexedDB 占位对象让它判定「可用」，再把 Storage 的读写方法换成进程内 Map——
 * store 只通过 Storage 这个门面访问存储，换掉门面就等价于换掉整个后端（不需要伪造事务 / 游标）。
 */
const path = require('path');

global.indexedDB = {};
global.window = global;
const core = f => require(path.join(__dirname, '..', 'src', 'core', f + '.ts'));

const Storage = core('storage').Storage;
if (!Storage || !Storage.available) {
  console.error('加载失败：Storage.available 不是 true（本测试需要 IndexedDB 分支）');
  process.exit(1);
}

// 进程内替身：kv / stories / images 三个「对象仓库」
const tables = { kv: new Map(), stories: new Map(), images: new Map() };
const table = name => tables[name] || (tables[name] = new Map());
Storage.get = (name, key) => Promise.resolve(table(name).has(key) ? table(name).get(key) : null);
Storage.put = (name, key, value) => { table(name).set(key, value); return Promise.resolve(true); };
Storage.del = (name, key) => { table(name).delete(key); return Promise.resolve(true); };
Storage.keys = name => Promise.resolve(Array.from(table(name).keys()));
Storage.entries = name => Promise.resolve(Array.from(table(name).entries()));

const Store = core('store').Store;
if (!Store) {
  console.error('加载失败：Store 导出缺失');
  process.exit(1);
}

let failed = 0;
function check(name, ok, detail) {
  if (ok) { console.log('  ok  ' + name); return; }
  failed += 1;
  console.error('FAIL  ' + name + (detail ? ' — ' + detail : ''));
}

// 原图在库里的原始记录（绕开 blobCache，确认的才是真正落盘状态）
function rawImage(id) {
  const rec = table('images').get(id);
  return rec && rec.blob ? rec : null;
}

async function main() {
  const boot = await Store.boot();
  check('存储后端 = indexeddb（否则本测试覆盖不到真实的释放路径）',
    boot.backend === 'indexeddb', JSON.stringify(boot));

  /* 故事 A：共用图 img-shared（scene）+ 独占图 img-solo（scene）
   * 故事 B：共用图 img-shared（scene）+ 只在 log 里引用的 img-log */
  const A = Store.newStory({ title: '删除方' });
  A.scenes = [
    { id: 'sc-a1', imageId: 'img-shared', alt: '共用', thumb: null, ts: 1 },
    { id: 'sc-a2', imageId: 'img-solo', alt: '独占', thumb: null, ts: 2 },
  ];
  const B = Store.newStory({ title: '保留方' });
  B.scenes = [{ id: 'sc-b1', imageId: 'img-shared', alt: '共用', thumb: null, ts: 3 }];
  B.log.push({ type: 'image', imageId: 'img-log', alt: '只在日志里', ts: 4 });
  Store.saveStory(A);
  Store.saveStory(B);

  ['img-shared', 'img-solo', 'img-log'].forEach(id => Store.putImage(id, new Blob(['x']), { from: 'test' }));
  await Store.flush();

  const keepBefore = Store.knownImageIds();
  check('保存后：三张图都已落盘',
    ['img-shared', 'img-solo', 'img-log'].every(id => !!rawImage(id)),
    JSON.stringify(Array.from(table('images').keys())));
  check('保存后：knownImageIds 认得出三张图（含只在 log 里引用的那张）',
    ['img-shared', 'img-solo', 'img-log'].every(id => keepBefore.has(id)),
    JSON.stringify(Array.from(keepBefore)));

  /* 删除 A：共用图必须留下，独占图必须释放 */
  Store.deleteStory(A.id);
  await Store.flush();

  check('共用图：删掉 A 后原图仍在（B 还引用着）',
    !!rawImage('img-shared'), '库里的图：' + JSON.stringify(Array.from(table('images').keys())));
  check('共用图：getImage 仍能取回 Blob（界面不会变裂图）',
    !!(await Store.getImage('img-shared')), 'null');
  check('独占图：删掉 A 后原图被释放（不留垃圾）',
    !rawImage('img-solo') && !(await Store.getImage('img-solo')),
    '库里的图：' + JSON.stringify(Array.from(table('images').keys())));
  check('log 引用：B 只在 log 里用的图不受影响',
    !!rawImage('img-log'), 'null');

  const keepAfter = Store.knownImageIds();
  check('删除后：knownImageIds 只掉 A 独占的那张（与「清理孤儿」同口径）',
    keepAfter.has('img-shared') && keepAfter.has('img-log') && !keepAfter.has('img-solo'),
    JSON.stringify(Array.from(keepAfter)));

  const B2 = Store.loadStory(B.id);
  check('保留方存档没被改动（scene 的 imageId 还在）',
    !!B2 && B2.scenes.length === 1 && B2.scenes[0].imageId === 'img-shared',
    B2 ? JSON.stringify(B2.scenes) : 'null');

  /* 反向控制：只被一个故事引用的图，删除时仍要释放（别为了「保住共用图」整段跳过） */
  const C = Store.newStory({ title: '孤儿' });
  C.scenes = [{ id: 'sc-c1', imageId: 'img-c', alt: '', thumb: null, ts: 5 }];
  Store.saveStory(C);
  Store.putImage('img-c', new Blob(['y']), { from: 'test' });
  await Store.flush();
  Store.deleteStory(C.id);
  await Store.flush();
  check('反向控制：独占图在删除时确实被释放（不是一律不释放）',
    !rawImage('img-c') && !(await Store.getImage('img-c')), '库里还有：' + JSON.stringify(Array.from(table('images').keys())));
}

main().then(() => {
  console.log('\n删除故事原图归属：' + (failed ? '有 ' + failed + ' 项失败' : '全部通过'));
  if (failed) process.exitCode = 1;
}).catch(e => {
  console.error('测试异常：' + ((e && e.stack) || e));
  process.exit(1);
});
