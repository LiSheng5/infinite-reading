/*
 * js/app/wizard.js —— 开局向导（T-P2-3）
 * 从 js/app.js 拆出（只搬家，不改行为）。
 */
(function () {
  'use strict';

  const A = IR.App, S = A.state;
  const { $, Store, DEFAULT_TOPIC, CHAT_PREMISE, DRAFT_SYSTEM, toast, openModal, closeModal, netErrHint, sleep, fmtTime, resolveSub } = A;


  /* ================= 本地存储与备份（P0 数据安全） =================
   * 全部数据只在浏览器 localStorage（每站点约 5MB），没有任何服务端。这里做三件事：
   *  1) 申请持久化存储 navigator.storage.persist()：磁盘压力下的 LRU 淘汰会跳过本站
   *     （Safari 的 7 天无交互清除仍会生效，只能靠交互 / 加到主屏缓解）
   *  2) 算清本应用占用量，到 70% 提前预警（原来的提示只在写入失败之后才出现，已经晚了）
   *  3) 「一键导出全部备份」(.irbackup.json，可整体还原) + 超过 7 天没备份就提醒一次
   */

  // 只统计本应用的键（ir: 前缀）：localStorage 上限是所有键共享的，这里的占用才是我们能控的

  // 真实占用：navigator.storage.estimate()（把 IndexedDB / Cache 等一起算在内，比数键位准得多）

  // 导出包：默认剥掉 API Key（备份文件常被放进网盘，带 Key 等于把钱包一起备份）

  /* 「带原图备份」= 一个 zip 里放两样东西：
   *   ir-backup.json      与普通备份完全同款（schema 2 只多一份 images 清单）
   *   images/0001.png …   原图按二进制原样存放
   * 为什么不把原图 base64 塞进 JSON：大图转 base64 体积涨约 1/3，还会在内存里堆成巨型字符串；
   * zip 装的是原始字节，体积最省，导出 / 导入都不容易把内存打爆。代价是 .zip 不能直接肉眼查看。 */

  // 超过 7 天没备份（且确实有故事）→ 启动后提醒一次；提醒本身每天最多一次，不刷屏

  // 从一个 zip 里找备份正文：优先根目录，也接受「被塞进一层文件夹」的情况

  // 带原图的全量备份（.zip）：解出 ir-backup.json 走同一套还原流程，原图另走 images/*

  /* ================= 剧情文本导入（R12 路径② / §4.11 / T-P6-1） =================
   * 粘贴任意剧情文本 → 整理向导（用「起草模型」；只有装不下才 map-reduce）→
   * premise + world 草稿 + 画风关键词 → 用户确认修改（不可跳过）→ 建新档 → 试画锚定 → 开场。
   * 调用失败退回本地规则。 */

  // 整理模型：弹窗里可选（默认跟随剧情模型；也能用单独配置的起草模型）

  // 「这次用谁整理」的一行字（显示在提示与确认页上；避免只写模型名让人误以为是硬编码的）

  // 整理模型的有效窗口：跟随剧情模型 → 用剧情模型的；起草模型 → 单独配了才查登记表

  // 粘贴框下方的一行提示：整理模型 + 窗口 + 这次会一次调用还是 map-reduce（返回 plan 供调用方复用）

  // 本地兜底整理：只截取原文开头并结构化（调用失败时用；标「本地规则」，等用户改）

  // 分段摘要合并（§4.11：分段各出摘要，再一次合并成开局材料）

  /* ================= 角色卡（R13 / §4.12 / T-P7-1） =================
   * 统一编辑器：自建 = 空白表单；导入 = SillyTavern V2/V3 PNG（只兼容格式，不复制内容）；改完即生效。
   * rp 开局 = 选（建 / 导入）一张角色卡；开场白作为首条旁白；示例对话喂给模型学口吻。 */

  // 卡 → 世界卡人物条目（personality / speech 对接，§4.12）；用户手改过的字段按 mergeWorld 规则保护

  // 开场白 = rp 首条旁白（不花一次 AI 调用；§4.12）

  /* ---------------- 用户画像（R13 / §4.12 / T-P7-2） ----------------
   * 开关默认全关、可按模式单独开或全开；范围 global（ir:user-profile）/ per-story 用户自选。
   * 收集：真实模式由书记员校对时顺手提取；失败退回本地确定性规则（只认「我…」句式）。
   * 注入：每轮只带与当前话题相关的 Top-N + 常驻一行摘要（assembleAI1 的 opts.profile，见 callAI1）。 */

  // 当前生效的画像条目（按 scope 取全局或本档）；关开关 / 没故事 → 空

  // 写入画像：关开关即停止收集；合并去重（同文只留最新），不设条数上限（§4.12 存储无上限）

  // 失败兜底：只看玩家最后说的一句（确定性规则）

  // 书记员输入里的画像指示：开没开都说清楚，省得模型乱输出

  /* ================= 开局向导（T-P2-3 / §4.8） ================= */

  function openWizard(prefill) {
    prefill = prefill || {};
    $('#wz-draft-input').value = prefill.topic || '';
    $('#wz-world').value = prefill.world || '';
    $('#wz-characters').value = prefill.characters || '';
    $('#wz-role').value = prefill.role || '';
    $('#wz-style').value = prefill.style || '';
    $('#wz-development').value = prefill.development || '';
    const cfg = resolveSub('draft');
    const sub = S.settings.draft || {};
    const src = (sub.provider || sub.model) ? '起草模型单独配置' : '跟随剧情模型';
    $('#wz-draft-hint').textContent = '起草模型：' + (cfg.model || '（未配置）') + '（' + src + '，可在模型设置里更换）。草稿出来后再改成你自己的话即可。';
    openModal('modal-wizard');
  }

  function parseCharacterLines(text) {
    return String(text || '').split('\n').map(line => {
      const p = line.split('｜').map(s => s.trim());
      if (!p[0]) return null;
      return { name: p[0], personality: p[1] || '', speech: p[2] || '' };
    }).filter(Boolean);
  }

  function firstSentence(text, max) {
    const t = String(text || '').trim().split(/[\n。；;]/)[0] || '';
    return t.slice(0, max || 40);
  }

  function localDraft(topic) {
    const t = String(topic || DEFAULT_TOPIC).replace(/^标题[:：]\s*/, '').trim();
    return {
      world: '围绕「' + t.slice(0, 24) + '」展开的世界。时代与地点贴近日常，但在寻常处埋着一点异样；规则不解释透，让故事自己显形。',
      characters: [
        { name: '叙述者', personality: '沉静、观察力强、话里有话', speech: '简短、克制' },
        { name: '旧识', personality: '看似随意、实则心事很重', speech: '喜欢反问、句子偏短' },
      ],
      role: '你是这场相遇的中心：一个带着未了心愿的人，可以在故事里做任何尝试。',
      styleTone: '克制的悬疑，暖光与冷影并存，雨夜的质感',
      development: '从一个安静的细节开场，让异样一点点渗出来。',
    };
  }

  function parseDraft(raw) {
    const s = String(raw || '');
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i === -1 || j <= i) return null;
    try {
      const o = JSON.parse(s.slice(i, j + 1));
      if (!o || (!o.world && !o.role && !Array.isArray(o.characters))) return null;
      return {
        world: String(o.world || ''),
        characters: Array.isArray(o.characters) ? o.characters.filter(Boolean).map(c => ({
          name: String(c.name || ''), personality: String(c.personality || c.persona || ''), speech: String(c.speech || ''),
        })).filter(c => c.name) : [],
        role: String(o.role || ''),
        styleTone: String(o.styleTone || o.style || ''),
        development: String(o.development || ''),
      };
    } catch (_) { return null; }
  }

  function fillWizard(d) {
    if (d.world) $('#wz-world').value = d.world;
    if (d.characters && d.characters.length) {
      $('#wz-characters').value = d.characters.map(c => [c.name, c.personality, c.speech].join('｜')).join('\n');
    }
    if (d.role) $('#wz-role').value = d.role;
    if (d.styleTone) $('#wz-style').value = d.styleTone;
    if (d.development) $('#wz-development').value = d.development;
  }

  async function draftWizard() {
    const topic = $('#wz-draft-input').value.trim() || DEFAULT_TOPIC;
    const btn = $('#btn-wz-draft');
    btn.disabled = true; btn.textContent = '起草中…';
    try {
      const cfg = resolveSub('draft');
      let d = null;
      if (!cfg.model) {
        await sleep(500);
        d = localDraft(topic);
      } else {
        const adapter = IR.ChatProviders[cfg.provider] || IR.ChatProviders['openai-compatible'];
        const raw = await adapter.chat(cfg, [
          { role: 'system', content: DRAFT_SYSTEM },
          { role: 'user', content: topic },
        ]);
        d = parseDraft(raw);
        if (!d) d = localDraft(topic);
      }
      fillWizard(d);
      toast('草稿已填入，改成你自己的话即可');
    } catch (e) {
      fillWizard(localDraft(topic));
      toast(netErrHint(e) + '（已改用本地模板草稿）', true, true);
    } finally {
      btn.disabled = false; btn.textContent = '✎ 起草';
    }
  }

  function buildPremise(f) {
    const lines = ['标题：' + f.title];
    if (f.world) lines.push('世界：' + f.world);
    if (f.role) lines.push('你的角色：' + f.role);
    if (f.chars.length) lines.push('主要人物：' + f.chars.map(c => c.name + '（' + [c.personality, c.speech].filter(Boolean).join('，') + '）').join('；'));
    if (f.style) lines.push('风格：' + f.style);
    if (f.dev) lines.push('想看的发展：' + f.dev);
    lines.push('AI 扮演：旁白，以及故事里除你以外的所有角色。剧情随玩家的行动自由生长，不要拒绝玩家的任何尝试。');
    return lines.join('\n');
  }

  function startFromWizard() {
    const topic = $('#wz-draft-input').value.trim();
    const worldText = $('#wz-world').value.trim();
    const chars = parseCharacterLines($('#wz-characters').value);
    const role = $('#wz-role').value.trim();
    const style = $('#wz-style').value.trim();
    const dev = $('#wz-development').value.trim();
    if (!worldText && !role && !chars.length) {
      toast('至少填一点世界观、人物或你的角色吧', true);
      return;
    }
    const title = (topic || firstSentence(worldText, 20) || '未命名故事').slice(0, 40);
    const premise = buildPremise({ title, world: worldText, role, chars, style, dev });
    const s = Store.newStory({ title, premise, mode: 'choice', styleTone: style });
    // 向导同时初始化世界卡（§4.8）：人物栏 → characters，世界观 → place
    s.world.place = firstSentence(worldText, 40);
    s.world.characters = chars.map(c => ({
      name: c.name, presence: '在场', personality: c.personality, speech: c.speech, note: '', noteLocked: false,
    }));
    Store.seedWorldFromPremise(s, premise);   // 画面参考 / 时间 / 伏笔等留空项按设定补上
    S.story = s;
    closeModal('modal-wizard');
    A.enterGame(true, { deferOpening: true });
    A.openAnchor({ onDone: A.renderChat });   // §12：剧情模式「向导 → 试画」；开场由用户点「开始第一幕」
  }

  function createStoryImmediate(mode) {
    // R13：rp 开局 = 选角色卡（自建空白表单 / 导入 PNG），开场白由卡写、直接进日志
    if (mode === 'rp') { A.openCardEditor({ mode: 'new' }); return; }
    const s = Store.newStory({
      title: '新对话',           // UI-2 §3.2：初始标题「新对话」，回合 1 / 6 由小模型自动起标题
      premise: CHAT_PREMISE,
      mode: 'chat',
    });
    S.story = s;
    A.enterGame(true);
  }

  A.reg({ openWizard, draftWizard, startFromWizard, createStoryImmediate });
})();
