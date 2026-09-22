import { request } from '../api.js';
import { icon } from '../icons.js';
import { navigate } from '../router.js';
import { upsertPost } from '../store.js';
import { toast } from '../ui.js';
import { pickFiles, uploadFiles } from '../components/media.js';
import { addStory } from '../components/stories.js';

export function renderCreate(host) {
  const selected = [];

  host.innerHTML = `
    <div class="page">
      <div class="page-title"><div><h1>Create</h1><p>Share with your circle only.</p></div></div>
      <div class="create-choice">
        <button class="choice-card" data-action="photos">
          <span class="choice-icon">${icon('image', 22)}</span>
          <strong>Photo or video</strong><small>Add up to 10 items to one post</small>
        </button>
        <button class="choice-card" data-action="story">
          <span class="choice-icon">${icon('camera', 22)}</span>
          <strong>Story</strong><small>Disappears after 24 hours</small>
        </button>
      </div>
      <section class="card composer">
        <textarea data-body maxlength="2200" placeholder="What's happening?" aria-label="Post text"></textarea>
        <div class="media-previews" data-previews hidden></div>
        <div class="composer-tools">
          <div>
            <button class="icon-button" data-action="photos" aria-label="Add photos or videos">${icon('image', 21)}</button>
            <button class="icon-button" data-action="story" aria-label="Create a story">${icon('camera', 21)}</button>
          </div>
          <button class="button button-primary" data-action="publish">Share post</button>
        </div>
      </section>
    </div>`;

  const previews = host.querySelector('[data-previews]');
  const textarea = host.querySelector('[data-body]');
  const publishButton = host.querySelector('[data-action="publish"]');

  const drawPreviews = () => {
    previews.hidden = selected.length === 0;
    previews.innerHTML = selected.map((item, index) => `
      <div class="media-preview">
        ${item.file.type.startsWith('video/') ? `<video src="${item.url}" muted playsinline></video>` : `<img src="${item.url}" alt="">`}
        <button data-remove="${index}" aria-label="Remove attachment">${icon('close', 14)}</button>
      </div>`).join('');
    previews.querySelectorAll('[data-remove]').forEach(button => button.addEventListener('click', () => {
      const index = Number(button.dataset.remove);
      URL.revokeObjectURL(selected[index].url);
      selected.splice(index, 1);
      drawPreviews();
    }));
  };

  const addFiles = async () => {
    const files = await pickFiles('image/*,video/*', true);
    for (const file of files.slice(0, 10 - selected.length)) selected.push({ file, url: URL.createObjectURL(file) });
    drawPreviews();
  };

  host.addEventListener('click', async event => {
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;
    const action = trigger.dataset.action;
    if (action === 'photos') return addFiles();
    if (action === 'story') return addStory();
    if (action === 'publish') {
      const body = textarea.value.trim();
      if (!body && !selected.length) return toast('Add text or media first', 'error');
      publishButton.disabled = true;
      publishButton.textContent = 'Sharing…';
      try {
        const uploaded = selected.length ? await uploadFiles(selected.map(item => item.file), 'post') : [];
        const { post } = await request('/api/posts', { method: 'POST', body: { body, mediaIds: uploaded.map(media => media.id) } });
        upsertPost(post);
        selected.forEach(item => URL.revokeObjectURL(item.url));
        selected.length = 0;
        textarea.value = '';
        drawPreviews();
        toast('Posted to your circle');
        navigate('/');
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        publishButton.disabled = false;
        publishButton.textContent = 'Share post';
      }
    }
  });

  return () => selected.forEach(item => URL.revokeObjectURL(item.url));
}
