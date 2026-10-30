#!/usr/bin/env node
'use strict';
/*
 * 无限阅读 · ZIP 读写冒烟测试（src/core/zip.ts）
 *
 * 为什么专门测它：全量备份「带原图」全靠这个手写的 ZIP 编码器 —— CRC 算错、偏移写错、
 * 长度字段用错宽度，产出的包会「能下载但打不开」，而且往往到换设备还原时才发现。
 * 这里不开浏览器、不联网，用**独立的第二套实现**去验：
 *   - 用一个逐位实现的 CRC32 复算每个条目的校验值（不信被测量的那个表）
 *   - 手工解析中央目录，检查偏移真的指向对应的本地头、名字与长度自洽
 *   - 手工构造一个 deflate（方法 8）压缩的包，验证读取路径能解开第三方工具的产物
 * 用法：node eval/zip-smoke.js   [--json]
 */
const path = require('path');
const zlib = require('zlib');

global.window = global;
const Zip = require(path.join(__dirname, '..', 'src', 'core', 'zip.ts')).Zip;
if (!Zip || typeof Zip.build !== 'function' || typeof Zip.read !== 'function') {
  console.error('加载失败：Zip 导出缺失');
  process.exit(1);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name: name, hit: !!ok, detail: detail == null ? '' : String(detail) });
}

/* ---------------- 独立参照实现（刻意与被测代码不同写法） ---------------- */

// 逐位算 CRC32，不经查表 —— 表算错了这里就会露馅
function crc32Ref(buf) {
  let crc = ~0;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (~crc) >>> 0;
}

// 手工解析中央目录 + 本地头（只看 ZIP32 的固定字段）
function manualParse(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('找不到 EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let q = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(q) !== 0x02014b50) throw new Error('第 ' + i + ' 个中央目录条目签名不对');
    const e = {
      flags: buf.readUInt16LE(q + 8),
      method: buf.readUInt16LE(q + 10),
      crc: buf.readUInt32LE(q + 16),
      csize: buf.readUInt32LE(q + 20),
      usize: buf.readUInt32LE(q + 24),
      nameLen: buf.readUInt16LE(q + 28),
      rel: buf.readUInt32LE(q + 42),
    };
    e.name = buf.slice(q + 46, q + 46 + e.nameLen).toString('utf8');
    if (buf.readUInt32LE(e.rel) !== 0x04034b50) throw new Error(e.name + ' 的本地头签名不对');
    const lNameLen = buf.readUInt16LE(e.rel + 26);
    const lExtraLen = buf.readUInt16LE(e.rel + 28);
    e.localName = buf.slice(e.rel + 30, e.rel + 30 + lNameLen).toString('utf8');
    const start = e.rel + 30 + lNameLen + lExtraLen;
    e.data = buf.slice(start, start + e.csize);
    out.push(e);
    q += 46 + e.nameLen + buf.readUInt16LE(q + 30) + buf.readUInt16LE(q + 32);
  }
  return { entries: out, count: count };
}

const toBuf = async blob => Buffer.from(await blob.arrayBuffer());

/* ---------------- 1. 写：结构与校验 ---------------- */

(async () => {
  const text = JSON.stringify({ format: 'ir-backup', schema: 2, note: '中文 · 换设备也能读回来 😀' });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64, 7)]);
  const big = Buffer.alloc(200000);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 0xFF;   // 跨过 65535 边界，验 u32 长度字段

  const blob = await Zip.build([
    { name: 'ir-backup.json', data: text },
    { name: 'images/0001.png', data: new Blob([png], { type: 'image/png' }) },
    { name: 'images/0002.bin', data: big },
  ]);
  const buf = await toBuf(blob);

  check('产出的文件是 zip（PK\\x03\\x04 开头）', buf.readUInt32LE(0) === 0x04034b50,
    '前 4 字节 ' + buf.slice(0, 4).toString('hex'));

  let parsed = null;
  try { parsed = manualParse(buf); } catch (e) { check('中央目录可被独立解析', false, e.message); }
  if (parsed) {
    check('中央目录可被独立解析', parsed.count === 3, parsed.count + ' 个条目');
    const names = parsed.entries.map(e => e.name);
    check('条目顺序与内容不变', names.join(',') === 'ir-backup.json,images/0001.png,images/0002.bin', names.join(' '));
    const byName = {};
    parsed.entries.forEach(e => { byName[e.name] = e; });

    check('方法 8 之外一律 store（method=0），任何解压工具都能开',
      parsed.entries.every(e => e.method === 0), parsed.entries.map(e => e.method).join(','));
    check('文件名标记为 UTF-8（flag 0x800）',
      parsed.entries.every(e => (e.flags & 0x800) !== 0), '0x' + parsed.entries[0].flags.toString(16));
    check('本地头名字与中央目录名字一致（偏移没写错）',
      parsed.entries.every(e => e.localName === e.name), 'ok');

    const j = byName['ir-backup.json'];
    check('CRC32 与独立逐位实现一致（文本条目）', j.crc === crc32Ref(j.data), '0x' + j.crc.toString(16));
    check('CRC32 与独立逐位实现一致（二进制条目）',
      byName['images/0001.png'].crc === crc32Ref(byName['images/0001.png'].data), 'ok');
    check('大条目（200KB）长度字段没被截断成 16 位',
      byName['images/0002.bin'].usize === big.length && byName['images/0002.bin'].csize === big.length,
      byName['images/0002.bin'].usize + ' 字节');
    check('压缩后大小 = 原始大小（store 的约定）',
      parsed.entries.every(e => e.csize === e.usize), 'ok');
    check('数据区字节与原始一致（大条目）', byName['images/0002.bin'].data.equals(big), 'ok');
  }

  /* ---------------- 2. 读：自己写的包能读回来 ---------------- */

  const back = await Zip.read(buf);
  check('读回条目数一致', back.size === 3, back.size + ' 个');
  check('文本条目往返一致（含中文与 emoji）', (await back.get('ir-backup.json').text()) === text, 'ok');
  check('二进制条目逐字节一致',
    Buffer.from(await back.get('images/0001.png').arrayBuffer()).equals(png), 'ok');
  check('大条目逐字节一致',
    Buffer.from(await back.get('images/0002.bin').arrayBuffer()).equals(big), 'ok');

  /* ---------------- 3. 兼容性：外部工具 / 畸形输入 ---------------- */

  // 手工造一个 deflate 压缩的包（模拟第三方压缩工具），顺带把分隔符写成反斜杠（Windows 自带「压缩」的习惯）
  const rawJson = Buffer.from('{"format":"ir-backup","schema":2}', 'utf8');
  const deflated = zlib.deflateRawSync(rawJson);
  const name = Buffer.from('folder\\ir-backup.json', 'utf8');
  const head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034b50, 0);
  head.writeUInt16LE(20, 4); head.writeUInt16LE(8, 8); head.writeUInt16LE(0, 10); head.writeUInt16LE(0, 12);
  head.writeUInt32LE(crc32Ref(rawJson), 14);
  head.writeUInt32LE(deflated.length, 18); head.writeUInt32LE(rawJson.length, 22);
  head.writeUInt16LE(name.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8); cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(crc32Ref(rawJson), 16);
  cd.writeUInt32LE(deflated.length, 20); cd.writeUInt32LE(rawJson.length, 24);
  cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(0, 42);
  const eocd2 = Buffer.alloc(22);
  eocd2.writeUInt32LE(0x06054b50, 0);
  eocd2.writeUInt16LE(1, 8); eocd2.writeUInt16LE(1, 10);
  eocd2.writeUInt32LE(cd.length + name.length, 12);
  eocd2.writeUInt32LE(head.length + name.length + deflated.length, 16);
  const external = Buffer.concat([head, name, deflated, cd, name, eocd2]);

  let ext = null;
  try { ext = await Zip.read(external); } catch (e) { check('能读第三方工具压出来的包（方法 8）', false, e.message); }
  if (ext) {
    const got = ext.get('folder/ir-backup.json');
    check('能读第三方工具压出来的包（方法 8 deflate）', ext.size === 1, ext.size + ' 个条目');
    check('反斜杠路径归一化成正斜杠（Windows 压缩工具的坑）',
      !!got, [...ext.keys()].join(' '));
    check('deflate 条目的正文解压正确', got ? (await got.text()) === rawJson.toString('utf8') : false, 'ok');
  }

  const bad = [Buffer.from('这不是 zip'), Buffer.alloc(0), Buffer.from('PK\x03\x04' + 'x'.repeat(50), 'binary')];
  let rejected = 0, detail = '';
  for (const b of bad) {
    try {
      await Zip.read(b);
    } catch (e) { rejected++; detail = e.message.slice(0, 24); }
  }
  check('畸形输入一律报错，而不是静默返回半成品', rejected === bad.length, rejected + '/' + bad.length + ' · ' + detail);
  check('空包（没有条目）被拒绝', await Zip.build([]).then(() => false, () => true), 'ok');

  /* ---------------- 报告 ---------------- */
  const hit = results.filter(r => r.hit).length;
  if (process.argv.indexOf('--json') !== -1) {
    console.log(JSON.stringify({ hit: hit, total: results.length, checks: results }, null, 2));
  } else {
    console.log('无限阅读 · ZIP 读写冒烟测试（src/core/zip.ts）');
    for (const r of results) {
      console.log((r.hit ? '[命中] ' : '[未中] ') + r.name + (r.detail ? '  —— ' + r.detail : ''));
    }
    console.log('\n合计：' + hit + '/' + results.length + (hit === results.length ? ' ✅' : ' ❌'));
  }
  if (hit !== results.length) process.exit(1);
})().catch(e => {
  console.error('冒烟测试异常：' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
