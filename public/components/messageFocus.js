/**
 * Long-press focus menu: the pressed message is lifted above a dimmed, blurred backdrop with a
 * reaction bar above it and the action menu below — shifting everything up when the message sits
 * low on screen, as native messengers do. Back button / tap outside closes it.
 */
import { icon } from '../icons.js';
import { closeOverlay, openOverlay } from '../lib/overlays.js';
import { exactTime } from '../lib/time.js';
import { t } from '../lib/i18n.js';
import { escapeHtml, modal, safeAreaInsets } from '../ui.js';
import { QUICK_REACTIONS, recentEmoji, rememberEmoji } from './emojiPanel.js';

export function openMessageFocus({ row, message, header = '', actions, myReaction = null, onReact, onAction }) {
  const bubble = row.querySelector('.message-bubble') || row;
  const rowRect = row.getBoundingClientRect();
  const bubbleRect = bubble.getBoundingClientRect();
  const viewportHeight = window.visualViewport?.height || window.innerHeight;
  const insets = safeAreaInsets();
  const safeTop = 12 + insets.top;

  const overlay = document.createElement('div');
  overlay.className = 'focus-overlay';
  overlay.innerHTML = `
    <div class="focus-backdrop" data-dismiss></div>
    <div class="focus-stage">
      <div class="reaction-bar focus-reactions${message.isMine ? ' mine' : ''}" role="group" aria-label="${t('React')}">
        ${QUICK_REACTIONS.map(emoji => `<button type="button" data-react="${emoji}" class="${myReaction === emoji ? 'selected' : ''}" aria-label="${t('React')} ${emoji}">${emoji}</button>`).join('')}
        <button type="button" class="more-reactions" data-more-reactions aria-label="${t('More reactions')}">${icon('plus', 18)}</button>
      </div>
      <div class="focus-message messages-inner"></div>
      <div class="focus-menu${message.isMine ? ' mine' : ''}" role="menu">
        ${header}
        <p class="focus-time">${icon('clock', 13)} ${escapeHtml(exactTime(message.createdAt))}${message.editedAt ? ` · ${t('edited')}` : ''}</p>
        ${actions.map(action => `<button type="button" role="menuitem" class="focus-action${action.danger ? ' danger' : ''}" data-action-id="${action.id}">${icon(action.icon, 20)}<span>${escapeHtml(action.label)}</span></button>`).join('')}
      </div>
    </div>`;

  const stage = overlay.querySelector('.focus-stage');
  const holder = overlay.querySelector('.focus-message');
  const bar = overlay.querySelector('.focus-reactions');
  const menu = overlay.querySelector('.focus-menu');
  const clone = row.cloneNode(true);
  clone.classList.remove('highlight');
  clone.querySelectorAll('video').forEach(video => video.removeAttribute('autoplay'));
  holder.append(clone);
  holder.style.left = `${rowRect.left}px`;
  holder.style.width = `${rowRect.width}px`;
  holder.style.top = `${rowRect.top}px`;
  const maxHeight = Math.max(120, viewportHeight * 0.42);
  if (rowRect.height > maxHeight) { holder.style.maxHeight = `${maxHeight}px`; holder.classList.add('clamped'); }
  document.body.append(overlay);
  document.documentElement.classList.add('focus-open');

  // Place the reaction bar above the bubble and the menu below it, then shift the whole stage up if
  // the menu would run off the bottom of the screen.
  const barHeight = bar.offsetHeight;
  const menuHeight = menu.offsetHeight;
  const bubbleHeight = Math.min(bubbleRect.height, maxHeight);
  let top = bubbleRect.top;
  const bottomLimit = viewportHeight - 16 - insets.bottom;
  if (top + bubbleHeight + 8 + menuHeight > bottomLimit) top = bottomLimit - menuHeight - 8 - bubbleHeight;
  if (top - barHeight - 8 < safeTop) top = safeTop + barHeight + 8;
  const shift = top - bubbleRect.top;
  const side = message.isMine ? 'right' : 'left';
  const edge = message.isMine ? window.innerWidth - bubbleRect.right : bubbleRect.left;
  bar.style[side] = `${Math.max(8, Math.min(edge, window.innerWidth - bar.offsetWidth - 8))}px`;
  menu.style[side] = `${Math.max(8, Math.min(edge, window.innerWidth - menu.offsetWidth - 8))}px`;
  bar.style.top = `${top - barHeight - 8}px`;
  menu.style.top = `${top + bubbleHeight + 8}px`;
  requestAnimationFrame(() => {
    overlay.classList.add('open');
    holder.style.transform = `translateY(${shift}px) scale(1.02)`;
  });
  navigator.vibrate?.(10);

  let closed = false;
  let overlayId = null;
  const close = ({ fromHistory = false } = {}) => {
    if (closed) return;
    closed = true;
    if (!fromHistory) closeOverlay(overlayId);
    overlay.classList.remove('open');
    overlay.classList.add('closing');
    holder.style.transform = '';
    document.documentElement.classList.remove('focus-open');
    setTimeout(() => overlay.remove(), 200);
  };
  overlayId = openOverlay(() => close({ fromHistory: true }));

  overlay.addEventListener('click', event => {
    if (event.target.closest('[data-dismiss]') || event.target === stage) return close();
    const reaction = event.target.closest('[data-react]');
    if (reaction) { close(); rememberEmoji(reaction.dataset.react); return onReact(reaction.dataset.react === myReaction ? '' : reaction.dataset.react); }
    if (event.target.closest('[data-more-reactions]')) { close(); return openReactionPicker(myReaction, onReact); }
    const action = event.target.closest('[data-action-id]');
    if (action) { close(); onAction(action.dataset.actionId); }
  });
  stage.addEventListener('click', event => { if (event.target === stage || event.target === holder) close(); });
  return { close };
}

/** Full emoji choice for reactions (the "+" at the end of the quick reaction bar). */
export function openReactionPicker(current, onReact) {
  const all = [...new Set([...recentEmoji(), '👍', '👎', '❤️', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱', '🤬', '😢', '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡', '🥱', '🥴', '😍', '🐳', '❤️‍🔥', '🌚', '🌭', '💯', '🤣', '⚡', '🍌', '🏆', '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕', '😈', '😴', '😭', '🤓', '👻', '👀', '🎃', '🙈', '😇', '😨', '🤝', '✍️', '🤗', '🫡', '🎅', '🎄', '☃️', '💅', '🤪', '🗿', '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾', '🤷', '😡'])];
  const sheet = modal(`<div class="modal-head"><h2>${t('React')}</h2><button class="icon-button" data-close-modal aria-label="${t('Close')}">${icon('close', 20)}</button></div>
    <div class="emoji-grid reaction-grid">${all.map(emoji => `<button type="button" class="emoji-key${emoji === current ? ' selected' : ''}" data-pick="${emoji}">${emoji}</button>`).join('')}</div>`);
  sheet.addEventListener('click', event => {
    const pick = event.target.closest('[data-pick]');
    if (!pick) return;
    rememberEmoji(pick.dataset.pick);
    sheet.close();
    onReact(pick.dataset.pick === current ? '' : pick.dataset.pick);
  });
}
