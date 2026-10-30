/*
 * src/app/sidecar.js —— 可选本地服务：连接状态、主动消息投递、下拉菜单
 * 从 src/app/main.js 拆出（只搬家，不改行为）。
 */
import { Sidecar } from '../core/sidecar.ts';
import { Features } from '../core/features.ts';
import { A, toast } from './core.js';


  const S = A.state;
  const { $, reportBackgroundFailure } = A;


  /* ---- 侧车连接状态与主动消息投递 ---- */

  function sidecarReady() {
    const SC = Sidecar;
    return !!(SC && typeof SC.isOnline === 'function' && SC.isOnline() && SC.status().hasToken);
  }

  function sidecarOffHint() {
    return '需要启动本地服务：在项目目录运行 node sidecar/server.mjs，再把终端打印的 token 填到「设置 → 本地服务」。';
  }

  function renderSidecarStatus() {
    const SC = Sidecar;
    const st = SC ? SC.status() : { online: false, hasToken: false, features: {}, lastError: '' };
    const el = $('#sidecar-state');
    if (el) {
      el.textContent = st.online
        ? (st.hasToken ? '本地服务在线' : '本地服务在线（还没填 token）')
        : ('未启动' + (st.lastError ? '：' + st.lastError : ''));
      el.className = 'sidecar-state ' + (st.online ? 'on' : 'off');
    }
    // 三个功能分区：没连上 / 没 token 就整体灰显（安全项真源在侧车，读不到就别给假象）
    const ready = !!(st.online && st.hasToken);
    for (const id of ['#fs-email', '#fs-schedule', '#fs-payment']) {
      const fs = $(id);
      if (fs) fs.classList.toggle('feature-off', !ready);
    }
    renderFeatureBar();
  }

  // 邮件 / 定时主动 / 代下单只在「对话 / 扮演」模式可用：剧情模式里既不能出现，
  // 也不能被触发（入口函数自己也再挡一次，不依赖界面是否渲染）。
  function featuresAllowed() {
    return !!(S.story && (S.story.mode === 'chat' || S.story.mode === 'rp'));
  }

  // 局内功能入口：只有「对话 / 扮演」模式才有「＋」菜单；本地服务没启动时菜单项灰显
  function renderFeatureBar() {
    const plus = $('#btn-more-actions');
    const menu = $('#feature-menu');
    const state = $('#feature-bar-state');
    if (!plus || !menu) return;
    const allowed = featuresAllowed();
    plus.classList.toggle('hidden', !allowed);
    if (!allowed) {
      menu.classList.add('hidden');
      plus.setAttribute('aria-expanded', 'false');
      return;
    }
    const SC = Sidecar;
    const st = SC ? SC.status() : { online: false, hasToken: false, features: {} };
    const ready = !!(st.online && st.hasToken);
    // 「✉ 写邮件」「🛒 代下单」只在智能体（chat）下显示；扮演（rp）只留「⏰ 定时主动」（v0.6.0 行为变更）
    const isChat = !!(S.story && S.story.mode === 'chat');
    const emBtn = $('#btn-feat-email');
    if (emBtn) emBtn.classList.toggle('hidden', !isChat);
    const pmBtn = $('#btn-feat-payment');
    if (pmBtn) pmBtn.classList.toggle('hidden', !isChat);
    for (const sel of ['#btn-feat-email', '#btn-feat-schedule', '#btn-feat-payment']) {
      const b = $(sel);
      if (!b || b.classList.contains('hidden')) continue;
      b.disabled = !ready;
      b.title = ready ? '' : sidecarOffHint();
    }
    if (state) {
      if (!st.online) state.textContent = '本地服务未启动：写邮件 / 定时主动 / 代下单需要先启动本地服务。';
      else if (!st.hasToken) state.textContent = '本地服务在线，但还没填 token（设置 → 本地服务）。';
      else {
        const names = { email: '邮件', schedule: '定时主动', payment: '购物支付' };
        const on = ['email', 'schedule', 'payment'].filter(k => st.features && st.features[k]).map(k => names[k]);
        state.textContent = on.length ? ('已开启：' + on.join('、')) : '都还没在设置里开启。';
      }
    }
  }

  /* ---------- 下拉菜单（顶栏「⋯」/ 输入区「＋」） ---------- */
  function closeMenus(except) {
    for (const menu of document.querySelectorAll('.menu')) {
      if (menu === except) continue;
      menu.classList.add('hidden');
    }
    for (const btn of document.querySelectorAll('[aria-expanded="true"]')) {
      if (except && btn.getAttribute('aria-controls') === except.id) continue;
      btn.setAttribute('aria-expanded', 'false');
    }
  }

  function toggleMenu(btn, menu) {
    if (!btn || !menu) return;
    const willOpen = menu.classList.contains('hidden');
    closeMenus(willOpen ? menu : null);
    menu.classList.toggle('hidden', !willOpen);
    btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    if (willOpen && menu === $('#feature-menu')) renderFeatureBar();
  }

  function yuan(cents) { return (Math.floor(Number(cents) || 0) / 100).toFixed(2) + ' 元'; }

  function irDownloadText(filename, text) {
    try {
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (e) { toast('导出失败：' + ((e && e.message) || e), true); }
  }

  // 页面打开 / 重新上线时补跑：把侧车里排队的触达捞回来（页面关着时侧车只入队，不打扰）
  async function pullProactive() {
    const SC = Sidecar;
    const F = Features;
    if (!SC || !F || !SC.isOnline() || !SC.status().hasToken) return;
    try {
      const list = await SC.listPending();
      for (const p of list) {
        if (p.channel && S.story && p.channel !== S.story.id) continue;   // 指定了别的会话就跳过
        F.accept({ fireId: p.id, prompt: p.prompt, name: p.name, reason: p.reason });
      }
    } catch (e) { reportBackgroundFailure('主动消息', e, { note: '拉取失败，等下一次上线再补' }); }
  }

  async function ackProactive(fireId) {
    const SC = Sidecar;
    if (!SC || !fireId) return;
    try { await SC.ackPending(fireId); }
    catch (e) { reportBackgroundFailure('主动消息确认', e, { note: '确认失败，下次下发会重复提醒' }); }
  }

  function initFeatures() {
    const F = Features;
    if (!F) return;
    F.attach({
      // 什么时候能把主动消息送进回合流程：不忙、有故事、是对话 / 扮演模式、且在线
      canDeliver: () => !S.busy && !!S.story && (S.story.mode === 'chat' || S.story.mode === 'rp')
        && (typeof navigator === 'undefined' || navigator.onLine !== false),
      deliver: async payload => {
        if (!payload || !payload.prompt) return;
        await A.sendPlayerAction(payload.prompt, false, {
          kind: 'agent',
          triggerName: payload.name || '',
          reason: payload.reason || '',
          fireId: payload.fireId || '',
        });
      },
    });
  }

  function initSidecar() {
    const SC = Sidecar;
    if (!SC) return;
    SC.configure(S.settings.sidecar || {});
    SC.on('state', () => {
      renderSidecarStatus();
      if (SC.isOnline() && SC.status().hasToken) { pullProactive(); A.loadFeatureConfig(); }
    });
    SC.on('fire', payload => { if (Features) Features.accept(payload); });
    SC.on('changed', () => { if (typeof A.renderTriggerList === 'function') { try { A.renderTriggerList(); } catch (_) { /* 列表刷新失败不影响推送本身，下次变更再刷 */ } } });
    SC.start();
    renderSidecarStatus();
    pullProactive();
    if (sidecarReady()) A.loadFeatureConfig();
  }

  A.reg({ sidecarReady, sidecarOffHint, renderSidecarStatus, featuresAllowed, renderFeatureBar, closeMenus, toggleMenu, yuan, irDownloadText, ackProactive, initFeatures, initSidecar });

