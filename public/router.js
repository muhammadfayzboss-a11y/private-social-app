const routes = [
  { pattern: /^\/$/, name: 'home' },
  { pattern: /^\/create$/, name: 'create' },
  { pattern: /^\/chat$/, name: 'chat' },
  { pattern: /^\/chat\/(\d+)$/, name: 'conversation', keys: ['conversationId'] },
  { pattern: /^\/activity$/, name: 'activity' },
  { pattern: /^\/profile$/, name: 'profile' },
  { pattern: /^\/profile\/(\d+)$/, name: 'profile', keys: ['userId'] },
  { pattern: /^\/settings$/, name: 'settings' }
];

export function currentRoute() {
  const pathname = window.location.pathname;
  for (const route of routes) {
    const match = pathname.match(route.pattern);
    if (!match) continue;
    const params = {};
    (route.keys || []).forEach((key, index) => { params[key] = match[index + 1]; });
    return { name: route.name, params, pathname };
  }
  return { name: 'home', params: {}, pathname: '/' };
}

/** How many in-app pages are behind this one; 0 means back would leave the app. */
export function historyDepth() { return Number(window.history.state?.depth || 0); }

export function navigate(path, { replace = false } = {}) {
  if (path === window.location.pathname + window.location.search) return;
  const depth = historyDepth();
  if (replace) window.history.replaceState({ depth }, '', path);
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
