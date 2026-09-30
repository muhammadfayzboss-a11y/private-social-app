/**
 * Pull-to-refresh for a screen's scroll container (the browser's own is disabled app-wide so it
 * never reloads the PWA by accident). Only starts when the list is already at the very top.
 */
export function enablePullToRefresh(scroller, onRefresh) {
  const indicator = document.createElement('div');
  indicator.className = 'pull-indicator';
  indicator.innerHTML = '<span class="spinner"></span>';
  scroller.prepend(indicator);
  let start = null; let distance = 0; let refreshing = false;
  const threshold = 70;
  const reset = () => { indicator.style.transform = ''; indicator.style.opacity = ''; indicator.classList.remove('armed'); scroller.classList.remove('pulling'); };
  scroller.addEventListener('touchstart', event => {
    if (refreshing || scroller.scrollTop > 0 || event.touches.length !== 1) return;
    start = event.touches[0].clientY; distance = 0;
  }, { passive: true });
  scroller.addEventListener('touchmove', event => {
    if (start === null) return;
    distance = event.touches[0].clientY - start;
    if (distance <= 0 || scroller.scrollTop > 0) { if (distance < -5) start = null; return; }
    const pull = Math.min(110, distance * 0.5);
    scroller.classList.add('pulling');
    indicator.style.opacity = String(Math.min(1, pull / threshold));
    indicator.style.transform = `translateY(${pull}px) rotate(${pull * 3}deg)`;
    indicator.classList.toggle('armed', pull >= threshold);
  }, { passive: true });
  scroller.addEventListener('touchend', async () => {
    if (start === null) return;
    start = null;
    const armed = indicator.classList.contains('armed');
    if (!armed) return reset();
    refreshing = true;
    navigator.vibrate?.(8);
    indicator.classList.add('refreshing');
    indicator.style.transform = `translateY(${threshold}px)`;
    try { await onRefresh(); } catch { /* the view shows its own error */ }
    refreshing = false;
    indicator.classList.remove('refreshing');
    reset();
  });
}
