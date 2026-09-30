import { config } from '../config.js';
import { all, bootstrapGroupConversation, one, run, transaction } from '../db.js';
import { clientIp, createSession, dummyPasswordCheck, getSession, hashPassword, rateLimit, sessionCookie, verifyPassword } from '../auth.js';
import { blockedByIds } from '../privacy.js';
import { broadcast, disconnectSession, isOnline } from '../realtime.js';
import { getSettings } from '../settings.js';
import { cleanText, HttpError, iso, json, parseJson, publicUser, randomToken, sha256, validateUsername } from '../utils.js';

function setSession(res, session) {
  res.setHeader('set-cookie', sessionCookie(session.token));
  return session.csrfToken;
}

async function createAccount(body, role = 'member', invite = null) {
  const username = validateUsername(body.username);
  const displayName = cleanText(body.displayName, 50, 'Display name');
  if (displayName.length < 1) throw new HttpError(400, 'Display name is required.');
  if (one('SELECT id FROM users WHERE username = ?', username)) throw new HttpError(409, 'That username is already in use.');
  const passwordHash = await hashPassword(body.password);
  const userId = transaction(() => {
    const result = run('INSERT INTO users(username, display_name, password_hash, role) VALUES (?, ?, ?, ?)', username, displayName, passwordHash, role);
    if (invite) run('UPDATE invites SET claimed_by = ?, claimed_at = CURRENT_TIMESTAMP WHERE id = ?', result.lastInsertRowid, invite.id);
    const group = bootstrapGroupConversation();
    run('INSERT OR IGNORE INTO conversation_members(conversation_id, user_id) VALUES (?, ?)', group.id, result.lastInsertRowid);
    return result.lastInsertRowid;
  });
  return one('SELECT * FROM users WHERE id = ?', userId);
}

export function registerAuthRoutes(router) {
  router.get('/api/auth/status', (req, res) => {
    const session = getSession(req);
    json(res, 200, {
      authenticated: Boolean(session), needsSetup: !one('SELECT id FROM users LIMIT 1'), user: session?.user || null,
      settings: session ? getSettings(session.user.id) : null, csrfToken: session?.csrfToken || null, serverTime: new Date().toISOString()
    });
  }, { public: true });

  router.post('/api/auth/bootstrap', async (req, res) => {
    rateLimit(`bootstrap:${clientIp(req)}`, 5, 300000);
    if (one('SELECT id FROM users LIMIT 1')) throw new HttpError(409, 'The group has already been created.');
    const body = await parseJson(req);
    if (body.setupCode !== config.setupCode) throw new HttpError(403, 'Invalid private setup code.');
    const userRow = await createAccount(body, 'admin');
    const session = createSession(userRow.id, req);
    const csrfToken = setSession(res, session);
    json(res, 201, { user: publicUser(userRow, true, { self: true }), settings: getSettings(userRow.id), csrfToken });
  }, { public: true });

  router.post('/api/auth/register', async (req, res) => {
    rateLimit(`register:${clientIp(req)}`, 10, 3600000);
    const body = await parseJson(req);
    const invite = one('SELECT * FROM invites WHERE code_hash = ? AND claimed_by IS NULL AND (expires_at IS NULL OR expires_at > ?)', sha256(String(body.inviteCode || '').trim()), new Date().toISOString());
    if (!invite) throw new HttpError(403, 'This invitation is invalid or has expired.');
    const userRow = await createAccount(body, 'member', invite);
    const session = createSession(userRow.id, req);
    const csrfToken = setSession(res, session);
    broadcast('member:joined', { user: publicUser(userRow, true) }, null, userRow.id);
    json(res, 201, { user: publicUser(userRow, true, { self: true }), settings: getSettings(userRow.id), csrfToken });
  }, { public: true });

  router.post('/api/auth/login', async (req, res) => {
    const body = await parseJson(req);
    const username = String(body.username || '').trim().toLowerCase();
    // A generous per-source cap (the whole group shares one proxy IP when hosted) plus a strict
    // per-account cap, so one member's failed attempts can never lock everybody else out.
    rateLimit(`login:ip:${clientIp(req)}`, 40, 600000);
    if (username) rateLimit(`login:user:${username}`, 8, 600000);
    const userRow = one('SELECT * FROM users WHERE username = ?', username);
    if (!userRow) { await dummyPasswordCheck(body.password); throw new HttpError(401, 'Incorrect username or password.'); }
    if (!(await verifyPassword(String(body.password || ''), userRow.password_hash))) throw new HttpError(401, 'Incorrect username or password.');
    const session = createSession(userRow.id, req);
    const csrfToken = setSession(res, session);
    json(res, 200, { user: publicUser(userRow, true, { self: true }), settings: getSettings(userRow.id), csrfToken });
  }, { public: true });

  router.post('/api/auth/logout', (req, res) => {
    run('DELETE FROM sessions WHERE id = ?', req.session.id);
    disconnectSession(req.session.id);
    res.setHeader('set-cookie', sessionCookie('', 0));
    json(res, 200, { ok: true });
  });

  router.post('/api/invites', async (req, res) => {
    if (req.session.user.role !== 'admin') throw new HttpError(403, 'Only the group admin can create invitations.');
    const body = await parseJson(req);
    const rawCode = randomToken(12);
    const days = Math.min(Math.max(Number(body.days || 7), 1), 30);
    const expiresAt = new Date(Date.now() + days * 86400000).toISOString();
    const result = run('INSERT INTO invites(code_hash, label, created_by, expires_at) VALUES (?, ?, ?, ?)', sha256(rawCode), cleanText(body.label, 50, 'Label'), req.session.user.id, expiresAt);
    json(res, 201, { id: Number(result.lastInsertRowid), code: rawCode, expiresAt });
  });

  router.get('/api/invites', (req, res) => {
    if (req.session.user.role !== 'admin') throw new HttpError(403, 'Only the group admin can view invitations.');
    json(res, 200, { invites: all('SELECT id, label, expires_at, claimed_at, created_at FROM invites ORDER BY id DESC')
      .map(invite => ({ id: invite.id, label: invite.label, expiresAt: iso(invite.expires_at), claimedAt: iso(invite.claimed_at), createdAt: iso(invite.created_at) })) });
  });

  router.get('/api/members', (req, res) => {
    const viewerId = req.session.user.id;
    const hiddenFrom = blockedByIds(viewerId);
    json(res, 200, { members: all('SELECT * FROM users ORDER BY display_name').map(user => publicUser(user, isOnline(user.id), { self: user.id === viewerId, hiddenFrom })) });
  });
}
