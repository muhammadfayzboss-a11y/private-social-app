// Deployment readiness audit: production configuration, security headers, cookie flags,
// PWA installability, offline shell, and mobile layout across phone viewports.
// Run with: npm run verify:deploy
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEVICES, click, createSession, evaluate, fill, launchChrome, pngSize, reload, screenshot, sleep, useDevice, waitFor, waitForHttp
} from './lib/cdp.mjs';

const PORT = Number(process.env.VERIFY_PORT || 4192);
const HTTPS_PORT = PORT + 1;
const DEBUG_PORT = Number(process.env.VERIFY_DEBUG_PORT || 9337);
const BASE = `http://127.0.0.1:${PORT}`;
const SETUP_CODE = 'deploy-check-setup-code';
const SECRET = 'deployment-readiness-secret-value-0123456789';
const shotDir = path.resolve('./.kiro/artifacts/screenshots');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-deploy-'));

const results = [];
const issues = [];
let failures = 0;
const probeFile = path.resolve('./public/__deploy-probe.js');
const volumeDirs = [];

function report(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
async function check(name, fn) {
  try { report(name, true, (await fn()) || ''); }
  catch (error) { report(name, false, error.message); }
}

function startServer({ port, env = {}, dataDir }) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
    env: {
      PATH: process.env.PATH,
      NODE_OPTIONS: '',
      NODE_ENV: 'production',
      PORT: String(port),
      APP_SECRET: SECRET,
      SETUP_CODE,
      DATABASE_PATH: path.join(dataDir, 'circle.db'),
      UPLOAD_DIR: path.join(dataDir, 'uploads'),
      STICKER_DIR: path.resolve('./stickers'),
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stderr.on('data', data => issues.push(`[server:${port}] ${String(data).trim()}`));
  return child;
}

const servers = [];
function shutdownAll() {
  for (const child of servers) child.kill('SIGKILL');
}

try {
  /* ------------------------------------------------------------------ */
  /* Phase 1 — production configuration, headers, and cookie flags      */
  /* ------------------------------------------------------------------ */

  const httpsLikeDir = path.join(workDir, 'https-origin');
  fs.mkdirSync(httpsLikeDir, { recursive: true });
  const httpsLike = startServer({
    port: HTTPS_PORT,
    dataDir: httpsLikeDir,
    env: { APP_ORIGIN: 'https://circle.example.test' }
  });
  servers.push(httpsLike);
  await waitForHttp(`http://127.0.0.1:${HTTPS_PORT}/api/health`);

  await check('production boot requires explicit secrets (no silent dev fallback)', async () => {
    const rejected = await new Promise(resolve => {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
        env: { PATH: process.env.PATH, NODE_OPTIONS: '', NODE_ENV: 'production', PORT: '0', DATABASE_PATH: path.join(workDir, 'unused.db') },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stderr = '';
      child.stderr.on('data', data => { stderr += data; });
      child.on('exit', code => resolve({ code, stderr }));
    });
    if (rejected.code === 0) throw new Error('server started without APP_SECRET');
    if (!/Refusing to start in production/.test(rejected.stderr)) throw new Error('missing explanatory error');
    return 'refuses to start without APP_SECRET and SETUP_CODE';
  });

  await check('an https APP_ORIGIN enables HSTS and Secure session cookies', async () => {
    const base = `http://127.0.0.1:${HTTPS_PORT}`;
    const headers = (await fetch(`${base}/`)).headers;
    if (!headers.get('strict-transport-security')) throw new Error('HSTS header missing');

    const created = await fetch(`${base}/api/auth/bootstrap`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ setupCode: SETUP_CODE, username: 'deploy', displayName: 'Deploy Check', password: 'deployment-pass-1' })
    });
    const cookie = created.headers.getSetCookie().find(entry => entry.startsWith('circle_session='));
    if (!cookie) throw new Error('no session cookie issued');
    for (const flag of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/']) {
      if (!cookie.includes(flag)) throw new Error(`session cookie missing ${flag}`);
    }
    return `HSTS + ${['HttpOnly', 'SameSite=Strict', 'Secure'].join(', ')}`;
  });

  await check('security headers are present on the app shell and API', async () => {
    const base = `http://127.0.0.1:${HTTPS_PORT}`;
    const expected = {
      'content-security-policy': /default-src 'self'/,
      'x-content-type-options': /nosniff/,
      'x-frame-options': /DENY/,
      'referrer-policy': /same-origin/,
      'permissions-policy': /geolocation=\(\)/
    };
    for (const target of ['/', '/api/health']) {
      const headers = (await fetch(`${base}${target}`)).headers;
      for (const [header, pattern] of Object.entries(expected)) {
        const value = headers.get(header);
        if (!value || !pattern.test(value)) throw new Error(`${target} missing or unexpected ${header}`);
      }
    }
    const csp = (await fetch(`${base}/`)).headers.get('content-security-policy');
    if (/script-src[^;]*unsafe/.test(csp)) throw new Error('CSP allows unsafe scripts');
    return 'CSP, nosniff, DENY, referrer, permissions';
  });

  await check('the app shell is not cached but static assets are', async () => {
    const base = `http://127.0.0.1:${HTTPS_PORT}`;
    const shell = (await fetch(`${base}/`)).headers.get('cache-control');
    const asset = (await fetch(`${base}/styles.css`)).headers.get('cache-control');
    if (!/no-cache/.test(shell || '')) throw new Error(`shell cache-control was "${shell}"`);
    if (!/max-age/.test(asset || '')) throw new Error(`asset cache-control was "${asset}"`);
    return `shell "${shell}", assets "${asset}"`;
  });

  await check('private endpoints and media stay closed to anonymous requests', async () => {
    const base = `http://127.0.0.1:${HTTPS_PORT}`;
    for (const endpoint of ['/api/feed', '/api/stories', '/api/conversations', '/api/activity', '/api/members', '/api/stickers', '/api/events', '/api/media/1']) {
      const { status } = await fetch(`${base}${endpoint}`);
      if (status !== 401) throw new Error(`${endpoint} returned ${status}, expected 401`);
    }
    return 'all private routes return 401';
  });

  await check('a fresh deployment creates its own data directories', async () => {
    const dbFile = path.join(httpsLikeDir, 'circle.db');
    const uploads = path.join(httpsLikeDir, 'uploads');
    if (!fs.existsSync(dbFile)) throw new Error('database file was not created');
    if (!fs.existsSync(uploads)) throw new Error('upload directory was not created');
    return 'database and upload directory created on first boot';
  });

  await check('the server shuts down cleanly on SIGTERM (container restarts)', async () => {
    const dataDir = path.join(workDir, 'sigterm');
    fs.mkdirSync(dataDir, { recursive: true });
    const port = PORT + 5;
    const child = startServer({ port, dataDir, env: { APP_ORIGIN: `http://127.0.0.1:${port}` } });
    servers.push(child);
    await waitForHttp(`http://127.0.0.1:${port}/api/health`);
    const exit = await new Promise(resolve => {
      const timer = setTimeout(() => resolve({ timedOut: true }), 6000);
      child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
      child.kill('SIGTERM');
    });
    if (exit.timedOut) throw new Error('process ignored SIGTERM and had to be killed');
    return `exited on SIGTERM (code ${exit.code ?? 'null'}, signal ${exit.signal ?? 'none'})`;
  });

  httpsLike.kill('SIGKILL');

  /* ------------------------------------------------------------------ */
  /* Phase 2 — PWA installability and mobile layout in a real browser   */
  /* ------------------------------------------------------------------ */

  const appDir = path.join(workDir, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  const app = startServer({ port: PORT, dataDir: appDir, env: { APP_ORIGIN: BASE } });
  servers.push(app);
  await waitForHttp(`${BASE}/api/health`);

  const chrome = await launchChrome({ debugPort: DEBUG_PORT, profileDir: path.join(workDir, 'chrome') });
  const session = createSession({ debugPort: DEBUG_PORT, screenshotDir: shotDir, onIssue: message => issues.push(message) });

  const page = await session.openPage('phone', BASE);
  await useDevice(page, DEVICES['iPhone 15 Pro']);
  await waitFor(page, "document.querySelector('.auth-card')", { label: 'sign-in screen' });

  await check('Chrome parses the manifest with no installability errors', async () => {
    const manifest = await page.send('Page.getAppManifest');
    if (manifest.errors?.length) throw new Error(manifest.errors.map(error => error.message).join('; '));
    if (!manifest.url) throw new Error('no manifest linked from the shell');
    const parsed = JSON.parse(manifest.data);
    const required = { name: parsed.name, short_name: parsed.short_name, start_url: parsed.start_url, display: parsed.display };
    for (const [field, value] of Object.entries(required)) if (!value) throw new Error(`manifest is missing ${field}`);
    if (parsed.display !== 'standalone') throw new Error(`display is "${parsed.display}", expected standalone`);
    return `${parsed.name} · ${parsed.display} · ${parsed.icons.length} icons`;
  });

  await check('Android install criteria are met (192px and 512px icons, maskable, scope)', async () => {
    const manifest = JSON.parse((await page.send('Page.getAppManifest')).data);
    const sizes = {};
    for (const entry of manifest.icons) {
      if (!entry.src.endsWith('.png')) continue;
      const file = path.resolve('./public', entry.src.replace(/^\//, ''));
      if (!fs.existsSync(file)) throw new Error(`icon file missing: ${entry.src}`);
      const measured = pngSize(file);
      if (`${measured.width}x${measured.height}` !== entry.sizes) throw new Error(`${entry.src} is ${measured.width}x${measured.height} but declares ${entry.sizes}`);
      sizes[entry.sizes] = (sizes[entry.sizes] || 0) + 1;
    }
    if (!sizes['192x192']) throw new Error('a 192x192 PNG icon is required for Android install');
    if (!sizes['512x512']) throw new Error('a 512x512 PNG icon is required for Android install');
    if (!manifest.icons.some(entry => (entry.purpose || '').includes('maskable'))) throw new Error('a maskable icon is required for a clean Android launcher icon');
    if (manifest.scope !== '/' || manifest.start_url !== '/') throw new Error('scope and start_url should both be "/"');
    const reachable = await fetch(`${BASE}${manifest.start_url}`);
    if (!reachable.ok) throw new Error('start_url is not reachable');
    return `icons ${Object.keys(sizes).join(', ')} + maskable`;
  });

  await check('iPhone home-screen install metadata is present', async () => {
    const meta = await evaluate(page, `
      const get = name => (document.querySelector('meta[name="' + name + '"]') || {}).content || null;
      return {
        capable: get('apple-mobile-web-app-capable'),
        statusBar: get('apple-mobile-web-app-status-bar-style'),
        title: get('apple-mobile-web-app-title'),
        viewport: get('viewport'),
        themeColor: get('theme-color'),
        touchIcon: (document.querySelector('link[rel="apple-touch-icon"]') || {}).getAttribute?.('href') || null
      };`);
    if (meta.capable !== 'yes') throw new Error('apple-mobile-web-app-capable must be "yes" for iOS standalone mode');
    if (!meta.touchIcon) throw new Error('apple-touch-icon link is missing');
    if (!/viewport-fit=cover/.test(meta.viewport || '')) throw new Error('viewport must include viewport-fit=cover for iPhone safe areas');
    const touchIconFile = path.resolve('./public', meta.touchIcon.replace(/^\//, ''));
    if (!fs.existsSync(touchIconFile)) throw new Error(`apple-touch-icon file missing: ${meta.touchIcon}`);
    const measured = pngSize(touchIconFile);
    if (measured.width !== 180) throw new Error(`apple-touch-icon should be 180x180, found ${measured.width}x${measured.height}`);
    return `capable=${meta.capable}, status bar=${meta.statusBar}, icon ${measured.width}px`;
  });

  await check('the service worker registers, controls the page, and has a fetch handler', async () => {
    await fill(page, '#setupCode', SETUP_CODE);
    await fill(page, '#username', 'mara');
    await fill(page, '#displayName', 'Mara Quinn');
    await fill(page, '#password', 'deployment-pass-1');
    await click(page, '.auth-card button[type="submit"]');
    await waitFor(page, "document.querySelector('.tabbar')", { label: 'app shell' });

    const state = await evaluate(page, `
      const registration = await navigator.serviceWorker.ready;
      return { scope: registration.scope, active: Boolean(registration.active) };`);
    if (!state.active) throw new Error('no active service worker');

    await reload(page);
    const controlled = await evaluate(page, `
      for (let attempt = 0; attempt < 30 && !navigator.serviceWorker.controller; attempt += 1) await new Promise(r => setTimeout(r, 100));
      return Boolean(navigator.serviceWorker.controller);`);
    if (!controlled) throw new Error('page is not controlled by the service worker after reload');
    const workerSource = await (await fetch(`${BASE}/sw.js`)).text();
    if (!/addEventListener\('fetch'/.test(workerSource)) throw new Error('service worker has no fetch handler (required for installability)');
    return `scope ${state.scope}, controlling after reload`;
  });

  await check('the app opens offline and shows a clear error state instead of a blank screen', async () => {
    await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await page.send('Page.reload', { ignoreCache: false });
    await sleep(1200);
    const offline = await evaluate(page, `
      await new Promise(resolve => setTimeout(resolve, 800));
      return { html: document.body.innerHTML.length, hasShell: Boolean(document.querySelector('.splash, .auth-card, .tabbar, .toast, .offline-screen')),
               text: document.body.innerText.slice(0, 120) };`);
    await page.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    if (!offline.hasShell || offline.html < 100) throw new Error('offline reload produced a blank page');
    await screenshot(page, '20-offline-shell', shotDir);
    await page.send('Page.reload', { ignoreCache: false });
    await waitFor(page, "document.querySelector('.tabbar')", { label: 'recovery after reconnect' });
    return 'cached shell renders offline and recovers online';
  });

  await check('no layout overflows horizontally on any supported phone width', async () => {
    const overflows = [];
    for (const [name, device] of Object.entries(DEVICES)) {
      await useDevice(page, device);
      await sleep(250);
      for (const [label, route] of [['chats', '/'], ['feed', '/feed'], ['activity', '/activity'], ['settings', '/settings']]) {
        await evaluate(page, `history.replaceState({depth:0}, '', ${JSON.stringify(route)}); dispatchEvent(new PopStateEvent('popstate')); return true;`);
        await sleep(250);
        const measurement = await evaluate(page, `
          const doc = document.documentElement;
          const widest = [...document.querySelectorAll('body *')]
            .filter(node => getComputedStyle(node).display !== 'none')
            .map(node => ({ tag: node.tagName + (node.className && typeof node.className === 'string' ? '.' + node.className.split(' ')[0] : ''), right: Math.round(node.getBoundingClientRect().right) }))
            .sort((a, b) => b.right - a.right)[0];
          return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth, widest };`);
        if (measurement.scrollWidth > measurement.clientWidth + 1) {
          overflows.push(`${name}/${label}: ${measurement.scrollWidth}>${measurement.clientWidth} (${measurement.widest?.tag})`);
        }
      }
    }
    if (overflows.length) throw new Error(overflows.join('; '));
    return `${Object.keys(DEVICES).length} viewports × 4 tabs clean`;
  });

  await check('primary touch targets meet the 44px minimum', async () => {
    await useDevice(page, DEVICES['iPhone SE']);
    await evaluate(page, "history.replaceState({depth:0}, '', '/'); dispatchEvent(new PopStateEvent('popstate')); return true;");
    await sleep(300);
    const small = await evaluate(page, `
      const targets = [...document.querySelectorAll('.tab-item, .topbar .icon-button, .fab')];
      return targets.map(node => {
        const rect = node.getBoundingClientRect();
        return { label: node.dataset.name || node.dataset.action || node.className, width: Math.round(rect.width), height: Math.round(rect.height) };
      }).filter(item => item.height > 0 && item.width > 0 && (item.height < 44 || item.width < 44));`);
    if (small.length) throw new Error(small.map(item => `${item.label} ${item.width}x${item.height}`).join(', '));
    return 'navigation, top bars, and compose action are at least 44px';
  });

  await check('the chat composer stays reachable when the on-screen keyboard is open', async () => {
    const conversations = await evaluate(page, `
      const status = await (await fetch('/api/auth/status', { credentials: 'same-origin' })).json();
      const response = await fetch('/api/conversations', { credentials: 'same-origin', headers: { 'x-csrf-token': status.csrfToken } });
      const data = await response.json();
      return data.conversations.map(item => item.id);`);
    await evaluate(page, "history.replaceState({depth:0}, '', '/'); dispatchEvent(new PopStateEvent('popstate')); return true;");
    await waitFor(page, `document.querySelector('[data-open="${conversations[0]}"]')`, { label: 'conversation list' });
    await click(page, `[data-open="${conversations[0]}"]`);
    await waitFor(page, "document.querySelector('.chat-composer')", { label: 'composer' });

    // Emulate the viewport shrinking the way a phone keyboard does.
    await page.send('Emulation.setDeviceMetricsOverride', { ...DEVICES['iPhone SE'], height: 330 });
    await sleep(400);
    const layout = await evaluate(page, `
      const composer = document.querySelector('.chat-composer').getBoundingClientRect();
      const messages = document.querySelector('.messages').getBoundingClientRect();
      return { composerBottom: Math.round(composer.bottom), viewport: window.innerHeight,
               composerVisible: composer.bottom <= window.innerHeight + 1, messagesHeight: Math.round(messages.height) };`);
    await useDevice(page, DEVICES['iPhone SE']);
    if (!layout.composerVisible) throw new Error(`composer bottom ${layout.composerBottom} exceeds viewport ${layout.viewport}`);
    if (layout.messagesHeight < 40) throw new Error('message list collapsed completely');
    await screenshot(page, '21-chat-keyboard', shotDir);
    return `composer visible with a ${layout.viewport}px viewport`;
  });

  await check('a redeployed asset reaches the browser instead of a stale cached copy', async () => {
    // Simulates "you deployed a fix": the file changes on disk while a client already has it cached.
    fs.writeFileSync(probeFile, 'export const build = "before";\n');
    const first = await evaluate(page, `
      const module = await import('/__deploy-probe.js?first');
      return module.build;`);
    if (first !== 'before') throw new Error('probe asset did not load');

    fs.writeFileSync(probeFile, 'export const build = "after";\n');
    await evaluate(page, "history.pushState({}, '', '/'); return true;");
    await page.send('Page.reload', { ignoreCache: false });
    await waitFor(page, "document.querySelector('.tabbar')", { label: 'shell after redeploy' });
    const served = await evaluate(page, `
      const response = await fetch('/__deploy-probe.js');
      return (await response.text()).includes('after') ? 'fresh' : 'stale';`);
    if (served !== 'fresh') throw new Error('the service worker served the old asset after a redeploy');
    return 'updated assets are picked up after reload';
  });

  await check('one member failing to sign in does not lock out the others', async () => {
    // Behind a hosting proxy every request shares one source IP, so throttling must be per account.
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await fetch(`${BASE}/api/auth/login`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'mara', password: `wrong-${attempt}` })
      });
    }
    const victim = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'mara', password: 'deployment-pass-1' })
    });
    if (victim.status !== 429) throw new Error(`the attacked account was not throttled (${victim.status})`);

    const other = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'someone-else', password: 'whatever-long-pass' })
    });
    if (other.status === 429) throw new Error('a second member was locked out by another account\'s failed logins');
    return 'throttling is per account, not per shared proxy IP';
  });

  await check('the container entrypoint prepares a mounted volume before dropping privileges', async () => {
    // Container volumes arrive root-owned, so a non-root process cannot create the database
    // unless ownership is fixed first. Verify both the contract and that the script runs.
    const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
    if (!/su-exec/.test(dockerfile)) throw new Error('Dockerfile must install su-exec to drop privileges');
    if (!/ENTRYPOINT \["\/app\/docker-entrypoint\.sh"\]/.test(dockerfile)) throw new Error('Dockerfile does not use docker-entrypoint.sh');
    const script = fs.readFileSync('docker-entrypoint.sh', 'utf8');
    for (const fragment of ['mkdir -p', 'chown -R node:node', 'exec su-exec node']) {
      if (!script.includes(fragment)) throw new Error(`entrypoint is missing "${fragment}"`);
    }
    if (!(fs.statSync('docker-entrypoint.sh').mode & 0o111)) throw new Error('docker-entrypoint.sh is not executable');

    // Created outside the 0700 work directory so the unprivileged test user can traverse into it.
    const volumeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-volume-'));
    volumeDirs.push(volumeRoot);
    fs.chmodSync(volumeRoot, 0o777);
    const outcome = await new Promise(resolve => {
      const child = spawn('./docker-entrypoint.sh', ['sh', '-c', 'echo entrypoint-ran'], {
        env: {
          PATH: process.env.PATH,
          DATABASE_PATH: path.join(volumeRoot, 'circle.db'),
          UPLOAD_DIR: path.join(volumeRoot, 'uploads')
        },
        // Run unprivileged so the script takes its pass-through branch on this machine.
        ...(process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {}),
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', data => { stdout += data; });
      child.stderr.on('data', data => { stderr += data; });
      child.on('error', error => resolve({ code: -1, stderr: error.message, stdout }));
      child.on('exit', code => resolve({ code, stdout, stderr }));
    });
    if (outcome.code !== 0) throw new Error(`entrypoint failed: ${outcome.stderr.trim() || outcome.code}`);
    if (!outcome.stdout.includes('entrypoint-ran')) throw new Error('entrypoint did not exec the server command');
    if (!fs.existsSync(path.join(volumeRoot, 'uploads'))) throw new Error('entrypoint did not create the upload directory');
    return 'creates volume directories, then execs the server as a non-root user';
  });

  await check('deployment files needed for hosting are present and consistent', async () => {
    const missing = ['Dockerfile', '.dockerignore', 'fly.toml', 'docker-entrypoint.sh', '.env.example', 'README.md', 'docs/DEPLOYMENT.md'].filter(file => !fs.existsSync(path.resolve(file)));
    if (missing.length) throw new Error(`missing: ${missing.join(', ')}`);
    const dockerfile = fs.readFileSync('Dockerfile', 'utf8');
    if (!/node:2[2-9]/.test(dockerfile)) throw new Error('Dockerfile must pin Node 22 or newer');
    if (!/src\/server\.js/.test(dockerfile)) throw new Error('Dockerfile does not start the server');
    const ignore = fs.readFileSync('.dockerignore', 'utf8');
    for (const entry of ['.env', 'data', '.git']) if (!ignore.includes(entry)) throw new Error(`.dockerignore should exclude ${entry}`);
    return 'Dockerfile, .dockerignore, fly.toml';
  });

  await check('every environment variable the code reads is documented', async () => {
    const sources = ['src/config.js'];
    const used = new Set();
    for (const file of sources) {
      const text = fs.readFileSync(file, 'utf8');
      for (const match of text.matchAll(/process\.env\.([A-Z0-9_]+)/g)) used.add(match[1]);
    }
    const example = fs.readFileSync('.env.example', 'utf8');
    const readme = fs.readFileSync('README.md', 'utf8');
    const undocumented = [...used].filter(name => !example.includes(name) || !readme.includes(name));
    if (undocumented.length) throw new Error(`not documented in both .env.example and README: ${undocumented.join(', ')}`);
    return `${used.size} variables documented`;
  });

  await check('README commands exist in package.json exactly as written', async () => {
    const scripts = JSON.parse(fs.readFileSync('package.json', 'utf8')).scripts;
    const readme = fs.readFileSync('README.md', 'utf8');
    const referenced = [...readme.matchAll(/`npm (?:run )?([a-z:]+)`/g)].map(match => match[1]).filter(name => name !== 'install');
    const missing = [...new Set(referenced)].filter(name => !(name in scripts));
    if (missing.length) throw new Error(`README references missing scripts: ${missing.join(', ')}`);
    if (/--watch/.test(scripts.start)) throw new Error('npm start must not use --watch in production');
    return `start="${scripts.start}"`;
  });

  await check('no uncaught errors or security warnings were logged', () => {
    const relevant = issues.filter(issue => !/ExperimentalWarning|SQLite is an experimental|Circle is ready|Maintenance:/.test(issue));
    if (relevant.length) throw new Error(relevant.slice(0, 4).join(' | '));
    return 'clean logs';
  });

  page.close();
  chrome.kill('SIGKILL');
} catch (error) {
  report('deployment audit harness', false, error.message);
} finally {
  shutdownAll();
  fs.rmSync(probeFile, { force: true });
  for (const dir of volumeDirs) fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${results.filter(result => result.ok).length}/${results.length} deployment checks passed`);
fs.rmSync(workDir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
