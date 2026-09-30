/**
 * Stories: the tray of circles, the full-screen viewer, and the composer (photo/video or a text
 * story on an original gradient background, rendered to an image on the device).
 *
 * Viewer gestures: tap right/left = next/previous, hold = pause, swipe left/right = next/previous
 * person, swipe down = close, swipe up (own story) = viewers. The Android back button closes it.
 */
import { request } from '../api.js';
import { icon } from '../icons.js';
import { activeStoryGroups, loadStories, removeStory, state, subscribe, upsertStory } from '../store.js';
import { actionSheet, avatar, confirmSheet, escapeHtml, modal, toast } from '../ui.js';
import { exactTime, relativeTime } from '../lib/time.js';
import { closeOverlay, openOverlay } from '../lib/overlays.js';
import { t, tn } from '../lib/i18n.js';
import { pickFiles, uploadFiles } from './media.js';
import { preparePhoto, prepareVideo } from './attach.js';

const PHOTO_DURATION = 5000;
const TEXT_BACKGROUNDS = [
  ['#7c6cf0', '#5aa9e6'], ['#ff7e8f', '#c86dd7'], ['#ffb88c', '#ff5f6d'], ['#164e57', '#8fb77a'],
  ['#1b2338', '#4a2c5c'], ['#f7c3cf', '#dcd0f7'], ['#111111', '#333333'], ['#2ec5d3', '#6a4cff']
];

/* ---------------------------------- tray ---------------------------------- */

export function createStoriesTray() {
  const section = document.createElement('section');
  section.className = 'stories-section';
  render(section);
  section.addEventListener('click', event => {
    const trigger = event.target.closest('[data-author]');
    if (!trigger) return;
    if (trigger.dataset.author === 'new') return addStory();
    openStoryViewer(Number(trigger.dataset.author));
  });
  return section;
}

export function renderStoriesTray(section) { render(section); }

/**
 * "My story" opens your live stories (with who viewed them) when you have any; the "+" always adds
 * a new one. Unseen stories have a coloured ring; seen ones a grey ring.
 */
function render(section) {
  const groups = activeStoryGroups();
  const mine = groups.find(group => group.author.id === state.user?.id);
  const others = groups.filter(group => group.author.id !== state.user?.id);
  section.hidden = false;
  section.innerHTML = `<div class="stories-row">
    <div class="story-avatar story-own">
      <button class="story-open" ${mine ? `data-author="${state.user.id}"` : 'data-author="new"'} aria-label="${mine ? t('View your story') : t('Add to your story')}">
        <span class="story-ring${mine ? (mine.allViewed ? ' viewed' : '') : ' empty'}">${avatar(state.user, 'md')}</span>
      </button>
      <button class="story-add-badge" data-author="new" aria-label="${t('Add to your story')}">${icon('plus', 13)}</button>
      <small>${t('My story')}</small>
    </div>
    ${others.map(group => `
      <button class="story-avatar" data-author="${group.author.id}">
        <span class="story-ring${group.allViewed ? ' viewed' : ''}">${avatar(group.author, 'md')}</span>
        <small>${escapeHtml(group.author.displayName.split(' ')[0])}</small>
      </button>`).join('')}
  </div>`;
}

/* -------------------------------- composer -------------------------------- */

export async function addStory() {
  const choice = await actionSheet({
    title: t('New story'),
    actions: [
      { id: 'gallery', label: t('Photo or video'), icon: 'image' },
      { id: 'camera', label: t('Camera'), icon: 'camera' },
      { id: 'text', label: t('Text story'), icon: 'text' }
    ]
  });
  if (choice === 'text') return openTextStory();
  if (choice !== 'gallery' && choice !== 'camera') return;
  const files = await pickFiles(choice === 'camera' ? 'image/*' : 'image/*,video/*', false, choice === 'camera' ? { capture: 'user' } : {});
  if (files.length) return openMediaStory(files[0]);
}

async function publishStory(file, caption, button) {
  button.disabled = true;
  button.textContent = t('Sharing…');
  try {
    const prepared = file.type.startsWith('video/') ? await prepareVideo(file) : await preparePhoto(file);
    const [media] = await uploadFiles([prepared.file], 'story', prepared);
    const { story } = await request('/api/stories', { method: 'POST', body: { mediaId: media.id, caption } });
    upsertStory(story);
    toast(t('Story shared — it disappears in 24 hours'));
    return true;
  } catch (error) {
    toast(error.message, 'error');
    button.disabled = false;
    button.textContent = t('Share story');
    return false;
  }
}

function privacyNote() {
  return `<p class="field-hint story-privacy-note">${icon('lock2', 14)} ${t('Visible for 24 hours to your circle, except people you hide stories from.')} <a href="/settings/privacy" data-internal>${t('Change')}</a></p>`;
}

function openMediaStory(file) {
  const url = URL.createObjectURL(file);
  const sheet = modal(`
    <div class="modal-head"><h2>${t('New story')}</h2><button class="icon-button" data-close-modal aria-label="${t('Close')}">${icon('close', 20)}</button></div>
    <div class="story-compose-preview">${file.type.startsWith('video/') ? `<video src="${url}" muted autoplay loop playsinline></video>` : `<img src="${url}" alt="">`}</div>
    <div class="field"><input id="story-caption" maxlength="300" placeholder="${t('Add a caption…')}" aria-label="${t('Caption')}"></div>
    ${privacyNote()}
    <button class="button button-primary button-block" data-publish>${t('Share story')}</button>`, 'story-compose');
  const publish = sheet.querySelector('[data-publish]');
  publish.addEventListener('click', async () => { if (await publishStory(file, sheet.querySelector('#story-caption').value, publish)) sheet.close(); });
  sheet.addEventListener('sheet:closed', () => URL.revokeObjectURL(url), { once: true });
  bindPrivacyLink(sheet);
}

function bindPrivacyLink(sheet) {
  sheet.querySelector('[data-internal]')?.addEventListener('click', async event => {
    event.preventDefault();
    sheet.close();
    const { navigate } = await import('../router.js');
    navigate('/settings/privacy');
  });
}

/** Draws the text story onto a 1080×1920 canvas so it becomes a normal image story. */
async function renderTextStory(text, colors) {
  const canvas = document.createElement('canvas');
  canvas.width = 1080; canvas.height = 1920;
  const context = canvas.getContext('2d');
  const gradient = context.createLinearGradient(0, 0, 1080, 1920);
  gradient.addColorStop(0, colors[0]); gradient.addColorStop(1, colors[1]);
  context.fillStyle = gradient;
  context.fillRect(0, 0, 1080, 1920);
  const size = text.length > 160 ? 58 : text.length > 80 ? 70 : 88;
  context.font = `700 ${size}px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif`;
  context.fillStyle = '#ffffff';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.shadowColor = 'rgba(0,0,0,.18)';
  context.shadowBlur = 12;
  const lines = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (context.measureText(candidate).width > 900 && line) { lines.push(line); line = word; } else line = candidate;
    }
    lines.push(line);
  }
  const lineHeight = size * 1.28;
  const top = 960 - ((lines.length - 1) * lineHeight) / 2;
  lines.slice(0, 18).forEach((line, index) => context.fillText(line, 540, top + index * lineHeight));
  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.9));
  return new File([blob], 'text-story.jpg', { type: 'image/jpeg' });
}

function openTextStory() {
  let colors = TEXT_BACKGROUNDS[0];
  const sheet = modal(`
    <div class="modal-head"><h2>${t('Text story')}</h2><button class="icon-button" data-close-modal aria-label="${t('Close')}">${icon('close', 20)}</button></div>
    <div class="text-story-editor" data-editor style="background:linear-gradient(160deg,${colors[0]},${colors[1]})">
      <textarea data-text maxlength="280" placeholder="${t('Type something…')}" aria-label="${t('Story text')}"></textarea>
    </div>
    <div class="swatches">${TEXT_BACKGROUNDS.map((pair, index) => `<button class="swatch${index === 0 ? ' active' : ''}" data-swatch="${index}" style="background:linear-gradient(160deg,${pair[0]},${pair[1]})" aria-label="${t('Background')} ${index + 1}"></button>`).join('')}</div>
    ${privacyNote()}
    <button class="button button-primary button-block" data-publish>${t('Share story')}</button>`, 'story-compose');
  const editor = sheet.querySelector('[data-editor]');
  sheet.addEventListener('click', event => {
    const swatch = event.target.closest('[data-swatch]');
    if (!swatch) return;
    colors = TEXT_BACKGROUNDS[Number(swatch.dataset.swatch)];
    editor.style.background = `linear-gradient(160deg,${colors[0]},${colors[1]})`;
    sheet.querySelectorAll('[data-swatch]').forEach(button => button.classList.toggle('active', button === swatch));
  });
  const publish = sheet.querySelector('[data-publish]');
  publish.addEventListener('click', async () => {
    const text = sheet.querySelector('[data-text]').value.trim();
    if (!text) return toast(t('Write something first'), 'error');
    if (await publishStory(await renderTextStory(text, colors), '', publish)) sheet.close();
  });
  bindPrivacyLink(sheet);
  setTimeout(() => sheet.querySelector('[data-text]').focus(), 300);
}

/* --------------------------------- viewer --------------------------------- */

function viewerList(views) {
  if (!views?.length) return `<p class="field-hint">${t('No views yet. You will see each viewer here once, with the time they watched.')}</p>`;
  return `<div class="member-list">${views.map(view => `<div class="member-item">${avatar(view.user, 'sm')}<div><strong>${escapeHtml(view.user.displayName)}</strong><small title="${escapeHtml(exactTime(view.viewedAt))}">${escapeHtml(relativeTime(view.viewedAt))}</small></div>${view.reaction ? `<span class="viewer-reaction">${escapeHtml(view.reaction)}</span>` : ''}</div>`).join('')}</div>`;
}

export function openStoryViewer(authorId, { storyId = null } = {}) {
  const groups = activeStoryGroups();
  let groupIndex = groups.findIndex(group => group.author.id === Number(authorId));
  if (groupIndex < 0) return toast(t('This story is no longer available.'));
  const requested = storyId ? groups[groupIndex].stories.findIndex(story => story.id === Number(storyId)) : -1;
  let index = requested >= 0 ? requested : Math.max(0, groups[groupIndex].stories.findIndex(story => !story.viewed && story.author.id !== state.user?.id));
  let timer = null;
  let startedAt = 0;
  let remaining = 0;
  let paused = false;
  let closed = false;

  const overlay = document.createElement('div');
  overlay.className = 'story-viewer';
  document.body.append(overlay);
  document.documentElement.classList.add('story-open');
  const overlayId = openOverlay(() => close({ fromHistory: true }));

  const current = () => groups[groupIndex].stories[index];

  const unsubscribe = subscribe((event, payload) => {
    if (event !== 'story:viewed') return;
    const story = current();
    if (story && story.id === payload.storyId) {
      const button = overlay.querySelector('[data-story-action="viewers"]');
      if (button) button.innerHTML = `${icon('eye', 18)} ${tn(story.views?.length || 0, '{n} viewer', '{n} viewers')}`;
    }
  });

  function close({ fromHistory = false } = {}) {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    unsubscribe();
    document.removeEventListener('keydown', onKey);
    if (!fromHistory) closeOverlay(overlayId);
    overlay.classList.add('closing');
    document.documentElement.classList.remove('story-open');
    setTimeout(() => overlay.remove(), 200);
    loadStories().catch(() => {});
  }
  const onKey = event => {
    if (event.key === 'Escape') close();
    if (event.key === 'ArrowRight') advance(1);
    if (event.key === 'ArrowLeft') advance(-1);
  };
  document.addEventListener('keydown', onKey);

  function advance(step = 1) {
    const group = groups[groupIndex];
    const next = index + step;
    if (next >= 0 && next < group.stories.length) { index = next; draw(); return; }
    jumpGroup(step);
  }
  function jumpGroup(step) {
    const nextGroup = groupIndex + (step > 0 ? 1 : -1);
    if (nextGroup < 0 || nextGroup >= groups.length) return close();
    groupIndex = nextGroup;
    index = step > 0 ? 0 : groups[groupIndex].stories.length - 1;
    overlay.classList.add(step > 0 ? 'slide-next' : 'slide-prev');
    setTimeout(() => overlay.classList.remove('slide-next', 'slide-prev'), 260);
    draw();
  }

  function schedule(duration) {
    clearTimeout(timer);
    remaining = duration;
    startedAt = performance.now();
    timer = setTimeout(() => advance(1), duration);
  }
  function pause() {
    if (paused) return;
    paused = true;
    clearTimeout(timer);
    remaining -= performance.now() - startedAt;
    overlay.classList.add('paused');
    overlay.querySelector('[data-story-media]')?.pause?.();
  }
  function resume() {
    if (!paused || closed) return;
    paused = false;
    overlay.classList.remove('paused');
    const media = overlay.querySelector('video[data-story-media]');
    if (media) { media.play().catch(() => {}); return; }
    startedAt = performance.now();
    timer = setTimeout(() => advance(1), Math.max(0, remaining));
  }

  function draw() {
    clearTimeout(timer);
    paused = false;
    overlay.classList.remove('paused');
    const group = groups[groupIndex];
    const story = current();
    const isMine = story.author.id === state.user?.id;
    const isVideo = (story.media.mimeType || '').startsWith('video/');
    overlay.innerHTML = `
      <div class="story-frame">
        <div class="story-progress">${group.stories.map((item, position) => `<i class="${position === index ? 'active' : position < index ? 'done' : ''}" style="--duration:${PHOTO_DURATION}ms"></i>`).join('')}</div>
        <header class="story-view-head">
          ${avatar(story.author, 'sm')}
          <div class="story-who"><strong>${escapeHtml(isMine ? t('My story') : story.author.displayName)}</strong><time title="${escapeHtml(exactTime(story.createdAt))}">${relativeTime(story.createdAt)}</time></div>
          ${isMine ? `<button class="icon-button" data-story-action="delete" aria-label="${t('Delete story')}">${icon('trash', 21)}</button>` : ''}
          <button class="icon-button" data-story-action="close" aria-label="${t('Close stories')}">${icon('close', 24)}</button>
        </header>
        <div class="story-content">
          ${isVideo
            ? `<video src="${escapeHtml(story.media.url)}" autoplay playsinline data-story-media></video>`
            : `<img src="${escapeHtml(story.media.url)}" alt="${escapeHtml(story.caption || t('Story'))}" data-story-media>`}
          ${story.caption ? `<p class="story-caption">${escapeHtml(story.caption)}</p>` : ''}
        </div>
        ${isMine
          ? `<div class="story-controls own"><button class="story-viewers-button" data-story-action="viewers">${icon('eye', 18)} ${tn(story.views?.length || 0, '{n} viewer', '{n} viewers')}</button></div>`
          : `<div class="story-controls">
              ${story.allowReplies !== false ? `<input placeholder="${t('Reply to {name}…', { name: escapeHtml(story.author.displayName.split(' ')[0]) })}" data-story-reply aria-label="${t('Reply to story')}" enterkeyhint="send">
              <button class="icon-button" data-story-action="send" aria-label="${t('Send reply')}">${icon('send', 22)}</button>` : `<span class="story-no-replies">${t('Replies are turned off')}</span>`}
              <button class="icon-button story-like${story.viewerReaction ? ' liked' : ''}" data-story-action="react" aria-label="${t('React')}">${icon('heart', 26, Boolean(story.viewerReaction))}</button>
            </div>`}
      </div>`;

    if (!isMine && !story.viewed) {
      story.viewed = true;
      request(`/api/stories/${story.id}/view`, { method: 'POST' }).catch(() => {});
    }

    const media = overlay.querySelector('[data-story-media]');
    if (isVideo) {
      media.addEventListener('loadedmetadata', () => {
        const duration = Number.isFinite(media.duration) ? media.duration * 1000 : PHOTO_DURATION;
        overlay.querySelector('.story-progress i.active')?.style.setProperty('--duration', `${duration}ms`);
      });
      media.addEventListener('ended', () => advance(1));
      media.play?.().catch(() => {});
    } else {
      schedule(PHOTO_DURATION);
    }
    const reply = overlay.querySelector('[data-story-reply]');
    reply?.addEventListener('focus', pause);
    reply?.addEventListener('blur', () => { if (!reply.value) resume(); });
    reply?.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); sendReply(); } });
  }

  async function sendReply() {
    const input = overlay.querySelector('[data-story-reply]');
    const body = input?.value.trim();
    if (!body) return;
    const story = current();
    try {
      await request(`/api/stories/${story.id}/reply`, { method: 'POST', body: { body } });
      input.value = '';
      input.blur();
      toast(t('Reply sent as a private message'));
      advance(1);
    } catch (error) { toast(error.message, 'error'); }
  }

  async function openViewers() {
    pause();
    const story = current();
    const sheet = modal(`<div class="modal-head"><h2>${t('Viewers')}</h2><button class="icon-button" data-close-modal aria-label="${t('Close')}">${icon('close', 20)}</button></div>
      <div data-viewers>${viewerList(story.views)}</div>`);
    sheet.addEventListener('sheet:closed', () => resume(), { once: true });
    // Refresh from the server so the list is authoritative even if an event was missed.
    request(`/api/stories/${story.id}/views`).then(({ views }) => {
      story.views = views;
      const target = sheet.querySelector('[data-viewers]');
      if (target) target.innerHTML = viewerList(views);
    }).catch(() => {});
  }

  // Gestures: tap zones, hold to pause, horizontal swipe between people, vertical swipes.
  let gesture = null;
  overlay.addEventListener('pointerdown', event => {
    if (event.target.closest('button, input, .story-controls')) return;
    gesture = { x: event.clientX, y: event.clientY, at: performance.now(), holdTimer: setTimeout(pause, 220) };
  });
  overlay.addEventListener('pointermove', event => {
    if (!gesture) return;
    const dy = event.clientY - gesture.y;
    if (dy > 0) overlay.querySelector('.story-frame').style.transform = `translateY(${dy * 0.6}px) scale(${1 - Math.min(0.1, dy / 2000)})`;
  }, { passive: true });
  overlay.addEventListener('pointerup', event => {
    if (!gesture) return;
    clearTimeout(gesture.holdTimer);
    const dx = event.clientX - gesture.x; const dy = event.clientY - gesture.y;
    const elapsed = performance.now() - gesture.at;
    const frame = overlay.querySelector('.story-frame');
    gesture = null;
    if (frame) frame.style.transform = '';
    if (dy > 110) return close();
    if (dy < -80 && current().author.id === state.user?.id) return openViewers();
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy)) { resume(); return jumpGroup(dx < 0 ? 1 : -1); }
    if (paused && elapsed > 220) return resume();
    resume();
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) advance(event.clientX < window.innerWidth * 0.33 ? -1 : 1);
  });
  overlay.addEventListener('pointercancel', () => { if (gesture) clearTimeout(gesture.holdTimer); gesture = null; resume(); });

  overlay.addEventListener('click', async event => {
    const trigger = event.target.closest('[data-story-action]');
    if (!trigger) return;
    const story = current();
    const action = trigger.dataset.storyAction;
    try {
      if (action === 'close') close();
      if (action === 'send') sendReply();
      if (action === 'viewers') openViewers();
      if (action === 'react') {
        const next = story.viewerReaction ? '' : '❤️';
        await request(`/api/stories/${story.id}/reaction`, { method: 'POST', body: { reaction: next } });
        story.viewerReaction = next || null;
        trigger.classList.toggle('liked', Boolean(next));
        trigger.innerHTML = icon('heart', 26, Boolean(next));
        if (next) { trigger.classList.add('pop'); setTimeout(() => trigger.classList.remove('pop'), 300); }
      }
      if (action === 'delete') {
        pause();
        if (!(await confirmSheet({ title: t('Delete this story?'), text: t('It disappears for everyone right away.'), confirm: t('Delete story') }))) return resume();
        await request(`/api/stories/${story.id}`, { method: 'DELETE' });
        removeStory(story.id);
        close();
      }
    } catch (error) { toast(error.message, 'error'); }
  });

  draw();
}
