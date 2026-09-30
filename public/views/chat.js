import { request } from '../api.js';
import { icon } from '../icons.js';
import { navigate } from '../router.js';
import { conversationById, getDraft, loadConversations, loadMembers, markConversationRead, patchConversation, state, subscribe, typingUsers } from '../store.js';
import { actionSheet, avatar, emptyState, escapeHtml, listSkeleton, modal, toast } from '../ui.js';
import { listTime, relativeTime } from '../lib/time.js';
import { onLongPress } from '../lib/gestures.js';
import { previewIcon, previewText, statusMarkup } from '../components/messages.js';

export { renderConversation } from './conversation.js';

const FOLDERS = [
  { id: 'all', label: 'All' },
  { id: 'unread', label: 'Unread' },
  { id: 'direct', label: 'Personal' },
  { id: 'group', label: 'Groups' }
];

function otherMember(conversation) {
  return conversation.members.find(member => member.id !== state.user?.id);
}

function liveMember(member) {
  return state.members.find(item => item.id === member?.id) || member;
}

function previewMarkup(conversation) {
  const typing = typingUsers(conversation.id);
  if (typing.length) {
    const who = conversation.kind === 'group' ? `${typing[0].user.displayName.split(' ')[0]} ` : '';
    return `<span class="preview-typing">${escapeHtml(who)}${typing[0].kind === 'voice' ? 'recording voice…' : 'typing…'}</span>`;
  }
  const draft = state.openConversationId === conversation.id ? '' : getDraft(conversation.id);
  if (draft) return `<span class="preview-draft">Draft:</span> ${escapeHtml(draft)}`;
  const message = conversation.lastMessage;
  if (!message) return '<span class="preview-muted">No messages yet — say hello</span>';
  const who = message.isMine ? 'You: ' : conversation.kind === 'group' ? `${message.sender.displayName.split(' ')[0]}: ` : '';
  return `${who ? `<span class="preview-sender">${escapeHtml(who)}</span>` : ''}${previewIcon(message)}${escapeHtml(previewText(message))}`;
}

function conversationRow(conversation) {
  const other = liveMember(otherMember(conversation));
  const message = conversation.lastMessage;
  return `<button class="conversation${conversation.unread && !conversation.muted ? ' has-unread' : ''}" data-open="${conversation.id}">
    <span class="avatar-wrap${conversation.kind === 'direct' && other?.online ? ' is-online' : ''}">
      ${conversation.kind === 'group' ? `<span class="avatar avatar-md avatar-group">${icon('users', 22)}</span>` : avatar(other, 'md')}
    </span>
    <span class="conversation-main">
      <span class="conversation-row">
        <strong>${escapeHtml(conversation.title || 'Conversation')}</strong>
        ${conversation.muted ? `<span class="muted-icon" title="Muted">${icon('mute', 14)}</span>` : ''}
        <span class="conversation-time">${message?.isMine ? statusMarkup(message) : ''}<time datetime="${escapeHtml(message?.createdAt || '')}">${message ? listTime(message.createdAt) : ''}</time></span>
      </span>
      <span class="conversation-row">
        <span class="conversation-preview">${previewMarkup(conversation)}</span>
        ${conversation.unread ? `<span class="unread-pill${conversation.muted ? ' muted' : ''}">${conversation.unread > 99 ? '99+' : conversation.unread}</span>` : conversation.pinned ? `<span class="pin-icon" title="Pinned">${icon('pin', 15)}</span>` : ''}
      </span>
    </span>
  </button>`;
}

export function renderChatList(host) {
  let folder = sessionStorage.getItem('circle-chat-folder') || 'all';
  let query = '';
  let searchResults = null;
  let searchTimer = null;
  let searchSeq = 0;

  host.innerHTML = `
    <div class="page page-chats">
      <div class="page-title"><h1>Chats</h1>
        <button class="icon-button" data-action="new-chat" aria-label="Start a direct message">${icon('edit', 22)}</button></div>
      <label class="search-field">${icon('search', 18)}<input type="search" data-search placeholder="Search chats, people, messages" autocomplete="off" enterkeyhint="search" aria-label="Search"></label>
      <div class="folder-tabs" role="tablist" data-folders></div>
      <div data-list>${listSkeleton(5)}</div>
    </div>`;

  const list = host.querySelector('[data-list]');
  const folders = host.querySelector('[data-folders]');
  const search = host.querySelector('[data-search]');

  const drawFolders = () => {
    const counts = {
      unread: state.conversations.items.filter(item => item.unread).length
    };
    folders.hidden = Boolean(query);
    folders.innerHTML = FOLDERS.map(item => `<button class="folder-tab${item.id === folder ? ' active' : ''}" role="tab" aria-selected="${item.id === folder}" data-folder="${item.id}">${item.label}${counts[item.id] ? ` <b>${counts[item.id]}</b>` : ''}</button>`).join('');
  };

  const drawSearch = () => {
    const lower = query.toLowerCase();
    const chats = state.conversations.items.filter(item => item.title.toLowerCase().includes(lower));
    const members = (searchResults?.members || []).filter(member => member.id !== state.user?.id);
    const messages = searchResults?.messages || [];
    const sections = [];
    if (chats.length) sections.push(`<h2 class="list-section">Chats</h2><div class="conversation-list">${chats.map(conversationRow).join('')}</div>`);
    if (members.length) sections.push(`<h2 class="list-section">People</h2><div class="conversation-list">${members.map(member => `
      <button class="conversation" data-member="${member.id}">
        <span class="avatar-wrap${member.online ? ' is-online' : ''}">${avatar(member, 'md')}</span>
        <span class="conversation-main"><span class="conversation-row"><strong>${escapeHtml(member.displayName)}</strong></span>
        <span class="conversation-row"><span class="conversation-preview">@${escapeHtml(member.username)}</span></span></span>
      </button>`).join('')}</div>`);
    if (messages.length) sections.push(`<h2 class="list-section">Messages</h2><div class="conversation-list">${messages.map(message => `
      <button class="conversation" data-result="${message.conversationId}" data-message-id="${message.id}">
        ${avatar(message.sender, 'md')}
        <span class="conversation-main"><span class="conversation-row"><strong>${escapeHtml(message.conversationTitle)}</strong><time>${relativeTime(message.createdAt)}</time></span>
        <span class="conversation-row"><span class="conversation-preview"><span class="preview-sender">${escapeHtml(message.isMine ? 'You' : message.sender.displayName.split(' ')[0])}:</span> ${highlight(message.body, query)}</span></span></span>
      </button>`).join('')}</div>`);
    if (!sections.length) {
      list.innerHTML = searchResults || query.length < 2
        ? emptyState('search', 'No results', query.length < 2 ? 'Type at least two characters to search messages.' : `Nothing matches “${query}”.`)
        : listSkeleton(3);
      return;
    }
    list.innerHTML = sections.join('');
  };

  const draw = () => {
    drawFolders();
    if (query) return drawSearch();
    if (!state.conversations.loaded) return;
    const items = state.conversations.items.filter(item => folder === 'all' || (folder === 'unread' ? item.unread : item.kind === folder));
    if (!state.conversations.items.length) {
      list.innerHTML = emptyState('chat', 'No conversations yet', 'Start a private chat with someone in your circle.', '<button class="button button-primary" data-action="new-chat">New message</button>');
      return;
    }
    if (!items.length) {
      list.innerHTML = emptyState(folder === 'unread' ? 'checks' : 'chat', folder === 'unread' ? 'All caught up' : 'Nothing in this folder', folder === 'unread' ? 'You have read every message.' : 'Chats of this type will appear here.');
      return;
    }
    list.innerHTML = `<div class="conversation-list">${items.map(conversationRow).join('')}</div>`;
  };

  search.addEventListener('input', () => {
    query = search.value.trim();
    clearTimeout(searchTimer);
    searchResults = null;
    draw();
    if (query.length < 2) return;
    const seq = ++searchSeq;
    searchTimer = setTimeout(async () => {
      try {
        const result = await request(`/api/search?q=${encodeURIComponent(query)}`);
        if (seq !== searchSeq) return; // a newer query superseded this one
        searchResults = result;
        draw();
      } catch (error) { if (seq === searchSeq) { searchResults = { members: [], messages: [] }; draw(); toast(error.message, 'error'); } }
    }, 250);
  });

  host.addEventListener('click', async event => {
    const folderButton = event.target.closest('[data-folder]');
    if (folderButton) { folder = folderButton.dataset.folder; sessionStorage.setItem('circle-chat-folder', folder); return draw(); }
    const result = event.target.closest('[data-result]');
    if (result) return navigate(`/chat/${result.dataset.result}?m=${result.dataset.messageId}`);
    const member = event.target.closest('[data-member]');
    if (member) return openDirect(Number(member.dataset.member));
    const open = event.target.closest('[data-open]');
    if (open) return navigate(`/chat/${open.dataset.open}`);
    if (event.target.closest('[data-action="new-chat"]')) return openNewChat();
  });

  async function openDirect(userId) {
    try {
      const { conversationId } = await request('/api/conversations/direct', { method: 'POST', body: { userId } });
      if (!conversationById(conversationId)) await loadConversations();
      navigate(`/chat/${conversationId}`);
    } catch (error) { toast(error.message, 'error'); }
  }

  async function openNewChat() {
    const sheet = modal(`<div class="modal-head"><h2>New message</h2><button class="icon-button" data-close-modal aria-label="Close">${icon('close', 20)}</button></div><div data-members>${listSkeleton(3)}</div>`);
    try {
      const members = await loadMembers(true);
      const others = members.filter(member => member.id !== state.user?.id);
      sheet.querySelector('[data-members]').innerHTML = others.length
        ? `<div class="member-list">${others.map(member => `<button class="member-item" data-direct="${member.id}">
            <span class="avatar-wrap${member.online ? ' is-online' : ''}">${avatar(member, 'sm')}</span><div><strong>${escapeHtml(member.displayName)}</strong><small>@${escapeHtml(member.username)}</small></div>${icon('chat', 18)}
          </button>`).join('')}</div>`
        : '<p class="field-hint">Invite someone from Profile → Settings first.</p>';
    } catch (error) { sheet.querySelector('[data-members]').innerHTML = `<p class="field-hint">${escapeHtml(error.message)}</p>`; }
    sheet.addEventListener('click', event => {
      const button = event.target.closest('[data-direct]');
      if (!button) return;
      sheet.close();
      openDirect(Number(button.dataset.direct));
    });
  }

  const stopLongPress = onLongPress(list, '[data-open]', async element => {
    const conversation = conversationById(element.dataset.open);
    if (!conversation) return;
    const choice = await actionSheet({
      title: conversation.title,
      actions: [
        { id: 'pin', label: conversation.pinned ? 'Unpin' : 'Pin to top', icon: 'pin' },
        { id: 'mute', label: conversation.muted ? 'Unmute' : 'Mute notifications', icon: conversation.muted ? 'bell' : 'mute' },
        conversation.unread && { id: 'read', label: 'Mark as read', icon: 'checks' }
      ].filter(Boolean)
    });
    try {
      if (choice === 'pin' || choice === 'mute') {
        const body = choice === 'pin' ? { pinned: !conversation.pinned } : { muted: !conversation.muted };
        const result = await request(`/api/conversations/${conversation.id}/settings`, { method: 'POST', body });
        patchConversation(conversation.id, result.conversation);
      }
      if (choice === 'read' && conversation.lastMessage?.id) {
        await request(`/api/conversations/${conversation.id}/read`, { method: 'POST', body: { messageId: conversation.lastMessage.id } });
        markConversationRead(conversation.id);
      }
    } catch (error) { toast(error.message, 'error'); }
  });

  const unsubscribe = subscribe(event => { if (['conversations', 'message', 'messages', 'presence', 'members', 'typing'].includes(event)) draw(); });
  loadConversations().then(draw).catch(error => {
    if (!state.conversations.loaded) list.innerHTML = emptyState('alert', 'Could not load chats', error.message, '<button class="button" data-action="retry-chats">Try again</button>');
  });
  host.addEventListener('click', event => { if (event.target.closest('[data-action="retry-chats"]')) { list.innerHTML = listSkeleton(5); loadConversations().then(draw).catch(() => draw()); } });
  draw();
  return () => { unsubscribe(); stopLongPress(); clearTimeout(searchTimer); };
}

function highlight(text, query) {
  const source = String(text || '');
  const index = source.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return escapeHtml(source.slice(0, 120));
  const start = Math.max(0, index - 30);
  return `${start ? '…' : ''}${escapeHtml(source.slice(start, index))}<mark>${escapeHtml(source.slice(index, index + query.length))}</mark>${escapeHtml(source.slice(index + query.length, index + query.length + 80))}`;
}
