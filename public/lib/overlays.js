/**
 * Makes sheets, viewers, and modes (selection, in-chat search) respond to the Android back button
 * and back gestures the way native apps do: back closes the top overlay instead of leaving the page.
 *
 * Opening an overlay pushes a history entry marked with its id. Closing it from the UI pops that
 * entry (deferred one tick so a navigation triggered from inside the sheet can reuse it instead).
 */
const stack = [];
let sequence = 0;
let pendingBack = null;
let swallowPops = 0;

export function openOverlay(close) {
  const id = ++sequence;
  stack.push({ id, close });
  // An action sheet often hands directly to another mode (message menu → selection, attachment
  // menu → preview). The first overlay has scheduled its history cleanup but the new one opens in
  // the same tick; replace that entry instead of stacking a dead same-URL history step.
  if (pendingBack && window.history.state?.overlay) {
    clearTimeout(pendingBack);
    pendingBack = null;
    window.history.replaceState({ ...(window.history.state || {}), overlay: id }, '', window.location.href);
  } else {
    window.history.pushState({ ...(window.history.state || {}), overlay: id }, '', window.location.href);
  }
  return id;
}

/** Called when the UI itself closes the overlay (tap outside, close button, action chosen). */
export function closeOverlay(id) {
  const index = stack.findIndex(entry => entry.id === id);
  if (index < 0) return;
  stack.splice(index, 1);
  clearTimeout(pendingBack);
  pendingBack = setTimeout(() => {
    pendingBack = null;
    if (window.history.state?.overlay === id) { swallowPops += 1; window.history.back(); }
  }, 0);
}

/**
 * Called first on every popstate. Returns true when the event belonged to an overlay (so the
 * router must not treat it as page navigation).
 */
export function consumeOverlayPop() {
  if (swallowPops > 0) { swallowPops -= 1; return true; }
  const top = stack.at(-1);
  if (top && window.history.state?.overlay !== top.id) {
    stack.pop();
    try { top.close({ fromHistory: true }); } catch (error) { console.error('Overlay close failed', error); }
    return true;
  }
  return false;
}

/**
 * Navigation started while an overlay's history entry is current: cancel the pending "back" and
 * let the new page replace that entry, closing any overlays still registered.
 */
export function takeOverlayEntry() {
  const onOverlayEntry = Boolean(window.history.state?.overlay);
  if (pendingBack) { clearTimeout(pendingBack); pendingBack = null; }
  if (!onOverlayEntry) return false;
  while (stack.length) {
    const entry = stack.pop();
    try { entry.close({ fromHistory: true }); } catch { /* already closed */ }
  }
  return true;
}

export function hasOverlays() { return stack.length > 0; }
