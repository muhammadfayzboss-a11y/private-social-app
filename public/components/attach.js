/**
 * Attachments: pick → preview (caption, remove, "send as file") → send.
 *
 * Photos are downscaled on the device before upload (a 12 MP phone photo becomes a few hundred KB),
 * which makes sending and loading fast on mobile data. Every photo and video also gets a ~1 KB
 * blurred thumbnail so the chat shows a placeholder instantly while the full file loads.
 */
import { icon } from '../icons.js';
import { actionSheet, escapeHtml, modal } from '../ui.js';
import { t, tn } from '../lib/i18n.js';
import { pickFiles } from './media.js';
import { formatBytes } from './messages.js';

const MAX_EDGE = 2048;
const FILE_ACCEPT = '.pdf,.zip,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,.md,image/*,video/*,audio/*';

function canvasFor(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

async function loadBitmap(file) {
  if (window.createImageBitmap) {
    try { return await window.createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* fall back to <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await image.decode();
    return image;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

function thumbFrom(source, width, height) {
  const scale = 24 / Math.max(width, height);
  const canvas = canvasFor(width * scale, height * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.5);
}

/** Returns { file, width, height, thumb } ready to upload. GIFs are kept as-is (animation). */
export async function preparePhoto(file) {
  try {
    const bitmap = await loadBitmap(file);
    const width = bitmap.width || bitmap.naturalWidth;
    const height = bitmap.height || bitmap.naturalHeight;
    const thumb = thumbFrom(bitmap, width, height);
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height));
    if (file.type === 'image/gif' || (scale === 1 && file.size < 1.5 * 1024 * 1024)) return { file, width, height, thumb };
    const canvas = canvasFor(width * scale, height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.86));
    if (!blob || blob.size >= file.size) return { file, width, height, thumb };
    const name = file.name.replace(/\.\w+$/, '') + '.jpg';
    return { file: new File([blob], name, { type: 'image/jpeg' }), width: canvas.width, height: canvas.height, thumb };
  } catch {
    return { file };
  }
}

export function prepareVideo(file) {
  return new Promise(resolve => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata'; video.muted = true; video.playsInline = true;
    const finish = result => { URL.revokeObjectURL(url); resolve({ file, ...result }); };
    const timeout = setTimeout(() => finish({}), 5000);
    video.onloadeddata = () => {
      try {
        const width = video.videoWidth; const height = video.videoHeight;
        clearTimeout(timeout);
        finish({ width, height, durationMs: Number.isFinite(video.duration) ? video.duration * 1000 : 0, thumb: width ? thumbFrom(video, width, height) : null });
      } catch { clearTimeout(timeout); finish({}); }
    };
    video.onerror = () => { clearTimeout(timeout); finish({}); };
    video.src = url;
    video.currentTime = 0.1;
  });
}

export async function openAttachMenu() {
  const choice = await actionSheet({
    actions: [
      { id: 'gallery', label: t('Photo or video'), icon: 'image' },
      { id: 'camera', label: t('Camera'), icon: 'camera' },
      { id: 'file', label: t('File'), icon: 'file' }
    ]
  });
  if (choice === 'gallery') return { files: await pickFiles('image/*,video/*', true), asFiles: false };
  if (choice === 'camera') return { files: await pickFiles('image/*', false, { capture: 'environment' }), asFiles: false };
  if (choice === 'file') return { files: await pickFiles(FILE_ACCEPT, true), asFiles: true };
  return { files: [], asFiles: false };
}

/**
 * Preview sheet. Resolves with { items: File[], caption, asFiles } or null when cancelled.
 * Media shows as thumbnails; documents as rows with name and size.
 */
export function openAttachPreview(files, { asFiles = false } = {}) {
  return new Promise(resolve => {
    const items = files.slice(0, 10).map(file => ({ file, url: /^(image|video)\//.test(file.type) ? URL.createObjectURL(file) : null }));
    let sendAsFiles = asFiles || items.some(item => !item.url);
    let result = null;
    const sheet = modal(`
      <div class="modal-head"><h2 data-heading></h2><button class="icon-button" data-close-modal aria-label="${t('Close')}">${icon('close', 20)}</button></div>
      <div class="attach-previews" data-previews></div>
      ${items.every(item => item.url) ? `<button type="button" class="row compact-row" data-toggle-files>${icon('file', 20)}<span class="row-text"><span class="row-label">${t('Send as file (original quality)')}</span></span><i class="switch${sendAsFiles ? ' on' : ''}"></i></button>` : ''}
      <div class="attach-caption"><input data-caption maxlength="1000" placeholder="${t('Add a caption…')}" aria-label="${t('Caption')}"><button type="button" class="send-circle" data-send aria-label="${t('Send')}">${icon('send', 20)}</button></div>`, 'attach-sheet');
    const draw = () => {
      sheet.querySelector('[data-heading]').textContent = items.length === 1 ? (items[0].url && !sendAsFiles ? t('Send photo') : t('Send file')) : tn(items.length, 'Send {n} item', 'Send {n} items');
      sheet.querySelector('[data-previews]').innerHTML = items.map((item, index) => item.url && !sendAsFiles
        ? `<div class="attach-thumb">${item.file.type.startsWith('video/') ? `<video src="${item.url}" muted playsinline></video><span class="gallery-badge">${icon('play', 12, true)}</span>` : `<img src="${item.url}" alt="">`}
            <button type="button" data-remove="${index}" aria-label="${t('Remove')}">${icon('close', 14)}</button></div>`
        : `<div class="attach-file"><span class="file-icon">${escapeHtml(item.file.name.split('.').pop().slice(0, 4))}</span><span><strong>${escapeHtml(item.file.name)}</strong><small>${formatBytes(item.file.size)}</small></span>
            <button type="button" class="icon-button" data-remove="${index}" aria-label="${t('Remove')}">${icon('close', 16)}</button></div>`).join('');
      if (!items.length) sheet.close();
    };
    sheet.addEventListener('click', event => {
      const remove = event.target.closest('[data-remove]');
      if (remove) { const [item] = items.splice(Number(remove.dataset.remove), 1); if (item?.url) URL.revokeObjectURL(item.url); draw(); return; }
      if (event.target.closest('[data-toggle-files]')) {
        sendAsFiles = !sendAsFiles;
        event.target.closest('[data-toggle-files]').querySelector('.switch').classList.toggle('on', sendAsFiles);
        draw();
        return;
      }
      if (event.target.closest('[data-send]')) {
        result = { items: items.map(item => item.file), caption: sheet.querySelector('[data-caption]').value.trim(), asFiles: sendAsFiles };
        sheet.close();
      }
    });
    sheet.querySelector('[data-caption]').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); sheet.querySelector('[data-send]').click(); } });
    sheet.addEventListener('sheet:closed', () => { items.forEach(item => item.url && URL.revokeObjectURL(item.url)); resolve(result); }, { once: true });
    draw();
  });
}
