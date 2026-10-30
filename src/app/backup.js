/*
 * src/app/backup.js —— 本地存储与备份（数据安全）
 * 从 src/app/main.js 拆出（只搬家，不改行为）。
 */
import { Storage } from '../core/storage.ts';
import { BackupPack } from '../core/backupPack.ts';
import { Zip } from '../core/zip.ts';
import { A, toast } from './core.js';


  const S = A.state;
  const { $, Store, irConfirm, openModal, closeModal, clone, fmtTime, fmtMB, persistSettings } = A;


  /* ================= 本地存储与备份（数据安全） =================
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
    } catch (_) { /* 读不到 localStorage（隐私模式等）：占用按 0 显示，不影响备份 */ }
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
    try { est = Storage ? await Storage.estimate() : null; }
    catch (_) { /* 探测失败：下面按「查不到占用统计」显示，不影响导出 */ }
    let imgs = 0;
    try { imgs = (await Store.listImageKeys()).length; }
    catch (_) { /* 原图键读不到：按 0 张显示，导出仍按故事清单打包 */ }
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
            ? '接近写入上限，先「一键导出全部备份」，再删掉不用的故事腾空间。'
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
          ? '未获得「持久化存储」授权：磁盘紧张时浏览器可能自动淘汰本站数据。多与页面交互、或把页面加为书签 / 应用，再刷新有机会获批。'
          : '（当前浏览器不支持，或暂时查不到持久化存储授权状态。）');
      ps.classList.toggle('alert', persistGranted === false);
    }
    renderBackupHint();
  }

  // 导出包：默认剥掉 API Key（备份文件常被放进网盘，带 Key 等于把钱包一起备份）
  // 阶段 2：打包逻辑抽到 src/core/backupPack.ts（纯数据），这里只负责取数与界面反馈
  function buildBackupPack(stripKeys) {
    return BackupPack.buildBackupPack(
      S.settings,
      Store.loadUserProfile(),
      Store.listStories().map(it => Store.loadStory(it.id)).filter(Boolean),
      stripKeys
    );
  }

  /* 「带原图备份」= 一个 zip 里放两样东西（打包细节见 src/core/backupPack.ts 头注）：
   *   ir-backup.json      与普通备份完全同款（schema 2 只多一份 images 清单）
   *   images/0001.png …   原图按二进制原样存放（不转 base64） */
  async function buildBackupZip(pack, onProgress) {
    return BackupPack.buildBackupZip(pack, onProgress);
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
    if (!(Zip && Zip.build)) { toast('打包模块没加载出来：请刷新页面重试', true, true); return; }

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
    // 阶段 2：数据校验/清单过滤抽到 src/core/backupPack.ts（parseBackup），这里只留确认与界面反馈
    const { stories, pending, missing } = BackupPack.parseBackup(obj, zipEntries);
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
      // 凭证合并：备份默认不带 Key，不能反手把本机 Key 冲成空；
      // sidecar token 一律沿用本机的（包里的值属于导出那台机器）。规则在 core，可单测。
      S.settings = BackupPack.restoreSecrets(S.settings, Store.migrateSettings(obj.settings));
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
          + (Storage && !Storage.available ? '（这台浏览器用不了 IndexedDB，原图存不进本地）' : '（数据不完整）')
        : '')
      + (missing ? '；清单里有 ' + missing + ' 张图不在包里（备份文件可能被改动过）' : ''),
      !!lost, true);
  }

  // 超过 7 天没备份（且确实有故事）→ 启动后提醒一次；提醒本身每天最多一次，不刷屏
  function remindBackupIfNeeded() {
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
    A.closeStoryPrefs();   // 全局设置与本对话设置互斥（避免面板叠在弹窗上）
    A.syncSettingsToForm();
    renderStoragePanel();
    openModal('modal-settings');
    A.initSettingsNav();   // 分组导航态（窄屏列表 / 桌面左导航）
    A.renderSidecarStatus();
    A.syncAdvPanels();     // 已有内容的折叠块（单独配置 / 高级参数）自动展开
    if (A.sidecarReady()) {   // 打开设置时刷新一次安全项（真源在侧车）；填完再同步一次折叠块
      Promise.resolve(A.loadFeatureConfig()).then(() => A.syncAdvPanels(), () => {});
    }
  }

  function isZipFile(file) {
    const n = String((file && file.name) || '').toLowerCase();
    const t = String((file && file.type) || '').toLowerCase();
    return /\.zip$/.test(n) || t === 'application/zip' || t === 'application/x-zip-compressed' || t === 'multipart/x-zip';
  }

  // 从一个 zip 里找备份正文：优先根目录，也接受「被塞进一层文件夹」的情况（纯逻辑在 src/core/backupPack.ts）
  function pickBackupJson(entries) {
    return BackupPack.pickBackupJson(entries);
  }

  // 带原图的全量备份（.zip）：解出 ir-backup.json 走同一套还原流程，原图另走 images/*
  async function importZipFile(file) {
    if (!(Zip && Zip.read)) { toast('这个版本没有 zip 支持：请刷新页面重试', true, true); return; }
    toast('正在读取备份包…', false, true);
    let entries = null;
    try {
      entries = await Zip.read(file);
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
    if (obj && obj.format === 'ir-backup') { applyBackupImport(obj); return; }   // 整体备份还原
    if (!obj || obj.format !== 'ir-story') { toast('这不是一个 .irstory.json / .irbackup.json 档案', true, true); return; }
    if (obj.kind === 'premise') {
      // 精简设定包 → 预填开局向导（路径①）
      closeModal('modal-new');
      A.openWizard(wizardPrefillFromPack(obj));
      toast('精简设定包：已预填向导，确认后开始', false, true);
      return;
    }
    // 完整档案：原样续玩
    // 阶段 2：story 组装的数据段抽到 src/core/backupPack.ts（storyFromPack，与 0.12.1 逐字一致），
    // 这里只留落盘与界面跳转
    const st = BackupPack.storyFromPack(obj);
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
            // 分支树里同一张 scene / 图片条目也换键：否则非当前分支的图全是死键
            const nodes = st.tree && st.tree.nodes;
            if (nodes) for (const nid of Object.keys(nodes)) {
              for (const sm of (nodes[nid].scenes || [])) if (sm && sm.id === sc.id) sm.imageId = imageId;
              for (const en of (nodes[nid].entries || [])) if (en && en.type === 'image' && en.id === sc.id) en.imageId = imageId;
            }
          }
        }
        // 竞态守卫：换键是异步的，期间故事可能已被删除——
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

