/*
 * acceptance/phase5/8/bytes-compare.mjs —— 阶段 5 · 第 8 步 · 截图逐字节对比
 *
 * 作什么：把 shoot.mjs 的产物（改动前 / 改动后 / 可选「同一份代码再跑一遍」）逐张算 SHA-256：
 *   · 改动前 vs 改动后：同名图是否逐字节一致
 *   · 若给了 --repeat：先算出「同一份代码两次跑也不一致」的天然抖动集（时间戳类界面），
 *     再判「有没有真回归」= 不在抖动集里却变了 / 缺图 / 多图
 *
 * 为什么要 --repeat：seeded 截图里有一部分带运行时时间（存档点名、相对时间、节点标签），
 * 同一份代码连跑两遍也不逐字节一致。把它当回归会把「本来就抖」误判成改动导致。
 *
 * 用法：
 *   node acceptance/phase5/8/bytes-compare.mjs --before=<dir> --after=<dir> [--repeat=<dir>]
 *        [--out=acceptance/phase5/8/shots-bytes.json]
 *
 * 退出码：0 = 无回归（抖动集内允许差异）；1 = 有回归 / 缺图 / 多图。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = { before: '', after: '', repeat: '', out: 'acceptance/phase5/8/shots-bytes.json' };
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([\w-]+)=(.+)$/);
  if (m) args[m[1]] = m[2];
}
if (!args.before || !args.after) {
  console.error('用法：node acceptance/phase5/8/bytes-compare.mjs --before=<dir> --after=<dir> [--repeat=<dir>] [--out=…]');
  process.exit(2);
}

const dirs = { before: path.resolve(args.before), after: path.resolve(args.after) };
if (args.repeat) dirs.repeat = path.resolve(args.repeat);
for (const [k, dir] of Object.entries(dirs)) {
  if (!fs.existsSync(dir)) { console.error('目录不存在：' + k + ' = ' + dir); process.exit(2); }
}

const hash = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const shots = (dir) => new Set(fs.readdirSync(dir).filter((f) => /\.png$/i.test(f)).sort());

const list = {};
for (const [k, dir] of Object.entries(dirs)) list[k] = shots(dir);

const both = [...list.before].filter((f) => list.after.has(f));
const onlyBefore = [...list.before].filter((f) => !list.after.has(f));
const onlyAfter = [...list.after].filter((f) => !list.before.has(f));

const hashOf = (dir, file) => hash(path.join(dir, file));

const mismatch = both
  .map((file) => ({ file, before: hashOf(dirs.before, file), after: hashOf(dirs.after, file) }))
  .filter((x) => x.before !== x.after);

/* 同一份代码跑两遍也不一致 = 天然抖动（时间戳类界面），不算回归 */
const volatile = [];
const regressed = [];
for (const m of mismatch) {
  const repeated = dirs.repeat && list.repeat && list.repeat.has(m.file)
    ? hashOf(dirs.repeat, m.file) !== m.after
    : false;
  (repeated ? volatile : regressed).push(repeated ? Object.assign({ repeat: hashOf(dirs.repeat, m.file) }, m) : m);
}

const result = {
  tool: 'acceptance/phase5/8/bytes-compare.mjs',
  generatedAt: new Date().toISOString(),
  dirs,
  count: { before: list.before.size, after: list.after.size, repeat: list.repeat ? list.repeat.size : 0, both: both.length },
  identical: both.length - mismatch.length,
  mismatches: mismatch.length,
  volatile,
  regressed,
  onlyBefore,
  onlyAfter,
  note: args.repeat
    ? '抖动集 = 同一份代码（--repeat）两次跑也不一致的图；回归 = 不在抖动集里却变了'
    : '没给 --repeat：所有差异都按回归处理',
  ok: regressed.length === 0 && onlyBefore.length === 0 && onlyAfter.length === 0,
};

const outFile = path.resolve(args.out);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');

console.log('[bytes] before ' + result.count.before + ' 张 / after ' + result.count.after
  + ' 张 / 同名 ' + result.count.both + ' 张，逐字节一致 ' + result.identical + ' 张');
if (volatile.length) console.log('[bytes] 天然抖动（同一份代码两次跑也不一致）' + volatile.length + ' 张：'
  + volatile.map((x) => x.file).join(', '));
if (regressed.length) {
  console.log('[bytes] 真回归 ' + regressed.length + ' 张');
  for (const m of regressed.slice(0, 10)) console.log('  ✗ ' + m.file + ' ' + m.before.slice(0, 12) + ' ≠ ' + m.after.slice(0, 12));
}
if (onlyBefore.length || onlyAfter.length) console.log('[bytes] 缺图 ' + onlyBefore.length + ' / 多图 ' + onlyAfter.length);
console.log('[bytes] → ' + path.relative(process.cwd(), outFile) + '  ' + (result.ok ? '无回归' : '有回归'));
process.exit(result.ok ? 0 : 1);
