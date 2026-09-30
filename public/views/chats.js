import { request } from '../api.js';
import { icon } from '../icons.js';
import { navigate } from '../router.js';
import { conversationById, loadConversations, loadMembers, markConversationRead, patchConversation, removeConversation, state, subscribe } from '../store.js';
import { actionSheet, avatar, emptyState, escapeHtml, listSkeleton, modal, toast, topBar } from '../ui.js';
import { onLongPress } from '../lib/gestures.js';
import { enablePullToRefresh } from '../lib/pull.js';
import { t, tn } from '../lib/i18n.js';
import { onSettingsChange, settings } from '../lib/settings.js';
import { conversationAvatar, enableRowSwipes, otherMember, renderRows } from '../components/chatRow.js';
import { createStoriesTray, renderStoriesTray } from '../components/stories.js';

const BUILT_IN_FOLDERS = [
  { id: 'all', label: () => t('All'), match: () => true },
  { id: 'unread', label: () => t('Unread'), match: item => item.unread || item.markedUnread },
  { id: 'direct', label: () => t('Personal'), match: item => item.kind === 'direct' },
  { id: 'group', label: () => t('Groups'), match: item => item.kind === 'group' }
];

function folders() {
  const custom = settings().folders.map(folder => ({
    id: `custom-${folder.id}`, label: () => folder.name, custom: true,
    match: item => folder.chatIds.includes(item.id) || (folder.direct && item.kind === 'direct') || (folder.groups && item.kind === 'group'),
    unreadOnly: folder.unreadOnly
  }));
  return [...BUILT_IN_FOLDERS, ...custom];
}

function connectionTitle() {
  if (navigator.onLine === false || state.realtime === 'offline') return `<span class="connecting">${t('Waiting for network…')}</span>`;
  if (state.realtime === 'connecting') return `<span class="connecting"><span class="spinner spinner-sm"></span>${t('Connecting…')}</span>`;
  return `<span class="brand"><span class="brand-mark-sm">${icon('lock', 14)}</span>Circle</span>`;
}

/** Shared long-press / swipe actions for a chat, used by the main list and the archive. */
export async function runChatAction(conversationId, action) {
  const conversation = conversationById(conversationId);
  if (!conversation) return;
  const settingsCall = async body => {
    const { conversation: updated } = await request(`/api/conversations/${conversationId}/settings`, { method: 'POST', body });
    patchConversation(conversationId, updated);
  };
  try {
    if (action === 'pin') await settingsCall({ pinned: !conversation.pinned });
    if (action === 'mute') { await settingsCall({ muted: !conversation.muted }); toast(conversation.muted ? t('Notifications muted') : t('Notifications on')); }
    if (action === 'archive') { await settingsCall({ archived: true, pinned: false }); toast(t('Chat archived')); }
    if (action === 'unarchive') { await settingsCall({ archived: false }); toast(t('Chat moved to the list')); }
    if (action === 'unread') await settingsCall({ markedUnread: true });
    if (action === 'read') {
      if (conversation.lastMessage?.id) await request(`/api/conversations/${conversationId}/read`, { method: 'POST', body: { messageId: conversation.lastMessage.id } });
      await settingsCall({ markedUnread: false });
      markConversationRead(conversationId);
    }
    if (action === 'delete') {
      const leaving = conversation.kind === 'group' && !conversation.isMainGroup;
      const choice = await actionSheet({
        title: leaving ? t('Leave “{name}”?', { name: conversation.title }) : t('Delete chat with {name}?', { name: conversation.title }),
        header: `<p class="sheet-text">${leaving ? t('You will stop receiving messages from this group.') : t('The chat disappears from your list and its history is removed for you only. It comes back if someone writes again.')}</p>`,
        actions: [
          leaving ? { id: 'leave', label: t('Leave group'), icon: 'logout', danger: true } : { id: 'clear', label: t('Delete for me'), icon: 'trash', danger: true },
          { id: 'cancel', label: t('Cancel') }
        ]
      });
      if (choice === 'leave') { await request(`/api/conversations/${conversationId}/leave`, { method: 'POST' }); removeConversation(conversationId); toast(t('You left the group')); }
      if (choice === 'clear') { await request(`/api/conversations/${conversationId}/clear`, { method: 'POST' }); removeConversation(conversationId); toast(t('Chat deleted')); }
    }
  } catch (error) { toast(error.message, 'error'); }
}

async function openChatMenu(conversationId) {
  const conversation = conversationById(conversationId);
  if (!conversation) return;
  const unread = conversation.unread || conversation.markedUnread;
  const choice = await actionSheet({
    header: `<div class="sheet-chat-head">${conversationAvatar(conversation, 'sm')}<strong>${escapeHtml(conversation.title)}</strong></div>`,
    actions: [
      { id: 'pin', label: conversation.pinned ? t('Unpin') : t('Pin to top'), icon: 'pin' },
      { id: 'mute', label: conversation.muted ? t('Unmute') : t('Mute'), icon: conversation.muted ? 'bell' : 'mute' },
      { id: unread ? 'read' : 'unread', label: unread ? t('Mark as read') : t('Mark as unread'), icon: unread ? 'checks' : 'unread' },
      { id: conversation.archived ? 'unarchive' : 'archive', label: conversation.archived ? t('Unarchive') : t('Archive'), icon: conversation.archived ? 'unarchive' : 'archive' },
      { id: 'delete', label: conversation.kind === 'group' && !conversation.isMainGroup ? t('Leave group') : t('Delete chat'), icon: 'trash', danger: true }
    ]
  });
  if (choice) runChatAction(conversationId, choice);
}

function chatListBody({ archived }) {
  return `<div class="chat-list" data-list>${listSkeleton(7)}</div>`;
}

function mountChatList(host, list, { archived, getFolder }) {
  const cache = new Map();
  const swipes = enableRowSwipes(list, (id, action) => runChatAction(id, action));
  const stopLongPress = onLongPress(list, '.chat-row', element => { swipes.close(false); openChatMenu(Number(element.dataset.conversation)); });
  list.addEventListener('click', event => {
    const open = event.target.closest('[data-open]');
    if (open) navigate(`/chat/${open.dataset.open}`);
  });
  const draw = () => {
    if (!state.conversations.loaded) return;
    const folder = getFolder?.();
    let items = state.conversations.items.filter(item => Boolean(item.archived) === archived);
    if (folder) items = items.filter(item => folder.match(item) && (!folder.unreadOnly || item.unread || item.markedUnread));
    if (!items.length) {
      cache.clear();
      list.innerHTML = archived
        ? emptyState('archive', t('No archived chats'), t('Swipe a chat to the left and tap Archive to keep your list tidy. Archived chats stay here even when new messages arrive.'))
        : folder && folder.id !== 'all'
          ? emptyState(folder.id === 'unread' ? 'checks' : 'folder', folder.id === 'unread' ? t('All caught up') : t('Nothing in this folder'), folder.id === 'unread' ? t('You have read every message.') : t('Chats that match this folder will appear here.'))
          : emptyState('chat', t('No chats yet'), t('Start a private chat with someone in your circle.'), `<button class="button button-primary" data-action="compose">${t('New message')}</button>`);
      return;
    }
    if (list.querySelector('.skeleton-rows, .empty-state')) list.innerHTML = '';
    renderRows(list, items, cache, { archivedList: archived });
  };
  return { draw, cleanup: () => { stopLongPress(); } };
}

export function renderChats(host, params, screen) {
  let folderId = sessionStorage.getItem('circle-chat-folder') || 'all';
  host.innerHTML = `
    ${topBar({ leading: `<div class="topbar-brand" data-connection>${connectionTitle()}</div>`, actions: `
      <button class="icon-button" data-action="search" aria-label="${t('Search')}">${icon('search', 23)}</button>` , className: 'topbar-root' })}
    <div class="screen-scroll" data-scroll>
      <div data-stories></div>
      <div class="folder-tabs" role="tablist" data-folders></div>
      <button class="archived-row" data-action="archived" hidden></button>
      ${chatListBody({ archived: false })}
    </div>
    <button class="fab" data-action="compose" aria-label="${t('New message')}">${icon('edit', 24)}</button>`;

  const scroller = host.querySelector('[data-scroll]');
  const list = host.querySelector('[data-list]');
  const foldersHost = host.querySelector('[data-folders]');
  const archivedRow = host.querySelector('.archived-row');
  const tray = createStoriesTray();
  host.querySelector('[data-stories]').append(tray);
  const currentFolder = () => folders().find(folder => folder.id === folderId) || BUILT_IN_FOLDERS[0];
  const chatList = mountChatList(host, list, { archived: false, getFolder: currentFolder });

  const drawFolders = () => {
    const all = folders();
    if (!all.some(folder => folder.id === folderId)) folderId = 'all';
    foldersHost.innerHTML = all.map(folder => {
      const count = state.conversations.items.filter(item => !item.archived && folder.match(item) && (item.unread || item.markedUnread) && !item.muted).length;
      return `<button class="folder-tab${folder.id === folderId ? ' active' : ''}" role="tab" aria-selected="${folder.id === folderId}" data-folder="${escapeHtml(folder.id)}">${escapeHtml(folder.label())}${count ? `<b>${count}</b>` : ''}</button>`;
    }).join('') + `<button class="folder-tab folder-edit" data-action="folders" aria-label="${t('Edit folders')}">${icon('sort', 16)}</button>`;
  };

  const drawArchived = () => {
    const archived = state.conversations.items.filter(item => item.archived);
    archivedRow.hidden = !archived.length || folderId !== 'all';
    if (archivedRow.hidden) return;
    const unread = archived.reduce((sum, item) => sum + (item.unread || 0), 0);
    archivedRow.innerHTML = `<span class="avatar avatar-md archived-avatar">${icon('archive', 24)}</span>
      <span class="conversation-main"><span class="conversation-row"><strong>${t('Archived Chats')}</strong></span>
      <span class="conversation-row"><span class="conversation-preview">${escapeHtml(archived.map(item => item.title).join(', '))}</span>${unread ? `<span class="unread-pill muted">${unread}</span>` : ''}</span></span>`;
  };

  const draw = () => { drawFolders(); drawArchived(); chatList.draw(); };
  const drawHeader = () => { host.querySelector('[data-connection]').innerHTML = connectionTitle(); };

  host.addEventListener('click', event => {
    const folderButton = event.target.closest('[data-folder]');
    if (folderButton) {
      folderId = folderButton.dataset.folder;
      sessionStorage.setItem('circle-chat-folder', folderId);
      folderButton.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
      return draw();
    }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'search') navigate('/search');
    if (action === 'archived') navigate('/chat/archived');
    if (action === 'compose') openCompose();
    if (action === 'folders') navigate('/settings/folders');
  });

  enablePullToRefresh(scroller, () => Promise.all([loadConversations(), import('../store.js').then(store => store.loadStories())]));

  const unsubscribe = subscribe(event => {
    if (['conversations', 'message', 'messages', 'presence', 'members', 'typing'].includes(event)) draw();
    if (['stories', 'story:viewed', 'members'].includes(event)) renderStoriesTray(tray);
    if (event === 'realtime:status') drawHeader();
  });
  const unsubscribeSettings = onSettingsChange((next, changed) => { if (changed?.folders) draw(); });
  const onNetwork = () => drawHeader();
  window.addEventListener('online', onNetwork);
  window.addEventListener('offline', onNetwork);
  screen.onShow(() => {
    draw();
    // Returning from a conversation must reconcile archive/read state and stories that changed while
    // this tab root stayed mounted underneath it.
    loadConversations().then(draw).catch(() => {});
    import('../store.js').then(store => store.loadStories().then(() => renderStoriesTray(tray)).catch(() => {}));
  });

  loadConversations().then(draw).catch(error => {
    if (!state.conversations.loaded) list.innerHTML = emptyState('alert', t('Could not load chats'), error.message, `<button class="button" data-action="retry">${t('Try again')}</button>`);
  });
  import('../store.js').then(store => store.loadStories().then(() => renderStoriesTray(tray)).catch(() => {}));
  host.addEventListener('click', event => { if (event.target.closest('[data-action="retry"]')) { list.innerHTML = listSkeleton(6); loadConversations().then(draw).catch(() => draw()); } });
  draw();

  return () => {
    unsubscribe(); unsubscribeSettings(); chatList.cleanup();
    window.removeEventListener('online', onNetwork);
    window.removeEventListener('offline', onNetwork);
  };
}

export function renderArchived(host) {
  host.innerHTML = `
    ${topBar({ title: t('Archived Chats'), back: '/' })}
    <div class="screen-scroll" data-scroll>
      <p class="list-hint">${t('Archived chats stay here when new messages arrive. Swipe right to move one back.')}</p>
      ${chatListBody({ archived: true })}
    </div>`;
  const list = host.querySelector('[data-list]');
  const chatList = mountChatList(host, list, { archived: true });
  const unsubscribe = subscribe(event => { if (['conversations', 'message', 'messages', 'presence', 'members', 'typing'].includes(event)) chatList.draw(); });
  loadConversations().then(chatList.draw).catch(() => chatList.draw());
  chatList.draw();
  return () => { unsubscribe(); chatList.cleanup(); };
}

/* ------------------------------ new message ------------------------------ */

async function openDirect(userId) {
  const { conversationId } = await request('/api/conversations/direct', { method: 'POST', body: { userId } });
  if (!conversationById(conversationId)) await loadConversations();
  navigate(`/chat/${conversationId}`);
}

export async function openCompose() {
  const sheet = modal(`
    <div class="modal-head"><h2>${t('New message')}</h2><button class="icon-button" data-close-modal aria-label="${t('Close')}">${icon('close', 20)}</button></div>
    <label class="search-field">${icon('search', 18)}<input type="search" data-filter placeholder="${t('Search members')}" autocomplete="off"></label>
    <div class="action-list compact"><button class="action-item" data-new-group>${icon('users', 21)}<span>${t('New group')}</span></button></div>
    <h3 class="sheet-section">${t('Members')}</h3>
    <div data-members>${listSkeleton(3)}</div>`, 'compose-sheet');
  let members = [];
  const draw = filter => {
    const lower = filter.toLowerCase();
    const others = members.filter(member => member.id !== state.user?.id && (!lower || member.displayName.toLowerCase().includes(lower) || member.username.includes(lower)));
    sheet.querySelector('[data-members]').innerHTML = others.length
      ? `<div class="member-list">${others.map(member => `<button class="member-item" data-direct="${member.id}">
          <span class="avatar-wrap${member.online ? ' is-online' : ''}">${avatar(member, 'sm')}</span><div><strong>${escapeHtml(member.displayName)}</strong><small>@${escapeHtml(member.username)}</small></div>
        </button>`).join('')}</div>`
      : `<p class="field-hint">${filter ? t('No members match “{query}”.', { query: escapeHtml(filter) }) : t('Invite someone from Settings → Invite friends first.')}</p>`;
  };
  try { members = await loadMembers(true); draw(''); } catch (error) { sheet.querySelector('[data-members]').innerHTML = `<p class="field-hint">${escapeHtml(error.message)}</p>`; }
  sheet.querySelector('[data-filter]').addEventListener('input', event => draw(event.target.value.trim()));
  sheet.addEventListener('click', async event => {
    const button = event.target.closest('[data-direct]');
    if (button) { sheet.close(); try { await openDirect(Number(button.dataset.direct)); } catch (error) { toast(error.message, 'error'); } }
    if (event.target.closest('[data-new-group]')) { sheet.close(); openNewGroup(members); }
  });
}

function openNewGroup(members) {
  const selected = new Set();
  const others = members.filter(member => member.id !== state.user?.id);
  const sheet = modal(`
    <div class="modal-head"><h2>${t('New group')}</h2><button class="icon-button" data-close-modal aria-label="${t('Close')}">${icon('close', 20)}</button></div>
    <div class="field"><input data-title maxlength="64" placeholder="${t('Group name')}" aria-label="${t('Group name')}"></div>
    <h3 class="sheet-section" data-count>${t('Add members')}</h3>
    <div class="forward-list">${others.map(member => `<label class="forward-item">
      <input type="checkbox" value="${member.id}">${avatar(member, 'sm')}<span>${escapeHtml(member.displayName)}</span><i class="check-circle">${icon('check', 14)}</i></label>`).join('')}</div>
    <button class="button button-primary button-block" data-create disabled>${t('Create group')}</button>`);
  const title = sheet.querySelector('[data-title]');
  const create = sheet.querySelector('[data-create]');
  const sync = () => {
    create.disabled = !title.value.trim() || !selected.size;
    sheet.querySelector('[data-count]').textContent = selected.size ? tn(selected.size, '{n} member selected', '{n} members selected') : t('Add members');
  };
  title.addEventListener('input', sync);
  sheet.addEventListener('change', event => {
    if (event.target.type !== 'checkbox') return;
    if (event.target.checked) selected.add(Number(event.target.value)); else selected.delete(Number(event.target.value));
    sync();
  });
  create.addEventListener('click', async () => {
    create.disabled = true;
    try {
      const { conversation } = await request('/api/conversations/group', { method: 'POST', body: { title: title.value.trim(), memberIds: [...selected] } });
      await loadConversations();
      sheet.close();
      navigate(`/chat/${conversation.id}`);
    } catch (error) { toast(error.message, 'error'); create.disabled = false; }
  });
  setTimeout(() => title.focus(), 300);
}

export { otherMember };
