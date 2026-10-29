/*
 * src/core/backupPack.ts —— 全量备份的打包 / 解析纯逻辑（阶段 2 自 src/app/backup.js 抽出）
 *
 * 只搬数据变换，不碰界面（按钮态 / toast / 弹窗留在 src/app/backup.js，那里经 BackupPack 调用本模块）。
 * 函数体与 0.12.1 逐字一致（参数化了原先闭包里的 S.settings / Store 读取）；版本戳由
 * tools/sync-version.mjs 注入（本文件与 store.ts 各持一处）。
 *
 * 依赖：tree（clone）/ store / zip 都是静态 import——模块图是 DAG，不存在循环。
 */
import { clone, Tree } from './tree.ts';
import { Store } from './store.ts';
import { Zip } from './zip.ts';
import { APP_VERSION } from './version.ts';

/* 「带原图备份」= 一个 zip 里放两样东西：
 *   ir-backup.json      与普通备份完全同款（schema 2 只多一份 images 清单）
 *   images/0001.png …   原图按二进制原样存放
 * 为什么不把原图 base64 塞进 JSON：大图转 base64 体积涨约 1/3，还会在内存里堆成巨型字符串；
 * zip 装的是原始字节，体积最省，导出 / 导入都不容易把内存打爆。代价是 .zip 不能直接肉眼查看。 */
const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
  'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg',
};

// 导出包：默认剥掉 API Key（备份文件常被放进网盘，带 Key 等于把钱包一起备份）
// UI-3：模型库 profiles[] 同样走这把刀（默认不带 Key 的语义不变，只是覆盖新增的 profiles）
function buildBackupPack(settings: any, userProfile: any[], stories: any[], stripKeys: boolean) {
  const s = clone(settings);
  if (stripKeys) {
    ['chat', 'painter', 'scribe', 'draft', 'image', 'video'].forEach(k => { if (s[k]) s[k].apiKey = ''; });
    if (Array.isArray(s.profiles)) s.profiles.forEach((p: any) => { if (p) p.apiKey = ''; });
  }
  return {
    format: 'ir-backup', schema: 1, app: '无限阅读 v' + APP_VERSION,   // 构建注入
    exportedAt: Date.now(),
    settings: s,
    userProfile: userProfile,
    stories: stories,
  };
}

async function buildBackupZip(pack: any, onProgress?: (done: number, total: number, bytes: number) => void) {
  // 只打包「还有故事引用着」的原图：孤儿图（引用已被删）本来就要靠「清理孤儿原图」清掉，不进备份。
  // §0：视频本体不进备份（体积），只留封面——封面在 scene / log 的 thumb 里随 json 走。
  const ids: any[] = Array.from(Store.knownImageIds()).filter((id: any) => !/^vid:/.test(String(id)));
  const files: any[] = [];
  const manifest: any[] = [];
  let bytes = 0;
  for (let i = 0; i < ids.length; i++) {
    const blob = await Store.getImage(ids[i]);
    if (blob && blob.size) {
      const path = 'images/' + String(manifest.length + 1).padStart(4, '0') + '.' + (IMAGE_EXT[blob.type] || 'bin');
      files.push({ name: path, data: blob });
      manifest.push({ id: ids[i], path: path, type: blob.type || 'application/octet-stream', size: blob.size });
      bytes += blob.size;
    }
    if (onProgress) onProgress(i + 1, ids.length, bytes);
  }
  const body = Object.assign({}, pack, { schema: 2, images: manifest });
  files.unshift({ name: 'ir-backup.json', data: JSON.stringify(body, null, 1) });
  return { blob: await Zip.build(files), count: manifest.length, bytes: bytes };
}

// 备份正文的数据校验：过滤有效 story / 图片清单，算出 zip 里缺失的图片数（纯数据，不碰界面）
function parseBackup(obj: any, zipEntries: Map<string, any> | null) {
  const stories = (Array.isArray(obj.stories) ? obj.stories : []).filter((s: any) => s && s.id);
  // 带原图的备份：清单在正文里，图片本体在同包的 images/*（见 buildBackupZip）
  const manifest = Array.isArray(obj.images) ? obj.images.filter((x: any) => x && x.id && x.path) : [];
  const pending = zipEntries ? manifest.filter((x: any) => zipEntries.has(x.path)) : [];
  const missing = manifest.length - pending.length;
  return { stories: stories, manifest: manifest, pending: pending, missing: missing };
}

// 从一个 zip 里找备份正文：优先根目录，也接受「被塞进一层文件夹」的情况
function pickBackupJson(entries: Map<string, any>) {
  if (entries.has('ir-backup.json')) return entries.get('ir-backup.json');
  let best: any = null;
  for (const [name, blob] of entries) {
    if (!/(^|\/)ir-backup\.json$/i.test(name)) continue;
    if (!best || name.length < best.name.length) best = { name: name, blob: blob };
  }
  return best ? best.blob : null;
}

/* .irstory.json 完整档案 → story（阶段 2 自 src/app/backup.js 的 applyImport 数据段抽出，
 * 函数体与 0.12.1 逐字一致；界面侧（showShelf / 换键异步段）留在 src/app/backup.js）。
 * 产物：newStory 形状 + 包字段回填 + scenes 重建 + prefs 清洗 + tree 透传并 ensure。 */
function storyFromPack(obj: any) {
  const st = Store.newStory({
    title: (obj.title || '导入的故事') + '（导入）',
    premise: obj.premise || '',
    mode: obj.mode || 'choice',
    styleTone: obj.styleTone || '',
    world: obj.world || {},
    styleCard: obj.styleCard || null,
    rollingStyle: obj.rollingStyle || null,
    characterCard: obj.characterCard || null,
    userProfile: obj.userProfile || [],
    painterThread: obj.painterThread || [],
  });
  st.log = Array.isArray(obj.log) ? obj.log : [];
  st.messages = Array.isArray(obj.messages) ? obj.messages : [];
  st.summaries = Array.isArray(obj.summaries) ? obj.summaries : [];
  st.turn = obj.turn || 0;
  st.lastSceneSummary = obj.lastSceneSummary || '';
  st.scenes = (obj.images || []).map((im: any, i: number) => ({
    id: im.id || ('sc-imp' + i), alt: im.alt || '', prompt: im.prompt || '', promptRaw: im.promptRaw || '',
    aspect: im.aspect || '', width: im.width || 0, height: im.height || 0,
    // 视频条目：只随包带封面（videoOmitted），本体没导出——导入后显示「视频未随备份导出」
    kind: im.kind || undefined, videoOmitted: im.videoOmitted || undefined,
    mode: im.mode || undefined, duration: im.duration || undefined,
    // 导入档案不可信（审查 中危 #12）：thumb 白名单只放行 data:/blob:，坏数据不进存储
    thumb: Store.safeThumb(im.thumb), src: im.src || null, ts: Date.now(),
  }));
  st.lastBg = st.scenes.length ? st.scenes[st.scenes.length - 1].id : null;
  // UI-3 §3.4：本对话偏好随包导入（只有 profileId + 显示用标签；凭证在导出侧已剥）。
  // 本机没有该 profile 时 resolveChatCfg 自动回退默认，本对话设置面板会提示。
  if (obj.prefs && typeof obj.prefs === 'object') st.prefs = Store.sanitizePrefsSafe(obj.prefs);
  st.tree = obj.tree ? clone(obj.tree) : null;   // full 包带的分支树（§5⑧）
  Tree.ensure(st);                               // 导入后建 / 校验树（无树旧包 → 线性链）
  return st;
}

const BackupPack = {
  IMAGE_EXT,
  buildBackupPack,
  buildBackupZip,
  parseBackup,
  pickBackupJson,
  storyFromPack,
};

export { BackupPack, IMAGE_EXT, buildBackupPack, buildBackupZip, parseBackup, pickBackupJson, storyFromPack };
