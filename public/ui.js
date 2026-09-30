import { icon } from './icons.js';
import { exactTime, relativeTime } from './lib/time.js';

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
 * Bottom sheet. Returns the backdrop element (callers use .querySelector / .remove()). Also closes
 * on Escape, on the backdrop, via [data-close-modal], and by dragging the sheet down.
 */
export function modal(content, className = '') {
  const root = document.createElement('div');
  root.className = 'modal-backdrop';
  root.innerHTML = `<section class="modal-sheet ${className}" role="dialog" aria-modal="true"><div class="sheet-handle" aria-hidden="true"></div>${content}</section>`;
  const sheet = root.querySelector('.modal-sheet');
  const previousFocus = document.activeElement;
  let closed = false;

  const finish = () => {
    if (closed) return;
    closed = true;
    openSheets = Math.max(0, openSheets - 1);
    if (!openSheets) document.documentElement.classList.remove('sheet-open');
    document.removeEventListener('keydown', onKey);
    root.dispatchEvent(new CustomEvent('sheet:closed'));
    if (previousFocus?.isConnected && typeof previousFocus.focus === 'function' && !previousFocus.matches?.('textarea, input')) previousFocus.focus({ preventScroll: true });
  };
  const nativeRemove = root.remove.bind(root);
  root.remove = () => { finish(); nativeRemove(); };
  root.close = () => {
    if (closed) return;
    root.classList.remove('open');
    finish();
    setTimeout(nativeRemove, 220);
  };
  const onKey = event => { if (event.key === 'Escape') root.close(); };

  root.addEventListener('click', event => { if (event.target === root || event.target.closest('[data-close-modal]')) root.close(); });
  document.addEventListener('keydown', onKey);

  // Drag down to dismiss, starting from the handle or the sheet's top area when it is scrolled to the top.
  let drag = null;
  sheet.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' || sheet.scrollTop > 0 || event.target.closest('input, textarea, button, [data-no-drag]')) return;
    drag = { y: event.clientY, dy: 0 };
  });
  sheet.addEventListener('pointermove', event => {
    if (!drag) return;
    drag.dy = Math.max(0, event.clientY - drag.y);
    sheet.style.transition = 'none';
    sheet.style.transform = `translateY(${drag.dy}px)`;
  }, { passive: true });
  const release = () => {
    if (!drag) return;
    const { dy } = drag; drag = null;
    sheet.style.transition = '';
    sheet.style.transform = '';
    if (dy > 90) root.close();
  };
  sheet.addEventListener('pointerup', release);
  sheet.addEventListener('pointercancel', release);

  openSheets += 1;
  document.documentElement.classList.add('sheet-open');
  document.body.append(root);
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
    actions: [{ id: 'confirm', label: confirm, danger }, { id: 'cancel', label: 'Cancel' }]
  });
  return result === 'confirm';
}

const REACTION_ICONS = { heart: 'heart', laugh: 'laugh', wow: 'wow', sad: 'sad', fire: 'fire', celebrate: 'celebrate' };
export const REACTION_LABELS = { heart: 'Love', laugh: 'Haha', wow: 'Wow', sad: 'Sad', fire: 'Fire', celebrate: 'Celebrate' };
/** Reactions use the SVG icon set rather than emoji so they stay consistent across every platform. */
export function reactionIcon(name, size = 18, filled = true) {
  return `<span class="reaction-icon reaction-${escapeHtml(name)}">${icon(REACTION_ICONS[name] || 'heart', size, filled)}</span>`;
}
