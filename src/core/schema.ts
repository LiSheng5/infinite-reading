/*
 * src/core/schema.ts —— 档案形状的唯一口径（阶段 2：类型 + schema 回归测试的真源）
 *
 * 【类型以真实档案为准】下面的 interface 全部从 acceptance/0.12.1/fixture/ 的真实导出
 * （backup-plain.irbackup.json / story-choice-full.irstory.json / story-rp-full.irstory.json）
 * 与 store.ts 的 newStory / migrateStory / buildStoryPack 逐字段核对写成——
 * **不能反过来改档案**：校验器只检查必需字段的存在与基本类型，档案里的多余旧字段一律放行
 * （老存档带的历史键是数据，不是错误）。
 *
 * 【消费方式】
 *   - store.ts / tree.ts / providers.ts 的公开 API 用这些 interface 约束签名（TS 类型）；
 *   - eval/schema-test.js 用下面的 check* 运行时校验器跑夹具回归（schema 回归测试）：
 *     ① 三份真实夹具全部过检；② 导入 → 还原 → 导出逐字段一致；③ 0.11 及更早存档能迁移。
 */

/* ============================ 世界 / 风格 / 角色 ============================ */

export interface WorldCharacter {
  name: string;
  presence: string;
  personality: string;
  speech: string;
  note: string;
}

export interface World {
  place: string;
  time: string;
  characters: WorldCharacter[];
  threads: string[];
  relationship: { stage: string; bonds: string[]; notes: string };
  scene: string;
  updatedAt: number;
  scribeAt: number;
}

export interface StyleCard {
  id: string;
  version: number;
  locked: boolean;
  updatedAt: number;
  styleKeywords: string[];
  medium: string;
  palette: string;
  characters: Array<{ name: string; look: string }>;
  negative: string;
  note: string;
}

export interface RollingStyle {
  style: string;
  scenes: string;
  wardrobe: string;
  updatedAt: number;
}

export interface CharacterCard {
  name: string;
  appearance: string;
  personality: string;
  scene: string;
  opening: string;
  exampleDialogue: string;
  systemNote: string;
  source: string;
  updatedAt: number;
}

export interface UserProfileEntry {
  text: string;
  kind: string;           // 'fact' | 'preference' | 'taboo'
  updatedAt: number;
}

/* ================================ 日志条目 ================================ */

export interface NarrationEntry {
  type: 'narration';
  text: string;
  versions?: string[];
  activeVersion?: number;
  ts: number;
  nid?: string;           // 来自哪个树节点（§5⑧）
}

export interface PlayerEntry {
  type: 'player' | 'choice' | 'system';
  text: string;
  kind?: string | null;   // 'do' | 'say' | 'director' …
  ts: number;
}

export interface ToolEntry {
  type: 'tool';
  tool: string;
  summary: string;
  ts: number;
}

export interface ImageEntry {
  type: 'image';
  id: string;
  prompt: string;
  promptRaw?: string;
  alt: string;
  thumb: string | null;   // JPEG dataURL（safeThumb 只放行 data:/blob:）
  src?: string;           // 仅内存态（落盘前被 serializeStory 剥掉）
  imageId?: string;       // 原图 Blob 键
  model?: string;
  size?: string;          // v0.1 遗留
  aspect?: string;
  width?: number;
  height?: number;
  styleCardId?: string;
  ts: number;
}

export interface VideoEntry {
  type: 'video';
  id: string;
  alt: string;
  thumb: string | null;   // 视频封面（旧档 poster 同义）
  prompt: string;
  promptRaw?: string;
  mode?: string;          // 'i2v' | 't2v'
  model?: string;
  duration?: number;
  resolution?: string;
  ts: number;
  videoOmitted?: boolean; // 导出包里视频本体不随行（§0）
  remoteUrl?: string;     // 旧档 videoUrl 同义，仅降级用
}

export type LogEntry = NarrationEntry | PlayerEntry | ToolEntry | ImageEntry | VideoEntry;

/* =============================== 场景 / 存档点 =============================== */

export interface Scene {
  id: string;
  alt?: string;
  prompt?: string;
  promptRaw?: string;
  kind?: string;            // 'video' = 视频场景
  aspect?: string;
  width?: number;
  height?: number;
  styleCardId?: string;
  supersededBy?: string;
  thumb?: string | null;    // 图片缩略图 / 视频封面（旧档 poster 同义）
  imageId?: string;
  videoId?: string;
  sourceSceneId?: string;
  mode?: string;
  taskId?: string;
  remoteUrl?: string;
  duration?: number;
  resolution?: number | string;
  ratio?: string;
  model?: string;
  src?: string | null;      // 仅内存态
  ts?: number;
}

export interface Savepoint {
  id: string;
  name: string;
  ts: number;
  turn: number;
  mode: string;
  log: LogEntry[];
  messages: Array<{ role: string; content: string }>;
  summaries: string[];
  world: World;
  styleCard: StyleCard | null;
  rollingStyle: RollingStyle;
  characterCard: CharacterCard | null;
  userProfile: UserProfileEntry[];
  painterThread: unknown[];
  scenes: Scene[];
  lastBg: string | null;
  lastSceneSummary: string;
  nodeId?: string;
  tree?: StoryTree | null;
}

/* ================================ 分支树 ================================== */

export interface TreeAction {
  type: string;             // 'opening' | 'player' …
  text: string;
  kind?: string | null;
  sent?: string;
}

export interface TreeNode {
  id: string;
  parent: string | null;
  children: string[];
  active: string | null;
  kind: string;
  action: TreeAction | null;
  userMsg: { role: string; content: string } | null;
  assistantMsg: { role: string; content: string } | null;
  entries: LogEntry[];
  scenes: Scene[];
  sid: string | null;
  msgFloor: number;
  msgSnap: unknown;
  sealed: boolean;
  turn: number;
  ts: number;
  meta: Record<string, unknown>;
}

export interface TreeState {
  world: World;
  summaries: string[];
  rollingStyle: RollingStyle;
  painterThread: unknown[];
  lastSceneSummary: string;
  lastBg: string | null;
}

export interface StoryTree {
  v: number;
  root: string | null;
  head: string | null;
  nodes: Record<string, TreeNode>;
  states: Record<string, TreeState>;
}

/* ============================== 本对话偏好 ================================= */

export interface StoryPrefs {
  profileId?: string;
  profileLabel?: string;
  choices?: string;         // 'tray' | 'always'
  showReasoning?: boolean;
  tools?: { image?: boolean; memory?: boolean; schedule?: boolean; email?: boolean; payment?: boolean };
  ui?: Record<string, unknown>;
}

/* ================================ 故事 ==================================== */

export interface Story {
  schema: number;           // 当前 = 3
  id: string;
  title: string;
  titleAuto: boolean;
  titleGen: number;
  premise: string;
  mode: string;             // 'choice' | 'chat' | 'rp'
  createdAt: number;
  updatedAt: number;
  log: LogEntry[];
  world: World;
  styleCard: StyleCard | null;
  rollingStyle: RollingStyle;
  styleTone?: string;
  characterCard: CharacterCard | null;
  userProfile: UserProfileEntry[];
  painterThread: unknown[];
  messages: Array<{ role: string; content: string }>;
  summaries: string[];
  savepoints: Savepoint[];
  ui: Record<string, unknown>;
  turn: number;
  scenes: Scene[];
  lastBg: string | null;
  lastSceneSummary: string;
  pendingVideos: Array<{ taskId: string } & Record<string, unknown>>;
  tree?: StoryTree | null;
  prefs?: StoryPrefs;
}

/* ============================== 导出包格式 ================================ */

export interface PackImage {
  id: string;
  alt?: string;
  prompt?: string;
  promptRaw?: string;
  kind?: string;
  videoOmitted?: boolean;
  mode?: string;
  duration?: number;
  resolution?: string;
  aspect?: string;
  width?: number;
  height?: number;
  styleCardId?: string;
  thumb?: string | null;
  src?: string | null;
  ts?: number;
}

/** .irstory.json（buildStoryPack 的产物；kind = 'full' | 'premise'） */
export interface StoryPack {
  format: 'ir-story';
  schema: number;
  kind: string;
  app: string;
  title: string;
  premise: string;
  mode: string;
  styleTone?: string;
  world: World;
  styleCard: StyleCard | null;
  rollingStyle: RollingStyle | null;
  characterCard: CharacterCard | null;
  createdAt: number;
  updatedAt: number;
  images: PackImage[];
  log?: LogEntry[];
  messages?: Array<{ role: string; content: string }>;
  summaries?: string[];
  painterThread?: unknown[];
  userProfile?: UserProfileEntry[];
  turn?: number;
  lastSceneSummary?: string;
  tree?: StoryTree | null;
  prefs?: StoryPrefs | null;
}

/** zip 带原图备份里的 images 清单条目 */
export interface BackupImageEntry {
  id: string;
  path: string;
  type: string;
  size: number;
}

/** .irbackup.json / zip 内 ir-backup.json（buildBackupPack 的产物） */
export interface BackupPack {
  format: 'ir-backup';
  schema: number;           // 1 = 无图清单；2 = 带 images 清单（zip）
  app: string;
  exportedAt: number;
  settings: Record<string, unknown>;
  userProfile: UserProfileEntry[];
  stories: Story[];
  images?: BackupImageEntry[];
}

/* ============================ 运行时校验器 ================================
 * 只检查「必需字段存在 + 基本类型对」；多余字段放行（老档案的历史键是数据）。
 * 每个 check* 返回问题清单（空数组 = 通过）。 */

function t(o: unknown): string { return o === null ? 'null' : (Array.isArray(o) ? 'array' : typeof o); }

function req(problems: string[], obj: any, path: string, key: string, want: string | string[]) {
  const list = Array.isArray(want) ? want : [want];
  const got = t(obj[key]);
  if (!list.includes(got)) problems.push(path + '.' + key + '：期望 ' + list.join('|') + '，得到 ' + got);
}

function reqArrOf(problems: string[], obj: any, path: string, key: string, item: (p: string, v: any) => void) {
  const v = obj[key];
  if (!Array.isArray(v)) { problems.push(path + '.' + key + '：期望 array，得到 ' + t(v)); return; }
  v.forEach((x, i) => item(path + '.' + key + '[' + i + ']', x));
}

function checkLogEntry(path: string, e: any, problems: string[]) {
  if (t(e) !== 'object') { problems.push(path + '：期望 object，得到 ' + t(e)); return; }
  req(problems, e, path, 'type', 'string');
  req(problems, e, path, 'ts', 'number');
  switch (e.type) {
    case 'narration': req(problems, e, path, 'text', 'string'); break;
    case 'player': case 'choice': case 'system': req(problems, e, path, 'text', 'string'); break;
    case 'tool': req(problems, e, path, 'tool', 'string'); req(problems, e, path, 'summary', 'string'); break;
    case 'image':
      req(problems, e, path, 'id', 'string');
      req(problems, e, path, 'alt', 'string');
      req(problems, e, path, 'thumb', ['string', 'null']);
      break;
    case 'video':
      req(problems, e, path, 'id', 'string');
      req(problems, e, path, 'thumb', ['string', 'null']);
      break;
    default: problems.push(path + '：未知条目类型 ' + JSON.stringify(e.type));
  }
}

function checkWorld(path: string, w: any, problems: string[]) {
  if (t(w) !== 'object') { problems.push(path + '：期望 object，得到 ' + t(w)); return; }
  req(problems, w, path, 'place', 'string');
  req(problems, w, path, 'time', 'string');
  req(problems, w, path, 'scene', 'string');
  reqArrOf(problems, w, path, 'characters', (p, c) => {
    if (t(c) !== 'object') { problems.push(p + '：期望 object'); return; }
    req(problems, c, p, 'name', 'string');
    req(problems, c, p, 'presence', 'string');
  });
  reqArrOf(problems, w, path, 'threads', (p, x) => { if (t(x) !== 'string') problems.push(p + '：期望 string'); });
}

function checkTreeNode(path: string, n: any, problems: string[]) {
  if (t(n) !== 'object') { problems.push(path + '：期望 object，得到 ' + t(n)); return; }
  req(problems, n, path, 'id', 'string');
  req(problems, n, path, 'parent', ['string', 'null']);
  req(problems, n, path, 'active', ['string', 'null']);
  req(problems, n, path, 'sid', ['string', 'null']);
  req(problems, n, path, 'sealed', 'boolean');
  req(problems, n, path, 'turn', 'number');
  req(problems, n, path, 'msgFloor', 'number');
  reqArrOf(problems, n, path, 'children', (p, x) => { if (t(x) !== 'string') problems.push(p + '：期望 string'); });
  reqArrOf(problems, n, path, 'entries', (p, e) => checkLogEntry(p, e, problems));
}

function checkTree(path: string, tree: any, problems: string[]) {
  if (t(tree) !== 'object') { problems.push(path + '：期望 object，得到 ' + t(tree)); return; }
  req(problems, tree, path, 'v', 'number');
  req(problems, tree, path, 'root', ['string', 'null']);
  req(problems, tree, path, 'head', ['string', 'null']);
  if (t(tree.nodes) !== 'object') { problems.push(path + '.nodes：期望 object'); return; }
  for (const id of Object.keys(tree.nodes)) checkTreeNode(path + '.nodes[' + id + ']', tree.nodes[id], problems);
  if (t(tree.states) !== 'object') { problems.push(path + '.states：期望 object'); return; }
  for (const sid of Object.keys(tree.states)) {
    const s = tree.states[sid];
    if (t(s) !== 'object') { problems.push(path + '.states[' + sid + ']：期望 object'); continue; }
    checkWorld(path + '.states[' + sid + '].world', s.world, problems);
    reqArrOf(problems, s, path + '.states[' + sid + ']', 'summaries', (p, x) => { if (t(x) !== 'string') problems.push(p + '：期望 string'); });
  }
}

function checkScene(path: string, s: any, problems: string[]) {
  if (t(s) !== 'object') { problems.push(path + '：期望 object，得到 ' + t(s)); return; }
  req(problems, s, path, 'id', 'string');
  req(problems, s, path, 'thumb', ['string', 'null', 'undefined']);
}

/** story 存档形状（schema v3） */
function checkStory(story: any): string[] {
  const problems: string[] = [];
  if (t(story) !== 'object') return ['story：期望 object，得到 ' + t(story)];
  const path = 'story';
  req(problems, story, path, 'schema', 'number');
  req(problems, story, path, 'id', 'string');
  req(problems, story, path, 'title', 'string');
  req(problems, story, path, 'titleAuto', 'boolean');
  req(problems, story, path, 'titleGen', 'number');
  req(problems, story, path, 'premise', 'string');
  req(problems, story, path, 'mode', 'string');
  req(problems, story, path, 'createdAt', 'number');
  req(problems, story, path, 'updatedAt', 'number');
  req(problems, story, path, 'turn', 'number');
  req(problems, story, path, 'lastSceneSummary', 'string');
  req(problems, story, path, 'lastBg', ['string', 'null']);
  reqArrOf(problems, story, path, 'log', (p, e) => checkLogEntry(p, e, problems));
  reqArrOf(problems, story, path, 'messages', (p, m) => {
    if (t(m) !== 'object') { problems.push(p + '：期望 object'); return; }
    req(problems, m, p, 'role', 'string');
    req(problems, m, p, 'content', 'string');
  });
  reqArrOf(problems, story, path, 'summaries', (p, x) => { if (t(x) !== 'string') problems.push(p + '：期望 string'); });
  reqArrOf(problems, story, path, 'scenes', (p, s) => checkScene(p, s, problems));
  reqArrOf(problems, story, path, 'savepoints', (p, sp) => {
    if (t(sp) !== 'object') { problems.push(p + '：期望 object'); return; }
    req(problems, sp, p, 'id', 'string');
    req(problems, sp, p, 'name', 'string');
    req(problems, sp, p, 'ts', 'number');
    req(problems, sp, p, 'log', 'array');
    req(problems, sp, p, 'world', 'object');
  });
  reqArrOf(problems, story, path, 'userProfile', (p, x) => {
    if (t(x) !== 'object') { problems.push(p + '：期望 object'); return; }
    req(problems, x, p, 'text', 'string');
    req(problems, x, p, 'kind', 'string');
  });
  checkWorld(path + '.world', story.world, problems);
  if (story.tree != null) checkTree(path + '.tree', story.tree, problems);
  return problems;
}

/** .irstory.json 导出包形状 */
function checkStoryPack(pack: any): string[] {
  const problems: string[] = [];
  if (t(pack) !== 'object') return ['pack：期望 object，得到 ' + t(pack)];
  const path = 'pack';
  req(problems, pack, path, 'format', 'string');
  if (pack.format !== 'ir-story') problems.push(path + '.format 应为 ir-story，得到 ' + JSON.stringify(pack.format));
  req(problems, pack, path, 'schema', 'number');
  req(problems, pack, path, 'kind', 'string');
  req(problems, pack, path, 'title', 'string');
  req(problems, pack, path, 'premise', 'string');
  req(problems, pack, path, 'mode', 'string');
  req(problems, pack, path, 'createdAt', 'number');
  req(problems, pack, path, 'updatedAt', 'number');
  checkWorld(path + '.world', pack.world, problems);
  req(problems, pack, path, 'images', 'array');
  if (pack.kind === 'full') {
    req(problems, pack, path, 'log', 'array');
    req(problems, pack, path, 'messages', 'array');
    req(problems, pack, path, 'turn', 'number');
    if (pack.tree != null) checkTree(path + '.tree', pack.tree, problems);
  }
  return problems;
}

/** .irbackup.json 全量备份形状 */
function checkBackupPack(pack: any): string[] {
  const problems: string[] = [];
  if (t(pack) !== 'object') return ['backup：期望 object，得到 ' + t(pack)];
  const path = 'backup';
  req(problems, pack, path, 'format', 'string');
  if (pack.format !== 'ir-backup') problems.push(path + '.format 应为 ir-backup，得到 ' + JSON.stringify(pack.format));
  req(problems, pack, path, 'schema', 'number');
  req(problems, pack, path, 'exportedAt', 'number');
  req(problems, pack, path, 'settings', 'object');
  req(problems, pack, path, 'userProfile', 'array');
  reqArrOf(problems, pack, path, 'stories', (p, s) => {
    for (const e of checkStory(s)) problems.push(p + ' ← ' + e);
  });
  if (pack.images != null) {
    reqArrOf(problems, pack, path, 'images', (p, im) => {
      if (t(im) !== 'object') { problems.push(p + '：期望 object'); return; }
      req(problems, im, p, 'id', 'string');
      req(problems, im, p, 'path', 'string');
    });
  }
  return problems;
}

const Schema = {
  checkStory, checkStoryPack, checkBackupPack, checkTree,
};

export { Schema, checkStory, checkStoryPack, checkBackupPack, checkTree };
