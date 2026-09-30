/**
 * Link previews (title, description, site name — never remote images, which the CSP would block and
 * which would leak members' IPs to third parties).
 *
 * The server fetches the page, so this is a classic SSRF surface. Defences:
 * - only http/https on their default ports;
 * - DNS is resolved once per hop through a custom lookup that rejects private, loopback, link-local,
 *   CGNAT, multicast and IPv4-mapped private addresses, and the socket connects to exactly that
 *   address (no DNS-rebinding window);
 * - every redirect target is re-validated, with at most three hops;
 * - 5 s timeout, 300 KB read cap, HTML only.
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { one, run } from './db.js';

const MAX_BYTES = 300 * 1024;
const TIMEOUT_MS = 5000;
const REFRESH_MS = 7 * 86400000;
const RETRY_MS = 86400000;
const inflight = new Map();

function ipv4Private(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
}

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return ipv4Private(ip);
  const lower = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return ipv4Private(mapped[1]);
  return lower === '::' || lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || /^fe[89ab]/.test(lower) || lower.startsWith('ff');
}

function safeLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true }, (error, addresses) => {
    if (error) return callback(error);
    const usable = addresses.filter(entry => !isPrivateAddress(entry.address));
    if (!usable.length || usable.length !== addresses.length) return callback(Object.assign(new Error('Blocked address'), { code: 'EBLOCKED' }));
    if (options?.all) return callback(null, usable);
    callback(null, usable[0].address, usable[0].family);
  });
}

export function validatePreviewUrl(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  if (url.port && !((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80'))) return null;
  if (net.isIP(url.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ''))) return null;
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(url.hostname)) return null;
  return url;
}

function fetchOnce(url) {
  return new Promise((resolve, reject) => {
    const client = url.protocol === 'https:' ? https : http;
    const request = client.get(url, {
      lookup: safeLookup, timeout: TIMEOUT_MS,
      headers: { 'user-agent': 'CircleLinkPreview/1.0 (+private group messenger)', accept: 'text/html,application/xhtml+xml', 'accept-language': 'en' }
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        return resolve({ redirect: new URL(response.headers.location, url).href });
      }
      if (response.statusCode !== 200 || !/text\/html|application\/xhtml/i.test(String(response.headers['content-type'] || ''))) {
        response.resume();
        return resolve({ html: null });
      }
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        chunks.push(chunk);
        if (size >= MAX_BYTES) { response.destroy(); resolve({ html: Buffer.concat(chunks).toString('utf8') }); }
      });
      response.on('end', () => resolve({ html: Buffer.concat(chunks).toString('utf8') }));
      response.on('error', reject);
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', reject);
  });
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decode(text) {
  return String(text || '').replace(/&(#x?[0-9a-f]+|[a-z]+|#39);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 31 && code < 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return ENTITIES[entity.toLowerCase()] ?? match;
  }).replace(/\s+/g, ' ').trim();
}

export function parsePreview(html) {
  const head = html.slice(0, MAX_BYTES);
  const meta = name => {
    const pattern = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i');
    const tag = pattern.exec(head)?.[0];
    return tag ? decode(/content=["']([^"']*)["']/i.exec(tag)?.[1]) : '';
  };
  const title = meta('og:title') || meta('twitter:title') || decode(/<title[^>]*>([^<]*)<\/title>/i.exec(head)?.[1]);
  return {
    title: title.slice(0, 200),
    description: (meta('og:description') || meta('description') || meta('twitter:description')).slice(0, 300),
    siteName: meta('og:site_name').slice(0, 80)
  };
}

async function fetchPreview(rawUrl) {
  let target = validatePreviewUrl(rawUrl);
  for (let hop = 0; target && hop < 4; hop += 1) {
    const result = await fetchOnce(target);
    if (result.redirect) { target = validatePreviewUrl(result.redirect); continue; }
    if (!result.html) return null;
    const preview = parsePreview(result.html);
    return preview.title ? { ...preview, siteName: preview.siteName || target.hostname.replace(/^www\./, '') } : null;
  }
  return null;
}

/**
 * Ensures a preview exists for `url`. Resolves true when a new preview was stored (the caller then
 * re-broadcasts the message). Unsafe or failing URLs are remembered so they are not retried often.
 */
export function ensureLinkPreview(url) {
  if (!url) return Promise.resolve(false);
  const cached = one('SELECT status, fetched_at FROM link_previews WHERE url = ?', url);
  if (cached) {
    const age = Date.now() - Date.parse(cached.fetched_at);
    if (cached.status === 'ok' && age < REFRESH_MS) return Promise.resolve(false);
    if (cached.status !== 'ok' && age < RETRY_MS) return Promise.resolve(false);
  }
  if (inflight.has(url)) return inflight.get(url);
  const store = (status, preview = {}) => run(`INSERT INTO link_previews(url, status, title, description, site_name, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(url) DO UPDATE SET status = excluded.status, title = excluded.title, description = excluded.description, site_name = excluded.site_name, fetched_at = excluded.fetched_at`,
    url, status, preview.title || '', preview.description || '', preview.siteName || '', new Date().toISOString());
  const task = (async () => {
    if (!validatePreviewUrl(url)) { store('blocked'); return false; }
    try {
      const preview = await fetchPreview(url);
      if (!preview) { store('none'); return false; }
      store('ok', preview);
      return true;
    } catch (error) {
      store(error.code === 'EBLOCKED' ? 'blocked' : 'error');
      return false;
    }
  })().finally(() => inflight.delete(url));
  inflight.set(url, task);
  return task;
}
