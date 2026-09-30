import { nowIso } from './utils.js';
import { one, run } from './db.js';
import { blockedIds } from './privacy.js';

// user id -> Set<{ res, sessionId }>. Session ids let remote sign-out close a live stream instantly.
const clients = new Map();
let sequence = 0;

const heartbeat = setInterval(() => {
  for (const connections of clients.values()) for (const connection of connections) {
    try { connection.res.write(`: heartbeat ${Date.now()}\n\n`); } catch { /* close handler removes it */ }
  }
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

export function connect(userId, sessionId, req, res) {
  userId = Number(userId);
  sessionId = Number(sessionId);
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  res.write(`retry: 3000\nevent: connected\ndata: ${JSON.stringify({ userId, at: nowIso(), serverTime: nowIso() })}\n\n`);
  const firstConnection = !clients.has(userId);
  if (!clients.has(userId)) clients.set(userId, new Set());
  const connection = { res, sessionId };
  clients.get(userId).add(connection);
  if (firstConnection && !hidesPresence(userId)) announcePresence(userId, { userId, online: true });
  const close = () => removeConnection(userId, connection);
  req.on('close', close);
  res.on('error', close);
}

function removeConnection(userId, connection) {
  const connections = clients.get(userId);
  if (!connections?.has(connection)) return;
  connections.delete(connection);
  if (!connections.size) {
    clients.delete(userId);
    const at = nowIso();
    run('UPDATE users SET last_seen_at = ? WHERE id = ?', at, userId);
    if (!hidesPresence(userId)) announcePresence(userId, { userId, online: false, lastSeenAt: at });
  }
}

/** Ends every active event stream authenticated by a session that was signed out remotely. */
export function disconnectSession(sessionId) {
  sessionId = Number(sessionId);
  let closed = 0;
  for (const [userId, connections] of [...clients]) {
    for (const connection of [...connections]) {
      if (connection.sessionId !== sessionId) continue;
      removeConnection(userId, connection);
      try { connection.res.end(); } catch { /* already closed */ }
      closed += 1;
    }
  }
  return closed;
}

/** Every frame carries a monotonically increasing id so clients can discard exact replays. */
export function send(userId, event, data) {
  const connections = clients.get(Number(userId));
  if (!connections?.size) return;
  const frame = `id: ${++sequence}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const connection of [...connections]) {
    try { connection.res.write(frame); } catch { removeConnection(Number(userId), connection); }
  }
}

export function sendMany(userIds, event, data) {
  for (const id of new Set(userIds.map(Number))) send(id, event, data);
}

export function broadcast(event, data, onlyIds = null, exceptId = null) {
  for (const id of onlyIds || [...clients.keys()]) if (id !== Number(exceptId)) send(id, event, data);
}
