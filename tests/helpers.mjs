import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-test-'));
process.env.NODE_ENV = 'test';
process.env.DATABASE_PATH = path.join(workDir, 'circle.db');
process.env.UPLOAD_DIR = path.join(workDir, 'uploads');
process.env.STICKER_DIR = path.resolve('./stickers');
process.env.SETUP_CODE = 'test-setup-code';
process.env.APP_SECRET = 'test-secret-value-that-is-long-enough-1234';

const { server } = await import('../src/server.js');
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

export const baseUrl = `http://127.0.0.1:${server.address().port}`;
export { server, workDir };
export const dbModule = await import('../src/db.js');

export function createClient() {
  let cookie = '';
  let csrf = null;

  async function call(pathname, { method = 'GET', body, headers = {}, skipCsrf = false, binary, stream = false, signal } = {}) {
    const requestHeaders = { accept: 'application/json', ...headers };
    if (cookie) requestHeaders.cookie = cookie;
    if (csrf && !skipCsrf && method !== 'GET') requestHeaders['x-csrf-token'] = csrf;
    let payload;
    if (binary) {
      requestHeaders['content-type'] = binary.type;
      requestHeaders['x-file-name'] = binary.name || 'upload';
      payload = binary.buffer;
    } else if (body !== undefined) {
      requestHeaders['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }

    const response = await fetch(`${baseUrl}${pathname}`, { method, headers: requestHeaders, body: payload, signal });
    for (const entry of response.headers.getSetCookie?.() || []) cookie = entry.split(';')[0];
    if (stream) return { status: response.status, response };

    const text = await response.text();
    let data = text;
    try { data = text ? JSON.parse(text) : null; } catch { /* keep text */ }
    if (data && typeof data === 'object' && data.csrfToken) csrf = data.csrfToken;
    return { status: response.status, data, headers: response.headers };
  }

  return {
    call,
    get cookie() { return cookie; },
    get csrfToken() { return csrf; },
    clearCsrf() { csrf = null; }
  };
}

export const pngFixture = fs.readFileSync(path.resolve('./public/icons/icon-192.png'));

export async function readEvent(reader, eventName, timeoutMs = 6000) {
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value, done } = await Promise.race([
      reader.read(),
      new Promise(resolve => setTimeout(() => resolve({ value: undefined, done: false }), 300))
    ]);
    if (done) break;
    if (value) buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() || '';
    for (const frame of frames) {
      const event = frame.match(/^event: (.+)$/m)?.[1];
      const data = frame.match(/^data: (.+)$/m)?.[1];
      if (event === eventName && data) return JSON.parse(data);
    }
  }
  throw new Error(`Timed out waiting for realtime event "${eventName}"`);
}
