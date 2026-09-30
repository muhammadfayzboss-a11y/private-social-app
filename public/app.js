import { request, setCsrf } from './api.js';
import { icon } from './icons.js';
import { currentRoute, navigate, onRouteChange } from './router.js';
import { connectRealtime } from './realtime.js';
import { loadActivity, loadConversations, loadMembers, state, subscribe, totalUnreadMessages } from './store.js';
import { toast } from './ui.js';
import { setServerTime, startRelativeTimeTicker } from './lib/time.js';
import { applyTheme, resolvedTheme, toggleTheme } from './lib/theme.js';
import { renderAuth } from './views/auth.js';
import { renderHome } from './views/home.js';
import { renderCreate } from './views/create.js';
import { renderChatList, renderConversation } from './views/chat.js';
import { renderActivity } from './views/activity.js';
import { renderProfile, renderSettings } from './views/profile.js';

const app = document.querySelector('#app');
const splash = document.querySelector('#splash');
let cleanup = null;
let shell = null;
let sessionStarted = false;
const scrollPositions = new Map();
let lastPath = null;

const NAV = [
  { name: 'home', path: '/', label: 'Home', iconName: 'home' },
  { name: 'chat', path: '/chat', label: 'Chats', iconName: 'chat' },
  { name: 'create', path: '/create', label: 'Create', iconName: 'plus' },
  { name: 'activity', path: '/activity', label: 'Activity', iconName: 'bell' },
  { name: 'profile', path: '/profile', label: 'Profile', iconName: 'user' }
];

const RENDERERS = {
  home: renderHome, create: renderCreate, chat: renderChatList, conversation: renderConversation,
  activity: renderActivity, profile: renderProfile, settings: renderSettings
};

function themeIcon() { return icon(resolvedTheme() === 'dark' ? 'sun' : 'moon', 21); }

/**
 * The shell is created once per signed-in session and never re-rendered. Its listeners are attached
 * to the shell element itself, so they cannot accumulate across navigations.
 */
function renderShell() {
  app.innerHTML = `
    <div class="app-shell">
      <header class="app-header">
        <div class="wordmark"><span class="mini-mark">${icon('lock', 15)}</span>Circle</div>
        <div class="connection-pill" data-connection hidden><span class="spinner spinner-sm"></span><span data-connection-text>Connecting…</span></div>
        <div class="header-actions">
          <button class="icon-button" data-action="theme" aria-label="Toggle dark mode">${themeIcon()}</button>
          <button class="icon-button badge-wrap" data-nav="/activity" aria-label="Activity">${icon('bell', 21)}<span class="badge" data-activity-badge hidden></span></button>
        </div>
      </header>
      <div id="view"></div>
      <nav class="bottom-nav" aria-label="Main navigation">
        ${NAV.map(item => `
          <button class="nav-item${item.name === 'create' ? ' nav-create' : ''}" data-nav="${item.path}" data-name="${item.name}" aria-label="${item.label}">
            <span class="badge-wrap nav-icon">${icon(item.iconName, 24)}${item.name === 'chat' ? '<span class="badge" data-chat-badge hidden></span>' : ''}${item.name === 'activity' ? '<span class="badge" data-nav-activity-badge hidden></span>' : ''}</span>
            <span class="nav-label">${item.label}</span>
          </button>`).join('')}
      </nav>
    </div>`;
  shell = app.querySelector('.app-shell');
  shell.addEventListener('click', event => {
    const navButton = event.target.closest('[data-nav]');
    if (navButton) {
      // Tapping the tab you are already on scrolls it back to the top, as native apps do.
      if (navButton.dataset.nav === window.location.pathname) window.scrollTo({ top: 0, behavior: 'smooth' });
      return navigate(navButton.dataset.nav);
    }
    if (event.target.closest('[data-action="theme"]')) toggleTheme();
  });
  updateConnection();
}

document.addEventListener('themechange', () => {
  const button = document.querySelector('.app-header [data-action="theme"]');
  if (button) button.innerHTML = themeIcon();
});

function setBadge(selector, count) {
  const badge = document.querySelector(selector);
  if (!badge) return;
  badge.hidden = !count;
  badge.textContent = count > 99 ? '99+' : String(count);
}

function updateBadges() {
  const chat = totalUnreadMessages();
  const activity = state.activity.unread;
  setBadge('[data-chat-badge]', chat);
  setBadge('[data-activity-badge]', activity);
  setBadge('[data-nav-activity-badge]', activity);
  document.title = chat + activity ? `(${chat + activity}) Circle` : 'Circle';
  // Home-screen icon badge where supported (installed PWAs on iOS 16.4+, Android, desktop).
  try { if (chat + activity) navigator.setAppBadge?.(chat + activity)?.catch?.(() => {}); else navigator.clearAppBadge?.()?.catch?.(() => {}); } catch { /* optional */ }
}

let connectionTimer = null;
function updateConnection() {
  const pill = document.querySelector('[data-connection]');
  if (!pill) return;
  clearTimeout(connectionTimer);
  const status = navigator.onLine === false ? 'offline' : state.realtime;
  if (status === 'online') { pill.hidden = true; return; }
  // A brief blip while reconnecting should not flash a banner.
  connectionTimer = setTimeout(() => {
    pill.hidden = false;
    pill.classList.toggle('offline', status === 'offline');
    pill.querySelector('[data-connection-text]').textContent = status === 'offline' ? 'Waiting for network…' : 'Connecting…';
  }, status === 'offline' ? 0 : 1500);
}

function setActiveNav(routeName) {
  document.querySelectorAll('.nav-item').forEach(item => {
    const active = item.dataset.name === routeName || (routeName === 'conversation' && item.dataset.name === 'chat') || (routeName === 'settings' && item.dataset.name === 'profile');
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
  });
}

function renderRoute(event) {
  const route = currentRoute();
  if (lastPath) scrollPositions.set(lastPath, window.scrollY);
  cleanup?.();
  cleanup = null;

  if (!state.user) {
    shell = null;
    document.body.classList.add('unauthenticated');
    cleanup = renderAuth(app, {
      needsSetup: state.needsSetup,
      onAuthenticated: async user => {
        state.user = user;
        document.body.classList.remove('unauthenticated');
        await startSession();
        if (window.location.pathname === '/' && !window.location.search) renderRoute();
        else navigate('/', { replace: true });
      }
    });
    return;
  }

  if (!shell) renderShell();
  const immersive = route.name === 'conversation';
  shell.classList.toggle('shell-immersive', immersive);
  // Every route renders into a brand-new container, so a view's delegated listeners die with it.
  const previous = document.querySelector('#view');
  const view = document.createElement('div');
  view.id = 'view';
  const back = event?.type === 'popstate' && event.isTrusted;
  view.className = `view view-enter${immersive ? ' view-immersive' : ''}${back ? ' view-back' : ''}`;
  previous.replaceWith(view);
  setActiveNav(route.name);
  updateBadges();
  cleanup = (RENDERERS[route.name] || renderHome)(view, route.params) || null;
  const path = window.location.pathname + window.location.search;
  // Restore where you were when coming back; start new pages at the top.
  window.scrollTo({ top: back ? scrollPositions.get(path) || 0 : 0 });
  lastPath = path;
}

async function startSession() {
  if (sessionStarted) return;
  sessionStarted = true;
  connectRealtime();
  await Promise.allSettled([loadMembers(true), loadConversations(), loadActivity()]);
  updateBadges();
  registerServiceWorker();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Only an update replacing an existing worker is news; the first install is silent.
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.register('/sw.js').then(registration => {
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'activated' && hadController) toast('Circle was updated — changes apply next time you open it.');
      });
    });
  }).catch(error => console.warn('Service worker registration failed', error));
}

let bootRetry = null;
function showOffline() {
  if (state.user && shell) return; // a running session shows the connection pill instead
  app.innerHTML = `<div class="offline-screen">
    <span class="empty-icon">${icon('alert', 30)}</span>
    <h2>Can't reach Circle</h2>
    <p>${navigator.onLine === false ? 'You are offline. Circle will reconnect as soon as the network is back.' : 'The server is not responding. Retrying automatically…'}</p>
    <button class="button button-primary" data-retry-boot>Try again</button>
  </div>`;
  app.querySelector('[data-retry-boot]').addEventListener('click', () => boot());
}

async function boot() {
  clearTimeout(bootRetry);
  applyTheme();
  startRelativeTimeTicker();
  try {
    const status = await request('/api/auth/status');
    setServerTime(status.serverTime);
    state.needsSetup = status.needsSetup;
    state.user = status.user;
    setCsrf(status.csrfToken);
    if (status.authenticated) await startSession();
  } catch {
    splash.classList.add('hidden');
    showOffline();
    toast('Could not reach the server. Retrying shortly.', 'error');
    bootRetry = setTimeout(boot, 5000);
    return;
  }
  splash.classList.add('hidden');
  setTimeout(() => splash.remove(), 400);
  renderRoute();
}

subscribe((event, payload) => {
  if (['activity', 'conversations', 'message', 'messages', 'notification'].includes(event)) updateBadges();
  if (event === 'realtime:status') updateConnection();
  if (event === 'notification' && payload) updateBadges();
});
window.addEventListener('online', () => { updateConnection(); if (!state.user && document.querySelector('.offline-screen')) boot(); });
window.addEventListener('offline', updateConnection);

// Deep links from push notifications arrive through the service worker.
navigator.serviceWorker?.addEventListener('message', event => {
  if (event.data?.type === 'navigate' && typeof event.data.url === 'string' && event.data.url.startsWith('/')) navigate(event.data.url);
});

onRouteChange(renderRoute);
boot();
