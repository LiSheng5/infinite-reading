/*
 * src/core/importText.ts —— 剧情文本导入的纯解析逻辑（阶段 2 自 src/app/importer.js 抽出）
 *
 * 只搬纯文本 → 结构化数据的变换（模型回包解析 / 本地兜底规则 / 人物行解析），
 * 界面（粘贴框、向导表单、状态行）留在 src/app/importer.js，经 ImportText 调用本模块。
 * 函数体与 0.12.1 逐字一致。
 */

function parseImportJson(raw: any) {
  const s = String(raw || '');
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i === -1 || j <= i) return null;
  let o = null;
  try { o = JSON.parse(s.slice(i, j + 1)); } catch (_) { return null; }
  return (o && typeof o === 'object') ? o : null;
}

function parseImportSummary(raw: any) {
  const o: any = parseImportJson(raw);
  return (o && o.summary) ? String(o.summary).trim() : '';
}

function parseImportResult(raw: any) {
  const o: any = parseImportJson(raw);
  if (!o || (!o.premise && !o.world)) return null;
  const w = (o.world && typeof o.world === 'object') ? o.world : {};
  return {
    title: String(o.title || '').trim().slice(0, 40),
    premise: String(o.premise || '').trim(),
    world: {
      place: String(w.place || ''), time: String(w.time || ''), scene: String(w.scene || ''),
      characters: Array.isArray(w.characters) ? w.characters.filter((c: any) => c && c.name).map((c: any) => ({
        name: String(c.name), presence: String(c.presence || '在场'),
        personality: String(c.personality || ''), speech: String(c.speech || ''), note: String(c.note || ''),
      })).slice(0, 6) : [],
      threads: Array.isArray(w.threads) ? w.threads.filter(Boolean).map(String).slice(0, 12) : [],
    },
    styleKeywords: Array.isArray(o.styleKeywords) ? o.styleKeywords.filter(Boolean).map(String).slice(0, 8) : [],
  };
}

// 本地兜底整理：只截取原文开头并结构化（调用失败时用；标「本地规则」，等用户改）
function localImport(text: any) {
  const t = String(text || '').replace(/\r\n?/g, '\n').trim();
  const flat = t.replace(/\s+/g, ' ');
  const first = (t.split('\n').map((s: string) => s.trim()).filter(Boolean)[0] || '');
  const book = first.match(/[《【]([^》】]{1,24})[》】]/);
  const head = first
    .replace(/^[#\s]*/, '').replace(/^标题[:：]\s*/, '')
    .replace(/^[《【\[]\s*/, '').replace(/[》】\]]\s*$/, '').trim();
  const title = ((book ? book[1] : head) || '导入的故事').slice(0, 20);
  const names: string[] = [];
  const re = /[「"]([^」"]{2,6})[」"]/g;   // 人名只认「」引号（《》是书名）
  let m;
  while ((m = re.exec(t)) && names.length < 4) {
    const n = m[1].trim();
    if (n && names.indexOf(n) < 0) names.push(n);
  }
  return {
    local: true,
    title: title,
    premise: [
      '标题：' + title,
      '世界：' + (flat.slice(0, 120) || '（原文没写清，可自行补充）'),
      '你的角色：故事里的主角（你可以随时扮演成任何人、做任何事）。',
      '风格：按原文语气自行补充。',
      'AI 扮演：旁白，以及故事里除你以外的所有角色。',
    ].join('\n'),
    world: {
      place: '', time: '', scene: flat.slice(0, 60),
      characters: names.map((n: string) => ({ name: n, presence: '在场', personality: '', speech: '', note: '' })),
      threads: [],
    },
    styleKeywords: [],
  };
}

function parseImportCharacters(text: any) {
  return String(text || '').split('\n').map((line: string) => {
    const p = line.split('｜').map((s: string) => s.trim());
    if (!p[0]) return null;
    return { name: p[0], presence: p[1] || '在场', personality: p[2] || '', speech: p[3] || '', note: '', noteLocked: false };
  }).filter(Boolean);
}

const ImportText = {
  parseImportJson,
  parseImportSummary,
  parseImportResult,
  localImport,
  parseImportCharacters,
};

export { ImportText, parseImportJson, parseImportSummary, parseImportResult, localImport, parseImportCharacters };
