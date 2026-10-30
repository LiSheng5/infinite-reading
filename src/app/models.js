/*
 * src/app/models.js —— 模型能力
 * 从 src/app/main.js 拆出（只搬家，不改行为）。
 */
import { Prefs } from '../core/prefs.ts';
import { Nav } from '../ui/navigation.js';
import { A } from './core.js';


  const S = A.state;
  const { $, Cap, IMAGE_ASPECTS } = A;


  /* ---------------- 模型能力 ---------------- */

  function capChat() {
    // 登记表是纯数据查询；查不到 / 抛错都按「未登记」处理（界面退回默认能力，不打扰用户）
    try { return Cap && Cap.find ? Cap.find('chat', S.settings.chat.model) : null; } catch (_) { /* 未登记 = 默认能力 */ return null; }
  }
  function capImage() {
    try { return Cap && Cap.find ? Cap.find('image', S.settings.image.model) : null; } catch (_) { /* 未登记 = 默认能力 */ return null; }
  }

  // 有效主模型配置：story.prefs.profileId → 模型库；缺省 / 找不到 → 默认主模型。
  // 所有发给主模型的请求与派生量（contextWindow / thinking / extraParams / noTools 键）都走它，
  // 不再直接读 S.settings.chat。
  function chatCfg() {
    const P = Prefs;
    if (P && typeof P.resolveChatCfg === 'function') return P.resolveChatCfg(S.settings, S.story).cfg;
    return S.settings.chat;
  }

  // 有效上下文窗口：用户手填优先，其次登记表；0 = 未知（压缩退回条数兜底）
  function chatContextWindow() {
    const cfg = chatCfg();
    const manual = +cfg.contextWindow || 0;
    if (manual > 0) return manual;
    try {
      const cap = Cap && Cap.find ? Cap.find('chat', cfg.model) : null;
      return (cap && +cap.contextWindow > 0) ? +cap.contextWindow : 0;
    } catch (_) { return 0; }   // 登记表查询失败 = 未知窗口（压缩按条数兜底，功能不受影响）
  }

  function sizeRatioLabel(s) {
    const m = String(s).match(/^(\d+)\s*[x×]\s*(\d+)$/);
    if (!m) return '';
    let a = +m[1], b = +m[2];
    const gcd = (x, y) => y ? gcd(y, x % y) : x;
    const g = gcd(a, b) || 1;
    a /= g; b /= g;
    if (a > 20 || b > 20) return '';
    return '（' + a + ':' + b + '）';
  }

  function pickSizeForAspect(sizes, aspect, w, h) {
    let target = 16 / 9;
    if (IMAGE_ASPECTS[aspect]) { target = IMAGE_ASPECTS[aspect][0] / IMAGE_ASPECTS[aspect][1]; }
    else if (aspect === 'custom' && w > 0 && h > 0) { target = w / h; }
    let best = sizes[0], bestD = Infinity;
    for (const s of sizes) {
      const m = String(s).match(/^(\d+)\s*[x×]\s*(\d+)$/);
      if (!m) continue;
      const d = Math.abs(Math.log((+m[1] / +m[2]) / target));
      if (d < bestD) { bestD = d; best = s; }
    }
    return best;
  }

  const LEVEL_LABELS = { low: '低（low）', medium: '中（medium）', high: '高（high）', max: '最大（max）' };

  // 手填尺寸时显示宽/高输入（预填档位模式下由档位决定，隐藏）
  function showImageWh(show) {
    $('#row-image-wh').classList.toggle('hidden', !show);
    $('#s-image-width').disabled = !show;
    $('#s-image-height').disabled = !show;
  }

  // 选项一律 createElement + textContent（红线「绝不 innerHTML 拼片段」）：
  // 当前数据源是静态注册表，但拼接写法在未来数据源一变即成注入点
  function fillOptions(sel, opts) {
    if (!sel) return;
    sel.textContent = '';
    for (const o of opts) {
      const el = document.createElement('option');
      el.value = String(o[0]);
      el.textContent = String(o[1]);
      sel.appendChild(el);
    }
  }

  // 设置面板：按模型能力显隐参数（思考档位 / 尺寸 / 质量 / 上下文窗口提示）
  function renderCapabilityFields() {
    // —— 对话模型 ——
    const cap = capChat();
    const t = cap && cap.thinking;
    const thinkWrap = $('#wrap-chat-thinking');
    if (t && t.kind !== 'none') {
      thinkWrap.classList.remove('hidden');
      const opts = [['default', '默认（不下发）']];
      if (t.kind === 'toggle') {
        opts.push(['on', '开启思考']);
        if ((t.values || []).indexOf('disabled') >= 0) opts.push(['off', '关闭思考']);
      } else if (t.kind === 'levels') {
        (t.values || []).forEach(v => opts.push([v, LEVEL_LABELS[v] || v]));
        if (t.toggleParam) opts.push(['off', '关闭思考' + (t.alwaysOn ? '（该模型常开，不生效）' : '')]);
      }
      const cur = opts.some(o => o[0] === S.settings.chat.thinking) ? S.settings.chat.thinking : 'default';
      const sel = $('#s-chat-thinking');
      fillOptions(sel, opts);
      sel.value = cur;
      S.settings.chat.thinking = cur;
    } else {
      thinkWrap.classList.add('hidden');
      S.settings.chat.thinking = 'default';
    }
    const ctxInput = $('#s-chat-ctx');
    ctxInput.value = (+S.settings.chat.contextWindow > 0) ? +S.settings.chat.contextWindow : '';
    ctxInput.placeholder = (cap && +cap.contextWindow > 0)
      ? (+cap.contextWindow + '（自动，按登记表）')
      : '不知道就留空（回退按条数压缩）';
    const parts = [];
    if (cap) {
      parts.push('预填参考：' + cap.model + (Cap.summarize ? '（' + Cap.summarize('chat', cap) + '）' : ''));
      if (cap.deprecated) parts.push('注意：该模型名可能已弃用，可改填新的');
    } else {
      parts.push('参数全部手填即可，不影响使用：上下文容量可在服务商「模型广场 / 文档」查到，不知道就留空（回退按条数压缩）；思考档位等厂商参数写进上面的「自定义请求参数」');
    }
    $('#s-chat-cap').textContent = parts.join(' · ');

    // —— 生图模型 ——
    const icap = capImage();
    const sizes = (icap && icap.image && Array.isArray(icap.image.sizes)) ? icap.image.sizes : [];
    const sizeWrap = $('#wrap-image-size'), aspectWrap = $('#wrap-image-aspect');
    const whRow = $('#row-image-wh'), qWrap = $('#wrap-image-quality');
    if (sizes.length) {
      sizeWrap.classList.remove('hidden');
      aspectWrap.classList.add('hidden');
      const sel = $('#s-image-size');
      fillOptions(sel, sizes.map(s => [s, s + sizeRatioLabel(s)])
        .concat([['__custom__', '自定义尺寸…（手填宽高）']]));
      const cur = sizes.indexOf(S.settings.image.size) >= 0
        ? S.settings.image.size
        : (S.settings.image.size === '__custom__'
          ? '__custom__'
          : pickSizeForAspect(sizes, S.settings.image.aspect, +S.settings.image.width, +S.settings.image.height));
      sel.value = cur;
      S.settings.image.size = cur;
      showImageWh(cur === '__custom__');
      const qs = (icap.image.quality || []);
      if (qs.length) {
        qWrap.classList.remove('hidden');
        const qsel = $('#s-image-quality');
        fillOptions(qsel, [['', '默认']].concat(qs.map(q => [q, q])));
        qsel.value = qs.indexOf(S.settings.image.quality) >= 0 ? S.settings.image.quality : '';
        S.settings.image.quality = qsel.value;
      } else {
        qWrap.classList.add('hidden');
        delete S.settings.image.quality;
      }
    } else {
      sizeWrap.classList.add('hidden');
      aspectWrap.classList.remove('hidden');
      whRow.classList.remove('hidden');
      qWrap.classList.add('hidden');
      delete S.settings.image.size;
      delete S.settings.image.quality;
    }
  }

  // 背景图只作用于右栏舞台：底层是当前图的模糊放大副本（CSS 负责模糊 / 压暗）。
  // 全页背景图已取消——阅读面必须是纯 --bg，图不能透到文字后面。
  // 阶段 5：换画走 Nav.stageArt —— 新旧图同名 stage-art，rich 档是共享元素过渡
  //（同一元素的旧 / 新快照做补间，过渡期暂停 Ken Burns，结束按档位恢复）。
  // 换画的两条路都汇到这里：AI 出图后 stagePlaySwap 的 animationend、点缩略图（renderStage → 同一条链）、
  // 视频场景取封面；同图重复调用（renderStage 反复跑）不再开新的一段。
  let stageArtSrc = '';   // 上一次真正落到模糊副本上的 src
  function setStageArt(src) {
    const bd = $('#stage-backdrop');
    if (!bd) return;
    const next = src || '';
    if (next === stageArtSrc) return;
    stageArtSrc = next;
    Nav.stageArt(() => {
      if (!next) {
        bd.classList.remove('show');
        bd.style.backgroundImage = '';
        return;
      }
      bd.style.backgroundImage = 'url(' + JSON.stringify(next) + ')';
      bd.classList.add('show');
    });
  }

  function thumb(dataUrl, maxW) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, (maxW || 560) / img.width);
        const cv = document.createElement('canvas');
        cv.width = Math.round(img.width * scale);
        cv.height = Math.round(img.height * scale);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        try { resolve(cv.toDataURL('image/jpeg', 0.7)); }
        catch (_) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  A.reg({ chatContextWindow, showImageWh, renderCapabilityFields, setStageArt, thumb });

