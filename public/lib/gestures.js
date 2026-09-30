/**
 * Touch gestures built on pointer events, delegated from one container so re-rendered children never
 * accumulate listeners. Both gestures cancel as soon as the finger moves like a scroll.
 */

/** Long press (and right-click / context menu) on elements matching `selector`. */
export function onLongPress(root, selector, handler, { delay = 430 } = {}) {
  let timer = null; let origin = null; let target = null; let fired = false;
  const clear = () => { clearTimeout(timer); timer = null; target = null; };
  const down = event => {
    if (event.button > 0) return;
    const element = event.target.closest(selector);
    if (!element || !root.contains(element)) return;
    fired = false;
    target = element;
    origin = { x: event.clientX, y: event.clientY };
    timer = setTimeout(() => {
      fired = true;
      navigator.vibrate?.(8);
      handler(target, event);
      clear();
    }, delay);
  };
  const move = event => { if (timer && origin && Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 8) clear(); };
  const context = event => {
    const element = event.target.closest(selector);
    if (!element || !root.contains(element)) return;
    event.preventDefault();
    if (!fired) handler(element, event);
    clear();
  };
  // Swallow the click that follows a long press so it does not also "tap" the element.
  const click = event => { if (fired) { event.preventDefault(); event.stopPropagation(); fired = false; } };
  root.addEventListener('pointerdown', down);
  root.addEventListener('pointermove', move, { passive: true });
  for (const type of ['pointerup', 'pointercancel', 'pointerleave']) root.addEventListener(type, clear);
  root.addEventListener('contextmenu', context);
  root.addEventListener('click', click, true);
  return () => {
    clear();
    root.removeEventListener('pointerdown', down);
    root.removeEventListener('pointermove', move);
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) root.removeEventListener(type, clear);
    root.removeEventListener('contextmenu', context);
    root.removeEventListener('click', click, true);
  };
}

/** Horizontal swipe to the left on `selector`; the element follows the finger and snaps back. */
export function onSwipeLeft(root, selector, handler, { threshold = 64 } = {}) {
  let state = null;
  const down = event => {
    if (event.pointerType === 'mouse') return;
    const element = event.target.closest(selector);
    if (!element || !root.contains(element)) return;
    state = { element, x: event.clientX, y: event.clientY, dx: 0, locked: null };
  };
  const move = event => {
    if (!state) return;
    const dx = event.clientX - state.x; const dy = event.clientY - state.y;
    if (state.locked === null && Math.hypot(dx, dy) > 10) state.locked = Math.abs(dx) > Math.abs(dy) * 1.4 && dx < 0 ? 'x' : 'y';
    if (state.locked !== 'x') return;
    state.dx = Math.max(-threshold * 1.4, Math.min(0, dx));
    state.element.style.transform = `translateX(${state.dx}px)`;
    state.element.classList.toggle('swipe-armed', state.dx <= -threshold);
  };
  const up = () => {
    if (!state) return;
    const { element, dx, locked } = state;
    state = null;
    if (locked !== 'x') return;
    element.style.transition = 'transform .18s ease';
    element.style.transform = '';
    element.classList.remove('swipe-armed');
    setTimeout(() => { element.style.transition = ''; }, 200);
    if (dx <= -threshold) { navigator.vibrate?.(6); handler(element); }
  };
  root.addEventListener('pointerdown', down, { passive: true });
  root.addEventListener('pointermove', move, { passive: true });
  root.addEventListener('pointerup', up);
  root.addEventListener('pointercancel', up);
  return () => {
    root.removeEventListener('pointerdown', down);
    root.removeEventListener('pointermove', move);
    root.removeEventListener('pointerup', up);
    root.removeEventListener('pointercancel', up);
  };
}
