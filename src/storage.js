import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { one, run } from './db.js';
import { HttpError } from './utils.js';

fs.mkdirSync(config.uploadDir, { recursive: true });

const allowed = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/webm', 'audio/mp4', 'audio/mpeg', 'audio/ogg'
]);
const extensions = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
  'audio/webm': '.webm', 'audio/mp4': '.m4a', 'audio/mpeg': '.mp3', 'audio/ogg': '.ogg'
};

function sniffMime(buffer, supplied) {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg';
  if (buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buffer.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif';
  // ISO base media (MP4/MOV/M4A) and Matroska/WebM containers carry both video and audio payloads,
  // so the client-declared type is kept for them once the container itself is recognised.
  if (buffer.subarray(4, 8).toString('latin1') === 'ftyp') return supplied;
  if (buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) return supplied;
  if (supplied.startsWith('audio/')) return supplied;
  return supplied;
}

export async function receiveUpload(req, ownerId, purpose) {
  const suppliedMime = String(req.headers['content-type'] || '').split(';')[0].toLowerCase();
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
  if (!allowed.has(mime)) throw new HttpError(415, 'File content does not match an allowed format.');
  const storageKey = `${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}${extensions[mime] || ''}`;
  const destination = path.join(config.uploadDir, storageKey);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, buffer, { flag: 'wx', mode: 0o600 });
  const originalName = decodeURIComponent(String(req.headers['x-file-name'] || 'upload')).replace(/[\\/\0]/g, '').slice(0, 180);
  try {
    const result = run('INSERT INTO media(owner_id, storage_key, original_name, mime_type, size_bytes, purpose) VALUES (?, ?, ?, ?, ?, ?)',
      ownerId, storageKey, originalName, mime, size, purpose);
    return one('SELECT * FROM media WHERE id = ?', result.lastInsertRowid);
  } catch (error) { fs.unlinkSync(destination); throw error; }
}

export function sendMedia(req, res, media) {
  const file = path.join(config.uploadDir, media.storage_key);
  if (!fs.existsSync(file)) throw new HttpError(404, 'Media file is unavailable.');
  const stat = fs.statSync(file);
  const range = req.headers.range;
  res.setHeader('content-type', media.mime_type);
  res.setHeader('accept-ranges', 'bytes');
  res.setHeader('cache-control', 'private, max-age=86400');
  res.setHeader('x-content-type-options', 'nosniff');
  if (range) {
    const [startText, endText] = range.replace('bytes=', '').split('-');
    const start = Number(startText); const end = endText ? Number(endText) : Math.min(start + 1024 * 1024, stat.size - 1);
    if (!Number.isFinite(start) || start >= stat.size) { res.writeHead(416); res.end(); return; }
    res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'content-length': stat.size });
    fs.createReadStream(file).pipe(res);
  }
}
