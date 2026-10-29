/* src/screens/modal/state.svelte.js —— 屏 6b「轻弹窗」的状态桥（Svelte 5 runes）
 *
 * 分工与屏 4/5 一致：DOM 契约（按 id 读写）归 legacy 界面层，**动态面**归组件。
 * 5 个轻弹窗里只有「人物行」是真正的动态面（可增删行）；其余字段都是「打开时灌一次值、
 * 提交时读一次值」，继续由 src/app/wizard.js / importer.js 直接写 input.value（零改动）。
 *
 * 为什么人物行必须搬进状态桥：0.12.1 的 A.charEditor 是命令式 DOM 注入（往容器里 createElement）。
 * 容器一旦归 Svelte 管，两层写同一棵子树迟早打架（重渲染会清掉注入的行）；而且注入的
 * <input> 只有浏览器默认样式。这里把「行」变成 $state 数组，组件用 TextInput 渲染，
 * 对外仍暴露与 charEditor 同形的 { set, get, add } 三个方法（见 charApi）。
 *
 * 口径与 charEditor 逐条对齐（eval 无关，靠 6b 自检脚本对账）：
 *   · set(list) 至少留一行空行（看得见字段形状）；
 *   · get() 滤掉全空行，字段值 trim，不造 fields 之外的值；
 *   · add(vals) 追加一行（不抢焦点：调用方自己决定焦点，legacy 只用来补行）。
 */
export const CHAR_FIELDS = {
  wizard: [
    { key: 'name', label: '名字', placeholder: '如：周叙' },
    { key: 'personality', label: '性格', placeholder: '如：话里有话、克制' },
    { key: 'speech', label: '说话方式', placeholder: '如：简短、喜欢反问' },
  ],
  import: [
    { key: 'name', label: '名字', placeholder: '姓名' },
    { key: 'presence', label: '在场 / 离场', placeholder: '在场' },
    { key: 'personality', label: '性格', placeholder: '性格' },
    { key: 'speech', label: '说话方式', placeholder: '说话方式' },
  ],
};

let seq = 0;

function makeRow(kind, vals) {
  const values = {};
  for (const f of CHAR_FIELDS[kind]) {
    values[f.key] = vals && vals[f.key] != null ? String(vals[f.key]) : '';
  }
  seq += 1;
  return { id: seq, values: values };
}

/** 人物行（wizard = 开局向导 / import = 文本导入确认页），组件里 each 它 */
export const charRows = $state({
  wizard: [makeRow('wizard', null)],
  import: [makeRow('import', null)],
});

function pad(kind) {
  if (!charRows[kind].length) charRows[kind] = [makeRow(kind, null)];
}

export function setRows(kind, list) {
  const rows = (Array.isArray(list) ? list : []).map(v => makeRow(kind, v));
  charRows[kind] = rows.length ? rows : [makeRow(kind, null)];
}

export function getRows(kind) {
  const fields = CHAR_FIELDS[kind] || [];
  return charRows[kind].map(row => {
    const out = {};
    let any = false;
    for (const f of fields) {
      const v = String(row.values[f.key] == null ? '' : row.values[f.key]).trim();
      out[f.key] = v;
      if (v) any = true;
    }
    return any ? out : null;
  }).filter(Boolean);
}

export function addRow(kind, vals) {
  const row = makeRow(kind, vals);
  charRows[kind].push(row);
  return row;
}

export function removeRow(kind, id) {
  charRows[kind] = charRows[kind].filter(r => r.id !== id);
  pad(kind);
}

/** 与 A.charEditor 同形的三个方法（wizard.js / importer.js 只用到 set / get） */
export function charApi(kind) {
  return {
    set(list) { setRows(kind, list); },
    get() { return getRows(kind); },
    add(vals) { return addRow(kind, vals); },
  };
}
