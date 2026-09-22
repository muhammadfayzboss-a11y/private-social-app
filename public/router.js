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

export function navigate(path, { replace = false } = {}) {
  if (path === window.location.pathname) return;
  if (replace) window.history.replaceState({}, '', path);
  else window.history.pushState({}, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function onRouteChange(handler) {
  window.addEventListener('popstate', handler);
  return () => window.removeEventListener('popstate', handler);
}
