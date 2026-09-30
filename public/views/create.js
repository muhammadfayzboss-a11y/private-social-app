import { request } from '../api.js';
import { icon } from '../icons.js';
import { goBack } from '../router.js';
import { upsertPost } from '../store.js';
import { toast, topBar } from '../ui.js';
import { t } from '../lib/i18n.js';
import { pickFiles, uploadFiles } from '../components/media.js';
import { preparePhoto, prepareVideo } from '../components/attach.js';
import { addStory } from '../components/stories.js';

export function renderCreate(host) {
  const selected = [];

  host.innerHTML = `
    ${topBar({ title: t('New post'), back: '/feed', actions: `<button class="text-button" data-action="publish">${t('Share')}</button>` })}
    <div class="screen-scroll" data-scroll>
      <section class="group"><div class="group-body padded">
        <textarea class="composer-textarea" data-body maxlength="2200" placeholder="${t('What’s happening?')}" aria-label="${t('Post text')}"></textarea>
        <div class="media-previews" data-previews hidden></div>
      </div></section>
      <section class="group"><div class="group-body">
        <button class="row" data-action="photos"><span class="tile" style="--tile:#5b8def">${icon('image', 18)}</span><span class="row-text"><span class="row-label">${t('Add photos or videos')}</span><small>${t('Up to 10 items in one post')}</small></span></button>
        <button class="row" data-action="story"><span class="tile" style="--tile:#ff5c7a">${icon('camera', 18)}</span><span class="row-text"><span class="row-label">${t('Share a story instead')}</span><small>${t('Disappears after 24 hours')}</small></span></button>
      </div></section>
      <p class="group-footer">${t('Posts are shared with your circle only.')}</p>
    </div>`;

  const previews = host.querySelector('[data-previews]');
  const textarea = host.querySelector('[data-body]');
  const publishButton = host.querySelector('[data-action="publish"]');

  const drawPreviews = () => {
    previews.hidden = selected.length === 0;
    previews.innerHTML = selected.map((item, index) => `
      <div class="media-preview">
        ${item.file.type.startsWith('video/') ? `<video src="${item.url}" muted playsinline></video>` : `<img src="${item.url}" alt="">`}
        <button data-remove="${index}" aria-label="${t('Remove')}">${icon('close', 14)}</button>
      </div>`).join('');
  };

  host.addEventListener('click', async event => {
    const remove = event.target.closest('[data-remove]');
    if (remove) {
      const [item] = selected.splice(Number(remove.dataset.remove), 1);
      if (item) URL.revokeObjectURL(item.url);
      return drawPreviews();
    }
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'photos') {
      const files = await pickFiles('image/*,video/*', true);
      for (const file of files.slice(0, 10 - selected.length)) selected.push({ file, url: URL.createObjectURL(file) });
      drawPreviews();
    }
    if (action === 'story') addStory();
    if (action === 'publish') {
      const body = textarea.value.trim();
      if (!body && !selected.length) return toast(t('Add text or media first'), 'error');
      publishButton.disabled = true;
      publishButton.textContent = t('Sharing…');
      try {
        const uploaded = [];
        for (const item of selected) {
          const prepared = item.file.type.startsWith('video/') ? await prepareVideo(item.file) : await preparePhoto(item.file);
          uploaded.push(...await uploadFiles([prepared.file], 'post', prepared));
        }
        const { post } = await request('/api/posts', { method: 'POST', body: { body, mediaIds: uploaded.map(media => media.id) } });
        upsertPost(post);
        selected.forEach(item => URL.revokeObjectURL(item.url));
        selected.length = 0;
        textarea.value = '';
        drawPreviews();
        toast(t('Posted to your circle'));
        goBack('/feed');
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        publishButton.disabled = false;
        publishButton.textContent = t('Share');
      }
    }
  });

  setTimeout(() => textarea.focus(), 320);
  return () => selected.forEach(item => URL.revokeObjectURL(item.url));
}
