/*
 * 无限阅读 · 主逻辑（v0.4）
 *
 * 结构：
 *  书架（应用入口，§7/T-P2-1）→ 新故事（选模式 → 剧情走向导 / 对话直接开聊 / 扮演暂自由扮演）
 *  → 阅读页（聊天记录 : 画面 双栏，§4.6）→ AI1 回合（上下文走 IR.Context，与评测同源）
 *  → 画师子代理 + 生图（§3.2/§4.7）→ 书记员 / 压缩（§4.1/§4.10）→ 存档点 / 导出导入（§4.11）
 * 存档：统一走 IR.Store（schema v2）；图片只存缩略图以控制体积。
 */
(function () {
  'use strict';

  const A = IR.App, S = A.state;
  const { $, Store, Cap, DEMO, STYLE_PRESETS, MODE_LABELS, KIND_LABELS, DEFAULT_TOPIC, CHAT_PREMISE, rpPremise, SCRIBE_SYSTEM, SCRIBE_COMPRESS_SYSTEM, SCRIBE_ROLLING_SYSTEM, DRAFT_SYSTEM, IMAGE_ASPECTS, requestChatStop, isStopError, setSendButtonsBusy, motionMQ, motionLevel, applyMotion, applyPaused, motionMs, toast, hideToast, irConfirm, closeConfirm, confirmValue, MODAL_IDS, modalStack, openModal, closeModal, dismissModal, closeTopModal, netErrHint, offlineBlocked, sleep, clone, fmtTime, fmtMB, persistSettings, saveAll, resolveSub, imageCfg, miniBtn } = A;

  /* ================= 事件绑定 ================= */

  function bind() {
    // —— 书架 ——
    $('#btn-new-story').onclick = () => openModal('modal-new');
    $('#btn-close-new').onclick = () => closeModal('modal-new');
    document.querySelectorAll('#modal-new .mode-card').forEach(b => {
      b.onclick = () => {
        const mode = b.dataset.mode;
        closeModal('modal-new');
        if (mode === 'choice') A.openWizard(null);
        else A.createStoryImmediate(mode);
      };
    });
    $('#btn-shelf-settings').onclick = A.openSettings;
    $('#btn-shelf-home').onclick = A.showStart;
    A.initShelf();   // UI-2：搜索框 / 键盘 / 空状态按钮（js/app/shelf.js）
    $('#btn-import').onclick = () => $('#file-import').click();
    $('#file-import').onchange = e => { A.handleImportFile(e.target.files && e.target.files[0]); e.target.value = ''; };

    // —— 剧情文本导入（R12 路径②，§4.11 / T-P6-1） ——
    $('#btn-import-text').onclick = A.openImportText;
    // 首页已换 Svelte 实现（src/screens/home，容器打 data-impl="svelte"）时跳过旧 DOM 绑定，避免双重触发
    const startSvelte = !!document.querySelector('#screen-start[data-impl="svelte"]');
    if (!startSvelte) $('#btn-start-import').onclick = A.openImportText;
    $('#btn-close-import-text').onclick = A.closeImportText;
    $('#btn-it-cancel').onclick = A.closeImportText;
    $('#btn-it-run').onclick = A.runImportText;
    $('#it-text').addEventListener('input', A.importPlanHint);
    $('#it-model-mode').addEventListener('change', e => {
      S.importModelMode = e.target.value === 'draft' ? 'draft' : 'follow';
      A.importPlanHint();
    });
    $('#btn-it-back').onclick = () => {
      if (S.importJob && S.importJob.busy) return;
      $('#it-step-confirm').classList.add('hidden');
      $('#it-step-run').classList.add('hidden');
      $('#it-step-paste').classList.remove('hidden');
      A.importPlanHint();
    };
    $('#btn-it-start').onclick = A.startFromImport;

    // —— 开始页：三张模式卡即三个开局入口，点哪张就按哪种模式开局（无「开始」按钮）——
    //（新首页是 Svelte 自带 handler，见 src/screens/home；旧 DOM 保留到阶段 6）
    if (!startSvelte) {
      document.querySelectorAll('#start-modes .mode-card').forEach(b => {
        b.onclick = () => A.startFromStart(b.dataset.mode);
      });
      $('#btn-start-shelf').onclick = A.showShelf;
      $('#btn-open-settings').onclick = A.openSettings;
      $('#btn-continue').onclick = A.continueLast;
      // 「离线演示」：带上 ?demo=1 重开一次（演示模式靠查询参数判定，刷新即回到普通模式）
      $('#btn-start-demo').onclick = () => { location.href = '?demo=1'; };
    }

    // 拖进窗口即可导入（书架与开始页都支持）
    [$('#screen-shelf'), $('#screen-start')].forEach(scr => {
      scr.addEventListener('dragover', e => { e.preventDefault(); scr.classList.add('dragover'); });
      scr.addEventListener('dragleave', () => scr.classList.remove('dragover'));
      scr.addEventListener('drop', e => {
        e.preventDefault();
        scr.classList.remove('dragover');
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        A.handleImportFile(f);
      });
    });

    // —— 阅读页 HUD ——
    // 左上「←」退出故事回首页；书架、标题与模式留在顶栏，其余收进「⋯」。
    $('#btn-back-home').onclick = A.showStart;
    $('#btn-hud-shelf').onclick = A.showShelf;
    $('#btn-hud-new').onclick = () => { A.closeMenus(); A.newStoryFromGame(); };
    $('#btn-settings').onclick = () => { A.closeMenus(); A.openSettings(); };
    $('#btn-savepoint').onclick = async () => {
      A.closeMenus();
      if (!S.story) return;
      const name = await irConfirm('给这个存档点起个名字', {
        title: '存档点', input: true, okText: '保存',
        value: '第 ' + (S.story.turn || 0) + ' 回合 · ' + new Date().toLocaleTimeString('zh-CN'),
      });
      if (name == null) return;
      A.addSavepoint(String(name).trim() || undefined);
      toast('已打存档点');
    };
    const manualGenerate = () => {
      A.closeMenus();
      if (!S.story) { toast('先打开一个故事吧'); return; }
      if (S.busy) { toast('回复生成中，这一幕写完再作画'); return; }   // §3.C：回复生成中不入队
      if (offlineBlocked('这次作画')) return;   // 离线：不排进队列，也不花额度
      const key = 'manual:' + A.treeHeadNodeId();   // §3.C：同一幕不重复入队
      if (A.paintQ.has(key)) { toast('这一幕已在作画队列里'); return; }
      // 场景描述读当前 head 的 lastSceneSummary（投影后即 story.lastSceneSummary）
      A.enqueueImage(S.story.lastSceneSummary, A.treeHeadNodeId(), key);
      toast('已加入作画队列');
    };
    $('#btn-manual-gen').onclick = manualGenerate;
    $('#btn-stage-gen').onclick = e => { if (e) e.stopPropagation(); manualGenerate(); };
    // 生视频（MiniMax，§8）：🎬 点开小菜单（以当前图生成 / 按剧情文生）；独立异步队列，不堵出图
    const openVideoMenu = e => {
      if (e) e.stopPropagation();
      const item = $('#btn-video-i2v');
      if (item) {
        const sc = A.currentScene();
        const noImg = !sc || A.isVideoScene(sc);
        item.disabled = noImg;
        item.title = noImg ? '还没有当前图：先画一张，或用「按剧情文生视频」' : '以当前画面为首帧做图生视频';
      }
      A.toggleMenu($('#btn-stage-video'), $('#video-menu'));
    };
    $('#btn-stage-video').onclick = openVideoMenu;
    $('#btn-video-i2v').onclick = () => { A.closeMenus(); A.videoFromCurrentImage(); };
    $('#btn-video-t2v').onclick = () => { A.closeMenus(); A.videoFromPlot(); };
    $('#btn-manual-video').onclick = () => { if (S.story) A.generateVideo(); };
    $('#btn-video-cancel').onclick = () => A.cancelActiveVideo();
    $('#btn-toggle-image').onclick = A.toggleStagePanel;
    $('#btn-stage-painter').onclick = e => { if (e) e.stopPropagation(); A.openWorkbench(null); };
    $('#btn-immersive').onclick = e => {
      if (e) e.stopPropagation();
      if (!S.story) return;
      if (A.isImmersive()) A.exitImmersive(); else A.enterImmersive();
    };
    $('#btn-immersive-exit').onclick = e => { if (e) e.stopPropagation(); A.exitImmersive(); };

    // 顶栏「⋯」/ 输入区「＋」：打开前先刷新菜单项状态
    $('#btn-hud-more').onclick = e => { e.stopPropagation(); A.toggleMenu($('#btn-hud-more'), $('#hud-more-menu')); };
    $('#btn-more-actions').onclick = e => { e.stopPropagation(); A.toggleMenu($('#btn-more-actions'), $('#feature-menu')); };
    document.addEventListener('click', e => {
      if (e.target.closest && e.target.closest('.menu-item')) { A.closeMenus(); return; }
      if (e.target.closest && e.target.closest('.menu, .hud-more, .menu-wrap')) return;
      A.closeMenus();
    });

    // 舞台点击：沉浸态显示 / 隐藏文字；堆叠态收起 / 展开成细条
    $('#stage-wrap').addEventListener('click', e => {
      if (e.target.closest && e.target.closest('button')) return;
      const layout = A.effectiveLayout();
      if (layout === 'immersive') {
        S.immersiveTextHidden = !S.immersiveTextHidden;
        $('#screen-game').classList.toggle('text-hidden', S.immersiveTextHidden);
      } else if (layout === 'stack') {
        $('#screen-game').classList.toggle('stage-strip');
      }
    });

    // —— 输入 ——
    const doSend = (opts) => {
      // P0-1：busy 期间只有点「停止」按钮才中断；Enter / 输入不触发（玩家可能只是提前打字）
      if (S.busy) { if (opts && opts.allowStop) requestChatStop(); return; }
      const v = $('#player-input').value.trim();
      if (!v) return;
      $('#player-input').value = '';
      A.sendPlayerAction(v, false);
    };
    $('#btn-send').onclick = () => doSend({ allowStop: true });
    $('#player-input').addEventListener('keydown', e => { if (e.key === 'Enter') doSend(); });

    // 做 / 说 / 导演：状态按故事记住
    document.querySelectorAll('#kind-switch .seg-btn').forEach(b => {
      b.onclick = () => {
        if (!S.story) return;
        const k = b.dataset.kind;
        S.story.ui.kind = (k === 'say' || k === 'direct') ? k : 'do';
        A.syncKindSwitch();
        saveAll();
        $('#player-input').focus();
      };
    });

    // 💡 灵感：展开 / 收起这一轮的选项
    $('#btn-inspiration').onclick = () => {
      if (!S.currentChoices.length || S.busy || S.live) return;
      S.choicesTrayOpen = !S.choicesTrayOpen;
      A.renderChat();
      if (S.choicesTrayOpen) {
        const tray = $('#choice-tray');
        if (tray) tray.scrollLeft = 0;
      }
    };

    // 虚拟键盘：visualViewport 变矮（弹出键盘）时，堆叠态自动把图收成细条
    const vv = window.visualViewport;
    const onViewportChange = () => {
      const game = $('#screen-game');
      if (!game) return;
      const shrunk = !!vv && vv.height < Math.max(300, window.innerHeight * 0.72);
      game.classList.toggle('kb-open', shrunk);
    };
    if (vv) {
      vv.addEventListener('resize', onViewportChange);
      vv.addEventListener('scroll', onViewportChange);
    }
    $('#player-input').addEventListener('focus', () => setTimeout(onViewportChange, 260));
    $('#player-input').addEventListener('blur', () => setTimeout(onViewportChange, 260));

    A.bindSplitter();

    // —— UI-3：本对话设置面板 / 模型库 / 全局设置分组导航 ——
    A.bindPrefsUI();
    A.initSettingsNav();

    // —— UI-4：分支页（顶栏「⋯」→「分支」/ 书架行菜单 / 历史位置提示条） ——
    A.initBranch();

    // —— 向导 ——
    $('#btn-close-wizard').onclick = () => $('#modal-wizard').classList.add('hidden');
    $('#btn-wz-cancel').onclick = () => $('#modal-wizard').classList.add('hidden');
    $('#btn-wz-draft').onclick = A.draftWizard;
    $('#btn-wz-start').onclick = A.startFromWizard;

    // —— 导出 / 设置 ——
    $('#btn-close-export').onclick = () => $('#modal-export').classList.add('hidden');
    $('#btn-do-export').onclick = A.doExport;
    // —— 画师工作台（T-P3-1） ——
    $('#btn-close-painter').onclick = A.closeWorkbench;
    $('#btn-pw-close').onclick = A.closeWorkbench;
    $('#modal-painter').addEventListener('click', e => {
      if (e.target === $('#modal-painter')) A.closeWorkbench();
    });
    $('#btn-pw-redraw').onclick = A.redrawFromWorkbench;
    $('#btn-pw-force').onclick = A.forceRedrawByCard;
    $('#btn-pw-send').onclick = A.painterThreadSend;
    $('#btn-pw-video').onclick = A.pwVideoGenerate;   // 工作台「视频」区（§8）
    $('#pw-input').addEventListener('keydown', e => { if (e.key === 'Enter') A.painterThreadSend(); });
    $('#btn-pw-reset').onclick = () => {
      if (!S.pw) return;
      const sc = A.imageSceneById(S.pw.sceneId);
      const raw = (sc && sc.promptRaw) || S.pw.promptRaw || '';
      if (!raw) { toast('没有存下画师原稿'); return; }
      S.pw.prompt = A.composePrompt(raw, A.styleSuffixText());
      $('#pw-prompt').value = S.pw.prompt;
      toast('已回到画师原稿');
    };
    $('#pw-aspect').onchange = A.pwShowWh;
    $('#pw-width').oninput = A.pwShowWh;
    $('#pw-height').oninput = A.pwShowWh;

    // —— 画风锚定（T-P4-1） ——
    $('#btn-close-anchor').onclick = A.closeAnchor;
    $('#btn-anchor-more').onclick = A.runAnchorBatch;
    $('#btn-anchor-skip').onclick = A.closeAnchor;
    $('#btn-anchor-use').onclick = A.anchorDraftCard;
    $('#btn-anchor-back').onclick = () => {
      if (!S.anchor || S.anchor.busy) return;
      $('#anchor-step-card').classList.add('hidden');
      $('#anchor-step-pick').classList.remove('hidden');
      $('#btn-anchor-use').disabled = S.anchor.pickedIdx < 0;
    };
    $('#btn-anchor-lock').onclick = A.anchorLock;
    $('#btn-anchor-chat').onclick = A.anchorCardChat;
    $('#ac-chat').addEventListener('keydown', e => { if (e.key === 'Enter') A.anchorCardChat(); });
    $('#btn-anchor-rerun').onclick = () => { closeModal('modal-settings'); A.openAnchor({}); };
    $('#btn-pw-anchor').onclick = () => { A.closeWorkbench(); A.openAnchor({}); };

    $('#btn-close-settings').onclick = () => closeModal('modal-settings');
    $('#modal-settings').addEventListener('click', e => {
      if (e.target === $('#modal-settings')) closeModal('modal-settings');
    });
    $('#btn-add-savepoint').onclick = () => {
      if (!S.story) return;
      A.addSavepoint();
      toast('已打存档点');
    };
    $('#btn-clear-notools').onclick = () => {
      S.settings.noTools = [];
      saveAll();
      A.renderNoToolsHint();
      toast('已清空「不接受工具」的模型记录，下次会重新尝试下发工具');
    };
    $('#s-image-aspect').onchange = A.applyAspectToFields;
    $('#s-image-provider').onchange = A.applyImageProviderHint;
    $('#btn-save-card-note').onclick = A.saveCardNote;
    $('#s-story-mode').onchange = A.onModeChange;
    $('#btn-save-world').onclick = A.saveWorldFromForm;
    $('#btn-inject-memory').onclick = A.toggleInjectMemory;

    // —— 角色卡（R13 / T-P7-1） ——
    $('#btn-edit-card').onclick = () => { if (!S.story) { toast('先打开一个故事'); return; } A.openCardEditor({ mode: 'edit' }); };
    $('#btn-close-card').onclick = () => A.closeCardEditor(true);
    $('#btn-rc-cancel').onclick = () => A.closeCardEditor(true);
    $('#btn-rc-save').onclick = A.saveCardFromEditor;
    $('#btn-rc-import').onclick = () => $('#file-card').click();
    $('#file-card').onchange = e => {
      A.importCardFile(e.target.files && e.target.files[0]);
      e.target.value = '';
    };
    $('#modal-card').addEventListener('click', e => {
      if (e.target === $('#modal-card')) A.closeCardEditor(true);
    });

    // —— 用户画像（R13 / T-P7-2） ——
    $('#btn-profile-all').onclick = () => {
      ['#s-profile-choice', '#s-profile-chat', '#s-profile-rp'].forEach(s => { $(s).checked = true; });
    };
    $('#btn-profile-none').onclick = () => {
      ['#s-profile-choice', '#s-profile-chat', '#s-profile-rp'].forEach(s => { $(s).checked = false; });
    };
    $('#btn-profile-clear').onclick = A.clearProfile;
    // —— 测试连接（只探测，不保存、不出图） ——
    Object.keys(A.TEST_TARGETS).forEach(key => {
      const btn = $('#btn-test-' + key);
      if (btn) btn.onclick = () => A.testConnection(key, btn);
    });
    $('#btn-save-settings').onclick = () => {
      A.applyFormToSettings();
      closeModal('modal-settings');
      toast('设置已保存');
      if (A.sidecarReady()) A.saveFeatureConfig();    // 安全项真源在侧车：单独同步一次
    };

    // —— 可选本地服务：探测 / 功能入口 / 安排与台账 ——
    const probeBtn = $('#btn-sidecar-probe');
    if (probeBtn) probeBtn.onclick = () => {
      const SC = IR.Sidecar;
      if (!SC) return;
      S.settings.sidecar = {
        port: Number(($('#s-sidecar-port') || {}).value) || 4319,
        token: (($('#s-sidecar-token') || {}).value || '').trim(),
      };
      persistSettings();
      SC.configure(S.settings.sidecar);
      SC.probe().then(ok => {
        A.renderSidecarStatus();
        if (ok) { toast('本地服务在线'); A.loadFeatureConfig(); }
        else toast('还是连不上：确认已经运行 node sidecar/server.mjs，且端口、token 与配置一致', true, true);
      });
    };
    const triggerBtn = $('#btn-trigger-refresh');
    if (triggerBtn) triggerBtn.onclick = () => A.renderTriggerList();
    const payBtn = $('#btn-pay-refresh');
    if (payBtn) payBtn.onclick = () => A.renderPayLedger();

    const featEmail = $('#btn-feat-email');
    if (featEmail) featEmail.onclick = A.openEmailModal;
    const featPay = $('#btn-feat-payment');
    if (featPay) featPay.onclick = A.openPaymentModal;
    const featSched = $('#btn-feat-schedule');
    if (featSched) featSched.onclick = () => {
      if (!A.featuresAllowed()) { toast('剧情模式里没有定时主动：切到智能体 / 扮演模式再用', true); return; }
      openModal('modal-settings');
      A.initSettingsNav();
      A.openSettingsGroup('g-tools');   // 定时主动在「工具与服务」组里：先切过去，再滚到它
      if (A.sidecarReady()) A.loadFeatureConfig();
      const fs = $('#fs-schedule');
      if (fs && fs.scrollIntoView) fs.scrollIntoView({ block: 'start' });
    };
    const closeEmail = $('#btn-close-email');
    if (closeEmail) closeEmail.onclick = () => closeModal('modal-email');
    const closePay = $('#btn-close-payment');
    if (closePay) closePay.onclick = () => closeModal('modal-payment');
    const emSend = $('#btn-em-send');
    if (emSend) emSend.onclick = A.doEmailSend;
    const pmSubmit = $('#btn-pm-submit');
    if (pmSubmit) pmSubmit.onclick = A.doPaymentSubmit;
    $('#btn-backup-all').onclick = () => {
      A.doBackupAll().catch(e => toast('导出备份失败：' + ((e && e.message) || e), true, true));
    };
    // 清理孤儿原图：只删「没有任何故事引用」的 Blob，剧情 / 缩略图 / 提示词都不动
    $('#btn-clean-images').onclick = async () => {
      const keys = await Store.listImageKeys();
      const keep = Store.knownImageIds();
      const orphans = keys.filter(k => !keep.has(k));
      if (!orphans.length) { toast('没有可清理的原图（现存 ' + keys.length + ' 张，都有故事引用）'); return; }
      if (!await irConfirm('清理 ' + orphans.length + ' 张没有故事引用的原图？剧情、缩略图、提示词都不受影响。', { title: '清理孤儿原图', okText: '清理' })) return;
      orphans.forEach(k => Store.releaseImage(k));
      await Store.flush();
      A.renderStoragePanel();
      toast('已清理 ' + orphans.length + ' 张孤儿原图', false, true);
    };
    $('#btn-clear-save').onclick = async () => {
      if (!await irConfirm('清空本地存档与全部设置？此操作不可恢复。', { title: '危险操作', okText: '清空' })) return;
      Store.clearAll();
      S.settings = Store.defaultSettings();
      S.story = null;
      A.syncSettingsToForm();
      A.showStart();
      toast('已清空');
    };
    // 模型名变化 → 按能力重排参数字段（T-M-1）
    $('#s-chat-model').addEventListener('change', () => {
      const cap = Cap.find('chat', $('#s-chat-model').value.trim());
      S.settings.chat.model = $('#s-chat-model').value.trim();
      if (cap && +cap.contextWindow > 0) S.settings.chat.contextWindow = 0; // 交回登记表自动值
      if (!cap || !cap.thinking || cap.thinking.kind === 'none') S.settings.chat.thinking = 'default';
      A.renderCapabilityFields();
    });
    $('#s-image-model').addEventListener('change', () => {
      S.settings.image.model = $('#s-image-model').value.trim();
      A.renderCapabilityFields();
    });
    // 选了「自定义尺寸…」就亮出宽高输入（预填档位模式下隐藏）
    $('#s-image-size').addEventListener('change', () => {
      S.settings.image.size = $('#s-image-size').value;
      A.showImageWh(S.settings.image.size === '__custom__');
    });
    // 自建确认弹窗（irConfirm）：确定 / 取消 / 关闭 / 回车
    $('#cf-ok').onclick = () => closeConfirm(confirmValue());
    $('#cf-cancel').onclick = () => closeConfirm(null);
    $('#btn-close-confirm').onclick = () => closeConfirm(null);
    $('#modal-confirm').addEventListener('click', e => { if (e.target === $('#modal-confirm')) closeConfirm(null); });
    $('#cf-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); closeConfirm(confirmValue()); }
    });

    // 图片灯箱：点遮罩 / 点图都关（Esc 见下面的全局按键）
    const lightbox = $('#lightbox');
    if (lightbox) lightbox.onclick = () => A.closeLightbox();

    // Esc：只关最上层弹窗（确认弹窗要走 closeConfirm 才能收掉 Promise）；
    // 没有弹窗时才退出沉浸态（P2）。
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      if (A.closeLightbox()) return;   // 灯箱最先关（点遮罩也能关）
      if (closeTopModal()) return;
      const openMenu = document.querySelector('.menu:not(.hidden)');
      if (openMenu) { A.closeMenus(); return; }
      // 本对话设置面板（Svelte 新屏才注册）：Esc 先退世界卡二级视图、再关面板
      if (IR.StoryPanel && IR.StoryPanel.esc && IR.StoryPanel.esc()) return;
      A.exitImmersive();
    });

    // 点弹窗遮罩关闭：只处理最上层，避免误关底下那层
    MODAL_IDS.forEach(id => {
      const el = document.getElementById(id);
      if (!el || id === 'modal-confirm') return;
      el.addEventListener('click', ev => {
        if (ev.target !== el) return;
        if (modalStack[modalStack.length - 1] !== id) return;
        // 功能类弹窗（尤其设置 / 邮件 / 支付）里填了一半的内容，误点遮罩不该丢
        if (id === 'modal-settings' || id === 'modal-email' || id === 'modal-payment' || id === 'modal-wizard') return;
        dismissModal(id);
      });
    });

    // 提示条关闭按钮（只有错误提示才显示）
    const toastClose = $('#toast-close');
    if (toastClose) toastClose.onclick = hideToast;

    // 断网 / 恢复：只是提示，绝不排队、不补发（离线是「这次点了不算」）
    window.addEventListener('offline', () => toast('已断网：聊天与作画暂时用不了，已存的故事照常能看。联网后重新点一次即可（离线期间不会排队、不会事后偷偷扣额度）。', true, true));
    window.addEventListener('online', () => toast('网络回来了：可以继续聊、继续作画。', false, true));

    // 退出即自动存档；页面不可见时暂停循环动画（html[data-paused]）
    window.addEventListener('beforeunload', () => { if (S.story) saveAll(); });
    document.addEventListener('visibilitychange', () => {
      applyPaused();
      if (document.hidden && S.story) saveAll();
    });
  }

  /* ================= 首页无限符号 =================
   * #start-infinity 里是一块 ASCII 字符画。这里把每个非空白字符包成 span.c：
   *   --x = 所在列（决定循环里的相位，色带从左往右流）
   *   --t = 静态时的浅蓝占比（动效关 / 标准档时就停在一道「深 → 浅 → 深」的渐变上）
   * 深色在底层、浅色在 ::after 叠层，只改叠层 opacity 来做深浅循环——
   * 守项目的动画白名单（只动 opacity），循环强度跟随 data-motion（见 style.css 的 .inf）。 */
  function buildInfinity() {
    const pre = $('#start-infinity');
    if (!pre || pre.dataset.ready === '1') return;
    pre.dataset.ready = '1';
    const rows = pre.textContent.split('\n');
    const width = Math.max.apply(null, rows.map(r => r.length)) || 1;
    pre.textContent = '';
    rows.forEach((row, ri) => {
      for (let x = 0; x < row.length; x++) {
        const ch = row[x];
        if (ch === ' ') { pre.appendChild(document.createTextNode(' ')); continue; }
        const span = document.createElement('span');
        span.className = 'c';
        span.dataset.c = ch;
        span.textContent = ch;
        span.style.setProperty('--x', String(x));
        span.style.setProperty('--t', (0.5 - 0.5 * Math.cos(2 * Math.PI * x / Math.max(1, width - 1))).toFixed(2));
        pre.appendChild(span);
      }
      if (ri < rows.length - 1) pre.appendChild(document.createTextNode('\n'));
    });
  }

  /* ================= 启动 ================= */

  function init() {
    // 后台落盘失败（最常见：本地空间满）不再静默：10 秒节流提示一次导出备份
    Store.setPersistErrorHandler(() => {
      if (Date.now() - S.lastSaveWarnAt < 10000) return;
      S.lastSaveWarnAt = Date.now();
      toast('存档写入失败（本地空间可能已满）：请「一键导出全部备份」，或删掉不用的故事 / 原图腾出空间', true, true);
    });
    // 原图是 Blob、异步取的：取到后把画面与缩略图重画一遍
    Store.setImageReadyHandler(() => { A.renderStage(); A.renderThumbs(); });

    Store.migrateLegacy();            // v0.1 旧档 → v0.2（幂等）
    S.settings = Store.loadSettings();  // 迁移后重新读取
    if (DEMO) S.settings = IR.Demo.applyTo(S.settings);   // 只改内存：演示适配器生效，配置不落盘
    // 动效强度（UI-1）：启动写 data-motion；系统「减少动态效果」变化时跟随（显式选择优先）
    applyMotion();
    if (motionMQ) {
      if (motionMQ.addEventListener) motionMQ.addEventListener('change', applyMotion);
      else if (motionMQ.addListener) motionMQ.addListener(applyMotion);
    }
    A.watchStageVisibility();           // Ken Burns 离屏暂停
    buildInfinity();                    // 首页无限符号（逐字上色 + 深浅蓝循环）
    bind();
    A.syncSettingsToForm();
    A.initFeatures();                   // 主动消息编排：去重 + 排队（投递走 sendPlayerAction）
    if (DEMO) {
      // 演示模式保持零外联：把本地服务换成一整套内存 mock，界面链路照样跑通
      if (IR.Demo && IR.Demo.installSidecarMock) IR.Demo.installSidecarMock();
      if (IR.Demo && IR.Demo.applyVideoGate) IR.Demo.applyVideoGate();   // 🎬 置灰（§8）
    }
    A.initSidecar();                    // 探测本地服务；离线则三功能保持禁用
    if (DEMO) A.startDemo();            // 演示模式直接开演（跳过开始页与试画锚定）
    else A.showStart();                 // 入口 = 开始页（v0.1 原样）
    A.renderShelf();
    A.initStorageGuard().then(A.renderStoragePanel);   // P0：申请持久化 + 刷新存储面板
    A.remindBackupIfNeeded();                        // P0：7 天没备份就提醒一次
  }

  // 先进 boot（装载 IndexedDB / 把 localStorage 旧数据迁过来），再进界面。
  // boot 失败会自己退回 localStorage 模式：功能一样，只是容量仍是约 5MB —— 数据不会丢。
  // 但「关键依赖缺失」（IR_DEP_MISSING，加载顺序错了）是启动错误，直接抛出失败——不静默降级。
  (async () => {
    let info = null;
    try {
      info = await Store.boot();
    } catch (e) {
      if (e && e.code === 'IR_DEP_MISSING') throw e;
      console.warn('存储初始化失败：', e);
    }
    init();
    if (info && info.error) {
      toast('本地存储升级未完成（IndexedDB 用不了），已退回原来的存储方式：数据没丢，但容量仍是约 5MB。', true, true);
    } else if (info && info.backend === 'indexeddb' && info.migrated && !info.migrated.skipped && info.migrated.stories) {
      toast('已把 ' + info.migrated.stories + ' 个故事迁移到 IndexedDB：容量不再受 5MB 限制。旧数据仍原样保留在本机，可随时回退。', false, true);
    }
  })();
})();
