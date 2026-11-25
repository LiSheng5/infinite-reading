/*
 * src/app/wizard.js —— 开局向导
 */
import { ChatProviders } from '../core/providers.ts';
import { charApi } from '../screens/modal/state.svelte.js';
import { A, renderChat } from './core.js';


  const S = A.state;
  const { $, Store, DEFAULT_TOPIC, CHAT_PREMISE, DRAFT_SYSTEM, openModal, closeModal, netErrHint, sleep, resolveSub, reportUserFailure } = A;


  /* ================= 开局向导 ================= */

  // 人物设定独立控件（可增删行）：姓名 / 性格 / 说话方式。
  // 行数据在 src/screens/modal/state.svelte.js，charApi 与旧 A.charEditor 同形的 set / get / add。
  function wzChars() {
    return charApi('wizard');
  }

  function openWizard(prefill) {
    prefill = prefill || {};
    $('#wz-draft-input').value = prefill.topic || '';
    $('#wz-world').value = prefill.world || '';
    wzChars().set(typeof prefill.characters === 'string'
      ? parseCharacterLines(prefill.characters)
      : (prefill.characters || []));
    $('#wz-role').value = prefill.role || '';
    $('#wz-style').value = prefill.style || '';
    $('#wz-development').value = prefill.development || '';
    // 提示行不再报「起草模型：xxx」这类内部配置状态：
    // 已配置 → 平时干净，只在起草完成 / 失败时写结果；未配置 → 一句话说清能做什么（手填 / 去接入）。
    const cfg = resolveSub('draft');
    const e = wzEls();
    e.required.classList.add('hidden');
    e.undo.classList.add('hidden');
    wzDraftUndo = null;
    const btn = $('#btn-wz-draft');
    if (cfg.model) {
      e.hint.textContent = '';
      e.connect.classList.add('hidden');
      btn.disabled = false;
      btn.removeAttribute('title');
    } else {
      e.hint.textContent = '还没接入模型，也可以直接手填';
      e.connect.classList.remove('hidden');
      btn.disabled = true;
      btn.title = '还没接入模型，先去接入';
    }
    bindWzExtras();
    syncWzMore(true);
    openModal('modal-wizard');
  }

  /* ---------- 向导内的就地状态（提示行 / 折叠摘要 / 必填红字），DOM 契约仍按 id 读写 ---------- */

  let wzBound = false;
  let wzDraftUndo = null;   // 起草前的快照（只存内存，不落盘）：撤销起草时原样灌回
  let wzFlashTimer = 0;

  function wzEls() {
    return {
      hint: $('#wz-draft-hint'),
      more: $('#wz-more'),
      sum: $('#wz-more-sum'),
      required: $('#wz-required-hint'),
      undo: $('#btn-wz-undo'),
      connect: $('#btn-wz-connect'),
    };
  }

  // 「更多设定（可选）」：摘要行给已填提示；autoOpen 时「有内容就展开」（不自动收起）。
  // 手动折叠不被普通输入抢回去——只有打开 / 起草回填 / 撤销这类「内容到达」的时机才自动展开。
  function syncWzMore(autoOpen) {
    const chars = wzChars().get();
    const parts = [];
    if (chars.length) parts.push('人物 ' + chars.length);
    if ($('#wz-style').value.trim()) parts.push('已填风格');
    if ($('#wz-development').value.trim()) parts.push('已填发展');
    const e = wzEls();
    e.sum.textContent = parts.length ? parts.join(' · ') : '人物 · 风格 · 发展';
    if (autoOpen && parts.length && !e.more.open) e.more.open = true;
  }

  // 表单是界面层按 id 灌值的，Svelte 感知不到；折叠摘要与必填红字靠容器上的委托监听同步
  function bindWzExtras() {
    if (wzBound) return;
    wzBound = true;
    const root = $('#modal-wizard');
    root.addEventListener('input', () => {
      syncWzMore(false);
      wzEls().required.classList.add('hidden');   // 任一项有输入，必填红字就撤
    });
    root.addEventListener('click', () => syncWzMore(false));   // 增删人物行后刷新「人物 N」
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
    const filled = [];
    if (d.world) { $('#wz-world').value = d.world; filled.push('wz-world'); }
    if (d.characters && d.characters.length) { wzChars().set(d.characters); filled.push('wz-characters'); }
    if (d.role) { $('#wz-role').value = d.role; filled.push('wz-role'); }
    if (d.styleTone) { $('#wz-style').value = d.styleTone; filled.push('wz-style'); }
    if (d.development) { $('#wz-development').value = d.development; filled.push('wz-development'); }
    flashWzFields(filled);
    syncWzMore(true);
  }

  // 被起草填充的字段短暂高亮（约 1.2s）：颜色过渡走 --m-t-* 令牌
  function flashWzFields(ids) {
    clearTimeout(wzFlashTimer);
    for (const id of ids) {
      const el = $('#' + id);
      if (el) el.classList.add('wz-flashable', 'wz-flash');
    }
    wzFlashTimer = setTimeout(() => {
      for (const id of ids) {
        const el = $('#' + id);
        if (el) el.classList.remove('wz-flash');
      }
    }, 1200);
  }

  // 撤销起草：把起草前的快照原样灌回（只存内存）
  function undoDraft() {
    if (!wzDraftUndo) return;
    const u = wzDraftUndo;
    wzDraftUndo = null;
    $('#wz-world').value = u.world;
    wzChars().set(u.characters);
    $('#wz-role').value = u.role;
    $('#wz-style').value = u.style;
    $('#wz-development').value = u.development;
    const e = wzEls();
    e.undo.classList.add('hidden');
    e.hint.textContent = '已撤销起草';
    syncWzMore(true);
  }

  async function draftWizard() {
    const topic = $('#wz-draft-input').value.trim() || DEFAULT_TOPIC;
    const btn = $('#btn-wz-draft');
    // 按钮由 Button 组件产出（图标是一个子节点），文案单独放在 #wz-draft-label，
    // 只能改这个 span 的文字，不能改按钮的 textContent
    const label = $('#wz-draft-label');
    btn.disabled = true; label.textContent = '起草中…';   // 结束后在 finally 里按「图标 + 起草」还原
    wzDraftUndo = {   // 快照先存：失败兜底填的本地模板草稿同样可撤销
      world: $('#wz-world').value,
      characters: wzChars().get(),
      role: $('#wz-role').value,
      style: $('#wz-style').value,
      development: $('#wz-development').value,
    };
    const e = wzEls();
    try {
      const cfg = resolveSub('draft');
      let d = null;
      if (!cfg.model) {
        await sleep(500);
        d = localDraft(topic);
      } else {
        const adapter = ChatProviders[cfg.provider] || ChatProviders['openai-compatible'];
        const raw = await adapter.chat(cfg, [
          { role: 'system', content: DRAFT_SYSTEM },
          { role: 'user', content: topic },
        ]);
        d = parseDraft(raw);
        if (!d) d = localDraft(topic);
      }
      fillWizard(d);
      e.hint.textContent = '草稿已填入，改成你自己的话即可';
    } catch (err) {
      fillWizard(localDraft(topic));
      e.hint.textContent = netErrHint(err) + '（已改用本地模板草稿）';
      reportUserFailure('起草', err, { message: netErrHint(err) + '（已改用本地模板草稿）' });   // 「起草」按钮仍在，可再点一次
    } finally {
      btn.disabled = false;
      label.textContent = '起草';
      e.undo.classList.remove('hidden');
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
    const chars = wzChars().get();
    const role = $('#wz-role').value.trim();
    const style = $('#wz-style').value.trim();
    const dev = $('#wz-development').value.trim();
    if (!worldText && !role && !chars.length) {
      // 就地提示（不弹 toast）：红字出现在三块设定上方，焦点落到世界观；任一项有输入即撤
      const e = wzEls();
      e.required.classList.remove('hidden');
      $('#wz-world').focus();
      return;
    }
    const title = (topic || firstSentence(worldText, 20) || '未命名故事').slice(0, 40);
    const premise = buildPremise({ title, world: worldText, role, chars, style, dev });
    const s = Store.newStory({ title, premise, mode: 'choice', styleTone: style });
    // 向导同时初始化世界卡：人物栏 → characters，世界观 → place
    s.world.place = firstSentence(worldText, 40);
    s.world.characters = chars.map(c => ({
      name: c.name, presence: '在场', personality: c.personality, speech: c.speech, note: '', noteLocked: false,
    }));
    Store.seedWorldFromPremise(s, premise);   // 画面参考 / 时间 / 伏笔等留空项按设定补上
    S.story = s;
    closeModal('modal-wizard');
    A.enterGame(true);
    A.openAnchor({ onDone: renderChat });   // 剧情模式「向导 → 试画」；开场由用户点「开始第一幕」
  }

  function createStoryImmediate() {
    // 新建聊天默认不带卡（角色卡在聊天里随时可加：空聊天引导页 / 聊天设置）
    const s = Store.newStory({
      title: '新对话',           // 初始标题「新对话」，回合 1 / 6 由小模型自动起标题
      premise: CHAT_PREMISE,
      mode: 'chat',
    });
    S.story = s;
    A.enterGame(true);
  }

  A.reg({ openWizard, draftWizard, startFromWizard, createStoryImmediate, undoDraft });

