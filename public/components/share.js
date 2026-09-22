import { request } from '../api.js';
import { icon } from '../icons.js';
import { loadConversations, state, upsertMessage } from '../store.js';
import { avatar, escapeHtml, modal, spinner, toast } from '../ui.js';

export function openSendToChat(post) {
  const sheet = modal(`
    <div class="modal-head"><h2>Send to</h2><button class="icon-button" data-close-modal aria-label="Close">${icon('close', 20)}</button></div>
    <div data-targets>${spinner('Loading chats')}</div>`);
  const container = sheet.querySelector('[data-targets]');

  loadConversations().then(conversations => {
    container.innerHTML = `<div class="conversation-list">${conversations.map(conversation => {
      const other = conversation.members.find(member => member.id !== state.user?.id);
      return `<button class="conversation" data-conversation="${conversation.id}">
        ${conversation.kind === 'group' ? `<span class="avatar avatar-md avatar-fallback">${icon('users', 20)}</span>` : avatar(other, 'md')}
        <div class="conversation-main"><div class="conversation-row"><strong>${escapeHtml(conversation.title || 'Conversation')}</strong></div></div>
        ${icon('send', 18)}
      </button>`;
    }).join('')}</div>`;

    container.querySelectorAll('[data-conversation]').forEach(button => button.addEventListener('click', async () => {
      const conversationId = Number(button.dataset.conversation);
      button.disabled = true;
      const excerpt = post.body ? `“${post.body.slice(0, 180)}”` : 'a post';
      const body = `Shared ${excerpt} from @${post.author.username} — ${window.location.origin}/?post=${post.id}`;
      try {
        const { message } = await request(`/api/conversations/${conversationId}/messages`, { method: 'POST', body: { kind: 'text', body } });
        upsertMessage(conversationId, message);
        sheet.remove();
        toast('Sent to chat');
      } catch (error) {
        toast(error.message, 'error');
        button.disabled = false;
      }
    }));
  }).catch(error => { container.innerHTML = `<p class="field-hint">${escapeHtml(error.message)}</p>`; });
}
