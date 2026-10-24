/*
 * js/app/styleanchor.js —— 画风锚定（R3 / §5）
 * 从 js/app.js 拆出（只搬家，不改行为）。
 */
(function () {
  'use strict';

  const A = IR.App, S = A.state;
  const { $, toast, openModal, closeModal, offlineBlocked, saveAll, resolveSub, imageCfg } = A;


  /* ================= 画风锚定（R3 / §5，T-P4-1） =================
   * 开局试画 4 张候选（按用户比例）→（可「再试一批」）→ 选定一张
   * → 画师起草视觉设定卡（可改字段 / 跟画师说着改）→ 锁定并记版本；
   * 跳过 = 无卡自由发挥（靠滚动风格摘要）；「锚定画风」按钮随时重走。 */

  function openAnchor(opts) {
    if (!S.story) { toast('先打开一个故事吧'); return; }
    opts = opts || {};
    S.anchor = {
      onDone: typeof opts.onDone === 'function' ? opts.onDone : null,
      batch: 0, tried: [], candidates: [], pickedIdx: -1, card: null,
      busy: false, doneFired: false,
    };
    const card = S.story.styleCard;
    $('#anchor-intro').textContent = (card && card.locked !== false)
      ? '当前已锚定视觉设定卡 v' + (card.version || 1) + '。重走会先按你的风格基调试画 4 张新候选，锁定后替换。'
      : '画师会按你的风格基调试画 4 张候选。点选一张进入视觉设定卡；不满意就「再试一批」，也可以跳过、自由发挥。';
    $('#anchor-step-pick').classList.remove('hidden');
    $('#anchor-step-card').classList.add('hidden');
    $('#ac-chat').value = '';
    $('#ac-status').textContent = '';
    $('#btn-anchor-use').disabled = true;
    openModal('modal-anchor');
    runAnchorBatch();
  }

  // 关闭 = 结束锚定（锁定 / 跳过 / ✕ / Esc 都走这里）；开局场景下继续开场
  function closeAnchor() {
    const a = S.anchor;
    S.anchor = null;
    closeModal('modal-anchor');
    if (a && !a.doneFired) {
      a.doneFired = true;
      if (a.onDone) a.onDone();
    }
  }

  function setAnchorBusy(on, note) {
    const b = !!on;
    $('#btn-anchor-more').disabled = b;
    $('#btn-anchor-use').disabled = b || !S.anchor || S.anchor.pickedIdx < 0;
    $('#btn-anchor-chat').disabled = b;
    $('#btn-anchor-lock').disabled = b;
    $('#btn-anchor-back').disabled = b;
    if (note != null) $('#ac-status').textContent = note;
  }

  function renderAnchorGrid(placeholder) {
    const grid = $('#anchor-grid');
    grid.innerHTML = '';
    if (!S.anchor) return;
    if (placeholder || !S.anchor.candidates.length) {
      const d = document.createElement('div');
      d.className = 'anchor-hint';
      d.textContent = placeholder || '（还没有候选）';
      grid.appendChild(d);
      return;
    }
    S.anchor.candidates.forEach((c, i) => {
      const cardEl = document.createElement('div');
      cardEl.className = 'anchor-card' + (i === S.anchor.pickedIdx ? ' sel' : '');
      if (c.src) {
        const img = document.createElement('img');
        img.src = c.src;
        img.alt = c.alt || c.promptEn || '候选画风';
        cardEl.appendChild(img);
      } else {
        const ph = document.createElement('div');
        ph.className = 'anchor-ph';
        ph.textContent = c.failed ? '这张没画出来' : '试画中…';
        cardEl.appendChild(ph);
      }
      const kw = document.createElement('div');
      kw.className = 'anchor-kw';
      kw.textContent = (c.keywords || []).slice(0, 4).join(', ') || c.alt || '';
      cardEl.appendChild(kw);
      cardEl.onclick = () => {
        if (!S.anchor || !c.src) return;
        S.anchor.pickedIdx = i;
        $('#btn-anchor-use').disabled = S.anchor.busy;
        renderAnchorGrid();
      };
      grid.appendChild(cardEl);
    });
  }

  // 试画一张候选：按用户设置的比例出图；不落档、不进剧情记录
  async function paintCandidate(promptEn) {
    if (offlineBlocked('这次试画')) return null;
    const cfgImg = imageCfg();
    const adapter = IR.ImageProviders[cfgImg.provider] || IR.ImageProviders['openai-images'];
    return adapter.generate(cfgImg, promptEn);
  }

  async function runAnchorBatch() {
    if (!S.anchor || S.anchor.busy) return;
    S.anchor.busy = true;
    S.anchor.candidates = [];
    S.anchor.pickedIdx = -1;
    setAnchorBusy(true);
    renderAnchorGrid('画师正在构思 4 组画风…');
    try {
      const res = await painterAnchorCompose({
        mode: 'styles', batch: S.anchor.batch + 1, tried: S.anchor.tried.slice(-16),
      });
      if (!S.anchor) return;   // 等回包期间被「跳过 / ✕ / Esc」关掉：这条回包直接丢弃，别再碰 anchor
      const styles = (res.styles || []).slice(0, 4);
      if (!styles.length) throw new Error('画师没有给出候选画风');
      S.anchor.batch += 1;
      S.anchor.candidates = styles.map(s => ({
        keywords: s.keywords || [], promptEn: s.promptEn || '', alt: s.alt || '',
        src: '', loading: true, failed: false,
      }));
      for (const c of S.anchor.candidates) S.anchor.tried = S.anchor.tried.concat(c.keywords);
      renderAnchorGrid();
      // 4 张并发试画；回调里按住候选对象本身，批次被替换后不再更新界面
      S.anchor.candidates.forEach(cand => {
        paintCandidate(cand.promptEn).then(src => {
          cand.src = src; cand.loading = false;
          if (S.anchor && S.anchor.candidates.indexOf(cand) >= 0) renderAnchorGrid();
        }).catch(() => {
          cand.loading = false; cand.failed = true;
          if (S.anchor && S.anchor.candidates.indexOf(cand) >= 0) renderAnchorGrid();
        });
      });
    } catch (e) {
      // 已经关掉锚定弹窗时不再打扰用户（回包迟到 / 被跳过）
      if (S.anchor) {
        renderAnchorGrid('试画没成功：' + (e && e.message ? e.message : e) + '（可以点「再试一批」）');
        toast('试画失败：' + (e && e.message ? e.message : e), true, true);
      }
    } finally {
      if (S.anchor) S.anchor.busy = false;
      setAnchorBusy(false);
    }
  }

  async function anchorDraftCard() {
    if (!S.anchor || S.anchor.busy || S.anchor.pickedIdx < 0) return;
    const picked = S.anchor.candidates[S.anchor.pickedIdx];
    if (!picked || !picked.src) { toast('等这张画出来再选吧'); return; }
    S.anchor.busy = true;
    setAnchorBusy(true);
    $('#btn-anchor-use').textContent = '画师起草中…';
    try {
      const res = await painterAnchorCompose({ mode: 'card', picked });
      if (!res.card) throw new Error('画师没有给出设定卡');
      S.anchor.card = res.card;
      fillAnchorCardForm(res.card);
      $('#anchor-card-preview').src = picked.src;
      $('#ac-picked-kw').textContent = '选定画风：' + ((picked.keywords || []).slice(0, 4).join(', ') || picked.alt || '');
      $('#ac-status').textContent = res.reply || '';
      $('#anchor-step-pick').classList.add('hidden');
      $('#anchor-step-card').classList.remove('hidden');
    } catch (e) {
      toast('生成视觉设定卡失败：' + (e && e.message ? e.message : e), true, true);
    } finally {
      if (S.anchor) S.anchor.busy = false;
      $('#btn-anchor-use').textContent = '用这张定画风';
      setAnchorBusy(false);
    }
  }

  function fillAnchorCardForm(card) {
    card = card || {};
    $('#ac-keywords').value = (card.styleKeywords || []).join(', ');
    $('#ac-medium').value = card.medium || '';
    $('#ac-palette').value = card.palette || '';
    $('#ac-characters').value = (card.characters || []).map(c =>
      [c.name || '', c.appearanceEn || '', c.outfit || '', c.features || ''].join('｜')).join('\n');
    $('#ac-negative').value = card.negative || '';
    $('#ac-note').value = card.note || '';
  }

  function readAnchorCardForm() {
    return {
      styleKeywords: $('#ac-keywords').value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
      medium: $('#ac-medium').value.trim(),
      palette: $('#ac-palette').value.trim(),
      characters: $('#ac-characters').value.split('\n').map(line => {
        const p = line.split('｜').map(s => s.trim());
        if (!p[0]) return null;
        return { name: p[0], appearanceEn: p[1] || '', outfit: p[2] || '', features: p[3] || '' };
      }).filter(Boolean),
      negative: $('#ac-negative').value.trim(),
      note: $('#ac-note').value.trim(),
    };
  }

  async function anchorCardChat() {
    if (!S.anchor || S.anchor.busy) return;
    const text = $('#ac-chat').value.trim();
    if (!text) return;
    $('#ac-chat').value = '';
    S.anchor.busy = true;
    setAnchorBusy(true, '画师修改中…');
    try {
      const res = await painterAnchorCompose({
        mode: 'cardchat', currentCard: readAnchorCardForm(), userText: text,
      });
      if (res.card) { S.anchor.card = res.card; fillAnchorCardForm(res.card); }
      $('#ac-status').textContent = res.reply || '已更新设定卡。';
    } catch (e) {
      $('#ac-status').textContent = '';
      toast('画师这次没接上话：' + (e && e.message ? e.message : e), true, true);
    } finally {
      if (S.anchor) S.anchor.busy = false;
      setAnchorBusy(false);
    }
  }

  function anchorLock() {
    if (!S.anchor || !S.story) return;
    const form = readAnchorCardForm();
    if (!form.styleKeywords.length && !form.medium && !form.palette && !form.characters.length && !form.note) {
      toast('至少给卡填一点画风关键词或说明', true);
      return;
    }
    const old = S.story.styleCard;
    S.story.styleCard = Object.assign({
      id: (old && old.id) || IR.genId('style'),
      version: ((old && +old.version) || 0) + 1,
      locked: true,
      updatedAt: Date.now(),
    }, form);
    saveAll();
    toast('已锁定视觉设定卡（v' + S.story.styleCard.version + '）：之后每张画都带着它', false, true);
    closeAnchor();
  }

  function parsePainterAnchor(raw) {
    const s = String(raw || '');
    const i = s.indexOf('{'), j = s.lastIndexOf('}');
    let o = {};
    if (i !== -1 && j > i) { try { o = JSON.parse(s.slice(i, j + 1)); } catch (_) { o = {}; } }
    const styles = Array.isArray(o.styles) ? o.styles.filter(Boolean).map(x => ({
      keywords: Array.isArray(x.keywords) ? x.keywords.filter(Boolean).map(String).slice(0, 8) : [],
      promptEn: String(x.prompt_en || x.promptEn || '').trim(),
      alt: String(x.alt || '').trim(),
    })) : [];
    const c = (o.card && typeof o.card === 'object') ? o.card : null;
    return {
      styles: styles,
      card: c ? {
        styleKeywords: Array.isArray(c.styleKeywords) ? c.styleKeywords.filter(Boolean).map(String).slice(0, 12) : [],
        medium: String(c.medium || '').trim(),
        palette: String(c.palette || '').trim(),
        characters: Array.isArray(c.characters) ? c.characters.filter(x => x && x.name).map(x => ({
          name: String(x.name),
          appearanceEn: String(x.appearanceEn || x.appearance || '').trim(),
          outfit: String(x.outfit || '').trim(),
          features: String(x.features || '').trim(),
        })) : [],
        negative: String(c.negative || '').trim(),
        note: String(c.note || '').trim(),
      } : null,
      reply: String(o.reply || '').trim(),
    };
  }

  // 锚定调用：同样走画师子代理（隔离上下文、用完即弃）
  async function painterAnchorCompose(opts) {
    const cfg = resolveSub('painter');
    const adapter = IR.ChatProviders[cfg.provider] || IR.ChatProviders['openai-compatible'];
    const messages = IR.Context.assemblePainter(S.story, opts);
    const raw = await adapter.chat(cfg, messages);
    return parsePainterAnchor(raw);
  }

  A.reg({ openAnchor, closeAnchor, runAnchorBatch, anchorDraftCard, anchorCardChat, anchorLock });
})();
