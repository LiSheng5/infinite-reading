/*
 * 无限阅读 · 极简 ZIP 读写（零依赖）
 *
 * 为什么要有这个文件：全量备份要能**连原图一起**带走（换设备 / 换浏览器 / 离线归档），
 * 而 base64 塞进 JSON 会让体积涨约 1/3，大图多了还会把内存撑爆。
 * ZIP 能把二进制原图原样打包，一个文件同时装下结构化的 .irbackup.json 和 images/*。
 *
 * 设计取舍：
 *   - **写入只用 store（不压缩）**：原图（PNG/JPEG/WebP）本身已压缩，再 deflate 基本白费；
 *     不压缩换来的是「字节与原文件完全一致」和极简实现，任何解压工具都能打开。
 *   - **读取兼容 deflate（方法 8）**：万一有人用系统自带的「压缩」或第三方工具把备份再压一层，
 *     有 DecompressionStream 就解开（Chrome 80+ / Safari 16.4+ / Node 18+），没有就报人话错误。
 *   - **不碰磁盘、不写路径**：只把字节切片还原成 Blob 交给调用方，天然没有 zip slip（路径穿越）问题。
 *   - **只解调用方要的东西**：调用方按清单取条目，剩下的字节不碰，这本身就是一层 zip 炸弹防护；
 *     另外仍做长度/条目数上限校验，畸形文件一律「拒绝处理」而不是硬解。
 *
 * 只支持 ZIP32（单文件 < 4GB、条目 < 65535），超出直接报错而不是产出坏包。
 * Node 下 require 不会报错：只是没有 Blob 时 build/read 会抛人话错误，离线评测用不到它。
 */

/* ↑ 阶段 2 搬迁自 src/core/zip.ts（IIFE → ES module，函数体逐字未动）。
 * 阶段 6：模块间依赖改为静态 import（全局 IR 兼容层已删除）。 */

 const LOC_SIG = 0x04034b50;   // 本地文件头
 const CD_SIG = 0x02014b50;    // 中央目录条目
 const EOCD_SIG = 0x06054b50;  // 中央目录结尾
 const SIG_LEN = 22;           // EOCD 固定长度（无注释）
 const CD_LEN = 46;            // 中央目录条目固定长度
 const MAX_ENTRIES = 65535;    // ZIP32 上限
 const READ_MAX_ENTRIES = 20000;
 const MAX_BYTES = 0xFFFF0000; // 单文件 / 总长上限（ZIP32 的 4GB 留余量）

 const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
 const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder('utf-8') : null;

 /* ---------------- CRC32（ZIP 校验用的标准多项式） ---------------- */

 const CRC_TABLE = (function () {
   const t = new Uint32Array(256);
   for (let n = 0; n < 256; n++) {
     let c = n;
     for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
     t[n] = c >>> 0;
   }
   return t;
 })();

 function crc32(bytes) {
   let c = 0xFFFFFFFF;
   for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
   return (c ^ 0xFFFFFFFF) >>> 0;
 }

 /* ---------------- 小工具 ---------------- */

 function isBlobLike(d) {
   return !!d && typeof d === 'object' && typeof d.arrayBuffer === 'function';
 }

 async function toBytes(data) {
   if (typeof data === 'string') {
     if (!encoder) throw new Error('当前环境没有 TextEncoder，无法打包文本');
     return encoder.encode(data);
   }
   if (data instanceof Uint8Array) return data;
   if (typeof ArrayBuffer !== 'undefined' && data instanceof ArrayBuffer) return new Uint8Array(data);
   if (isBlobLike(data)) return new Uint8Array(await data.arrayBuffer());
   throw new Error('不支持的数据类型（只接受 字符串 / Blob / ArrayBuffer / Uint8Array）');
 }

 // MS-DOS 时间戳（ZIP 的时间字段就是它，1980 年起）
 function dosTime(when) {
   const d = (when instanceof Date) ? when : new Date(+when || Date.now());
   const y = d.getFullYear();
   const year = y < 1980 ? 1980 : (y > 2107 ? 2107 : y);
   return {
     time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
     date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
   };
 }

 function utf8(str) {
   if (!encoder) throw new Error('当前环境没有 TextEncoder，无法打包文本');
   return encoder.encode(str);
 }

 /* ---------------- 写：entries → Blob ----------------
 * entries: [{ name, data: Blob|ArrayBuffer|Uint8Array|string, lastModified? }]
 * 注意：manifest 里没列的字节一个都不写；条目名由调用方给（本应用只用 ASCII 名）。
 */

 async function build(entries) {
   if (typeof Blob === 'undefined') throw new Error('当前环境不支持 Blob，无法打包 zip');
   if (!Array.isArray(entries) || !entries.length) throw new Error('没有内容可打包');
   if (entries.length > MAX_ENTRIES) throw new Error('条目太多（上限 ' + MAX_ENTRIES + '），请分批导出');

   const parts = [];
   const dir = [];
   let offset = 0;

   for (const e of entries) {
     const name = utf8(String((e && e.name) || ''));
     if (!name.length) throw new Error('有条目缺少文件名');
     const data = await toBytes(e && e.data);
     const size = data.length;
     if (offset + size > MAX_BYTES || size > MAX_BYTES) {
       throw new Error('打包内容超过 4GB 上限（ZIP32）。请分开导出：单个故事的「导出 → 附带原图」也是一条路');
     }

     const when = dosTime(e && e.lastModified);
     const crc = crc32(data);

     const head = new Uint8Array(30 + name.length);
     const hv = new DataView(head.buffer);
     hv.setUint32(0, LOC_SIG, true);
     hv.setUint16(4, 20, true);            // 解压所需版本 2.0
     hv.setUint16(6, 0x0800, true);        // 文件名是 UTF-8
     hv.setUint16(8, 0, true);             // 方法 0 = store
     hv.setUint16(10, when.time, true);
     hv.setUint16(12, when.date, true);
     hv.setUint32(14, crc, true);
     hv.setUint32(18, size, true);         // 压缩后大小 = 原始大小
     hv.setUint32(22, size, true);
     hv.setUint16(26, name.length, true);
     hv.setUint16(28, 0, true);
     head.set(name, 30);

     // 数据块优先直接引用原 Blob（浏览器可把它放在磁盘上），而不是把字节全留在内存里：
     // 这样打包 100 张大图，JS 堆里同时只有「正在算 CRC 的那一张」。
     parts.push(head, isBlobLike(e && e.data) ? e.data : data);

     const cd = new Uint8Array(CD_LEN + name.length);
     const cv = new DataView(cd.buffer);
     cv.setUint32(0, CD_SIG, true);
     cv.setUint16(4, 20, true);            // 创建版本
     cv.setUint16(6, 20, true);            // 解压所需版本
     cv.setUint16(8, 0x0800, true);
     cv.setUint16(10, 0, true);
     cv.setUint16(12, when.time, true);
     cv.setUint16(14, when.date, true);
     cv.setUint32(16, crc, true);
     cv.setUint32(20, size, true);
     cv.setUint32(24, size, true);
     cv.setUint16(28, name.length, true);
     cv.setUint16(30, 0, true);            // 扩展字段
     cv.setUint16(32, 0, true);            // 注释
     cv.setUint16(34, 0, true);            // 起始磁盘号
     cv.setUint16(36, 0, true);            // 内部属性
     cv.setUint32(38, 0, true);            // 外部属性
     cv.setUint32(42, offset, true);       // 本地头偏移
     cd.set(name, CD_LEN);
     dir.push(cd);

     offset += head.length + size;
   }

   const cdOffset = offset;
   let cdSize = 0;
   dir.forEach(d => { cdSize += d.length; });

   const eocd = new Uint8Array(SIG_LEN);
   const ev = new DataView(eocd.buffer);
   ev.setUint32(0, EOCD_SIG, true);
   ev.setUint16(4, 0, true);               // 本磁盘号
   ev.setUint16(6, 0, true);               // 目录起始磁盘号
   ev.setUint16(8, dir.length, true);      // 本磁盘条目数
   ev.setUint16(10, dir.length, true);     // 总条目数
   ev.setUint32(12, cdSize, true);
   ev.setUint32(16, cdOffset, true);
   ev.setUint16(20, 0, true);              // 注释长度

   return new Blob(parts.concat(dir, [eocd]), { type: 'application/zip' });
 }

 /* ---------------- 读：ArrayBuffer|Blob → Map<路径, Blob> ---------------- */

 async function inflateRaw(bytes) {
   if (typeof DecompressionStream === 'undefined' || typeof Response === 'undefined') return null;
   try {
     const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
     return new Uint8Array(await new Response(stream).arrayBuffer());
   } catch (_) {
     return null;
   }
 }

 function findEOCD(dv, len) {
   const min = Math.max(0, len - (65535 + SIG_LEN));
   for (let i = len - SIG_LEN; i >= min; i--) {
     if (dv.getUint32(i, true) === EOCD_SIG) return i;
   }
   return -1;
 }

 async function read(input) {
   if (typeof Blob === 'undefined') throw new Error('当前环境不支持 Blob，无法读取 zip');
   const bytes = await toBytes(input);
   const len = bytes.length;
   if (len < SIG_LEN) throw new Error('文件太小，不像 zip');

   const dv = new DataView(bytes.buffer, bytes.byteOffset, len);
   const eocd = findEOCD(dv, len);
   if (eocd < 0) throw new Error('找不到 ZIP 目录结构（文件损坏，或本来就不是 zip；.rar / .7z 不支持）');

   const count = dv.getUint16(eocd + 10, true);
   const cdSize = dv.getUint32(eocd + 12, true);
   const cdOffset = dv.getUint32(eocd + 16, true);
   if (!count) throw new Error('这个 zip 是空的');
   if (count > READ_MAX_ENTRIES) throw new Error('zip 条目过多（' + count + '），拒绝处理');
   if (cdOffset + cdSize > len || cdOffset + CD_LEN > len) throw new Error('ZIP 目录越界（文件不完整）');

   const out = new Map();
   let p = cdOffset;
   let compressed = 0;          // 因为缺解压能力而跳过的条目数
   let total = 0;

   for (let i = 0; i < count; i++) {
     if (p + CD_LEN > len || dv.getUint32(p, true) !== CD_SIG) break;
     const method = dv.getUint16(p + 10, true);
     const usize = dv.getUint32(p + 24, true);
     const csize = dv.getUint32(p + 20, true);
     const nameLen = dv.getUint16(p + 28, true);
     const extraLen = dv.getUint16(p + 30, true);
     const commentLen = dv.getUint16(p + 32, true);
     const rel = dv.getUint32(p + 42, true);
     if (!decoder) throw new Error('当前环境没有 TextDecoder，无法解析 zip');
     let name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
     // Windows 自带的「压缩」会把分隔符写成反斜杠（同一份备份重新打包后路径变 images\0001.png），
     // 这里统一成正斜杠，调用方才能按清单里的路径找到条目
     if (name.indexOf('\\') !== -1) name = name.replace(/\\/g, '/');
     p += CD_LEN + nameLen + extraLen + commentLen;

     if (name.slice(-1) === '/') continue;                       // 目录项
     if (usize > MAX_BYTES || csize > MAX_BYTES) continue;       // 畸形条目直接跳过
     if (rel + 30 > len || dv.getUint32(rel, true) !== LOC_SIG) continue;
     // 本地头里的名字 / 扩展字段长度可能与中央目录不同，必须以本地头为准算数据起点
     const start = rel + 30 + dv.getUint16(rel + 26, true) + dv.getUint16(rel + 28, true);
     if (start + csize > len) continue;

     const raw = bytes.subarray(start, start + csize);
     if (method === 0) {
       total += raw.length;
       if (total > MAX_BYTES) throw new Error('zip 解出来的内容超过 4GB 上限，拒绝处理');
       out.set(name, new Blob([raw]));
     } else if (method === 8) {
       const full = await inflateRaw(raw);
       if (!full) { compressed++; continue; }
       total += full.length;
       if (total > MAX_BYTES) throw new Error('zip 解出来的内容超过 4GB 上限，拒绝处理');
       out.set(name, new Blob([full]));
     } else {
       compressed++;                                             // 其它压缩方法（罕见）不支持
     }
   }

   if (!out.size) {
     throw new Error(compressed
       ? 'zip 里的内容用了当前浏览器不支持的压缩方式（试试用最新版 Chrome / Edge 打开后重新导出）'
       : 'zip 里没有能读出来的文件');
   }
   return out;
 }

 const Zip = { build, read, crc32 };
 export { Zip };