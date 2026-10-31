/*
 * src/app/importer.js —— 剧情文本导入（路径②）
 * 从 src/app/main.js 拆出（只搬家，不改行为）。
 */
import { Context } from '../core/context.ts';
import { ChatProviders } from '../core/providers.ts';
import { ImportText } from '../core/importText.ts';
import { WriteBack } from '../core/writeBack.ts';
import { charApi } from '../screens/modal/state.svelte.js';
import { A, renderChat, toast } from './core.js';


  const S = A.state;
  const { $, Store, Cap, openModal, closeModal, resolveSub } = A;


  /* ================= 剧情文本导入（路径②） =================
   * 粘贴任意剧情文本 → 整理向导（用「起草模型」；只有装不下才 map-reduce）→
   * premise + world 草稿 + 画风关键词 → 用户确认修改（不可跳过）→ 建新档 → 试画锚定 → 开场。
   * 调用失败退回本地规则。 */

  // 整理模型：弹窗里可选（默认跟随剧情模型；也能用单独配置的起草模型）

  function importCfg() {
    if (S.importModelMode === 'draft') return resolveSub('draft');   // 起草模型（没单独配就是剧情模型）
    const c = S.settings.chat;                                       // 跟随剧情模型
    return {
      // provider 按配置取（剧情模型没写就沿用子模型的归一口径）；写死会在加第二个渠道时静默走错
      provider: c.provider || resolveSub('draft').provider,
      baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model,
      temperature: 0.7,
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
      } catch (_) { return 0; }   // 登记表查询失败 = 未知窗口（只影响提示与分段策略，按一次调用处理）
    }
    return A.chatContextWindow();
  }

  // 粘贴框下方的一行提示：整理模型 + 窗口 + 这次会一次调用还是 map-reduce（返回 plan 供调用方复用）
  function importPlanHint() {
    const raw = ($('#it-text').value || '').trim();
    const win = importContextWindow();
    const plan = Context.planImport(raw, win);
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
    cancelImportJob();
    $('#it-text').value = '';
    $('#it-model-mode').value = S.importModelMode;   // 记住上次选的整理模型
    $('#it-step-paste').classList.remove('hidden');
    $('#it-step-run').classList.add('hidden');
    $('#it-step-confirm').classList.add('hidden');
    importPlanHint();
    openModal('modal-import-text');
    $('#it-text').focus();
  }

  // 异步写回契约：关窗 / 重开 = 结束这次整理任务——标记 cancelled 并中止在途请求；
  // 续体（分段摘要 / 合并 / 整理）靠 job.cancelled 与 S.importJob !== job 自行退出，
  // 不会把结果写回已置空 / 已换掉的任务（writeBackIfSameJob 是最后一道闸）。
  function cancelImportJob() {
    const job = S.importJob;
    S.importJob = null;
    if (!job) return;
    job.cancelled = true;
    if (job.abortCtrl) { try { job.abortCtrl.abort(); } catch (_) { /* 已结束的请求再 abort 会抛：清理是幂等的，忽略 */ } job.abortCtrl = null; }
  }

  function closeImportText() {
    cancelImportJob();
    closeModal('modal-import-text');
  }

  function setImportStatus(text) {
    const el = $('#it-status');
    if (el) el.textContent = text || '';
  }

  async function callImportChat(cfg, task, text, meta, hooks) {
    const adapter = ChatProviders[cfg.provider] || ChatProviders['openai-compatible'];
    return adapter.chat(cfg, Context.assembleImporter(task, text, meta), hooks);
  }

  // 纯解析逻辑（模型回包 JSON / 本地兜底规则 / 人物行）已抽到 src/core/importText.ts，
  // 这里只留界面流；阶段 2 起经 ImportText 调用，函数体与 0.12.1 逐字一致
  function parseImportJson(raw) { return ImportText.parseImportJson(raw); }
  function parseImportSummary(raw) { return ImportText.parseImportSummary(raw); }
  function parseImportResult(raw) { return ImportText.parseImportResult(raw); }
  function localImport(text) { return ImportText.localImport(text); }
  function parseImportCharacters(text) { return ImportText.parseImportCharacters(text); }

  // 人物设定独立控件（可增删行）：姓名 / 在场或离场 / 性格 / 说话方式。
  // 行数据在 src/screens/modal/state.svelte.js，charApi 与旧 A.charEditor 同形的 set / get / add。
  function itChars() {
    return charApi('import');
  }

  function fillImportForm(res, plan) {
    $('#it-title').value = res.title || '';
    $('#it-premise').value = res.premise || '';
    const w = res.world || {};
    $('#it-place').value = w.place || '';
    $('#it-time').value = w.time || '';
    $('#it-scene').value = w.scene || '';
    itChars().set(w.characters || []);
    $('#it-threads').value = (w.threads || []).join('\n');
    $('#it-style').value = (res.styleKeywords || []).join(', ');
    const used = (plan && plan.needsMap) ? (plan.chunks.length + ' 段 map-reduce') : '一次调用';
    $('#it-confirm-info').textContent = '整理方式：' + used + ' · 整理模型：' + importModelLabel()
      + (res.local ? ' · 本地规则兜底（只截了原文开头，建议手动补充）' : '')
      + '。下面每一栏都可以改——确认这一步不能跳过。';
  }

  // 分段摘要合并（分段各出摘要，再一次合并成开局材料）
  async function reduceImportSummaries(cfg, summaries, budget, stale, hooks) {
    let list = summaries.slice();
    for (let round = 0; round < 4; round++) {
      const batches = Context.planImportMerge(list, budget);
      if (batches.length <= 1) break;                 // 已能一次装下（或只剩一条）
      const next = [];
      for (let i = 0; i < batches.length; i++) {
        if (stale && stale()) return '';              // 弹窗已关：不再继续花模型调用
        setImportStatus('合并摘要 · 第 ' + (i + 1) + ' / ' + batches.length + ' 批…');
        const raw = await callImportChat(cfg, 'merge', batches[i].join('\n\n'), undefined, hooks);
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
    const plan = Context.planImport(raw, importContextWindow());
    // 异步写回契约：任务对象持有在局部，关窗 / 重开 / 新一轮整理都会把 S.importJob 置空或换掉
    //（cancelImportJob 还会标 cancelled + abort 在途请求）；续体只认自己这一次的 job，
    // 绝不写 S.importJob.err / .busy，最后一段写回也过 writeBackIfSameJob 闸。
    const job = { raw: raw, plan: plan, busy: true, result: null, err: '', cancelled: false, abortCtrl: null };
    S.importJob = job;
    const stale = () => job.cancelled || !WriteBack.isSameJob(S.importJob, job);
    const hooks = { onAborter(ctrl) { job.abortCtrl = ctrl; } };
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
          if (stale()) return;                        // 弹窗已关：不再继续花模型调用
          setImportStatus('分段摘要 第 ' + (i + 1) + ' / ' + plan.chunks.length + ' 段…');
          const one = await callImportChat(cfg, 'map', plan.chunks[i], { index: i + 1, total: plan.chunks.length }, hooks);
          summaries.push(parseImportSummary(one) || String(plan.chunks[i]).slice(0, 120));
        }
        if (stale()) return;
        setImportStatus('合并摘要…');
        const merged = await reduceImportSummaries(cfg, summaries, plan.budget, stale, hooks);
        if (stale()) return;
        setImportStatus('整理成故事设定…');
        res = parseImportResult(await callImportChat(cfg, 'final', merged, undefined, hooks));
      } else {
        res = parseImportResult(await callImportChat(cfg, 'final', raw, undefined, hooks));
      }
    } catch (e) {
      job.err = (e && e.message) || String(e);
      res = null;
    }

    if (stale()) return;   // 关窗 / 任务被新任务顶掉：结果不再回写，也不碰已经隐藏的 DOM
    const local = !res;
    if (local) res = localImport(raw);
    WriteBack.writeBackIfSameJob(S.importJob, job, (j) => {
      j.busy = false;
      j.result = res;
      fillImportForm(res, plan);
      $('#it-step-run').classList.add('hidden');
      $('#it-step-confirm').classList.remove('hidden');
      toast(local
        ? ('整理没成功（' + (j.err || '模型没给出可用结果') + '）：已用本地规则生成草稿，请手动补充')
        : ('整理完成（' + (plan.needsMap ? plan.chunks.length + ' 段 map-reduce' : '一次调用') + '）：确认或改完再开局'),
        local, local);
    });
  }

  function startFromImport() {
    if (!S.importJob || !S.importJob.result) { toast('先整理一遍再开局', true); return; }
    const title = ($('#it-title').value.trim() || '导入的故事').slice(0, 40);
    const premise = $('#it-premise').value.trim();
    const chars = itChars().get().map(c => ({
      name: c.name, presence: c.presence || '在场', personality: c.personality || '',
      speech: c.speech || '', note: '', noteLocked: false,
    })).filter(c => c.name);
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
    A.openAnchor({ onDone: renderChat });   // 建新档 → 试画锚定；开场由用户点「开始第一幕」
  }

  A.reg({ importPlanHint, openImportText, closeImportText, runImportText, startFromImport });

