import { request, setCsrf } from '../api.js';
import { icon } from '../icons.js';
import { navigate } from '../router.js';
import { applyProfile, loadMembers, resetState, state, subscribe } from '../store.js';
import { avatar, emptyState, escapeHtml, mediaView, modal, skeleton, timeAgo, toast } from '../ui.js';
import { createPostCard } from '../components/post.js';
import { pickFiles, uploadFiles } from '../components/media.js';

export function renderProfile(host, { userId } = {}) {
  const targetId = Number(userId || state.user?.id);
  const isSelf = targetId === state.user?.id;
  let tab = 'posts';
  let data = null;

  host.innerHTML = `<div class="page">${skeleton(2)}</div>`;

  const draw = () => {
    if (!data) return;
    const { user, posts } = data;
    const mediaItems = posts.flatMap(post => post.media.map(media => ({ media, postId: post.id })));
    host.innerHTML = `
      <div class="page">
        ${userId && !isSelf ? `<div class="page-title"><button class="icon-button" data-action="back" aria-label="Back">${icon('back', 22)}</button></div>` : ''}
        <section class="card profile-hero">
          <div class="profile-avatar-wrap ${user.online ? 'online-dot' : ''}">${avatar(user, 'xl')}</div>
          <h1>${escapeHtml(user.displayName)}</h1>
          <div class="handle">@${escapeHtml(user.username)}${user.role === 'admin' ? ' · admin' : ''}</div>
          ${user.bio ? `<p class="bio">${escapeHtml(user.bio)}</p>` : ''}
          <div class="profile-status ${user.online ? 'online' : ''}"><i></i>${user.online ? 'Online now' : user.lastSeenAt ? `Last seen ${timeAgo(user.lastSeenAt)} ago` : 'Offline'}</div>
          <div class="profile-actions">
            ${isSelf
              ? `<button class="button button-primary" data-action="edit">${icon('edit', 18)} Edit profile</button>
                 <button class="button" data-action="settings">${icon('users', 18)} Settings</button>`
              : `<button class="button button-primary" data-action="message">${icon('chat', 18)} Message</button>`}
          </div>
        </section>
        <div class="profile-tabs">
          <button class="profile-tab${tab === 'posts' ? ' active' : ''}" data-tab="posts">${icon('grid', 18)} Posts ${posts.length}</button>
          <button class="profile-tab${tab === 'media' ? ' active' : ''}" data-tab="media">${icon('image', 18)} Media ${mediaItems.length}</button>
        </div>
        <div data-content></div>
      </div>`;

    const content = host.querySelector('[data-content]');
    if (tab === 'posts') {
      if (!posts.length) content.innerHTML = emptyState('image', 'No posts yet', isSelf ? 'Your posts will appear here.' : `${user.displayName} has not posted yet.`);
      else { content.className = 'feed'; posts.forEach(post => content.append(createPostCard(post))); }
    } else {
      content.innerHTML = mediaItems.length
        ? `<div class="profile-grid">${mediaItems.map(item => `<button class="profile-grid-item" data-post-link="${item.postId}">${mediaView(item.media, 'grid-media')}</button>`).join('')}</div>`
        : emptyState('camera', 'No media yet', 'Photos and videos from posts appear here.');
    }
  };

  host.addEventListener('click', async event => {
    const tabButton = event.target.closest('[data-tab]');
    if (tabButton) { tab = tabButton.dataset.tab; draw(); return; }
    const link = event.target.closest('[data-post-link]');
    if (link) return navigate(`/?post=${link.dataset.postLink}`);
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;
    try {
      if (trigger.dataset.action === 'back') history.back();
      if (trigger.dataset.action === 'settings') navigate('/settings');
      if (trigger.dataset.action === 'edit') openEditProfile();
      if (trigger.dataset.action === 'message') {
        const { conversationId } = await request('/api/conversations/direct', { method: 'POST', body: { userId: targetId } });
        navigate(`/chat/${conversationId}`);
      }
    } catch (error) { toast(error.message, 'error'); }
  });

  function openEditProfile() {
    let avatarMediaId = undefined;
    const sheet = modal(`
      <div class="modal-head"><h2>Edit profile</h2><button class="icon-button" data-close-modal aria-label="Close">${icon('close', 20)}</button></div>
      <div class="edit-avatar">
        <span data-avatar-preview>${avatar(state.user, 'lg')}</span>
        <button class="button" data-change-avatar>${icon('camera', 18)} Change photo</button>
      </div>
      <form data-profile-form>
        <div class="field"><label for="displayName">Display name</label><input id="displayName" name="displayName" maxlength="50" value="${escapeHtml(state.user.displayName)}" required></div>
        <div class="field"><label for="bio">Bio</label><textarea id="bio" name="bio" maxlength="180" rows="3">${escapeHtml(state.user.bio || '')}</textarea></div>
        <button class="button button-primary button-block" type="submit">Save profile</button>
      </form>`);

    sheet.querySelector('[data-change-avatar]').addEventListener('click', async () => {
      const files = await pickFiles('image/*', false);
      if (!files.length) return;
      try {
        toast('Uploading photo…');
        const [media] = await uploadFiles(files, 'avatar');
        avatarMediaId = media.id;
        sheet.querySelector('[data-avatar-preview]').innerHTML = `<img class="avatar avatar-lg" src="${media.url}" alt="">`;
      } catch (error) { toast(error.message, 'error'); }
    });

    sheet.querySelector('[data-profile-form]').addEventListener('submit', async event => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(event.target).entries());
      if (avatarMediaId !== undefined) payload.avatarMediaId = avatarMediaId;
      try {
        const result = await request('/api/profile', { method: 'PATCH', body: payload });
        state.user = result.user;
        applyProfile(result.user);
        data.user = { ...data.user, ...result.user };
        sheet.remove();
        draw();
        toast('Profile updated');
      } catch (error) { toast(error.message, 'error'); }
    });
  }

  const unsubscribe = subscribe(event => { if (['presence', 'members', 'post'].includes(event) && data) draw(); });

  request(`/api/profiles/${targetId}`).then(result => { data = result; draw(); })
    .catch(error => { host.innerHTML = `<div class="page">${emptyState('close', 'Could not load profile', error.message)}</div>`; });

  return unsubscribe;
}

export function renderSettings(host) {
  host.innerHTML = `
    <div class="page">
      <div class="page-title"><div><h1>Settings</h1><p>Manage your circle.</p></div>
        <button class="icon-button" data-action="back" aria-label="Back">${icon('back', 22)}</button></div>
      <div class="settings-list">
        <button class="settings-item" data-action="theme">${icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon', 20)}<span>Switch to ${document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'} mode</span></button>
        <button class="settings-item" data-action="notifications">${icon('bell', 20)}<span>Enable push notifications</span></button>
        ${state.user?.role === 'admin' ? `
          <button class="settings-item" data-action="invite">${icon('plus', 20)}<span>Create invite code</span></button>
          <button class="settings-item" data-action="reload-stickers">${icon('smile', 20)}<span>Reload sticker packs</span></button>` : ''}
        <button class="settings-item" data-action="logout">${icon('logout', 20)}<span>Sign out</span></button>
      </div>
      <h2 class="section-title">Members</h2>
      <div data-members>${skeleton(1)}</div>
      <p class="field-hint app-version">Circle · private build · installed as a PWA where supported.</p>
    </div>`;

  const membersHost = host.querySelector('[data-members]');
  const drawMembers = () => {
    membersHost.innerHTML = `<div class="member-list">${state.members.map(member => `
      <button class="member-item" data-member="${member.id}">
        <span class="${member.online ? 'online-dot' : ''}">${avatar(member, 'sm')}</span>
        <div><strong>${escapeHtml(member.displayName)}</strong><small>@${escapeHtml(member.username)}${member.role === 'admin' ? ' · admin' : ''}${member.online ? ' · online' : ''}</small></div>
      </button>`).join('')}</div>`;
  };

  host.addEventListener('click', async event => {
    const member = event.target.closest('[data-member]');
    if (member) return navigate(`/profile/${member.dataset.member}`);
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;
    const action = trigger.dataset.action;
    try {
      if (action === 'back') navigate('/profile');
      if (action === 'theme') {
        const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        localStorage.setItem('circle-theme', next);
        renderSettings(host);
      }
      if (action === 'notifications') {
        const { enablePush } = await import('../push.js');
        await enablePush();
      }
      if (action === 'invite') {
        const { code, expiresAt } = await request('/api/invites', { method: 'POST', body: { label: 'Circle invite', days: 7 } });
        modal(`<div class="modal-head"><h2>Invite code</h2><button class="icon-button" data-close-modal aria-label="Close">${icon('close', 20)}</button></div>
          <p class="field-hint">Share this code privately. It works once and expires ${escapeHtml(new Date(expiresAt).toLocaleDateString())}.</p>
          <div class="invite-result">${escapeHtml(code)}</div>
          <button class="button button-primary button-block" data-copy>Copy code</button>`)
          .querySelector('[data-copy]').addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(code); toast('Invite code copied'); }
            catch { toast('Copy failed — select the code manually', 'error'); }
          });
      }
      if (action === 'reload-stickers') {
        const { stickersLoaded } = await request('/api/stickers/reload', { method: 'POST' });
        toast(`${stickersLoaded} sticker${stickersLoaded === 1 ? '' : 's'} loaded`);
      }
      if (action === 'logout') {
        await request('/api/auth/logout', { method: 'POST' });
        setCsrf(null);
        resetState();
        const { disconnectRealtime } = await import('../realtime.js');
        disconnectRealtime();
        window.location.assign('/');
      }
    } catch (error) { toast(error.message, 'error'); }
  });

  const unsubscribe = subscribe(event => { if (['members', 'presence'].includes(event)) drawMembers(); });
  loadMembers(true).then(drawMembers).catch(error => { membersHost.innerHTML = escapeHtml(error.message); });
  drawMembers();
  return unsubscribe;
}
