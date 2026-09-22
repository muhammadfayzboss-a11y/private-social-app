import { request, setCsrf } from './api.js';
import { icon } from './icons.js';
import { currentRoute, navigate, onRouteChange } from './router.js';
import { connectRealtime } from './realtime.js';
import { loadActivity, loadConversations, loadMembers, state, subscribe, totalUnreadMessages } from './store.js';
import { toast } from './ui.js';
import { renderAuth } from './views/auth.js';
import { renderHome } from './views/home.js';
import { renderCreate } from './views/create.js';
import { renderChatList, renderConversation } from './views/chat.js';
import { renderActivity } from './views/activity.js';
import { renderProfile, renderSettings } from './views/profile.js';

const app = document.querySelector('#app');
const splash = document.querySelector('#splash');
let cleanup = null;
let shellReady = false;

function initTheme() {
  const stored = localStorage.getItem('circle-theme');
  const theme = stored || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#101014' : '#7357ff');
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('circle-theme', next);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', next === 'dark' ? '#101014' : '#7357ff');
  document.querySelector('[data-action="theme"]').innerHTML = icon(next === 'dark' ? 'sun' : 'moon', 21);
}

const NAV = [
  { name: 'home', path: '/', label: 'Home', iconName: 'home' },
  { name: 'chat', path: '/chat', label: 'Chat', iconName: 'chat' },
  { name: 'create', path: '/create', label: 'Create', iconName: 'plus' },
  { name: 'activity', path: '/activity', label: 'Activity', iconName: 'bell' },
  { name: 'profile', path: '/profile', label: 'Profile', iconName: 'user' }
];

function renderShell() {
  app.innerHTML = `
    <div class="app-shell">
      <header class="app-header">
        <div class="wordmark"><span class="mini-mark">${icon('lock', 15)}</span>Circle</div>
        <div class="header-actions">
          <button class="icon-button" data-action="theme" aria-label="Toggle dark mode">${icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon', 21)}</button>
          <button class="icon-button badge-wrap" data-nav="/activity" aria-label="Activity">${icon('bell', 21)}<span class="badge" data-activity-badge hidden></span></button>
        </div>
      </header>
      <div id="view"></div>
      <nav class="bottom-nav" aria-label="Main navigation">
        ${NAV.map(item => `
          <button class="nav-item${item.name === 'create' ? ' nav-create' : ''}" data-nav="${item.path}" data-name="${item.name}" aria-label="${item.label}">
            <span class="badge-wrap">${icon(item.iconName, 23)}${item.name === 'chat' ? '<span class="badge" data-chat-badge hidden></span>' : ''}${item.name === 'activity' ? '<span class="badge" data-nav-activity-badge hidden></span>' : ''}</span>
            <span>${item.label}</span>
          </button>`).join('')}
      </nav>
    </div>`;

  app.addEventListener('click', event => {
    const navButton = event.target.closest('[data-nav]');
    if (navButton) return navigate(navButton.dataset.nav);
    if (event.target.closest('[data-action="theme"]')) toggleTheme();
  });

  shellReady = true;
}

function updateBadges() {
  const chat = totalUnreadMessages();
  const activity = state.activity.unread;
  const chatBadge = document.querySelector('[data-chat-badge]');
  if (chatBadge) { chatBadge.hidden = !chat; chatBadge.textContent = chat > 9 ? '9+' : String(chat); }
  for (const selector of ['[data-activity-badge]', '[data-nav-activity-badge]']) {
    const badge = document.querySelector(selector);
    if (badge) { badge.hidden = !activity; badge.textContent = activity > 9 ? '9+' : String(activity); }
  }
  const title = chat + activity;
  document.title = title ? `(${title}) Circle` : 'Circle';
}

function setActiveNav(routeName) {
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.name === routeName || (routeName === 'conversation' && item.dataset.name === 'chat') || (routeName === 'settings' && item.dataset.name === 'profile'));
  });
}

function renderRoute() {
  const route = currentRoute();
  cleanup?.();
  cleanup = null;

  if (!state.user) {
    document.body.classList.add('unauthenticated');
    shellReady = false;
    cleanup = renderAuth(app, {
      needsSetup: state.needsSetup,
      onAuthenticated: async user => {
        state.user = user;
        document.body.classList.remove('unauthenticated');
        await startSession();
        navigate('/');
        renderRoute();
      }
    });
    return;
  }

  if (route.name === 'conversation') {
    shellReady = false;
    cleanup = renderConversation(app, route.params);
    return;
  }

  if (!shellReady) renderShell();
  const view = document.querySelector('#view');
  view.innerHTML = '';
  setActiveNav(route.name);
  updateBadges();

  const renderers = {
    home: renderHome,
    create: renderCreate,
    chat: renderChatList,
    activity: renderActivity,
    profile: renderProfile,
    settings: renderSettings
  };
  cleanup = (renderers[route.name] || renderHome)(view, route.params);
  window.scrollTo({ top: 0 });
}

async function startSession() {
  connectRealtime();
  await Promise.allSettled([loadMembers(true), loadConversations(), loadActivity()]);
  updateBadges();
  registerServiceWorker();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js').catch(error => console.warn('Service worker registration failed', error));
}

async function boot() {
  initTheme();
  try {
    const status = await request('/api/auth/status');
    state.needsSetup = status.needsSetup;
    state.user = status.user;
    setCsrf(status.csrfToken);
    if (status.authenticated) await startSession();
  } catch (error) {
    toast('Could not reach the server. Retrying shortly.', 'error');
    setTimeout(boot, 4000);
  } finally {
    splash.classList.add('hidden');
    setTimeout(() => splash.remove(), 400);
  }
  renderRoute();
}

subscribe(event => {
  if (['activity', 'conversations', 'message', 'messages'].includes(event)) updateBadges();
  if (event === 'notification') updateBadges();
});

onRouteChange(renderRoute);
boot();
