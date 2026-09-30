/**
 * Chat list rows: avatar with online dot, name with mute/pin marks, time with delivery ticks,
 * preview (typing… / Draft: / "You:"), and the unread badge. Rows can be swiped both ways to reveal
 * actions, as in native messengers.
 */
import { icon } from '../icons.js';
import { getDraft, state, typingUsers } from '../store.js';
import { avatar, escapeHtml } from '../ui.js';
import { listTime } from '../lib/time.js';
import { t } from '../lib/i18n.js';
import { previewIcon, previewText, statusMarkup } from './messages.js';

export function otherMember(conversation) {
  return conversation.members.find(member => member.id !== state.user?.id);
}

export function liveMember(member) {
  return state.members.find(item => item.id === member?.id) || member;
}

export function conversationAvatar(conversation, size = 'md') {
  if (conversation.kind === 'group') return `<span class="avatar avatar-${size} avatar-group" data-hue="${conversation.id % 7}">${icon('users', size === 'sm' ? 18 : 24)}</span>`;
  return avatar(liveMember(otherMember(conversation)), size);
}

function previewMarkup(conversation) {
  const typing = typingUsers(conversation.id);
  if (typing.length) {
    const who = conversation.kind === 'group' ? `${escapeHtml(typing[0].user.displayName.split(' ')[0])} ` : '';
    return `<span class="preview-typing">${who}${typing[0].kind === 'voice' ? t('is recording voice') : t('is typing')}<i class="typing-dots"><b></b><b></b><b></b></i></span>`;
  }
  const draft = state.openConversationId === conversation.id ? '' : getDraft(conversation.id);
  if (draft) return `<span class="preview-draft">${t('Draft:')}</span> ${escapeHtml(draft)}`;
  if (conversation.blocked?.byMe) return `<span class="preview-muted">${t('You blocked this member')}</span>`;
  const message = conversation.lastMessage;
  if (!message) return `<span class="preview-muted">${t('No messages yet')}</span>`;
  const who = message.isMine ? `${t('You')}: ` : conversation.kind === 'group' ? `${message.sender.displayName.split(' ')[0]}: ` : '';
  return `${who ? `<span class="preview-sender">${escapeHtml(who)}</span>` : ''}${previewIcon(message)}${escapeHtml(previewText(message))}`;
}

export function chatRowSignature(conversation) {
  const other = liveMember(otherMember(conversation));
  return JSON.stringify([conversation.title, conversation.unread, conversation.markedUnread, conversation.muted, conversation.pinned, conversation.archived,
    conversation.lastMessage?.id, conversation.lastMessage?.body, conversation.lastMessage?.readBy?.length, conversation.lastMessage?.editedAt,
    other?.online, other?.avatarUrl, typingUsers(conversation.id).map(item => item.user.id + item.kind), getDraft(conversation.id), conversation.blocked?.byMe, state.openConversationId === conversation.id]);
}

export function chatRowMarkup(conversation, { swipe = true, archivedList = false } = {}) {
  const other = liveMember(otherMember(conversation));
  const message = conversation.lastMessage;
  const unread = conversation.unread || (conversation.markedUnread ? 1 : 0);
  const content = `<button class="conversation${unread && !conversation.muted ? ' has-unread' : ''}" data-open="${conversation.id}">
      <span class="avatar-wrap${conversation.kind === 'direct' && other?.online ? ' is-online' : ''}">${conversationAvatar(conversation)}</span>
      <span class="conversation-main">
        <span class="conversation-row">
          <strong>${escapeHtml(conversation.title || t('Conversation'))}</strong>
          ${conversation.muted ? `<span class="muted-icon" aria-label="${t('Muted')}">${icon('mute', 15)}</span>` : ''}
          <span class="conversation-time">${message?.isMine ? statusMarkup(message) : ''}<time>${message ? listTime(message.createdAt) : ''}</time></span>
        </span>
        <span class="conversation-row">
          <span class="conversation-preview">${previewMarkup(conversation)}</span>
          ${unread ? `<span class="unread-pill${conversation.muted ? ' muted' : ''}${!conversation.unread ? ' dot' : ''}">${conversation.unread ? (conversation.unread > 99 ? '99+' : conversation.unread) : ''}</span>`
            : conversation.pinned ? `<span class="pin-icon" aria-label="${t('Pinned')}">${icon('pin', 16)}</span>` : ''}
        </span>
      </span>
    </button>`;
  if (!swipe) return `<div class="chat-row" data-conversation="${conversation.id}">${content}</div>`;
  const read = unread ? { id: 'read', label: t('Read'), icon: 'checks', color: '#5b8def' } : { id: 'unread', label: t('Unread'), icon: 'unread', color: '#5b8def' };
  const left = [read, { id: 'pin', label: conversation.pinned ? t('Unpin') : t('Pin'), icon: 'pin', color: '#22b573' }];
  const right = [
    { id: 'mute', label: conversation.muted ? t('Unmute') : t('Mute'), icon: conversation.muted ? 'bell' : 'mute', color: '#f0a52b' },
    { id: 'delete', label: t('Delete'), icon: 'trash', color: '#e5484d' },
    { id: archivedList ? 'unarchive' : 'archive', label: archivedList ? t('Unarchive') : t('Archive'), icon: archivedList ? 'unarchive' : 'archive', color: '#8e8e93' }
  ];
  const actions = (items, side) => `<div class="swipe-actions swipe-${side}">${items.map(item => `<button class="swipe-action" data-swipe="${item.id}" style="--swipe:${item.color}">${icon(item.icon, 22)}<span>${item.label}</span></button>`).join('')}</div>`;
  return `<div class="chat-row" data-conversation="${conversation.id}">${actions(left, 'left')}${actions(right, 'right')}${content}</div>`;
}

/**
 * Swipe handling for every row in `list`, delegated so re-rendered rows need no new listeners.
 * A short swipe reveals the buttons; a long swipe triggers the outermost action directly.
 */
export function enableRowSwipes(list, onAction) {
  const ACTION = 76;
  let drag = null;
  let open = null;
  const setOffset = (row, x, animate) => {
    const content = row.querySelector('.conversation');
    content.style.transition = animate ? 'transform .22s cubic-bezier(.2,.8,.2,1)' : 'none';
    content.style.transform = x ? `translateX(${x}px)` : '';
    row.classList.toggle('swiped-left', x > 0);
    row.classList.toggle('swiped-right', x < 0);
  };
  const close = (animate = true) => { if (open) { setOffset(open, 0, animate); open = null; } };

  list.addEventListener('pointerdown', event => {
    const row = event.target.closest('.chat-row');
    if (event.target.closest('[data-swipe]')) return;
    if (open && open !== row) close();
    if (!row || !row.querySelector('.swipe-actions') || event.pointerType === 'mouse') return;
    const current = open === row ? Number((row.querySelector('.conversation').style.transform.match(/-?\d+(\.\d+)?/) || [0])[0]) : 0;
    drag = { row, x: event.clientX, y: event.clientY, base: current, dx: current, locked: null };
  }, { passive: true });
  list.addEventListener('pointermove', event => {
    if (!drag) return;
    const dx = event.clientX - drag.x; const dy = event.clientY - drag.y;
    if (drag.locked === null && Math.hypot(dx, dy) > 8) drag.locked = Math.abs(dx) > Math.abs(dy) * 1.3 ? 'x' : 'y';
    if (drag.locked !== 'x') return;
    const leftWidth = drag.row.querySelectorAll('.swipe-left .swipe-action').length * ACTION;
    const width = drag.row.offsetWidth;
    drag.dx = Math.max(-width * 0.85, Math.min(width * 0.6, drag.base + dx));
    if (drag.dx > leftWidth) drag.dx = leftWidth + (drag.dx - leftWidth) * 0.6;
    setOffset(drag.row, drag.dx, false);
    drag.row.classList.toggle('swipe-full', drag.dx < -width * 0.6);
  }, { passive: true });
  const end = () => {
    if (!drag) return;
    const { row, dx, locked } = drag;
    drag = null;
    if (locked !== 'x') return;
    const width = row.offsetWidth;
    const rightWidth = row.querySelectorAll('.swipe-right .swipe-action').length * ACTION;
    const leftWidth = row.querySelectorAll('.swipe-left .swipe-action').length * ACTION;
    row.classList.remove('swipe-full');
    // Swallow the click that ends a swipe, so it never opens the chat.
    row.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => row.removeEventListener('click', swallow, { capture: true }), 350);
    if (dx < -width * 0.6) { setOffset(row, 0, true); open = null; navigator.vibrate?.(10); return onAction(Number(row.dataset.conversation), row.querySelector('.swipe-right .swipe-action:last-child').dataset.swipe); }
    if (dx < -40) { setOffset(row, -rightWidth, true); open = row; return; }
    if (dx > leftWidth * 0.9) { setOffset(row, 0, true); open = null; navigator.vibrate?.(10); return onAction(Number(row.dataset.conversation), row.querySelector('.swipe-left .swipe-action').dataset.swipe); }
    if (dx > 40) { setOffset(row, leftWidth, true); open = row; return; }
    setOffset(row, 0, true); open = null;
  };
  const swallow = event => { event.stopPropagation(); event.preventDefault(); };
  list.addEventListener('pointerup', end);
  list.addEventListener('pointercancel', end);
  list.addEventListener('click', event => {
    const button = event.target.closest('[data-swipe]');
    if (button) {
      event.stopPropagation();
      const row = button.closest('.chat-row');
      close();
      onAction(Number(row.dataset.conversation), button.dataset.swipe);
      return;
    }
    // Tapping an open row closes it instead of opening the chat.
    if (open && event.target.closest('.chat-row') === open) { event.stopPropagation(); event.preventDefault(); close(); }
  }, true);
  return { close };
}

/** Keyed rendering: rows are rebuilt only when their content changes, then reordered in place. */
export function renderRows(list, conversations, cache, options) {
  const seen = new Set();
  const nodes = conversations.map(conversation => {
    seen.add(conversation.id);
    const signature = chatRowSignature(conversation) + JSON.stringify(options || {});
    let entry = cache.get(conversation.id);
    if (!entry || entry.signature !== signature) {
      const template = document.createElement('template');
      template.innerHTML = chatRowMarkup(conversation, options).trim();
      entry = { element: template.content.firstElementChild, signature };
      cache.set(conversation.id, entry);
    }
    return entry.element;
  });
  for (const id of [...cache.keys()]) if (!seen.has(id)) cache.delete(id);
  const current = [...list.children];
  if (current.length !== nodes.length || current.some((node, index) => node !== nodes[index])) list.replaceChildren(...nodes);
}
