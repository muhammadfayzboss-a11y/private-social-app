/**
 * URL ⇄ screen mapping. Root screens are the four tabs; everything else is pushed on top of the tab
 * it belongs to (a chat opened from the chat list keeps the list mounted underneath).
 */
import { takeOverlayEntry } from './lib/overlays.js';

const routes = [
  { pattern: /^\/$/, name: 'chats', tab: 'chats', root: true },
  { pattern: /^\/feed$/, name: 'feed', tab: 'feed', root: true },
  { pattern: /^\/activity$/, name: 'activity', tab: 'activity', root: true },
  { pattern: /^\/settings$/, name: 'settings', tab: 'settings', root: true },
  { pattern: /^\/chat\/archived$/, name: 'archived', tab: 'chats' },
  { pattern: /^\/chat\/(\d+)$/, name: 'conversation', tab: 'chats', keys: ['conversationId'] },
  { pattern: /^\/chat\/(\d+)\/info$/, name: 'chatInfo', tab: 'chats', keys: ['conversationId'] },
  { pattern: /^\/search$/, name: 'search', tab: 'chats' },
  { pattern: /^\/create$/, name: 'create', tab: 'feed' },
  { pattern: /^\/profile$/, name: 'profile', tab: 'settings' },
  { pattern: /^\/profile\/(\d+)$/, name: 'profile', tab: null, keys: ['userId'] },
  { pattern: /^\/settings\/([a-z-]+)$/, name: 'settingsPage', tab: 'settings', keys: ['page'] }
];

/** Links from older versions of the app keep working. */
const REDIRECTS = [
  { from: /^\/chat$/, to: () => '/' },
  { from: /^\/home$/, to: () => '/feed' }
];

export function matchRoute(pathname = window.location.pathname) {
  for (const route of routes) {
    const match = pathname.match(route.pattern);
    if (!match) continue;
    const params = {};
    (route.keys || []).forEach((key, index) => { params[key] = match[index + 1]; });
    return { name: route.name, tab: route.tab, root: Boolean(route.root), params, pathname };
  }
  return { name: 'chats', tab: 'chats', root: true, params: {}, pathname: '/' };
}

export function currentRoute() { return matchRoute(window.location.pathname); }

/** Rewrites legacy URLs in place (e.g. push notifications created before the redesign). */
export function normaliseLegacyUrl() {
  const { pathname, search } = window.location;
  const params = new URLSearchParams(search);
  let target = null;
  if (pathname === '/' && params.has('post')) target = `/feed?post=${encodeURIComponent(params.get('post'))}`;
  for (const redirect of REDIRECTS) if (redirect.from.test(pathname)) target = redirect.to();
  if (target) window.history.replaceState({ depth: historyDepth() }, '', target);
}

/** How many in-app pages are behind this one; 0 means back would leave the app. */
export function historyDepth() { return Number(window.history.state?.depth || 0); }

export function navigate(path, { replace = false } = {}) {
  if (path === window.location.pathname + window.location.search) return;
  // An open sheet owns the current history entry: the new page replaces it instead of stacking.
  const reuseOverlayEntry = takeOverlayEntry();
  const depth = historyDepth();
  if (replace) window.history.replaceState({ depth }, '', path);
  else if (reuseOverlayEntry) window.history.replaceState({ depth: depth + 1 }, '', path);
  else window.history.pushState({ depth: depth + 1 }, '', path);
  window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
}

/** Goes back inside the app when possible, otherwise replaces the page with `fallback`. */
export function goBack(fallback = '/') {
  if (historyDepth() > 0) window.history.back();
  else navigate(fallback, { replace: true });
}

export function onRouteChange(handler) {
  window.addEventListener('popstate', handler);
  return () => window.removeEventListener('popstate', handler);
}
