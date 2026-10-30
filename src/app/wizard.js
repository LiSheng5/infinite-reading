/*
 * src/app/wizard.js —— 开局向导
 * 从 src/app/main.js 拆出（只搬家，不改行为）。
 */
import { ChatProviders } from '../core/providers.ts';
import { charApi } from '../screens/modal/state.svelte.js';
import { A, renderChat, toast } from './core.js';


  const S = A.state;
  const { $, Store, DEFAULT_TOPIC, CHAT_PREMISE, DRAFT_SYSTEM, openModal, closeModal, netErrHint, sleep, fmtTime, resolveSub, reportUserFailure } = A;


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
    if (d.characters && d.characters.length) wzChars().set(d.characters);
    if (d.role) $('#wz-role').value = d.role;
    if (d.styleTone) $('#wz-style').value = d.styleTone;
    if (d.development) $('#wz-development').value = d.development;
  }

  async function draftWizard() {
    const topic = $('#wz-draft-input').value.trim() || DEFAULT_TOPIC;
    const btn = $('#btn-wz-draft');
    // 屏 6b：按钮由 Button 组件产出（图标是一个子节点），文案单独放在 #wz-draft-label，
    // 只能改这个 span 的文字；旧 DOM 没有该 span，退回原来的 textContent / innerHTML 写法。
    const label = $('#wz-draft-label') || btn;
    btn.disabled = true; label.textContent = '起草中…';   // 结束后在 finally 里按「图标 + 起草」还原
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
      toast('草稿已填入，改成你自己的话即可');
    } catch (e) {
      fillWizard(localDraft(topic));
      reportUserFailure('起草', e, { message: netErrHint(e) + '（已改用本地模板草稿）' });   // 「起草」按钮仍在，可再点一次
    } finally {
      btn.disabled = false;
      label.textContent = '起草';
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
      toast('至少填一点世界观、人物或你的角色吧', true);
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
    A.enterGame(true, { deferOpening: true });
    A.openAnchor({ onDone: renderChat });   // 剧情模式「向导 → 试画」；开场由用户点「开始第一幕」
  }

  function createStoryImmediate(mode) {
    // rp 开局 = 选角色卡（自建空白表单 / 导入 PNG），开场白由卡写、直接进日志
    if (mode === 'rp') { A.openCardEditor({ mode: 'new' }); return; }
    const s = Store.newStory({
      title: '新对话',           // 初始标题「新对话」，回合 1 / 6 由小模型自动起标题
      premise: CHAT_PREMISE,
      mode: 'chat',
    });
    S.story = s;
    A.enterGame(true);
  }

  A.reg({ openWizard, draftWizard, startFromWizard, createStoryImmediate });

