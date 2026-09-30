/**
 * Account-level endpoints: synced preferences, username, blocking, and signed-in devices.
 * Every handler acts on the signed-in member only; ids in the URL are always checked against them.
 */
import { all, one, run } from '../db.js';
import { broadcast, isOnline, sendMany } from '../realtime.js';
import { getSettings, updateSettings } from '../settings.js';
import { HttpError, iso, json, parseJson, publicUser, validateUsername } from '../utils.js';

/** A readable device label from a User-Agent string (for the Devices screen only). */
export function describeDevice(userAgent = '') {
  const ua = String(userAgent);
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Unknown device';
  const browser = /EdgA?\//.test(ua) ? 'Edge' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : /node/i.test(ua) ? 'Script' : 'Browser';
  return { os, browser, label: `${browser} on ${os}` };
}

export function registerAccountRoutes(router) {
  router.get('/api/settings', (req, res) => json(res, 200, { settings: getSettings(req.session.user.id) }));

  router.patch('/api/settings', async (req, res) => {
    const body = await parseJson(req, 64000);
    const settings = updateSettings(req.session.user.id, body.settings ?? body);
    // Other signed-in devices of this member pick the change up live.
    sendMany([req.session.user.id], 'settings:updated', { settings });
    json(res, 200, { settings });
  });

  router.patch('/api/profile/username', async (req, res) => {
    const body = await parseJson(req);
    const username = validateUsername(body.username);
    const taken = one('SELECT id FROM users WHERE username = ? AND id <> ?', username, req.session.user.id);
    if (taken) throw new HttpError(409, 'That username is already in use.');
    run('UPDATE users SET username = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', username, req.session.user.id);
    const user = one('SELECT * FROM users WHERE id = ?', req.session.user.id);
    broadcast('profile:updated', { user: publicUser(user, isOnline(user.id)) }, null, user.id);
    json(res, 200, { user: publicUser(user, true, { self: true }) });
  });

  router.get('/api/blocks', (req, res) => {
    const rows = all(`SELECT u.*, b.created_at blocked_at FROM user_blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = ? ORDER BY b.created_at DESC`, req.session.user.id);
    json(res, 200, { blocked: rows.map(row => ({ ...publicUser(row, false), blockedAt: iso(row.blocked_at) })) });
  });

  router.post('/api/blocks', async (req, res) => {
    const body = await parseJson(req);
    const target = one('SELECT id FROM users WHERE id = ?', Number(body.userId));
    if (!target || target.id === req.session.user.id) throw new HttpError(400, 'Choose another member.');
    run('INSERT OR IGNORE INTO user_blocks(blocker_id, blocked_id) VALUES (?, ?)', req.session.user.id, target.id);
    // The blocked member immediately loses this member's presence.
    sendMany([target.id], 'presence', { userId: req.session.user.id, online: false, lastSeenAt: null, hidden: true });
    sendMany([req.session.user.id, target.id], 'block:changed', { userId: target.id, by: req.session.user.id, blocked: true });
    json(res, 201, { ok: true });
  });

  router.delete('/api/blocks/:userId', (req, res, params) => {
    const targetId = Number(params.userId);
    run('DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?', req.session.user.id, targetId);
    sendMany([req.session.user.id, targetId], 'block:changed', { userId: targetId, by: req.session.user.id, blocked: false });
    json(res, 200, { ok: true });
  });

  router.get('/api/sessions', (req, res) => {
    const rows = all('SELECT id, user_agent, created_at, last_used_at, expires_at FROM sessions WHERE user_id = ? AND expires_at > ? ORDER BY last_used_at DESC',
      req.session.user.id, new Date().toISOString());
    json(res, 200, {
      sessions: rows.map(row => ({
        id: row.id, current: row.id === req.session.id, device: describeDevice(row.user_agent),
        createdAt: iso(row.created_at), lastActiveAt: iso(row.last_used_at), expiresAt: iso(row.expires_at)
      }))
    });
  });

  router.delete('/api/sessions/:id', (req, res, params) => {
    const id = Number(params.id);
    if (id === req.session.id) throw new HttpError(400, 'Use “Sign out” to end this session.');
    const removed = run('DELETE FROM sessions WHERE id = ? AND user_id = ?', id, req.session.user.id).changes;
    if (!removed) throw new HttpError(404, 'Session not found.');
    json(res, 200, { ok: true });
  });

  router.post('/api/sessions/terminate-others', (req, res) => {
    const removed = run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', req.session.user.id, req.session.id).changes;
    json(res, 200, { ok: true, removed });
  });
}
