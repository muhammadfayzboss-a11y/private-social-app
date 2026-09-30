/**
 * Long-press menu for one message. Only actions that make sense for this viewer and message are
 * offered: edit is for your own text, delete-for-everyone for your own messages, copy only when there
 * is text, and so on.
 */
import { request } from '../api.js';
import { icon } from '../icons.js';
import { exactTime } from '../lib/time.js';
import { loadConversations, state } from '../store.js';
import { avatar, escapeHtml, modal, toast } from '../ui.js';
import { MESSAGE_REACTIONS } from './reactions.js';

export function openMessageMenu(message, { conversation, onAction }) {
  const mine = message.isMine;
  const canCopy = Boolean(message.body);
  const readers = mine ? message.readBy || [] : [];
  const myReaction = message.reactions?.find(item => item.user.id === state.user?.id)?.reaction;
  const isPinned = conversation?.pinnedMessage?.id === message.id;
  const actions = [
    { id: 'reply', label: 'Reply', icon: 'reply' },
    canCopy && { id: 'copy', label: 'Copy text', icon: 'copy' },
    mine && message.kind === 'text' && { id: 'edit', label: 'Edit', icon: 'edit' },
    { id: 'forward', label: 'Forward', icon: 'forward' },
    { id: 'pin', label: isPinned ? 'Unpin' : 'Pin', icon: 'pin' },
    message.media && message.kind !== 'voice' && { id: 'download', label: 'Save to device', icon: 'down' },
    { id: 'delete', label: 'Delete', icon: 'trash', danger: true }
  ].filter(Boolean);

  const sheet = modal(`
    <div class="reaction-bar" role="group" aria-label="React">${MESSAGE_REACTIONS.map(emoji => `
      <button type="button" data-react="${emoji}" class="${myReaction === emoji ? 'selected' : ''}" aria-label="React ${emoji}">${emoji}</button>`).join('')}
    </div>
    <p class="message-menu-time">${icon('clock', 13)} ${mine ? 'Sent' : 'Received'} ${escapeHtml(exactTime(message.createdAt))}${message.editedAt ? ` · edited ${escapeHtml(exactTime(message.editedAt))}` : ''}</p>
    ${mine && conversation?.kind === 'group' ? `<div class="seen-by">${readers.length
      ? `${icon('checks', 15)}<span>Seen by ${readers.map(reader => escapeHtml(reader.displayName)).join(', ')}</span>`
      : `${icon('check', 15)}<span>Not seen yet</span>`}</div>` : ''}
    <div class="action-list">${actions.map(action => `
      <button type="button" class="action-item${action.danger ? ' danger' : ''}" data-menu="${action.id}">${icon(action.icon, 21)}<span>${escapeHtml(action.label)}</span></button>`).join('')}
    </div>`, 'action-sheet message-menu');

  sheet.addEventListener('click', event => {
    const reaction = event.target.closest('[data-react]');
    const action = event.target.closest('[data-menu]');
    if (!reaction && !action) return;
    sheet.close();
    if (reaction) onAction('react', reaction.dataset.react === myReaction ? '' : reaction.dataset.react);
    else onAction(action.dataset.menu);
  });
  return sheet;
}

export async function openForwardPicker(message) {
  const conversations = state.conversations.loaded ? state.conversations.items : await loadConversations();
  const selected = new Set();
  const sheet = modal(`
    <div class="modal-head"><h2>Forward to…</h2><button class="icon-button" data-close-modal aria-label="Close">${icon('close', 20)}</button></div>
    <div class="forward-list">${conversations.map(conversation => {
      const other = conversation.members.find(member => member.id !== state.user?.id);
      return `<label class="forward-item">
        <input type="checkbox" value="${conversation.id}">
        ${conversation.kind === 'group' ? `<span class="avatar avatar-sm avatar-group">${icon('users', 16)}</span>` : avatar(other, 'sm')}
        <span>${escapeHtml(conversation.title)}</span><i class="check-circle">${icon('check', 14)}</i>
      </label>`;
    }).join('')}</div>
    <button type="button" class="button button-primary button-block" data-send disabled>Forward</button>`);
  const send = sheet.querySelector('[data-send]');
  sheet.addEventListener('change', event => {
    if (event.target.type !== 'checkbox') return;
    if (event.target.checked) selected.add(Number(event.target.value)); else selected.delete(Number(event.target.value));
    send.disabled = !selected.size;
    send.textContent = selected.size > 1 ? `Forward to ${selected.size} chats` : 'Forward';
  });
  send.addEventListener('click', async () => {
    send.disabled = true;
    try {
      await request(`/api/messages/${message.id}/forward`, { method: 'POST', body: { conversationIds: [...selected] } });
      sheet.close();
      toast(selected.size > 1 ? `Forwarded to ${selected.size} chats` : 'Message forwarded');
    } catch (error) {
      toast(error.message, 'error');
      send.disabled = false;
    }
  });
}
