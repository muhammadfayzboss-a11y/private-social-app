import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message, code = 'REQUEST_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const nowIso = () => new Date().toISOString();
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
  return Object.fromEntries(header.split(';').map(part => part.trim().split('=').map(decodeURIComponent)).filter(pair => pair.length === 2));
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

export function publicUser(row, online = false) {
  if (!row) return null;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    bio: row.bio,
    role: row.role,
    avatarUrl: row.avatar_media_id ? `/api/media/${row.avatar_media_id}` : null,
    online,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at
  };
}

export function parseRoute(pattern, pathname) {
  const names = [];
  const regex = new RegExp(`^${pattern.replace(/:([A-Za-z]+)/g, (_, name) => { names.push(name); return '([^/]+)'; })}$`);
  const match = pathname.match(regex);
  if (!match) return null;
  return Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1])]));
}
