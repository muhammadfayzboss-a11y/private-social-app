/**
 * Native-style navigation stack.
 *
 * - Four tab roots (Chats, Feed, Activity, Settings) are created once and kept alive, so switching
 *   tabs is instant and keeps scroll position and state.
 * - Other screens are pushed on top of the current tab with a slide; the screen underneath stays
 *   mounted, so going back is instant and nothing re-renders or flashes.
 * - An edge swipe from the left drags the top screen away (standalone mode, where there is no
 *   browser gesture to conflict with) and completes as a real history "back".
 */
import { goBack, historyDepth, matchRoute } from '../router.js';
import { consumeOverlayPop } from './overlays.js';

const ROOT_PATHS = { chats: '/', feed: '/feed', activity: '/activity', settings: '/settings' };
const roots = new Map();
let stack = [];
let activeTab = null;
let lastDepth = 0;
let views = {};
let container = null;
let onRoute = () => {};
let skipAnimation = false;
let busy = null;

const motionOff = () => document.documentElement.dataset.motion === 'off';
const DURATION = 280;

export function initNavigation({ host, renderers, onChange }) {
  container = host;
  views = renderers;
  onRoute = onChange;
  lastDepth = historyDepth();
  enableEdgeSwipe();
}

function top() { return stack.at(-1) || roots.get(activeTab) || null; }
export function topScreen() { return top(); }
export function stackDepth() { return stack.length; }
export function currentTab() { return activeTab; }

function screenApi(entry) {
  return {
    element: entry.element,
    path: entry.path,
    isActive: () => top() === entry && !entry.element.classList.contains('tab-hidden'),
    onShow: fn => entry.element.addEventListener('screen:show', fn),
    onHide: fn => entry.element.addEventListener('screen:hide', fn)
  };
}

function createScreen(route, path, { root = false } = {}) {
  const element = document.createElement('section');
  element.className = `screen screen-${route.name}${root ? ' screen-root' : ' screen-pushed'}`;
  element.dataset.path = path;
  const entry = { element, route, path, cleanup: null };
  container.append(element);
  try {
    entry.cleanup = views[route.name]?.(element, route.params, screenApi(entry)) || null;
  } catch (error) {
    console.error('Screen failed to render', route.name, error);
    element.innerHTML = '<div class="screen-error"><p>Something went wrong.</p><button class="button" data-reload>Reload</button></div>';
    element.querySelector('[data-reload]').addEventListener('click', () => window.location.reload());
  }
  return entry;
}

function destroy(entry) {
  try { entry.cleanup?.(); } catch (error) { console.error('Screen cleanup failed', error); }
  entry.element.remove();
}

function fire(entry, type) { entry?.element.dispatchEvent(new CustomEvent(type)); }

function animate(element, className) {
  return new Promise(resolve => {
    if (motionOff()) return resolve();
    element.classList.add(className);
    const done = () => { element.classList.remove(className); resolve(); };
    const timer = setTimeout(done, DURATION + 80);
    element.addEventListener('animationend', () => { clearTimeout(timer); done(); }, { once: true });
  });
}

function switchTab(tab, { fade = true } = {}) {
  let entry = roots.get(tab);
  const previous = roots.get(activeTab);
  if (!entry) {
    const path = ROOT_PATHS[tab];
    entry = createScreen(matchRoute(path), path, { root: true });
    roots.set(tab, entry);
  }
  if (previous && previous !== entry) { previous.element.classList.add('tab-hidden'); fire(previous, 'screen:hide'); }
  entry.element.classList.remove('tab-hidden', 'covered');
  const changed = activeTab !== tab;
  activeTab = tab;
  if (changed && fade && previous) animate(entry.element, 'tab-enter');
  if (changed || !previous) fire(entry, 'screen:show');
  return entry;
}

async function push(route, path, { animated }) {
  const previous = top();
  const entry = createScreen(route, path);
  stack.push(entry);
  fire(previous, 'screen:hide');
  fire(entry, 'screen:show');
  if (animated && previous) await Promise.all([animate(entry.element, 'enter-push'), animate(previous.element, 'leave-push')]);
  if (previous && top() === entry) previous.element.classList.add('covered');
}

async function popTo(index, { animated }) {
  const removing = stack.splice(index + 1);
  if (!removing.length) return;
  const target = index >= 0 ? stack[index] : roots.get(activeTab);
  const leaving = removing.pop();
  removing.forEach(destroy);
  target.element.classList.remove('covered');
  fire(leaving, 'screen:hide');
  fire(target, 'screen:show');
  if (animated) await Promise.all([animate(leaving.element, 'leave-pop'), animate(target.element, 'enter-pop')]);
  destroy(leaving);
}

function replaceTop(route, path) {
  const old = stack.pop();
  const below = top();
  const entry = createScreen(route, path);
  stack.push(entry);
  if (old) destroy(old);
  below?.element.classList.add('covered');
  fire(entry, 'screen:show');
}

/** Renders whatever the current URL describes, animating in the direction history moved. */
export async function handleLocation(event) {
  if (event?.type === 'popstate' && consumeOverlayPop()) return;
  await busy;
  const route = matchRoute(window.location.pathname);
  const path = window.location.pathname + window.location.search;
  const depth = historyDepth();
  const direction = depth > lastDepth ? 'forward' : depth < lastDepth ? 'back' : 'replace';
  lastDepth = depth;
  const animated = !skipAnimation && !motionOff() && roots.size > 0;
  skipAnimation = false;

  busy = (async () => {
    if (route.root) {
      if (stack.length) {
        if (activeTab === route.tab) await popTo(-1, { animated: animated && direction !== 'forward' });
        else { stack.splice(0).forEach(destroy); }
      }
      const entry = switchTab(route.tab, { fade: animated });
      if (entry.path !== path) { entry.path = path; fire(entry, 'screen:params'); }
    } else {
      const tab = route.tab || activeTab || 'chats';
      if (activeTab !== tab || !roots.has(tab)) {
        stack.splice(0).forEach(destroy);
        switchTab(tab, { fade: false });
      }
      const index = stack.findIndex(entry => entry.path === path);
      if (index >= 0 && index === stack.length - 1) { /* already showing */ }
      else if (index >= 0) await popTo(index, { animated: animated && direction === 'back' });
      else if (direction === 'replace' && stack.length) replaceTop(route, path);
      else await push(route, path, { animated: animated && direction !== 'back' });
    }
  })();
  await busy;
  busy = null;
  onRoute(route, { depth: stack.length, tab: activeTab });
}

/** Drops every screen (sign-out, language change). */
export function resetNavigation() {
  stack.splice(0).forEach(destroy);
  for (const entry of roots.values()) destroy(entry);
  roots.clear();
  activeTab = null;
}

/** Scrolls the active tab root to the top, or pops back to it if screens are stacked on top. */
export function scrollActiveRootToTop() {
  const entry = roots.get(activeTab);
  entry?.element.querySelector('.screen-scroll')?.scrollTo({ top: 0, behavior: motionOff() ? 'auto' : 'smooth' });
}

/* ------------------------------ edge swipe ------------------------------ */

function enableEdgeSwipe() {
  // In a regular iOS Safari tab the browser owns the edge gesture; only take it over when installed.
  const iosBrowser = /iP(hone|ad|od)/.test(navigator.userAgent) && !window.navigator.standalone;
  if (iosBrowser) return;
  let drag = null;
  container.addEventListener('pointerdown', event => {
    if (event.pointerType !== 'touch' || !stack.length || busy || event.clientX > 24) return;
    const current = stack.at(-1);
    const below = stack.at(-2) || roots.get(activeTab);
    drag = { current, below, x: event.clientX, y: event.clientY, dx: 0, locked: null, at: performance.now() };
  }, { passive: true });
  container.addEventListener('pointermove', event => {
    if (!drag) return;
    const dx = event.clientX - drag.x; const dy = event.clientY - drag.y;
    if (drag.locked === null && Math.hypot(dx, dy) > 8) {
      drag.locked = dx > Math.abs(dy) ? 'x' : 'y';
      if (drag.locked === 'x') {
        drag.below.element.classList.remove('covered');
        drag.below.element.classList.add('peek');
        drag.current.element.classList.add('dragging');
      }
    }
    if (drag.locked !== 'x') return;
    drag.dx = Math.max(0, dx);
    const width = window.innerWidth;
    drag.current.element.style.transform = `translateX(${drag.dx}px)`;
    drag.below.element.style.transform = `translateX(${-25 + (drag.dx / width) * 25}%)`;
  }, { passive: true });
  const end = () => {
    if (!drag) return;
    const { current, below, dx, locked, at } = drag;
    drag = null;
    if (locked !== 'x') return;
    const width = window.innerWidth;
    const fast = dx > 60 && dx / Math.max(1, performance.now() - at) > 0.6;
    const complete = dx > width * 0.35 || fast;
    current.element.classList.remove('dragging');
    current.element.classList.add('settling');
    below.element.classList.add('settling');
    current.element.style.transform = complete ? 'translateX(100%)' : '';
    below.element.style.transform = complete ? 'translateX(0)' : '';
    setTimeout(() => {
      current.element.classList.remove('settling');
      below.element.classList.remove('settling', 'peek');
      below.element.style.transform = '';
      if (complete) {
        skipAnimation = true;
        current.element.style.visibility = 'hidden';
        goBack(ROOT_PATHS[activeTab] || '/');
      } else {
        current.element.style.transform = '';
        below.element.classList.add('covered');
      }
    }, 220);
  };
  container.addEventListener('pointerup', end);
  container.addEventListener('pointercancel', end);
}
