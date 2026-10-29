/*
 * 无限阅读 · 角色卡（R13 / §4.12）
 *
 * 职责：
 *  - SillyTavern V2 / V3 角色卡解析（PNG 内嵌 JSON：tEXt/iTXt 的 `chara` / `ccv3`）
 *  - 字段映射（description→外貌 / scenario→场景 / first_mes→开场白 / mes_example→示例对话 / system_prompt→系统提示）
 *  - 与世界卡对接：卡 → world.characters 一条人物条目（personality / speech 对接）
 *
 * 合规（§4.12）：只兼容**格式**，不复制任何代码与内容；解析的是用户自己的卡。
 * 纯逻辑、零依赖；IIFE 挂 应用层注册表，Node 亦可加载（评测用）。
 */

/* ↑ 阶段 2 搬迁自 src/core/roleCard.ts（IIFE → ES module，函数体逐字未动）。
 * 模块间现存的 global.IR 惰性互访按铁律保留（可选依赖语义，见 src/core/ir.ts 头注）；
 * 导出即真实 API。 */
import { Zip } from './zip.ts';

const global = globalThis as any;
declare const Buffer: any;

  const CARD_FIELDS = ['name', 'appearance', 'personality', 'scene', 'opening', 'exampleDialogue', 'systemNote'];
  const SOURCES = ['builtin', 'st-import', 'custom'];
  const TEXT_KEYWORDS = ['ccv3', 'chara'];   // V3 优先，其次 V2
  const FIELD_MAX = 4000;                    // 单字段入库截断（防呆；控 localStorage 体积）

  function str(v, max?) {
    const s = String(v == null ? '' : v).replace(/\r\n?/g, '\n').trim();
    const cap = max || FIELD_MAX;
    return s.length > cap ? s.slice(0, cap) : s;
  }

  function emptyCard() {
    return {
      name: '', appearance: '', personality: '', scene: '',
      opening: '', exampleDialogue: '', systemNote: '',
      source: 'custom', updatedAt: 0,
    };
  }

  // 任意来源（编辑器表单 / 旧档 / 导入）→ 规范化角色卡（幂等）
  function normalize(raw) {
    const out = emptyCard();
    if (!raw || typeof raw !== 'object') return out;
    for (const k of CARD_FIELDS) out[k] = str(raw[k]);
    out.source = SOURCES.indexOf(raw.source) >= 0 ? raw.source : 'custom';
    out.updatedAt = +raw.updatedAt || 0;
    return out;
  }

  /* ---------------- PNG 解析（只认 tEXt / 未压缩 iTXt） ---------------- */

  function readU32(b, o) {
    return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  }

  function ascii(b, o, n) {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(b[o + i]);
    return s;
  }

  // 标准 PNG CRC32（多项式 0xEDB88320，与 ZIP 同一多项式）：唯一口径在 Zip.crc32（zip.js，
  // 审查 可维护性 三·5）。roleCard.js 在 zip.js 之前加载，取值放调用时，缺了直接抛不静默降级。
  function crc32(b) {
    const fn = Zip.crc32;
    return fn(b);
  }

  function toBytes(data) {
    if (!data) return null;
    if (data instanceof Uint8Array) return data;
    if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) return new Uint8Array(data);
    if (Array.isArray(data)) return new Uint8Array(data);
    return null;
  }

  function b64ToBytes(s) {
    const clean = String(s == null ? '' : s).replace(/[\s\r\n]+/g, '');
    if (!clean) return new Uint8Array(0);
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'));
    const bin = global.atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function bytesToUtf8(b) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(b);
    if (typeof Buffer !== 'undefined') return Buffer.from(b).toString('utf8');
    let s = '';
    for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    try { return decodeURIComponent(escape(s)); } catch (_) { return s; }
  }

  // 读出一个 PNG 全部可用的文本块（keyword + text），并校验 CRC
  function readTextChunks(data) {
    const b = toBytes(data);
    if (!b || b.length < 8) return [];
    if (!(b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47)) return [];
    const out = [];
    let off = 8;
    while (off + 12 <= b.length) {
      const len = readU32(b, off);
      const type = ascii(b, off + 4, 4);
      if (off + 12 + len > b.length) break;
      const chunk = b.subarray(off + 4, off + 8 + len);   // type + data
      const crc = readU32(b, off + 8 + len);
      const ok = crc32(chunk) === crc;
      if (ok && (type === 'tEXt' || type === 'iTXt')) {
        const body = b.subarray(off + 8, off + 8 + len);
        let i = 0;
        while (i < body.length && body[i] !== 0 && i < 80) i += 1;   // keyword 1~79 字节
        const keyword = ascii(body, 0, i);
        if (i < body.length && body[i] === 0) {
          if (type === 'tEXt') {
            out.push({ keyword: keyword, text: bytesToUtf8(body.subarray(i + 1)) });
          } else {
            // iTXt：keyword \0 flag(1) method(1) language \0 translated \0 text
            let j = i + 3;
            while (j < body.length && body[j] !== 0) j += 1;   // language tag
            j += 1;
            while (j < body.length && body[j] !== 0) j += 1;   // translated keyword
            j += 1;
            if (body[i + 1] === 0 && j <= body.length) out.push({ keyword: keyword, text: bytesToUtf8(body.subarray(j)) });
          }
        }
      }
      off += 12 + len;
      if (type === 'IEND') break;
    }
    return out;
  }

  /* ---------------- SillyTavern 卡 → 我们的角色卡 ---------------- */

  // V2 = 平铺字段；V3 = { spec:'chara_card_v3', data:{...} }（两种都接）
  function fromST(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const data = (raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)) ? raw.data : raw;
    const alt = Array.isArray(data.alternate_greetings) ? data.alternate_greetings.find(Boolean) : '';
    const card = normalize({
      name: str(data.name, 60),
      appearance: str(data.description),
      personality: str(data.personality),
      scene: str(data.scenario),
      opening: str(data.first_mes) || str(alt),
      exampleDialogue: str(data.mes_example),
      systemNote: str(data.system_prompt) || str(data.post_history_instructions) || str(data.creator_notes),
      source: 'st-import',
      updatedAt: Date.now(),
    });
    if (!card.name && !card.appearance && !card.personality && !card.opening) return null;
    return card;
  }

  // 导入入口：PNG 字节 → 角色卡（ccv3 优先，其次 chara；再解 base64 JSON）
  function parsePNG(data) {
    const chunks = readTextChunks(data);
    if (!chunks.length) return null;
    for (const kw of TEXT_KEYWORDS) {
      const hit = chunks.filter(c => c.keyword === kw).pop();
      if (!hit || !hit.text) continue;
      let json = null;
      try { json = JSON.parse(hit.text); } catch (_) {
        try { json = JSON.parse(bytesToUtf8(b64ToBytes(hit.text))); } catch (_) { json = null; }
      }
      const card = fromST(json);
      if (card) return card;
    }
    return null;
  }

  // 示例对话里角色的第一句（截断），当 world.characters 的「说话方式」提示
  function speechHint(card) {
    const text = str(card && card.exampleDialogue);
    if (!text) return '';
    const name = str(card && card.name, 60);
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(?:\{\{char\}\}|[^：:]{1,20})\s*[:：]\s*[「"']?([^」"'\n]{2,80})/);
      if (!m) continue;
      if (name && line.indexOf('{{char}}') < 0 && line.indexOf(name) < 0) continue;
      return m[1].trim().slice(0, 60);
    }
    return '';
  }

  // 导入卡 → 世界卡人物条目（personality / speech 天然对接，§4.12）
  function worldCharacter(card) {
    const c = normalize(card);
    if (!c.name) return null;
    const noteBits = [];
    if (c.scene) noteBits.push(c.scene.slice(0, 40));
    if (c.appearance) noteBits.push('外貌：' + c.appearance.slice(0, 40));
    return {
      name: c.name,
      presence: '在场',
      personality: c.personality,
      speech: speechHint(c),
      note: noteBits.join('；'),
    };
  }

  function sourceLabel(card) {
    const s = card && card.source;
    if (s === 'st-import') return 'SillyTavern 导入';
    if (s === 'builtin') return '内置';
    return '自建';
  }

  const RoleCard = {
    CARD_FIELDS, SOURCES, TEXT_KEYWORDS,
    emptyCard, normalize, fromST, parsePNG, readTextChunks,
    speechHint, worldCharacter, sourceLabel,
  };
  export { RoleCard };