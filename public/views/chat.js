import { request } from '../api.js';
import { icon } from '../icons.js';
import { navigate } from '../router.js';
import { conversationById, loadConversations, loadMembers, markConversationRead, state, subscribe } from '../store.js';
import { avatar, emptyState, escapeHtml, modal, skeleton, timeAgo, toast } from '../ui.js';
import { MESSAGE_REACTIONS } from '../components/reactions.js';

function previewText(conversation) {
  const message = conversation.lastMessage;
  if (!message) return 'No messages yet — say hello';
  const who = message.isMine ? 'You' : message.sender.displayName.split(' ')[0];
  const kinds = { sticker: 'sent a sticker', image: 'sent a photo', video: 'sent a video', voice: 'sent a voice message', story_reply: 'replied to a story' };
  return `${who}: ${message.deletedAt ? 'message deleted' : kinds[message.kind] || message.body}`;
}

export function renderChatList(host) {
  host.innerHTML = `
    <div class="page">
      <div class="page-title"><div><h1>Chat</h1><p>Group and one-to-one conversations.</p></div>
        <button class="icon-button" data-action="new-chat" aria-label="Start a direct message">${icon('plus', 22)}</button></div>
      <div data-list>${skeleton(3)}</div>
    </div>`;

  const list = host.querySelector('[data-list]');

  const draw = () => {
    const conversations = state.conversations.items;
    if (!state.conversations.loaded) return;
    if (!conversations.length) {
      list.innerHTML = emptyState('chat', 'No conversations yet', 'Start a private chat with someone in your circle.');
      return;
    }
    list.innerHTML = `<div class="conversation-list">${conversations.map(conversation => {
      const other = conversation.members.find(member => member.id !== state.user?.id);
      const online = conversation.kind === 'group'
        ? conversation.members.filter(member => member.id !== state.user?.id && member.online).length
        : other?.online;
      return `<button class="conversation" data-open="${conversation.id}">
        <span class="${conversation.kind === 'direct' && other?.online ? 'online-dot' : ''}">
          ${conversation.kind === 'group' ? `<span class="avatar avatar-md avatar-fallback">${icon('users', 20)}</span>` : avatar(other, 'md')}
        </span>
        <div class="conversation-main">
          <div class="conversation-row">
            <strong>${escapeHtml(conversation.title || 'Conversation')}</strong>
            <time>${conversation.lastMessage ? timeAgo(conversation.lastMessage.createdAt) : ''}</time>
          </div>
          <p>${escapeHtml(previewText(conversation))}${conversation.kind === 'group' && online ? ` · ${online} online` : ''}</p>
        </div>
        ${conversation.unread ? `<span class="unread-pill">${conversation.unread}</span>` : ''}
      </button>`;
    }).join('')}</div>`;
  };

  host.addEventListener('click', async event => {
    const open = event.target.closest('[data-open]');
    if (open) return navigate(`/chat/${open.dataset.open}`);
    if (event.target.closest('[data-action="new-chat"]')) {
      const members = await loadMembers();
      const others = members.filter(member => member.id !== state.user?.id);
      const sheet = modal(`<div class="modal-head"><h2>New message</h2><button class="icon-button" data-close-modal aria-label="Close">${icon('close', 20)}</button></div>
        ${others.length ? `<div class="member-list">${others.map(member => `<button class="member-item" data-direct="${member.id}">
            ${avatar(member, 'sm')}<div><strong>${escapeHtml(member.displayName)}</strong><small>@${escapeHtml(member.username)}${member.online ? ' · online' : ''}</small></div>${icon('send', 16)}
          </button>`).join('')}</div>` : '<p class="field-hint">Invite someone from Profile → Settings first.</p>'}`);
      sheet.querySelectorAll('[data-direct]').forEach(button => button.addEventListener('click', async () => {
        try {
          const { conversationId } = await request('/api/conversations/direct', { method: 'POST', body: { userId: Number(button.dataset.direct) } });
          sheet.remove();
          await loadConversations();
          navigate(`/chat/${conversationId}`);
        } catch (error) { toast(error.message, 'error'); }
      }));
    }
  });

  const unsubscribe = subscribe(event => { if (['conversations', 'message', 'messages', 'presence', 'members'].includes(event)) draw(); });
  loadConversations().then(draw).catch(error => { list.innerHTML = emptyState('close', 'Could not load chats', error.message); });
  draw();
  return unsubscribe;
}

export function renderConversation(host, { conversationId }) {
  const id = Number(conversationId);
  let replyTo = null;
  let recorder = null;
  let recordedChunks = [];
  let typingTimer = null;

  host.innerHTML = `
    <div class="chat-page">
      <header class="chat-header">
        <button class="icon-button" data-action="back" aria-label="Back to chats">${icon('back', 22)}</button>
        <div class="chat-person" data-person></div>
      </header>
      <div class="messages" data-messages>${skeleton(1)}</div>
      <div class="typing" data-typing></div>
      <div class="reply-bar" data-reply hidden></div>
      <form class="chat-composer" data-composer>
        <button class="icon-button" type="button" data-action="attach" aria-label="Attach photo or video">${icon('image', 22)}</button>
        <button class="icon-button" type="button" data-action="stickers" aria-label="Open stickers">${icon('smile', 22)}</button>
        <textarea class="chat-input" data-input rows="1" maxlength="4000" placeholder="Message…" aria-label="Message"></textarea>
        <button class="icon-button" type="button" data-action="voice" aria-label="Record voice message">${icon('mic', 22)}</button>
        <button class="icon-button chat-send" type="submit" aria-label="Send message">${icon('send', 22)}</button>
      </form>
    </div>`;

  const messagesHost = host.querySelector('[data-messages]');
  const personHost = host.querySelector('[data-person]');
  const typingHost = host.querySelector('[data-typing]');
  const replyBar = host.querySelector('[data-reply]');
  const input = host.querySelector('[data-input]');
  const form = host.querySelector('[data-composer]');

  const drawHeader = () => {
    const conversation = conversationById(id);
    if (!conversation) return;
    const other = conversation.members.find(member => member.id !== state.user?.id);
    const subtitle = conversation.kind === 'group'
      ? `${conversation.members.length} members · ${conversation.members.filter(member => member.online).length} online`
      : other?.online ? 'Online now' : other?.lastSeenAt ? `Last seen ${timeAgo(other.lastSeenAt)} ago` : 'Offline';
    personHost.innerHTML = `
      <span class="${other?.online && conversation.kind === 'direct' ? 'online-dot' : ''}">
        ${conversation.kind === 'group' ? `<span class="avatar avatar-sm avatar-fallback">${icon('users', 16)}</span>` : avatar(other, 'sm')}
      </span>
      <div><strong>${escapeHtml(conversation.title || 'Conversation')}</strong><small>${escapeHtml(subtitle)}</small></div>`;
  };

  const drawMessages = () => {
    const store = state.messages.get(id);
    if (!store?.loaded) return;
    const conversation = conversationById(id);
    if (!store.items.length) {
      messagesHost.innerHTML = emptyState('chat', 'No messages yet', 'Send the first message to get things going.');
      return;
    }
    const atBottom = messagesHost.scrollHeight - messagesHost.scrollTop - messagesHost.clientHeight < 140;
    messagesHost.innerHTML = `
      ${store.nextCursor ? '<button class="button button-ghost button-block" data-action="older">Load earlier messages</button>' : ''}
      ${store.items.map((message, index) => {
        const previous = store.items[index - 1];
        const showSender = conversation?.kind === 'group' && !message.isMine && previous?.sender.id !== message.sender.id;
        const seen = message.isMine && message.readBy.length > 0;
        const reactions = message.reactions.reduce((groups, item) => ({ ...groups, [item.reaction]: (groups[item.reaction] || 0) + 1 }), {});
        return `<div class="message${message.isMine ? ' mine' : ''}${message.kind === 'sticker' ? ' sticker-message' : ''}" data-message="${message.id}">
          ${showSender ? `<span class="message-sender">${escapeHtml(message.sender.displayName)}</span>` : ''}
          <div class="message-bubble">
            ${message.replyTo ? `<div class="reply-quote">${escapeHtml(message.replyTo.deleted ? 'Deleted message' : (message.replyTo.body || message.replyTo.kind))}</div>` : ''}
            ${message.deletedAt ? '<em class="deleted-note">This message was deleted</em>' : renderMessageBody(message)}
            <div class="message-meta">${timeAgo(message.createdAt)}${message.isMine ? (seen ? ` · ${icon('check', 11)}` : ' · sent') : ''}</div>
          </div>
          ${Object.keys(reactions).length ? `<div class="message-reactions">${Object.entries(reactions).map(([reaction, count]) => `<span class="message-reaction">${escapeHtml(reaction)}${count > 1 ? ` ${count}` : ''}</span>`).join('')}</div>` : ''}
        </div>`;
      }).join('')}`;

    attachMessageHandlers();
    if (atBottom) messagesHost.scrollTop = messagesHost.scrollHeight;

    const last = store.items.at(-1);
    if (last && conversation?.unread) {
      request(`/api/conversations/${id}/read`, { method: 'POST', body: { messageId: last.id } }).then(() => markConversationRead(id)).catch(() => {});
    }
  };

  const renderMessageBody = message => {
    if (message.kind === 'sticker' && message.sticker) return `<img class="sticker" src="${escapeHtml(message.sticker.url)}" alt="${escapeHtml(message.sticker.name)}">`;
    if (message.kind === 'image' && message.media) return `<img class="message-media" src="${escapeHtml(message.media.url)}" alt="Shared photo" loading="lazy">${message.body ? `<div>${escapeHtml(message.body)}</div>` : ''}`;
    if (message.kind === 'video' && message.media) return `<video class="message-media" src="${escapeHtml(message.media.url)}" controls playsinline preload="metadata"></video>`;
    if (message.kind === 'voice' && message.media) return `<audio class="message-audio" src="${escapeHtml(message.media.url)}" controls preload="metadata"></audio>`;
    return escapeHtml(message.body);
  };

  const attachMessageHandlers = () => {
    messagesHost.querySelectorAll('[data-message]').forEach(element => {
      let timer = null;
      const openMenu = () => {
        clearTimeout(timer);
        const store = state.messages.get(id);
        const message = store.items.find(item => item.id === Number(element.dataset.message));
        if (!message || message.deletedAt) return;
        const sheet = modal(`
          <div class="modal-head"><h2>Message</h2><button class="icon-button" data-close-modal aria-label="Close">${icon('close', 20)}</button></div>
          <div class="reaction-picker emoji-picker">${MESSAGE_REACTIONS.map(emoji => `<button data-react="${emoji}" aria-label="React ${emoji}">${emoji}</button>`).join('')}</div>
          <div class="settings-list">
            <button class="settings-item" data-menu="reply">${icon('reply', 19)}<span>Reply</span></button>
            ${message.isMine ? `<button class="settings-item" data-menu="delete">${icon('trash', 19)}<span>Delete message</span></button>` : ''}
          </div>`);
        sheet.querySelectorAll('[data-react]').forEach(button => button.addEventListener('click', async () => {
          sheet.remove();
          const existing = message.reactions.find(item => item.user.id === state.user?.id)?.reaction;
          try { await request(`/api/messages/${message.id}/reaction`, { method: 'POST', body: { reaction: existing === button.dataset.react ? '' : button.dataset.react } }); }
          catch (error) { toast(error.message, 'error'); }
        }));
        sheet.querySelector('[data-menu="reply"]').addEventListener('click', () => {
          sheet.remove();
          replyTo = message;
          replyBar.hidden = false;
          replyBar.innerHTML = `<span>Replying to ${escapeHtml(message.isMine ? 'yourself' : message.sender.displayName)}: ${escapeHtml((message.body || message.kind).slice(0, 60))}</span>
            <button class="icon-button" data-action="cancel-reply" aria-label="Cancel reply">${icon('close', 16)}</button>`;
          input.focus();
        });
        sheet.querySelector('[data-menu="delete"]')?.addEventListener('click', async () => {
          sheet.remove();
          try { await request(`/api/messages/${message.id}`, { method: 'DELETE' }); } catch (error) { toast(error.message, 'error'); }
        });
      };
      element.addEventListener('pointerdown', () => { timer = setTimeout(openMenu, 450); });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach(type => element.addEventListener(type, () => clearTimeout(timer)));
      element.addEventListener('contextmenu', event => { event.preventDefault(); openMenu(); });
      element.addEventListener('dblclick', openMenu);
    });
  };

  const drawTyping = () => {
    const names = [...(state.typing.get(id)?.keys() || [])]
      .map(userId => conversationById(id)?.members.find(member => member.id === Number(userId))?.displayName)
      .filter(Boolean);
    typingHost.textContent = names.length ? `${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} typing…` : '';
  };

  const send = async payload => {
    const { message } = await request(`/api/conversations/${id}/messages`, { method: 'POST', body: { ...payload, replyToId: replyTo?.id || null } });
    const { upsertMessage } = await import('../store.js');
    upsertMessage(id, message);
    replyTo = null;
    replyBar.hidden = true;
    messagesHost.scrollTop = messagesHost.scrollHeight;
  };

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const body = input.value.trim();
    if (!body) return;
    input.value = '';
    input.style.height = 'auto';
    try { await send({ kind: 'text', body }); } catch (error) { toast(error.message, 'error'); input.value = body; }
  });

  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    if (typingTimer) return;
    request(`/api/conversations/${id}/typing`, { method: 'POST', body: { typing: true } }).catch(() => {});
    typingTimer = setTimeout(() => {
      typingTimer = null;
      request(`/api/conversations/${id}/typing`, { method: 'POST', body: { typing: false } }).catch(() => {});
    }, 2500);
  });

  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && window.matchMedia('(min-width: 760px)').matches) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  host.addEventListener('click', async event => {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;
    const action = trigger.dataset.action;
    try {
      if (action === 'back') navigate('/chat');
      if (action === 'cancel-reply') { replyTo = null; replyBar.hidden = true; }
      if (action === 'older') {
        const { loadMessages } = await import('../store.js');
        await loadMessages(id, { more: true });
      }
      if (action === 'attach') {
        const { pickFiles, uploadFiles } = await import('../components/media.js');
        const files = await pickFiles('image/*,video/*', false);
        if (!files.length) return;
        toast('Uploading…');
        const [media] = await uploadFiles(files, 'chat');
        await send({ kind: files[0].type.startsWith('video/') ? 'video' : 'image', mediaId: media.id });
      }
      if (action === 'stickers') {
        const { openStickerPicker } = await import('../components/stickerPicker.js');
        openStickerPicker(async stickerId => {
          try { await send({ kind: 'sticker', stickerId }); } catch (error) { toast(error.message, 'error'); }
        });
      }
      if (action === 'voice') await toggleRecording(trigger);
    } catch (error) { toast(error.message, 'error'); }
  });

  async function toggleRecording(button) {
    if (recorder?.state === 'recording') {
      recorder.stop();
      button.classList.remove('recording');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      return toast('Voice messages are not supported in this browser', 'error');
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = ['audio/webm', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type)) || '';
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recordedChunks = [];
    recorder.addEventListener('dataavailable', event => { if (event.data.size) recordedChunks.push(event.data); });
    recorder.addEventListener('stop', async () => {
      stream.getTracks().forEach(track => track.stop());
      const blob = new Blob(recordedChunks, { type: recorder.mimeType || 'audio/webm' });
      if (blob.size < 700) return toast('Recording was too short', 'error');
      try {
        const file = new File([blob], 'voice-message', { type: blob.type });
        const { uploadFiles } = await import('../components/media.js');
        const [media] = await uploadFiles([file], 'voice');
        await send({ kind: 'voice', mediaId: media.id });
      } catch (error) { toast(error.message, 'error'); }
    });
    recorder.start();
    button.classList.add('recording');
    toast('Recording — tap the microphone again to send');
  }

  const unsubscribe = subscribe((event, payload) => {
    if (event === 'messages' || event === 'message') drawMessages();
    if (event === 'conversations' || event === 'presence' || event === 'members') drawHeader();
    if (event === 'typing') drawTyping();
  });

  (async () => {
    try {
      const { loadMessages } = await import('../store.js');
      if (!state.conversations.loaded) await loadConversations();
      await loadMembers();
      drawHeader();
      await loadMessages(id);
      drawMessages();
      messagesHost.scrollTop = messagesHost.scrollHeight;
    } catch (error) {
      messagesHost.innerHTML = emptyState('lock', 'Conversation unavailable', error.message);
    }
  })();

  return () => {
    unsubscribe();
    clearTimeout(typingTimer);
    if (recorder?.state === 'recording') recorder.stop();
    document.querySelector('.sticker-picker')?.remove();
  };
}
