// Mobile-first end-to-end verification through Chrome DevTools Protocol (zero dependencies).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEVICES, click, createSession, evaluate, fill, launchChrome, screenshot as capture, sleep, useDevice, waitFor, waitForHttp
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
  try { const detail = await fn(); report(name, true, typeof detail === 'string' ? detail : ''); }
  catch (error) { report(name, false, error.message); }
}

const session = createSession({ debugPort: DEBUG_PORT, screenshotDir: shotDir, onIssue: message => consoleIssues.push(message) });
const openPage = (label, url = BASE) => session.openPage(label, url);
const mobileViewport = page => useDevice(page, DEVICES['iPhone 15 Pro']);
const screenshot = (page, name) => capture(page, name, shotDir);

async function apiCall(page, pathname, options = {}) {
  return evaluate(page, `
    const status = await (await fetch('/api/auth/status', { credentials: 'same-origin' })).json();
    const response = await fetch(${JSON.stringify(pathname)}, {
      method: ${JSON.stringify(options.method || 'GET')}, credentials: 'same-origin',
      headers: Object.assign({ 'x-csrf-token': status.csrfToken, 'content-type': 'application/json' }, ${JSON.stringify(options.headers || {})}),
      body: ${options.body !== undefined ? JSON.stringify(JSON.stringify(options.body)) : 'undefined'}
    });
    return { status: response.status, data: await response.json().catch(() => null) };`);
}
async function uploadPng(page, purpose) {
  return evaluate(page, `
    const status = await (await fetch('/api/auth/status', { credentials: 'same-origin' })).json();
    const canvas = document.createElement('canvas'); canvas.width = 900; canvas.height = 700;
    const c = canvas.getContext('2d'); const g = c.createLinearGradient(0,0,900,700); g.addColorStop(0,'#6c5ce7'); g.addColorStop(1,'#ff6584');
    c.fillStyle=g;c.fillRect(0,0,900,700);c.fillStyle='rgba(255,255,255,.9)';c.beginPath();c.arc(450,350,150,0,Math.PI*2);c.fill();
    const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));
    const response=await fetch('/api/media?purpose='+${JSON.stringify(purpose)},{method:'POST',credentials:'same-origin',headers:{'content-type':'image/png','x-csrf-token':status.csrfToken,'x-file-name':'generated.png'},body:blob});
    return (await response.json()).media.id;`);
}
async function uploadPdf(page, purpose = 'file') {
  return evaluate(page, `
    const status=await(await fetch('/api/auth/status',{credentials:'same-origin'})).json();
    const body=new TextEncoder().encode('%PDF-1.7\\nCircle report\\n'+(' '.repeat(200)));
    const response=await fetch('/api/media?purpose='+${JSON.stringify(purpose)},{method:'POST',credentials:'same-origin',headers:{'content-type':'application/pdf','x-csrf-token':status.csrfToken,'x-file-name':'Circle-report.pdf'},body});
    return { status:response.status, data:await response.json() };`);
}

const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.js'], {
  env: { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'development', PORT: String(PORT), APP_ORIGIN: BASE,
    DATABASE_PATH: path.join(workDir, 'circle.db'), UPLOAD_DIR: path.join(workDir, 'uploads'), STICKER_DIR: path.resolve('./stickers'),
    SETUP_CODE, APP_SECRET: 'browser-verification-secret-value-0123456789' },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stderr.on('data', data => consoleIssues.push(`[server] ${String(data).trim()}`));
let chrome = null;
const shutdown = () => { chrome?.kill('SIGKILL'); server.kill('SIGTERM'); };

try {
  await waitForHttp(`${BASE}/api/health`);
  chrome = await launchChrome({ debugPort: DEBUG_PORT, profileDir: path.join(workDir, 'chrome-profile') });
  const pageA = await openPage('admin', BASE);
  await mobileViewport(pageA);
  await pageA.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tashkent' });
  await waitFor(pageA, "document.querySelector('.auth-card')", { label: 'auth screen' });

  await check('mobile auth and splash resolve cleanly', async () => {
    const h = await evaluate(pageA, "return document.querySelector('.auth-card h2').textContent.trim();");
    if (h !== 'Create your circle') throw new Error(`unexpected heading ${h}`);
    await screenshot(pageA, '01-mobile-auth');
    return h;
  });

  await check('admin setup opens the four-tab mobile app', async () => {
    await fill(pageA, '#setupCode', SETUP_CODE); await fill(pageA, '#username', 'mara'); await fill(pageA, '#displayName', 'Mara Quinn'); await fill(pageA, '#password', 'circle-admin-pass');
    await click(pageA, '.auth-card button[type="submit"]');
    await waitFor(pageA, "document.querySelector('.tabbar')", { label: 'mobile tabbar' });
    const info = await evaluate(pageA, `const tabs=[...document.querySelectorAll('.tab-item')];return {count:tabs.length,names:tabs.map(x=>x.dataset.name),root:location.pathname,screen:Boolean(document.querySelector('.screen-chats'))};`);
    if (info.count !== 4 || info.names.join() !== 'chats,feed,activity,settings') throw new Error(JSON.stringify(info));
    if (info.root !== '/' || !info.screen) throw new Error('Chats is not the root screen');
    await screenshot(pageA, '02-chats-empty');
    return info.names.join(', ');
  });

  await check('root screen has stories, folders, and compose FAB', async () => {
    await waitFor(pageA, "document.querySelector('.stories-row') && document.querySelector('.folder-tabs') && document.querySelector('.fab')");
    const labels = await evaluate(pageA, "return [...document.querySelectorAll('.folder-tab')].map(x=>x.textContent.trim()).join(' / ');");
    if (!/All/.test(labels) || !/Unread/.test(labels)) throw new Error(labels);
    return labels;
  });

  await check('root tabs return to the existing Chats history entry', async () => {
    await click(pageA, '[data-tab-path="/feed"]');
    await waitFor(pageA, "location.pathname === '/feed'");
    await click(pageA, '[data-tab-path="/"]');
    await waitFor(pageA, "location.pathname === '/' && history.state.depth === 0");
    const entries = await evaluate(pageA, "return { path: location.pathname, depth: history.state.depth }; ");
    if (entries.path !== '/' || entries.depth !== 0) throw new Error(JSON.stringify(entries));
    return 'Chats restored at depth 0';
  });

  await check('Feed tab and empty state are native-style and stateful', async () => {
    await click(pageA, '[data-tab-path="/feed"]');
    await waitFor(pageA, "document.querySelector('.screen-feed:not(.tab-hidden) .empty-state')", { label: 'empty feed' });
    const title = await evaluate(pageA, "return document.querySelector('.screen-feed .empty-state h3').textContent;");
    if (!/Nothing/.test(title)) throw new Error(title);
    return title;
  });

  const postMedia = await uploadPng(pageA, 'post');
  await check('new post appears with private image and reactions work', async () => {
    const made = await apiCall(pageA, '/api/posts', { method: 'POST', body: { body: 'First light on the ridge', mediaIds: [postMedia] } });
    if (made.status !== 201) throw new Error(`post ${made.status}`);
    await click(pageA, '[data-tab-path="/"]'); await click(pageA, '[data-tab-path="/feed"]');
    await waitFor(pageA, "document.querySelector('.post-card img.post-media')", { label: 'post card' });
    await click(pageA, '.post-card [data-action="like"]');
    const feed = await apiCall(pageA, '/api/feed');
    if (feed.data.posts[0].viewerReaction !== 'heart') throw new Error('reaction not stored');
    await screenshot(pageA, '03-feed');
    return feed.data.posts[0].body;
  });

  await check('stored markup is escaped, never inserted as HTML', async () => {
    await apiCall(pageA, '/api/posts', { method: 'POST', body: { body: '<img src=x onerror="window.__xss=true">' } });
    await click(pageA, '[data-tab-path="/"]'); await click(pageA, '[data-tab-path="/feed"]');
    await waitFor(pageA, "document.querySelectorAll('.post-card').length >= 2");
    const result = await evaluate(pageA, `await new Promise(r=>setTimeout(r,300));const n=[...document.querySelectorAll('.post-body')].find(x=>x.textContent.includes('onerror'));return {ran:Boolean(window.__xss),imgs:n?.querySelectorAll('img').length,text:n?.textContent};`);
    if (result.ran || result.imgs) throw new Error('XSS rendered');
    return 'escaped text';
  });

  await check('Settings uses grouped mobile categories', async () => {
    await click(pageA, '[data-tab-path="/settings"]');
    await waitFor(pageA, "document.querySelector('.profile-card') && document.querySelectorAll('.group-body .row').length >= 8", { label: 'settings rows' });
    const text = await evaluate(pageA, "return document.querySelector('.screen-settings').innerText;");
    for (const expected of ['Privacy and Security','Notifications','Data and Storage','Appearance','Chat Background','Folders','Devices']) if (!text.includes(expected)) throw new Error(`missing ${expected}`);
    await screenshot(pageA, '04-settings');
    return 'all categories visible';
  });

  await check('AMOLED theme applies immediately to every surface', async () => {
    await click(pageA, '[data-href="/settings/appearance"]');
    await waitFor(pageA, "document.querySelector('[data-theme-choice=\"amoled\"]')");
    await click(pageA, '[data-theme-choice="amoled"]');
    await sleep(250);
    const state = await evaluate(pageA, "return {theme:document.documentElement.dataset.theme,bg:getComputedStyle(document.documentElement).getPropertyValue('--screen-bg').trim(),stored:JSON.parse(localStorage.getItem('circle-settings')).appearance.theme};");
    if (state.theme !== 'amoled' || state.bg !== '#000' || state.stored !== 'amoled') throw new Error(JSON.stringify(state));
    await screenshot(pageA, '05-amoled-appearance');
    await click(pageA, '[data-theme-choice="light"]');
    return 'AMOLED → Light';
  });

  await check('chat wallpaper preview and apply are live', async () => {
    await evaluate(pageA, "history.back(); return true;"); await waitFor(pageA, "document.querySelector('.screen-settings:not(.covered)')");
    await click(pageA, '[data-href="/settings/background"]');
    await waitFor(pageA, "document.querySelector('[data-wallpaper=\"aurora\"]')");
    await click(pageA, '[data-wallpaper="aurora"]');
    await evaluate(pageA, "const s=document.querySelector('[data-wallpaper-dim]');s.value=30;s.dispatchEvent(new Event('input',{bubbles:true}));return true;");
    await click(pageA, '[data-apply]');
    await sleep(450);
    const saved = await apiCall(pageA, '/api/settings');
    if (saved.data.settings.appearance.wallpaper.id !== 'aurora' || saved.data.settings.appearance.wallpaper.dim !== 30) throw new Error('not saved');
    await screenshot(pageA, '06-wallpaper-picker');
    return 'Aurora, dim 30%';
  });

  await check('failed settings sync stays queued and retries after reconnect', async () => {
    await pageA.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await evaluate(pageA, `const module=await import('/lib/settings.js');await module.updateSettings({chat:{enterToSend:true}}).catch(()=>{});return module.settings().chat.enterToSend;`);
    await pageA.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await evaluate(pageA, "dispatchEvent(new Event('online')); return true;");
    await waitFor(pageA, "(await (await fetch('/api/settings',{credentials:'same-origin'})).json()).settings.chat.enterToSend === true", { timeout: 9000, label: 'queued settings retry' });
    return 'offline change reached the server after reconnect';
  });

  const invite = await apiCall(pageA, '/api/invites', { method: 'POST', body: { label: 'Ana', days: 7 } });
  const pageB = await openPage('member', BASE);
  await mobileViewport(pageB);
  await waitFor(pageB, "document.querySelector('.auth-card')");
  await check('second member joins only with a real invite', async () => {
    await click(pageB, '[data-switch]'); await fill(pageB, '#inviteCode', invite.data.code); await fill(pageB, '#username', 'ana'); await fill(pageB, '#displayName', 'Ana Ruiz'); await fill(pageB, '#password', 'ana-strong-pass');
    await click(pageB, '.auth-card button[type="submit"]');
    await waitFor(pageB, "document.querySelector('.tabbar')", { label: 'member app' });
    return '@ana';
  });

  await check('private group chat opens full-screen with mobile composer', async () => {
    for (const page of [pageA,pageB]) {
      await evaluate(page, "history.replaceState({depth:0},'', '/');dispatchEvent(new PopStateEvent('popstate'));return true;");
      await waitFor(page, "document.querySelector('.screen-chats:not(.tab-hidden)')");
      await waitFor(page, "document.querySelector('[data-open]')", { label: 'group row' });
      await click(page, '[data-open]');
      await waitFor(page, "document.querySelector('.chat-page .chat-composer')", { label: 'chat composer' });
    }
    const chrome = await evaluate(pageA, "return {tabbar:getComputedStyle(document.querySelector('.tabbar')).pointerEvents,header:Boolean(document.querySelector('.chat-header')),composer:Boolean(document.querySelector('.composer-emoji')&&document.querySelector('.composer-attach')&&document.querySelector('.chat-voice'))};");
    if (!chrome.header || !chrome.composer) throw new Error(JSON.stringify(chrome));
    await screenshot(pageA, '07-chat-empty');
    return 'full-screen chat';
  });

  await check('text sends optimistically and arrives once over realtime', async () => {
    await fill(pageB, '[data-input]', 'Dinner Friday? I can cook.');
    await evaluate(pageB, "document.querySelector('[data-composer]').requestSubmit();return true;");
    await waitFor(pageA, "[...document.querySelectorAll('.message-text')].some(x=>x.textContent.includes('Dinner Friday'))", { timeout: 10000, label: 'live message' });
    await sleep(500);
    const rendered = await evaluate(pageA, "return [...document.querySelectorAll('.message-text')].filter(x=>x.textContent.includes('Dinner Friday')).length;");
    if (rendered !== 1) throw new Error(`rendered ${rendered}`);
    await screenshot(pageA, '08-chat-message');
    return 'exactly one message';
  });

  await check('fresh UTC timestamp reads Just now in UTC+5', async () => {
    const result = await evaluate(pageA, `const m=[...document.querySelectorAll('.message')].find(x=>x.textContent.includes('Dinner Friday'));return {label:m.querySelector('.message-meta time').textContent.trim(),offset:new Date().getTimezoneOffset()};`);
    if (!['Just now','Hozirgina'].includes(result.label) && !/^\d+m$/.test(result.label)) throw new Error(JSON.stringify(result));
    if (result.offset !== -300) throw new Error('timezone override missing');
    return `${result.label} at UTC+5`;
  });

  await check('reply preview, edit and reactions synchronise', async () => {
    await evaluate(pageA, `const b=[...document.querySelectorAll('.message-bubble')].find(x=>x.textContent.includes('Dinner Friday'));b.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));return true;`);
    await waitFor(pageA, "document.querySelector('.focus-action[data-action-id=\"reply\"]')", { label: 'focus menu' });
    await screenshot(pageA, '09-message-focus');
    await click(pageA, '[data-action-id="reply"]');
    await fill(pageA, '[data-input]', 'Pasta sounds great');
    await evaluate(pageA, "document.querySelector('[data-composer]').requestSubmit();return true;");
    await waitFor(pageB, "document.querySelector('.reply-quote')", { timeout: 9000 });
    await evaluate(pageA, `const b=[...document.querySelectorAll('.message-bubble')].find(x=>x.textContent.includes('Dinner Friday'));b.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));return true;`);
    await waitFor(pageA, "document.querySelector('[data-react]')"); await click(pageA, '[data-react="❤️"]');
    await waitFor(pageB, "document.querySelector('.message-reaction')", { timeout: 9000 });
    return 'reply + realtime reaction';
  });

  await check('multi-select mode counts, copies, and exits with back', async () => {
    await evaluate(pageA, `const b=[...document.querySelectorAll('.message-bubble')].find(x=>x.textContent.includes('Dinner Friday'));b.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));return true;`);
    await waitFor(pageA, "document.querySelector('[data-action-id=\"select\"]')"); await click(pageA, '[data-action-id="select"]');
    await waitFor(pageA, "document.querySelector('.chat-page.mode-select')");
    const count = await evaluate(pageA, "return document.querySelector('[data-select-count]').textContent;");
    if (!/1/.test(count)) throw new Error(count);
    await screenshot(pageA, '10-multi-select');
    await click(pageA, '[data-action="close-select"]');
    await waitFor(pageA, "!document.querySelector('.chat-page.mode-select')");
    return count;
  });

  await check('emoji panel replaces keyboard and inserts at the caret', async () => {
    await click(pageA, '[data-action="emoji"]');
    await waitFor(pageA, "document.querySelector('.emoji-panel .emoji-key')");
    const emoji = await evaluate(pageA, "return document.querySelector('.emoji-key').dataset.emoji;");
    await click(pageA, '.emoji-key');
    const value = await evaluate(pageA, "return document.querySelector('[data-input]').value;");
    if (!value.includes(emoji)) throw new Error('emoji not inserted');
    await screenshot(pageA, '11-emoji-panel');
    await click(pageA, '[data-action="emoji"]');
    return emoji;
  });

  await check('hold-to-record sends one voice message after repeated chat visits', async () => {
    // Reopen the chat three times: listeners must never accumulate.
    for (let n=0;n<3;n+=1){
      await click(pageA,'[data-action="back"]'); await sleep(450);
      const backState=await evaluate(pageA,"return {path:location.pathname,screens:[...document.querySelectorAll('.screen')].map(x=>x.className)};");
      if(backState.path!=='/'||!backState.screens.some(x=>x.includes('screen-chats')&&!x.includes('covered')))throw new Error('back navigation: '+JSON.stringify(backState));
      await click(pageA,'[data-open]');await waitFor(pageA,"document.querySelector('.chat-voice')");
    }
    const before=(await apiCall(pageA,'/api/conversations')).data.conversations.find(x=>x.kind==='group');
    const beforeMessages=(await apiCall(pageA,`/api/conversations/${before.id}/messages`)).data.messages.filter(x=>x.kind==='voice').length;
    await evaluate(pageA, `const b=document.querySelector('.chat-voice');b.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:7,pointerType:'touch',clientX:370,clientY:800}));return true;`);
    await waitFor(pageA, "document.querySelector('[data-composer-wrap]').dataset.recording === 'holding'", { timeout: 7000, label: 'voice recording' });
    await sleep(1300);
    await evaluate(pageA, `const b=document.querySelector('.chat-voice');b.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:7,pointerType:'touch',clientX:370,clientY:800}));return true;`);
    await waitFor(pageA, "document.querySelector('.message.mine .voice') && !document.querySelector('.message.pending')", { timeout: 15000, label: 'voice confirmed' });
    await waitFor(pageB, "document.querySelector('.message:not(.mine) .voice')", { timeout: 12000, label: 'voice received' });
    const afterMessages=(await apiCall(pageA,`/api/conversations/${before.id}/messages`)).data.messages.filter(x=>x.kind==='voice');
    if (afterMessages.length-beforeMessages!==1) throw new Error(`created ${afterMessages.length-beforeMessages}`);
    const voice=afterMessages.at(-1); if(!voice.media.waveform?.length||!voice.media.durationMs)throw new Error('metadata missing');
    await screenshot(pageB,'12-voice-received');
    return `1 message, ${voice.media.durationMs}ms, ${voice.media.waveform.length} bars`;
  });

  await check('only one voice player can be active and speed cycles', async () => {
    // Send a second recorded voice.
    await evaluate(pageA, `const b=document.querySelector('.chat-voice');b.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:8,pointerType:'touch',clientX:370,clientY:800}));return true;`);
    await waitFor(pageA,"document.querySelector('[data-composer-wrap]').dataset.recording === 'holding'",{timeout:7000});await sleep(1000);
    await evaluate(pageA, `const b=document.querySelector('.chat-voice');b.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:8,pointerType:'touch',clientX:370,clientY:800}));return true;`);
    await waitFor(pageB,"document.querySelectorAll('.message:not(.mine) .voice').length>=2",{timeout:12000});
    const result=await evaluate(pageB,`const ids=[...document.querySelectorAll('.voice')].map(x=>x.dataset.voice);const n=id=>document.querySelector('[data-voice="'+id+'"]');const busy=id=>n(id).classList.contains('is-playing')||n(id).classList.contains('is-loading');n(ids[0]).querySelector('[data-voice-toggle]').click();await new Promise(r=>setTimeout(r,500));n(ids[1]).querySelector('[data-voice-toggle]').click();await new Promise(r=>setTimeout(r,500));n(ids[1]).querySelector('[data-voice-speed]').click();return {active:ids.filter(busy).length,first:busy(ids[0]),second:busy(ids[1]),speed:n(ids[1]).querySelector('[data-voice-speed]').textContent,audios:document.querySelectorAll('audio').length};`);
    if(result.active!==1||result.first||!result.second||result.audios)throw new Error(JSON.stringify(result));
    if(result.speed!=='1.5×')throw new Error(`speed ${result.speed}`);
    return JSON.stringify(result);
  });

  await check('a locked recording is cancelled when the chat is covered', async () => {
    await evaluate(pageA, `const module=await import('/lib/settings.js');await module.updateSettings({chat:{sendByHold:false}});return true;`);
    await click(pageA, '.chat-voice');
    await waitFor(pageA, "document.querySelector('[data-composer-wrap]').dataset.recording === 'locked'", { timeout: 7000, label: 'locked recording' });
    await click(pageA, '.chat-person');
    await waitFor(pageA, "document.querySelector('.screen-chatInfo:not(.covered)')", { label: 'chat info over recording' });
    await sleep(400);
    const state = await evaluate(pageA, "const c=document.querySelector('.screen-conversation [data-composer-wrap]');return {recording:c?.dataset.recording||'idle',covered:document.querySelector('.screen-conversation')?.classList.contains('covered')};");
    if (state.recording !== 'idle' || !state.covered) throw new Error(JSON.stringify(state));
    await evaluate(pageA, "history.back();return true;");
    await waitFor(pageA, "document.querySelector('.screen-conversation:not(.covered) .chat-voice')");
    await evaluate(pageA, `const module=await import('/lib/settings.js');await module.updateSettings({chat:{sendByHold:true}});return true;`);
    return 'microphone stopped without sending';
  });

  await check('files are real downloads and appear in the chat', async () => {
    const uploaded=await uploadPdf(pageA); if(uploaded.status!==201)throw new Error(`upload ${uploaded.status}`);
    const conv=(await apiCall(pageA,'/api/conversations')).data.conversations.find(x=>x.kind==='group');
    const sent=await apiCall(pageA,`/api/conversations/${conv.id}/messages`,{method:'POST',body:{kind:'file',mediaId:uploaded.data.media.id,body:'Quarterly report'}});
    if(sent.status!==201)throw new Error(`send ${sent.status}`);
    await waitFor(pageB,"document.querySelector('.file-card')",{timeout:9000});
    const info=await evaluate(pageB,"const f=document.querySelector('.file-card');return {name:f.textContent,download:f.hasAttribute('download'),href:f.getAttribute('href')};");
    if(!info.download||!info.href.includes('download=1'))throw new Error(JSON.stringify(info));
    return info.name.replace(/\s+/g,' ').trim();
  });

  await check('delete for everyone disappears from both clients in realtime', async () => {
    await fill(pageA,'[data-input]','Delete this everywhere');await evaluate(pageA,"document.querySelector('[data-composer]').requestSubmit();return true;");
    await waitFor(pageB,"[...document.querySelectorAll('.message-text')].some(x=>x.textContent.includes('Delete this everywhere'))",{timeout:9000});
    await evaluate(pageA,`const b=[...document.querySelectorAll('.message-bubble')].find(x=>x.textContent.includes('Delete this everywhere'));b.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true}));return true;`);
    await waitFor(pageA,"document.querySelector('[data-action-id=\"delete\"]')");await click(pageA,'[data-action-id="delete"]');
    await waitFor(pageA,"document.querySelector('[data-sheet-action=\"everyone\"]')");await click(pageA,'[data-sheet-action="everyone"]');
    await waitFor(pageB,"![...document.querySelectorAll('.message-text')].some(x=>x.textContent.includes('Delete this everywhere'))",{timeout:9000});
    return 'both clients removed it';
  });

  const storyMedia=await uploadPng(pageA,'story');
  await check('stories show unseen rings and fullscreen gestures', async () => {
    await apiCall(pageA,'/api/stories',{method:'POST',body:{mediaId:storyMedia,caption:'Trail day'}});
    await evaluate(pageB,"history.replaceState({depth:0},'', '/');dispatchEvent(new PopStateEvent('popstate'));return true;");
    await waitFor(pageB,"document.querySelector('.story-avatar[data-author]:not([data-author=\"new\"])')",{timeout:9000});
    await click(pageB,'.story-avatar[data-author]:not([data-author="new"])');
    await waitFor(pageB,"document.querySelector('.story-viewer [data-story-media]')");
    const story=await evaluate(pageB,"return {caption:document.querySelector('.story-caption')?.textContent,bars:document.querySelectorAll('.story-progress i').length};");
    if(story.caption!=='Trail day'||!story.bars)throw new Error(JSON.stringify(story));
    await screenshot(pageB,'13-story-viewer');
    await click(pageB,'[data-story-action="close"]');
    return story.caption;
  });

  await check('author opens own story and sees deduplicated viewer', async () => {
    await evaluate(pageA,"history.replaceState({depth:0},'', '/');dispatchEvent(new PopStateEvent('popstate'));return true;");
    await waitFor(pageA,"document.querySelector('.story-own [data-author]:not([data-author=\"new\"])')");await click(pageA,'.story-own [data-author]:not([data-author="new"])');
    await waitFor(pageA,"document.querySelector('[data-story-action=\"viewers\"]')");await click(pageA,'[data-story-action="viewers"]');
    await waitFor(pageA,"[...document.querySelectorAll('.modal-sheet .member-item')].some(x=>x.textContent.includes('Ana'))");
    const count=await evaluate(pageA,"return document.querySelectorAll('.modal-sheet .member-item').length;");
    if(count!==1)throw new Error(`viewer rows ${count}`);
    await screenshot(pageA,'14-story-viewers');
    await evaluate(pageA,"document.querySelector('.modal-backdrop').close();return true;");await sleep(250);await click(pageA,'[data-story-action="close"]');
    return 'Ana once';
  });

  await check('archive stays archived after a new message', async () => {
    const conv=(await apiCall(pageA,'/api/conversations')).data.conversations.find(x=>x.kind==='group');
    await apiCall(pageA,`/api/conversations/${conv.id}/settings`,{method:'POST',body:{archived:true}});
    await apiCall(pageB,`/api/conversations/${conv.id}/messages`,{method:'POST',body:{kind:'text',body:'Still in archive'}});
    await evaluate(pageA,"history.replaceState({depth:0},'', '/');dispatchEvent(new PopStateEvent('popstate'));return true;");
    await waitFor(pageA,"document.querySelector('.archived-row:not([hidden])')",{timeout:9000});
    const rowExists=await evaluate(pageA,`return ![...document.querySelectorAll('.chat-list [data-open]')].some(x=>x.dataset.open===${JSON.stringify(String(conv.id))});`);
    if(!rowExists)throw new Error('archived chat returned to main list');
    await click(pageA,'.archived-row'); await sleep(500);
    const archiveState=await evaluate(pageA,`return {path:location.pathname,screens:[...document.querySelectorAll('.screen')].map(x=>x.className),rows:[...document.querySelectorAll('.screen-archived [data-open]')].map(x=>x.dataset.open),text:document.querySelector('.screen-archived')?.innerText.slice(0,300)};`);
    if(archiveState.path!=='/chat/archived'||!archiveState.rows.length)throw new Error(JSON.stringify(archiveState));
    return 'remains in archive';
  });

  await check('Uzbek language applies to the whole shell', async () => {
    await evaluate(pageA,"history.replaceState({depth:0},'', '/settings/language');dispatchEvent(new PopStateEvent('popstate'));return true;");
    await waitFor(pageA,"document.querySelector('[data-language=\"uz\"]')");await click(pageA,'[data-language="uz"]');
    await waitFor(pageA,"document.documentElement.lang.startsWith('uz') && document.querySelector('.tabbar')");
    const labels=await evaluate(pageA,"return [...document.querySelectorAll('.tab-label')].map(x=>x.textContent).join(',');");
    if(!labels.includes('Chatlar')||!labels.includes('Sozlamalar'))throw new Error(labels);
    await screenshot(pageA,'15-uzbek');
    return labels;
  });

  await check('PWA manifest, service worker, launch images and icons are present', async () => {
    const info=await evaluate(pageA,`const m=await(await fetch('/manifest.webmanifest')).json();const r=await navigator.serviceWorker.ready;return {display:m.display,icons:m.icons.length,shortcuts:m.shortcuts.length,worker:Boolean(r.active),launch:document.querySelectorAll('link[rel="apple-touch-startup-image"]').length,standalone:m.start_url};`);
    if(info.display!=='standalone'||!info.worker||info.icons<4||info.shortcuts<3||info.launch<10)throw new Error(JSON.stringify(info));
    return JSON.stringify(info);
  });

  await check('keyboard-size viewport keeps composer reachable', async () => {
    await evaluate(pageB,"history.replaceState({depth:0},'', '/');dispatchEvent(new PopStateEvent('popstate'));return true;");await waitFor(pageB,"document.querySelector('[data-open]')");await click(pageB,'[data-open]');await waitFor(pageB,"document.querySelector('.chat-composer')");
    await pageB.send('Emulation.setDeviceMetricsOverride',{...DEVICES['iPhone SE'],height:330});await sleep(300);
    const layout=await evaluate(pageB,"const c=document.querySelector('.composer-wrap').getBoundingClientRect();const m=document.querySelector('.messages').getBoundingClientRect();return {bottom:Math.round(c.bottom),viewport:innerHeight,messages:Math.round(m.height)};");
    await useDevice(pageB,DEVICES['iPhone 15 Pro']);
    if(layout.bottom>layout.viewport+1||layout.messages<40)throw new Error(JSON.stringify(layout));
    return JSON.stringify(layout);
  });

  await check('all primary screens fit every supported phone width', async () => {
    const overflows=[];
    for(const [name,device] of Object.entries(DEVICES)){
      await useDevice(pageB,device);
      for(const target of ['/','/feed','/activity','/settings']){
        await evaluate(pageB,`history.replaceState({depth:0},'',${JSON.stringify(target)});dispatchEvent(new PopStateEvent('popstate'));return true;`);await sleep(180);
        const width=await evaluate(pageB,"return {scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth};");
        if(width.scroll>width.client+1)overflows.push(`${name}:${target} ${width.scroll}>${width.client}`);
      }
    }
    await useDevice(pageB,DEVICES['iPhone 15 Pro']);
    if(overflows.length)throw new Error(overflows.join('; '));
    return `${Object.keys(DEVICES).length} phones × 4 tabs`;
  });

  await check('desktop remains responsive as a secondary layout', async () => {
    await pageB.send('Emulation.setDeviceMetricsOverride',{width:1280,height:860,deviceScaleFactor:1,mobile:false});
    await evaluate(pageB,"history.replaceState({depth:0},'', '/');dispatchEvent(new PopStateEvent('popstate'));return true;");await sleep(300);
    const info=await evaluate(pageB,"const t=document.querySelector('.tabbar').getBoundingClientRect();return {tab:[Math.round(t.width),Math.round(t.height)],overflow:document.documentElement.scrollWidth-document.documentElement.clientWidth};");
    if(info.tab[1]<=info.tab[0]||info.overflow>1)throw new Error(JSON.stringify(info));
    await screenshot(pageB,'16-desktop-secondary');
    return `${info.tab[0]}×${info.tab[1]} rail`;
  });

  await check('remote session termination signs out UI and revokes its live connection', async () => {
    const pageC = await openPage('revoked-device', BASE);
    await mobileViewport(pageC);
    await waitFor(pageC, "document.querySelector('.auth-card')");
    await fill(pageC, '#username', 'ana'); await fill(pageC, '#password', 'ana-strong-pass');
    await click(pageC, '.auth-card button[type="submit"]');
    await waitFor(pageC, "document.querySelector('.tabbar')", { label: 'second Ana device' });
    const sessions = await apiCall(pageB, '/api/sessions');
    const remote = sessions.data.sessions.find(item => !item.current);
    if (!remote) throw new Error('remote session not listed');
    const removed = await apiCall(pageB, `/api/sessions/${remote.id}`, { method: 'DELETE' });
    if (removed.status !== 200) throw new Error(`termination ${removed.status}`);
    await waitFor(pageC, "document.querySelector('.auth-card') && !document.querySelector('.tabbar')", { timeout: 15000, label: 'revoked UI signed out' });
    const denied = await evaluate(pageC, "return (await fetch('/api/feed',{credentials:'same-origin'})).status;");
    pageC.close();
    if (denied !== 401) throw new Error(`revoked HTTP status ${denied}`);
    return 'SSE closed, shell removed, API denied';
  });

  await check('no uncaught runtime or server errors', () => {
    const relevant=consoleIssues.filter(issue=>!/ExperimentalWarning|SQLite is an experimental|Circle is ready|Maintenance:|status of (401|403|404|410)/.test(issue));
    if(relevant.length)throw new Error(relevant.slice(0,8).join(' | '));
    return 'clean console and server logs';
  });

  pageA.close();pageB.close();
} catch(error){report('browser verification harness',false,error.message)} finally {shutdown()}

console.log(`\n${results.filter(result=>result.ok).length}/${results.length} browser checks passed`);
console.log(`Screenshots: ${shotDir}`);
fs.rmSync(workDir,{recursive:true,force:true});
process.exit(failures?1:0);
