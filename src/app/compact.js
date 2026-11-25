/*
 * src/app/compact.js —— 手动压缩（指示器气泡里的「压缩较早的对话」）
 *
 * 回合之外把较早的对话压进摘要栈，与回合收尾的自动压缩同源：
 *   · 切分口径走 Context.planCompression({ force: true })（保留最近 keep 条）；
 *   · 书记员可用 → 双职（压缩 + 校对），只借 A.scribeCompress 发请求与解析；
 *   · 不可用 / 失败 → Context.localSummarize 兜底（本地摘要质量低，完成提示里写明）；
 *   · 写回后必须 Tree.resyncHead（head 已 sealed：不重算窗口，切分支 / 重进故事会回滚）；
 *   · 留痕条目走 Tree.pushLate（回合之外的条目不属于任何节点，story.log.push 会丢）。
 *
 * 异步写回契约：等书记员期间换了故事 → WriteBack.assertStory 失败，结果丢弃、不落盘。
 * 撤销：压缩前 clone { messages, summaries, world }，toast 里 8 秒内可还原（同一条持久化路径）。
 */
import { Context } from '../core/context.ts';
import { Tree } from '../core/tree.ts';
import { WriteBack } from '../core/writeBack.ts';
import { A, renderChat, saveAll, toast } from './core.js';


  const S = A.state;
  const { clone, shortError, failureEntry, reportUserFailure, reportBackgroundFailure } = A;

  const UNDO_MS = 8000;   // toast 上的「撤销」窗口
  let lastUndo = null;    // { storyId, snapshot }：只保留最近一次手动压缩（toast 同时只有一条）
  let running = false;    // 这次手动压缩正在执行（区别于回合生成的 S.busy）：按钮显示「压缩中…」

  // toast 里的「约 A → B token」：与指示器同一口径（buildAssembleOpts dry + estimateTokensOf）。
  // 只是说明文字：算不出来就退回不带 token 的提示，不挡压缩本身。
  function estTokens(story) {
    try {
      const built = A.buildAssembleOpts('', { dry: true });
      return Context.estimateTokensOf(Context.assembleAI1(story, '', built.asmOpts));
    } catch (e) {
      return 0;
    }
  }
  const fmtN = (n) => Number(Math.round(+n || 0)).toLocaleString('en-US');

  // 指示器气泡里「压缩较早的对话」按钮的状态：原因复用前置检查的同一套判定（不复制一份）；
  // path 给按钮标注走哪条路（书记员 / 本地摘要质量低）。
  function compactStatus() {
    const path = A.scribeUsable() ? 'scribe' : 'local';
    if (running) return { ok: false, running: true, reason: '', path: path };
    const gate = compactPrecheck();
    return { ok: gate.ok, running: false, reason: gate.ok ? '' : gate.reason, path: path };
  }

  // 前置检查：返回 { ok:true, plan } 或 { ok:false, reason }。
  // reason 直接给按钮展示；检查本身只读（planCompression 不改 story）。
  function compactPrecheck() {
    if (!S.story) return { ok: false, reason: '未进入故事' };
    if (S.busy) return { ok: false, reason: '正在生成' };
    const tree = S.story.tree;
    const head = tree && tree.nodes && tree.nodes[tree.head];
    if (!head) return { ok: false, reason: '未进入故事' };
    // head 不是叶子 = 停在历史位置：后代各自持有自己的 State 与窗口，压缩传不过去
    if ((head.children || []).length) return { ok: false, reason: '当前在历史位置，先回到最新' };
    const plan = Context.planCompression(S.story, { force: true });
    if (!plan) return { ok: false, reason: '没有可压的内容' };
    return { ok: true, plan: plan };
  }

  // 书记员回包写回：与 turn.js 的 runSmartCompress 同口径（摘要 / 窗口 / 世界卡 / 画像）
  function applyScribe(story, plan, parsed) {
    story.summaries = (story.summaries || []).concat(parsed.summaries);
    story.messages = story.messages.slice(plan.candidate.length);
    Context.trimSummaries(story.summaries, Context.DEFAULT_MAX_SUMMARIES);
    if (parsed.world) Context.mergeWorld(story.world, parsed.world, { allowEmpty: true });
    if (parsed.profile && parsed.profile.length) A.applyProfileEntries(parsed.profile);
    story.world.scribeAt = Date.now();
    return { compressedTurns: parsed.summaries.length, messagesRemoved: plan.candidate.length, summaries: story.summaries.length };
  }

  // 手动压缩：返回 { ok:true, compressedTurns, messagesRemoved, path, fallback } 或
  // { ok:false, reason }（前置检查拒绝 / 换故事丢弃 / 失败）。执行期间占 S.busy，finally 必清。
  async function compactNow() {
    const gate = compactPrecheck();
    if (!gate.ok) return gate;
    const story = S.story;
    const sid = story.id;
    const plan = gate.plan;
    // 撤销快照：只存会被压缩改动的三样（树里的原始 turn 节点不动，这是摘要质量不佳的保险）
    const snapshot = {
      messages: clone(story.messages),
      summaries: clone(story.summaries),
      world: clone(story.world),
    };
    const useScribe = !!A.scribeUsable();
    const estBefore = estTokens(story);
    running = true;
    S.busy = true;
    renderChat();
    try {
      let result = null;
      let path = 'local';
      let scribeErr = '';
      if (useScribe) {
        const rc = await A.scribeCompress(plan.groups);
        // 等书记员期间换了故事：结果丢弃，不落盘
        if (!WriteBack.assertStory(S.story, sid, '手动压缩（书记员）')) {
          return { ok: false, reason: '故事已切换，已丢弃这次压缩' };
        }
        if (rc.err) {
          scribeErr = rc.err;
          reportBackgroundFailure('compact', rc.err, { note: '手动压缩：书记员失败（退回本地摘要）' });
        } else {
          result = applyScribe(story, plan, rc.parsed);
          path = 'scribe';
        }
      }
      if (!result) {
        result = Context.compressStory(story, { summarize: Context.localSummarize, force: true });
        if (!result) return { ok: false, reason: '没有可压的内容' };
      }
      // 树是真源：head 已 sealed，先同步 State / 窗口，再 saveAll；留痕走 pushLate
      Tree.resyncHead(story);
      const estAfter = estTokens(story);
      const entry = scribeErr
        ? failureEntry('compress', scribeErr, {
          summary: '手动压缩：' + result.compressedTurns + ' 幕压入摘要栈（本地摘要，质量较低；书记员失败已退回）',
        })
        : {
          type: 'tool', tool: 'compress',
          summary: '手动压缩：' + result.compressedTurns + ' 幕压入摘要栈（' + (path === 'scribe' ? '书记员' : '本地') + '）',
          ts: Date.now(),
        };
      Tree.pushLate(story, A.treeHeadNodeId(), entry);
      saveAll();
      lastUndo = { storyId: sid, snapshot: snapshot };
      // 完成提示：幕数 + 走的路径（本地质量低要写明）+ token 前后（约 A → B，与指示器同口径）
      const pathText = path === 'scribe' ? '书记员' : (scribeErr ? '本地摘要，质量较低；书记员失败已退回' : '本地摘要，质量较低');
      const range = (estBefore > 0 && estAfter > 0)
        ? ('，约 ' + fmtN(estBefore) + ' → ' + fmtN(estAfter) + ' token')
        : '';
      toast(
        '已压缩 ' + result.compressedTurns + ' 幕（' + pathText + '）' + range,
        false, true,
        { label: '撤销', ms: UNDO_MS, onClick: () => A.compactUndo() }
      );
      return { ok: true, compressedTurns: result.compressedTurns, messagesRemoved: result.messagesRemoved, path: path, fallback: !!scribeErr };
    } catch (e) {
      // 用户刚点的按钮：走用户可行动出口（按钮仍在，可重试）
      reportUserFailure('手动压缩', e, { hint: '可再点一次「压缩较早的对话」' });
      return { ok: false, reason: '压缩失败：' + shortError(e) };
    } finally {
      running = false;
      S.busy = false;
      renderChat();
    }
  }

  // 撤销最近一次手动压缩（toast 的「撤销」入口）：还原 messages / summaries / world，
  // 走与压缩完全相同的 resyncHead + saveAll 持久化路径，切分支 / 重进故事都不会回滚。
  function compactUndo() {
    if (!lastUndo) return false;
    const sid = lastUndo.storyId;
    if (!S.story || S.story.id !== sid) { toast('故事已切换，无法撤销这次压缩'); return false; }
    if (S.busy) { toast('正在生成，等这一步结束再撤销'); return false; }
    const story = S.story;
    const snap = lastUndo.snapshot;
    story.messages = snap.messages;
    story.summaries = snap.summaries;
    story.world = snap.world;
    lastUndo = null;
    Tree.resyncHead(story);
    saveAll();
    renderChat();
    toast('已撤销压缩');
    return true;
  }

  A.reg({ compactNow, compactUndo, compactStatus });
