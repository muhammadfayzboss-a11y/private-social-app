import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { one, run } from './db.js';
import { HttpError, safeDecode } from './utils.js';

fs.mkdirSync(config.uploadDir, { recursive: true });

const allowed = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg'
]);
// Some platforms label the same containers differently; normalise before checking.
const aliases = { 'audio/x-m4a': 'audio/mp4', 'audio/m4a': 'audio/mp4', 'audio/aac': 'audio/mp4', 'audio/mp3': 'audio/mpeg', 'video/x-m4v': 'video/mp4' };
const extensions = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'audio/webm': '.webm', 'audio/mp4': '.m4a', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg'
};

/**
 * Identifies the real format from the file's leading bytes. Container formats (MP4/MOV, WebM, Ogg)
 * carry either audio or video, so the declared type is kept only when it belongs to the detected
 * container family. Anything unrecognised is rejected rather than trusted.
 */
export function sniffMime(buffer, supplied) {
  const head = buffer.subarray(0, 12);
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (head.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif';
  if (head.subarray(4, 8).toString('latin1') === 'ftyp') return ['video/mp4', 'video/quicktime', 'audio/mp4'].includes(supplied) ? supplied : 'video/mp4';
  if (head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return ['video/webm', 'audio/webm'].includes(supplied) ? supplied : 'video/webm';
  if (head.subarray(0, 4).toString('latin1') === 'OggS') return 'audio/ogg';
  if (head.subarray(0, 3).toString('latin1') === 'ID3' || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return 'audio/mpeg';
  return null;
}

function boundedInt(value, max) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) && number > 0 && number <= max ? number : null;
}

export async function receiveUpload(req, ownerId, purpose) {
  const declared = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  const suppliedMime = aliases[declared] || declared;
  if (!allowed.has(suppliedMime)) throw new HttpError(415, 'Unsupported media type.');
  const declaredLength = Number(req.headers['content-length'] || 0);
  if (declaredLength > config.maxUploadBytes) throw new HttpError(413, 'File exceeds the upload limit.');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > config.maxUploadBytes) throw new HttpError(413, 'File exceeds the upload limit.');
    chunks.push(chunk);
  }
  if (!size) throw new HttpError(400, 'The uploaded file is empty.');
  const buffer = Buffer.concat(chunks);
  const mime = sniffMime(buffer, suppliedMime);
  if (!mime || !allowed.has(mime)) throw new HttpError(415, 'File content does not match an allowed format.');
  // Images must be declared as images and vice versa; audio and video may share a container.
  if ((mime.startsWith('image/')) !== suppliedMime.startsWith('image/')) throw new HttpError(415, 'File content does not match its declared type.');
  if (purpose === 'voice' && !mime.startsWith('audio/') && mime !== 'video/webm' && mime !== 'video/mp4') throw new HttpError(415, 'Voice messages must be audio.');
  // Some recorders label audio-only WebM/MP4 as video; voice uploads are always stored as audio.
  const storedMime = purpose === 'voice' ? mime.replace(/^video\//, 'audio/') : mime;
  const storageKey = `${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}${extensions[storedMime] || ''}`;
  const destination = path.join(config.uploadDir, storageKey);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, buffer, { flag: 'wx', mode: 0o600 });
  const originalName = safeDecode(String(req.headers['x-file-name'] || 'upload')).replace(/[\\/\0]/g, '').slice(0, 180);
  // Dimensions are reported by the client so the UI can reserve space before the file loads.
  const width = boundedInt(req.headers['x-media-width'], 20000);
  const height = boundedInt(req.headers['x-media-height'], 20000);
  const durationMs = boundedInt(req.headers['x-media-duration'], 6 * 3600 * 1000);
  try {
    const result = run('INSERT INTO media(owner_id, storage_key, original_name, mime_type, size_bytes, purpose, width, height, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ownerId, storageKey, originalName, storedMime, size, purpose, width, height, durationMs);
    return one('SELECT * FROM media WHERE id = ?', result.lastInsertRowid);
  } catch (error) { fs.unlinkSync(destination); throw error; }
}

/** Parses a single-range header ("a-b", "a-", "-n"); returns null for anything unsatisfiable. */
export function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match || (!match[1] && !match[2])) return null;
  let start; let end;
  if (!match[1]) { const suffix = Number(match[2]); if (!suffix) return null; start = Math.max(0, size - suffix); end = size - 1; }
  else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1; }
  if (start >= size || end < start) return null;
  return { start, end };
}

export function sendMedia(req, res, media) {
  const file = path.join(config.uploadDir, media.storage_key);
  if (!fs.existsSync(file)) throw new HttpError(404, 'Media file is unavailable.');
  const stat = fs.statSync(file);
  res.setHeader('content-type', media.mime_type);
  res.setHeader('accept-ranges', 'bytes');
  res.setHeader('cache-control', 'private, max-age=86400');
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('content-security-policy', "default-src 'none'; sandbox");
  if (req.headers.range) {
    const range = parseRange(req.headers.range, stat.size);
    if (!range) { res.writeHead(416, { 'content-range': `bytes */${stat.size}` }); res.end(); return; }
    res.writeHead(206, { 'content-range': `bytes ${range.start}-${range.end}/${stat.size}`, 'content-length': range.end - range.start + 1 });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file, { start: range.start, end: range.end }).pipe(res);
  } else {
    res.writeHead(200, { 'content-length': stat.size });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  }
}
