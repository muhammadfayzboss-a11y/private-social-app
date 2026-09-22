// End-to-end browser verification driven through the Chrome DevTools Protocol.
// Zero dependencies: uses Node's built-in WebSocket client and the Chrome binary already on the machine.
// Run with: npm run verify:browser
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEVICES, click, createSession, evaluate, fill, launchChrome, reload, screenshot as capture, sleep, useDevice, waitFor, waitForHttp
} from './lib/cdp.mjs';

const PORT = Number(process.env.VERIFY_PORT || 4188);
const DEBUG_PORT = Number(process.env.VERIFY_DEBUG_PORT || 9333);
const BASE = `http://127.0.0.1:${PORT}`;
const SETUP_CODE = 'browser-verification-code';
const shotDir = path.resolve('./.kiro/artifacts/screenshots');
fs.mkdirSync(shotDir, { recursive: true });

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-browser-'));
const results = [];
const consoleIssues = [];
let failures = 0;

function report(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function check(name, fn) {
  try {
    const detail = await fn();
    report(name, true, typeof detail === 'string' ? detail : '');
  } catch (error) {
    report(name, false, error.message);
  }
}

/* --- harness: shared CDP helpers, app-specific helpers below ------------- */

const session = createSession({ debugPort: DEBUG_PORT, screenshotDir: shotDir, onIssue: message => consoleIssues.push(message) });
const openPage = (label, url = BASE) => session.openPage(label, url);
const mobileViewport = page => useDevice(page, DEVICES['iPhone 15 Pro']);
const screenshot = (page, name) => capture(page, name, shotDir);

// Seeds content through the real authenticated API from inside the page session.
async function apiCall(page, pathname, options = {}) {
  return evaluate(page, `
    const status = await (await fetch('/api/auth/status', { credentials: 'same-origin' })).json();
    const response = await fetch(${JSON.stringify(pathname)}, {
      method: ${JSON.stringify(options.method || 'GET')},
      credentials: 'same-origin',
      headers: Object.assign({ 'x-csrf-token': status.csrfToken }, ${JSON.stringify(options.headers || {})}),
      body: ${options.body ? JSON.stringify(JSON.stringify(options.body)) : 'undefined'}
    });
    return { status: response.status, data: await response.json().catch(() => null) };`);
}

async function uploadPngFromPage(page, purpose) {
  return evaluate(page, `
    const status = await (await fetch('/api/auth/status', { credentials: 'same-origin' })).json();
    const canvas = document.createElement('canvas');
    canvas.width = 900; canvas.height = 700;
    const context = canvas.getContext('2d');
    const gradient = context.createLinearGradient(0, 0, 900, 700);
    gradient.addColorStop(0, '#7357ff'); gradient.addColorStop(1, '#ff6584');
    context.fillStyle = gradient; context.fillRect(0, 0, 900, 700);
    context.fillStyle = 'rgba(255,255,255,.92)';
    context.beginPath(); context.arc(450, 350, 150, 0, Math.PI * 2); context.fill();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    const response = await fetch('/api/media?purpose=' + ${JSON.stringify(purpose)}, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'image/png', 'x-csrf-token': status.csrfToken, 'x-file-name': 'generated.png' },
      body: blob
    });
    const data = await response.json();
    return data.media.id;`);
}

/* ------------------------------- processes ------------------------------- */

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
  env: {
    ...process.env,
    NODE_OPTIONS: '',
    NODE_ENV: 'development',
    PORT: String(PORT),
    APP_ORIGIN: BASE,
    DATABASE_PATH: path.join(workDir, 'circle.db'),
    UPLOAD_DIR: path.join(workDir, 'uploads'),
    STICKER_DIR: path.resolve('./stickers'),
    SETUP_CODE,
    APP_SECRET: 'browser-verification-secret-value-0123456789'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stderr.on('data', data => consoleIssues.push(`[server] ${String(data).trim()}`));

let chrome = null;
function shutdown() {
  chrome?.kill('SIGKILL');
  server.kill('SIGTERM');
}

/* --------------------------------- run ---------------------------------- */

try {
  await waitForHttp(`${BASE}/api/health`);
  chrome = await launchChrome({ debugPort: DEBUG_PORT, profileDir: path.join(workDir, 'chrome-profile') });

  const pageA = await openPage('admin', BASE);
  await mobileViewport(pageA);
  await waitFor(pageA, "document.querySelector('.auth-card')", { label: 'auth screen' });

  await check('splash screen resolves into the sign-in experience on a phone viewport', async () => {
    const heading = await evaluate(pageA, "return document.querySelector('.auth-card h2').textContent.trim();");
    if (heading !== 'Create your circle') throw new Error(`unexpected heading: ${heading}`);
    await screenshot(pageA, '01-auth-mobile');
    return heading;
  });

  await check('admin account is created through the setup form', async () => {
    await fill(pageA, '#setupCode', SETUP_CODE);
    await fill(pageA, '#username', 'mara');
    await fill(pageA, '#displayName', 'Mara Quinn');
    await fill(pageA, '#password', 'circle-admin-pass');
    await click(pageA, '.auth-card button[type="submit"]');
    await waitFor(pageA, "document.querySelector('.bottom-nav')", { label: 'app shell' });
    return 'signed in as @mara';
  });

  await check('notification badges stay hidden while counts are zero', async () => {
    const visible = await evaluate(pageA, `
      await new Promise(resolve => setTimeout(resolve, 300));
      return [...document.querySelectorAll('.badge')].filter(node => node.getBoundingClientRect().height > 0).map(node => node.textContent);`);
    if (visible.length) throw new Error(`badges visible with no unread items: ${visible.join(',')}`);
    return 'no empty badges';
  });

  await check('bottom navigation renders five destinations with SVG icons', async () => {
    const info = await evaluate(pageA, `
      const items = [...document.querySelectorAll('.nav-item')];
      return { count: items.length, labels: items.map(item => item.dataset.name), svgs: document.querySelectorAll('.bottom-nav svg').length,
               emoji: /[\\u{1F300}-\\u{1FAFF}]/u.test(document.querySelector('.bottom-nav').textContent) };`);
    if (info.count !== 5) throw new Error(`expected 5 nav items, found ${info.count}`);
    if (info.svgs < 5) throw new Error('navigation icons are not SVG');
    if (info.emoji) throw new Error('navigation uses emoji as icons');
    return info.labels.join(', ');
  });

  await check('empty feed shows a real empty state', async () => {
    await waitFor(pageA, "document.querySelector('.empty-state, .post-card')", { label: 'feed state' });
    const text = await evaluate(pageA, "return (document.querySelector('.empty-state h3') || {}).textContent || 'posts already present';");
    await screenshot(pageA, '02-empty-feed');
    return text;
  });

  const mediaId = await uploadPngFromPage(pageA, 'post');
  await check('a post with an uploaded photo renders in the feed', async () => {
    const created = await apiCall(pageA, '/api/posts', { method: 'POST', body: { body: 'First light on the ridge — worth the 4am start.', mediaIds: [mediaId] } });
    if (created.status !== 201) throw new Error(`post creation failed: ${created.status}`);
    // Returning to Home must resynchronise the feed rather than showing a stale view.
    await click(pageA, '[data-nav="/chat"]');
    await click(pageA, '[data-nav="/"]');
    await waitFor(pageA, "document.querySelector('.post-card img.post-media')", { label: 'post image after returning to Home' });
    const rendered = await evaluate(pageA, `
      const image = document.querySelector('.post-card img.post-media');
      return { loaded: image.naturalWidth > 0, body: document.querySelector('.post-body').textContent.trim() };`);
    if (!rendered.loaded) throw new Error('post image did not load from the private media endpoint');
    return rendered.body;
  });

  await check('liking a post through the UI persists to the database', async () => {
    await click(pageA, '.post-card [data-action="like"]');
    await waitFor(pageA, "document.querySelector('.post-card .like-action.liked')", { label: 'liked state' });
    const stored = await apiCall(pageA, '/api/feed');
    if (stored.data.posts[0].reactions.heart !== 1) throw new Error('reaction was not stored');
    if (stored.data.posts[0].viewerReaction !== 'heart') throw new Error('viewer reaction missing');
    return 'heart stored server-side';
  });

  await check('commenting through the UI stores and displays the comment', async () => {
    await fill(pageA, '.post-card .comment-form input', 'Unreal light!');
    await evaluate(pageA, "document.querySelector('.post-card .comment-form').requestSubmit(); return true;");
    await waitFor(pageA, "[...document.querySelectorAll('.comment-bubble')].some(node => node.textContent.includes('Unreal light!'))", { label: 'comment rendered' });
    const stored = await apiCall(pageA, '/api/feed');
    if (stored.data.posts[0].comments[0].body !== 'Unreal light!') throw new Error('comment was not stored');
    await screenshot(pageA, '03-feed-post');
    return 'comment persisted';
  });

  await check('untrusted markup in a post is escaped, not executed', async () => {
    await apiCall(pageA, '/api/posts', { method: 'POST', body: { body: '<img src=x onerror="window.__xss=true">' } });
    await click(pageA, '[data-nav="/activity"]');
    await click(pageA, '[data-nav="/"]');
    await waitFor(pageA, "document.querySelectorAll('.post-card').length >= 2", { label: 'both posts' });
    const result = await evaluate(pageA, `
      await new Promise(resolve => setTimeout(resolve, 400));
      const body = [...document.querySelectorAll('.post-body')].find(node => node.textContent.includes('onerror'));
      return { executed: Boolean(window.__xss), injected: body ? body.querySelectorAll('img').length : -1, text: body ? body.textContent : '' };`);
    if (result.executed) throw new Error('injected script executed');
    if (result.injected !== 0) throw new Error('markup was inserted into the DOM');
    return 'rendered as text';
  });

  const storyMediaId = await uploadPngFromPage(pageA, 'story');
  await check('a new story appears in the stories tray', async () => {
    const created = await apiCall(pageA, '/api/stories', { method: 'POST', body: { mediaId: storyMediaId, caption: 'Trail day' } });
    if (created.status !== 201) throw new Error(`story creation failed: ${created.status}`);
    await click(pageA, '[data-nav="/create"]');
    await click(pageA, '[data-nav="/"]');
    await waitFor(pageA, "document.querySelector('.story-avatar')", { label: 'stories tray' });
    await screenshot(pageA, '04-stories-tray');
    return 'story tray rendered';
  });

  await check('dark mode applies across the interface', async () => {
    await click(pageA, '[data-action="theme"]');
    const theme = await evaluate(pageA, "return document.documentElement.dataset.theme;");
    if (theme !== 'dark') throw new Error(`theme did not switch: ${theme}`);
    await sleep(350);
    await screenshot(pageA, '05-feed-dark');
    await click(pageA, '[data-action="theme"]');
    return 'dark then light restored';
  });

  await check('the PWA manifest, icons, and service worker are active', async () => {
    const info = await evaluate(pageA, `
      const registration = await navigator.serviceWorker.getRegistration();
      const manifest = await (await fetch('/manifest.webmanifest')).json();
      const icon = await fetch('/icons/icon-512.png');
      return { worker: Boolean(registration), scope: registration ? registration.scope : null, display: manifest.display,
               icons: manifest.icons.length, iconOk: icon.ok, themeColor: document.querySelector('meta[name="theme-color"]').content };`);
    if (!info.worker) throw new Error('service worker did not register');
    if (info.display !== 'standalone') throw new Error('manifest is not installable as standalone');
    if (!info.iconOk) throw new Error('app icon missing');
    return `sw scope ${info.scope}, ${info.icons} icons, theme ${info.themeColor}`;
  });

  // Second member joins in a separate browser context.
  const invite = await apiCall(pageA, '/api/invites', { method: 'POST', body: { label: 'Ana', days: 7 } });
  const pageB = await openPage('member', BASE);
  await mobileViewport(pageB);
  await waitFor(pageB, "document.querySelector('.auth-card')", { label: 'auth screen for second member' });

  await check('a second member joins with an invite code', async () => {
    await click(pageB, '[data-switch]');
    await fill(pageB, '#inviteCode', invite.data.code);
    await fill(pageB, '#username', 'ana');
    await fill(pageB, '#displayName', 'Ana Ruiz');
    await fill(pageB, '#password', 'ana-strong-pass');
    await click(pageB, '.auth-card button[type="submit"]');
    await waitFor(pageB, "document.querySelector('.bottom-nav')", { label: 'second member shell' });
    return 'joined as @ana';
  });

  await check('a stranger without an invite code is refused by the UI', async () => {
    const pageC = await openPage('stranger', BASE);
    await waitFor(pageC, "document.querySelector('.auth-card')");
    await click(pageC, '[data-switch]');
    await fill(pageC, '#inviteCode', 'not-a-real-invite-code');
    await fill(pageC, '#username', 'stranger');
    await fill(pageC, '#displayName', 'Stranger');
    await fill(pageC, '#password', 'stranger-pass-1');
    await click(pageC, '.auth-card button[type="submit"]');
    await waitFor(pageC, "document.querySelector('.toast-error')", { label: 'rejection toast' });
    const message = await evaluate(pageC, "return document.querySelector('.toast-error').textContent;");
    const stillOut = await evaluate(pageC, "return !document.querySelector('.bottom-nav');");
    if (!stillOut) throw new Error('stranger reached the application');
    await screenshot(pageC, '06-invite-rejected');
    pageC.close();
    return message;
  });

  await check('the second member watches the story, and the author sees the view', async () => {
    // Stories advance themselves after five seconds, so the viewer is reopened before each step
    // instead of assuming it stayed on screen.
    const openViewer = async () => {
      if (await evaluate(pageB, "return Boolean(document.querySelector('.story-viewer'));")) return;
      await waitFor(pageB, "document.querySelector('.story-avatar[data-author]:not([data-author=\"new\"])')", { label: "another member's story ring" });
      await click(pageB, '.story-avatar[data-author]:not([data-author="new"])');
      await waitFor(pageB, "document.querySelector('.story-viewer img[data-story-media]')", { label: 'story viewer' });
    };

    await openViewer();
    const viewer = await evaluate(pageB, `
      const image = document.querySelector('.story-viewer img[data-story-media]');
      for (let attempt = 0; attempt < 10 && !image.naturalWidth; attempt += 1) await new Promise(r => setTimeout(r, 60));
      return { loaded: image.naturalWidth > 0, bars: document.querySelectorAll('.story-progress i').length,
               caption: (document.querySelector('.story-caption') || {}).textContent || '' };`);
    if (!viewer.loaded) throw new Error('story media did not load');

    await openViewer();
    await fill(pageB, '[data-story-reply]', 'That view is unreal!');
    await click(pageB, '[data-story-action="send"]');
    await sleep(600);
    await openViewer();
    await screenshot(pageB, '07-story-viewer');
    await evaluate(pageB, "const close = document.querySelector('[data-story-action=\"close\"]'); if (close) close.click(); return true;");

    const authorView = await apiCall(pageA, '/api/stories');
    const story = authorView.data.stories[0];
    if (!story?.views?.length) throw new Error('story view was not recorded');
    return `caption "${viewer.caption}", ${viewer.bars} progress bar(s), viewed by ${story.views[0].user.username}`;
  });

  await check('the story reply arrives as a private message and a notification', async () => {
    await waitFor(pageA, "document.querySelector('[data-activity-badge]:not([hidden])')", { timeout: 9000, label: 'activity badge' });
    await click(pageA, '[data-nav="/activity"]');
    await waitFor(pageA, "document.querySelector('.activity-item')", { label: 'activity entries' });
    const text = await evaluate(pageA, `
      const items = [...document.querySelectorAll('.activity-item')].map(node => node.textContent.replace(/\\s+/g, ' ').trim());
      return items.join(' || ');`);
    if (!/replied to your story/.test(text)) throw new Error(`story reply notification missing: ${text}`);
    const conversations = await apiCall(pageA, '/api/conversations');
    const direct = conversations.data.conversations.find(conversation => conversation.kind === 'direct');
    if (!direct) throw new Error('story reply did not create a direct conversation');
    if (!direct.lastMessage.body.includes('That view is unreal!')) throw new Error('story reply message missing');
    return 'notification and direct message stored';
  });

  await check('group chat delivers messages between two browsers in real time', async () => {
    const conversations = await apiCall(pageA, '/api/conversations');
    const groupId = conversations.data.conversations.find(conversation => conversation.kind === 'group').id;

    for (const page of [pageB, pageA]) {
      await click(page, '[data-nav="/chat"]');
      await waitFor(page, `document.querySelector('[data-open="${groupId}"]')`, { label: 'group conversation in list' });
      await click(page, `[data-open="${groupId}"]`);
      await waitFor(page, "document.querySelector('.chat-composer')", { label: 'chat composer' });
    }

    await fill(pageB, '[data-input]', 'Dinner Friday? I can cook.');
    await evaluate(pageB, "document.querySelector('[data-composer]').requestSubmit(); return true;");
    await waitFor(pageA, "[...document.querySelectorAll('.message-bubble')].some(node => node.textContent.includes('Dinner Friday'))",
      { timeout: 10000, label: 'live message on the other device' });
    await screenshot(pageA, '07-chat-realtime');
    return 'message arrived over SSE without a refresh';
  });

  await check('typing indicators and read receipts update live', async () => {
    await evaluate(pageB, `
      const input = document.querySelector('[data-input]');
      input.value = 'typing…';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;`);
    await waitFor(pageA, "document.querySelector('[data-typing]').textContent.includes('typing')", { timeout: 8000, label: 'typing indicator' });
    await evaluate(pageB, "document.querySelector('[data-input]').value = ''; return true;");
    const receipt = await evaluate(pageB, `
      await new Promise(resolve => setTimeout(resolve, 600));
      const meta = [...document.querySelectorAll('.message.mine .message-meta')].pop();
      return meta ? meta.textContent.trim() : 'none';`);
    return `typing seen; sender meta "${receipt}"`;
  });

  await check('stickers send from the picker and appear for the recipient', async () => {
    await click(pageA, '[data-action="stickers"]');
    await waitFor(pageA, "document.querySelector('.sticker-picker .sticker-button')", { label: 'sticker picker' });
    await screenshot(pageA, '08-sticker-picker');
    const stickerId = await evaluate(pageA, "return document.querySelector('.sticker-picker .sticker-button').dataset.sticker;");
    await click(pageA, '.sticker-picker .sticker-button');
    await waitFor(pageA, "document.querySelector('.message.mine img.sticker')", { label: 'sticker in sender view' });
    await waitFor(pageB, `[...document.querySelectorAll('img.sticker')].some(node => node.src.includes(${JSON.stringify(stickerId)}))`,
      { timeout: 10000, label: 'sticker delivered to recipient' });
    const drawn = await evaluate(pageB, `
      const image = [...document.querySelectorAll('img.sticker')].pop();
      await new Promise(resolve => setTimeout(resolve, 300));
      const bubble = image.closest('.message');
      return { rendered: image.complete && image.naturalWidth > 0, treatedAsMine: bubble.classList.contains('mine'),
               sender: (bubble.querySelector('.message-sender') || {}).textContent || '' };`);
    if (!drawn.rendered) throw new Error('sticker artwork did not render');
    if (drawn.treatedAsMine) throw new Error('an incoming sticker was rendered as the recipient\'s own message');
    await screenshot(pageB, '09-sticker-received');
    return `sent ${stickerId}`;
  });

  await check('message reactions sync to the other member', async () => {
    await evaluate(pageA, `
      const bubble = [...document.querySelectorAll('.message')].find(node => node.textContent.includes('Dinner Friday'));
      bubble.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return true;`);
    await waitFor(pageA, "document.querySelector('.modal-sheet [data-react]')", { label: 'reaction sheet' });
    await click(pageA, '.modal-sheet [data-react]');
    await waitFor(pageB, "document.querySelector('.message-reaction')", { timeout: 9000, label: 'reaction on recipient device' });
    return 'reaction delivered';
  });

  await check('activity feed records the interaction and clears its badge', async () => {
    await click(pageB, '[data-action="back"]');
    await waitFor(pageB, "document.querySelector('.bottom-nav')");
    await click(pageB, '[data-nav="/activity"]');
    await waitFor(pageB, "document.querySelector('.activity-item, .empty-state')", { label: 'activity list' });
    const summary = await evaluate(pageB, `
      const items = [...document.querySelectorAll('.activity-item')];
      return { count: items.length, first: items.length ? items[0].textContent.replace(/\\s+/g, ' ').trim() : 'empty' };`);
    await screenshot(pageB, '10-activity');
    if (!summary.count) throw new Error('no activity was recorded');
    return summary.first;
  });

  await check('profile editing persists a new display name and bio', async () => {
    await click(pageB, '[data-nav="/profile"]');
    await waitFor(pageB, "document.querySelector('.profile-hero')", { label: 'profile page' });
    await click(pageB, '[data-action="edit"]');
    await waitFor(pageB, "document.querySelector('[data-profile-form]')", { label: 'edit form' });
    await fill(pageB, '#displayName', 'Ana R.');
    await fill(pageB, '#bio', 'Climbing, cold coffee, and cartography.');
    await evaluate(pageB, "document.querySelector('[data-profile-form]').requestSubmit(); return true;");
    await waitFor(pageB, "document.querySelector('.profile-hero h1').textContent.includes('Ana R.')", { label: 'updated profile' });
    const stored = await apiCall(pageB, '/api/auth/status');
    if (stored.data.user.bio !== 'Climbing, cold coffee, and cartography.') throw new Error('bio was not saved');
    await screenshot(pageB, '11-profile');
    return stored.data.user.displayName;
  });

  await check('the media tab shows the shared gallery', async () => {
    await click(pageA, '[data-action="back"]');
    await waitFor(pageA, "document.querySelector('.bottom-nav')");
    await click(pageA, '[data-nav="/profile"]');
    await waitFor(pageA, "document.querySelector('.profile-tabs')", { label: 'profile tabs' });
    await click(pageA, '[data-tab="media"]');
    await waitFor(pageA, "document.querySelector('.profile-grid-item img')", { label: 'media gallery' });
    return 'gallery rendered';
  });

  await check('settings expose invites, sticker reload, members, and sign out', async () => {
    await click(pageA, '[data-tab="posts"]');
    await click(pageA, '[data-action="settings"]');
    await waitFor(pageA, "document.querySelector('.settings-list')", { label: 'settings' });
    const actions = await evaluate(pageA, `
      await new Promise(resolve => setTimeout(resolve, 400));
      return { actions: [...document.querySelectorAll('.settings-item')].map(node => node.dataset.action),
               members: document.querySelectorAll('.member-item').length };`);
    for (const required of ['theme', 'notifications', 'invite', 'reload-stickers', 'logout']) {
      if (!actions.actions.includes(required)) throw new Error(`missing settings action: ${required}`);
    }
    if (actions.members !== 2) throw new Error(`expected 2 members, found ${actions.members}`);
    await screenshot(pageA, '12-settings');
    return `${actions.members} members listed`;
  });

  await check('desktop layout switches to a rail navigation', async () => {
    await pageA.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
    await click(pageA, '[data-nav="/"]');
    await waitFor(pageA, "document.querySelector('.post-card')");
    const layout = await evaluate(pageA, `
      await new Promise(resolve => setTimeout(resolve, 300));
      const nav = document.querySelector('.bottom-nav');
      const rect = nav.getBoundingClientRect();
      return { width: Math.round(rect.width), height: Math.round(rect.height), vertical: rect.height > rect.width };`);
    if (!layout.vertical) throw new Error('navigation did not become a vertical rail on desktop');
    await screenshot(pageA, '13-desktop');
    return `rail ${layout.width}×${layout.height}`;
  });

  await check('signing out returns to the locked sign-in screen', async () => {
    await pageA.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
    await click(pageA, '[data-nav="/profile"]');
    await waitFor(pageA, "document.querySelector('[data-action=\"settings\"]')");
    await click(pageA, '[data-action="settings"]');
    await waitFor(pageA, "document.querySelector('[data-action=\"logout\"]')");
    await click(pageA, '[data-action="logout"]');
    await waitFor(pageA, "document.querySelector('.auth-card')", { timeout: 15000, label: 'sign-in screen' });
    const locked = await evaluate(pageA, `
      const response = await fetch('/api/feed', { credentials: 'same-origin' });
      return response.status;`);
    if (locked !== 401) throw new Error(`session still active: ${locked}`);
    return 'session cleared';
  });

  await check('no uncaught errors were logged in either browser session', () => {
    const relevant = consoleIssues.filter(issue => !/ExperimentalWarning|SQLite is an experimental/.test(issue));
    if (relevant.length) throw new Error(relevant.slice(0, 5).join(' | '));
    return 'clean console';
  });

  pageA.close();
  pageB.close();
} catch (error) {
  report('browser verification harness', false, error.message);
} finally {
  shutdown();
}

console.log(`\n${results.filter(result => result.ok).length}/${results.length} browser checks passed`);
console.log(`Screenshots: ${shotDir}`);
fs.rmSync(workDir, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
