import { request, upload } from '../api.js';
import { icon } from '../icons.js';
import { goBack, navigate } from '../router.js';
import {
  conversationById, getDraft, loadAround, loadConversations, loadMembers, loadMessages, loadNewer, markConversationRead, memberById,
  messageKey, messageStore, patchConversation, patchPendingMessage, publish, removeMessage, removePendingMessage, setDraft, state, subscribe,
  trimHistory, typingUsers, upsertMessage
} from '../store.js';
import { actionSheet, avatar, emptyState, escapeHtml, modal, toast } from '../ui.js';
import { dayKey, dayLabel, lastSeenText, now, parseTime, refreshRelativeTimes } from '../lib/time.js';
import { onEnded, renameMedia, setPlaybackRate, stopAll, toggle as togglePlayback } from '../lib/audio.js';
import { onLongPress, onSwipeLeft } from '../lib/gestures.js';
import { closeOverlay, openOverlay } from '../lib/overlays.js';
import { onSettingsChange, settings } from '../lib/settings.js';
import { paintWallpaper } from '../lib/wallpapers.js';
import { t, tn } from '../lib/i18n.js';
import { playSentSound } from '../lib/sounds.js';
import { messageMarkup, messageSignature, previewIcon, previewText } from '../components/messages.js';
import { openForwardPicker } from '../components/messageMenu.js';
import { openMessageFocus } from '../components/messageFocus.js';
import { bindVoice, paintVoice } from '../components/voice.js';
import { createEmojiPanel } from '../components/emojiPanel.js';
import { openAttachMenu, openAttachPreview, preparePhoto, prepareVideo } from '../components/attach.js';
import { createVoiceComposer } from '../components/voiceComposer.js';
import { conversationAvatar, otherMember } from '../components/chatRow.js';

const GROUP_WINDOW_MS = 5 * 60 * 1000;
let localSeq = 0;
let keyboardHeight = Number(localStorage.getItem('circle-keyboard-height')) || 290;

function newClientId() {
  const random = crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `c${random}`.slice(0, 40);
}

export function renderConversation(host, { conversationId }, screen) {
  const id = Number(conversationId);
  const jumpTarget = Number(new URLSearchParams(window.location.search).get('m')) || null;
  let active = true;
  const setActive = value => {
    active = value;
    if (value) { state.openConversationId = id; document.documentElement.classList.add('chat-open'); }
    else if (state.openConversationId === id) { state.openConversationId = null; document.documentElement.classList.remove('chat-open'); }
  };
  setActive(true);

  let replyTo = null;
  let editing = null;
  let unreadAnchor = null;
  let lastReadSent = 0;
  let stickToBottom = true;
  let awayCount = 0;
  let firstDraw = true;
  let destroyed = false;
  let typingSentAt = 0;
  let typingStopTimer = null;
  let selecting = false;
  const selected = new Set();
  let selectionOverlay = null;
  let searchOverlay = null;
  let searchResults = [];
  let searchIndex = -1;
  let emojiPanel = null;
  let emojiOverlay = null;
  const rows = new Map();
  const days = new Map();
  const retries = new Map();     // clientId -> function that re-sends with the same clientId
  const cleanups = [];

  host.innerHTML = `
    <div class="chat-page">
      <div class="chat-wallpaper" data-wallpaper aria-hidden="true"></div>
      <header class="chat-header">
        <div class="header-row header-normal">
          <button class="icon-button topbar-back" data-action="back" aria-label="${t('Back')}">${icon('back', 26)}</button>
          <button class="chat-person" data-action="info" aria-label="${t('Conversation details')}"></button>
          <button class="icon-button" data-action="search" aria-label="${t('Search in chat')}">${icon('search', 22)}</button>
          <button class="icon-button" data-action="more" aria-label="${t('More')}">${icon('more', 22)}</button>
        </div>
        <div class="header-row header-search">
          <button class="icon-button" data-action="close-search" aria-label="${t('Close search')}">${icon('back', 26)}</button>
          <input type="search" data-search placeholder="${t('Search')}" enterkeyhint="search" autocomplete="off" aria-label="${t('Search in chat')}">
          <span class="search-count" data-search-count></span>
          <button class="icon-button" data-action="search-up" aria-label="${t('Older result')}">${icon('arrowup', 20)}</button>
          <button class="icon-button" data-action="search-down" aria-label="${t('Newer result')}"><span class="flip">${icon('arrowup', 20)}</span></button>
        </div>
        <div class="header-row header-select">
          <button class="icon-button" data-action="close-select" aria-label="${t('Cancel selection')}">${icon('close', 24)}</button>
          <strong class="select-count" data-select-count></strong>
          <button class="icon-button" data-action="select-copy" aria-label="${t('Copy')}">${icon('copy', 21)}</button>
          <button class="icon-button" data-action="select-share" aria-label="${t('Share')}">${icon('share', 21)}</button>
          <button class="icon-button" data-action="select-pin" aria-label="${t('Pin')}">${icon('pin', 21)}</button>
        </div>
      </header>
      <div class="pinned-bar" data-pinned hidden></div>
      <div class="messages" data-messages>
        <div class="messages-inner" data-list>${bubbleSkeleton()}</div>
      </div>
      <button class="scroll-down" data-action="scroll-bottom" aria-label="${t('Scroll to latest messages')}" hidden>${icon('down', 24)}<span class="scroll-badge" data-away hidden></span></button>
      <div class="composer-wrap" data-composer-wrap>
        <div class="composer-context" data-context hidden></div>
        <div class="blocked-bar" data-blocked hidden></div>
        <form class="chat-composer" data-composer>
          <button class="icon-button composer-emoji" type="button" data-action="emoji" aria-label="${t('Emoji and stickers')}">${icon('smile', 25)}</button>
          <div class="composer-field">
            <textarea class="chat-input" data-input rows="1" maxlength="4000" placeholder="${t('Message')}" aria-label="${t('Message')}" enterkeyhint="send"></textarea>
          </div>
          <button class="icon-button composer-attach" type="button" data-action="attach" aria-label="${t('Attach')}">${icon('paperclip', 24)}</button>
          <button class="composer-action chat-voice" type="button" data-action="voice" aria-label="${t('Record voice message')}">${icon('mic', 24)}</button>
          <button class="composer-action chat-send" type="submit" aria-label="${t('Send message')}">${icon('send', 22)}</button>
        </form>
        <div class="select-bar" data-select-bar>
          <button type="button" class="select-bar-action danger" data-action="select-delete">${icon('trash', 21)}<span>${t('Delete')}</span></button>
          <button type="button" class="select-bar-action" data-action="select-forward">${icon('forward', 21)}<span>${t('Forward')}</span></button>
        </div>
      </div>
      <div class="emoji-host" data-emoji-host></div>
    </div>`;

  const page = host.querySelector('.chat-page');
  const wallpaper = host.querySelector('[data-wallpaper]');
  const scroller = host.querySelector('[data-messages]');
  const list = host.querySelector('[data-list]');
  const personHost = host.querySelector('.chat-person');
  const pinnedBar = host.querySelector('[data-pinned]');
  const contextBar = host.querySelector('[data-context]');
  const blockedBar = host.querySelector('[data-blocked]');
  const input = host.querySelector('[data-input]');
  const form = host.querySelector('[data-composer]');
  const composerWrap = host.querySelector('[data-composer-wrap]');
  const scrollDown = host.querySelector('[data-action="scroll-bottom"]');
  const awayBadge = host.querySelector('[data-away]');
  const emojiHost = host.querySelector('[data-emoji-host]');
  const searchInput = host.querySelector('[data-search]');
  const topSentinel = document.createElement('div');
  topSentinel.className = 'history-sentinel';
  topSentinel.innerHTML = '<span class="spinner"></span>';
  const bottomSentinel = document.createElement('div');
  bottomSentinel.className = 'history-sentinel';
  bottomSentinel.innerHTML = '<span class="spinner"></span>';

  input.value = getDraft(id);
  syncComposer();
  setPlaybackRate(settings().chat.voiceSpeed);

  const drawWallpaper = () => paintWallpaper(wallpaper, settings().appearance.wallpaper, document.documentElement.dataset.theme);
  drawWallpaper();
  const onTheme = () => drawWallpaper();
  document.addEventListener('themechange', onTheme);
  cleanups.push(() => document.removeEventListener('themechange', onTheme));
  cleanups.push(onSettingsChange((next, changed) => {
    if (changed?.appearance?.wallpaper) drawWallpaper();
    if (changed?.appearance?.bubbleTime || changed?.chat?.linkPreviews || changed?.data) { rows.clear(); draw(); }
  }));

  /* ------------------------------- header ------------------------------- */

  function drawHeader() {
    const conversation = conversationById(id);
    if (!conversation) return;
    const other = otherMember(conversation);
    const live = conversation.kind === 'direct' ? (memberById(other?.id) || other) : null;
    const typing = typingUsers(id);
    let subtitle;
    if (typing.length) {
      const verb = typing.some(item => item.kind === 'voice') ? t('recording voice') : t('typing');
      subtitle = conversation.kind === 'group' ? `${typing.map(item => escapeHtml(item.user.displayName.split(' ')[0])).join(', ')} ${verb}` : verb;
      subtitle += '<i class="typing-dots"><b></b><b></b><b></b></i>';
    } else if (conversation.kind === 'group') {
      const online = conversation.members.filter(member => member.id !== state.user?.id && (memberById(member.id) || member).online).length;
      subtitle = escapeHtml(tn(conversation.members.length, '{n} member', '{n} members') + (online ? `, ${tn(online, '{n} online', '{n} online')}` : ''));
    } else subtitle = escapeHtml(lastSeenText(live));
    personHost.innerHTML = `
      <span class="avatar-wrap${live?.online ? ' is-online' : ''}">${conversationAvatar(conversation, 'sm')}</span>
      <span class="chat-person-text"><strong>${escapeHtml(conversation.title || t('Conversation'))}</strong>
      <small data-typing class="${typing.length ? 'is-typing' : ''}${live?.online ? ' is-online' : ''}">${subtitle}</small></span>`;
    drawPinned(conversation);
    drawBlocked(conversation);
  }

  function drawPinned(conversation) {
    const pinned = conversation.pinnedMessage;
    pinnedBar.hidden = !pinned;
    if (!pinned) return;
    pinnedBar.innerHTML = `<button type="button" class="pinned-main" data-jump="${pinned.id}"><span class="pinned-line"></span><span class="pinned-text"><strong>${t('Pinned message')}</strong><small>${previewIcon(pinned)}${escapeHtml(previewText(pinned) || t('Message'))}</small></span></button>
      <button type="button" class="icon-button" data-action="unpin" aria-label="${t('Unpin message')}">${icon('close', 18)}</button>`;
  }

  function drawBlocked(conversation) {
    const blocked = conversation.blocked;
    const closed = Boolean(blocked?.byMe || blocked?.byThem);
    blockedBar.hidden = !closed;
    form.hidden = closed || selecting;
    if (!closed) return;
    blockedBar.innerHTML = blocked.byMe
      ? `<button type="button" class="blocked-action" data-action="unblock">${t('Unblock')}</button>`
      : `<p>${t('You can’t send messages to this member.')}</p>`;
  }

  /* ------------------------------ messages ------------------------------ */

  function bubbleSkeleton() {
    return `<div class="bubble-skeleton" aria-hidden="true">${[62, 40, 75, 52, 34, 68].map((width, index) => `<i class="${index % 3 === 1 ? 'mine' : ''}" style="width:${width}%"></i>`).join('')}</div>`;
  }

  function isNearBottom(threshold = 120) {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < threshold;
  }

  function scrollToBottom(smooth = false) {
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth && document.documentElement.dataset.motion !== 'off' ? 'smooth' : 'auto' });
    awayCount = 0;
    updateScrollButton();
  }

  function updateScrollButton() {
    const store = messageStore(id);
    const show = !isNearBottom(300) || store.hasNewer;
    scrollDown.hidden = !show;
    awayBadge.hidden = !awayCount;
    awayBadge.textContent = awayCount > 99 ? '99+' : String(awayCount);
  }

  function daySeparator(message) {
    const key = dayKey(message.createdAt);
    const label = dayLabel(message.createdAt);
    let node = days.get(key);
    if (!node) { node = document.createElement('div'); node.className = 'day-separator'; days.set(key, node); }
    if (node.textContent !== label) node.innerHTML = `<span>${escapeHtml(label)}</span>`;
    return node;
  }

  function sameGroup(a, b) {
    if (!a || !b) return false;
    if (a.sender.id !== b.sender.id || dayKey(a.createdAt) !== dayKey(b.createdAt)) return false;
    return Math.abs((parseTime(b.createdAt) || 0) - (parseTime(a.createdAt) || 0)) < GROUP_WINDOW_MS;
  }

  function draw({ forceBottom = false } = {}) {
    if (destroyed) return;
    const store = messageStore(id);
    if (!store.loaded) return;
    const conversation = conversationById(id);
    const isGroup = conversation?.kind === 'group';
    const items = store.items;

    if (!items.length) {
      rows.clear();
      list.innerHTML = `<div class="chat-empty">${emptyState('chat', t('No messages here yet'), t('Say hello — or hold the microphone to send a voice message.'))}</div>`;
      return;
    }
    if (list.querySelector('.chat-empty, .bubble-skeleton')) list.innerHTML = '';

    const wasNearBottom = isNearBottom();
    const previousHeight = scroller.scrollHeight;
    const previousTop = scroller.scrollTop;
    const previousFirst = list.querySelector('.message-row')?.dataset.key;
    const previousLastKey = [...rows.keys()].at(-1);

    const nodes = [];
    if (store.nextCursor) nodes.push(topSentinel);
    let dividerPlaced = false;
    let previousDay = null;
    const seen = new Set();
    items.forEach((message, index) => {
      const day = dayKey(message.createdAt);
      if (day !== previousDay) { nodes.push(daySeparator(message)); previousDay = day; }
      const previous = items[index - 1];
      const next = items[index + 1];
      const groupStart = !sameGroup(previous, message);
      const groupEnd = !sameGroup(message, next);
      const unreadDivider = !dividerPlaced && unreadAnchor !== null && message.id > unreadAnchor && !message.isMine;
      if (unreadDivider) dividerPlaced = true;
      const sender = memberById(message.sender.id) || message.sender;
      const layout = {
        viewerId: state.user?.id, isGroup, groupStart, groupEnd, unreadDivider, selecting, selected: selected.has(message.id),
        showSender: isGroup && !message.isMine && groupStart && message.kind !== 'sticker',
        showAvatar: isGroup && !message.isMine && groupEnd,
        avatarHtml: `<button type="button" class="avatar-button" data-profile="${sender.id}" aria-label="${escapeHtml(sender.displayName)}">${avatar(sender, 'sm')}</button>`
      };
      const key = messageKey(message);
      seen.add(key);
      const signature = messageSignature(message, layout);
      let row = rows.get(key);
      if (!row && message.id && message.clientId) {
        const pendingKey = `c${message.clientId}`;
        if (rows.has(pendingKey)) { row = rows.get(pendingKey); rows.delete(pendingKey); }
      }
      if (!row || row.signature !== signature) {
        const element = document.createElement('div');
        element.className = `message-row${!row && !firstDraw ? ' appear' : ''}`;
        element.dataset.key = key;
        element.innerHTML = messageMarkup(message, layout);
        element.querySelectorAll('[data-voice]').forEach(voice => paintVoice(voice));
        row = { element, signature };
      }
      rows.set(key, row);
      nodes.push(row.element);
    });
    if (store.hasNewer) nodes.push(bottomSentinel);
    for (const key of [...rows.keys()]) if (!seen.has(key)) rows.delete(key);

    const current = [...list.children];
    if (current.length !== nodes.length || current.some((node, index) => node !== nodes[index])) list.replaceChildren(...nodes);

    const newFirst = list.querySelector('.message-row')?.dataset.key;
    const newLastKey = [...rows.keys()].at(-1);
    if (firstDraw) return;
    if (previousFirst && newFirst !== previousFirst && rows.has(previousFirst) && !forceBottom) {
      // Older history was prepended above: keep the visible messages exactly where they were.
      scroller.scrollTop = previousTop + (scroller.scrollHeight - previousHeight);
    } else if (forceBottom || (wasNearBottom && !store.hasNewer)) {
      scrollToBottom(!forceBottom && newLastKey !== previousLastKey);
    } else if (newLastKey !== previousLastKey && previousLastKey) {
      const last = items.at(-1);
      if (last && !last.isMine) awayCount += 1;
    }
    updateScrollButton();
    scheduleRead();
  }

  function highlight(element) {
    if (!element) return;
    element.classList.remove('highlight');
    void element.offsetWidth;
    element.classList.add('highlight');
  }

  async function jumpTo(messageId) {
    let row = list.querySelector(`.message-row[data-key="m${messageId}"]`);
    if (!row) {
      try { await loadAround(id, messageId); } catch (error) { return toast(error.message, 'error'); }
      draw();
      row = list.querySelector(`.message-row[data-key="m${messageId}"]`);
    }
    if (!row) return toast(t('That message is no longer available.'), 'error');
    row.scrollIntoView({ block: 'center', behavior: document.documentElement.dataset.motion === 'off' ? 'auto' : 'smooth' });
    highlight(row.querySelector('.message'));
    updateScrollButton();
  }

  /* ------------------------------ read state ------------------------------ */

  let readTimer = null;
  function scheduleRead() {
    clearTimeout(readTimer);
    readTimer = setTimeout(markVisibleRead, 350);
  }

  function markVisibleRead() {
    if (destroyed || !active || document.visibilityState !== 'visible') return;
    const store = messageStore(id);
    const bottom = scroller.scrollTop + scroller.clientHeight;
    let target = 0;
    for (const message of store.items) {
      if (!message.id || message.isMine) continue;
      const row = rows.get(`m${message.id}`)?.element;
      if (row && row.offsetTop < bottom) target = Math.max(target, message.id);
    }
    const conversation = conversationById(id);
    const lastRead = Math.max(lastReadSent, conversation?.lastReadMessageId || 0);
    if (!target || target <= lastRead) {
      if (isNearBottom() && !store.hasNewer) {
        if (conversation?.markedUnread) request(`/api/conversations/${id}/settings`, { method: 'POST', body: { markedUnread: false } }).catch(() => {});
        markConversationRead(id);
        if (trimHistory(id)) draw();
      }
      return;
    }
    lastReadSent = target;
    if (conversation) conversation.lastReadMessageId = target;
    request(`/api/conversations/${id}/read`, { method: 'POST', body: { messageId: target } })
      .then(result => patchConversation(id, { unread: result.unread, markedUnread: false }))
      .catch(() => { lastReadSent = 0; });
  }

  /* -------------------------------- sending -------------------------------- */

  function replySummary() {
    return replyTo ? { id: replyTo.id, body: replyTo.body, kind: replyTo.kind, deleted: false, sender: { id: replyTo.sender.id, displayName: replyTo.sender.displayName } } : null;
  }

  function pendingMessage(fields) {
    return {
      id: null, clientId: newClientId(), localSeq: ++localSeq, conversationId: id, body: '', media: null, sticker: null, linkPreview: null,
      replyTo: replySummary(), forwardedFrom: null, sender: state.user, reactions: [], readBy: [], isMine: true,
      editedAt: null, deletedAt: null, createdAt: new Date(now()).toISOString(), ...fields
    };
  }

  /**
   * Optimistic send: the message appears immediately; `perform` does the network work. The same
   * clientId is reused for every retry, so the server can only ever store the message once.
   */
  function sendOptimistic(pending, perform) {
    const attempt = async () => {
      patchPendingMessage(id, pending.clientId, { failed: false });
      try {
        const message = await perform(pending.clientId);
        if (pending.media && message.media && String(pending.media.id).startsWith('local-')) renameMedia(pending.media.id, message.media.id);
        upsertMessage(id, message);
        retries.delete(pending.clientId);
      } catch (error) {
        if (destroyed) return;
        patchPendingMessage(id, pending.clientId, { failed: true });
        toast(error.message, 'error');
      }
    };
    retries.set(pending.clientId, attempt);
    upsertMessage(id, pending);
    clearContext();
    draw({ forceBottom: true });
    if (settings().notifications.sound) playSentSound();
    return attempt();
  }

  const post = (clientId, body) => request(`/api/conversations/${id}/messages`, { method: 'POST', body: { ...body, clientId } }).then(result => result.message);

  function sendText(text) {
    const replyToId = replyTo?.id || null;
    const pending = pendingMessage({ kind: 'text', body: text });
    return sendOptimistic(pending, clientId => post(clientId, { kind: 'text', body: text, replyToId }));
  }

  function sendSticker(sticker) {
    const replyToId = replyTo?.id || null;
    const pending = pendingMessage({ kind: 'sticker', sticker: { id: sticker.id, name: sticker.name || t('Sticker'), url: sticker.url || `/api/stickers/${sticker.id}/file` } });
    return sendOptimistic(pending, clientId => post(clientId, { kind: 'sticker', stickerId: sticker.id, replyToId }));
  }

  async function sendAttachment(file, { caption = '', asFile = false } = {}) {
    const replyToId = replyTo?.id || null;
    const visual = !asFile && /^(image|video)\//.test(file.type);
    const kind = !visual ? 'file' : file.type.startsWith('video/') ? 'video' : 'image';
    const localUrl = URL.createObjectURL(file);
    const pending = pendingMessage({ kind, body: caption, localUrl, media: { id: `local-${Date.now()}-${localSeq}`, url: localUrl, mimeType: file.type, name: file.name, size: file.size } });
    let mediaId = null;
    return sendOptimistic(pending, async clientId => {
      if (!mediaId) {
        let prepared = { file };
        if (kind === 'image') prepared = await preparePhoto(file);
        if (kind === 'video') prepared = await prepareVideo(file);
        const purpose = kind === 'file' ? 'file' : 'chat';
        mediaId = (await upload(prepared.file, purpose, prepared)).media.id;
      }
      return post(clientId, { kind, mediaId, body: caption, replyToId });
    });
  }

  function sendVoice(recording) {
    const replyToId = replyTo?.id || null;
    const localUrl = URL.createObjectURL(recording.blob);
    const pending = pendingMessage({ kind: 'voice', localUrl });
    pending.media = { id: `local-${pending.clientId}`, url: localUrl, mimeType: recording.type, durationMs: recording.durationMs, waveform: recording.waveform };
    let mediaId = null;
    return sendOptimistic(pending, async clientId => {
      if (!mediaId) {
        const file = new File([recording.blob], `voice-${Date.now()}`, { type: recording.type });
        mediaId = (await upload(file, 'voice', { durationMs: recording.durationMs })).media.id;
      }
      return post(clientId, { kind: 'voice', mediaId, durationMs: recording.durationMs, waveform: recording.waveform, replyToId });
    });
  }

  function sendTyping(typing, kind = 'text') {
    if (!settings().chat.typingIndicators) return;
    request(`/api/conversations/${id}/typing`, { method: 'POST', body: { typing, kind } }).catch(() => {});
  }

  function noteTyping() {
    const moment = Date.now();
    if (moment - typingSentAt > 3000) { typingSentAt = moment; sendTyping(true); }
    clearTimeout(typingStopTimer);
    typingStopTimer = setTimeout(() => { typingSentAt = 0; sendTyping(false); }, 3500);
  }

  function stopTyping() {
    if (!typingSentAt) return;
    clearTimeout(typingStopTimer);
    typingSentAt = 0;
    sendTyping(false);
  }

  /* ------------------------------ composer ------------------------------ */

  function syncComposer() {
    const hasText = Boolean(input.value.trim());
    form.classList.toggle('has-text', hasText || Boolean(editing));
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 150)}px`;
  }

  function showContext(kind, message) {
    const label = kind === 'edit' ? t('Edit message') : t('Reply to {name}', { name: message.isMine ? t('yourself') : message.sender.displayName });
    contextBar.hidden = false;
    contextBar.innerHTML = `<span class="context-icon">${icon(kind === 'edit' ? 'edit' : 'reply', 21)}</span>
      <button type="button" class="context-main" data-jump="${message.id}"><strong>${escapeHtml(label)}</strong><small>${previewIcon(message)}${escapeHtml(previewText(message) || t('Message'))}</small></button>
      <button type="button" class="icon-button" data-action="cancel-context" aria-label="${t('Cancel')}">${icon('close', 20)}</button>`;
  }

  function clearContext() {
    const wasEditing = Boolean(editing);
    replyTo = null;
    editing = null;
    contextBar.hidden = true;
    contextBar.innerHTML = '';
    if (wasEditing) { input.value = getDraft(id); syncComposer(); }
  }

  function focusInput() { closeEmoji(); input.focus({ preventScroll: true }); }

  function startReply(message) {
    if (editing) clearContext();
    replyTo = message;
    showContext('reply', message);
    focusInput();
  }

  function startEdit(message) {
    replyTo = null;
    editing = message;
    showContext('edit', message);
    input.value = message.body;
    syncComposer();
    focusInput();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  let draftTimer = null;
  input.addEventListener('input', () => {
    syncComposer();
    if (!editing) {
      clearTimeout(draftTimer);
      draftTimer = setTimeout(() => setDraft(id, input.value), 300);
      if (input.value.trim()) noteTyping(); else stopTyping();
    }
  });

  input.addEventListener('focus', () => closeEmoji());
  input.addEventListener('keydown', event => {
    const enterSends = settings().chat.enterToSend || window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && enterSends) {
      event.preventDefault();
      form.requestSubmit();
    }
    if (event.key === 'Escape' && (replyTo || editing)) clearContext();
    if (event.key === 'ArrowUp' && !input.value) {
      const last = [...messageStore(id).items].reverse().find(message => message.isMine && message.id && message.kind === 'text');
      if (last) { event.preventDefault(); startEdit(last); }
    }
  });

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    if (editing) {
      const target = editing;
      clearContext();
      if (text === target.body) return;
      try {
        const { message } = await request(`/api/messages/${target.id}`, { method: 'PATCH', body: { body: text } });
        upsertMessage(id, message);
      } catch (error) { toast(error.message, 'error'); }
      return;
    }
    input.value = '';
    setDraft(id, '');
    syncComposer();
    stopTyping();
    // Keep the keyboard open between messages, as a messenger should.
    if (document.activeElement === input || !emojiPanel) input.focus({ preventScroll: true });
    sendText(text);
  });

  /* -------------------------- emoji & sticker panel -------------------------- */

  function insertAtCursor(text) {
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? input.value.length;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    const caret = start + text.length;
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event('input'));
  }

  function openEmoji() {
    if (emojiPanel) return;
    emojiPanel = createEmojiPanel({ onEmoji: insertAtCursor, onSticker: sticker => { sendSticker(sticker); } });
    emojiPanel.element.style.height = `${Math.max(240, Math.min(keyboardHeight, window.innerHeight * 0.5))}px`;
    emojiHost.append(emojiPanel.element);
    page.classList.add('emoji-open');
    host.querySelector('[data-action="emoji"]').innerHTML = icon('keyboard', 25);
    input.blur();
    emojiOverlay = openOverlay(() => closeEmoji({ fromHistory: true }));
    if (stickToBottom) requestAnimationFrame(() => scrollToBottom());
  }

  function closeEmoji({ fromHistory = false } = {}) {
    if (!emojiPanel) return;
    emojiPanel.destroy();
    emojiPanel = null;
    page.classList.remove('emoji-open');
    host.querySelector('[data-action="emoji"]').innerHTML = icon('smile', 25);
    if (!fromHistory) closeOverlay(emojiOverlay);
    emojiOverlay = null;
  }

  /* ------------------------------- voice ------------------------------- */

  const voice = createVoiceComposer({
    micButton: host.querySelector('[data-action="voice"]'),
    wrap: composerWrap,
    onSend: recording => sendVoice(recording),
    onRecordingChange: recording => { sendTyping(recording, 'voice'); if (recording) closeEmoji(); }
  });
  cleanups.push(() => voice.destroy());

  // Consecutive voice messages play one after another, like listening to a voice thread.
  cleanups.push(onEnded(finishedId => {
    if (!settings().chat.autoplayVoice || destroyed || !active) return;
    const items = messageStore(id).items;
    const index = items.findIndex(message => message.media?.id === finishedId);
    const next = index >= 0 ? items.slice(index + 1).find(message => message.kind === 'voice' && message.media) : null;
    if (!next || next.isMine) return;
    togglePlayback({ id: next.media.id, url: next.localUrl || next.media.url, durationMs: next.media.durationMs, title: next.sender.displayName });
  }));

  /* ----------------------------- search in chat ----------------------------- */

  let searchTimer = null;
  function openSearch() {
    if (searchOverlay) return;
    page.classList.add('mode-search');
    searchOverlay = openOverlay(() => closeSearch({ fromHistory: true }));
    setTimeout(() => searchInput.focus(), 60);
  }
  function closeSearch({ fromHistory = false } = {}) {
    if (!searchOverlay) return;
    page.classList.remove('mode-search');
    if (!fromHistory) closeOverlay(searchOverlay);
    searchOverlay = null;
    searchInput.value = '';
    searchResults = [];
    searchIndex = -1;
    updateSearchCount();
    list.querySelectorAll('.search-hit').forEach(node => node.classList.remove('search-hit'));
  }
  function updateSearchCount() {
    host.querySelector('[data-search-count]').textContent = searchResults.length ? t('{index} of {total}', { index: searchIndex + 1, total: searchResults.length }) : searchInput.value.trim().length > 1 ? t('No results') : '';
  }
  async function runSearch() {
    const query = searchInput.value.trim();
    if (query.length < 2) { searchResults = []; searchIndex = -1; return updateSearchCount(); }
    try {
      const result = await request(`/api/search?q=${encodeURIComponent(query)}&conversationId=${id}`);
      if (query !== searchInput.value.trim()) return;
      searchResults = result.messages.map(message => message.id);
      searchIndex = searchResults.length ? 0 : -1;
      updateSearchCount();
      if (searchResults.length) showSearchHit();
    } catch (error) { toast(error.message, 'error'); }
  }
  async function showSearchHit() {
    const messageId = searchResults[searchIndex];
    if (!messageId) return;
    await jumpTo(messageId);
    list.querySelectorAll('.search-hit').forEach(node => node.classList.remove('search-hit'));
    list.querySelector(`.message-row[data-key="m${messageId}"] .message`)?.classList.add('search-hit');
  }
  searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 300); });
  searchInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); runSearch(); searchInput.blur(); } });

  /* ------------------------------ selection ------------------------------ */

  function enterSelection(message) {
    if (!message?.id) return;
    if (!selecting) {
      selecting = true;
      page.classList.add('mode-select');
      closeEmoji();
      input.blur();
      selectionOverlay = openOverlay(() => exitSelection({ fromHistory: true }));
    }
    selected.add(message.id);
    navigator.vibrate?.(8);
    updateSelection();
  }
  function exitSelection({ fromHistory = false } = {}) {
    if (!selecting) return;
    selecting = false;
    selected.clear();
    page.classList.remove('mode-select');
    if (!fromHistory) closeOverlay(selectionOverlay);
    selectionOverlay = null;
    drawBlocked(conversationById(id) || {});
    draw();
  }
  function toggleSelected(message) {
    if (!message?.id) return;
    if (selected.has(message.id)) selected.delete(message.id); else selected.add(message.id);
    if (!selected.size) return exitSelection();
    updateSelection();
  }
  function selectedMessages() {
    return messageStore(id).items.filter(message => message.id && selected.has(message.id));
  }
  function updateSelection() {
    const items = selectedMessages();
    host.querySelector('[data-select-count]').textContent = tn(items.length, '{n} selected', '{n} selected');
    host.querySelector('[data-action="select-copy"]').hidden = !items.some(message => message.body);
    host.querySelector('[data-action="select-pin"]').hidden = items.length !== 1;
    host.querySelector('[data-action="select-share"]').hidden = !navigator.share || !items.some(message => message.body);
    draw();
  }
  function selectionText(items) {
    const isGroup = conversationById(id)?.kind === 'group';
    return items.map(message => (isGroup || items.length > 1 ? `${message.sender.displayName}: ` : '') + (message.body || previewText(message))).join('\n');
  }

  /* -------------------------------- actions -------------------------------- */

  function findMessage(element) {
    const row = element.closest('.message-row');
    if (!row) return null;
    const key = row.dataset.key;
    return messageStore(id).items.find(message => messageKey(message) === key) || null;
  }

  async function react(message, reaction) {
    try {
      const { message: updated } = await request(`/api/messages/${message.id}/reaction`, { method: 'POST', body: { reaction } });
      upsertMessage(id, updated);
    } catch (error) { toast(error.message, 'error'); }
  }

  async function deleteMessages(messages) {
    const conversation = conversationById(id);
    const allMine = messages.every(message => message.isMine);
    const others = conversation?.kind === 'group' ? t('everyone') : otherMember(conversation)?.displayName || t('everyone');
    const choice = await actionSheet({
      title: messages.length === 1 ? t('Delete message?') : tn(messages.length, 'Delete {n} message?', 'Delete {n} messages?'),
      header: `<p class="sheet-text">${allMine ? t('“Delete for everyone” also removes it for {name}.', { name: escapeHtml(others) }) : t('This removes the messages from your chat history only.')}</p>`,
      actions: [
        allMine && { id: 'everyone', label: t('Delete for everyone'), icon: 'trash', danger: true },
        { id: 'me', label: t('Delete for me'), icon: 'trash', danger: !allMine },
        { id: 'cancel', label: t('Cancel') }
      ].filter(Boolean)
    });
    if (choice !== 'everyone' && choice !== 'me') return false;
    // Remove immediately (animated); restore if the server refuses.
    for (const message of messages) {
      const row = list.querySelector(`.message-row[data-key="m${message.id}"]`);
      row?.classList.add('removing');
    }
    await new Promise(resolve => setTimeout(resolve, document.documentElement.dataset.motion === 'off' ? 0 : 180));
    for (const message of messages) removeMessage(id, message.id);
    try {
      if (messages.length === 1) await request(`/api/messages/${messages[0].id}?scope=${choice}`, { method: 'DELETE' });
      else await request(`/api/conversations/${id}/messages/delete`, { method: 'POST', body: { messageIds: messages.map(message => message.id), scope: choice } });
    } catch (error) { for (const message of messages) upsertMessage(id, message); toast(error.message, 'error'); }
    return true;
  }

  async function togglePin(message) {
    const conversation = conversationById(id);
    const unpin = !message || conversation?.pinnedMessage?.id === message.id;
    try {
      const { pinnedMessage } = await request(`/api/conversations/${id}/pin`, { method: 'POST', body: { messageId: unpin ? null : message.id } });
      patchConversation(id, { pinnedMessage });
      toast(unpin ? t('Message unpinned') : t('Message pinned'));
    } catch (error) { toast(error.message, 'error'); }
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast(t('Copied')); } catch { toast(t('Copy is not available here'), 'error'); }
  }

  function openMenu(message, element) {
    if (!message) return;
    if (!message.id) { if (message.failed) retries.get(message.clientId)?.(); return; }
    if (selecting) return toggleSelected(message);
    const conversation = conversationById(id);
    const mine = message.isMine;
    const readers = mine && conversation?.kind === 'group' ? message.readBy || [] : null;
    const header = readers ? `<p class="focus-seen">${icon(readers.length ? 'checks' : 'check', 15)} ${readers.length ? escapeHtml(t('Seen by {names}', { names: readers.map(reader => reader.displayName).join(', ') })) : t('Not seen yet')}</p>` : '';
    const canMessage = !(conversation?.blocked?.byMe || conversation?.blocked?.byThem);
    const actions = [
      canMessage && { id: 'reply', label: t('Reply'), icon: 'reply' },
      message.body && { id: 'copy', label: t('Copy'), icon: 'copy' },
      mine && ['text', 'image', 'video', 'file'].includes(message.kind) && (message.kind === 'text' || message.body) && { id: 'edit', label: t('Edit'), icon: 'edit' },
      { id: 'pin', label: conversation?.pinnedMessage?.id === message.id ? t('Unpin') : t('Pin'), icon: 'pin' },
      { id: 'forward', label: t('Forward'), icon: 'forward' },
      message.media && message.kind !== 'voice' && { id: 'download', label: t('Save to device'), icon: 'install' },
      { id: 'select', label: t('Select'), icon: 'select' },
      { id: 'delete', label: t('Delete'), icon: 'trash', danger: true }
    ].filter(Boolean);
    openMessageFocus({
      row: element.closest('.message'), message, header, actions,
      myReaction: message.reactions?.find(item => item.user.id === state.user?.id)?.reaction || null,
      onReact: reaction => react(message, reaction),
      onAction: action => {
        if (action === 'reply') startReply(message);
        if (action === 'edit') startEdit(message);
        if (action === 'forward') openForwardPicker([message]);
        if (action === 'pin') togglePin(message);
        if (action === 'delete') deleteMessages([message]);
        if (action === 'copy') copy(message.body);
        if (action === 'select') enterSelection(message);
        if (action === 'download' && message.media) {
          const link = document.createElement('a');
          link.href = `${message.media.url}?download=1`;
          link.download = message.media.name || '';
          link.click();
        }
      }
    });
  }

  function openImage(src) {
    const viewer = modal(`<img class="lightbox-image" src="${escapeHtml(src)}" alt="${t('Photo')}"><button class="icon-button lightbox-close" data-close-modal aria-label="${t('Close')}">${icon('close', 24)}</button>`, 'lightbox');
    viewer.querySelector('.lightbox-image').addEventListener('click', () => viewer.close());
  }

  async function openMore() {
    const conversation = conversationById(id);
    if (!conversation) return;
    const choice = await actionSheet({
      actions: [
        { id: 'info', label: conversation.kind === 'group' ? t('Group info') : t('View profile'), icon: conversation.kind === 'group' ? 'users' : 'user' },
        { id: 'search', label: t('Search'), icon: 'search' },
        { id: 'mute', label: conversation.muted ? t('Unmute') : t('Mute'), icon: conversation.muted ? 'bell' : 'mute' },
        { id: 'wallpaper', label: t('Change wallpaper'), icon: 'wallpaper' },
        { id: 'archive', label: conversation.archived ? t('Unarchive') : t('Archive'), icon: conversation.archived ? 'unarchive' : 'archive' },
        { id: 'delete', label: conversation.kind === 'group' && !conversation.isMainGroup ? t('Leave group') : t('Delete chat'), icon: 'trash', danger: true }
      ]
    });
    if (choice === 'info') navigate(`/chat/${id}/info`);
    if (choice === 'search') openSearch();
    if (choice === 'wallpaper') navigate('/settings/background');
    if (['mute', 'archive', 'delete'].includes(choice)) {
      const { runChatAction } = await import('./chats.js');
      await runChatAction(id, choice === 'archive' && conversation.archived ? 'unarchive' : choice);
      if (choice === 'delete' && !conversationById(id)) goBack('/');
    }
  }

  // In selection mode a tap anywhere on a message toggles it (captured before any other handler).
  list.addEventListener('click', event => {
    if (!selecting) return;
    const message = findMessage(event.target);
    if (!message) return;
    event.preventDefault();
    event.stopPropagation();
    toggleSelected(message);
  }, true);

  host.addEventListener('click', async event => {
    const jump = event.target.closest('[data-jump]');
    if (jump && jump.dataset.jump) { event.preventDefault(); return jumpTo(Number(jump.dataset.jump)); }
    const internal = event.target.closest('[data-internal-link]');
    if (internal) { event.preventDefault(); return navigate(internal.getAttribute('href')); }
    const mention = event.target.closest('[data-mention]');
    if (mention) {
      const member = state.members.find(item => item.username.toLowerCase() === mention.dataset.mention);
      if (member) return navigate(`/profile/${member.id}`);
    }
    const profile = event.target.closest('[data-profile]');
    if (profile) return navigate(`/profile/${profile.dataset.profile}`);
    const reaction = event.target.closest('[data-toggle-reaction]');
    if (reaction) {
      const message = findMessage(reaction);
      const mine = message?.reactions.find(item => item.user.id === state.user?.id)?.reaction;
      if (message?.id) react(message, mine === reaction.dataset.toggleReaction ? '' : reaction.dataset.toggleReaction);
      return;
    }
    const retry = event.target.closest('[data-retry]');
    if (retry) return retries.get(retry.dataset.retry)?.();
    const load = event.target.closest('[data-load-media]');
    if (load) {
      event.preventDefault();
      event.stopPropagation();
      const message = findMessage(load);
      if (!message?.media) return;
      const box = load.closest('.media-box');
      box.innerHTML = message.kind === 'video'
        ? `<video class="message-media" src="${escapeHtml(message.media.url)}" controls playsinline autoplay></video>`
        : `<img class="message-media" src="${escapeHtml(message.media.url)}" alt="${t('Photo')}" decoding="async">`;
      return;
    }
    const image = event.target.closest('[data-open-media]');
    if (image) {
      const img = image.querySelector('img');
      if (img) return openImage(img.currentSrc || img.src);
      return;
    }

    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;
    const action = trigger.dataset.action;
    try {
      if (action === 'back') return goBack('/');
      if (action === 'info') return navigate(`/chat/${id}/info`);
      if (action === 'more') return openMore();
      if (action === 'search') return openSearch();
      if (action === 'close-search') return closeSearch();
      if (action === 'search-up' && searchResults.length) { searchIndex = Math.min(searchResults.length - 1, searchIndex + 1); updateSearchCount(); return showSearchHit(); }
      if (action === 'search-down' && searchResults.length) { searchIndex = Math.max(0, searchIndex - 1); updateSearchCount(); return showSearchHit(); }
      if (action === 'cancel-context') return clearContext();
      if (action === 'unpin') return togglePin(null);
      if (action === 'unblock') {
        const other = otherMember(conversationById(id));
        await request(`/api/blocks/${other.id}`, { method: 'DELETE' });
        const { conversation } = await request(`/api/conversations/${id}`);
        patchConversation(id, conversation);
        return toast(t('Member unblocked'));
      }
      if (action === 'scroll-bottom') {
        if (messageStore(id).hasNewer) { await loadMessages(id); draw(); }
        unreadAnchor = null;
        return scrollToBottom(true);
      }
      if (action === 'emoji') return emojiPanel ? focusInput() : openEmoji();
      if (action === 'attach') {
        closeEmoji();
        const { files, asFiles } = await openAttachMenu();
        if (!files.length) return;
        const result = await openAttachPreview(files, { asFiles });
        if (!result) return;
        if (result.items.reduce((sum, file) => sum + file.size, 0) > 50 * 1024 * 1024) return toast(t('Choose files totaling 50 MB or less.'), 'error');
        // Serialize preparation/upload/send: ten 25 MB files must never become ten full in-memory
        // server buffers at once. Each item still appears optimistically as its turn begins.
        for (let index = 0; index < result.items.length; index += 1) {
          await sendAttachment(result.items[index], { caption: index === 0 ? result.caption : '', asFile: result.asFiles });
        }
      }
      if (action === 'close-select') return exitSelection();
      if (action === 'select-copy') { await copy(selectionText(selectedMessages().filter(message => message.body))); return exitSelection(); }
      if (action === 'select-share') {
        try { await navigator.share({ text: selectionText(selectedMessages()) }); } catch { /* share sheet dismissed */ }
        return exitSelection();
      }
      if (action === 'select-pin') { const [message] = selectedMessages(); if (message) await togglePin(message); return exitSelection(); }
      if (action === 'select-forward') { const items = selectedMessages(); exitSelection(); return openForwardPicker(items); }
      if (action === 'select-delete') { const items = selectedMessages(); if (await deleteMessages(items)) exitSelection(); }
    } catch (error) { toast(error.message, 'error'); }
  });

  // Double-tap a bubble for a quick ❤️, like native messengers.
  list.addEventListener('dblclick', event => {
    if (selecting || event.target.closest('button, a, video, [data-voice], .message-text')) return;
    const message = findMessage(event.target);
    if (!message?.id) return;
    const mine = message.reactions.find(item => item.user.id === state.user?.id)?.reaction;
    react(message, mine === '❤️' ? '' : '❤️');
  });

  cleanups.push(onLongPress(list, '.message-bubble, .sticker', element => openMenu(findMessage(element), element)));
  cleanups.push(onSwipeLeft(list, '.message', element => { if (selecting) return; const message = findMessage(element); if (message?.id) startReply(message); }));
  cleanups.push(bindVoice(list));

  /* --------------------------- scrolling & viewport --------------------------- */

  const loadOlder = async () => {
    const store = messageStore(id);
    if (!store.nextCursor || store.loading) return;
    await loadMessages(id, { more: true }).catch(error => toast(error.message, 'error'));
    // A short page may leave the sentinel in range, and the observer only fires on changes.
    requestAnimationFrame(() => {
      if (!destroyed && topSentinel.isConnected && topSentinel.getBoundingClientRect().bottom > scroller.getBoundingClientRect().top - 600) loadOlder();
    });
  };
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      if (entry.target === topSentinel) loadOlder();
      if (entry.target === bottomSentinel) loadNewer(id).catch(() => {});
    }
  }, { root: scroller, rootMargin: '600px 0px' });
  observer.observe(topSentinel);
  observer.observe(bottomSentinel);

  let scrollFrame = 0;
  scroller.addEventListener('scroll', () => {
    cancelAnimationFrame(scrollFrame);
    scrollFrame = requestAnimationFrame(() => {
      stickToBottom = isNearBottom();
      if (stickToBottom) awayCount = 0;
      updateScrollButton();
      scheduleRead();
    });
  }, { passive: true });

  // Images and videos that finish loading must not push the latest message out of view.
  list.addEventListener('load', event => {
    if (event.target.classList?.contains('message-media')) event.target.classList.add('loaded');
    if (stickToBottom) scrollToBottom();
  }, true);
  list.addEventListener('loadedmetadata', () => { if (stickToBottom) scrollToBottom(); }, true);

  // Keep the composer glued above the on-screen keyboard (iOS resizes only the visual viewport).
  const viewport = window.visualViewport;
  const fitViewport = () => {
    if (!viewport || !active) return;
    const keepBottom = stickToBottom;
    const keyboard = window.innerHeight - viewport.height;
    if (keyboard > 150 && document.activeElement === input) {
      keyboardHeight = keyboard;
      try { localStorage.setItem('circle-keyboard-height', String(Math.round(keyboard))); } catch { /* ignore */ }
    }
    const height = Math.min(viewport.height, window.innerHeight);
    const offset = Math.min(viewport.offsetTop || 0, Math.max(0, window.innerHeight - height));
    page.style.setProperty('height', `${height}px`, 'important');
    page.style.transform = offset ? `translateY(${offset}px)` : '';
    if (keepBottom) scrollToBottom();
  };
  if (viewport) {
    viewport.addEventListener('resize', fitViewport);
    viewport.addEventListener('scroll', fitViewport);
    cleanups.push(() => { viewport.removeEventListener('resize', fitViewport); viewport.removeEventListener('scroll', fitViewport); });
    fitViewport();
  }

  const onVisibility = () => {
    if (document.visibilityState === 'visible') { refreshRelativeTimes(list); scheduleRead(); }
    else { stopTyping(); voice.cancel(); }
  };
  document.addEventListener('visibilitychange', onVisibility);
  cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));

  // Another screen was pushed on top (profile, media) or it was popped back into view.
  screen.onHide(() => { setActive(false); stopTyping(); closeEmoji(); voice.cancel(); });
  screen.onShow(() => { setActive(true); drawHeader(); scheduleRead(); fitViewport(); });

  /* ------------------------------ subscriptions ------------------------------ */

  cleanups.push(subscribe((event, payload) => {
    const mine = payload === id || payload?.conversationId === id;
    if ((event === 'messages' || event === 'message') && mine) draw({ forceBottom: event === 'message' && payload.created && payload.message.isMine && !payload.message.id });
    if (['conversations', 'presence', 'members', 'typing'].includes(event)) drawHeader();
    if (event === 'reset') navigate('/', { replace: true });
  }));

  /* -------------------------------- first load -------------------------------- */

  (async () => {
    try {
      if (!state.conversations.loaded) await loadConversations();
      if (!conversationById(id)) {
        // Not in the cached list yet (e.g. a chat created on another device): ask the server directly.
        const { conversation } = await request(`/api/conversations/${id}`);
        state.conversations.items.push(conversation);
        publish('conversations');
      }
      loadMembers().catch(() => {});
      const conversation = conversationById(id);
      drawHeader();
      if (conversation.unread && conversation.lastReadMessageId) unreadAnchor = conversation.lastReadMessageId;
      const store = messageStore(id);
      if (jumpTarget) await loadAround(id, jumpTarget);
      else if (conversation.unread > 40 && unreadAnchor) await loadAround(id, unreadAnchor);
      else if (!store.loaded || store.hasNewer) await loadMessages(id);
      else loadMessages(id).catch(() => {}); // cached: show instantly, refresh quietly
      draw();
      firstDraw = false;
      const divider = list.querySelector('[data-unread-divider]');
      if (jumpTarget) jumpTo(jumpTarget);
      else if (divider) divider.scrollIntoView({ block: 'start' });
      else scrollToBottom();
      stickToBottom = isNearBottom();
      updateScrollButton();
      scheduleRead();
    } catch (error) {
      list.innerHTML = `<div class="chat-empty">${emptyState('lock', t('Conversation unavailable'), error.status === 403 ? t('You are not a member of this conversation.') : error.message,
        `<button class="button button-primary" data-action="back">${t('Back to chats')}</button>`)}</div>`;
    }
  })();

  return () => {
    destroyed = true;
    setActive(false);
    clearTimeout(readTimer);
    clearTimeout(draftTimer);
    clearTimeout(searchTimer);
    if (!editing) setDraft(id, input.value);
    stopTyping();
    closeEmoji();
    if (selecting) exitSelection();
    if (searchOverlay) closeSearch();
    stopAll();
    observer.disconnect();
    for (const cleanup of cleanups) cleanup();
    // Release optimistic previews; confirmed messages fall back to their server URLs.
    for (const message of messageStore(id).items) {
      if (message.localUrl) { URL.revokeObjectURL(message.localUrl); delete message.localUrl; }
    }
    for (const message of messageStore(id).items.filter(item => !item.id && !retries.has(item.clientId))) removePendingMessage(id, message.clientId);
  };
}
