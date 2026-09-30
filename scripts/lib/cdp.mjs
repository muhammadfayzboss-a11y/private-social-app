// Minimal Chrome DevTools Protocol client shared by the verification scripts.
// Uses Node's built-in WebSocket, so no packages are required.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class Cdp {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
  }
  async ready() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener('open', resolve, { once: true });
      this.socket.addEventListener('error', () => reject(new Error('DevTools socket failed')), { once: true });
    });
    this.socket.addEventListener('message', event => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      } else if (message.method) {
        for (const handler of this.listeners.get(message.method) || []) handler(message.params);
      }
    });
    return this;
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method} timed out`)); }, 20000);
    });
  }
  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
  }
  close() { try { this.socket.close(); } catch { /* already closed */ } }
}

export async function launchChrome({ debugPort, profileDir, binary = process.env.CHROME_PATH || '/usr/local/bin/chrome' }) {
  const chrome = spawn(binary, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run',
    '--hide-scrollbars', '--mute-audio', `--remote-debugging-port=${debugPort}`, `--user-data-dir=${profileDir}`,
    // A synthetic microphone lets the checks record and send real voice messages.
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required',
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  await waitForHttp(`http://127.0.0.1:${debugPort}/json/version`);
  return chrome;
}

export async function waitForHttp(url, timeout = 25000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if ((await fetch(url)).ok) return true; } catch { /* retry */ }
    await sleep(200);
  }
  throw new Error(`Service did not start: ${url}`);
}

export function createSession({ debugPort, screenshotDir, onIssue = () => {} }) {
  let browser = null;

  async function devtools(pathname) {
    const response = await fetch(`http://127.0.0.1:${debugPort}${pathname}`, { method: pathname.startsWith('/json/new') ? 'PUT' : 'GET' });
    return response.json();
  }

  async function connection() {
    if (browser) return browser;
    const version = await devtools('/json/version');
    browser = await new Cdp(version.webSocketDebuggerUrl).ready();
    return browser;
  }

  // Each page gets an isolated browser context so cookies and sessions never mix.
  async function openPage(label, url) {
    const link = await connection();
    const { browserContextId } = await link.send('Target.createBrowserContext', { disposeOnDetach: false });
    const { targetId } = await link.send('Target.createTarget', { url, browserContextId });
    const page = await new Cdp(`ws://127.0.0.1:${debugPort}/devtools/page/${targetId}`).ready();
    page.label = label;
    page.targetId = targetId;
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Network.enable');
    await page.send('Log.enable');
    page.on('Runtime.exceptionThrown', params => {
      onIssue(`[${label}] uncaught: ${params.exceptionDetails?.exception?.description || params.exceptionDetails?.text}`);
    });
    page.on('Runtime.consoleAPICalled', params => {
      if (params.type !== 'error') return;
      const text = params.args.map(arg => arg.value ?? arg.description ?? '').join(' ');
      if (text.includes('Failed to load resource')) return;
      onIssue(`[${label}] console.error: ${text}`);
    });
    page.on('Log.entryAdded', params => {
      const { level, text } = params.entry;
      if (level !== 'error') return;
      // 401/403 and deliberate offline emulation are produced by the negative-path checks.
      if (/status of (401|403)/.test(text) || /favicon|manifest/i.test(text)) return;
      if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_FAILED/.test(text)) return;
      onIssue(`[${label}] log: ${text}`);
    });
    return page;
  }

  return { openPage, connection, devtools };
}

export const DEVICES = {
  'iPhone SE': { width: 375, height: 667, deviceScaleFactor: 2, mobile: true },
  'iPhone 15 Pro': { width: 393, height: 852, deviceScaleFactor: 3, mobile: true },
  'Pixel 8': { width: 412, height: 915, deviceScaleFactor: 2.6, mobile: true },
  'Galaxy S8 (narrow)': { width: 360, height: 740, deviceScaleFactor: 3, mobile: true },
  'smallest supported': { width: 320, height: 568, deviceScaleFactor: 2, mobile: true }
};

export async function useDevice(page, device) {
  await page.send('Emulation.setDeviceMetricsOverride', { ...device });
  await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
}

export async function evaluate(page, expression) {
  const result = await page.send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    returnByValue: true, awaitPromise: true, userGesture: true
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}

export async function waitFor(page, expression, { timeout = 12000, label = expression } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await evaluate(page, `return Boolean(${expression});`).catch(() => false);
    if (value) return true;
    await sleep(120);
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

export async function click(page, selector) {
  const clicked = await evaluate(page, `const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.click(); return true;`);
  if (!clicked) throw new Error(`Element not found: ${selector}`);
  await sleep(220);
}

export async function fill(page, selector, value) {
  const ok = await evaluate(page, `
    const node = document.querySelector(${JSON.stringify(selector)});
    if (!node) return false;
    node.focus();
    node.value = ${JSON.stringify(value)};
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
    return true;`);
  if (!ok) throw new Error(`Input not found: ${selector}`);
}

export async function reload(page, waitSelector = '.tabbar') {
  await page.send('Page.reload', { ignoreCache: false });
  await sleep(400);
  await waitFor(page, `document.querySelector(${JSON.stringify(waitSelector)})`, { label: `reload → ${waitSelector}` });
}

export async function screenshot(page, name, screenshotDir) {
  const { data } = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  fs.mkdirSync(screenshotDir, { recursive: true });
  const file = path.join(screenshotDir, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  return file;
}

/** Reads width/height straight from a PNG IHDR chunk. */
export function pngSize(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.subarray(1, 4).toString('latin1') !== 'PNG') throw new Error(`${file} is not a PNG`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
