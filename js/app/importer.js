/*
 * js/app/importer.js —— 剧情文本导入（R12 路径②）
 * 从 js/app.js 拆出（只搬家，不改行为）。
 */
(function () {
  'use strict';

  const A = IR.App, S = A.state;
  const { $, Store, Cap, toast, openModal, closeModal, resolveSub } = A;


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

  function importCfg() {
    if (S.importModelMode === 'draft') return resolveSub('draft');   // 起草模型（没单独配就是剧情模型）
    const c = S.settings.chat;                                       // 跟随剧情模型
    return {
      provider: 'openai-compatible',
      baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model,
      temperature: 0.7, thinking: 'default',
    };
  }

  // 「这次用谁整理」的一行字（显示在提示与确认页上；避免只写模型名让人误以为是硬编码的）
  function importModelLabel() {
    const cfg = importCfg();
    const src = S.importModelMode === 'draft' ? '起草模型' : '跟随剧情模型';
    return cfg.model ? (cfg.model + '（' + src + '）') : ('未配置模型名（' + src + '）');
  }

  // 整理模型的有效窗口：跟随剧情模型 → 用剧情模型的；起草模型 → 单独配了才查登记表
  function importContextWindow() {
    if (S.importModelMode === 'draft') {
      const sub = S.settings.draft || {};
      if (!sub.provider && !sub.model) return A.chatContextWindow();
      try {
        const w = Cap && Cap.contextWindowOf ? Cap.contextWindowOf(sub.model || S.settings.chat.model, sub.provider) : null;
        return w || 0;
      } catch (_) { return 0; }
    }
    return A.chatContextWindow();
  }

  // 粘贴框下方的一行提示：整理模型 + 窗口 + 这次会一次调用还是 map-reduce（返回 plan 供调用方复用）
  function importPlanHint() {
    const raw = ($('#it-text').value || '').trim();
    const win = importContextWindow();
    const plan = IR.Context.planImport(raw, win);
    const parts = [
      '整理模型：' + importModelLabel(),
      win > 0 ? ('窗口 ' + Cap.formatWindow(win) + ' token') : '窗口未知（按一次调用处理）',
      '约 ' + raw.length + ' 字 → ' + (plan.needsMap
        ? ('分 ' + plan.chunks.length + ' 段 map-reduce，每段 ≤ ' + plan.budget + ' 字')
        : '一次调用'),
    ];
    $('#it-plan-hint').textContent = parts.join(' · ');
    return plan;
  }

  function openImportText() {
    S.importJob = null;
    $('#it-text').value = '';
    $('#it-model-mode').value = S.importModelMode;   // 记住上次选的整理模型
    $('#it-step-paste').classList.remove('hidden');
    $('#it-step-run').classList.add('hidden');
    $('#it-step-confirm').classList.add('hidden');
    importPlanHint();
    openModal('modal-import-text');
    $('#it-text').focus();
  }

  function closeImportText() {
    S.importJob = null;
    closeModal('modal-import-text');
  }

  function setImportStatus(text) {
    const el = $('#it-status');
    if (el) el.textContent = text || '';
  }

  async function callImportChat(cfg, task, text, meta) {
    const adapter = IR.ChatProviders[cfg.provider] || IR.ChatProviders['openai-compatible'];
    return adapter.chat(cfg, IR.Context.assembleImporter(task, text, meta));
  }

  function parseImportJson(raw) {
    const s = String(raw || '');
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    if (i === -1 || j <= i) return null;
    let o = null;
    try { o = JSON.parse(s.slice(i, j + 1)); } catch (_) { return null; }
    return (o && typeof o === 'object') ? o : null;
  }

  function parseImportSummary(raw) {
    const o = parseImportJson(raw);
    return (o && o.summary) ? String(o.summary).trim() : '';
  }

  function parseImportResult(raw) {
    const o = parseImportJson(raw);
    if (!o || (!o.premise && !o.world)) return null;
    const w = (o.world && typeof o.world === 'object') ? o.world : {};
    return {
      title: String(o.title || '').trim().slice(0, 40),
      premise: String(o.premise || '').trim(),
      world: {
        place: String(w.place || ''), time: String(w.time || ''), scene: String(w.scene || ''),
        characters: Array.isArray(w.characters) ? w.characters.filter(c => c && c.name).map(c => ({
          name: String(c.name), presence: String(c.presence || '在场'),
          personality: String(c.personality || ''), speech: String(c.speech || ''), note: String(c.note || ''),
        })).slice(0, 6) : [],
        threads: Array.isArray(w.threads) ? w.threads.filter(Boolean).map(String).slice(0, 12) : [],
      },
      styleKeywords: Array.isArray(o.styleKeywords) ? o.styleKeywords.filter(Boolean).map(String).slice(0, 8) : [],
    };
  }

  // 本地兜底整理：只截取原文开头并结构化（调用失败时用；标「本地规则」，等用户改）
  function localImport(text) {
    const t = String(text || '').replace(/\r\n?/g, '\n').trim();
    const flat = t.replace(/\s+/g, ' ');
    const first = (t.split('\n').map(s => s.trim()).filter(Boolean)[0] || '');
    const book = first.match(/[《【]([^》】]{1,24})[》】]/);
    const head = first
      .replace(/^[#\s]*/, '').replace(/^标题[:：]\s*/, '')
      .replace(/^[《【\[]\s*/, '').replace(/[》】\]]\s*$/, '').trim();
    const title = ((book ? book[1] : head) || '导入的故事').slice(0, 20);
    const names = [];
    const re = /[「"]([^」"]{2,6})[」"]/g;   // 人名只认「」引号（《》是书名）
    let m;
    while ((m = re.exec(t)) && names.length < 4) {
      const n = m[1].trim();
      if (n && names.indexOf(n) < 0) names.push(n);
    }
    return {
      local: true,
      title: title,
      premise: [
        '标题：' + title,
        '世界：' + (flat.slice(0, 120) || '（原文没写清，可自行补充）'),
        '你的角色：故事里的主角（你可以随时扮演成任何人、做任何事）。',
        '风格：按原文语气自行补充。',
        'AI 扮演：旁白，以及故事里除你以外的所有角色。',
      ].join('\n'),
      world: {
        place: '', time: '', scene: flat.slice(0, 60),
        characters: names.map(n => ({ name: n, presence: '在场', personality: '', speech: '', note: '' })),
        threads: [],
      },
      styleKeywords: [],
    };
  }

  function parseImportCharacters(text) {
    return String(text || '').split('\n').map(line => {
      const p = line.split('｜').map(s => s.trim());
      if (!p[0]) return null;
      return { name: p[0], presence: p[1] || '在场', personality: p[2] || '', speech: p[3] || '', note: '', noteLocked: false };
    }).filter(Boolean);
  }

  function fillImportForm(res, plan) {
    $('#it-title').value = res.title || '';
    $('#it-premise').value = res.premise || '';
    const w = res.world || {};
    $('#it-place').value = w.place || '';
    $('#it-time').value = w.time || '';
    $('#it-scene').value = w.scene || '';
    $('#it-characters').value = (w.characters || [])
      .map(c => [c.name, c.presence || '在场', c.personality || '', c.speech || ''].join('｜')).join('\n');
    $('#it-threads').value = (w.threads || []).join('\n');
    $('#it-style').value = (res.styleKeywords || []).join(', ');
    const used = (plan && plan.needsMap) ? (plan.chunks.length + ' 段 map-reduce') : '一次调用';
    $('#it-confirm-info').textContent = '整理方式：' + used + ' · 整理模型：' + importModelLabel()
      + (res.local ? ' · 本地规则兜底（只截了原文开头，建议手动补充）' : '')
      + '。下面每一栏都可以改——确认这一步不能跳过。';
  }

  // 分段摘要合并（§4.11：分段各出摘要，再一次合并成开局材料）
  async function reduceImportSummaries(cfg, summaries, budget) {
    let list = summaries.slice();
    for (let round = 0; round < 4; round++) {
      const batches = IR.Context.planImportMerge(list, budget);
      if (batches.length <= 1) break;                 // 已能一次装下（或只剩一条）
      const next = [];
      for (let i = 0; i < batches.length; i++) {
        setImportStatus('合并摘要 · 第 ' + (i + 1) + ' / ' + batches.length + ' 批…');
        const raw = await callImportChat(cfg, 'merge', batches[i].join('\n\n'));
        next.push(parseImportSummary(raw) || batches[i].join(' ').slice(0, 200));
      }
      list = next;
    }
    return list.join('\n\n');
  }

  async function runImportText() {
    if (S.importJob && S.importJob.busy) return;
    const raw = ($('#it-text').value || '').trim();
    if (raw.length < 20) { toast('先贴一段剧情文本（至少 20 字），再点「开始整理」', true); return; }
    const cfg = importCfg();
    const plan = IR.Context.planImport(raw, importContextWindow());
    S.importJob = { raw: raw, plan: plan, busy: true, result: null, err: '' };
    $('#it-step-paste').classList.add('hidden');
    $('#it-step-confirm').classList.add('hidden');
    $('#it-step-run').classList.remove('hidden');
    $('#it-run-info').textContent = '整理模型：' + importModelLabel() + ' · ' + (plan.needsMap
      ? ('长文：整篇装不下（模型窗口 ' + Cap.formatWindow(plan.window) + '），分 ' + plan.chunks.length + ' 段摘要后再合并')
      : '一次调用整理整篇');
    setImportStatus('整理中…');

    let res = null;
    try {
      if (plan.needsMap) {
        const summaries = [];
        for (let i = 0; i < plan.chunks.length; i++) {
          setImportStatus('分段摘要 第 ' + (i + 1) + ' / ' + plan.chunks.length + ' 段…');
          const one = await callImportChat(cfg, 'map', plan.chunks[i], { index: i + 1, total: plan.chunks.length });
          summaries.push(parseImportSummary(one) || String(plan.chunks[i]).slice(0, 120));
        }
        setImportStatus('合并摘要…');
        const merged = await reduceImportSummaries(cfg, summaries, plan.budget);
        setImportStatus('整理成故事设定…');
        res = parseImportResult(await callImportChat(cfg, 'final', merged));
      } else {
        res = parseImportResult(await callImportChat(cfg, 'final', raw));
      }
    } catch (e) {
      S.importJob.err = (e && e.message) || String(e);
      res = null;
    }

    const local = !res;
    if (local) res = localImport(raw);
    S.importJob.busy = false;
    S.importJob.result = res;
    fillImportForm(res, plan);
    $('#it-step-run').classList.add('hidden');
    $('#it-step-confirm').classList.remove('hidden');
    toast(local
      ? ('整理没成功（' + (S.importJob.err || '模型没给出可用结果') + '）：已用本地规则生成草稿，请手动补充')
      : ('整理完成（' + (plan.needsMap ? plan.chunks.length + ' 段 map-reduce' : '一次调用') + '）：确认或改完再开局'),
      local, local);
  }

  function startFromImport() {
    if (!S.importJob || !S.importJob.result) { toast('先整理一遍再开局', true); return; }
    const title = ($('#it-title').value.trim() || '导入的故事').slice(0, 40);
    const premise = $('#it-premise').value.trim();
    const chars = parseImportCharacters($('#it-characters').value);
    const threads = $('#it-threads').value.split('\n').map(s => s.trim()).filter(Boolean);
    const style = $('#it-style').value.trim();
    if (!premise && !chars.length) {
      toast('设定还空着：至少留一行故事设定或一个人物（这一步不能跳过）', true);
      return;
    }
    const s = Store.newStory({ title: title, premise: premise || ('标题：' + title), mode: 'choice', styleTone: style });
    s.world.place = $('#it-place').value.trim();
    s.world.time = $('#it-time').value.trim();
    s.world.scene = $('#it-scene').value.trim();
    s.world.characters = chars;
    s.world.threads = threads;
    S.story = s;
    closeModal('modal-import-text');
    S.importJob = null;
    A.enterGame(true, { deferOpening: true });
    A.openAnchor({ onDone: A.renderChat });   // §4.11：建新档 → 试画锚定；开场由用户点「开始第一幕」
  }

  A.reg({ importPlanHint, openImportText, closeImportText, runImportText, startFromImport });
})();
