/*
 * 无限阅读 · sidecar · SSE 事件通道
 *
 * 侧车 → 前端（页面开着时）的唯一推送通道：到点触发、待确认变化等。
 * 只推事件，不推全量；页面没开时事件自然没人收，前端下次打开先拉 /api/pending 补齐。
 */
const clients = new Set();

export function addClient(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const client = { res, at: Date.now() };
  clients.add(client);

  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);

  const cleanup = () => {
    clearInterval(ping);
    clients.delete(client);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  req.on('end', cleanup);

  return client;
}

export function broadcast(event, data) {
  const payload = 'event: ' + String(event) + '\ndata: ' + JSON.stringify(data == null ? {} : data) + '\n\n';
  for (const c of clients) {
    try { c.res.write(payload); } catch (_) {}
  }
  return clients.size;
}

export function clientCount() { return clients.size; }

export function closeAll() {
  for (const c of clients) { try { c.res.end(); } catch (_) {} }
  clients.clear();
}
