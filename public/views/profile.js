import { request, setCsrf } from '../api.js';
import { icon } from '../icons.js';
import { goBack, navigate } from '../router.js';
import { applyProfile, loadMembers, resetState, state, subscribe } from '../store.js';
import { avatar, confirmSheet, emptyState, escapeHtml, mediaView, modal, skeleton, toast } from '../ui.js';
import { exactTime, lastSeenText, relativeTime, timeTag } from '../lib/time.js';
import { setThemePreference, themePreference } from '../lib/theme.js';
import { createPostCard } from '../components/post.js';
import { pickFiles, uploadFiles } from '../components/media.js';
import { addStory, openStoryViewer } from '../components/stories.js';

function viewersMarkup(views) {
  if (!views?.length) return `<p class="field-hint">Nobody has viewed this story yet. Viewers appear here as soon as they watch it.</p>`;
  return `<div class="member-list">${views.map(view => `
    <button class="member-item" data-member="${view.user.id}">${avatar(view.user, 'sm')}
      <div><strong>${escapeHtml(view.user.displayName)}</strong><small title="${escapeHtml(exactTime(view.viewedAt))}">Viewed ${escapeHtml(relativeTime(view.viewedAt))}</small></div>
      ${view.reaction ? `<span class="viewer-reaction">${escapeHtml(view.reaction)}</span>` : ''}
    </button>`).join('')}</div>`;
}

/** The author's own story history with viewer lists. Only ever requested for the signed-in member. */
function storiesSection(archive) {
  if (!archive) return `<section class="card profile-section"><h2 class="section-title">Your stories</h2><div class="story-archive">${'<i class="skeleton-tile"></i>'.repeat(3)}</div></section>`;
  const { stories, retentionDays } = archive;
  return `<section class="card profile-section">
    <div class="section-head"><h2 class="section-title">Your stories</h2><button class="text-button" data-action="add-story">${icon('plus', 16)} Add</button></div>
    ${stories.length ? `<div class="story-archive">${stories.map(story => `
      <button class="archive-item${story.expired ? ' expired' : ''}" data-archive="${story.id}">
        ${(story.media.mimeType || '').startsWith('video/') ? `<video src="${escapeHtml(story.media.url)}" preload="metadata" muted playsinline></video>` : `<img src="${escapeHtml(story.media.url)}" alt="" loading="lazy" decoding="async">`}
        <span class="archive-meta"><span>${icon('eye', 13)} ${story.viewCount}</span><span>${story.expired ? 'Expired' : relativeTime(story.createdAt)}</span></span>
      </button>`).join('')}</div>
      <p class="field-hint">Only you can see this. Expired stories stay here for ${retentionDays} days.</p>`
    : `<p class="field-hint">Stories you share appear here with everyone who viewed them. Only you can see this list.</p>`}
  </section>`;
}

export function renderProfile(host, { userId } = {}) {
  const targetId = Number(userId || state.user?.id);
  const isSelf = targetId === state.user?.id;
  let tab = 'posts';
  let data = null;
  let archive = null;

  host.innerHTML = `<div class="page">${isSelf ? '' : `<div class="page-title"><button class="icon-button" data-action="back" aria-label="Back">${icon('back', 22)}</button></div>`}
    <section class="card profile-hero skeleton-hero" aria-hidden="true"><i></i><span></span><span></span></section>${skeleton(1)}</div>`;

  const draw = () => {
    if (!data) return;
    const { posts, stats } = data;
    const user = isSelf ? { ...data.user, ...state.user } : (state.members.find(member => member.id === targetId) ? { ...data.user, ...state.members.find(member => member.id === targetId) } : data.user);
    const mediaItems = posts.flatMap(post => post.media.map(media => ({ media, postId: post.id })));
    const status = lastSeenText(user);
    host.innerHTML = `
      <div class="page">
        ${!isSelf ? `<div class="page-title"><button class="icon-button" data-action="back" aria-label="Back">${icon('back', 22)}</button></div>` : ''}
        <section class="card profile-hero">
          <div class="avatar-wrap profile-avatar-wrap${user.online ? ' is-online' : ''}">${avatar(user, 'xl')}</div>
          <h1>${escapeHtml(user.displayName)}</h1>
          <div class="handle">@${escapeHtml(user.username)}${user.role === 'admin' ? ' · admin' : ''}</div>
          ${user.bio ? `<p class="bio">${escapeHtml(user.bio)}</p>` : isSelf ? '<p class="bio muted">Add a short bio so your circle knows what you are up to.</p>' : ''}
          <div class="profile-status${user.online ? ' online' : ''}"><i></i>${escapeHtml(isSelf ? 'online' : status)}</div>
          <div class="profile-stats"><span><strong>${stats?.posts ?? posts.length}</strong> posts</span><span><strong>${stats?.activeStories ?? 0}</strong> live ${stats?.activeStories === 1 ? 'story' : 'stories'}</span><span>joined ${escapeHtml(new Date(user.createdAt).toLocaleDateString(undefined, { month: 'short', year: 'numeric' }))}</span></div>
          <div class="profile-actions">
            ${isSelf
              ? `<button class="button button-primary" data-action="edit">${icon('edit', 18)} Edit profile</button>
                 <button class="button" data-action="settings">${icon('shield', 18)} Settings</button>`
              : `<button class="button button-primary" data-action="message">${icon('chat', 18)} Message</button>
                 ${stats?.activeStories ? `<button class="button" data-action="view-stories">${icon('eye', 18)} View story</button>` : ''}`}
          </div>
        </section>
        ${isSelf ? storiesSection(archive) : ''}
        <div class="profile-tabs" role="tablist">
          <button class="profile-tab${tab === 'posts' ? ' active' : ''}" data-tab="posts" role="tab">${icon('grid', 18)} Posts</button>
          <button class="profile-tab${tab === 'media' ? ' active' : ''}" data-tab="media" role="tab">${icon('image', 18)} Media ${mediaItems.length}</button>
        </div>
        <div data-content></div>
      </div>`;

    const content = host.querySelector('[data-content]');
    if (tab === 'posts') {
      if (!posts.length) content.innerHTML = emptyState('image', 'No posts yet', isSelf ? 'Your posts will appear here.' : `${user.displayName} has not posted yet.`, isSelf ? '<button class="button button-primary" data-action="create">Create a post</button>' : '');
      else { content.className = 'feed'; posts.forEach(post => content.append(createPostCard(post))); }
    } else {
      content.innerHTML = mediaItems.length
        ? `<div class="profile-grid">${mediaItems.map(item => `<button class="profile-grid-item" data-post-link="${item.postId}">${mediaView(item.media, 'grid-media')}</button>`).join('')}</div>`
        : emptyState('camera', 'No media yet', 'Photos and videos from posts appear here.');
    }
  };

  const loadArchive = () => {
    if (!isSelf) return;
    request('/api/stories/archive').then(result => { archive = result; draw(); })
      .catch(() => { archive = { stories: [], retentionDays: 30 }; draw(); });
  };

  function openArchivedStory(story) {
    const sheet = modal(`
      <div class="modal-head"><h2>Story</h2><button class="icon-button" data-close-modal aria-label="Close">${icon('close', 20)}</button></div>
      <div class="archive-preview">
        ${(story.media.mimeType || '').startsWith('video/') ? `<video src="${escapeHtml(story.media.url)}" controls playsinline preload="metadata"></video>` : `<img src="${escapeHtml(story.media.url)}" alt="">`}
        <div><strong>${story.caption ? escapeHtml(story.caption) : 'No caption'}</strong>
          <small>Shared ${timeTag(story.createdAt)} · ${story.expired ? 'expired' : `expires ${escapeHtml(relativeTime(story.expiresAt) === 'just now' ? 'soon' : new Date(story.expiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}`}</small></div>
      </div>
      ${!story.expired ? `<button class="button button-block" data-open-live>${icon('eye', 18)} Open in story viewer</button>` : ''}
      <h3 class="sheet-section">${story.viewCount} ${story.viewCount === 1 ? 'viewer' : 'viewers'}</h3>
      ${viewersMarkup(story.views)}`);
    sheet.addEventListener('click', event => {
      const member = event.target.closest('[data-member]');
      if (member) { sheet.close(); navigate(`/profile/${member.dataset.member}`); }
      if (event.target.closest('[data-open-live]')) { sheet.close(); openStoryViewer(state.user.id, { storyId: story.id }); }
    });
  }

  host.addEventListener('click', async event => {
    const tabButton = event.target.closest('[data-tab]');
    if (tabButton) { tab = tabButton.dataset.tab; draw(); return; }
    const link = event.target.closest('[data-post-link]');
    if (link) return navigate(`/?post=${link.dataset.postLink}`);
    const archived = event.target.closest('[data-archive]');
    if (archived) return openArchivedStory(archive.stories.find(story => story.id === Number(archived.dataset.archive)));
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;
    try {
      const action = trigger.dataset.action;
      if (action === 'back') goBack('/');
      if (action === 'settings') navigate('/settings');
      if (action === 'create') navigate('/create');
      if (action === 'edit') openEditProfile();
      if (action === 'add-story') { await addStory(); loadArchive(); }
      if (action === 'view-stories') openStoryViewer(targetId);
      if (action === 'message') {
        const { conversationId } = await request('/api/conversations/direct', { method: 'POST', body: { userId: targetId } });
        navigate(`/chat/${conversationId}`);
      }
    } catch (error) { toast(error.message, 'error'); }
  });

  function openEditProfile() {
    let avatarMediaId;
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
        sheet.querySelector('[data-avatar-preview]').innerHTML = `<img class="avatar avatar-lg" src="${escapeHtml(media.url)}" alt="">`;
      } catch (error) { toast(error.message, 'error'); }
    });

    sheet.querySelector('[data-profile-form]').addEventListener('submit', async event => {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(event.target).entries());
      if (avatarMediaId !== undefined) payload.avatarMediaId = avatarMediaId;
      const submit = event.target.querySelector('[type="submit"]');
      submit.disabled = true;
      try {
        const result = await request('/api/profile', { method: 'PATCH', body: payload });
        state.user = { ...state.user, ...result.user };
        applyProfile(result.user);
        data.user = { ...data.user, ...result.user };
        sheet.close();
        draw();
        toast('Profile updated');
      } catch (error) { toast(error.message, 'error'); submit.disabled = false; }
    });
  }

  const unsubscribe = subscribe((event, payload) => {
    if (['presence', 'members', 'post'].includes(event) && data) draw();
    if (event === 'story:viewed' && isSelf && archive) {
      const story = archive.stories.find(item => item.id === payload.storyId);
      if (story) { story.views = [payload.view, ...(story.views || []).filter(item => item.user.id !== payload.view.user.id)]; story.viewCount = story.views.length; draw(); }
    }
    if (event === 'stories' && isSelf) loadArchive();
  });

  request(`/api/profiles/${targetId}`).then(result => { data = result; draw(); })
    .catch(error => { host.innerHTML = `<div class="page">${emptyState('alert', 'Could not load profile', error.status === 404 ? 'This member no longer exists.' : error.message, '<button class="button" data-action="back">Go back</button>')}</div>`; });
  loadArchive();

  return unsubscribe;
}

function settingRow({ action, iconName, label, hint = '', control = '' }) {
  return `<button class="settings-item" data-action="${action}">${icon(iconName, 20)}<span><strong>${escapeHtml(label)}</strong>${hint ? `<small>${escapeHtml(hint)}</small>` : ''}</span>${control}</button>`;
}

function toggleControl(on) { return `<i class="switch${on ? ' on' : ''}" aria-hidden="true"></i>`; }

export function renderSettings(host) {
  const draw = () => {
    const preference = themePreference();
    const showLastSeen = state.user?.privacy?.showLastSeen !== false;
    const pushState = !('Notification' in window) ? 'unsupported' : Notification.permission;
    host.innerHTML = `
      <div class="page">
        <div class="page-title"><button class="icon-button" data-action="back" aria-label="Back">${icon('back', 22)}</button><h1>Settings</h1><span></span></div>

        <h2 class="section-title">Appearance</h2>
        <div class="segmented" role="radiogroup" aria-label="Theme">
          ${[['light', 'sun', 'Light'], ['dark', 'moon', 'Dark'], ['system', 'monitor', 'System']].map(([value, iconName, label]) => `
            <button role="radio" aria-checked="${preference === value}" class="${preference === value ? 'active' : ''}" data-theme-choice="${value}">${icon(iconName, 18)}<span>${label}</span></button>`).join('')}
        </div>
        <div class="settings-list">
          ${settingRow({ action: 'theme', iconName: document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon', label: `Switch to ${document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'} mode` })}
        </div>

        <h2 class="section-title">Privacy</h2>
        <div class="settings-list">
          ${settingRow({ action: 'privacy-last-seen', iconName: 'eye', label: 'Show online status & last seen', hint: showLastSeen ? 'Members can see when you were last active.' : 'Hidden — others see “last seen recently”.', control: toggleControl(showLastSeen) })}
        </div>
        <p class="field-hint settings-note">Story viewer lists are only ever visible to the story's author. Read receipts in chats are always on so conversations stay honest.</p>

        <h2 class="section-title">Notifications</h2>
        <div class="settings-list">
          ${settingRow({ action: 'notifications', iconName: 'bell', label: 'Enable push notifications', hint: pushState === 'granted' ? 'Allowed on this device.' : pushState === 'denied' ? 'Blocked — allow notifications in your browser settings.' : pushState === 'unsupported' ? 'Not supported here. On iPhone, install Circle to the Home Screen first.' : 'Get alerts when the app is closed.' })}
        </div>
        <p class="field-hint settings-note">Mute a noisy chat from its details screen or by long-pressing it in the chat list.</p>

        ${state.user?.role === 'admin' ? `<h2 class="section-title">Admin</h2><div class="settings-list">
          ${settingRow({ action: 'invite', iconName: 'plus', label: 'Create invite code', hint: 'Single-use, expires in 7 days.' })}
          ${settingRow({ action: 'reload-stickers', iconName: 'smile', label: 'Reload sticker packs' })}
        </div>` : ''}

        <h2 class="section-title">Members</h2>
        <div data-members>${skeleton(1)}</div>

        <div class="settings-list">${settingRow({ action: 'logout', iconName: 'logout', label: 'Sign out' })}</div>
        <p class="field-hint app-version">Circle · private build · installed as a PWA where supported.</p>
      </div>`;
    drawMembers();
  };

  const drawMembers = () => {
    const membersHost = host.querySelector('[data-members]');
    if (!membersHost || !state.members.length) return;
    membersHost.innerHTML = `<div class="member-list">${state.members.map(member => `
      <button class="member-item" data-member="${member.id}">
        <span class="avatar-wrap${member.online ? ' is-online' : ''}">${avatar(member, 'sm')}</span>
        <div><strong>${escapeHtml(member.displayName)}${member.id === state.user?.id ? ' (you)' : ''}</strong><small>@${escapeHtml(member.username)}${member.role === 'admin' ? ' · admin' : ''} · ${escapeHtml(member.id === state.user?.id ? 'online' : lastSeenText(member))}</small></div>
      </button>`).join('')}</div>`;
  };

  host.addEventListener('click', async event => {
    const member = event.target.closest('[data-member]');
    if (member) return navigate(`/profile/${member.dataset.member}`);
    const themeChoice = event.target.closest('[data-theme-choice]');
    if (themeChoice) { setThemePreference(themeChoice.dataset.themeChoice); return draw(); }
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;
    const action = trigger.dataset.action;
    try {
      if (action === 'back') goBack('/profile');
      if (action === 'theme') { setThemePreference(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); draw(); }
      if (action === 'privacy-last-seen') {
        const next = state.user?.privacy?.showLastSeen === false;
        const { user } = await request('/api/profile/privacy', { method: 'PATCH', body: { showLastSeen: next } });
        state.user = { ...state.user, ...user };
        toast(next ? 'Your last seen time is visible again' : 'Your last seen time is now hidden');
        draw();
      }
      if (action === 'notifications') {
        const { enablePush } = await import('../push.js');
        await enablePush();
        draw();
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
        if (!(await confirmSheet({ title: 'Sign out of Circle?', text: 'You will need your password to sign back in on this device.', confirm: 'Sign out' }))) return;
        const { stopAll } = await import('../lib/audio.js');
        stopAll();
        await request('/api/auth/logout', { method: 'POST' });
        setCsrf(null);
        const { resetRealtime } = await import('../realtime.js');
        resetRealtime();
        resetState();
        window.location.assign('/');
      }
    } catch (error) { toast(error.message, 'error'); }
  });

  const unsubscribe = subscribe(event => { if (['members', 'presence'].includes(event)) drawMembers(); });
  draw();
  loadMembers(true).then(drawMembers).catch(error => { const target = host.querySelector('[data-members]'); if (target) target.innerHTML = `<p class="field-hint">${escapeHtml(error.message)}</p>`; });
  return unsubscribe;
}
