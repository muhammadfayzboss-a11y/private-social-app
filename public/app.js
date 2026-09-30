import { request, setCsrf } from './api.js';
import { icon } from './icons.js';
import { goBack, navigate, normaliseLegacyUrl, onRouteChange } from './router.js';
import { connectRealtime } from './realtime.js';
import { conversationById, loadActivity, loadConversations, loadMembers, resetState, state, subscribe, totalUnreadMessages } from './store.js';
import { avatar, escapeHtml, toast } from './ui.js';
import { setServerTime, startRelativeTimeTicker } from './lib/time.js';
import { applyTheme } from './lib/theme.js';
import { setLanguage, t } from './lib/i18n.js';
import { applyServerSettings, clearLocalSettings, clearPrivateLocalData, onSettingsChange, settings } from './lib/settings.js';
import { currentTab, handleLocation, initNavigation, resetNavigation, scrollActiveRootToTop, stackDepth } from './lib/nav.js';
import { playIncomingSound } from './lib/sounds.js';
import { renderAuth } from './views/auth.js';

const app = document.querySelector('#app');
const splash = document.querySelector('#splash');
let shell = null;
let sessionStarted = false;
const BUILD_VERSION = '7';

/*
 * iOS can report different percentage, dynamic, and visual viewport heights after standalone
 * launch, rotation, keyboard use, or returning from the background. Keep the complete app shell
 * on one measured viewport so the tab bar always paints through the bottom safe area.
 */
let viewportFrame = 0;
let viewportSettleTimer = null;
/**
 * The shell fills the layout viewport through plain CSS (`#app { inset: 0 }`), which cannot leave a
 * gap. JS only intervenes while an on-screen keyboard is covering part of that viewport, so a wrong
 * or missing measurement can never shrink the app away from the bottom of the screen.
 */
function applyAppViewport() {
  viewportFrame = 0;
  const viewport = window.visualViewport;
  const visualHeight = Math.max(1, Math.round(viewport?.height || window.innerHeight));
  const visualOffset = Math.max(0, Math.round(viewport?.offsetTop || 0));
  // A keyboard hides a large slice of the layout viewport. Small differences are browser chrome or
  // the home-indicator safe area, which must stay inside the app so the tab bar paints through them.
  const keyboardOpen = window.innerHeight - visualHeight - visualOffset > 120;
  document.documentElement.classList.toggle('keyboard-open', keyboardOpen);
  if (!keyboardOpen) {
    document.documentElement.style.removeProperty('--app-height');
    document.documentElement.style.removeProperty('--app-offset-top');
    return;
  }
  const maxOffset = Math.max(0, window.innerHeight - visualHeight);
  document.documentElement.style.setProperty('--app-height', `${visualHeight}px`);
  document.documentElement.style.setProperty('--app-offset-top', `${Math.min(visualOffset, maxOffset)}px`);
}
function scheduleAppViewport() {
  cancelAnimationFrame(viewportFrame);
  clearTimeout(viewportSettleTimer);
  viewportFrame = requestAnimationFrame(applyAppViewport);
  // WebKit sometimes settles its final standalone/rotation metrics one frame later.
  viewportSettleTimer = setTimeout(applyAppViewport, 120);
}
applyAppViewport();
window.visualViewport?.addEventListener('resize', scheduleAppViewport);
window.visualViewport?.addEventListener('scroll', scheduleAppViewport);
window.addEventListener('resize', scheduleAppViewport);
window.addEventListener('orientationchange', scheduleAppViewport);
window.addEventListener('pageshow', scheduleAppViewport);

const TABS = [
  { tab: 'chats', path: '/', label: 'Chats', iconName: 'chat' },
  { tab: 'feed', path: '/feed', label: 'Feed', iconName: 'grid' },
  { tab: 'activity', path: '/activity', label: 'Activity', iconName: 'bell' },
  { tab: 'settings', path: '/settings', label: 'Settings', iconName: 'settings' }
];

/**
 * Feature screens are native dynamic imports. The first launch loads only the shell, auth, state and
 * current tab; the 40–55 KB conversation/settings modules arrive only when opened (and are then held
 * by the browser module cache and service worker shell for instant repeat visits).
 */
function lazy(modulePath, exportName) {
  return (element, params, screen) => {
    let cancelled = false;
    let cleanup = null;
    element.innerHTML = '<div class="screen-loader"><span class="spinner"></span></div>';
    import(`${modulePath}?v=${BUILD_VERSION}`).then(module => {
      if (cancelled) return;
      element.innerHTML = '';
      cleanup = module[exportName](element, params, screen) || null;
    }).catch(error => {
      if (cancelled) return;
      console.error(`Could not load screen ${exportName}`, error);
      element.innerHTML = `<div class="screen-error"><p>${escapeHtml(t('Could not load'))}</p><button class="button" data-reload>${escapeHtml(t('Try again'))}</button></div>`;
      element.querySelector('[data-reload]').addEventListener('click', () => window.location.reload());
    });
    return () => { cancelled = true; cleanup?.(); };
  };
}

const RENDERERS = {
  chats: lazy('./views/chats.js', 'renderChats'), archived: lazy('./views/chats.js', 'renderArchived'),
  conversation: lazy('./views/conversation.js', 'renderConversation'), chatInfo: lazy('./views/chatInfo.js', 'renderChatInfo'),
  search: lazy('./views/search.js', 'renderSearch'), feed: lazy('./views/feed.js', 'renderFeed'), create: lazy('./views/create.js', 'renderCreate'),
  activity: lazy('./views/activity.js', 'renderActivity'), profile: lazy('./views/profile.js', 'renderProfile'),
  settings: lazy('./views/settings.js', 'renderSettings'), settingsPage: lazy('./views/settings.js', 'renderSettingsPage')
};

/**
 * The shell is created once per signed-in session. Screens live in #screens (managed by the
 * navigation stack); the tab bar sits below them and hides while a screen is pushed.
 */
function renderShell() {
  app.innerHTML = `
    <div class="app-shell">
      <div id="screens" class="screens"></div>
      <nav class="tabbar" aria-label="${t('Main navigation')}">
        ${TABS.map(item => `
          <button class="tab-item" data-tab-path="${item.path}" data-name="${item.tab}" aria-label="${t(item.label)}">
            <span class="tab-icon">${icon(item.iconName, 26)}<span class="badge" data-badge="${item.tab}" hidden></span></span>
            <span class="tab-label">${t(item.label)}</span>
          </button>`).join('')}
      </nav>
      <div class="banner-region" data-banners></div>
    </div>`;
  shell = app.querySelector('.app-shell');
  shell.querySelector('.tabbar').addEventListener('click', event => {
    const button = event.target.closest('[data-tab-path]');
    if (!button) return;
    const target = button.dataset.tabPath;
    if (window.location.pathname === target) return scrollActiveRootToTop();
    // Chats is the existing depth-0 home entry. Pop back to it instead of replacing the upper tab
    // with another `/` entry (which would make the next Back appear to do nothing).
    if (target === '/') return goBack('/');
    navigate(target, { replace: currentTab() !== 'chats' });
  });
  // Every screen's back button: history-aware (returns within the app, never out of it).
  shell.querySelector('#screens').addEventListener('click', event => {
    const back = event.target.closest('[data-back]');
    if (back) { event.preventDefault(); goBack(back.dataset.back || '/'); }
  });
  initNavigation({ host: shell.querySelector('#screens'), renderers: RENDERERS, onChange: onRouteChanged });
}

function onRouteChanged(route, { depth, tab }) {
  document.documentElement.classList.toggle('stack-open', depth > 0);
  shell?.querySelectorAll('.tab-item').forEach(item => {
    const active = item.dataset.name === tab;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
  });
  updateBadges();
}

function setBadge(name, count, dot = false) {
  const badge = document.querySelector(`[data-badge="${name}"]`);
  if (!badge) return;
  badge.hidden = !count && !dot;
  badge.classList.toggle('dot', !count && dot);
  badge.textContent = count ? (count > 99 ? '99+' : String(count)) : '';
}

function updateBadges() {
  const chats = totalUnreadMessages();
  const activity = state.activity.unread;
  setBadge('chats', chats);
  setBadge('activity', activity);
  document.title = chats + activity ? `(${chats + activity}) Circle` : 'Circle';
  // Home-screen icon badge where supported (installed PWAs on iOS 16.4+, Android, desktop).
  try { if (chats + activity) navigator.setAppBadge?.(chats + activity)?.catch?.(() => {}); else navigator.clearAppBadge?.()?.catch?.(() => {}); } catch { /* optional */ }
}

/* ----------------------------- in-app banners ----------------------------- */

/**
 * A message arriving in a chat that is not on screen shows a compact banner (tap to open), plays
 * a short sound and vibrates — each controlled in Settings → Notifications.
 */
function bannerPreview(message) {
  if (message.kind === 'text' || message.kind === 'story_reply') return message.body || t('New message');
  return { image: t('Photo'), video: t('Video'), voice: t('Voice message'), file: message.media?.name || t('File'), sticker: t('Sticker') }[message.kind] || t('New message');
}

function showMessageBanner(conversationId, message) {
  const prefs = settings().notifications;
  const conversation = conversationById(conversationId);
  if (!conversation || conversation.muted || message.isMine || state.openConversationId === Number(conversationId)) return;
  if (conversation.kind === 'group' ? !prefs.groups : !prefs.messages) return;
  if (document.visibilityState !== 'visible') return;
  if (prefs.sound) playIncomingSound();
  if (prefs.vibrate) navigator.vibrate?.(20);
  if (!prefs.inApp) return;
  const region = shell?.querySelector('[data-banners]');
  if (!region) return;
  region.querySelector(`[data-banner="${conversationId}"]`)?.remove();
  const banner = document.createElement('button');
  banner.className = 'message-banner';
  banner.dataset.banner = String(conversationId);
  const title = conversation.kind === 'group' ? `${message.sender.displayName} · ${conversation.title}` : message.sender.displayName;
  banner.innerHTML = `${avatar(message.sender, 'sm')}<span><strong>${escapeHtml(title)}</strong><small>${escapeHtml(prefs.preview ? bannerPreview(message) : t('New message'))}</small></span>`;
  banner.addEventListener('click', () => { banner.remove(); navigate(`/chat/${conversationId}`); });
  let startY = null;
  banner.addEventListener('pointerdown', event => { startY = event.clientY; });
  banner.addEventListener('pointermove', event => { if (startY !== null && event.clientY - startY < -20) { banner.classList.add('leaving'); setTimeout(() => banner.remove(), 200); } });
  region.append(banner);
  requestAnimationFrame(() => banner.classList.add('show'));
  setTimeout(() => { banner.classList.add('leaving'); setTimeout(() => banner.remove(), 220); }, 4200);
}

/* --------------------------------- session -------------------------------- */

function renderApp() {
  if (!state.user) {
    shell = null;
    resetNavigation();
    document.body.classList.add('unauthenticated');
    renderAuth(app, {
      needsSetup: state.needsSetup,
      onAuthenticated: async (user, userSettings) => {
        state.user = user;
        applyServerSettings(userSettings);
        document.body.classList.remove('unauthenticated');
        await startSession();
        window.history.replaceState({ depth: 0 }, '', '/');
        renderApp();
      }
    });
    return;
  }
  document.body.classList.remove('unauthenticated');
  if (!shell) renderShell();
  handleLocation();
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
  let reloadingForUpdate = false;
  if (hadController) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloadingForUpdate) return;
      reloadingForUpdate = true;
      window.location.reload();
    }, { once: true });
  }
  navigator.serviceWorker.register(`/sw.js?v=${BUILD_VERSION}`, { updateViaCache: 'none' }).then(registration => {
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'activated' && hadController) toast(t('Circle was updated — reloading…'));
      });
    });
  }).catch(error => console.warn('Service worker registration failed', error));
}

let bootRetry = null;
function showOffline() {
  if (state.user && shell) return;
  app.innerHTML = `<div class="offline-screen">
    <span class="empty-icon">${icon('alert', 30)}</span>
    <h2>${t('Can’t reach Circle')}</h2>
    <p>${navigator.onLine === false ? t('You are offline. Circle will reconnect as soon as the network is back.') : t('The server is not responding. Retrying automatically…')}</p>
    <button class="button button-primary" data-retry-boot>${t('Try again')}</button>
  </div>`;
  app.querySelector('[data-retry-boot]').addEventListener('click', () => boot());
}

async function boot() {
  clearTimeout(bootRetry);
  setLanguage(settings().language);
  applyTheme();
  startRelativeTimeTicker();
  normaliseLegacyUrl();
  try {
    const status = await request('/api/auth/status');
    setServerTime(status.serverTime);
    state.needsSetup = status.needsSetup;
    state.user = status.user;
    setCsrf(status.csrfToken);
    if (status.settings) {
      const languageChanged = status.settings.language !== settings().language;
      applyServerSettings(status.settings);
      if (languageChanged) setLanguage(status.settings.language);
    }
    if (status.authenticated) await startSession();
  } catch {
    splash.classList.add('hidden');
    showOffline();
    toast(t('Could not reach the server. Retrying shortly.'), 'error');
    bootRetry = setTimeout(boot, 5000);
    return;
  }
  splash.classList.add('hidden');
  setTimeout(() => splash.remove(), 400);
  renderApp();
}

subscribe((event, payload) => {
  if (['activity', 'conversations', 'message', 'messages', 'notification'].includes(event)) updateBadges();
  if (event === 'message' && payload?.created && payload.message?.id) showMessageBanner(payload.conversationId, payload.message);
});

// A language change re-renders every screen with the new strings.
onSettingsChange((next, changed) => {
  if (changed?.language && next.language !== document.documentElement.lang.slice(0, 2)) {
    setLanguage(next.language);
    if (shell) { resetNavigation(); shell = null; renderApp(); }
  }
});

// Android's install prompt is kept so Settings can offer "Install app" at a good moment.
window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); state.installPrompt = event; });
window.addEventListener('appinstalled', () => { state.installPrompt = null; toast(t('Circle is installed on your home screen')); });

// Deep links from push notifications arrive through the service worker.
navigator.serviceWorker?.addEventListener('message', event => {
  if (event.data?.type === 'navigate' && typeof event.data.url === 'string' && event.data.url.startsWith('/')) navigate(event.data.url);
});

let revoking = false;
window.addEventListener('circle:auth-revoked', async () => {
  if (revoking || !state.user) return;
  revoking = true;
  const userId = state.user.id;
  setCsrf(null);
  const { resetRealtime } = await import('./realtime.js');
  resetRealtime();
  clearPrivateLocalData(userId);
  clearLocalSettings();
  resetState();
  resetNavigation();
  sessionStarted = false;
  shell = null;
  window.history.replaceState({ depth: 0 }, '', '/');
  renderApp();
  toast(t('This device was signed out. Please sign in again.'), 'error');
  revoking = false;
});

window.addEventListener('online', () => { if (!state.user && document.querySelector('.offline-screen')) boot(); });
onRouteChange(event => { if (state.user && shell) handleLocation(event); });
boot();

export { stackDepth };
