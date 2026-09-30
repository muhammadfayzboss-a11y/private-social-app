/** Forward one or many messages to one or many chats. */
import { request } from '../api.js';
import { icon } from '../icons.js';
import { loadConversations, state } from '../store.js';
import { escapeHtml, modal, toast } from '../ui.js';
import { t, tn } from '../lib/i18n.js';
import { conversationAvatar } from './chatRow.js';

export async function openForwardPicker(messages) {
  const items = (Array.isArray(messages) ? messages : [messages]).filter(message => message?.id);
  if (!items.length) return;
  const conversations = state.conversations.loaded ? state.conversations.items : await loadConversations();
  const selected = new Set();
  const sheet = modal(`
    <div class="modal-head"><h2>${items.length > 1 ? tn(items.length, 'Forward {n} message', 'Forward {n} messages') : t('Forward to…')}</h2><button class="icon-button" data-close-modal aria-label="${t('Close')}">${icon('close', 20)}</button></div>
    <label class="search-field">${icon('search', 18)}<input type="search" data-filter placeholder="${t('Search chats')}" autocomplete="off"></label>
    <div class="forward-list" data-list>${conversations.filter(conversation => !(conversation.blocked?.byMe || conversation.blocked?.byThem)).map(conversation => `
      <label class="forward-item" data-title="${escapeHtml(conversation.title.toLowerCase())}">
        <input type="checkbox" value="${conversation.id}">
        ${conversationAvatar(conversation, 'sm')}
        <span>${escapeHtml(conversation.title)}</span><i class="check-circle">${icon('check', 14)}</i>
      </label>`).join('')}</div>
    <button type="button" class="button button-primary button-block" data-send disabled>${t('Forward')}</button>`);
  const send = sheet.querySelector('[data-send]');
  sheet.querySelector('[data-filter]').addEventListener('input', event => {
    const query = event.target.value.trim().toLowerCase();
    for (const row of sheet.querySelectorAll('.forward-item')) row.hidden = Boolean(query) && !row.dataset.title.includes(query);
  });
  sheet.addEventListener('change', event => {
    if (event.target.type !== 'checkbox') return;
    if (event.target.checked) selected.add(Number(event.target.value)); else selected.delete(Number(event.target.value));
    send.disabled = !selected.size;
    send.textContent = selected.size > 1 ? tn(selected.size, 'Forward to {n} chat', 'Forward to {n} chats') : t('Forward');
  });
  const operationId = `forward-${crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : Date.now().toString(36)}`.slice(0, 48);
  send.addEventListener('click', async () => {
    send.disabled = true;
    try {
      await request('/api/messages/forward', { method: 'POST', body: { messageIds: items.map(message => message.id), conversationIds: [...selected], operationId } });
      sheet.close();
      toast(selected.size > 1 ? tn(selected.size, 'Forwarded to {n} chat', 'Forwarded to {n} chats') : t('Forwarded'));
    } catch (error) {
      toast(error.message, 'error');
      send.disabled = false;
    }
  });
}
