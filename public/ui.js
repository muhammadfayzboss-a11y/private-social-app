import { icon } from './icons.js';
import { exactTime, relativeTime } from './lib/time.js';
import { closeOverlay, openOverlay } from './lib/overlays.js';
import { t } from './lib/i18n.js';

export function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[ch]));
}

export function avatar(user, size = 'md') {
  return user?.avatarUrl
    ? `<img class="avatar avatar-${size}" src="${escapeHtml(user.avatarUrl)}" alt="" loading="lazy" decoding="async">`
    : `<span class="avatar avatar-${size} avatar-fallback" data-hue="${Number(user?.id || 0) % 7}" aria-hidden="true">${escapeHtml((user?.displayName || user?.username || '?').slice(0, 1).toUpperCase())}</span>`;
}

/** Kept for existing callers; delegates to the timezone-safe formatter. */
export function timeAgo(value) { return relativeTime(value); }
export function fullTime(value) { return exactTime(value); }

function dimensions(media) {
  return media?.width && media?.height ? ` width="${Number(media.width)}" height="${Number(media.height)}" style="aspect-ratio:${Number(media.width)}/${Number(media.height)}"` : '';
}

export function mediaView(media, className = 'post-media') {
  if (!media) return '';
  const type = media.mimeType || '';
  if (type.startsWith('video/')) return `<video class="${className}" src="${escapeHtml(media.url)}" controls playsinline preload="metadata"${dimensions(media)}></video>`;
  if (type.startsWith('audio/')) return `<audio class="message-audio" src="${escapeHtml(media.url)}" controls preload="none"></audio>`;
  return `<img class="${className}" src="${escapeHtml(media.url)}" alt="Shared media" loading="lazy" decoding="async"${dimensions(media)}>`;
}

export function spinner(label = 'Loading') {
  return `<div class="loading" role="status"><span class="spinner"></span><span>${escapeHtml(label)}</span></div>`;
}

export function skeleton(count = 3) {
  return `<div class="skeleton-list" aria-hidden="true">${Array.from({ length: count }, () => '<div class="skeleton-card"><i></i><span></span><span></span></div>').join('')}</div>`;
}

export function listSkeleton(count = 6) {
  return `<div class="skeleton-rows" aria-hidden="true">${Array.from({ length: count }, (_, index) => `<div class="skeleton-row"><i></i><div><span style="width:${45 + (index * 17) % 35}%"></span><span style="width:${60 + (index * 23) % 30}%"></span></div></div>`).join('')}</div>`;
}

export function emptyState(iconName, title, text, action = '') {
  return `<div class="empty-state"><span class="empty-icon">${icon(iconName, 30)}</span><h3>${escapeHtml(title)}</h3><p>${escapeHtml(text)}</p>${action}</div>`;
}

export function toast(message, type = 'info') {
  const region = document.querySelector('#toast-region');
  if (!region) return;
  // Identical toasts in quick succession collapse into one.
  if ([...region.children].some(item => item.textContent === message)) return;
  const item = document.createElement('div');
  item.className = `toast toast-${type}`;
  item.setAttribute('role', type === 'error' ? 'alert' : 'status');
  item.textContent = message;
  region.append(item);
  requestAnimationFrame(() => item.classList.add('show'));
  setTimeout(() => { item.classList.remove('show'); setTimeout(() => item.remove(), 250); }, type === 'error' ? 4200 : 2600);
}

let openSheets = 0;

/**
 * Bottom sheet. Returns the backdrop element (callers use .querySelector / .close()). Closes on
 * Escape, the backdrop, [data-close-modal], dragging the sheet down, and the Android back button.
 */
export function modal(content, className = '') {
  const root = document.createElement('div');
  root.className = 'modal-backdrop';
  root.innerHTML = `<section class="modal-sheet ${className}" role="dialog" aria-modal="true"><div class="sheet-handle" aria-hidden="true"></div>${content}</section>`;
  const sheet = root.querySelector('.modal-sheet');
  const previousFocus = document.activeElement;
  let closed = false;
  let overlayId = null;

  const finish = ({ fromHistory = false } = {}) => {
    if (closed) return false;
    closed = true;
    openSheets = Math.max(0, openSheets - 1);
    if (!openSheets) document.documentElement.classList.remove('sheet-open');
    document.removeEventListener('keydown', onKey);
    if (!fromHistory) closeOverlay(overlayId);
    root.dispatchEvent(new CustomEvent('sheet:closed'));
    if (previousFocus?.isConnected && typeof previousFocus.focus === 'function' && !previousFocus.matches?.('textarea, input')) previousFocus.focus({ preventScroll: true });
    return true;
  };
  const nativeRemove = root.remove.bind(root);
  const animateOut = () => { root.classList.remove('open'); root.classList.add('closing'); setTimeout(nativeRemove, 220); };
  root.remove = () => { finish(); nativeRemove(); };
  root.close = () => { if (finish()) animateOut(); };
  const onKey = event => { if (event.key === 'Escape') root.close(); };

  root.addEventListener('click', event => { if (event.target === root || event.target.closest('[data-close-modal]')) root.close(); });
  document.addEventListener('keydown', onKey);

  // Drag down to dismiss, from anywhere on the sheet while it is scrolled to the top.
  let drag = null;
  sheet.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' || sheet.scrollTop > 0 || event.target.closest('input, textarea, [data-no-drag], .voice-wave')) return;
    drag = { y: event.clientY, dy: 0, at: performance.now() };
  });
  sheet.addEventListener('pointermove', event => {
    if (!drag) return;
    drag.dy = Math.max(0, event.clientY - drag.y);
    if (drag.dy < 6) return;
    sheet.style.transition = 'none';
    sheet.style.transform = `translateY(${drag.dy}px)`;
  }, { passive: true });
  const release = () => {
    if (!drag) return;
    const { dy, at } = drag; drag = null;
    const fast = dy > 40 && dy / Math.max(1, performance.now() - at) > 0.5;
    sheet.style.transition = '';
    sheet.style.transform = '';
    if (dy > 110 || fast) root.close();
  };
  sheet.addEventListener('pointerup', release);
  sheet.addEventListener('pointercancel', release);

  openSheets += 1;
  document.documentElement.classList.add('sheet-open');
  document.body.append(root);
  overlayId = openOverlay(() => { if (finish({ fromHistory: true })) animateOut(); });
  requestAnimationFrame(() => root.classList.add('open'));
  return root;
}

/**
 * A list of actions in a sheet. Resolves with the chosen action id, or null if dismissed.
 * `actions`: [{ id, label, icon, danger, hint }]; `header` is optional trusted markup.
 */
export function actionSheet({ title = '', header = '', actions = [] }) {
  return new Promise(resolve => {
    let chosen = null;
    const sheet = modal(`
      ${title ? `<div class="modal-head"><h2>${escapeHtml(title)}</h2></div>` : ''}
      ${header}
      <div class="action-list">${actions.map(action => `
        <button class="action-item${action.danger ? ' danger' : ''}" data-sheet-action="${escapeHtml(action.id)}">
          ${action.icon ? icon(action.icon, 21) : ''}<span>${escapeHtml(action.label)}</span>${action.hint ? `<small>${escapeHtml(action.hint)}</small>` : ''}
        </button>`).join('')}</div>`, 'action-sheet');
    sheet.addEventListener('click', event => {
      const button = event.target.closest('[data-sheet-action]');
      if (!button) return;
      chosen = button.dataset.sheetAction;
      sheet.close();
    });
    sheet.addEventListener('sheet:closed', () => resolve(chosen), { once: true });
  });
}

export async function confirmSheet({ title, text = '', confirm = 'Confirm', danger = true }) {
  const result = await actionSheet({
    title,
    header: text ? `<p class="sheet-text">${escapeHtml(text)}</p>` : '',
    actions: [{ id: 'confirm', label: confirm, danger }, { id: 'cancel', label: t('Cancel') }]
  });
  return result === 'confirm';
}

const REACTION_ICONS = { heart: 'heart', laugh: 'laugh', wow: 'wow', sad: 'sad', fire: 'fire', celebrate: 'celebrate' };
export const REACTION_LABELS = { heart: 'Love', laugh: 'Haha', wow: 'Wow', sad: 'Sad', fire: 'Fire', celebrate: 'Celebrate' };
/** Reactions use the SVG icon set rather than emoji so they stay consistent across every platform. */
export function reactionIcon(name, size = 18, filled = true) {
  return `<span class="reaction-icon reaction-${escapeHtml(name)}">${icon(REACTION_ICONS[name] || 'heart', size, filled)}</span>`;
}

/* ------------------------------- screen chrome ------------------------------- */

/**
 * Top bar used by every screen: optional back button, centred or leading title with subtitle,
 * and trailing actions. `data-back` buttons are handled globally (history-aware).
 */
export function topBar({ title = '', subtitle = '', back = null, leading = '', actions = '', className = '', titleId = '' } = {}) {
  return `<header class="topbar ${className}">
    ${back !== null ? `<button class="icon-button topbar-back" data-back="${escapeHtml(back)}" aria-label="${t('Back')}">${icon('back', 26)}</button>` : leading}
    <div class="topbar-title"${titleId ? ` id="${titleId}"` : ''}><strong>${title}</strong>${subtitle ? `<small>${subtitle}</small>` : ''}</div>
    <div class="topbar-actions">${actions}</div>
  </header>`;
}

/** Coloured square icon used by settings rows, as in native settings apps. */
export function tile(iconName, color) {
  return `<span class="tile" style="--tile:${color}">${icon(iconName, 18)}</span>`;
}

/**
 * A grouped list row. `value` shows on the right; `toggle` renders a switch; `href` navigates.
 */
export function row({ iconName = '', color = '#8e8e93', label, hint = '', value = '', toggle = null, action = '', href = '', danger = false, chevron = true, attrs = '' }) {
  const control = toggle !== null ? `<i class="switch${toggle ? ' on' : ''}" role="switch" aria-checked="${Boolean(toggle)}"></i>` : `${value ? `<span class="row-value">${value}</span>` : ''}${chevron && (href || action) && !danger ? `<span class="row-chevron">${icon('chevron', 18)}</span>` : ''}`;
  return `<button class="row${danger ? ' danger' : ''}" ${href ? `data-href="${escapeHtml(href)}"` : ''} ${action ? `data-row="${escapeHtml(action)}"` : ''} ${attrs}>
    ${iconName ? tile(iconName, color) : ''}
    <span class="row-text"><span class="row-label">${label}</span>${hint ? `<small>${hint}</small>` : ''}</span>
    ${control}
  </button>`;
}

export function group(rows, { title = '', footer = '' } = {}) {
  return `<section class="group">${title ? `<h3 class="group-title">${title}</h3>` : ''}<div class="group-body">${rows.join('')}</div>${footer ? `<p class="group-footer">${footer}</p>` : ''}</section>`;
}

/** Safe-area insets in px (notch, home indicator), measured from a probe element. */
let safeProbe = null;
export function safeAreaInsets() {
  if (!safeProbe) {
    safeProbe = document.createElement('div');
    safeProbe.style.cssText = 'position:fixed;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    document.body.append(safeProbe);
  }
  const style = getComputedStyle(safeProbe);
  return { top: parseFloat(style.paddingTop) || 0, bottom: parseFloat(style.paddingBottom) || 0, left: parseFloat(style.paddingLeft) || 0, right: parseFloat(style.paddingRight) || 0 };
}
