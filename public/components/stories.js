import { request } from '../api.js';
import { icon } from '../icons.js';
import { activeStoryGroups, loadStories, removeStory, state, subscribe, upsertStory } from '../store.js';
import { avatar, confirmSheet, escapeHtml, modal, toast } from '../ui.js';
import { exactTime, relativeTime } from '../lib/time.js';
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

/**
 * "Your story" opens your own live stories (with who viewed them) when you have any; the small "+"
 * always adds a new one. Previously the tile only ever opened the uploader, so members could not
 * watch their own story or see its viewers.
 */
function render(section) {
  const groups = activeStoryGroups();
  const mine = groups.find(group => group.author.id === state.user?.id);
  const views = mine ? new Set(mine.stories.flatMap(story => (story.views || []).map(view => view.user.id))).size : 0;
  section.innerHTML = `<div class="stories-row">
    <div class="story-avatar story-own">
      <button class="story-open" ${mine ? `data-author="${state.user.id}"` : 'data-author="new"'} aria-label="${mine ? 'View your story' : 'Add to your story'}">
        <span class="story-ring ${mine ? '' : 'viewed'}">${avatar(state.user, 'md')}</span>
      </button>
      <button class="story-add-badge" data-author="new" aria-label="Add to your story">${icon('plus', 14)}</button>
      <small>${mine ? `${icon('eye', 11)} ${views}` : 'Your story'}</small>
    </div>
    ${groups.filter(group => group.author.id !== state.user?.id).map(group => `
      <button class="story-avatar" data-author="${group.author.id}">
        <span class="story-ring${group.allViewed ? ' viewed' : ''}">${avatar(group.author, 'md')}</span>
        <small>${escapeHtml(group.author.displayName.split(' ')[0])}</small>
      </button>`).join('')}
  </div>`;
}

function viewerList(views) {
  if (!views?.length) return '<p class="field-hint">No views yet. You will see each viewer here once, with the time they watched.</p>';
  return `<div class="member-list">${views.map(view => `<div class="member-item">${avatar(view.user, 'sm')}<div><strong>${escapeHtml(view.user.displayName)}</strong><small title="${escapeHtml(exactTime(view.viewedAt))}">${escapeHtml(relativeTime(view.viewedAt))}</small></div>${view.reaction ? `<span class="viewer-reaction">${escapeHtml(view.reaction)}</span>` : ''}</div>`).join('')}</div>`;
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

export function openStoryViewer(authorId, { storyId = null } = {}) {
  const groups = activeStoryGroups();
  let groupIndex = groups.findIndex(group => group.author.id === Number(authorId));
  if (groupIndex < 0) return toast('This story is no longer available.');
  const requested = storyId ? groups[groupIndex].stories.findIndex(story => story.id === Number(storyId)) : -1;
  let index = requested >= 0 ? requested : Math.max(0, groups[groupIndex].stories.findIndex(story => !story.viewed && story.author.id !== state.user?.id));
  let timer = null;

  const overlay = document.createElement('div');
  overlay.className = 'story-viewer';
  document.body.append(overlay);
  document.body.style.overflow = 'hidden';

  // Live viewer count while the author watches their own story.
  const unsubscribe = subscribe((event, payload) => {
    if (event !== 'story:viewed') return;
    const story = groups[groupIndex]?.stories[index];
    if (story && story.id === payload.storyId) {
      const button = overlay.querySelector('[data-story-action="viewers"]');
      if (button) button.innerHTML = `${icon('eye', 18)} ${story.views?.length || 0} ${story.views?.length === 1 ? 'viewer' : 'viewers'}`;
    }
  });

  const close = () => {
    clearTimeout(timer);
    unsubscribe();
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    document.body.style.overflow = '';
    loadStories().catch(() => {});
  };
  const onKey = event => {
    if (event.key === 'Escape') close();
    if (event.key === 'ArrowRight') advance(1);
    if (event.key === 'ArrowLeft') advance(-1);
  };
  document.addEventListener('keydown', onKey);

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
        <div><strong>${escapeHtml(isMine ? 'Your story' : story.author.displayName)}</strong> <time title="${escapeHtml(exactTime(story.createdAt))}">${relativeTime(story.createdAt)}</time></div>
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
        ? `<div class="story-controls"><button class="button button-ghost" data-story-action="viewers">${icon('eye', 18)} ${story.views?.length || 0} ${story.views?.length === 1 ? 'viewer' : 'viewers'}</button></div>`
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
        if (!(await confirmSheet({ title: 'Delete this story?', text: 'It disappears for everyone right away.', confirm: 'Delete story' }))) return draw();
        await request(`/api/stories/${story.id}`, { method: 'DELETE' });
        removeStory(story.id);
        close();
      }
      if (action === 'viewers') {
        clearTimeout(timer);
        const sheet = modal(`<div class="modal-head"><h2>Viewers</h2><button class="icon-button" data-close-modal aria-label="Close">${icon('close', 20)}</button></div>
          <div data-viewers>${viewerList(story.views)}</div>`);
        sheet.addEventListener('sheet:closed', () => { if (overlay.isConnected) draw(); }, { once: true });
        // Refresh from the server so the list is authoritative even if an event was missed.
        request(`/api/stories/${story.id}/views`).then(({ views }) => {
          story.views = views;
          const target = sheet.querySelector('[data-viewers]');
          if (target) target.innerHTML = viewerList(views);
        }).catch(() => {});
      }
    } catch (error) { toast(error.message, 'error'); }
  });

  draw();
}
