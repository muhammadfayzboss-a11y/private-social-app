/** Pure markup for chat messages. Every piece of user text passes through escapeHtml. */
import { icon } from '../icons.js';
import { clockTime, exactTime, relativeTime } from '../lib/time.js';
import { escapeHtml } from '../ui.js';
import { voiceMarkup } from './voice.js';

const KIND_LABELS = { sticker: 'Sticker', image: 'Photo', video: 'Video', voice: 'Voice message', story_reply: 'Story reply' };
const KIND_ICONS = { image: 'image', video: 'camera', voice: 'mic', sticker: 'smile' };

/** One-line description of a message for chat previews, reply bars, and pinned bars. */
export function previewText(message) {
  if (!message) return '';
  if (message.kind === 'text' || message.kind === 'story_reply') return message.body || '';
  const label = KIND_LABELS[message.kind] || 'Message';
  return message.body ? `${label} · ${message.body}` : label;
}

export function previewIcon(message) {
  const name = KIND_ICONS[message?.kind];
  return name ? `<span class="preview-icon">${icon(name, 14)}</span>` : '';
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi;

/** Escapes text, then turns URLs into links. Same-origin links navigate inside the app. */
export function richText(text) {
  const source = String(text || '');
  let html = '';
  let last = 0;
  for (const match of source.matchAll(URL_PATTERN)) {
    html += escapeHtml(source.slice(last, match.index));
    let url;
    try { url = new URL(match[0]); } catch { html += escapeHtml(match[0]); last = match.index + match[0].length; continue; }
    const internal = url.origin === window.location.origin;
    html += internal
      ? `<a href="${escapeHtml(url.pathname + url.search)}" data-internal-link>${escapeHtml(match[0])}</a>`
      : `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(match[0])}</a>`;
    last = match.index + match[0].length;
  }
  return html + escapeHtml(source.slice(last));
}

function isEmojiOnly(text) {
  const trimmed = String(text || '').trim();
  return trimmed.length > 0 && trimmed.length <= 12 && /^(\p{Extended_Pictographic}|\p{Emoji_Component}|\u200d|\ufe0f|\s)+$/u.test(trimmed);
}

function mediaAttributes(media) {
  return media.width && media.height ? ` width="${Number(media.width)}" height="${Number(media.height)}" style="aspect-ratio:${Number(media.width)}/${Number(media.height)}"` : '';
}

function bodyMarkup(message, senderName) {
  const media = message.media;
  const src = message.localUrl || media?.url;
  if (message.kind === 'sticker' && message.sticker) return `<img class="sticker" src="${escapeHtml(message.sticker.url)}" alt="${escapeHtml(message.sticker.name)}" draggable="false">`;
  if (message.kind === 'image' && media) return `<button type="button" class="media-open" data-open-media><img class="message-media" src="${escapeHtml(src)}" alt="Photo" loading="lazy" decoding="async"${mediaAttributes(media)}></button>${message.body ? `<div class="message-text">${richText(message.body)}</div>` : ''}`;
  if (message.kind === 'video' && media) return `<video class="message-media" src="${escapeHtml(src)}" controls playsinline preload="metadata"${mediaAttributes(media)}></video>`;
  if (message.kind === 'voice' && media) return voiceMarkup({ ...media, url: src }, { title: senderName });
  if (message.kind === 'story_reply') return `<div class="story-reply-label">${icon('camera', 13)} Replied to a story</div><div class="message-text">${richText(message.body)}</div>`;
  return `<div class="message-text">${richText(message.body)}</div>`;
}

export function statusMarkup(message) {
  if (!message.isMine) return '';
  if (message.failed) return `<span class="status status-failed" title="Not sent">${icon('alert', 14)}</span>`;
  if (!message.id) return `<span class="status status-sending" title="Sending">${icon('clock', 13)}</span>`;
  if (message.readBy?.length) return `<span class="status status-read" title="Read">${icon('checks', 15)}</span>`;
  return `<span class="status status-sent" title="Sent">${icon('check', 14)}</span>`;
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
  const name = reply.sender?.displayName || 'Message';
  const text = reply.deleted ? 'Deleted message' : previewText(reply) || KIND_LABELS[reply.kind] || 'Message';
  return `<button type="button" class="reply-quote" data-jump="${Number(reply.id)}"><strong>${escapeHtml(name)}</strong><span>${escapeHtml(text)}</span></button>`;
}

/**
 * A message row. Layout flags come from the list (grouping consecutive messages from the same
 * sender), so the row itself stays a pure function of its inputs.
 */
export function messageMarkup(message, { viewerId, showSender, showAvatar, groupStart, groupEnd, isGroup, avatarHtml = '', unreadDivider = false }) {
  const kindClass = message.kind === 'sticker' ? ' sticker-message' : (message.kind === 'image' || message.kind === 'video') && !message.body ? ' media-message' : '';
  const emoji = message.kind === 'text' && isEmojiOnly(message.body) ? ' emoji-message' : '';
  const key = message.id ? `m${message.id}` : `c${message.clientId}`;
  const time = message.createdAt;
  return `${unreadDivider ? '<div class="unread-divider" data-unread-divider><span>Unread messages</span></div>' : ''}
  <div class="message${message.isMine ? ' mine' : ''}${kindClass}${emoji}${groupStart ? ' group-start' : ''}${groupEnd ? ' group-end' : ''}${message.failed ? ' failed' : ''}${!message.id ? ' pending' : ''}"
    data-message="${message.id || ''}" data-key="${key}" ${message.clientId ? `data-client-id="${escapeHtml(message.clientId)}"` : ''}>
    ${isGroup && !message.isMine ? `<div class="message-avatar">${showAvatar ? avatarHtml : ''}</div>` : ''}
    <div class="message-column">
      <div class="message-bubble">
        ${showSender ? `<span class="message-sender" data-hue="${Number(message.sender.id) % 7}">${escapeHtml(message.sender.displayName)}</span>` : ''}
        ${message.forwardedFrom ? `<div class="forwarded">${icon('forward', 13)} Forwarded from <strong>${escapeHtml(message.forwardedFrom.displayName)}</strong></div>` : ''}
        ${replyMarkup(message)}
        ${bodyMarkup(message, message.sender.displayName)}
        <span class="message-meta">
          ${message.editedAt ? '<span class="edited">edited</span>' : ''}
          <time datetime="${escapeHtml(time)}" data-rel title="${escapeHtml(exactTime(time))} · ${escapeHtml(clockTime(time))}">${relativeTime(time)}</time>
          ${statusMarkup(message)}
        </span>
      </div>
      ${reactionsMarkup(message, viewerId)}
      ${message.failed ? `<button type="button" class="retry-send" data-retry="${escapeHtml(message.clientId)}">${icon('alert', 13)} Not sent — tap to retry</button>` : ''}
    </div>
    <span class="swipe-reply-icon" aria-hidden="true">${icon('reply', 18)}</span>
  </div>`;
}

/** Everything that changes a row's appearance; rows are only rebuilt when this changes. */
export function messageSignature(message, layout) {
  return JSON.stringify([
    message.id, message.clientId, message.body, message.editedAt, message.failed, message.localUrl ? 1 : 0,
    message.reactions?.map(item => [item.reaction, item.user.id]), message.readBy?.length ? 1 : 0, message.media?.id, message.media?.durationMs,
    layout.showSender, layout.showAvatar, layout.groupStart, layout.groupEnd, layout.unreadDivider, message.replyTo?.deleted
  ]);
}
