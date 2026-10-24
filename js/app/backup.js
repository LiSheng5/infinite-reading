/*
 * js/app/backup.js —— 本地存储与备份（P0 数据安全）
 * 从 js/app.js 拆出（只搬家，不改行为）。
 */
(function () {
  'use strict';

  const A = IR.App, S = A.state;
  const { $, Store, DEMO, toast, irConfirm, openModal, closeModal, clone, fmtTime, fmtMB, persistSettings } = A;


  /* ================= 本地存储与备份（P0 数据安全） =================
   * 全部数据只在浏览器 localStorage（每站点约 5MB），没有任何服务端。这里做三件事：
   *  1) 申请持久化存储 navigator.storage.persist()：磁盘压力下的 LRU 淘汰会跳过本站
   *     （Safari 的 7 天无交互清除仍会生效，只能靠交互 / 加到主屏缓解）
   *  2) 算清本应用占用量，到 70% 提前预警（原来的提示只在写入失败之后才出现，已经晚了）
   *  3) 「一键导出全部备份」(.irbackup.json，可整体还原) + 超过 7 天没备份就提醒一次
   */
  let persistGranted = null;                      // null = 未知 / 不支持
  const LS_CHAR_LIMIT = 5000000;                  // localStorage 每站点约 5MB，按 UTF-16 字符数保守算
  const BACKUP_REMIND_MS = 7 * 24 * 3600 * 1000;  // 7 天
  const BACKUP_NAG_MS = 24 * 3600 * 1000;         // 提醒本身每天最多一次

  async function initStorageGuard() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        persistGranted = navigator.storage.persisted ? await navigator.storage.persisted() : false;
        if (!persistGranted) persistGranted = await navigator.storage.persist();
      }
    } catch (_) { persistGranted = null; }
  }

  // 只统计本应用的键（ir: 前缀）：localStorage 上限是所有键共享的，这里的占用才是我们能控的
  function localUsage() {
    let chars = 0, keys = 0;
    try {
      const LS = window.localStorage;
      for (let i = 0; i < LS.length; i++) {
        const k = LS.key(i);
        if (!k || k.indexOf('ir:') !== 0) continue;
        chars += k.length + String(LS.getItem(k) || '').length;
        keys++;
      }
    } catch (_) {}
    return { chars: chars, keys: keys };
  }

  function markBackedUp() {
    S.settings.lastBackupAt = Date.now();
    S.settings.lastBackupRemindAt = Date.now();
    persistSettings();
    renderBackupHint();
  }

  function renderBackupHint() {
    const el = $('#backup-at');
    if (!el) return;
    const t = +S.settings.lastBackupAt || 0;
    el.textContent = t
      ? ('上次备份：' + fmtTime(t) + ((Date.now() - t > BACKUP_REMIND_MS) ? '（已超过 7 天，建议再备一次）' : ''))
      : '还没备份过';
    el.classList.toggle('alert', !t || (Date.now() - t > BACKUP_REMIND_MS));
  }

  // 真实占用：navigator.storage.estimate()（把 IndexedDB / Cache 等一起算在内，比数键位准得多）
  async function renderUsageLine() {
    const el = $('#storage-usage');
    if (!el) return;
    el.textContent = '正在统计占用…';
    let est = null;
    try { est = IR.Storage ? await IR.Storage.estimate() : null; } catch (_) {}
    let imgs = 0;
    try { imgs = (await Store.listImageKeys()).length; } catch (_) {}
    el.textContent = (est && est.usage != null)
      ? ('实测占用：约 ' + fmtMB(est.usage) + (est.quota ? '（浏览器给的额度约 ' + fmtMB(est.quota) + '）' : '')
        + ' · 现存原图 ' + imgs + ' 张。IndexedDB 的可用容量取决于浏览器、设备剩余空间与存储策略，不是无限大。')
      : ('这台浏览器查不到占用统计 · 现存原图 ' + imgs + ' 张。');
  }

  function renderStoragePanel() {
    const u = localUsage();
    const pct = Math.min(100, Math.round(u.chars / LS_CHAR_LIMIT * 100));
    const n = Store.listStories().length;
    const info = Store.storageInfo();
    const st = $('#storage-state');
    if (st) {
      if (info.backend === 'indexeddb') {
        st.textContent = '当前主库：IndexedDB（' + n + ' 个故事）—— 已解除 localStorage 约 5MB 的限制，'
          + '原图以 Blob 单独存放，缩略图与文本照旧跟着故事走。';
        st.classList.remove('alert');
      } else {
        st.textContent = '本应用存档已用约 ' + pct + '%（' + n + ' 个故事 / ' + u.keys + ' 个键位）——'
          + (pct >= 70
            ? '⚠ 接近写入上限，先「一键导出全部备份」，再删掉不用的故事腾空间。'
            : '每个站点约 5MB，到 70% 以上就该收拾一下了。')
          + (info.bootError
            ? '（升级到 IndexedDB 时出错，已安全退回：' + info.bootError + ' —— 数据没丢，但容量仍是约 5MB）'
            : (info.available ? '' : '（这台浏览器用不了 IndexedDB，所以退回原来的存储方式）'));
        st.classList.toggle('alert', pct >= 70);
      }
    }
    renderUsageLine();
    const ps = $('#storage-persist');
    if (ps) {
      ps.textContent = persistGranted === true
        ? '已获得「持久化存储」授权：浏览器的自动淘汰会跳过本站（手动清除数据、Safari 的 7 天规则仍会删）。'
        : (persistGranted === false
          ? '⚠ 未获得「持久化存储」授权：磁盘紧张时浏览器可能自动淘汰本站数据。多与页面交互、或把页面加为书签 / 应用，再刷新有机会获批。'
          : '（当前浏览器不支持，或暂时查不到持久化存储授权状态。）');
      ps.classList.toggle('alert', persistGranted === false);
    }
    renderBackupHint();
  }

  // 导出包：默认剥掉 API Key（备份文件常被放进网盘，带 Key 等于把钱包一起备份）
  // UI-3：模型库 profiles[] 同样走这把刀（默认不带 Key 的语义不变，只是覆盖新增的 profiles）
  function buildBackupPack(stripKeys) {
    const s = clone(S.settings);
    if (stripKeys) {
      ['chat', 'painter', 'scribe', 'draft', 'image', 'video'].forEach(k => { if (s[k]) s[k].apiKey = ''; });
      if (Array.isArray(s.profiles)) s.profiles.forEach(p => { if (p) p.apiKey = ''; });
    }
    return {
      format: 'ir-backup', schema: 1, app: '无限阅读 v0.12.0',
      exportedAt: Date.now(),
      settings: s,
      userProfile: Store.loadUserProfile(),
      stories: Store.listStories().map(it => Store.loadStory(it.id)).filter(Boolean),
    };
  }

  /* 「带原图备份」= 一个 zip 里放两样东西：
   *   ir-backup.json      与普通备份完全同款（schema 2 只多一份 images 清单）
   *   images/0001.png …   原图按二进制原样存放
   * 为什么不把原图 base64 塞进 JSON：大图转 base64 体积涨约 1/3，还会在内存里堆成巨型字符串；
   * zip 装的是原始字节，体积最省，导出 / 导入都不容易把内存打爆。代价是 .zip 不能直接肉眼查看。 */
  const IMAGE_EXT = {
    'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
    'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg',
  };

  async function buildBackupZip(pack, onProgress) {
    // 只打包「还有故事引用着」的原图：孤儿图（引用已被删）本来就要靠「清理孤儿原图」清掉，不进备份。
    // §0：视频本体不进备份（体积），只留封面——封面在 scene / log 的 thumb 里随 json 走。
    const ids = Array.from(Store.knownImageIds()).filter(id => !/^vid:/.test(String(id)));
    const files = [];
    const manifest = [];
    let bytes = 0;
    for (let i = 0; i < ids.length; i++) {
      const blob = await Store.getImage(ids[i]);
      if (blob && blob.size) {
        const path = 'images/' + String(manifest.length + 1).padStart(4, '0') + '.' + (IMAGE_EXT[blob.type] || 'bin');
        files.push({ name: path, data: blob });
        manifest.push({ id: ids[i], path: path, type: blob.type || 'application/octet-stream', size: blob.size });
        bytes += blob.size;
      }
      if (onProgress) onProgress(i + 1, ids.length, bytes);
    }
    const body = Object.assign({}, pack, { schema: 2, images: manifest });
    files.unshift({ name: 'ir-backup.json', data: JSON.stringify(body, null, 1) });
    return { blob: await IR.Zip.build(files), count: manifest.length, bytes: bytes };
  }

  async function doBackupAll() {
    const withKeys = !!($('#backup-with-keys') && $('#backup-with-keys').checked);
    const withSrc = !!($('#backup-with-src') && $('#backup-with-src').checked);
    const btn = $('#btn-backup-all');
    const oldText = btn ? btn.textContent : '';
    const pack = buildBackupPack(!withKeys);
    if (!pack.stories.length) { toast('还没有故事可以备份', true); return; }
    const day = new Date();
    const stamp = day.getFullYear() + String(day.getMonth() + 1).padStart(2, '0') + String(day.getDate()).padStart(2, '0');
    const note = withKeys ? '（含 API Key，请妥善保管）' : '（不含 API Key）';

    if (!withSrc) {
      A.download('ir-backup-' + stamp + '.irbackup.json', JSON.stringify(pack, null, 1));
      markBackedUp();
      renderStoragePanel();
      toast('已导出全部备份：' + pack.stories.length + ' 个故事' + note, false, true);
      return;
    }
    if (!(IR.Zip && IR.Zip.build)) { toast('打包模块没加载出来：请刷新页面重试', true, true); return; }

    if (btn) { btn.disabled = true; btn.textContent = '正在收集原图…'; }
    try {
      await Store.flush();                                  // 先把攒着的写盘落下去，备份的才是最新状态
      const zip = await buildBackupZip(pack, (done, total, bytes) => {
        if (btn) btn.textContent = '正在打包原图 ' + done + '/' + total + '（' + fmtMB(bytes) + '）…';
      });
      if (!zip.count) {
        // 一张原图都没取到：多半是 v0.2 时代的老故事只存了缩略图（那时原图还没有单独存放）
        A.download('ir-backup-' + stamp + '.irbackup.json', JSON.stringify(pack, null, 1));
        markBackedUp();
        renderStoragePanel();
        toast('本地没有原图可打包（旧故事可能只存了缩略图），已改为导出不含原图的 .irbackup.json', false, true);
        return;
      }
      A.downloadBlob('ir-backup-' + stamp + '.zip', zip.blob);
      markBackedUp();
      renderStoragePanel();
      toast('已导出全部备份：' + pack.stories.length + ' 个故事 + ' + zip.count + ' 张原图（' + fmtMB(zip.bytes) + '）' + note, false, true);
    } catch (e) {
      toast('打包失败：' + ((e && e.message) ? e.message : e), true, true);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = oldText; }
    }
  }

  async function applyBackupImport(obj, zipEntries) {
    const stories = (Array.isArray(obj.stories) ? obj.stories : []).filter(s => s && s.id);
    // 带原图的备份：清单在正文里，图片本体在同包的 images/*（见 buildBackupZip）
    const manifest = Array.isArray(obj.images) ? obj.images.filter(x => x && x.id && x.path) : [];
    const pending = zipEntries ? manifest.filter(x => zipEntries.has(x.path)) : [];
    const missing = manifest.length - pending.length;
    if (!stories.length && !obj.settings) { toast('备份文件里没有可还原的内容', true); return; }
    const ok = await irConfirm(
      '导入备份：还原 ' + stories.length + ' 个故事'
      + (pending.length ? ' + ' + pending.length + ' 张原图' : '')
      + (obj.settings ? '，并覆盖当前的模型设置' : '')
      + (Array.isArray(obj.userProfile) ? '与用户画像' : '')
      + '？同 id 的故事会被覆盖，其它故事保留。',
      { title: '导入备份', okText: '还原' }
    );
    if (!ok) return;
    let n = 0;
    for (const raw of stories) {
      const s2 = Store.migrateStory(raw);
      if (!s2 || !s2.id) continue;
      Store.saveStory(s2);
      n++;
    }
    if (obj.settings) {
      const prev = S.settings;
      S.settings = Store.migrateSettings(obj.settings);
      // 备份可能刻意不带 Key：别把现有 Key 覆盖成空
      ['chat', 'painter', 'scribe', 'draft', 'image', 'video'].forEach(k => {
        if (S.settings[k] && !S.settings[k].apiKey && prev[k] && prev[k].apiKey) S.settings[k].apiKey = prev[k].apiKey;
      });
      persistSettings();
      A.syncSettingsToForm();
    }
    if (Array.isArray(obj.userProfile)) Store.saveUserProfile(obj.userProfile);

    // 原图：从 zip 条目直接写回 IndexedDB（字节原样落盘，不经过 base64）
    let imgs = 0, lost = 0;
    for (const im of pending) {
      const raw = zipEntries.get(im.path);
      if (!raw) { lost++; continue; }
      const blob = im.type ? raw.slice(0, raw.size, im.type) : raw;
      if (Store.putImage(im.id, blob, { from: 'backup' })) imgs++; else lost++;
    }
    if (pending.length) await Store.flush();

    A.renderShelf();
    renderStoragePanel();
    toast('已还原备份：' + n + ' 个故事'
      + (imgs ? ' + ' + imgs + ' 张原图' : '')
      + (lost
        ? '；有 ' + lost + ' 张原图没还原'
          + (IR.Storage && !IR.Storage.available ? '（这台浏览器用不了 IndexedDB，原图存不进本地）' : '（数据不完整）')
        : '')
      + (missing ? '；清单里有 ' + missing + ' 张图不在包里（备份文件可能被改动过）' : ''),
      !!lost, true);
  }

  // 超过 7 天没备份（且确实有故事）→ 启动后提醒一次；提醒本身每天最多一次，不刷屏
  function remindBackupIfNeeded() {
    if (DEMO) return;                 // 演示模式不提醒备份（配置与故事都不必当回事）
    const n = Store.listStories().length;
    if (!n) return;
    const now = Date.now();
    const last = +S.settings.lastBackupAt || 0;
    if (last && now - last < BACKUP_REMIND_MS) return;
    if (now - (+S.settings.lastBackupRemindAt || 0) < BACKUP_NAG_MS) return;
    S.settings.lastBackupRemindAt = now;
    persistSettings();
    setTimeout(() => toast(
      '你的 ' + n + ' 个故事只存在这个浏览器里，已经超过 7 天没备份了：设置 → 本地存储与备份 →「一键导出全部备份」',
      false, true
    ), 1800);
  }

  function openSettings() {
    if (DEMO) toast('演示模式：这里的设置改了也不会生效（演示不联网、不写盘）。去掉地址栏的 ?demo=1 重新打开，就可以接入真模型了。', false, true);
    A.closeStoryPrefs();   // UI-3：全局设置与本对话设置互斥（避免面板叠在弹窗上）
    A.syncSettingsToForm();
    renderStoragePanel();
    openModal('modal-settings');
    A.initSettingsNav();   // UI-3 §4.1：分组导航态（窄屏列表 / 桌面左导航）
    A.renderSidecarStatus();
    if (A.sidecarReady()) A.loadFeatureConfig();   // 打开设置时刷新一次安全项（真源在侧车）
  }

  function isZipFile(file) {
    const n = String((file && file.name) || '').toLowerCase();
    const t = String((file && file.type) || '').toLowerCase();
    return /\.zip$/.test(n) || t === 'application/zip' || t === 'application/x-zip-compressed' || t === 'multipart/x-zip';
  }

  // 从一个 zip 里找备份正文：优先根目录，也接受「被塞进一层文件夹」的情况
  function pickBackupJson(entries) {
    if (entries.has('ir-backup.json')) return entries.get('ir-backup.json');
    let best = null;
    for (const [name, blob] of entries) {
      if (!/(^|\/)ir-backup\.json$/i.test(name)) continue;
      if (!best || name.length < best.name.length) best = { name: name, blob: blob };
    }
    return best ? best.blob : null;
  }

  // 带原图的全量备份（.zip）：解出 ir-backup.json 走同一套还原流程，原图另走 images/*
  async function importZipFile(file) {
    if (!(IR.Zip && IR.Zip.read)) { toast('这个版本没有 zip 支持：请刷新页面重试', true, true); return; }
    toast('正在读取备份包…', false, true);
    let entries = null;
    try {
      entries = await IR.Zip.read(file);
    } catch (e) {
      toast('这个 .zip 打不开：' + ((e && e.message) ? e.message : e), true, true);
      return;
    }
    const main = pickBackupJson(entries);
    if (!main) {
      toast('这个 zip 里没有 ir-backup.json —— 只认识「一键导出全部备份（带原图）」导出的 .zip。'
        + '.irstory.json / .irbackup.json 请直接拖进来，不用先压缩。', true, true);
      return;
    }
    let obj = null;
    try { obj = JSON.parse(await main.text()); } catch (_) {
      toast('备份包里的 ir-backup.json 不是有效 JSON（文件可能损坏）', true, true);
      return;
    }
    if (!obj || obj.format !== 'ir-backup') { toast('备份包里的 ir-backup.json 不是本应用的备份格式', true, true); return; }
    applyBackupImport(obj, entries);
  }

  function handleImportFile(file) {
    if (!file) return;
    if (isZipFile(file)) { importZipFile(file); return; }
    const reader = new FileReader();
    reader.onload = () => {
      let obj = null;
      try { obj = JSON.parse(reader.result); } catch (_) { toast('文件不是有效的 JSON', true); return; }
      applyImport(obj);
    };
    reader.readAsText(file);
  }

  function applyImport(obj) {
    if (obj && obj.format === 'ir-backup') { applyBackupImport(obj); return; }   // 整体备份还原（P0）
    if (!obj || obj.format !== 'ir-story') { toast('这不是一个 .irstory.json / .irbackup.json 档案', true, true); return; }
    if (obj.kind === 'premise') {
      // 精简设定包 → 预填开局向导（§4.11 路径①）
      closeModal('modal-new');
      A.openWizard(wizardPrefillFromPack(obj));
      toast('精简设定包：已预填向导，确认后开始', false, true);
      return;
    }
    // 完整档案：原样续玩
    const st = Store.newStory({
      title: (obj.title || '导入的故事') + '（导入）',
      premise: obj.premise || '',
      mode: obj.mode || 'choice',
      styleTone: obj.styleTone || '',
      world: obj.world || {},
      styleCard: obj.styleCard || null,
      rollingStyle: obj.rollingStyle || null,
      characterCard: obj.characterCard || null,
      userProfile: obj.userProfile || [],
      painterThread: obj.painterThread || [],
    });
    st.log = Array.isArray(obj.log) ? obj.log : [];
    st.messages = Array.isArray(obj.messages) ? obj.messages : [];
    st.summaries = Array.isArray(obj.summaries) ? obj.summaries : [];
    st.turn = obj.turn || 0;
    st.lastSceneSummary = obj.lastSceneSummary || '';
    st.scenes = (obj.images || []).map((im, i) => ({
      id: im.id || ('sc-imp' + i), alt: im.alt || '', prompt: im.prompt || '', promptRaw: im.promptRaw || '',
      aspect: im.aspect || '', width: im.width || 0, height: im.height || 0,
      // 视频条目：只随包带封面（videoOmitted），本体没导出——导入后显示「视频未随备份导出」
      kind: im.kind || undefined, videoOmitted: im.videoOmitted || undefined,
      mode: im.mode || undefined, duration: im.duration || undefined,
      // 导入档案不可信（审查 中危 #12）：thumb 白名单只放行 data:/blob:，坏数据不进存储
      thumb: Store.safeThumb(im.thumb), src: im.src || null, ts: Date.now(),
    }));
    st.lastBg = st.scenes.length ? st.scenes[st.scenes.length - 1].id : null;
    // UI-3 §3.4：本对话偏好随包导入（只有 profileId + 显示用标签；凭证在导出侧已剥）。
    // 本机没有该 profile 时 resolveChatCfg 自动回退默认，本对话设置面板会提示。
    if (obj.prefs && typeof obj.prefs === 'object') st.prefs = Store.sanitizePrefsSafe(obj.prefs);
    st.tree = obj.tree ? clone(obj.tree) : null;   // full 包带的分支树（§5⑧）
    IR.Tree.ensure(st);                            // 导入后建 / 校验树（无树旧包 → 线性链）
    Store.saveStory(st);
    A.showShelf();                       // 导入即进书架，能直接看到新卡片
    // 档案里带的原图（别人导出时勾了「附带原图」）：转成 Blob 存进 IndexedDB，之后照常显示原图
    const withOriginal = st.scenes.filter(sc => sc.src && sc.src.indexOf('data:') === 0);
    if (withOriginal.length) {
      (async () => {
        for (const sc of withOriginal) {
          const imageId = await A.storeOriginal(sc.id, sc.src, { width: sc.width, height: sc.height });
          if (imageId) {
            sc.imageId = imageId;
            // 这里 story 已被 showShelf 置空：直接在导入的 st 上找（原写法 findImageEntry 永远找不到）
            const entry = (st.log || []).find(e => e && e.type === 'image' && e.id === sc.id);
            if (entry) entry.imageId = imageId;
            // 分支树里同一张 scene / 图片条目也换键（§5⑧）：否则非当前分支的图全是死键
            const nodes = st.tree && st.tree.nodes;
            if (nodes) for (const nid of Object.keys(nodes)) {
              for (const sm of (nodes[nid].scenes || [])) if (sm && sm.id === sc.id) sm.imageId = imageId;
              for (const en of (nodes[nid].entries || [])) if (en && en.type === 'image' && en.id === sc.id) en.imageId = imageId;
            }
          }
        }
        // 竞态守卫（审查 中危 #14）：换键是异步的，期间故事可能已被删除——
        // 保存前校验还存在，否则 saveStory 会把已删故事“复活”
        if (!Store.loadStory(st.id)) return;
        Store.saveStory(st);   // 换键结果要落盘（story 已切走，saveAll 是空操作）
        A.renderStage(); A.renderThumbs();
      })();
    }
    toast('已导入：《' + st.title + '》', false, true);
  }

  function wizardPrefillFromPack(obj) {
    const w = obj.world || {};
    return {
      topic: obj.title || '',
      world: obj.premise || '',
      characters: (w.characters || []).map(c => [c.name || '', c.personality || '', c.speech || ''].join('｜')).join('\n'),
      style: obj.styleTone || (obj.styleCard && (obj.styleCard.styleKeywords || []).join(', ')) || '',
      role: '', development: '',
    };
  }

  A.reg({ initStorageGuard, markBackedUp, renderStoragePanel, doBackupAll, remindBackupIfNeeded, openSettings, handleImportFile });
})();
