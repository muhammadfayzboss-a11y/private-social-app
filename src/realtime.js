import { nowIso } from './utils.js';
import { run } from './db.js';

const clients = new Map();
const heartbeat = setInterval(() => {
  for (const connections of clients.values()) for (const res of connections) res.write(`: heartbeat ${Date.now()}\n\n`);
}, 25000);
heartbeat.unref();

export function isOnline(userId) { return Boolean(clients.get(Number(userId))?.size); }
export function onlineUserIds() { return [...clients.keys()].filter(isOnline); }

export function connect(userId, req, res) {
  userId = Number(userId);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  res.write(`event: connected\ndata: ${JSON.stringify({ userId, at: nowIso() })}\n\n`);
  const firstConnection = !clients.has(userId);
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);
  if (firstConnection) broadcast('presence', { userId, online: true }, null, userId);
  req.on('close', () => {
    const connections = clients.get(userId);
    connections?.delete(res);
    if (!connections?.size) {
      clients.delete(userId);
      run('UPDATE users SET last_seen_at = ? WHERE id = ?', nowIso(), userId);
      broadcast('presence', { userId, online: false, lastSeenAt: nowIso() }, null, userId);
    }
  });
}

export function send(userId, event, data) {
  for (const res of clients.get(Number(userId)) || []) {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }
}

export function sendMany(userIds, event, data) {
  for (const id of new Set(userIds.map(Number))) send(id, event, data);
}

export function broadcast(event, data, onlyIds = null, exceptId = null) {
  for (const id of onlyIds || clients.keys()) if (id !== Number(exceptId)) send(id, event, data);
}
