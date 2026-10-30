/*
 * src/app/layout.js —— 布局状态（全局设置与本对话设置共用同一入口）
 * 从 src/app/render.js 拆出（只搬家，不改行为）：render.js 在 800 行红线（app-structure-test）。
 *
 * 所有排版只由 #screen-game 的 data-layout 决定：
 *   auto → 宽度 ≥ 900px 用 split，否则 stack；immersive 只能由用户进入。
 * 有效值 = story.prefs.ui 覆盖 → settings.ui 全局默认；story.ui 只记输入类型。 */
import { Prefs } from '../core/prefs.ts';
import { A, saveAll } from './core.js';


  const S = A.state;
  const { $, Store, persistSettings } = A;

  const LAYOUTS = ['auto', 'split', 'stack', 'immersive'];
  // 字号 / 宽度 / 密度：三档映射到令牌（--font-scale / --content-w / --density），不为每档写一套样式
  const FONT_SCALE = { sm: 0.92, md: 1, lg: 1.12 };
  const CONTENT_W = { narrow: '620px', standard: '760px', wide: '920px' };
  const DENSITY = { compact: 0.82, standard: 1 };

  function uiState() {
    if (!S.settings.ui || typeof S.settings.ui !== 'object') S.settings.ui = Store.defaultSettings().ui;
    return S.settings.ui;
  }

  // 有效 UI（只读合并快照）：本对话覆盖 → 全局默认
  function effectiveUi() {
    return Prefs.effective(S.settings, S.story, 'ui');
  }

  // 写回：本对话已覆盖的键写 story.prefs.ui，未覆盖的写全局 settings.ui
  function writeUi(patch) {
    const prefsUi = (S.story && S.story.prefs && S.story.prefs.ui) || null;
    for (const k of Object.keys(patch)) {
      if (prefsUi && Object.prototype.hasOwnProperty.call(prefsUi, k)) prefsUi[k] = patch[k];
      else uiState()[k] = patch[k];
    }
  }

  // UI 写回后的落盘：writeUi 可能写进 **story.prefs.ui**，此时只 persistSettings()
  // （只存全局 settings）等于没存 —— 刷新后本对话的 layout / splitRatio / imageCollapsed 全丢。
  // 有当前故事时走 saveAll（= 全局设置 + 这个故事）；没有故事（首页 / 书架）只有全局可存。
  function commitUi() {
    if (S.story) saveAll();
    else persistSettings();
  }

  // 最近一次的「非沉浸布局配置」：退出沉浸回到它，而不是一律回落 auto。
  // 在这里记而不是在 setLayout 里记：本对话设置面板是直接写 prefs.ui.layout 再 applyLayout 的
  // （不走 setLayout），只有 applyLayout 能看到两条入口的最终状态。只在进程内记 ——
  // 刷新时沉浸态本身就写在 prefs 里，没有可回退的历史值，照旧回落 auto。
  let lastUiLayout = 'auto';

  function autoLayout() {
    return (typeof window !== 'undefined' && window.innerWidth >= 900) ? 'split' : 'stack';
  }

  function effectiveLayout() {
    // v0.6.0：chat（智能体）/ rp（扮演）是纯聊天布局（无画面区）；剧情模式的 split / stack / immersive 一行不动
    if (S.story && (S.story.mode === 'chat' || S.story.mode === 'rp')) return 'chat';
    const ui = effectiveUi();
    if (ui.layout === 'immersive') return 'immersive';
    if (ui.layout === 'split' || ui.layout === 'stack') return ui.layout;
    return autoLayout();
  }

  // 设置里的布局项：chat / rp 下给一行灰字说明（布局选项本身不动，切回剧情模式照常生效）
  function renderLayoutHint() {
    const el = $('#ui-layout-hint');
    if (!el) return;
    const noStage = !!(S.story && (S.story.mode === 'chat' || S.story.mode === 'rp'));
    el.textContent = noStage ? '此模式没有画面区（纯聊天布局），下面的布局选项只对剧情模式生效。' : '';
  }

  function isImmersive() {
    return effectiveLayout() === 'immersive';
  }

  function setLayout(next) {
    const layout = LAYOUTS.indexOf(next) >= 0 ? next : 'auto';
    if (layout !== 'immersive') S.immersiveTextHidden = false;
    writeUi({ layout: layout });
    applyLayout();
    commitUi();
  }

  function applyLayout() {
    const el = $('#screen-game');
    if (!el) return;
    const ui = effectiveUi();
    const layout = effectiveLayout();
    // 记「上一次的非沉浸配置」：退出沉浸回到它；原来是 auto 的仍回 auto，
    // 不把 auto 钉死成某个具体布局（那样宽屏切换 / 旋转就再也不自适应了）。
    if (ui.layout !== 'immersive') lastUiLayout = LAYOUTS.indexOf(ui.layout) >= 0 ? ui.layout : 'auto';
    el.dataset.layout = layout;
    el.style.setProperty('--split-ratio', String(ui.splitRatio || 0.5));
    // 字号 / 宽度 / 密度 → CSS 变量（令牌驱动；chat / rp 的内容区吃这三个变量）
    el.style.setProperty('--font-scale', String(FONT_SCALE[ui.fontScale] != null ? FONT_SCALE[ui.fontScale] : 1));
    el.style.setProperty('--content-w', CONTENT_W[ui.width] || CONTENT_W.standard);
    el.style.setProperty('--density', String(DENSITY[ui.density] != null ? DENSITY[ui.density] : 1));
    el.classList.toggle('no-image', !!ui.imageCollapsed && layout !== 'immersive');
    el.classList.toggle('text-hidden', !!S.immersiveTextHidden);
    if (layout !== 'stack') { el.classList.remove('stage-strip', 'kb-open'); }
    renderLayoutHint();

    const exitBtn = $('#btn-immersive-exit');
    if (exitBtn) exitBtn.classList.toggle('hidden', layout !== 'immersive');
    const toggle = $('#btn-toggle-image');
    if (toggle) toggle.title = ui.imageCollapsed ? '展开画面' : '收起画面';
    const imm = $('#btn-immersive');
    if (imm) imm.title = layout === 'immersive' ? '退出沉浸（Esc）' : '沉浸（画面铺满）';
  }

  // 画面（收起 / 展开舞台）：沉浸态下等同于退出沉浸（回到进入前的布局）
  function toggleStagePanel() {
    if (!S.story) return;
    if (isImmersive()) { exitImmersive(); return; }
    writeUi({ imageCollapsed: !effectiveUi().imageCollapsed });
    applyLayout();
    commitUi();
  }

  function enterImmersive() {
    if (!S.story) return;
    S.immersiveTextHidden = false;
    setLayout('immersive');
  }

  // Esc / ✕ 退出沉浸态：回到进入前的布局（没有记录时回落 auto）
  function exitImmersive() {
    if (!isImmersive()) return false;
    S.immersiveTextHidden = false;
    setLayout(lastUiLayout || 'auto');
    return true;
  }

  function bindSplitter() {
    const sp = $('#splitter');
    if (!sp) return;
    let dragging = false;
    const onMove = (clientX, touch) => {
      if (!S.story || effectiveLayout() !== 'split') return;
      const rect = $('#game-layout').getBoundingClientRect();
      const p = (clientX - rect.left) / Math.max(1, rect.width);
      // 每栏最小约 28%
      writeUi({ splitRatio: Math.max(0.28, Math.min(0.72, p)) });
      applyLayout();
      if (touch && touch.preventDefault) touch.preventDefault();
    };
    const stop = () => {
      if (!dragging) return;
      dragging = false;
      sp.classList.remove('dragging');
      // 拖动过程只改内存（每帧写盘太贵），松手落一次盘；命中 story prefs 的键要随故事存
      commitUi();
    };
    sp.addEventListener('mousedown', e => { dragging = true; sp.classList.add('dragging'); e.preventDefault(); });
    window.addEventListener('mousemove', e => { if (dragging) onMove(e.clientX); });
    window.addEventListener('mouseup', stop);
    sp.addEventListener('touchstart', () => { dragging = true; sp.classList.add('dragging'); }, { passive: true });
    window.addEventListener('touchmove', e => {
      if (dragging && e.touches && e.touches[0]) onMove(e.touches[0].clientX, e);
    }, { passive: false });
    window.addEventListener('touchend', stop);
    // 双击分隔条恢复 1:1
    sp.addEventListener('dblclick', () => {
      writeUi({ splitRatio: 0.5 });
      applyLayout();
      commitUi();
    });
    // 窗口尺寸变化：auto 需要在 split / stack 之间切换
    let rzTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(rzTimer);
      rzTimer = setTimeout(applyLayout, 120);
    });
  }

  A.reg({ effectiveLayout, renderLayoutHint, isImmersive, applyLayout, toggleStagePanel, enterImmersive, exitImmersive, bindSplitter });

