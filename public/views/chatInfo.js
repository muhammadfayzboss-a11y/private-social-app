import { request } from '../api.js';
import { icon } from '../icons.js';
import { navigate } from '../router.js';
import { conversationById, loadConversations, memberById, patchConversation, state, subscribe } from '../store.js';
import { avatar, emptyState, escapeHtml, modal, toast, topBar } from '../ui.js';
import { lastSeenText } from '../lib/time.js';
import { t, tn } from '../lib/i18n.js';
import { conversationAvatar, otherMember } from '../components/chatRow.js';
import { mountSharedMedia } from '../components/sharedMedia.js';
import { renderProfile } from './profile.js';
import { runChatAction } from './chats.js';

/**
 * Chat details. A private chat shows the other member's profile (with this chat's shared media);
 * a group shows its members, notification and pin controls, and shared media.
 */
export function renderChatInfo(host, { conversationId }, screen) {
  const id = Number(conversationId);
  let cleanupInner = null;
  let sharedCleanup = null;

  const renderGroup = conversation => {
    const canRename = conversation.createdBy === state.user?.id || state.user?.role === 'admin';
    host.innerHTML = `${topBar({ title: t('Group info'), back: `/chat/${id}`, actions: canRename && !conversation.isMainGroup ? `<button class="text-button" data-action="rename">${t('Edit')}</button>` : '' })}
      <div class="screen-scroll" data-scroll>
        <section class="profile-header">
          <span class="profile-avatar">${conversationAvatar(conversation, 'xl')}</span>
          <h1>${escapeHtml(conversation.title)}</h1>
          <p class="profile-status">${escapeHtml(tn(conversation.members.length, '{n} member', '{n} members'))}</p>
          <div class="profile-buttons">
            <button class="profile-button" data-action="mute">${icon(conversation.muted ? 'bell' : 'mute', 22)}<span>${conversation.muted ? t('Unmute') : t('Mute')}</span></button>
            <button class="profile-button" data-action="search">${icon('search', 22)}<span>${t('Search')}</span></button>
            <button class="profile-button" data-action="pin-chat">${icon('pin', 22)}<span>${conversation.pinned ? t('Unpin') : t('Pin')}</span></button>
            ${conversation.isMainGroup ? '' : `<button class="profile-button danger" data-action="leave">${icon('logout', 22)}<span>${t('Leave')}</span></button>`}
          </div>
        </section>
        <section class="group"><h3 class="group-title">${escapeHtml(tn(conversation.members.length, '{n} member', '{n} members'))}</h3><div class="group-body">
          ${conversation.members.map(member => {
            const live = memberById(member.id) || member;
            return `<button class="row member-row" data-member="${member.id}">${avatar(live, 'sm')}<span class="row-text"><span class="row-label">${escapeHtml(live.displayName)}${live.id === state.user?.id ? ` <small>(${t('you')})</small>` : ''}</span>
              <small class="${live.online ? 'online-text' : ''}">${escapeHtml(live.id === state.user?.id ? t('online') : lastSeenText(live))}</small></span>${live.role === 'admin' ? `<span class="row-value">${t('admin')}</span>` : ''}</button>`;
          }).join('')}
        </div></section>
        <section class="group"><div class="group-body padded" data-shared></div></section>
      </div>`;
    sharedCleanup?.();
    sharedCleanup = mountSharedMedia(host.querySelector('[data-shared]'), id);
  };

  const render = () => {
    const conversation = conversationById(id);
    if (!conversation) {
      host.innerHTML = `${topBar({ title: '', back: '/' })}<div class="screen-scroll">${emptyState('alert', t('Chat not found'), t('It may have been deleted.'))}</div>`;
      return;
    }
    if (conversation.kind === 'direct') {
      const other = otherMember(conversation);
      cleanupInner = renderProfile(host, { userId: other.id, conversationId: id }, screen);
      host.querySelector('[data-back]')?.setAttribute('data-back', `/chat/${id}`);
      return;
    }
    renderGroup(conversation);
  };

  host.addEventListener('click', async event => {
    const conversation = conversationById(id);
    if (!conversation || conversation.kind === 'direct') return;
    const member = event.target.closest('[data-member]');
    if (member) return navigate(`/profile/${member.dataset.member}`);
    const action = event.target.closest('[data-action]')?.dataset.action;
    try {
      if (action === 'mute' || action === 'pin-chat') {
        const body = action === 'mute' ? { muted: !conversation.muted } : { pinned: !conversation.pinned };
        const { conversation: updated } = await request(`/api/conversations/${id}/settings`, { method: 'POST', body });
        patchConversation(id, updated);
        renderGroup(conversationById(id));
      }
      if (action === 'search') navigate(`/chat/${id}`);
      if (action === 'leave') {
        await runChatAction(id, 'delete');
        if (!conversationById(id)) navigate('/', { replace: true });
      }
      if (action === 'rename') {
        const sheet = modal(`<div class="modal-head"><h2>${t('Edit group')}</h2><button class="icon-button" data-close-modal aria-label="${t('Close')}">${icon('close', 20)}</button></div>
          <form data-rename><div class="field"><label for="group-title">${t('Group name')}</label><input id="group-title" maxlength="64" value="${escapeHtml(conversation.title)}" required></div>
          <button class="button button-primary button-block" type="submit">${t('Save')}</button></form>`);
        sheet.querySelector('[data-rename]').addEventListener('submit', async submit => {
          submit.preventDefault();
          try {
            const { conversation: updated } = await request(`/api/conversations/${id}`, { method: 'PATCH', body: { title: sheet.querySelector('#group-title').value } });
            patchConversation(id, updated);
            sheet.close();
            renderGroup(conversationById(id));
          } catch (error) { toast(error.message, 'error'); }
        });
      }
    } catch (error) { toast(error.message, 'error'); }
  });

  const unsubscribe = subscribe(event => {
    const conversation = conversationById(id);
    if (conversation?.kind === 'group' && ['presence', 'members'].includes(event)) renderGroup(conversation);
  });

  if (conversationById(id)) render();
  else loadConversations().then(render).catch(() => render());

  return () => { unsubscribe(); cleanupInner?.(); sharedCleanup?.(); };
}
