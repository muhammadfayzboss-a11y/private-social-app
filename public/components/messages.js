/** Pure markup for chat messages. Every piece of user text passes through escapeHtml. */
import { icon } from '../icons.js';
import { clockTime, exactTime, relativeTime } from '../lib/time.js';
import { t } from '../lib/i18n.js';
import { settings } from '../lib/settings.js';
import { escapeHtml } from '../ui.js';
import { voiceMarkup } from './voice.js';

const KIND_LABELS = { sticker: 'Sticker', image: 'Photo', video: 'Video', voice: 'Voice message', story_reply: 'Story reply', file: 'File' };
const KIND_ICONS = { image: 'image', video: 'camera', voice: 'mic', sticker: 'smile', file: 'file' };

/** One-line description of a message for chat previews, reply bars, and pinned bars. */
export function previewText(message) {
  if (!message) return '';
  if (message.kind === 'text' || message.kind === 'story_reply') return message.body || '';
  if (message.kind === 'file') return message.body || message.media?.name || t('File');
  const label = t(KIND_LABELS[message.kind] || 'Message');
  return message.body ? `${label} · ${message.body}` : label;
}

export function previewIcon(message) {
  const name = KIND_ICONS[message?.kind];
  return name ? `<span class="preview-icon">${icon(name, 14)}</span>` : '';
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi;
const MENTION_PATTERN = /(^|[^\w@])@([a-z0-9_]{3,24})\b/gi;

function mentions(escaped) {
  return escaped.replace(MENTION_PATTERN, (match, before, name) => `${before}<span class="mention" data-mention="${name.toLowerCase()}">@${name}</span>`);
}

/** Escapes text, then turns URLs into links and @usernames into mentions. Same-origin links stay in the app. */
export function richText(text) {
  const source = String(text || '');
  let html = '';
  let last = 0;
  for (const match of source.matchAll(URL_PATTERN)) {
    html += mentions(escapeHtml(source.slice(last, match.index)));
    let url;
    try { url = new URL(match[0]); } catch { html += escapeHtml(match[0]); last = match.index + match[0].length; continue; }
    const internal = url.origin === window.location.origin;
    html += internal
      ? `<a href="${escapeHtml(url.pathname + url.search)}" data-internal-link>${escapeHtml(match[0])}</a>`
      : `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(match[0])}</a>`;
    last = match.index + match[0].length;
  }
  return html + mentions(escapeHtml(source.slice(last)));
}

function isEmojiOnly(text) {
  const trimmed = String(text || '').trim();
  return trimmed.length > 0 && trimmed.length <= 12 && /^(\p{Extended_Pictographic}|\p{Emoji_Component}|\u200d|\ufe0f|\s)+$/u.test(trimmed);
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10240 ? 1 : 0)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

const FILE_COLORS = { pdf: '#e5484d', doc: '#2d7fd0', docx: '#2d7fd0', xls: '#1f9d5f', xlsx: '#1f9d5f', csv: '#1f9d5f', ppt: '#e0871f', pptx: '#e0871f', zip: '#8e6cf5', txt: '#6e6e7c', md: '#6e6e7c' };

function mediaBox(media, inner, { thumb = true } = {}) {
  const ratio = media.width && media.height ? `aspect-ratio:${Number(media.width)}/${Number(media.height)};` : '';
  const width = media.width && media.height ? `width:min(300px, 72vw, calc(${Number(media.width)} / ${Number(media.height)} * 360px));` : '';
  const background = thumb && media.thumb ? `background-image:url('${media.thumb}');` : '';
  return `<span class="media-box" style="${ratio}${width}${background}">${inner}</span>`;
}

function bodyMarkup(message, { mine, senderName, autoload }) {
  const media = message.media;
  const src = message.localUrl || media?.url;
  if (message.kind === 'sticker' && message.sticker) return `<img class="sticker" src="${escapeHtml(message.sticker.url)}" alt="${escapeHtml(message.sticker.name)}" draggable="false">`;
  if (message.kind === 'image' && media) {
    const image = autoload.photos || message.localUrl
      ? `<img class="message-media" src="${escapeHtml(src)}" alt="${t('Photo')}" loading="lazy" decoding="async">`
      : `<span class="media-download" data-load-media>${icon('install', 22)}<small>${formatBytes(media.size)}</small></span>`;
    return `<button type="button" class="media-open" data-open-media>${mediaBox(media, image)}</button>${message.body ? `<div class="message-text caption">${richText(message.body)}</div>` : ''}`;
  }
  if (message.kind === 'video' && media) {
    const video = autoload.videos || message.localUrl
      ? `<video class="message-media" src="${escapeHtml(src)}" controls playsinline preload="metadata"></video>`
      : `<span class="media-download" data-load-media>${icon('play', 22, true)}<small>${formatBytes(media.size)}</small></span>`;
    return `${mediaBox(media, video)}${message.body ? `<div class="message-text caption">${richText(message.body)}</div>` : ''}`;
  }
  if (message.kind === 'voice' && media) return voiceMarkup({ ...media, url: src }, { title: senderName, mine });
  if (message.kind === 'file' && media) {
    const extension = String(media.name || '').split('.').pop().toLowerCase().slice(0, 4);
    return `<a class="file-card" href="${escapeHtml(message.localUrl || `${media.url}?download=1`)}" ${message.localUrl ? '' : 'download'} data-file>
        <span class="file-icon" style="--file:${FILE_COLORS[extension] || '#6c5ce7'}">${escapeHtml(extension || 'file')}</span>
        <span class="file-info"><strong>${escapeHtml(media.name || t('File'))}</strong><small>${formatBytes(media.size)}${extension ? ` · ${escapeHtml(extension.toUpperCase())}` : ''}</small></span>
      </a>${message.body ? `<div class="message-text caption">${richText(message.body)}</div>` : ''}`;
  }
  if (message.kind === 'story_reply') return `<div class="story-reply-label">${icon('camera', 13)} ${t('Replied to a story')}</div><div class="message-text">${richText(message.body)}</div>`;
  return `<div class="message-text">${richText(message.body)}</div>`;
}

function linkPreviewMarkup(message) {
  const preview = message.linkPreview;
  if (!preview || !settings().chat.linkPreviews) return '';
  return `<a class="link-preview" href="${escapeHtml(preview.url)}" target="_blank" rel="noopener noreferrer nofollow">
    ${preview.siteName ? `<span class="link-site">${escapeHtml(preview.siteName)}</span>` : ''}
    <strong>${escapeHtml(preview.title)}</strong>${preview.description ? `<span>${escapeHtml(preview.description)}</span>` : ''}
  </a>`;
}

export function statusMarkup(message) {
  if (!message.isMine) return '';
  if (message.failed) return `<span class="status status-failed" title="${t('Not sent')}">${icon('alert', 14)}</span>`;
  if (!message.id) return `<span class="status status-sending" title="${t('Sending')}">${icon('clock', 13)}</span>`;
  if (message.readBy?.length) return `<span class="status status-read" title="${t('Read')}">${icon('checks', 16)}</span>`;
  return `<span class="status status-sent" title="${t('Sent')}">${icon('check', 15)}</span>`;
}

function reactionsMarkup(message, viewerId) {
  if (!message.reactions?.length) return '';
  const groups = new Map();
  for (const item of message.reactions) {
    if (!groups.has(item.reaction)) groups.set(item.reaction, { count: 0, mine: false, names: [] });
    const group = groups.get(item.reaction);
    group.count += 1;
    group.names.push(item.user.displayName);
    if (item.user.id === viewerId) group.mine = true;
  }
  return `<div class="message-reactions">${[...groups].map(([reaction, group]) => `
    <button type="button" class="message-reaction${group.mine ? ' mine' : ''}" data-toggle-reaction="${escapeHtml(reaction)}" title="${escapeHtml(group.names.join(', '))}">
      <span>${escapeHtml(reaction)}</span>${group.count > 1 ? `<b>${group.count}</b>` : ''}
    </button>`).join('')}</div>`;
}

function replyMarkup(message) {
  const reply = message.replyTo;
  if (!reply) return '';
  const name = reply.sender?.displayName || t('Message');
  const text = reply.deleted ? t('Deleted message') : previewText(reply) || t(KIND_LABELS[reply.kind] || 'Message');
  return `<button type="button" class="reply-quote" data-jump="${Number(reply.id)}"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(text)}</span></button>`;
}

export function timeLabel(value) {
  return settings().appearance.bubbleTime === 'clock' ? clockTime(value) : relativeTime(value);
}

/**
 * A message row. Layout flags come from the list (grouping consecutive messages from the same
 * sender), so the row itself stays a pure function of its inputs.
 */
export function messageMarkup(message, { viewerId, showSender, showAvatar, groupStart, groupEnd, isGroup, avatarHtml = '', unreadDivider = false, selecting = false, selected = false }) {
  const visual = (message.kind === 'image' || message.kind === 'video') && !message.body;
  const kindClass = message.kind === 'sticker' ? ' sticker-message' : visual ? ' media-message' : '';
  const emoji = message.kind === 'text' && isEmojiOnly(message.body) ? ' emoji-message' : '';
  const key = message.id ? `m${message.id}` : `c${message.clientId}`;
  const time = message.createdAt;
  const autoload = { photos: settings().data.autoPhotos, videos: settings().data.autoVideos };
  const clock = settings().appearance.bubbleTime === 'clock';
  return `${unreadDivider ? `<div class="unread-divider" data-unread-divider><span>${t('Unread messages')}</span></div>` : ''}
  <div class="message${message.isMine ? ' mine' : ''}${kindClass}${emoji}${groupStart ? ' group-start' : ''}${groupEnd ? ' group-end' : ''}${message.failed ? ' failed' : ''}${!message.id ? ' pending' : ''}${selected ? ' selected' : ''}"
    data-message="${message.id || ''}" data-key="${key}" ${message.clientId ? `data-client-id="${escapeHtml(message.clientId)}"` : ''}>
    ${selecting ? `<span class="select-check" aria-hidden="true">${icon('check', 14)}</span>` : ''}
    ${isGroup && !message.isMine ? `<div class="message-avatar">${showAvatar ? avatarHtml : ''}</div>` : ''}
    <div class="message-column">
      <div class="message-bubble">
        ${showSender ? `<span class="message-sender" data-hue="${Number(message.sender.id) % 7}">${escapeHtml(message.sender.displayName)}</span>` : ''}
        ${message.forwardedFrom ? `<div class="forwarded">${icon('forward', 13)} ${t('Forwarded from')} <strong>${escapeHtml(message.forwardedFrom.displayName)}</strong></div>` : ''}
        ${replyMarkup(message)}
        ${bodyMarkup(message, { mine: message.isMine, senderName: message.sender.displayName, autoload })}
        ${linkPreviewMarkup(message)}
        <span class="message-meta">
          ${message.editedAt ? `<span class="edited">${t('edited')}</span>` : ''}
          <time datetime="${escapeHtml(time)}" ${clock ? '' : 'data-rel'} title="${escapeHtml(exactTime(time))}">${timeLabel(time)}</time>
          ${statusMarkup(message)}
        </span>
      </div>
      ${reactionsMarkup(message, viewerId)}
      ${message.failed ? `<button type="button" class="retry-send" data-retry="${escapeHtml(message.clientId)}">${icon('alert', 13)} ${t('Not sent — tap to retry')}</button>` : ''}
    </div>
    <span class="swipe-reply-icon" aria-hidden="true">${icon('reply', 18)}</span>
  </div>`;
}

/** Everything that changes a row's appearance; rows are only rebuilt when this changes. */
export function messageSignature(message, layout) {
  return JSON.stringify([
    message.id, message.clientId, message.body, message.editedAt, message.failed, message.localUrl ? 1 : 0, message.linkPreview?.title,
    message.reactions?.map(item => [item.reaction, item.user.id]), message.readBy?.length ? 1 : 0, message.media?.id, message.media?.durationMs,
    layout.showSender, layout.showAvatar, layout.groupStart, layout.groupEnd, layout.unreadDivider, message.replyTo?.deleted, layout.selecting, layout.selected
  ]);
}
