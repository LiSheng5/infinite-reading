/*
 * js/app/cards.js —— 角色卡 / 用户画像（数据与导入）
 * 从 js/app.js 拆出（只搬家，不改行为）。
 */
(function () {
  'use strict';

  const A = IR.App, S = A.state;
  const { $, Store, rpPremise, toast, openModal, closeModal, fmtTime, saveAll } = A;


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

  let cardEditor = null;   // { mode: 'new'|'edit', source, onCancel }

  function openCardEditor(opts) {
    opts = opts || {};
    const mode = opts.mode === 'new' ? 'new' : 'edit';
    const card = opts.card || ((mode === 'edit' && S.story && S.story.characterCard) || IR.RoleCard.emptyCard());
    cardEditor = { mode: mode, source: card.source || 'custom', onCancel: opts.onCancel || null };
    fillCardForm(card);
    $('#card-modal-title').textContent = mode === 'new' ? '选一张角色卡（扮演开局）' : '角色卡';
    $('#card-source-hint').textContent = '来源：' + IR.RoleCard.sourceLabel(card)
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
    const c = IR.RoleCard.normalize(card);
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
    return IR.RoleCard.normalize({
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
      try { card = IR.RoleCard.parsePNG(new Uint8Array(reader.result)); } catch (_) { card = null; }
      if (!card) { toast('没能从这张 PNG 里读到角色卡：支持 SillyTavern V2 / V3 内嵌 JSON 的卡', true, true); return; }
      fillCardForm(card);
      toast('已读入角色卡「' + card.name + '」（' + IR.RoleCard.sourceLabel(card) + '），可以随意改，改完保存', false, true);
    };
    reader.readAsArrayBuffer(file);
  }

  // 卡 → 世界卡人物条目（personality / speech 对接，§4.12）；用户手改过的字段按 mergeWorld 规则保护
  function syncWorldCharacter(card) {
    if (!S.story || !card) return;
    const entry = IR.RoleCard.worldCharacter(card);
    if (!entry) return;
    S.story.world = S.story.world || Store.defaultWorld();
    IR.Context.mergeWorld(S.story.world, { characters: [entry] });
  }

  // 开场白 = rp 首条旁白（不花一次 AI 调用；§4.12）
  function pushCardOpening(card) {
    const text = String((card && card.opening) || '').trim();
    if (!S.story || !text) return;
    S.story.log.push({ type: 'narration', text: text, versions: [text], activeVersion: 0, ts: Date.now() });
  }

  function startStoryFromCard(card, syncWorld) {
    const s = Store.newStory({
      title: '新对话',           // UI-2 §3.2：扮演新对话初始标题「新对话」，之后自动起标题（titleAuto 默认 true）
      premise: rpPremise(card),
      mode: 'rp',
      characterCard: card,
    });
    if (syncWorld) {
      const entry = IR.RoleCard.worldCharacter(card);
      if (entry) IR.Context.mergeWorld(s.world, { characters: [entry] });
    }
    S.story = s;
    A.enterGame(true, { deferOpening: true });   // rp 不做开局锚定（P4）；开场白直接进日志
    pushCardOpening(card);
    saveAll();
    A.renderChat();
    toast('已登场：' + (card.name || '角色') + '。开场白是角色卡写的，接下来就由你们演。', false, true);
  }

  /* ---------------- 用户画像（R13 / §4.12 / T-P7-2） ----------------
   * 开关默认全关、可按模式单独开或全开；范围 global（ir:user-profile）/ per-story 用户自选。
   * 收集：真实模式由书记员校对时顺手提取；失败退回本地确定性规则（只认「我…」句式）。
   * 注入：每轮只带与当前话题相关的 Top-N + 常驻一行摘要（assembleAI1 的 opts.profile，见 callAI1）。 */

  function profileOn() {
    const up = S.settings.userProfile || {};
    return IR.Context.profileEnabledFor(up.enabled, (S.story && S.story.mode) || 'choice');
  }

  // 当前生效的画像条目（按 scope 取全局或本档）；关开关 / 没故事 → 空
  function activeProfileEntries() {
    if (!S.story || !profileOn()) return [];
    return ((S.settings.userProfile || {}).scope === 'global')
      ? Store.loadUserProfile()
      : (S.story.userProfile || []);
  }

  // 写入画像：关开关即停止收集；合并去重（同文只留最新），不设条数上限（§4.12 存储无上限）
  function applyProfileEntries(list) {
    if (!S.story || !profileOn() || !Array.isArray(list) || !list.length) return 0;
    const inc = IR.Context.normalizeProfile(list);
    if (!inc.length) return 0;
    if ((S.settings.userProfile || {}).scope === 'global') {
      Store.saveUserProfile(IR.Context.mergeProfile(Store.loadUserProfile(), inc));
    } else {
      S.story.userProfile = IR.Context.mergeProfile(S.story.userProfile || [], inc);
    }
    return inc.length;
  }

  // 失败兜底：只看玩家最后说的一句（确定性规则）
  function collectProfileLocal() {
    const last = [...((S.story && S.story.log) || [])].reverse().find(e => e.type === 'player' || e.type === 'choice');
    if (!last) return;
    const got = IR.Context.localProfileExtract(last.text);
    if (got.length) { applyProfileEntries(got); saveAll(); }
  }

  // 书记员输入里的画像指示：开没开都说清楚，省得模型乱输出
  function scribeProfileHint() {
    return profileOn()
      ? '[用户画像] 请提取：玩家值得长期记住的信息（每轮最多 3 条，同类只留最新；没有就省略 profile）。'
      : '[用户画像] 未开启：不要输出 profile 字段。';
  }

  A.reg({ openCardEditor, closeCardEditor, saveCardFromEditor, importCardFile, profileOn, activeProfileEntries, applyProfileEntries, collectProfileLocal, scribeProfileHint });
})();
