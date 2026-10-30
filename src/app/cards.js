/*
 * src/app/cards.js —— 角色卡 / 用户画像（数据与导入）
 * 从 src/app/main.js 拆出（只搬家，不改行为）。
 */
import { RoleCard } from '../core/roleCard.ts';
import { Context } from '../core/context.ts';
import { A, renderChat, saveAll, toast } from './core.js';


  const S = A.state;
  const { $, Store, rpPremise, openModal, closeModal, fmtTime } = A;


  /* ================= 角色卡 =================
   * 统一编辑器：自建 = 空白表单；导入 = SillyTavern V2/V3 PNG（只兼容格式，不复制内容）；改完即生效。
   * rp 开局 = 选（建 / 导入）一张角色卡；开场白作为首条旁白；示例对话喂给模型学口吻。 */

  let cardEditor = null;   // { mode: 'new'|'edit', source, onCancel }

  function openCardEditor(opts) {
    opts = opts || {};
    const mode = opts.mode === 'new' ? 'new' : 'edit';
    const card = opts.card || ((mode === 'edit' && S.story && S.story.characterCard) || RoleCard.emptyCard());
    cardEditor = { mode: mode, source: card.source || 'custom', onCancel: opts.onCancel || null };
    fillCardForm(card);
    $('#card-modal-title').textContent = mode === 'new' ? '选一张角色卡（扮演开局）' : '角色卡';
    $('#card-source-hint').textContent = '来源：' + RoleCard.sourceLabel(card)
      + (mode === 'new' ? '。可以空白自建，也可以导入你自己的 SillyTavern V2/V3 PNG 卡；导入后可随意改。' : '（改完即生效，下一回合开始用新卡）');
    $('#btn-rc-save').textContent = mode === 'new' ? '用这张卡开局' : '保存角色卡';
    openModal('modal-card');
  }

  function closeCardEditor(cancel) {
    const cb = cardEditor && cardEditor.onCancel;
    closeModal('modal-card');
    cardEditor = null;
    if (cancel && cb) cb();
  }

  function fillCardForm(card) {
    const c = RoleCard.normalize(card);
    if (cardEditor) cardEditor.source = c.source;
    $('#rc-name').value = c.name;
    $('#rc-appearance').value = c.appearance;
    $('#rc-personality').value = c.personality;
    $('#rc-scene').value = c.scene;
    $('#rc-opening').value = c.opening;
    $('#rc-example').value = c.exampleDialogue;
    $('#rc-note').value = c.systemNote;
    $('#rc-sync-world').checked = true;
  }

  function readCardForm() {
    return RoleCard.normalize({
      name: $('#rc-name').value,
      appearance: $('#rc-appearance').value,
      personality: $('#rc-personality').value,
      scene: $('#rc-scene').value,
      opening: $('#rc-opening').value,
      exampleDialogue: $('#rc-example').value,
      systemNote: $('#rc-note').value,
      source: (cardEditor && cardEditor.source) || 'custom',
      updatedAt: Date.now(),
    });
  }

  function saveCardFromEditor() {
    if (!cardEditor) return;
    const card = readCardForm();
    if (!card.name) { toast('先给角色起个名字吧', true); return; }
    const syncWorld = $('#rc-sync-world').checked;
    if (cardEditor.mode === 'new') {
      closeModal('modal-card');
      cardEditor = null;
      startStoryFromCard(card, syncWorld);
      return;
    }
    if (!S.story) { closeCardEditor(false); return; }
    S.story.characterCard = card;
    if (syncWorld) syncWorldCharacter(card);
    saveAll();
    A.renderStoryPanels();
    A.renderProfilePanel();
    closeCardEditor(false);
    toast('角色卡已保存，改完即生效');
  }

  function importCardFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let card = null;
      try { card = RoleCard.parsePNG(new Uint8Array(reader.result)); } catch (_) { card = null; }
      if (!card) { toast('没能从这张 PNG 里读到角色卡：支持 SillyTavern V2 / V3 内嵌 JSON 的卡', true, true); return; }
      fillCardForm(card);
      toast('已读入角色卡「' + card.name + '」（' + RoleCard.sourceLabel(card) + '），可以随意改，改完保存', false, true);
    };
    reader.readAsArrayBuffer(file);
  }

  // 卡 → 世界卡人物条目（personality / speech 对接）；用户手改过的字段按 mergeWorld 规则保护
  function syncWorldCharacter(card) {
    if (!S.story || !card) return;
    const entry = RoleCard.worldCharacter(card);
    if (!entry) return;
    S.story.world = S.story.world || Store.defaultWorld();
    Context.mergeWorld(S.story.world, { characters: [entry] });
  }

  // 开场白 = rp 首条旁白（不花一次 AI 调用）
  function pushCardOpening(card) {
    const text = String((card && card.opening) || '').trim();
    if (!S.story || !text) return;
    S.story.log.push({ type: 'narration', text: text, versions: [text], activeVersion: 0, ts: Date.now() });
  }

  function startStoryFromCard(card, syncWorld) {
    const s = Store.newStory({
      title: '新对话',           // 扮演新对话初始标题「新对话」，之后自动起标题（titleAuto 默认 true）
      premise: rpPremise(card),
      mode: 'rp',
      characterCard: card,
    });
    if (syncWorld) {
      const entry = RoleCard.worldCharacter(card);
      if (entry) Context.mergeWorld(s.world, { characters: [entry] });
    }
    S.story = s;
    A.enterGame(true, { deferOpening: true });   // rp 不做开局锚定；开场白直接进日志
    pushCardOpening(card);
    saveAll();
    renderChat();
    toast('已登场：' + (card.name || '角色') + '。开场白是角色卡写的，接下来就由你们演。', false, true);
  }

  /* ---------------- 用户画像 ----------------
   * 开关默认全关、可按模式单独开或全开；范围 global（ir:user-profile）/ per-story 用户自选。
   * 收集：真实模式由书记员校对时顺手提取；失败退回本地确定性规则（只认「我…」句式）。
   * 注入：每轮只带与当前话题相关的 Top-N + 常驻一行摘要（assembleAI1 的 opts.profile，见 callAI1）。 */

  function profileOn() {
    const up = S.settings.userProfile || {};
    return Context.profileEnabledFor(up.enabled, (S.story && S.story.mode) || 'choice');
  }

  // 当前生效的画像条目（按 scope 取全局或本档）；关开关 / 没故事 → 空
  function activeProfileEntries() {
    if (!S.story || !profileOn()) return [];
    return ((S.settings.userProfile || {}).scope === 'global')
      ? Store.loadUserProfile()
      : (S.story.userProfile || []);
  }

  // 写入画像：关开关即停止收集；合并去重（同文只留最新），不设条数上限（存储无上限）
  function applyProfileEntries(list) {
    if (!S.story || !profileOn() || !Array.isArray(list) || !list.length) return 0;
    const inc = Context.normalizeProfile(list);
    if (!inc.length) return 0;
    if ((S.settings.userProfile || {}).scope === 'global') {
      Store.saveUserProfile(Context.mergeProfile(Store.loadUserProfile(), inc));
    } else {
      S.story.userProfile = Context.mergeProfile(S.story.userProfile || [], inc);
    }
    return inc.length;
  }

  // 失败兜底：只看玩家最后说的一句（确定性规则）
  function collectProfileLocal() {
    const last = [...((S.story && S.story.log) || [])].reverse().find(e => e.type === 'player' || e.type === 'choice');
    if (!last) return;
    const got = Context.localProfileExtract(last.text);
    if (got.length) { applyProfileEntries(got); saveAll(); }
  }

  // 书记员输入里的画像指示：开没开都说清楚，省得模型乱输出
  function scribeProfileHint() {
    return profileOn()
      ? '[用户画像] 请提取：玩家值得长期记住的信息（每轮最多 3 条，同类只留最新；没有就省略 profile）。'
      : '[用户画像] 未开启：不要输出 profile 字段。';
  }

  A.reg({ openCardEditor, closeCardEditor, saveCardFromEditor, importCardFile, profileOn, activeProfileEntries, applyProfileEntries, collectProfileLocal, scribeProfileHint });

