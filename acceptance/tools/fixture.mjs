/*
 * acceptance/tools/fixture.mjs —— 回归夹具（阶段 0 / 0.12.1）
 *
 * 任务书 §5 阶段 0：「准备一份真实形态的备份（多个故事，含分支、存档点、图片、视频、角色卡、
 * 用户画像），后续每阶段都要能导入、还原、再导出，并与原文件逐字段比对。」
 *
 * 产物（acceptance/0.12.1/fixture/）：
 *   backup-plain.irbackup.json      「一键导出全部备份」（不带原图 / 不带 API Key）——真实 UI 导出
 *   backup-with-src.zip             「一键导出全部备份（带原图）」——真实 UI 导出
 *   story-choice-full.irstory.json  单故事完整档案（剧情 + 分支 + 图 + 视频 + 存档点，带原图）
 *   story-rp-full.irstory.json      单故事完整档案（扮演 + 角色卡 + 用户画像）
 *   fixture-seed.json               播种清单 + 各产物 sha256 + 易变字段口径
 *   roundtrip-report.json           roundtrip 逐字段比对报告（roundtrip 命令写）
 *
 * 用法：
 *   node acceptance/tools/fixture.mjs build      # 播种真实形态数据 → 真实 UI 导出三种格式
 *   node acceptance/tools/fixture.mjs roundtrip  # 干净上下文：导入夹具 → 还原 → 再导出 → 逐字段比对
 *   node acceptance/tools/fixture.mjs all        # build + roundtrip
 *
 * 约定：
 *  - 只新增文件，不改任何应用源码；页面一律 file:// 打开（双击 index.html 的真实形态），不联网。
 *  - Chromium 走系统 Chrome（channel:'chrome'），不下载浏览器。
 *  - 播种数据的形状以 0.12.1 真实写入路径为准：
 *      回合       → IR.Tree.begin / commit / seal（与 js/app/round.js·turn.js 同口径）
 *      日志条目   → IR.Context.narrationEntry / assistantEntry / absorbToolCalls / mergeWorld / compressStory
 *      晚到的图   → IR.Tree.pushLate（sealed 节点后补图，painter.js 的真实路径）
 *      原图 / 视频 → IR.Store.putImage / putVideo，键名 img:<sceneId> / vid:<sceneId>（同 storeOriginal）
 *      存档点     → IR.App.addSavepoint（library.js snapshotStory 的真实路径）
 *  - 「导出 / 导入」一律走真实 UI（#btn-backup-all / #btn-do-export / #file-import + 确认弹窗），
 *    夹具文件 = 用户真能拿到的文件。
 *  - 逐字段比对只放行「注定会变」的字段（导出时刻 / 版本串 / 导入刷新的 updatedAt 等），
 *    口径写进 fixture-seed.json 与 roundtrip-report.json；其余任何字段不一致都算失败。
 */
import { createRequire } from 'module';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const OUT = path.join(ROOT, 'acceptance', '0.12.1', 'fixture');
const APP_URL = pathToFileURL(path.join(ROOT, 'index.html')).href;

// zip 读写用应用自己的 js/zip.js（Node 里 require 与 eval/zip-smoke.js 同款用法）：
// 夹具比对的是「同一份代码打出的包」，解析器也必须是同一份，避免两套 zip 实现各自有偏差。
require(path.join(ROOT, 'js', 'zip.js'));
const Zip = (globalThis.IR && globalThis.IR.Zip) || null;

const log = (...a) => console.log('[fixture]', ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const trunc = v => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s == null ? '(undefined)' : (s.length > 160 ? s.slice(0, 160) + '…' : s);
};

/* ================= 比对口径：注定会变的字段（唯一放行清单） ================= */

// 全量备份（ir-backup / zip 内的 ir-backup.json）
const RULES_BACKUP = {
  label: '全量备份',
  ignore: [
    ['exportedAt'],                  // 导出时刻
    ['app'],                         // 版本串随发版变（sync-version.mjs 注入）
    ['stories', '*', 'updatedAt'],   // saveStory 会把 updatedAt 刷成导入落盘时刻
    ['images', '*', 'path'],         // zip 里图片按收集顺序编号，键对不上是顺序差异不是数据差异（按 id 对齐后逐字节比）
  ],
  normalize: [],
};
// 单故事档案（ir-story）
const RULES_STORY = {
  label: '单故事档案',
  ignore: [
    ['createdAt'],                   // 导入新建故事，创建时刻必变
    ['updatedAt'],                   // 同上
    ['images', '*', 'ts'],           // 导入重建 scenes 时 ts = 导入时刻（视频条目会带出旧 ts，再导出即新 ts）
  ],
  normalize: [
    [['title'], v => String(v == null ? '' : v).replace(/（导入）$/, '')],  // 导入加「（导入）」后缀
  ],
};

/* ================= 播种内容（真实形态：分支 / 存档点 / 图 / 视频 / 角色卡 / 画像） ================= */

const FAKE_KEY = 'sk-fixture-DO-NOT-LEAK';

// 剧情故事「雨夜便利店」的回合（内容原创、形状照抄真实回包：narration / choices /
// scene_change / scene_summary / world / tool_calls / reasoning 全覆盖）
const TURNS_A = [
  {
    actionType: 'opening',
    text: '（故事开场。请描写第一幕，把玩家带进场景。）',
    reply: {
      narration: '凌晨的雨把街道泡成深色。自动门「叮」地一声为你让开，暖气混着关东煮的味道扑面而来。收银台旁立着一台旧收音机，红色旋钮被磨得发亮，沙沙地放着老歌。',
      choices: ['走向关东煮的柜台', '和店员搭话', '随意浏览货架'],
      scene_change: true,
      scene_summary: '雨夜便利店内部，暖黄灯光，收银台旁一台红色旋钮的旧收音机，落地玻璃外是湿漉漉反光的街道',
      world: { place: '雨夜便利店（收银台与货架区）', time: '深夜·雨夜', scene: '收银台旁一台红色旋钮的旧收音机，暖黄灯光' },
    },
  },
  {
    actionType: 'player', kind: 'do', text: '走到关东煮的柜台前，看了看锅边的便签',
    reply: {
      narration: '锅咕嘟咕嘟地翻着小泡。锅边贴着一张手写便签：「过了三点，就别再添汤了。」你余光瞥见便签背面还有一行小字，被蒸汽熏得快看不清了。',
      choices: ['问店员便签是谁写的', '夹一串萝卜', '回到收银台那边'],
      scene_change: false,
      scene_summary: '第三排货架前冒着热气的关东煮锅，锅边一张手写便签',
      world: { place: '雨夜便利店·第三排货架（关东煮）', threads: ['锅边便签：过了三点就别再添汤'] },
      tool_calls: [
        { id: 'call-recall-1', type: 'function', function: { name: 'recall_world_state', arguments: '{}' }, result: { place: '雨夜便利店', time: '深夜·雨夜', characters: [], threads: ['锅边便签：过了三点就别再添汤'] } },
      ],
    },
  },
  {
    actionType: 'choice', kind: 'do', text: '和店员搭话',
    reply: {
      reasoning: '玩家选了「和店员搭话」。店员是关键线索人物，给他起个名字周叙，说话带点反问，把「凌晨三点」的传闻递出去。',
      narration: '店员是个二十出头的年轻人，正在给饭团补货。他抬头看你一眼：「避雨？这场雨要下到凌晨三点。」——凌晨三点。他说这三个字时，收音机的沙沙声恰好停了一拍。',
      choices: ['问他凌晨三点会发生什么', '买一杯热咖啡', '假装没听见，继续逛'],
      scene_change: true,
      scene_summary: '便利店收银台附近，年轻店员周叙在货架间补货，暖光',
      world: { time: '凌晨两点多；传闻凌晨三点有事发生', characters: [{ name: '周叙', presence: '在场', personality: '话里有话、克制、爱反问', speech: '简短、喜欢反问', note: '今晚看店的年轻店员' }] },
    },
  },
  {
    actionType: 'player', kind: 'say', text: '「这场雨要下到凌晨三点？」我重复了一遍他的话。',
    reply: {
      narration: '周叙码饭团的手停了一下，胶带撕开的声音格外清晰。「传闻嘛，听听就好。」他把一排饭团码得整整齐齐，忽然抬眼盯着你，「不过——你要是非得在凌晨三点买东西，我劝你，挑便宜的就走。」',
      choices: ['追问为什么是便宜的东西', '换个话题聊聊这场雨'],
      scene_change: false,
      scene_summary: '货架间，店员回头看向镜头，表情介于笑意与警惕之间',
      world: { threads: ['锅边便签：过了三点就别再添汤', '周叙的劝告：挑便宜的就走'] },
      tool_calls: [
        { id: 'call-mem-1', type: 'function', function: { name: 'update_memory', arguments: '{"world":{"relationship":{"notes":"周叙话里有话，似乎知道凌晨三点的事"}},"text":"周叙话里有话，似乎知道凌晨三点的事"}' }, result: { ok: true, written: 'world.relationship.notes' } },
      ],
    },
  },
  {
    actionType: 'player', kind: 'do', text: '抬头看墙上的挂钟',
    reply: {
      narration: '墙上的挂钟停在 2:47，秒针纹丝不动，像是被人按住了。可窗外的雨声分明还在走。周叙顺着你的视线看过去，笑了笑：「那钟早坏了，别管它。」',
      choices: ['问他店里的钟为什么坏了', '继续盯着挂钟看'],
      scene_change: true,
      scene_summary: '墙上停摆的挂钟，指针凝固在 2:47，暖光边缘泛着冷',
      world: { time: '挂钟停在 2:47；传闻凌晨三点有事发生', scene: '墙上停摆的挂钟，指针凝固在 2:47' },
    },
    paintAfter: 'image',
  },
  {
    actionType: 'player', kind: 'do', text: '回到收银台旁听收音机',
    reply: {
      narration: '收音机里的老歌忽然断了，插进一段听不清的电流声，隐约像有人在数数：一、二、三、四……数到七就没了下文。',
      choices: ['凑近收音机听清楚', '伸手去转调频旋钮'],
      scene_change: false,
      scene_summary: '收银台旁那台红色旋钮的旧收音机，电流声里的模糊人影',
    },
    paintAfter: 'image',
  },
  {
    // 分支：从第 5 回合（挂钟）的节点换条路走（Tree.switchTo 后再 commit = 真实分叉流程）
    forkAfterTurnIndex: 4,
    actionType: 'player', kind: 'do', text: '我没有理会收音机，先去把那扇虚掩的门推开了',
    reply: {
      narration: '门后是一条窄得不像话的储物间过道，灯泡在头顶忽明忽暗。尽头堆着没拆封的纸箱，最上面那只箱子的胶带被人重新贴过，边缘还留着指甲的划痕。',
      choices: ['拆开那只箱子', '退回店里'],
      scene_change: true,
      scene_summary: '储物间过道，忽明忽暗的灯泡，尽头堆着纸箱',
      world: { place: '便利店储物间过道', scene: '灯泡忽明忽暗，尽头堆着纸箱' },
    },
    paintAfter: 'video',
  },
];

const STORY_A_PREMISE = [
  '标题：雨夜便利店',
  '世界：现代都市，深夜的便利店，外面下着大雨，店里灯光昏黄，收音机放着老歌。',
  '你的角色：一位进来避雨的夜班顾客（你可以随时扮演成任何人、做任何事）。',
  'AI 扮演：旁白，以及店里的一切——店员、常客、广播里的声音……',
  '风格：克制的悬疑，日常里藏着一丝奇异。剧情随玩家的行动自由生长。',
  '人物：周叙｜话里有话、克制、爱反问｜简短、喜欢反问',
  '伏笔：锅边便签；挑便宜的就走',
].join('\n');

/* ================= 小工具：真实 UI 的入口动作 ================= */

async function openApp(page, query) {
  await page.goto(APP_URL + (query || ''), { waitUntil: 'load' });
  await page.waitForFunction(() => !!(window.IR && IR.App && IR.Store), null, { timeout: 15000 });
  await sleep(500);
}

async function setCheckbox(page, id, on) {
  await page.evaluate(([id, on]) => {
    const el = document.getElementById(id);
    if (!el) throw new Error('找不到控件 #' + id);
    el.checked = !!on;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, [id, on]);
}

async function captureDownload(page, act) {
  const [dl] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    act(),
  ]);
  const file = await dl.path();
  return fs.readFileSync(file);
}

// 先到书架（设置 / 行菜单的入口都在书架屏幕上）
async function gotoShelf(page) {
  if (await page.locator('#screen-shelf:not(.hidden)').count()) return;
  await page.click('#btn-start-shelf');
  await page.waitForSelector('#screen-shelf:not(.hidden)');
  await sleep(400);
}

// 设置 → 数据（「一键导出全部备份」所在地）
async function openSettingsData(page) {
  await gotoShelf(page);
  await page.click('#btn-shelf-settings');
  await page.waitForSelector('#modal-settings:not(.hidden)');
  await sleep(400);
  if (await page.locator('#set-back:not(.hidden)').count()) await page.click('#set-back');
  await page.click('.set-nav-item[data-group="g-data"]');
  await sleep(300);
}

// 「一键导出全部备份」：withSrc=false → .irbackup.json；true → .zip（本地没有原图时自动退化 json）
async function exportBackup(page, { withSrc, withKeys }) {
  await openSettingsData(page);
  await setCheckbox(page, 'backup-with-src', withSrc);
  await setCheckbox(page, 'backup-with-keys', withKeys);
  const buf = await captureDownload(page, () => page.click('#btn-backup-all'));
  await sleep(300);
  await page.click('#btn-close-settings');
  await sleep(200);
  return buf;
}

// 书架行菜单 → 导出弹窗 → #btn-do-export（完整档案）
async function exportStoryPack(page, storyId, { withSrc }) {
  await gotoShelf(page);
  await page.click('#shelf-row-' + storyId + ' .shelf-row-more');
  await page.waitForSelector('.row-menu');
  await page.locator('.row-menu .menu-item', { hasText: '导出' }).first().click();
  await page.waitForSelector('#modal-export:not(.hidden)');
  await page.evaluate(() => {
    const r = document.querySelector('input[name="export-kind"][value="full"]');
    if (r) r.checked = true;
    const s = document.getElementById('export-src');
    if (s) s.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await setCheckbox(page, 'export-src', withSrc);
  const buf = await captureDownload(page, () => page.click('#btn-do-export'));
  await sleep(300);
  return buf;
}

// 真实导入入口：隐藏 input #file-import + irConfirm 确认弹窗（备份类才有确认）
async function importFile(page, file) {
  await page.setInputFiles('#file-import', file);
  const hasConfirm = await page.waitForSelector('#modal-confirm:not(.hidden)', { timeout: 8000 })
    .then(() => true).catch(() => false);
  if (hasConfirm) {
    await sleep(200);
    await page.click('#cf-ok');
    await page.waitForSelector('#modal-confirm.hidden', { timeout: 8000 }).catch(() => {});
  }
}

/* ================= build：播种 + 真实 UI 导出 ================= */

async function buildFixture() {
  log('== build：播种真实形态数据 ==');
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN', reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const consoleErrors = [];
  page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', e => consoleErrors.push('pageerror: ' + String(e).slice(0, 200)));

  try {
    await openApp(page, '');
    const seedResult = await seedInPage(page);
    if (!seedResult.ok) throw new Error('播种失败：' + JSON.stringify(seedResult.errors));
    log('  播种完成：', seedResult.stories.map(s => `《${s.title}》(${s.mode}, turn=${s.turn}, 节点=${s.treeNodes}, 存档点=${s.savepoints}, 图=${s.images}, 视频=${s.videos})`).join('；'));

    // —— 真实 UI 导出三种格式 ——
    const plain = await exportBackup(page, { withSrc: false, withKeys: false });
    const zip = await exportBackup(page, { withSrc: true, withKeys: false });
    // 带 Key 的备份只验证「Key 在里面」，不落盘（安全红线：夹具目录里永远没有 Key）
    const withKeys = await exportBackup(page, { withSrc: false, withKeys: true });
    const withKeysObj = JSON.parse(withKeys.toString('utf8'));
    const keyLeak = ['chat', 'painter', 'scribe', 'draft', 'image', 'video'].some(k => withKeysObj.settings && withKeysObj.settings[k] && withKeysObj.settings[k].apiKey);
    const plainObj = JSON.parse(plain.toString('utf8'));
    const keyStripped = ['chat', 'painter', 'scribe', 'draft', 'image', 'video'].every(k => !plainObj.settings[k] || !plainObj.settings[k].apiKey)
      && (plainObj.settings.profiles || []).every(p => !p || !p.apiKey);
    if (!keyLeak) throw new Error('带 Key 导出里没读到 Key（播种的 Key 没进 settings？）');
    if (!keyStripped) throw new Error('默认导出里仍有 API Key —— 安全红线被破坏');
    log('  API Key 校验：带 Key 导出含 Key、默认导出已剥净 ✓');

    const storyChoiceId = seedResult.stories[0].id;   // 雨夜便利店
    const storyRpId = seedResult.stories[1].id;       // 角色卡故事
    const storyChoice = await exportStoryPack(page, storyChoiceId, { withSrc: true });
    const storyRp = await exportStoryPack(page, storyRpId, { withSrc: false });

    const artifacts = [
      { file: 'backup-plain.irbackup.json', bytes: plain, kind: 'ir-backup', withSrc: false, rules: 'RULES_BACKUP' },
      { file: 'backup-with-src.zip', bytes: zip, kind: 'ir-backup-zip', withSrc: true, rules: 'RULES_BACKUP + 逐图字节' },
      { file: 'story-choice-full.irstory.json', bytes: storyChoice, kind: 'ir-story', withSrc: true, rules: 'RULES_STORY' },
      { file: 'story-rp-full.irstory.json', bytes: storyRp, kind: 'ir-story', withSrc: false, rules: 'RULES_STORY' },
    ];
    for (const a of artifacts) {
      fs.writeFileSync(path.join(OUT, a.file), a.bytes);
      a.sha256 = sha256(a.bytes);
      a.size = a.bytes.length;
      delete a.bytes;
      log('  导出', a.file, '(' + a.size + ' bytes, sha256 ' + a.sha256.slice(0, 12) + '…)');
    }

    const seedManifest = {
      project: 'infinite-reading',
      version: '0.12.1',
      stage: '0（迁移基线）· 回归夹具',
      generatedAt: new Date().toISOString(),
      tool: 'acceptance/tools/fixture.mjs build',
      entry: APP_URL,
      how: {
        seed: '页面内经 IR.Store / IR.Tree / IR.Context 的真实写入路径播种（见 fixture.mjs 头注）',
        export: '全部经真实 UI：设置→数据→「一键导出全部备份」/ 书架行菜单→导出弹窗',
      },
      stories: seedResult.stories,
      globalUserProfile: seedResult.globalUserProfile,
      artifacts,
      comparePolicy: {
        backup: RULES_BACKUP,
        story: RULES_STORY,
        zipExtra: 'zip 里的 images/* 按 manifest 的 id 对齐后逐字节 sha256 比对（path 编号差异放行）',
        note: '除以上放行字段外，任何字段不一致都算回归失败；发现不一致立即回滚该阶段（任务书 §11）。',
      },
      consoleErrors,
    };
    fs.writeFileSync(path.join(OUT, 'fixture-seed.json'), JSON.stringify(seedManifest, null, 2), 'utf8');
    log('build done →', path.join(OUT, 'fixture-seed.json'));
  } finally {
    await browser.close();
  }
}

// 在页面里播种（真实写入路径）
async function seedInPage(page) {
  return page.evaluate(async ({ turnsA, premiseA, FAKE_KEY }) => {
    const { Store, Tree, Context } = window.IR;
    const out = { ok: true, errors: [], stories: [], globalUserProfile: [], images: [], videos: [] };
    let clock = Date.now() - 30 * 24 * 3600 * 1000;   // 时间戳铺在过去 30 天内，单调递增
    const nextTs = () => (clock += 61 * 1000);
    const now = () => clock;

    const makeThumb = (i) => {
      const c = document.createElement('canvas');
      c.width = 120; c.height = 80;
      const g = c.getContext('2d');
      const grad = g.createLinearGradient(0, 0, 120, 80);
      grad.addColorStop(0, '#1d2a44');
      grad.addColorStop(1, '#3c5a80');
      g.fillStyle = grad;
      g.fillRect(0, 0, 120, 80);
      g.fillStyle = ['#d9822b', '#c0392b', '#27ae60', '#8e44ad'][i % 4];
      g.fillRect(12 + i * 9, 12, 46, 46);
      g.fillStyle = '#f5ecd7';
      g.fillRect(70, 40 + (i % 3) * 6, 34, 12);
      return { thumb: c.toDataURL('image/jpeg', 0.72), png: c.toDataURL('image/png') };
    };

    // —— 回合：与 js/app/round.js / eval/run.js 同口径 ——
    function playTurn(st, t, opening) {
      const ts = nextTs();
      const mark = Tree.begin(st);
      const raw = String(t.text || '');
      const sent = opening
        ? t.text
        : (st.mode === 'chat' ? raw : '（' + (t.kind === 'say' ? '说' : t.kind === 'direct' ? '导演' : '做') + '）' + raw);
      if (!opening) {
        st.log.push({ type: t.actionType === 'choice' ? 'choice' : 'player', text: raw, kind: t.kind || 'do', ts });
      }
      const userMsg = { role: 'user', content: Context.playerContent(st.premise, sent, opening ? { includePremise: true } : undefined) };
      const r = t.reply || {};
      const rr = {
        narration: r.narration || '', choices: r.choices || [],
        scene_change: !!r.scene_change, scene_summary: r.scene_summary || '',
      };
      if (r.world) Context.mergeWorld(st.world, r.world);
      const asst = Context.assistantEntry(rr, r.reasoning || '');
      const narr = Context.narrationEntry(rr.narration, r.reasoning || '', ts);
      st.log.push(narr);
      st.messages.push(userMsg, asst);
      if (r.tool_calls) {
        Context.absorbToolCalls(st, r.tool_calls, {
          applyProfile: entries => { st.userProfile = Context.mergeProfile(st.userProfile || [], entries); },
          now: ts,
        });
      }
      st.turn += 1;
      st.lastSceneSummary = rr.scene_summary || st.lastSceneSummary;
      Context.compressStory(st, { summarize: Context.localSummarize });
      const node = Tree.commit(st, {
        action: opening
          ? { type: 'opening', text: t.text, kind: null, sent: t.text }
          : { type: t.actionType === 'choice' ? 'choice' : 'player', text: raw, kind: t.kind || 'do', sent },
        userMsg, assistantMsg: asst, logMark: mark.logMark,
        meta: { model: 'fixture-chat-model' },
      });
      Tree.seal(st, node.id);
      return node;
    }

    // —— 晚到的图 / 视频：sealed 节点后补（painter.js / video.js 的真实路径 pushLate）——
    async function paintOnNode(st, node, kind, i, sourceScene) {
      const ts = nextTs();
      const { thumb, png } = makeThumb(i);
      const blob = await fetch(png).then(r => r.blob());
      const scene = {
        id: window.IR.genId('sc'),
        prompt: 'cinematic still, rainy convenience store at night, warm amber light, watercolor',
        promptRaw: 'fixture prompt raw #' + i,
        alt: '雨夜便利店场景图 ' + (i + 1),
        thumb, width: 120, height: 80, aspect: '3:2',
        model: 'fixture-image-model', ts,
      };
      if (kind === 'video') {
        scene.kind = 'video';
        scene.videoId = 'vid:' + scene.id;
        scene.mode = sourceScene ? 'i2v' : 't2v';
        scene.sourceSceneId = sourceScene ? sourceScene.id : undefined;
        scene.taskId = 'vid-task-fixture-' + i;
        scene.duration = 6;
        scene.resolution = '768P';
        scene.ratio = '16:9';
        scene.model = 'minimax-video';
        scene.remoteUrl = 'https://video.invalid/fixture/' + scene.id + '.mp4';   // 仅降级用的字符串，永不请求
        const vblob = new Blob([new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32, i, i + 1, i + 2, i + 3, 0xde, 0xad, 0xbe, 0xef])], { type: 'video/mp4' });
        Store.putVideo(scene.videoId, vblob, { prompt: scene.prompt, mode: scene.mode, taskId: scene.taskId });
        out.videos.push({ sceneId: scene.id, videoId: scene.videoId, bytes: vblob.size });
        const entry = {
          type: 'video', id: scene.id, alt: scene.alt, thumb: scene.thumb,
          videoId: scene.videoId, remoteUrl: scene.remoteUrl,
          mode: scene.mode, sourceSceneId: scene.sourceSceneId,
          prompt: scene.prompt, promptRaw: scene.promptRaw,
          model: scene.model, duration: scene.duration,
          resolution: scene.resolution, ratio: scene.ratio,
          taskId: scene.taskId, ts: scene.ts,
        };
        Tree.pushLate(st, node.id, scene);
        Tree.pushLate(st, node.id, entry);
      } else {
        scene.imageId = 'img:' + scene.id;
        scene.styleCardId = st.styleCard ? (st.styleCard.id + '@' + (st.styleCard.version || 1)) : undefined;
        Store.putImage(scene.imageId, blob, {
          model: scene.model, size: '120x80', width: scene.width, height: scene.height, prompt: scene.prompt,
        });
        out.images.push({ sceneId: scene.id, imageId: scene.imageId, bytes: blob.size });
        const entry = {
          type: 'image', id: scene.id, prompt: scene.prompt, promptRaw: scene.promptRaw, alt: scene.alt,
          thumb: scene.thumb, imageId: scene.imageId, model: scene.model, size: '120x80',
          aspect: scene.aspect, width: scene.width, height: scene.height, styleCardId: scene.styleCardId,
          ts: scene.ts,
        };
        Tree.pushLate(st, node.id, scene);
        Tree.pushLate(st, node.id, entry);
      }
      return scene;
    }

    try {
      /* ---------- 设置（先造好，供导出剥 Key 验证） ---------- */
      const settings = Store.migrateSettings({
        chat: { baseUrl: 'https://api.invalid/v1', apiKey: FAKE_KEY, model: 'fixture-chat-model', thinking: 'default', contextWindow: 128000, extraParams: '{"temperature":0.8}' },
        painter: { baseUrl: 'https://api.invalid/v1', apiKey: 'sk-fixture-painter-KEY', model: 'fixture-painter-model' },
        scribe: { enabled: true, every: 6, aiTasks: true },
        image: { provider: 'openai-images', baseUrl: 'https://img.invalid/v1', apiKey: 'sk-fixture-image-KEY', model: 'fixture-image-model', aspect: '3:2', width: 1024, height: 1024, refMode: 'prev' },
        video: { provider: 'minimax-video', apiKey: 'sk-fixture-video-KEY', model: 'minimax-video', duration: 6, resolution: '768P', ratio: '16:9' },
        profiles: [
          { id: 'pf-fixture-main', label: '主模型 · 固定档', baseUrl: 'https://api.invalid/v1', apiKey: 'sk-fixture-profile-KEY', model: 'fixture-chat-model' },
          { id: 'pf-fixture-alt', label: '备用便宜档', baseUrl: 'https://api2.invalid/v1', apiKey: '', model: 'fixture-lite-model' },
        ],
        userProfile: { enabled: 'all' },
        ui: { layout: 'split', splitRatio: 0.55, imageCollapsed: false, choices: 'tray', motion: 'rich', fontScale: 'md', width: 'standard', density: 'standard' },
        showReasoning: true,
        toolsEnabled: 'on',
        noTools: [{ baseUrl: 'https://api2.invalid/v1', model: 'fixture-lite-model', at: 0 }],
        stylePreset: 'watercolor',
        styleCustom: '暖黄灯光，冷蓝雨夜，水彩质感',
        sidecar: { port: 4319, token: 'fixture-sidecar-token' },
      });
      window.IR.App.state.settings = settings;
      window.IR.App.persistSettings();

      /* ---------- 全局用户画像（ir:user-profile） ---------- */
      const gProfile = [
        { text: '玩家喜欢在夜里写东西', kind: 'preference', updatedAt: nextTs() },
        { text: '对关东煮的气味过敏', kind: 'fact', updatedAt: nextTs() },
        { text: '不想被剧透结局', kind: 'taboo', updatedAt: nextTs() },
      ];
      Store.saveUserProfile(gProfile);
      out.globalUserProfile = Store.loadUserProfile();

      /* ---------- 故事 A：雨夜便利店（剧情 / 分支 / 图 / 视频 / 存档点） ---------- */
      const stA = Store.newStory({ title: '雨夜便利店', premise: premiseA, mode: 'choice' });
      stA.styleTone = '克制的悬疑，日常里藏着一丝奇异';
      stA.styleCard = {
        id: window.IR.genId('style'), version: 2, locked: true, updatedAt: nextTs(),
        styleKeywords: ['cinematic', 'warm amber light', 'rainy night'],
        medium: 'watercolor',
        palette: 'amber, deep blue',
        characters: [{ name: '周叙', appearanceEn: 'young clerk', outfit: 'store uniform', features: 'calm eyes' }],
        negative: 'text, watermark',
        note: '暖黄灯光，冷蓝雨夜',
      };
      stA.rollingStyle = {
        style: '暖黄灯光的水彩，冷蓝雨夜的反光，克制构图',
        scenes: '便利店内部，收银台与货架之间',
        wardrobe: '便利店制服、深色雨衣',
        updatedAt: nextTs(),
      };
      stA.prefs = {
        profileId: 'pf-fixture-main', profileLabel: '主模型 · 固定档',
        choices: 'tray', showReasoning: true,
        tools: { image: true, memory: true, schedule: false, email: false, payment: false },
        ui: { layout: 'split', splitRatio: 0.55, fontScale: 'md', width: 'standard', density: 'standard' },
      };

      const nodes = [];
      let forkBaseNode = null;
      for (let i = 0; i < turnsA.length; i++) {
        const t = turnsA[i];
        if (t.forkAfterTurnIndex != null && forkBaseNode == null) {
          Tree.switchTo(stA, nodes[t.forkAfterTurnIndex].id);   // 回到早前节点（真实分叉流程）
          forkBaseNode = nodes[t.forkAfterTurnIndex];
        }
        const node = playTurn(stA, t, t.actionType === 'opening');
        nodes.push(node);
        if (t.paintAfter === 'image') {
          await paintOnNode(stA, node, 'image', out.images.length);
        } else if (t.paintAfter === 'video') {
          await paintOnNode(stA, node, 'video', out.videos.length, stA.scenes.find(s => s.kind !== 'video'));
        }
      }
      // 摘要栈（C-A）：7 回合的短局触发不了压缩，直接放两条 compressStory/localSummarize
      // 产出的同形状槽位（摘要条目就是纯字符串），把 summaries[] 的往返覆盖上
      stA.summaries = [
        '【第1幕】雨夜便利店（收银台与货架区）｜深夜·雨夜｜在场：周叙｜发生：进店避雨、看锅边便签、与店员搭话｜伏笔：锅边便签；挑便宜的就走',
        '【第2幕】墙上停摆的挂钟｜凌晨两点多｜在场：周叙｜发生：挂钟停在 2:47、收音机数数声｜伏笔：周叙的劝告：挑便宜的就走',
      ];
      // 视频里带一个「进行中」的生视频任务（§5⑤ pendingVideos）
      stA.pendingVideos = [{
        taskId: 'vid-task-fixture-pending', mode: 'i2v', prompt: '缓慢推近储物间的纸箱',
        sourceSceneId: (stA.scenes.find(s => s.kind !== 'video') || {}).id || null,
        nodeId: nodes[nodes.length - 1].id,
        createdAt: nextTs(), promptRaw: 'fixture pending prompt', alt: '储物间纸箱特写',
      }];

      // 存档点：真实路径 IR.App.addSavepoint（library.js snapshotStory）
      window.IR.App.state.story = stA;
      window.IR.App.addSavepoint('开局前夜');
      Tree.switchTo(stA, nodes[2].id);
      window.IR.App.addSavepoint('周叙登场');
      Tree.switchTo(stA, nodes[nodes.length - 1].id);
      window.IR.App.state.story = null;

      Store.saveStory(stA);

      /* ---------- 故事 B：扮演 + 角色卡 + 故事内画像 ---------- */
      const stB = Store.newStory({ title: '凌霜的航线夜谈', premise: '与星舰领航员凌霜的扮演对话。', mode: 'rp' });
      stB.titleAuto = true;
      stB.characterCard = {
        name: '凌霜', appearance: '银白长发，舰桥制服，左眼下一颗小痣',
        personality: '冷静、克制，偶尔冒出冷幽默',
        scene: '星舰舰桥，舷窗外是缓慢旋转的星云',
        opening: '「你迟到了三分钟。」她没有回头，声音里听不出情绪。',
        exampleDialogue: '「航线不是路，是承诺。」',
        systemNote: '保持克制的科幻语感，不主动推进剧情，回应玩家的行动。',
        source: 'custom', updatedAt: nextTs(),
      };
      stB.userProfile = [{ text: '玩家喜欢在夜里写东西', kind: 'preference', updatedAt: nextTs() }];
      stB.prefs = { profileId: 'pf-fixture-alt', profileLabel: '备用便宜档', choices: 'always', showReasoning: false };
      playTurn(stB, { actionType: 'player', kind: 'say', text: '「路上遇到点事。」我把外套挂好。', reply: { narration: '「嗯。」她的手指在航图上轻轻敲了两下，「坐。这次的航线，要经过一片没有名字的空域。」', choices: [], scene_change: false, scene_summary: '舰桥，航图的冷光映在凌霜脸上' } }, false);
      playTurn(stB, { actionType: 'player', kind: 'do', text: '凑过去看那片空域', reply: { narration: '航图上那片空域只有一圈淡得几乎看不见的虚线，像有人擦掉过一次又没擦干净。凌霜把航图推过来一点：「看出什么了？」', choices: ['问她这圈虚线是什么', '说我看不出来'], scene_change: false, scene_summary: '航图特写，一圈淡虚线' } }, false);
      playTurn(stB, { actionType: 'player', kind: 'say', text: '「这圈虚线，被人擦过。」', reply: { narration: '「眼力不错。」她终于转过头来，「那是三年前，我亲手擦的。」', choices: [], scene_change: true, scene_summary: '凌霜回头，舷窗外星云缓慢旋转' } }, false);
      Store.saveStory(stB);

      /* ---------- 故事 C：智能体（纯文本对话，无图） ---------- */
      const stC = Store.newStory({ title: '新对话', premise: '日常智能体对话。', mode: 'chat' });
      playTurn(stC, { actionType: 'player', kind: 'do', text: '帮我记一下：周五下午三点和印刷厂开对接会', reply: { narration: '记下了：周五 15:00，与印刷厂开对接会。要不要我提前一天提醒你？', choices: [], scene_change: false, scene_summary: '' } }, false);
      playTurn(stC, { actionType: 'player', kind: 'do', text: '要，顺便把上次的样张文件找出来', reply: { narration: '好，周四 15:00 提醒你。样张文件在「印刷/样张」目录里，最近一次修改是上周二。', choices: [], scene_change: false, scene_summary: '' } }, false);
      Store.saveStory(stC);

      Store.setCurrentId(stA.id);
      await Store.flush();

      const dump = (st) => ({
        id: st.id, title: st.title, mode: st.mode, turn: st.turn,
        logEntries: (st.log || []).length,
        treeNodes: st.tree ? Object.keys(st.tree.nodes).length : 0,
        branches: st.tree ? Object.values(st.tree.nodes).filter(n => n.children && n.children.length > 1).length : 0,
        savepoints: (st.savepoints || []).length,
        images: (st.scenes || []).filter(s => s.kind !== 'video').length,
        videos: (st.scenes || []).filter(s => s.kind === 'video').length,
        summaries: (st.summaries || []).length,
        characterCard: !!st.characterCard,
      });
      out.stories = [stA, stB, stC].map(dump);
      window.__fixtureSeeded = out;
    } catch (e) {
      out.ok = false;
      out.errors.push(String(e && e.stack || e));
    }
    return out;
  }, { turnsA: TURNS_A, premiseA: STORY_A_PREMISE, FAKE_KEY });
}

/* ================= roundtrip：导入 → 还原 → 再导出 → 逐字段比对 ================= */

function transform(obj, normalizeRules) {
  const walk = (v, path) => {
    let out = v;
    for (const [pat, fn] of normalizeRules) {
      if (matchPath(path, pat)) out = fn(out);
    }
    if (Array.isArray(out)) return out.map((x, i) => walk(x, path.concat(i)));
    if (out && typeof out === 'object') {
      const o = {};
      for (const k of Object.keys(out)) o[k] = walk(out[k], path.concat(k));
      return o;
    }
    return out;
  };
  return walk(obj, []);
}

function matchPath(path, pattern) {
  if (pattern.length !== path.length) return false;
  return pattern.every((seg, i) => seg === '*' || seg === String(path[i]));
}

// 逐字段深比对：返回差异列表（空 = 一致）。只放行 opts.ignore 里的路径。
function diffJson(a, b, opts) {
  const diffs = [];
  const walk = (x, y, path) => {
    if (path.length && opts.ignore && opts.ignore.some(p => matchPath(path, p))) return;
    const pstr = path.length ? path.join('.') : '(root)';
    const tx = x === null || x === undefined ? String(x) : typeof x;
    const ty = y === null || y === undefined ? String(y) : typeof y;
    if (tx !== ty) { diffs.push({ path: pstr, a: trunc(x), b: trunc(y), why: '类型不同 ' + tx + ' vs ' + ty }); return; }
    if (Array.isArray(x)) {
      if (x.length !== y.length) diffs.push({ path: pstr + '.length', a: x.length, b: y.length, why: '数组长度不同' });
      const n = Math.min(x.length, y.length);
      for (let i = 0; i < n; i++) walk(x[i], y[i], path.concat(i));
      return;
    }
    if (x && typeof x === 'object') {
      const keys = Array.from(new Set(Object.keys(x).concat(Object.keys(y)))).sort();
      for (const k of keys) {
        if (!(k in x)) { diffs.push({ path: pstr + '.' + k, a: '(缺)', b: trunc(y[k]), why: '再导出多了字段' }); continue; }
        if (!(k in y)) { diffs.push({ path: pstr + '.' + k, a: trunc(x[k]), b: '(缺)', why: '再导出丢了字段' }); continue; }
        walk(x[k], y[k], path.concat(k));
      }
      return;
    }
    if (x !== y) diffs.push({ path: pstr, a: trunc(x), b: trunc(y), why: '值不同' });
  };
  walk(a, b, []);
  return diffs;
}

// 全量备份的稳定化：stories 按 id 对齐（数组顺序 = updatedAt 排序，导入落盘后顺序可漂移）
function stabilizeBackup(obj) {
  const o = JSON.parse(JSON.stringify(obj));
  if (Array.isArray(o.stories)) o.stories.sort((x, y) => String(x.id).localeCompare(String(y.id)));
  if (Array.isArray(o.images)) {
    o.images = o.images.slice().sort((x, y) => String(x.id).localeCompare(String(y.id)));
  }
  return o;
}

async function readZipEntries(buf) {
  if (!Zip || !Zip.read) throw new Error('IR.Zip 未加载（js/zip.js require 失败）');
  return Zip.read(new Blob([buf]));
}

// zip 比对：ir-backup.json 逐字段 + images/* 按 id 对齐逐字节
async function diffZip(fixtureBuf, reExportBuf) {
  const report = { diffs: [], imageDiffs: [], checked: 0 };
  const f = await readZipEntries(fixtureBuf);
  const r = await readZipEntries(reExportBuf);
  const pick = entries => {
    for (const [name, blob] of entries) if (/(^|\/)ir-backup\.json$/i.test(name)) return blob;
    return null;
  };
  const fJson = JSON.parse(await pick(f).text());
  const rJson = JSON.parse(await pick(r).text());
  report.diffs = diffJson(stabilizeBackup(fJson), stabilizeBackup(rJson), RULES_BACKUP);

  const byId = async (entries, manifest) => {
    const out = new Map();
    for (const im of manifest || []) {
      const blob = entries.get(im.path);
      if (!blob) { out.set(im.id, null); continue; }
      out.set(im.id, sha256(Buffer.from(await blob.arrayBuffer())));
    }
    return out;
  };
  const fm = await byId(f, fJson.images);
  const rm = await byId(r, rJson.images);
  const ids = Array.from(new Set(Array.from(fm.keys()).concat(Array.from(rm.keys())))).sort();
  for (const id of ids) {
    report.checked++;
    const a = fm.get(id), b = rm.get(id);
    if (a !== b) report.imageDiffs.push({ id, fixture: a || '(缺)', reExport: b || '(缺)' });
  }
  return report;
}

async function roundtrip() {
  log('== roundtrip：导入 → 还原 → 再导出 → 逐字段比对 ==');
  const seedManifestPath = path.join(OUT, 'fixture-seed.json');
  if (!fs.existsSync(seedManifestPath)) {
    throw new Error('没有 fixture-seed.json：先跑 `node acceptance/tools/fixture.mjs build`');
  }
  const seedManifest = JSON.parse(fs.readFileSync(seedManifestPath, 'utf8'));
  const artifacts = seedManifest.artifacts.map(a => Object.assign({}, a, {
    path: path.join(OUT, a.file),
  })).filter(a => fs.existsSync(a.path));

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const results = [];
  try {
    for (const art of artifacts) {
      log('--', art.file);
      const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN', reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      const consoleErrors = [];
      page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 200)); });
      page.on('pageerror', e => consoleErrors.push('pageerror: ' + String(e).slice(0, 200)));
      const r = { file: art.file, ok: true, checks: [], diffs: [], imageDiffs: [], consoleErrors };
      try {
        await openApp(page, '');
        const before = await page.evaluate(() => IR.Store.listStories().length);
        r.checks.push({ name: '导入前无存档', ok: before === 0, detail: 'listStories=' + before });

        await importFile(page, art.path);

        if (art.kind === 'ir-backup' || art.kind === 'ir-backup-zip') {
          // 还原：3 个故事
          await page.waitForFunction(() => IR.Store.listStories().length >= 3, null, { timeout: 20000 });
          const restored = await page.evaluate(() => IR.Store.listStories().map(it => {
            const st = IR.Store.loadStory(it.id);
            return { id: st.id, title: st.title, mode: st.mode, turn: st.turn, savepoints: (st.savepoints || []).length, scenes: (st.scenes || []).length, treeNodes: st.tree ? Object.keys(st.tree.nodes).length : 0 };
          }));
          r.checks.push({ name: '还原 3 个故事', ok: restored.length === 3, detail: JSON.stringify(restored) });
          if (art.kind === 'ir-backup-zip') {
            // 还原：原图逐张取回（尺寸对上 manifest）
            const imgCheck = await page.evaluate(async () => {
              const out = [];
              for (const it of IR.Store.listStories()) {
                const st = IR.Store.loadStory(it.id);
                for (const s of (st.scenes || [])) {
                  if (s.imageId) {
                    const blob = await IR.Store.getImage(s.imageId);
                    out.push({ imageId: s.imageId, size: blob ? blob.size : 0 });
                  }
                }
              }
              return out;
            });
            r.checks.push({ name: '原图已还原', ok: imgCheck.length > 0 && imgCheck.every(x => x.size > 0), detail: JSON.stringify(imgCheck) });
          }
          const buf = await exportBackup(page, { withSrc: art.kind === 'ir-backup-zip', withKeys: false });
          if (art.kind === 'ir-backup-zip') {
            const zr = await diffZip(fs.readFileSync(art.path), buf);
            r.diffs = zr.diffs;
            r.imageDiffs = zr.imageDiffs;
            r.checks.push({ name: 'zip 逐图字节一致', ok: zr.imageDiffs.length === 0, detail: zr.checked + ' 张图' });
          } else {
            const fix = JSON.parse(fs.readFileSync(art.path, 'utf8'));
            const got = JSON.parse(buf.toString('utf8'));
            r.checks.push({
              name: '夹具与再导出均为有效档案（防空比对）',
              ok: fix.format === 'ir-backup' && got.format === 'ir-backup' && (fix.stories || []).length === (got.stories || []).length,
              detail: `format=${fix.format}/${got.format} stories=${(fix.stories || []).length}/${(got.stories || []).length}`,
            });
            r.diffs = diffJson(stabilizeBackup(fix), stabilizeBackup(got), RULES_BACKUP);
          }
        } else {
          // 单故事档案：等「（导入）」故事 + 带原图的异步换键落定
          await page.waitForFunction(() => IR.Store.listStories().length >= 1, null, { timeout: 20000 });
          await page.waitForFunction(() => {
            const it = IR.Store.listStories().find(x => /（导入）/.test(x.title));
            if (!it) return false;
            const st = IR.Store.loadStory(it.id);
            return !!st && (st.scenes || []).every(s => s.kind === 'video' || s.thumb == null || !!s.imageId);
          }, null, { timeout: 20000 }).catch(() => {});
          const info = await page.evaluate(() => {
            const it = IR.Store.listStories().find(x => /（导入）/.test(x.title)) || IR.Store.listStories()[0];
            const st = IR.Store.loadStory(it.id);
            return {
              id: st.id, title: st.title, log: (st.log || []).length,
              scenes: (st.scenes || []).length,
              withImageId: (st.scenes || []).filter(s => s.imageId).length,
              treeNodes: st.tree ? Object.keys(st.tree.nodes).length : 0,
              savepoints: (st.savepoints || []).length,
              characterCard: st.characterCard ? st.characterCard.name : null,
              turn: st.turn,
            };
          });
          r.checks.push({ name: '导入故事已还原', ok: /（导入）/.test(info.title), detail: JSON.stringify(info) });

          const fixObj = JSON.parse(fs.readFileSync(art.path, 'utf8'));
          const expectedImages = (fixObj.images || []).filter(x => x.src).length;
          r.checks.push({ name: '原图换键落定', ok: info.withImageId >= expectedImages, detail: `imageId=${info.withImageId} 期望≥${expectedImages}` });

          const buf = await exportStoryPack(page, info.id, { withSrc: art.withSrc });
          const got = JSON.parse(buf.toString('utf8'));
          r.checks.push({
            name: '夹具与再导出均为有效档案（防空比对）',
            ok: fixObj.format === 'ir-story' && got.format === 'ir-story' && (fixObj.log || []).length === (got.log || []).length,
            detail: `format=${fixObj.format}/${got.format} log=${(fixObj.log || []).length}/${(got.log || []).length}`,
          });
          const fix = transform(fixObj, RULES_STORY.normalize);
          const gotT = transform(got, RULES_STORY.normalize);
          r.diffs = diffJson(fix, gotT, RULES_STORY);
        }
      } catch (e) {
        r.ok = false;
        r.checks.push({ name: '流程异常', ok: false, detail: String(e && e.stack || e) });
      }
      r.ok = r.ok && r.diffs.length === 0 && r.imageDiffs.length === 0 && r.checks.every(c => c.ok);
      results.push(r);
      log('  ', r.ok ? 'PASS' : 'FAIL', art.file,
        r.diffs.length ? ('字段差异 ' + r.diffs.length) : '',
        r.imageDiffs.length ? ('图片差异 ' + r.imageDiffs.length) : '');
      if (!r.ok) {
        for (const c of r.checks.filter(c => !c.ok)) log('    ✗', c.name, '—', trunc(c.detail));
        for (const d of r.diffs.slice(0, 20)) log('    ✗ 字段', d.path, '夹具=', d.a, '再导出=', d.b, '(' + d.why + ')');
        for (const d of r.imageDiffs.slice(0, 10)) log('    ✗ 图片', d.id, d.fixture, d.reExport);
      }
      await ctx.close();
    }
  } finally {
    await browser.close();
  }

  const ok = results.every(r => r.ok);
  const report = {
    project: 'infinite-reading',
    version: '0.12.1',
    stage: '0（迁移基线）· 回归夹具 roundtrip',
    generatedAt: new Date().toISOString(),
    tool: 'acceptance/tools/fixture.mjs roundtrip',
    how: '每个夹具文件各起一个干净浏览器上下文（file://）：真实 UI 导入（#file-import）→ 还原 → 真实 UI 再导出 → 与夹具原文件逐字段比对',
    comparePolicy: seedManifest.comparePolicy,
    ok,
    artifacts: results,
  };
  fs.writeFileSync(path.join(OUT, 'roundtrip-report.json'), JSON.stringify(report, null, 2), 'utf8');
  log('roundtrip done →', path.join(OUT, 'roundtrip-report.json'), ok ? 'ALL PASS' : 'FAIL');
  return ok;
}

/* ================= selftest：比对器自检 + 全链路负测试 =================
 * 反向测试必须改「再导出」那一侧才有效：roundtrip 是「夹具 vs 夹具自己的再导出」，
 * 改夹具两边会一起变，永远测不出比对器失灵。这里：
 *   ① 纯比对器单测：改坏 / 删字段 / 加字段 / 数组长度必须报差异；放行字段必须不报；
 *   ② 全链路负测试：真实 UI 导入 → 页面里故意改坏一个故事字段 → 真实 UI 再导出 → 必须报出差异。
 * 任何一项失灵都说明「逐字段比对」是空跑，回归保障不成立。 */
async function selftest() {
  let failed = 0;
  const check = (name, ok, detail) => {
    log('  ', ok ? '✓' : '✗', name, detail ? '— ' + trunc(detail) : '');
    if (!ok) failed++;
  };

  log('== selftest ①：比对器单测 ==');
  const base = JSON.parse(fs.readFileSync(path.join(OUT, 'backup-plain.irbackup.json'), 'utf8'));
  const clone = o => JSON.parse(JSON.stringify(o));

  const mut = clone(base);
  mut.stories[0].world.place = '（故意改坏）';
  check('改坏 stories[].world.place 被发现',
    diffJson(stabilizeBackup(base), stabilizeBackup(mut), RULES_BACKUP).some(d => /\.world\.place$/.test(d.path)));

  const mutDel = clone(base);
  delete mutDel.stories[0].premise;
  check('删字段被发现',
    diffJson(stabilizeBackup(base), stabilizeBackup(mutDel), RULES_BACKUP).some(d => /\.premise$/.test(d.path)));

  const mutAdd = clone(base);
  mutAdd.stories[0].extraField = 1;
  check('加字段被发现',
    diffJson(stabilizeBackup(base), stabilizeBackup(mutAdd), RULES_BACKUP).some(d => /\.extraField$/.test(d.path)));

  const mutArr = clone(base);
  mutArr.userProfile.pop();
  check('数组条数变化被发现',
    diffJson(stabilizeBackup(base), stabilizeBackup(mutArr), RULES_BACKUP).some(d => /\.length$/.test(d.path)));

  const mutVolatile = clone(base);
  mutVolatile.exportedAt = 1;
  mutVolatile.app = '无限阅读 v9.9.9';
  mutVolatile.stories[0].updatedAt = 1;
  check('放行字段（exportedAt / app / updatedAt）不报差异',
    diffJson(stabilizeBackup(base), stabilizeBackup(mutVolatile), RULES_BACKUP).length === 0);

  const s1 = { title: '雨夜便利店', createdAt: 1, updatedAt: 2, images: [{ id: 'a', ts: 3 }] };
  const s2 = { title: '雨夜便利店（导入）', createdAt: 9, updatedAt: 9, images: [{ id: 'a', ts: 9 }] };
  check('单故事放行字段 +「（导入）」后缀归一后一致',
    diffJson(transform(s1, RULES_STORY.normalize), transform(s2, RULES_STORY.normalize), RULES_STORY).length === 0);
  check('单故事标题真不一致时仍报差异',
    diffJson(transform({ title: '甲' }, RULES_STORY.normalize), transform({ title: '乙（导入）' }, RULES_STORY.normalize), RULES_STORY).length > 0);

  log('== selftest ②：全链路负测试（导入 → 故意改坏 → 再导出 → 必须报差异） ==');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'zh-CN', reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await openApp(page, '');
    await importFile(page, path.join(OUT, 'backup-plain.irbackup.json'));
    await page.waitForFunction(() => IR.Store.listStories().length >= 3, null, { timeout: 20000 });
    const poke = await page.evaluate(() => {
      const it = IR.Store.listStories().find(x => x.title === '雨夜便利店');
      if (!it) return '找不到故事';
      const st = IR.Store.loadStory(it.id);
      st.world.place = '（selftest 故意改坏）';
      IR.Store.saveStory(st);
      return 'ok';
    });
    check('页面内改坏故事世界卡', poke === 'ok', poke);
    const buf = await exportBackup(page, { withSrc: false, withKeys: false });
    const got = JSON.parse(buf.toString('utf8'));
    const diffs = diffJson(stabilizeBackup(base), stabilizeBackup(got), RULES_BACKUP);
    check('改坏后的再导出被比对器抓住', diffs.some(d => /\.world\.place$/.test(d.path)), diffs.slice(0, 3).map(d => d.path + '=' + trunc(d.b)).join('; '));
    await ctx.close();
  } finally {
    await browser.close();
  }

  log('selftest', failed ? ('FAIL（' + failed + ' 项失灵）') : 'ALL PASS');
  if (failed) process.exitCode = 1;
}

/* ================= 入口 ================= */

async function main() {
  const cmd = (process.argv[2] || 'all').toLowerCase();
  if (cmd === 'build') { await buildFixture(); return; }
  if (cmd === 'roundtrip') { if (!await roundtrip()) process.exitCode = 1; return; }
  if (cmd === 'selftest') { await selftest(); return; }
  if (cmd === 'all') {
    await buildFixture();
    if (!await roundtrip()) process.exitCode = 1;
    return;
  }
  console.error('用法：node acceptance/tools/fixture.mjs [build|roundtrip|selftest|all]');
  process.exitCode = 2;
}

main().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
