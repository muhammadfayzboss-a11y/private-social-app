import { request } from '../api.js';
import { icon } from '../icons.js';
import { navigate } from '../router.js';
import { applyProfile, conversationById, loadConversations, patchConversation, state, subscribe } from '../store.js';
import { actionSheet, avatar, confirmSheet, emptyState, escapeHtml, mediaView, modal, toast, topBar } from '../ui.js';
import { exactTime, lastSeenText, relativeTime, timeTag } from '../lib/time.js';
import { locale, t, tn } from '../lib/i18n.js';
import { createPostCard } from '../components/post.js';
import { pickFiles, uploadFiles } from '../components/media.js';
import { preparePhoto } from '../components/attach.js';
import { addStory, openStoryViewer } from '../components/stories.js';
import { mountSharedMedia } from '../components/sharedMedia.js';

function viewersMarkup(views) {
  if (!views?.length) return `<p class="field-hint">${t('Nobody has viewed this story yet. Viewers appear here as soon as they watch it.')}</p>`;
  return `<div class="member-list">${views.map(view => `
    <button class="member-item" data-member="${view.user.id}">${avatar(view.user, 'sm')}
      <div><strong>${escapeHtml(view.user.displayName)}</strong><small title="${escapeHtml(exactTime(view.viewedAt))}">${t('Viewed {time}', { time: escapeHtml(relativeTime(view.viewedAt)) })}</small></div>
      ${view.reaction ? `<span class="viewer-reaction">${escapeHtml(view.reaction)}</span>` : ''}
    </button>`).join('')}</div>`;
}

function archiveMarkup(archive) {
  if (!archive) return `<div class="story-archive">${'<i class="skeleton-tile"></i>'.repeat(3)}</div>`;
  if (!archive.stories.length) return `<p class="field-hint">${t('Stories you share appear here with everyone who viewed them. Only you can see this list.')}</p>`;
  return `<div class="story-archive">${archive.stories.map(story => `
    <button class="archive-item${story.expired ? ' expired' : ''}" data-archive="${story.id}">
      ${(story.media.mimeType || '').startsWith('video/') ? `<video src="${escapeHtml(story.media.url)}" preload="metadata" muted playsinline></video>` : `<img src="${escapeHtml(story.media.url)}" alt="" loading="lazy" decoding="async">`}
      <span class="archive-meta"><span>${icon('eye', 13)} ${story.viewCount}</span><span>${story.expired ? t('Expired') : relativeTime(story.createdAt)}</span></span>
    </button>`).join('')}</div>
    <p class="field-hint">${t('Only you can see this. Expired stories stay here for {days} days.', { days: archive.retentionDays })}</p>`;
}

export function openEditProfile() {
  let avatarMediaId;
  const sheet = modal(`
    <div class="modal-head"><h2>${t('Edit profile')}</h2><button class="icon-button" data-close-modal aria-label="${t('Close')}">${icon('close', 20)}</button></div>
    <div class="edit-avatar">
      <span data-avatar-preview>${avatar(state.user, 'lg')}</span>
      <div class="edit-avatar-actions">
        <button class="text-button" data-change-avatar>${icon('camera', 18)} ${t('Set new photo')}</button>
        ${state.user.avatarUrl ? `<button class="text-button danger-text" data-remove-avatar>${t('Remove photo')}</button>` : ''}
      </div>
    </div>
    <form data-profile-form>
      <div class="field"><label for="displayName">${t('Name')}</label><input id="displayName" name="displayName" maxlength="50" value="${escapeHtml(state.user.displayName)}" required></div>
      <div class="field"><label for="username">${t('Username')}</label><div class="input-prefix"><span>@</span><input id="username" name="username" maxlength="24" value="${escapeHtml(state.user.username)}" autocapitalize="none" spellcheck="false" required></div>
        <span class="field-hint">${t('3–24 lowercase letters, numbers, or underscores. Members can mention you with it.')}</span></div>
      <div class="field"><label for="bio">${t('Bio')}</label><textarea id="bio" name="bio" maxlength="180" rows="3" placeholder="${t('A few words about yourself')}">${escapeHtml(state.user.bio || '')}</textarea></div>
      <button class="button button-primary button-block" type="submit">${t('Save')}</button>
    </form>`);

  sheet.querySelector('[data-change-avatar]').addEventListener('click', async () => {
    const files = await pickFiles('image/*', false);
    if (!files.length) return;
    try {
      toast(t('Uploading photo…'));
      const prepared = await preparePhoto(files[0]);
      const [media] = await uploadFiles([prepared.file], 'avatar', prepared);
      avatarMediaId = media.id;
      sheet.querySelector('[data-avatar-preview]').innerHTML = `<img class="avatar avatar-lg" src="${escapeHtml(media.url)}" alt="">`;
    } catch (error) { toast(error.message, 'error'); }
  });
  sheet.querySelector('[data-remove-avatar]')?.addEventListener('click', () => {
    avatarMediaId = null;
    sheet.querySelector('[data-avatar-preview]').innerHTML = avatar({ ...state.user, avatarUrl: null }, 'lg');
  });

  sheet.querySelector('[data-profile-form]').addEventListener('submit', async event => {
    event.preventDefault();
    const form = Object.fromEntries(new FormData(event.target).entries());
    const submit = event.target.querySelector('[type="submit"]');
    submit.disabled = true;
    try {
      const payload = { displayName: form.displayName, bio: form.bio };
      if (avatarMediaId !== undefined) payload.avatarMediaId = avatarMediaId;
      let { user } = await request('/api/profile', { method: 'PATCH', body: payload });
      const username = String(form.username || '').trim().toLowerCase();
      if (username && username !== state.user.username) ({ user } = await request('/api/profile/username', { method: 'PATCH', body: { username } }));
      state.user = { ...state.user, ...user };
      applyProfile(user);
      sheet.close();
      toast(t('Profile updated'));
    } catch (error) { toast(error.message, 'error'); submit.disabled = false; }
  });
}

export function renderProfile(host, { userId, conversationId } = {}, screen) {
  const targetId = Number(userId || state.user?.id);
  const isSelf = targetId === state.user?.id;
  let tab = isSelf ? 'posts' : 'shared';
  let data = null;
  let archive = null;
  let sharedCleanup = null;

  host.innerHTML = `${topBar({ title: '', back: isSelf ? '/settings' : '/' })}
    <div class="screen-scroll" data-scroll><div class="profile-header skeleton-hero" aria-hidden="true"><i></i><span></span><span></span></div></div>`;
  const scroll = host.querySelector('[data-scroll]');

  const directId = () => Number(conversationId) || data?.relationship?.directConversationId || null;

  const draw = () => {
    if (!data) return;
    sharedCleanup?.(); sharedCleanup = null;
    const { posts, stats } = data;
    const live = isSelf ? { ...data.user, ...state.user } : { ...data.user, ...(state.members.find(member => member.id === targetId) || {}) };
    const mediaItems = posts.flatMap(post => post.media.map(media => ({ media, postId: post.id })));
    const direct = directId() ? conversationById(directId()) : null;
    const blocked = data.relationship?.blockedByMe;
    if (!directId() && tab === 'shared') tab = 'posts';
    scroll.innerHTML = `
      <section class="profile-header">
        <button class="profile-avatar avatar-wrap${live.online && !isSelf ? ' is-online' : ''}" data-action="${isSelf ? 'edit' : 'avatar'}" aria-label="${t('Profile photo')}">${avatar(live, 'xl')}</button>
        <h1>${escapeHtml(live.displayName)}</h1>
        <p class="profile-status${live.online ? ' online' : ''}">${escapeHtml(isSelf ? t('online') : blocked ? t('blocked') : lastSeenText(live))}</p>
        <div class="profile-buttons">
          ${isSelf ? `
            <button class="profile-button" data-action="edit">${icon('edit', 22)}<span>${t('Edit')}</span></button>
            <button class="profile-button" data-action="add-story">${icon('camera', 22)}<span>${t('Story')}</span></button>
            <button class="profile-button" data-action="settings">${icon('settings', 22)}<span>${t('Settings')}</span></button>` : `
            <button class="profile-button" data-action="message">${icon('chat', 22)}<span>${t('Message')}</span></button>
            ${direct ? `<button class="profile-button" data-action="mute">${icon(direct.muted ? 'bell' : 'mute', 22)}<span>${direct.muted ? t('Unmute') : t('Mute')}</span></button>` : ''}
            ${stats?.activeStories ? `<button class="profile-button" data-action="view-stories">${icon('eye', 22)}<span>${t('Story')}</span></button>` : ''}
            <button class="profile-button" data-action="more">${icon('more', 22)}<span>${t('More')}</span></button>`}
        </div>
      </section>
      <section class="group"><div class="group-body info-rows">
        ${live.bio ? `<div class="info-row"><span class="info-value">${escapeHtml(live.bio)}</span><small>${t('Bio')}</small></div>` : isSelf ? `<button class="info-row" data-action="edit"><span class="info-value muted">${t('Add a few words about yourself')}</span><small>${t('Bio')}</small></button>` : ''}
        <button class="info-row" data-action="copy-username"><span class="info-value">@${escapeHtml(live.username)}</span><small>${t('Username')}</small></button>
        <div class="info-row"><span class="info-value">${escapeHtml(new Date(live.createdAt).toLocaleDateString(locale(), { day: 'numeric', month: 'long', year: 'numeric' }))}</span><small>${t('Joined')}${live.role === 'admin' ? ` · ${t('Group admin')}` : ''}</small></div>
      </div></section>
      ${isSelf ? `<section class="group"><div class="group-title-row"><h3 class="group-title">${t('Your stories')}</h3><button class="text-button" data-action="add-story">${icon('plus', 16)} ${t('Add')}</button></div>
        <div class="group-body padded" data-archive-host>${archiveMarkup(archive)}</div></section>` : ''}
      <div class="profile-tabs segmented" role="tablist">
        ${!isSelf && directId() ? `<button role="tab" data-tab="shared" class="${tab === 'shared' ? 'active' : ''}">${t('Shared')}</button>` : ''}
        <button role="tab" data-tab="posts" class="${tab === 'posts' ? 'active' : ''}">${t('Posts')} ${stats?.posts ?? posts.length}</button>
        <button role="tab" data-tab="media" class="${tab === 'media' ? 'active' : ''}">${t('Media')} ${mediaItems.length}</button>
      </div>
      <div data-content class="profile-content"></div>`;

    const content = scroll.querySelector('[data-content]');
    if (tab === 'shared' && directId()) sharedCleanup = mountSharedMedia(content, directId());
    else if (tab === 'posts') {
      if (!posts.length) content.innerHTML = emptyState('image', t('No posts yet'), isSelf ? t('Your posts will appear here.') : t('{name} has not posted yet.', { name: live.displayName }), isSelf ? `<button class="button button-primary" data-action="create">${t('Create a post')}</button>` : '');
      else { content.classList.add('feed'); posts.forEach(post => content.append(createPostCard(post))); }
    } else {
      content.innerHTML = mediaItems.length
        ? `<div class="profile-grid">${mediaItems.map(item => `<button class="profile-grid-item" data-post-link="${item.postId}">${mediaView(item.media, 'grid-media')}</button>`).join('')}</div>`
        : emptyState('camera', t('No media yet'), t('Photos and videos from posts appear here.'));
    }
    host.querySelector('.topbar-title strong').textContent = isSelf ? t('My profile') : '';
  };

  const loadArchive = () => {
    if (!isSelf) return;
    request('/api/stories/archive').then(result => { archive = result; const target = scroll.querySelector('[data-archive-host]'); if (target) target.innerHTML = archiveMarkup(archive); })
      .catch(() => { archive = { stories: [], retentionDays: 30 }; });
  };

  function openArchivedStory(story) {
    const sheet = modal(`
      <div class="modal-head"><h2>${t('Story')}</h2><button class="icon-button" data-close-modal aria-label="${t('Close')}">${icon('close', 20)}</button></div>
      <div class="archive-preview">
        ${(story.media.mimeType || '').startsWith('video/') ? `<video src="${escapeHtml(story.media.url)}" controls playsinline preload="metadata"></video>` : `<img src="${escapeHtml(story.media.url)}" alt="">`}
        <div><strong>${story.caption ? escapeHtml(story.caption) : t('No caption')}</strong>
          <small>${t('Shared')} ${timeTag(story.createdAt)} · ${story.expired ? t('expired') : t('live')}</small></div>
      </div>
      ${!story.expired ? `<button class="button button-block" data-open-live>${icon('eye', 18)} ${t('Open in story viewer')}</button>` : ''}
      <h3 class="sheet-section">${tn(story.viewCount, '{n} viewer', '{n} viewers')}</h3>
      ${viewersMarkup(story.views)}`);
    sheet.addEventListener('click', event => {
      const member = event.target.closest('[data-member]');
      if (member) { sheet.close(); navigate(`/profile/${member.dataset.member}`); }
      if (event.target.closest('[data-open-live]')) { sheet.close(); openStoryViewer(state.user.id, { storyId: story.id }); }
    });
  }

  async function openMore() {
    const blocked = data.relationship?.blockedByMe;
    const choice = await actionSheet({
      actions: [
        directId() && { id: 'search', label: t('Search in chat'), icon: 'search' },
        { id: blocked ? 'unblock' : 'block', label: blocked ? t('Unblock') : t('Block {name}', { name: data.user.displayName.split(' ')[0] }), icon: 'block', danger: !blocked }
      ].filter(Boolean)
    });
    if (choice === 'search') navigate(`/chat/${directId()}`);
    if (choice === 'block') {
      if (!(await confirmSheet({ title: t('Block {name}?', { name: data.user.displayName }), text: t('They won’t be able to message you, see your last seen, or see your stories. You can unblock at any time.'), confirm: t('Block') }))) return;
      await request('/api/blocks', { method: 'POST', body: { userId: targetId } });
      data.relationship.blockedByMe = true;
      toast(t('{name} is blocked', { name: data.user.displayName }));
      loadConversations().catch(() => {});
      draw();
    }
    if (choice === 'unblock') {
      await request(`/api/blocks/${targetId}`, { method: 'DELETE' });
      data.relationship.blockedByMe = false;
      toast(t('Member unblocked'));
      loadConversations().catch(() => {});
      draw();
    }
  }

  host.addEventListener('click', async event => {
    const tabButton = event.target.closest('[data-tab]');
    if (tabButton) { tab = tabButton.dataset.tab; draw(); return; }
    const link = event.target.closest('[data-post-link]');
    if (link) return navigate(`/feed?post=${link.dataset.postLink}`);
    const archived = event.target.closest('[data-archive]');
    if (archived) return openArchivedStory(archive.stories.find(story => story.id === Number(archived.dataset.archive)));
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;
    try {
      const action = trigger.dataset.action;
      if (action === 'settings') navigate('/settings');
      if (action === 'create') navigate('/create');
      if (action === 'edit') openEditProfile();
      if (action === 'add-story') { await addStory(); loadArchive(); }
      if (action === 'view-stories') openStoryViewer(targetId);
      if (action === 'more') openMore();
      if (action === 'avatar' && data.user.avatarUrl) modal(`<img class="lightbox-image" src="${escapeHtml(data.user.avatarUrl)}" alt=""><button class="icon-button lightbox-close" data-close-modal aria-label="${t('Close')}">${icon('close', 24)}</button>`, 'lightbox');
      if (action === 'copy-username') { try { await navigator.clipboard.writeText(`@${data.user.username}`); toast(t('Username copied')); } catch { /* clipboard unavailable */ } }
      if (action === 'mute' && directId()) {
        const direct = conversationById(directId());
        const { conversation } = await request(`/api/conversations/${directId()}/settings`, { method: 'POST', body: { muted: !direct?.muted } });
        patchConversation(directId(), conversation);
        draw();
      }
      if (action === 'message') {
        const { conversationId: id } = await request('/api/conversations/direct', { method: 'POST', body: { userId: targetId } });
        if (!conversationById(id)) await loadConversations();
        navigate(`/chat/${id}`);
      }
    } catch (error) { toast(error.message, 'error'); }
  });

  const unsubscribe = subscribe((event, payload) => {
    if (['presence', 'members', 'conversations'].includes(event) && data && tab !== 'shared') draw();
    if (event === 'story:viewed' && isSelf && archive) {
      const story = archive.stories.find(item => item.id === payload.storyId);
      if (story) { story.views = [payload.view, ...(story.views || []).filter(item => item.user.id !== payload.view.user.id)]; story.viewCount = story.views.length; const target = scroll.querySelector('[data-archive-host]'); if (target) target.innerHTML = archiveMarkup(archive); }
    }
    if (event === 'stories' && isSelf) loadArchive();
  });

  request(`/api/profiles/${targetId}`).then(result => { data = result; draw(); })
    .catch(error => { scroll.innerHTML = emptyState('alert', t('Could not load profile'), error.status === 404 ? t('This member no longer exists.') : error.message); });
  loadArchive();

  return () => { unsubscribe(); sharedCleanup?.(); };
}
