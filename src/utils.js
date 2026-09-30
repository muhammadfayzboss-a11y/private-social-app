import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message, code = 'REQUEST_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const nowIso = () => new Date().toISOString();

/**
 * SQLite's CURRENT_TIMESTAMP stores UTC as "YYYY-MM-DD HH:MM:SS" with no zone marker. Browsers parse
 * that shape as *local* time (or reject it), which shifted every "time ago" by the viewer's UTC
 * offset. Every timestamp leaves the API as an unambiguous ISO-8601 UTC string instead.
 */
export function iso(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(text)) return `${text.replace(' ', 'T')}Z`;
  return text;
}

/** decodeURIComponent that never throws on malformed input (a bad header must not become a 500). */
export function safeDecode(value) {
  try { return decodeURIComponent(value); } catch { return String(value); }
}
export const addDays = (date, days) => new Date(date.getTime() + days * 86400000).toISOString();
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const safeEqual = (a, b) => {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

export function validateUsername(value) {
  const username = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9_]{3,24}$/.test(username)) throw new HttpError(400, 'Username must be 3–24 letters, numbers, or underscores.');
  return username;
}

export function cleanText(value, max, field = 'Text') {
  const text = String(value ?? '').trim();
  if (text.length > max) throw new HttpError(400, `${field} is too long.`);
  return text;
}

export function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(part => {
    const index = part.indexOf('=');
    return index < 1 ? [] : [part.slice(0, index).trim(), safeDecode(part.slice(index + 1).trim())];
  }).filter(pair => pair.length === 2));
}

export function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

export function parseJson(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) { reject(new HttpError(413, 'Request is too large.')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new HttpError(400, 'Invalid JSON body.')); }
    });
    req.on('error', reject);
  });
}

/**
 * Members who turned off "Show last seen" appear to everyone else without an online indicator or a
 * last-seen time. `self` is used only for the member's own record, which always carries the truth
 * plus their privacy settings.
 */
export function publicUser(row, online = false, { self = false, hiddenFrom = null } = {}) {
  if (!row) return null;
  // `hiddenFrom` holds members who blocked the viewer: they look like "last seen recently".
  const hidesPresence = Number(row.show_last_seen ?? 1) === 0 || Boolean(hiddenFrom?.has(Number(row.id)));
  const user = {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio,
    role: row.role,
    avatarUrl: row.avatar_media_id ? `/api/media/${row.avatar_media_id}` : null,
    online: self ? Boolean(online) : (hidesPresence ? false : Boolean(online)),
    lastSeenAt: self || !hidesPresence ? iso(row.last_seen_at) : null,
    presenceHidden: !self && hidesPresence,
    createdAt: iso(row.created_at)
  };
  if (self) user.privacy = { showLastSeen: Number(row.show_last_seen ?? 1) !== 0, readReceipts: Number(row.read_receipts ?? 1) !== 0 };
  return user;
}

export function parseRoute(pattern, pathname) {
  const names = [];
  const regex = new RegExp(`^${pattern.replace(/:([A-Za-z]+)/g, (_, name) => { names.push(name); return '([^/]+)'; })}$`);
  const match = pathname.match(regex);
  if (!match) return null;
  return Object.fromEntries(names.map((name, index) => [name, safeDecode(match[index + 1])]));
}
