/*
 * 无限阅读 · sidecar · SSE 事件通道
 *
 * 侧车 → 前端（页面开着时）的唯一推送通道：到点触发、待确认变化等。
 * 只推事件，不推全量；页面没开时事件自然没人收，前端下次打开先拉 /api/pending 补齐。
 *
 * 资源与凭据边界：
 *   - 连接凭「短时效一次性 ticket」——EventSource 不能带 Authorization 头，token 绝不进 URL / 日志；
 *   - 客户端数量有上限，超限由调用方回 429（慢连接 / 僵尸连接不无限堆积）；
 *   - 写失败的客户端就地清理，不留在集合里继续吃广播。
 */
import crypto from 'node:crypto';

const clients = new Set();
const MAX_CLIENTS = 32;
const TICKET_TTL_MS = 30 * 1000;   // ticket 短时效：换到后要马上连
const MAX_TICKETS = 64;

const tickets = new Map();   // ticket → 过期时间戳（一次性：连接时消费）

function pruneTickets() {
  const now = Date.now();
  for (const [t, exp] of tickets) { if (exp <= now) tickets.delete(t); }
  while (tickets.size > MAX_TICKETS) {
    const oldest = tickets.keys().next().value;
    if (oldest === undefined) break;
    tickets.delete(oldest);
  }
}

/* 换取一张一次性 SSE ticket（调用方已过 Bearer 鉴权） */
export function issueTicket() {
  pruneTickets();
  const ticket = crypto.randomBytes(24).toString('hex');
  tickets.set(ticket, Date.now() + TICKET_TTL_MS);
  return { ticket: ticket, expiresInMs: TICKET_TTL_MS };
}

/* 消费 ticket：不管过没过期，用掉即删（一次性） */
export function consumeTicket(ticket) {
  const key = String(ticket || '');
  const exp = tickets.get(key);
  tickets.delete(key);
  return !!exp && exp > Date.now();
}

export function addClient(req, res) {
  if (clients.size >= MAX_CLIENTS) return null;   // 超上限：调用方回 429
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const client = { res, at: Date.now(), ping: null, cleanup: null };
  const cleanup = () => {
    if (client.ping) { clearInterval(client.ping); client.ping = null; }
    clients.delete(client);   // 幂等：close / error / end 可能都会来
  };
  client.cleanup = cleanup;
  clients.add(client);

  client.ping = setInterval(() => {
    try { res.write(': ping\n\n'); }
    catch (_) { cleanup(); }   // 写失败（连接已死）：就地移除，不留在集合里吃广播
  }, 25000);

  req.on('close', cleanup);
  req.on('error', cleanup);
  req.on('end', cleanup);
  res.on('error', cleanup);
  res.on('close', cleanup);

  return client;
}

export function broadcast(event, data) {
  const payload = 'event: ' + String(event) + '\ndata: ' + JSON.stringify(data == null ? {} : data) + '\n\n';
  for (const c of clients) {
    try { c.res.write(payload); }
    catch (_) { if (c.cleanup) c.cleanup(); }   // 写失败的客户端就地清理
  }
  return clients.size;
}

export function closeAll() {
  for (const c of clients) {
    if (c.cleanup) c.cleanup();
    try { c.res.end(); } catch (_) {}
  }
  clients.clear();
}
