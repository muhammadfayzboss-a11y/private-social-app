import { nowIso } from './utils.js';
import { one, run } from './db.js';
import { blockedIds } from './privacy.js';

const clients = new Map();
let sequence = 0;

const heartbeat = setInterval(() => {
  for (const connections of clients.values()) for (const res of connections) res.write(`: heartbeat ${Date.now()}\n\n`);
}, 25000);
heartbeat.unref();

export function isOnline(userId) { return Boolean(clients.get(Number(userId))?.size); }
export function onlineUserIds() { return [...clients.keys()].filter(isOnline); }

function hidesPresence(userId) {
  return Number(one('SELECT show_last_seen FROM users WHERE id = ?', userId)?.show_last_seen ?? 1) === 0;
}

/** Presence goes to everyone connected except the member themselves and anyone they blocked. */
function announcePresence(userId, data) {
  const blocked = blockedIds(userId);
  for (const id of [...clients.keys()]) if (id !== userId && !blocked.has(id)) send(id, 'presence', data);
}

export function connect(userId, req, res) {
  userId = Number(userId);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  // `retry` tells EventSource how quickly to reconnect; serverTime lets the client correct clock skew
  // so relative timestamps ("5m") are computed against the server's clock, not a drifting phone clock.
  res.write(`retry: 3000\nevent: connected\ndata: ${JSON.stringify({ userId, at: nowIso(), serverTime: nowIso() })}\n\n`);
  const firstConnection = !clients.has(userId);
  if (!clients.has(userId)) clients.set(userId, new Set());
  clients.get(userId).add(res);
  if (firstConnection && !hidesPresence(userId)) announcePresence(userId, { userId, online: true });
  const close = () => {
    const connections = clients.get(userId);
    if (!connections?.has(res)) return;
    connections.delete(res);
    if (!connections.size) {
      clients.delete(userId);
      const at = nowIso();
      run('UPDATE users SET last_seen_at = ? WHERE id = ?', at, userId);
      if (!hidesPresence(userId)) announcePresence(userId, { userId, online: false, lastSeenAt: at });
    }
  };
  req.on('close', close);
  res.on('error', close);
}

/** Every frame carries a monotonically increasing id so clients can discard exact replays. */
export function send(userId, event, data) {
  const connections = clients.get(Number(userId));
  if (!connections?.size) return;
  const frame = `id: ${++sequence}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of connections) res.write(frame);
}

export function sendMany(userIds, event, data) {
  for (const id of new Set(userIds.map(Number))) send(id, event, data);
}

export function broadcast(event, data, onlyIds = null, exceptId = null) {
  for (const id of onlyIds || [...clients.keys()]) if (id !== Number(exceptId)) send(id, event, data);
}
