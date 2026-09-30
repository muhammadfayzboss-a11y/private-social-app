import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './config.js';
import { one, run } from './db.js';
import { addDays, HttpError, iso, parseCookies, publicUser, randomToken, safeEqual, sha256 } from './utils.js';

const scrypt = promisify(crypto.scrypt);

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
    throw new HttpError(400, 'Password must be between 10 and 128 characters.');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt}$${Buffer.from(derived).toString('hex')}`;
}

// Verifying against a throwaway hash when the username does not exist keeps response times the
// same either way, so login timing cannot be used to discover which usernames are members.
const DUMMY_HASH = `scrypt$${crypto.randomBytes(16).toString('hex')}$${'0'.repeat(128)}`;
export function dummyPasswordCheck(password) { return verifyPassword(String(password || ''), DUMMY_HASH); }

export async function verifyPassword(password, stored) {
  try {
    const [scheme, salt, expected] = stored.split('$');
    if (scheme !== 'scrypt') return false;
    const derived = await scrypt(password, salt, 64, { N: 16384, r: 8, p: 1 });
    return safeEqual(Buffer.from(derived).toString('hex'), expected);
  } catch { return false; }
}

export function sessionCookie(token, maxAge = config.sessionDays * 86400) {
  const security = config.secureCookies ? '; Secure' : '';
  return `circle_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${security}`;
}

export function createSession(userId, req) {
  const token = randomToken();
  const csrfToken = randomToken(24);
  run('INSERT INTO sessions(user_id, token_hash, csrf_token, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)',
    userId, sha256(token), csrfToken, addDays(new Date(), config.sessionDays), String(req.headers['user-agent'] || '').slice(0, 300));
  return { token, csrfToken };
}

export function getSession(req) {
  const token = parseCookies(req.headers.cookie).circle_session;
  if (!token) return null;
  const session = one(`SELECT s.*, u.username, u.display_name, u.bio, u.role, u.avatar_media_id, u.last_seen_at, u.show_last_seen, u.read_receipts, u.created_at
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`, sha256(token), new Date().toISOString());
  if (!session) return null;
  // Keep "last active" fresh for the Devices screen without writing on every request.
  if (!(Date.now() - Date.parse(iso(session.last_used_at)) < 5 * 60000)) {
    run('UPDATE sessions SET last_used_at = ? WHERE id = ?', new Date().toISOString(), session.id);
  }
  return { id: session.id, csrfToken: session.csrf_token, user: publicUser({ ...session, id: session.user_id }, true, { self: true }) };
}

export function requireAuth(req) {
  const session = getSession(req);
  if (!session) throw new HttpError(401, 'Please sign in to continue.', 'AUTH_REQUIRED');
  req.session = session;
  return session;
}

export function verifyCsrf(req, session) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  const supplied = req.headers['x-csrf-token'];
  if (!supplied || !safeEqual(supplied, session.csrfToken)) throw new HttpError(403, 'Your session could not be verified. Refresh and try again.', 'CSRF_INVALID');
}

/**
 * Identifies the caller for throttling. Hosted behind a proxy every request arrives from the
 * same socket address, so X-Forwarded-For is used when TRUST_PROXY is explicitly enabled.
 * This value is only ever used for rate-limit keys, never for authentication decisions.
 */
export function clientIp(req) {
  if (config.trustProxy) {
    const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress || 'unknown';
}

const attempts = new Map();
export function rateLimit(key, limit = 20, windowMs = 60000) {
  const now = Date.now();
  const current = attempts.get(key);
  if (!current || current.resetAt < now) { attempts.set(key, { count: 1, resetAt: now + windowMs }); return; }
  current.count += 1;
  if (current.count > limit) throw new HttpError(429, 'Too many attempts. Please wait and try again.');
}

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of attempts) if (value.resetAt < now) attempts.delete(key);
}, 60000).unref();
