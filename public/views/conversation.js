import { request, upload } from '../api.js';
import { icon } from '../icons.js';
import { goBack, navigate } from '../router.js';
import {
  conversationById, getDraft, loadAround, loadConversations, loadMembers, loadMessages, loadNewer, markConversationRead, memberById,
  messageKey, messageStore, patchConversation, patchPendingMessage, publish, removeMessage, removePendingMessage, setDraft, state, subscribe,
  typingUsers, upsertMessage
} from '../store.js';
import { actionSheet, avatar, emptyState, escapeHtml, modal, toast } from '../ui.js';
import { dayKey, dayLabel, lastSeenText, now, parseTime, refreshRelativeTimes, formatDuration } from '../lib/time.js';
import { renameMedia, stopAll } from '../lib/audio.js';
import { MAX_RECORDING_MS, recordingSupported, VoiceRecorder } from '../lib/recorder.js';
import { onLongPress, onSwipeLeft } from '../lib/gestures.js';
import { messageMarkup, messageSignature, previewIcon, previewText } from '../components/messages.js';
import { openForwardPicker, openMessageMenu } from '../components/messageMenu.js';
import { bindVoice, paintVoice } from '../components/voice.js';

const GROUP_WINDOW_MS = 5 * 60 * 1000;
let localSeq = 0;

function newClientId() {
  const random = crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `c${random}`.slice(0, 40);
}

export function renderConversation(host, { conversationId }) {
  const id = Number(conversationId);
  const jumpTarget = Number(new URLSearchParams(window.location.search).get('m')) || null;
  state.openConversationId = id;
  document.documentElement.classList.add('chat-open');

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
  let recordTimer = null;
  const rows = new Map();
  const days = new Map();
  const retries = new Map();     // clientId -> function that re-sends with the same clientId
  const recorder = new VoiceRecorder();
  const cleanups = [];

  host.innerHTML = `
    <div class="chat-page">
      <header class="chat-header">
        <button class="icon-button" data-action="back" aria-label="Back to chats">${icon('back', 24)}</button>
        <button class="chat-person" data-action="info" aria-label="Conversation details"></button>
        <button class="icon-button" data-action="info" aria-label="Conversation details">${icon('more', 22)}</button>
      </header>
      <div class="pinned-bar" data-pinned hidden></div>
      <div class="messages" data-messages>
        <div class="messages-inner" data-list>${bubbleSkeleton()}</div>
      </div>
      <button class="scroll-down" data-action="scroll-bottom" aria-label="Scroll to latest messages" hidden>${icon('down', 22)}<span class="scroll-badge" data-away hidden></span></button>
      <div class="composer-wrap">
        <div class="composer-context" data-context hidden></div>
        <form class="chat-composer" data-composer>
          <button class="icon-button" type="button" data-action="attach" aria-label="Attach photo or video">${icon('paperclip', 22)}</button>
          <div class="composer-field">
            <textarea class="chat-input" data-input rows="1" maxlength="4000" placeholder="Message" aria-label="Message" enterkeyhint="send"></textarea>
            <button class="icon-button composer-sticker" type="button" data-action="stickers" aria-label="Open stickers">${icon('smile', 22)}</button>
          </div>
          <button class="icon-button chat-voice" type="button" data-action="voice" aria-label="Record voice message">${icon('mic', 23)}</button>
          <button class="icon-button chat-send" type="submit" aria-label="Send message">${icon('send', 21)}</button>
        </form>
        <div class="recording-bar" data-recording hidden>
          <button class="icon-button" type="button" data-action="cancel-recording" aria-label="Cancel recording">${icon('trash', 21)}</button>
          <span class="recording-dot"></span><span class="recording-time" data-record-time>0:00</span>
          <span class="recording-level" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
          <span class="recording-hint">Recording…</span>
          <button class="icon-button chat-send recording-send" type="button" data-action="send-recording" aria-label="Send voice message">${icon('send', 21)}</button>
        </div>
      </div>
    </div>`;

  const page = host.querySelector('.chat-page');
  const scroller = host.querySelector('[data-messages]');
  const list = host.querySelector('[data-list]');
  const personHost = host.querySelector('.chat-person');
  const pinnedBar = host.querySelector('[data-pinned]');
  const contextBar = host.querySelector('[data-context]');
  const input = host.querySelector('[data-input]');
  const form = host.querySelector('[data-composer]');
  const scrollDown = host.querySelector('[data-action="scroll-bottom"]');
  const awayBadge = host.querySelector('[data-away]');
  const recordingBar = host.querySelector('[data-recording]');
  const topSentinel = document.createElement('div');
  topSentinel.className = 'history-sentinel';
  topSentinel.innerHTML = '<span class="spinner"></span>';
  const bottomSentinel = document.createElement('div');
  bottomSentinel.className = 'history-sentinel';
  bottomSentinel.innerHTML = '<span class="spinner"></span>';

  input.value = getDraft(id);
  syncComposer();

  /* ------------------------------- header ------------------------------- */

  function otherMember(conversation) {
    return conversation?.members.find(member => member.id !== state.user?.id);
  }

  function drawHeader() {
    const conversation = conversationById(id);
    if (!conversation) return;
    const other = otherMember(conversation);
    const live = conversation.kind === 'direct' ? (memberById(other?.id) || other) : null;
    const typing = typingUsers(id);
    let subtitle;
    if (typing.length) {
      const verb = typing.some(item => item.kind === 'voice') ? 'recording a voice message' : 'typing';
      subtitle = conversation.kind === 'group' ? `${typing.map(item => item.user.displayName.split(' ')[0]).join(', ')} ${typing.length > 1 ? 'are' : 'is'} ${verb}…` : `${verb}…`;
    } else if (conversation.kind === 'group') {
      const online = conversation.members.filter(member => member.id !== state.user?.id && (memberById(member.id) || member).online).length;
      subtitle = `${conversation.members.length} members${online ? `, ${online} online` : ''}`;
    } else subtitle = lastSeenText(live);
    personHost.innerHTML = `
      <span class="avatar-wrap${live?.online ? ' is-online' : ''}">${conversation.kind === 'group' ? `<span class="avatar avatar-sm avatar-group">${icon('users', 18)}</span>` : avatar(live, 'sm')}</span>
      <span class="chat-person-text"><strong>${escapeHtml(conversation.title || 'Conversation')}</strong>
      <small data-typing class="${typing.length ? 'is-typing' : ''}${live?.online ? ' is-online' : ''}">${escapeHtml(subtitle)}</small></span>`;
    drawPinned(conversation);
  }

  function drawPinned(conversation) {
    const pinned = conversation.pinnedMessage;
    pinnedBar.hidden = !pinned;
    if (!pinned) return;
    pinnedBar.innerHTML = `<button type="button" class="pinned-main" data-jump="${pinned.id}">${icon('pin', 16)}<span><strong>Pinned message</strong><small>${previewIcon(pinned)}${escapeHtml(previewText(pinned) || 'Message')}</small></span></button>
      <button type="button" class="icon-button" data-action="unpin" aria-label="Unpin message">${icon('close', 18)}</button>`;
  }

  /* ------------------------------ messages ------------------------------ */

  function bubbleSkeleton() {
    return `<div class="bubble-skeleton" aria-hidden="true">${[62, 40, 75, 52, 34, 68].map((width, index) => `<i class="${index % 3 === 1 ? 'mine' : ''}" style="width:${width}%"></i>`).join('')}</div>`;
  }

  function isNearBottom(threshold = 120) {
    return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < threshold;
  }

  function scrollToBottom(smooth = false) {
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
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
      list.innerHTML = emptyState('chat', 'No messages here yet', 'Say hello — or send a voice message or a sticker.');
      return;
    }
    if (list.querySelector('.empty-state, .bubble-skeleton')) list.innerHTML = '';

    const wasNearBottom = isNearBottom();
    const previousHeight = scroller.scrollHeight;
    const previousTop = scroller.scrollTop;
    const previousFirst = list.querySelector('[data-key]')?.dataset.key;
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
        viewerId: state.user?.id, isGroup, groupStart, groupEnd, unreadDivider,
        showSender: isGroup && !message.isMine && groupStart && message.kind !== 'sticker',
        showAvatar: isGroup && !message.isMine && groupEnd,
        avatarHtml: `<button type="button" class="avatar-button" data-profile="${sender.id}" aria-label="Open ${escapeHtml(sender.displayName)}'s profile">${avatar(sender, 'sm')}</button>`
      };
      const key = messageKey(message);
      seen.add(key);
      const signature = messageSignature(message, layout);
      let row = rows.get(key);
      if (!row && message.id && message.clientId) {
        // An optimistic row confirmed by the server: keep the element, just re-key it.
        const pendingKey = `c${message.clientId}`;
        if (rows.has(pendingKey)) { row = rows.get(pendingKey); rows.delete(pendingKey); }
      }
      if (!row || row.signature !== signature) {
        const element = document.createElement('div');
        element.className = 'message-row';
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

    const newFirst = list.querySelector('[data-key]')?.dataset.key;
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
    element.classList.remove('highlight');
    void element.offsetWidth;
    element.classList.add('highlight');
  }

  async function jumpTo(messageId) {
    let row = list.querySelector(`[data-key="m${messageId}"]`);
    if (!row) {
      try { await loadAround(id, messageId); } catch (error) { return toast(error.message, 'error'); }
      draw();
      row = list.querySelector(`[data-key="m${messageId}"]`);
    }
    if (!row) return toast('That message is no longer available.', 'error');
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
    if (destroyed || document.visibilityState !== 'visible') return;
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
      if (isNearBottom() && !store.hasNewer) markConversationRead(id);
      return;
    }
    lastReadSent = target;
    if (conversation) conversation.lastReadMessageId = target;
    request(`/api/conversations/${id}/read`, { method: 'POST', body: { messageId: target } })
      .then(result => patchConversation(id, { unread: result.unread }))
      .catch(() => { lastReadSent = 0; });
  }

  /* -------------------------------- sending -------------------------------- */

  function replySummary() {
    return replyTo ? { id: replyTo.id, body: replyTo.body, kind: replyTo.kind, deleted: false, sender: { id: replyTo.sender.id, displayName: replyTo.sender.displayName } } : null;
  }

  function pendingMessage(fields) {
    return {
      id: null, clientId: newClientId(), localSeq: ++localSeq, conversationId: id, body: '', media: null, sticker: null,
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
    const pending = pendingMessage({ kind: 'sticker', sticker: { id: sticker.id, name: sticker.name || 'Sticker', url: sticker.url || `/api/stickers/${sticker.id}/file` } });
    return sendOptimistic(pending, clientId => post(clientId, { kind: 'sticker', stickerId: sticker.id, replyToId }));
  }

  function sendMedia(file) {
    const replyToId = replyTo?.id || null;
    const kind = file.type.startsWith('video/') ? 'video' : 'image';
    const localUrl = URL.createObjectURL(file);
    const pending = pendingMessage({ kind, localUrl, media: { id: `local-${Date.now()}`, url: localUrl, mimeType: file.type } });
    let mediaId = null;
    return sendOptimistic(pending, async clientId => {
      if (!mediaId) {
        const { measureMedia } = await import('../components/media.js');
        const details = await measureMedia(file);
        mediaId = (await upload(file, 'chat', details)).media.id;
      }
      return post(clientId, { kind, mediaId, replyToId });
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
    input.style.height = `${Math.min(input.scrollHeight, 140)}px`;
  }

  function showContext(kind, message) {
    const label = kind === 'edit' ? 'Edit message' : `Reply to ${message.isMine ? 'yourself' : message.sender.displayName}`;
    contextBar.hidden = false;
    contextBar.innerHTML = `<span class="context-icon">${icon(kind === 'edit' ? 'edit' : 'reply', 19)}</span>
      <button type="button" class="context-main" data-jump="${message.id}"><strong>${escapeHtml(label)}</strong><small>${previewIcon(message)}${escapeHtml(previewText(message) || 'Message')}</small></button>
      <button type="button" class="icon-button" data-action="cancel-context" aria-label="Cancel">${icon('close', 18)}</button>`;
  }

  function clearContext() {
    const wasEditing = Boolean(editing);
    replyTo = null;
    editing = null;
    contextBar.hidden = true;
    contextBar.innerHTML = '';
    if (wasEditing) { input.value = getDraft(id); syncComposer(); }
  }

  function startReply(message) {
    if (editing) clearContext();
    replyTo = message;
    showContext('reply', message);
    input.focus({ preventScroll: true });
  }

  function startEdit(message) {
    replyTo = null;
    editing = message;
    showContext('edit', message);
    input.value = message.body;
    syncComposer();
    input.focus({ preventScroll: true });
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

  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
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
    input.focus({ preventScroll: true });
    sendText(text);
  });

  /* ------------------------------- recording ------------------------------- */

  async function startRecording() {
    if (!recordingSupported()) return toast('Voice messages are not supported in this browser.', 'error');
    if (recorder.state !== 'idle') return;
    try {
      const started = await recorder.start();
      if (!started || destroyed) return;
    } catch (error) { return toast(error.message, 'error'); }
    stopAll();
    form.hidden = true;
    recordingBar.hidden = false;
    sendTyping(true, 'voice');
    const levels = recordingBar.querySelectorAll('.recording-level i');
    recorder.onLevel = level => levels.forEach((bar, index) => { bar.style.transform = `scaleY(${Math.max(0.15, Math.min(1, level * (1 - Math.abs(index - 2) * 0.18)))})`; });
    const time = recordingBar.querySelector('[data-record-time]');
    recordTimer = setInterval(() => {
      const elapsed = recorder.elapsed();
      time.textContent = formatDuration(elapsed);
      if (elapsed >= MAX_RECORDING_MS) finishRecording(true);
    }, 200);
  }

  function resetRecordingUi() {
    clearInterval(recordTimer);
    recordTimer = null;
    recordingBar.hidden = true;
    form.hidden = false;
    recordingBar.querySelector('[data-record-time]').textContent = '0:00';
    sendTyping(false, 'voice');
  }

  async function finishRecording(send) {
    if (recorder.state !== 'recording' && recorder.state !== 'starting') return;
    if (!send) { recorder.cancel(); resetRecordingUi(); return; }
    const sendButton = recordingBar.querySelector('[data-action="send-recording"]');
    sendButton.disabled = true;
    const recording = await recorder.stop();
    sendButton.disabled = false;
    resetRecordingUi();
    if (!recording) return toast('Recording was too short — hold on a little longer.');
    sendVoice(recording);
  }

  /* -------------------------------- actions -------------------------------- */

  function findMessage(element) {
    const row = element.closest('[data-key]');
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

  async function deleteMessage(message) {
    const conversation = conversationById(id);
    const others = conversation?.kind === 'group' ? 'everyone' : otherMember(conversation)?.displayName || 'everyone';
    const choice = await actionSheet({
      title: 'Delete message?',
      header: `<p class="sheet-text">${message.isMine ? `“Delete for everyone” also removes it for ${escapeHtml(others)}.` : 'This removes the message from your chat history only.'}</p>`,
      actions: [
        message.isMine && { id: 'everyone', label: 'Delete for everyone', icon: 'trash', danger: true },
        { id: 'me', label: 'Delete for me', icon: 'trash', danger: !message.isMine },
        { id: 'cancel', label: 'Cancel' }
      ].filter(Boolean)
    });
    if (choice !== 'everyone' && choice !== 'me') return;
    // Remove immediately; restore if the server refuses.
    removeMessage(id, message.id);
    try { await request(`/api/messages/${message.id}?scope=${choice}`, { method: 'DELETE' }); }
    catch (error) { upsertMessage(id, message); toast(error.message, 'error'); }
  }

  async function togglePin(message) {
    const conversation = conversationById(id);
    const unpin = conversation?.pinnedMessage?.id === message?.id || !message;
    try {
      const { pinnedMessage } = await request(`/api/conversations/${id}/pin`, { method: 'POST', body: { messageId: unpin ? null : message.id } });
      patchConversation(id, { pinnedMessage });
      toast(unpin ? 'Message unpinned' : 'Message pinned');
    } catch (error) { toast(error.message, 'error'); }
  }

  function openMenu(message) {
    if (!message) return;
    if (!message.id) {
      if (message.failed) return retries.get(message.clientId)?.();
      return;
    }
    openMessageMenu(message, {
      conversation: conversationById(id),
      onAction: async (action, value) => {
        if (action === 'react') return react(message, value);
        if (action === 'reply') return startReply(message);
        if (action === 'edit') return startEdit(message);
        if (action === 'forward') return openForwardPicker(message);
        if (action === 'pin') return togglePin(message);
        if (action === 'delete') return deleteMessage(message);
        if (action === 'copy') {
          try { await navigator.clipboard.writeText(message.body); toast('Copied'); } catch { toast('Copy is not available here', 'error'); }
        }
        if (action === 'download' && message.media) {
          const link = document.createElement('a');
          link.href = message.media.url;
          link.download = '';
          link.click();
        }
      }
    });
  }

  function openImage(src) {
    const viewer = modal(`<img class="lightbox-image" src="${escapeHtml(src)}" alt="Photo"><button class="icon-button lightbox-close" data-close-modal aria-label="Close">${icon('close', 24)}</button>`, 'lightbox');
    viewer.querySelector('.lightbox-image').addEventListener('click', () => viewer.close());
  }

  async function openInfo() {
    const conversation = conversationById(id);
    if (!conversation) return;
    const other = otherMember(conversation);
    const sheet = modal(`
      <div class="info-head">
        ${conversation.kind === 'group' ? `<span class="avatar avatar-lg avatar-group">${icon('users', 34)}</span>` : avatar(memberById(other?.id) || other, 'lg')}
        <h2>${escapeHtml(conversation.title)}</h2>
        <p>${conversation.kind === 'group' ? `${conversation.members.length} members` : escapeHtml(lastSeenText(memberById(other?.id) || other))}</p>
      </div>
      <div class="action-list compact">
        ${conversation.kind === 'direct' ? `<button class="action-item" data-info="profile">${icon('user', 20)}<span>View profile</span></button>` : ''}
        <button class="action-item" data-info="mute">${icon(conversation.muted ? 'bell' : 'mute', 20)}<span>${conversation.muted ? 'Unmute notifications' : 'Mute notifications'}</span></button>
        <button class="action-item" data-info="pin-chat">${icon('pin', 20)}<span>${conversation.pinned ? 'Unpin chat' : 'Pin chat to top'}</span></button>
      </div>
      ${conversation.kind === 'group' ? `<h3 class="sheet-section">Members</h3><div class="member-list">${conversation.members.map(member => {
        const live = memberById(member.id) || member;
        return `<button class="member-item" data-member="${member.id}">${avatar(live, 'sm')}<div><strong>${escapeHtml(live.displayName)}${live.id === state.user?.id ? ' (you)' : ''}</strong><small class="${live.online ? 'online-text' : ''}">${escapeHtml(lastSeenText(live))}</small></div></button>`;
      }).join('')}</div>` : ''}
      <h3 class="sheet-section">Shared media</h3>
      <div data-gallery><div class="gallery-grid">${'<i class="skeleton-tile"></i>'.repeat(6)}</div></div>`, 'info-sheet');

    sheet.addEventListener('click', async event => {
      const action = event.target.closest('[data-info]')?.dataset.info;
      const member = event.target.closest('[data-member]');
      const media = event.target.closest('[data-gallery-item]');
      if (member) { sheet.close(); navigate(`/profile/${member.dataset.member}`); }
      if (media) { sheet.close(); jumpTo(Number(media.dataset.galleryItem)); }
      if (action === 'profile') { sheet.close(); navigate(`/profile/${other.id}`); }
      if (action === 'mute' || action === 'pin-chat') {
        const body = action === 'mute' ? { muted: !conversation.muted } : { pinned: !conversation.pinned };
        try {
          const result = await request(`/api/conversations/${id}/settings`, { method: 'POST', body });
          patchConversation(id, result.conversation);
          sheet.close();
          toast(action === 'mute' ? (body.muted ? 'Notifications muted' : 'Notifications on') : (body.pinned ? 'Chat pinned' : 'Chat unpinned'));
        } catch (error) { toast(error.message, 'error'); }
      }
    });

    try {
      const { items } = await request(`/api/conversations/${id}/media`);
      const visual = items.filter(item => item.kind !== 'voice');
      const voices = items.filter(item => item.kind === 'voice').length;
      sheet.querySelector('[data-gallery]').innerHTML = visual.length
        ? `<div class="gallery-grid">${visual.map(item => `<button class="gallery-item" data-gallery-item="${item.id}">${item.kind === 'video'
          ? `<video src="${escapeHtml(item.media.url)}" preload="metadata" muted playsinline></video><span class="gallery-badge">${icon('play', 12, true)}</span>`
          : `<img src="${escapeHtml(item.media.url)}" alt="" loading="lazy" decoding="async">`}</button>`).join('')}</div>${voices ? `<p class="field-hint">${voices} voice message${voices === 1 ? '' : 's'} in this chat.</p>` : ''}`
        : `<p class="field-hint">Photos and videos shared here will appear in this gallery.${voices ? ` ${voices} voice message${voices === 1 ? '' : 's'} so far.` : ''}</p>`;
    } catch (error) {
      sheet.querySelector('[data-gallery]').innerHTML = `<p class="field-hint">${escapeHtml(error.message)}</p>`;
    }
  }

  host.addEventListener('click', async event => {
    const jump = event.target.closest('[data-jump]');
    if (jump && jump.dataset.jump) { event.preventDefault(); return jumpTo(Number(jump.dataset.jump)); }
    const internal = event.target.closest('[data-internal-link]');
    if (internal) { event.preventDefault(); return navigate(internal.getAttribute('href')); }
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
    const image = event.target.closest('[data-open-media]');
    if (image) return openImage(image.querySelector('img').currentSrc || image.querySelector('img').src);

    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;
    const action = trigger.dataset.action;
    try {
      if (action === 'back') return goBack('/chat');
      if (action === 'info') return openInfo();
      if (action === 'cancel-context') return clearContext();
      if (action === 'unpin') return togglePin(null);
      if (action === 'scroll-bottom') {
        if (messageStore(id).hasNewer) { await loadMessages(id); draw(); }
        unreadAnchor = null;
        return scrollToBottom(true);
      }
      if (action === 'voice') return startRecording();
      if (action === 'cancel-recording') return finishRecording(false);
      if (action === 'send-recording') return finishRecording(true);
      if (action === 'attach') {
        const { pickFiles } = await import('../components/media.js');
        const files = await pickFiles('image/*,video/*', true);
        for (const file of files.slice(0, 10)) sendMedia(file);
      }
      if (action === 'stickers') {
        const { openStickerPicker } = await import('../components/stickerPicker.js');
        openStickerPicker(stickerId => {
          const sticker = state.stickers.packs.flatMap(pack => pack.stickers).concat(state.stickers.recent).find(item => item.id === stickerId) || { id: stickerId };
          sendSticker(sticker);
        });
      }
    } catch (error) { toast(error.message, 'error'); }
  });

  // Double-tap a bubble for a quick ❤️, like the native messengers.
  list.addEventListener('dblclick', event => {
    if (event.target.closest('button, a, video, [data-voice], .message-text')) return;
    const message = findMessage(event.target);
    if (!message?.id) return;
    const mine = message.reactions.find(item => item.user.id === state.user?.id)?.reaction;
    react(message, mine === '❤️' ? '' : '❤️');
  });

  cleanups.push(onLongPress(list, '.message-bubble, .sticker', element => openMenu(findMessage(element))));
  cleanups.push(onSwipeLeft(list, '.message', element => { const message = findMessage(element); if (message?.id) startReply(message); }));
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
  list.addEventListener('load', () => { if (stickToBottom) scrollToBottom(); }, true);
  list.addEventListener('loadedmetadata', () => { if (stickToBottom) scrollToBottom(); }, true);

  // Keep the composer glued above the on-screen keyboard (iOS resizes only the visual viewport).
  const viewport = window.visualViewport;
  const fitViewport = () => {
    if (!viewport) return;
    const keepBottom = stickToBottom;
    page.style.height = `${viewport.height}px`;
    page.style.transform = viewport.offsetTop ? `translateY(${viewport.offsetTop}px)` : '';
    if (keepBottom) scrollToBottom();
  };
  if (viewport) {
    viewport.addEventListener('resize', fitViewport);
    viewport.addEventListener('scroll', fitViewport);
    cleanups.push(() => { viewport.removeEventListener('resize', fitViewport); viewport.removeEventListener('scroll', fitViewport); });
    fitViewport();
  }

  const onVisibility = () => { if (document.visibilityState === 'visible') { refreshRelativeTimes(list); scheduleRead(); } else stopTyping(); };
  document.addEventListener('visibilitychange', onVisibility);
  cleanups.push(() => document.removeEventListener('visibilitychange', onVisibility));

  /* ------------------------------ subscriptions ------------------------------ */

  cleanups.push(subscribe((event, payload) => {
    const mine = payload === id || payload?.conversationId === id;
    if ((event === 'messages' || event === 'message') && mine) draw({ forceBottom: event === 'message' && payload.created && payload.message.isMine && !payload.message.id });
    if (['conversations', 'presence', 'members', 'typing'].includes(event)) drawHeader();
    if (event === 'reset') navigate('/');
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
      list.innerHTML = emptyState('lock', 'Conversation unavailable', error.status === 403 ? 'You are not a member of this conversation.' : error.message,
        '<button class="button button-primary" data-action="back">Back to chats</button>');
    }
  })();

  return () => {
    destroyed = true;
    if (state.openConversationId === id) state.openConversationId = null;
    document.documentElement.classList.remove('chat-open');
    clearTimeout(readTimer);
    clearTimeout(draftTimer);
    if (!editing) setDraft(id, input.value);
    stopTyping();
    if (recorder.state !== 'idle') { recorder.cancel(); resetRecordingUi(); }
    stopAll();
    observer.disconnect();
    for (const cleanup of cleanups) cleanup();
    // Release optimistic previews; confirmed messages fall back to their server URLs.
    for (const message of messageStore(id).items) {
      if (message.localUrl) { URL.revokeObjectURL(message.localUrl); delete message.localUrl; }
    }
    for (const message of messageStore(id).items.filter(item => !item.id && !retries.has(item.clientId))) removePendingMessage(id, message.clientId);
    document.querySelector('.sticker-picker')?.remove();
  };
}
