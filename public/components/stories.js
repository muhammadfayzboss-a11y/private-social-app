import { request } from '../api.js';
import { icon } from '../icons.js';
import { activeStoryGroups, loadStories, removeStory, state, upsertStory } from '../store.js';
import { avatar, escapeHtml, modal, timeAgo, toast } from '../ui.js';
import { pickFiles, uploadFiles } from './media.js';

export function createStoriesTray() {
  const section = document.createElement('section');
  section.className = 'card stories-section';
  render(section);
  section.addEventListener('click', async event => {
    const trigger = event.target.closest('[data-author]');
    if (!trigger) return;
    if (trigger.dataset.author === 'new') return addStory();
    openStoryViewer(Number(trigger.dataset.author));
  });
  return section;
}

export function renderStoriesTray(section) { render(section); }

function render(section) {
  const groups = activeStoryGroups();
  const mine = groups.find(group => group.author.id === state.user?.id);
  section.innerHTML = `<div class="stories-row">
    <button class="story-avatar" data-author="new">
      <span class="story-ring ${mine ? '' : 'viewed'} story-add">${avatar(state.user, 'md')}</span>
      <small>Your story</small>
    </button>
    ${groups.filter(group => group.author.id !== state.user?.id).map(group => `
      <button class="story-avatar" data-author="${group.author.id}">
        <span class="story-ring${group.allViewed ? ' viewed' : ''}">${avatar(group.author, 'md')}</span>
        <small>${escapeHtml(group.author.displayName.split(' ')[0])}</small>
      </button>`).join('')}
  </div>`;
}

export async function addStory() {
  const files = await pickFiles('image/*,video/*', false);
  if (!files.length) return;
  const sheet = modal(`
    <div class="modal-head"><h2>New story</h2><button class="icon-button" data-close-modal aria-label="Close">${icon('close', 20)}</button></div>
    <div class="media-previews" data-preview></div>
    <div class="field"><label for="story-caption">Caption</label><input id="story-caption" maxlength="300" placeholder="Say something…"></div>
    <button class="button button-primary button-block" data-publish>Share story</button>`);
  const preview = sheet.querySelector('[data-preview]');
  const url = URL.createObjectURL(files[0]);
  preview.innerHTML = `<div class="media-preview">${files[0].type.startsWith('video/') ? `<video src="${url}" muted playsinline></video>` : `<img src="${url}" alt="">`}</div>`;
  const publish = sheet.querySelector('[data-publish]');
  publish.addEventListener('click', async () => {
    publish.disabled = true;
    publish.textContent = 'Sharing…';
    try {
      const [media] = await uploadFiles(files, 'story');
      const { story } = await request('/api/stories', { method: 'POST', body: { mediaId: media.id, caption: sheet.querySelector('#story-caption').value } });
      upsertStory(story);
      URL.revokeObjectURL(url);
      sheet.remove();
      toast('Story shared — it disappears in 24 hours');
    } catch (error) {
      toast(error.message, 'error');
      publish.disabled = false;
      publish.textContent = 'Share story';
    }
  });
}

export function openStoryViewer(authorId) {
  const groups = activeStoryGroups();
  let groupIndex = groups.findIndex(group => group.author.id === Number(authorId));
  if (groupIndex < 0) return;
  let index = Math.max(0, groups[groupIndex].stories.findIndex(story => !story.viewed && story.author.id !== state.user?.id));
  let timer = null;

  const overlay = document.createElement('div');
  overlay.className = 'story-viewer';
  document.body.append(overlay);
  document.body.style.overflow = 'hidden';

  const close = () => {
    clearTimeout(timer);
    overlay.remove();
    document.body.style.overflow = '';
    loadStories().catch(() => {});
  };

  const advance = (step = 1) => {
    const group = groups[groupIndex];
    const next = index + step;
    if (next >= 0 && next < group.stories.length) { index = next; draw(); return; }
    const nextGroup = groupIndex + (step > 0 ? 1 : -1);
    if (nextGroup < 0 || nextGroup >= groups.length) return close();
    groupIndex = nextGroup;
    index = step > 0 ? 0 : groups[groupIndex].stories.length - 1;
    draw();
  };

  function draw() {
    clearTimeout(timer);
    const group = groups[groupIndex];
    const story = group.stories[index];
    const isMine = story.author.id === state.user?.id;
    const isVideo = (story.media.mimeType || '').startsWith('video/');
    overlay.innerHTML = `
      <div class="story-progress">${group.stories.map((item, position) => `<i class="${position === index ? 'active' : position < index ? 'done' : ''}"></i>`).join('')}</div>
      <header class="story-view-head">
        ${avatar(story.author, 'sm')}
        <div><strong>${escapeHtml(story.author.displayName)}</strong> <time>${timeAgo(story.createdAt)}</time></div>
        ${isMine ? `<button class="icon-button" data-story-action="delete" aria-label="Delete story">${icon('trash', 19)}</button>` : ''}
        <button class="icon-button" data-story-action="close" aria-label="Close stories">${icon('close', 22)}</button>
      </header>
      <div class="story-content">
        <button class="story-nav prev" data-story-action="prev" aria-label="Previous story"></button>
        ${isVideo
          ? `<video src="${escapeHtml(story.media.url)}" autoplay playsinline data-story-media></video>`
          : `<img src="${escapeHtml(story.media.url)}" alt="${escapeHtml(story.caption || 'Story')}" data-story-media>`}
        <button class="story-nav next" data-story-action="next" aria-label="Next story"></button>
        ${story.caption ? `<p class="story-caption">${escapeHtml(story.caption)}</p>` : ''}
      </div>
      ${isMine
        ? `<div class="story-controls"><button class="button button-ghost" data-story-action="viewers">${icon('users', 18)} ${story.views?.length || 0} ${story.views?.length === 1 ? 'view' : 'views'}</button></div>`
        : `<div class="story-controls">
            <input placeholder="Reply to ${escapeHtml(story.author.displayName.split(' ')[0])}…" data-story-reply aria-label="Reply to story">
            <button class="icon-button" data-story-action="react" aria-label="React with a heart">${icon('heart', 22, Boolean(story.viewerReaction))}</button>
            <button class="icon-button" data-story-action="send" aria-label="Send reply">${icon('send', 22)}</button>
          </div>`}`;

    if (!isMine && !story.viewed) {
      story.viewed = true;
      request(`/api/stories/${story.id}/view`, { method: 'POST' }).catch(() => {});
    }

    const media = overlay.querySelector('[data-story-media]');
    if (isVideo) {
      media.addEventListener('ended', () => advance(1));
      media.play?.().catch(() => {});
    } else {
      timer = setTimeout(() => advance(1), 5000);
    }
  }

  overlay.addEventListener('click', async event => {
    const trigger = event.target.closest('[data-story-action]');
    if (!trigger) return;
    const story = groups[groupIndex].stories[index];
    const action = trigger.dataset.storyAction;
    try {
      if (action === 'close') close();
      if (action === 'next') advance(1);
      if (action === 'prev') advance(-1);
      if (action === 'react') {
        clearTimeout(timer);
        const next = story.viewerReaction ? '' : '❤️';
        await request(`/api/stories/${story.id}/reaction`, { method: 'POST', body: { reaction: next } });
        story.viewerReaction = next || null;
        toast(next ? 'Reaction sent' : 'Reaction removed');
        draw();
      }
      if (action === 'send') {
        const input = overlay.querySelector('[data-story-reply]');
        const body = input.value.trim();
        if (!body) return;
        clearTimeout(timer);
        await request(`/api/stories/${story.id}/reply`, { method: 'POST', body: { body } });
        input.value = '';
        toast('Reply sent as a private message');
        advance(1);
      }
      if (action === 'delete') {
        clearTimeout(timer);
        if (!window.confirm('Delete this story?')) return draw();
        await request(`/api/stories/${story.id}`, { method: 'DELETE' });
        removeStory(story.id);
        close();
      }
      if (action === 'viewers') {
        clearTimeout(timer);
        const viewers = story.views || [];
        modal(`<div class="modal-head"><h2>Viewers</h2><button class="icon-button" data-close-modal aria-label="Close">${icon('close', 20)}</button></div>
          ${viewers.length ? `<div class="member-list">${viewers.map(view => `<div class="member-item">${avatar(view.user, 'sm')}<div><strong>${escapeHtml(view.user.displayName)}</strong><small>${timeAgo(view.viewedAt)}</small></div></div>`).join('')}</div>`
            : '<p class="field-hint">No views yet.</p>'}`).addEventListener('click', event2 => { if (event2.target.closest('[data-close-modal]')) draw(); });
      }
    } catch (error) { toast(error.message, 'error'); }
  });

  overlay.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
  draw();
}
