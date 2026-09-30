/** Tabs of everything shared in one chat: photos & videos, files, links, and voice messages. */
import { request } from '../api.js';
import { icon } from '../icons.js';
import { navigate } from '../router.js';
import { emptyState, escapeHtml, modal } from '../ui.js';
import { relativeTime } from '../lib/time.js';
import { t } from '../lib/i18n.js';
import { formatBytes } from './messages.js';
import { bindVoice, paintVoice, voiceMarkup } from './voice.js';

const TABS = [
  { id: 'media', label: 'Media', empty: 'Photos and videos shared here appear in this tab.' },
  { id: 'files', label: 'Files', empty: 'Documents shared here appear in this tab.' },
  { id: 'links', label: 'Links', empty: 'Links shared here appear in this tab.' },
  { id: 'voice', label: 'Voice', empty: 'Voice messages shared here appear in this tab.' }
];

function linkOf(message) {
  const match = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/i.exec(message.body || '');
  return match ? match[0] : message.linkPreview?.url || '';
}

function itemsMarkup(type, items, conversationId) {
  if (type === 'media') return `<div class="gallery-grid">${items.map(item => `<button class="gallery-item" data-media-open="${item.id}" data-kind="${item.kind}" data-src="${escapeHtml(item.media.url)}"
      style="${item.media.thumb ? `background-image:url('${item.media.thumb}')` : ''}">${item.kind === 'video'
      ? `<video src="${escapeHtml(item.media.url)}" preload="metadata" muted playsinline></video><span class="gallery-badge">${icon('play', 12, true)}</span>`
      : `<img src="${escapeHtml(item.media.url)}" alt="" loading="lazy" decoding="async">`}</button>`).join('')}</div>`;
  if (type === 'files') return `<div class="shared-list">${items.map(item => `<a class="file-card shared-row" href="${escapeHtml(item.media.url)}?download=1" download>
      <span class="file-icon">${escapeHtml(String(item.media.name || '').split('.').pop().slice(0, 4) || 'file')}</span>
      <span class="file-info"><strong>${escapeHtml(item.media.name || t('File'))}</strong><small>${formatBytes(item.media.size)} · ${escapeHtml(relativeTime(item.createdAt))} · ${escapeHtml(item.sender.displayName)}</small></span></a>`).join('')}</div>`;
  if (type === 'links') return `<div class="shared-list">${items.map(item => {
    const url = linkOf(item);
    let host = url;
    try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep raw */ }
    return `<div class="shared-row link-row"><span class="link-badge">${escapeHtml(host.slice(0, 1).toUpperCase())}</span>
      <span class="file-info"><strong>${escapeHtml(item.linkPreview?.title || host)}</strong><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(url)}</a>
      <button class="text-button" data-jump-chat="${item.id}">${t('Show in chat')}</button></span></div>`;
  }).join('')}</div>`;
  return `<div class="shared-list">${items.map(item => `<div class="shared-row voice-row">
      ${voiceMarkup({ ...item.media, url: item.media.url }, { title: item.sender.displayName, mine: item.isMine })}
      <small>${escapeHtml(item.sender.displayName)} · ${escapeHtml(relativeTime(item.createdAt))}</small></div>`).join('')}</div>`;
}

export function mountSharedMedia(host, conversationId) {
  let active = 'media';
  let cursor = null;
  let loading = false;
  host.innerHTML = `
    <div class="segmented shared-tabs" role="tablist">${TABS.map(tab => `<button role="tab" data-shared-tab="${tab.id}" class="${tab.id === active ? 'active' : ''}">${t(tab.label)}</button>`).join('')}</div>
    <div class="shared-body" data-body></div>
    <button class="button button-ghost button-block" data-more hidden>${t('Load more')}</button>`;
  const body = host.querySelector('[data-body]');
  const more = host.querySelector('[data-more]');
  const unbindVoice = bindVoice(body);

  const load = async ({ append = false } = {}) => {
    if (loading) return;
    loading = true;
    if (!append) body.innerHTML = `<div class="gallery-grid">${'<i class="skeleton-tile"></i>'.repeat(6)}</div>`;
    try {
      const data = await request(`/api/conversations/${conversationId}/media?type=${active}${append && cursor ? `&before=${cursor}` : ''}`);
      cursor = data.nextCursor;
      const tab = TABS.find(item => item.id === active);
      if (!append && !data.items.length) body.innerHTML = emptyState(active === 'media' ? 'image' : active === 'files' ? 'file' : active === 'links' ? 'link' : 'mic', t('Nothing here yet'), t(tab.empty));
      else if (append) body.insertAdjacentHTML('beforeend', itemsMarkup(active, data.items, conversationId));
      else body.innerHTML = itemsMarkup(active, data.items, conversationId);
      body.querySelectorAll('[data-voice]').forEach(element => paintVoice(element));
      more.hidden = !cursor;
    } catch (error) {
      body.innerHTML = `<p class="field-hint">${escapeHtml(error.message)}</p>`;
    } finally { loading = false; }
  };

  host.addEventListener('click', event => {
    const tab = event.target.closest('[data-shared-tab]');
    if (tab) {
      active = tab.dataset.sharedTab;
      cursor = null;
      host.querySelectorAll('[data-shared-tab]').forEach(button => button.classList.toggle('active', button === tab));
      return load();
    }
    if (event.target.closest('[data-more]')) return load({ append: true });
    const media = event.target.closest('[data-media-open]');
    if (media) {
      if (media.dataset.kind === 'video') {
        const viewer = modal(`<video class="lightbox-image" src="${escapeHtml(media.dataset.src)}" controls autoplay playsinline></video><button class="icon-button lightbox-close" data-close-modal aria-label="${t('Close')}">${icon('close', 24)}</button>`, 'lightbox');
        return viewer;
      }
      const viewer = modal(`<img class="lightbox-image" src="${escapeHtml(media.dataset.src)}" alt=""><div class="lightbox-actions"><button class="button" data-jump-chat="${media.dataset.mediaOpen}">${t('Show in chat')}</button></div><button class="icon-button lightbox-close" data-close-modal aria-label="${t('Close')}">${icon('close', 24)}</button>`, 'lightbox');
      viewer.addEventListener('click', inner => { if (inner.target.closest('[data-jump-chat]')) { viewer.close(); navigate(`/chat/${conversationId}?m=${media.dataset.mediaOpen}`); } else if (inner.target.classList.contains('lightbox-image')) viewer.close(); });
      return;
    }
    const jump = event.target.closest('[data-jump-chat]');
    if (jump) navigate(`/chat/${conversationId}?m=${jump.dataset.jumpChat}`);
  });

  load();
  return () => unbindVoice();
}
