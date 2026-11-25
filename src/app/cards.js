/*
 * src/app/cards.js —— 角色卡 / 用户画像（数据与导入）
 */
import { RoleCard } from '../core/roleCard.ts';
import { Context } from '../core/context.ts';
import { setCardView } from '../screens/modal/state.svelte.js';
import { A, renderChat, saveAll, toast } from './core.js';


  const S = A.state;
  const { $, Store, rpPremise, openModal, closeModal, fmtTime, MODE_ENTRY } = A;


  /* ================= 角色卡 =================
   * 双视图编辑器：视图 A「选卡」= 导入 SillyTavern V2/V3 PNG（只兼容格式，不复制内容）/ 自己写一张；
   * 视图 B「编辑」= 名字 + 开场白直给，其余折进「更多设定（可选）」。改完即生效。
   * 聊天带卡开局 = 选（建 / 导入）一张角色卡；开场白作为首条旁白；示例对话喂给模型学口吻。 */

  let cardEditor = null;   // { mode: 'new'|'edit', source, hasExisting, imported, onCancel }

  function openCardEditor(opts) {
    opts = opts || {};
    const mode = opts.mode === 'new' ? 'new' : 'edit';
    const card = opts.card || ((mode === 'edit' && S.story && S.story.characterCard) || RoleCard.emptyCard());
    // hasExisting = 在改一张已经存在的卡；决定初始视图与来源提示的口吻
    const hasExisting = mode === 'edit' && !!(opts.card || (S.story && S.story.characterCard));
    cardEditor = {
      mode: mode,
      source: card.source || 'custom',
      hasExisting: hasExisting,
      imported: null,
      onCancel: opts.onCancel || null,
    };
    fillCardForm(card);
    bindCardExtras();
    // 开局选卡（mode 为 new）或故事里还没有角色卡（聊天设置里补的第一张）→ 先到选卡视图；
    // 编辑已有卡直接进编辑视图。backable 只在这里定：从选卡走过去的编辑视图才有「← 选卡」。
    const wantPick = mode === 'new' || !hasExisting;
    showCardView(wantPick ? 'pick' : 'edit', wantPick);
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
    syncCardMore(true);   // 有内容就把「更多设定（可选）」展开（折叠摘要同步）
  }

  /* ---------- 双视图与折叠区的就地状态（标题 / 提示 / 摘要 / 必填红字），DOM 契约仍按 id 读写 ---------- */

  // 当前是不是「给当前聊天加卡」的场景：聊天还没有卡（空聊天引导页 / 聊天设置的「添加」都走这里）。
  // 否则（没有可挂的聊天）保存时才新建一条带卡聊天。
  function cardAttachToCurrent() {
    return !!(S.story && S.story.mode === 'chat' && !S.story.characterCard);
  }

  // 视图切换（'pick' 选卡 / 'edit' 编辑）：组件按 cardView 状态切 hidden，这里同步文案。
  // 保存钮 / 标题文案按场景改写（组件里只放纯文本子节点）：
  //   选卡视图 = 「给当前聊天加卡」（添加角色卡）或「新建聊天并带卡」（新故事 · 聊天）；
  //   编辑视图 = 改已有卡（保存角色卡）。
  function showCardView(v, backable) {
    const pick = v === 'pick';
    setCardView(pick ? 'pick' : 'edit', backable);
    if (pick && cardEditor) cardEditor.imported = null;   // 回到选卡 = 重新选，导入提示作废
    const attachToCurrent = cardAttachToCurrent();
    $('#card-modal-title').textContent = pick
      ? (attachToCurrent ? '添加角色卡' : MODE_ENTRY.chat.title)
      : '角色卡';
    $('#card-source-hint').textContent = pick ? '' : cardSourceHint();
    $('#btn-rc-save').textContent = (cardEditor && cardEditor.mode === 'new')
      ? (attachToCurrent ? '添加角色卡' : '开始聊天')
      : ((cardEditor && cardEditor.hasExisting) ? '保存角色卡' : '添加角色卡');
    const req = $('#rc-required-hint');
    if (req) req.classList.add('hidden');
    if (!pick) {
      const nameEl = $('#rc-name');
      if (nameEl && !nameEl.value) nameEl.focus();   // 自己写一张 → 直接落在名字上
    }
    syncCardMore(true);
  }

  // 来源提示随场景：导入后报文件名；改已有卡沿用「改完即生效」；
  // 新建说清归属——这张卡会存进故事（characterCard），之后在故事里随时能改。
  function cardSourceHint() {
    if (!cardEditor) return '';
    if (cardEditor.imported) return '已导入：' + cardEditor.imported;
    if (cardEditor.hasExisting) {
      return '来源：' + RoleCard.sourceLabel({ source: cardEditor.source }) + '（改完即生效，下一回合开始用新卡）';
    }
    return '这张卡只属于这次对话：会随故事保存，之后随时能改';
  }

  // 「更多设定（可选）」：摘要行给已填提示；autoOpen 时「有内容就展开」（不自动收起），
  // 与剧情向导的折叠块同一套口径。只认文本字段——同步世界卡勾选框默认就勾着，
  // 算「有内容」的话折叠块会永远自动展开。
  function syncCardMore(autoOpen) {
    const parts = [];
    if ($('#rc-appearance').value.trim()) parts.push('已填外貌');
    if ($('#rc-personality').value.trim()) parts.push('已填性格');
    if ($('#rc-scene').value.trim()) parts.push('已填场景');
    if ($('#rc-example').value.trim()) parts.push('已填示例');
    if ($('#rc-note').value.trim()) parts.push('已填提示');
    const sum = $('#rc-more-sum');
    if (sum) sum.textContent = parts.length ? parts.join(' · ') : '外貌 · 性格 · 场景 · 其他';
    const more = $('#rc-more');
    if (autoOpen && parts.length && more && !more.open) more.open = true;
  }

  // 表单是界面层按 id 灌值的，Svelte 感知不到；折叠摘要与必填红字靠容器上的委托监听同步
  let cardBound = false;
  function bindCardExtras() {
    if (cardBound) return;
    cardBound = true;
    $('#modal-card').addEventListener('input', () => {
      syncCardMore(false);
      const req = $('#rc-required-hint');
      if (req) req.classList.add('hidden');   // 任一项有输入，必填红字就撤
    });
  }

  // 自己写一张：进编辑视图。表单里还是导入来的卡才重置成空白——
  // 用户自己敲过的内容（回选卡再进来）原样保留，不替用户做主。
  function writeCardFromScratch() {
    if (cardEditor && cardEditor.imported) {
      fillCardForm(RoleCard.emptyCard());
      cardEditor.imported = null;
    }
    showCardView('edit');
  }

  // 选卡视图的大按钮走 main.js 的既有绑定（点它开文件框）；编辑视图的「导入 PNG 卡」走这里
  function pickCardFile() {
    const f = $('#file-card');
    if (f) f.click();
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
    if (!card.name) {
      // 就地提示（不弹 toast）：红字给在名字上方，焦点落到名字；有输入即撤
      const req = $('#rc-required-hint');
      if (req) req.classList.remove('hidden');
      const nameEl = $('#rc-name');
      if (nameEl) nameEl.focus();
      return;
    }
    const syncWorld = $('#rc-sync-world').checked;
    if (cardEditor.mode === 'new' && !cardAttachToCurrent()) {
      // 新建聊天并带卡（没有可挂的当前聊天时）
      closeModal('modal-card');
      cardEditor = null;
      startStoryFromCard(card, syncWorld);
      return;
    }
    if (!S.story) { closeCardEditor(false); return; }
    // 给当前聊天加卡 / 改已有卡
    const hadCard = !!S.story.characterCard;
    S.story.characterCard = card;
    if (syncWorld) syncWorldCharacter(card);
    // 给还没有历史的聊天加卡：开场白直接进日志（有卡时的开场方式，与原扮演一致）
    if (!hadCard && !(S.story.log || []).length) pushCardOpening(card);
    saveAll();
    A.renderStoryPanels();
    A.renderProfilePanel();
    closeCardEditor(false);
    // 有没有卡会改输入区口吻（「说点什么」/「说点什么，或交给我办件事」）：加完卡立刻同步一次
    A.syncKindSwitch();
    renderChat();
    toast(hadCard
      ? '角色卡已保存，改完即生效'
      : ('角色卡已添加：' + (card.name || '角色') + (card.opening ? '。开场白是角色卡写的，接下来就由你们演。' : '。')), false, true);
  }

  // 移除角色卡（聊天设置）：二次确认；只摘卡，历史消息与世界卡都保留
  async function removeCardFromStory() {
    if (!S.story || !S.story.characterCard) return;
    if (!await A.irConfirm('移除角色卡？历史消息会保留，之后还可以再添加。', { title: '移除角色卡', okText: '移除' })) return;
    delete S.story.characterCard;
    saveAll();
    A.renderStoryPanels();
    A.syncKindSwitch();   // 摘卡后输入区回到「或交给我办件事」的口吻
    renderChat();
    toast('角色卡已移除，历史消息保留');
  }

  function importCardFile(file) {
    if (!file) return;
    const isPng = file.type === 'image/png' || /\.png$/i.test(file.name || '');
    if (!isPng) { toast('只支持 PNG 格式的角色卡（SillyTavern V2/V3 内嵌 JSON）', true); return; }
    const reader = new FileReader();
    reader.onload = () => {
      let card = null;
      try { card = RoleCard.parsePNG(new Uint8Array(reader.result)); } catch (_) { card = null; }
      if (!card) { toast('没能从这张 PNG 里读到角色卡：支持 SillyTavern V2 / V3 内嵌 JSON 的卡', true, true); return; }
      if (cardEditor) cardEditor.imported = file.name;
      fillCardForm(card);
      showCardView('edit');   // 导入成功 → 进编辑视图（表单已灌值）
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

  // 开场白 = 有卡聊天的首条旁白（不花一次 AI 调用）
  function pushCardOpening(card) {
    const text = String((card && card.opening) || '').trim();
    if (!S.story || !text) return;
    S.story.log.push({ type: 'narration', text: text, versions: [text], activeVersion: 0, ts: Date.now() });
  }

  function startStoryFromCard(card, syncWorld) {
    const s = Store.newStory({
      title: '新对话',           // 带卡聊天初始标题「新对话」，之后自动起标题（titleAuto 默认 true）
      premise: rpPremise(card),
      mode: 'chat',
      characterCard: card,
    });
    if (syncWorld) {
      const entry = RoleCard.worldCharacter(card);
      if (entry) Context.mergeWorld(s.world, { characters: [entry] });
    }
    S.story = s;
    A.enterGame(true, { deferOpening: true });   // 带卡聊天不做开局锚定；开场白直接进日志
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

  A.reg({ openCardEditor, closeCardEditor, showCardView, writeCardFromScratch, pickCardFile, saveCardFromEditor, importCardFile, removeCardFromStory, profileOn, activeProfileEntries, applyProfileEntries, collectProfileLocal, scribeProfileHint });

