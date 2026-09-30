/**
 * One EventSource per tab. Every handler is idempotent (store upserts match by id/clientId), so a
 * replayed or duplicated event can never duplicate UI state. After any reconnect the client
 * resynchronises: conversations, open message windows, feed, and activity are re-fetched, because
 * events broadcast while the phone was asleep are not replayed by the server.
 */
import {
  addNotification, applyPresence, applyProfile, applyRead, applyStoryView, conversationById, loadActivity, loadConversations,
  loadMembers, patchConversation, patchPost, publish, removeMessage, removePost, removeStory, resyncMessages, setTyping, state,
  upsertConversation, upsertMessage, upsertPost, upsertStory
} from './store.js';
import { setServerTime } from './lib/time.js';

let source = null;
let reconnectTimer = null;
let hasConnectedBefore = false;
let lastEventId = 0;
let retryDelay = 2000;

function onMessageCreated(data) {
  const created = upsertMessage(data.conversationId, data.message);
  const conversation = conversationById(data.conversationId);
  if (!conversation) { loadConversations().catch(() => {}); return; }
  const isOpen = state.openConversationId === Number(data.conversationId) && document.visibilityState === 'visible';
  // Only a genuinely new message from someone else, in a chat that is not on screen, is unread.
  if (created && !data.message.isMine && !isOpen) conversation.unread = (conversation.unread || 0) + 1;
  publish('conversations');
}

const handlers = {
  connected: data => setServerTime(data.serverTime),
  presence: data => applyPresence(data),
  'member:joined': data => { applyProfile(data.user); loadConversations().catch(() => {}); },
  'profile:updated': data => applyProfile(data.user),
  'post:created': data => upsertPost(data.post),
  'post:updated': data => upsertPost(data.post),
  'post:deleted': data => removePost(data.postId),
  'post:reaction': data => patchPost(data.postId, { reactions: data.reactions }),
  'comment:created': data => {
    const post = state.feed.posts.find(item => item.id === Number(data.postId));
    if (!post) return;
    if (!post.comments.some(comment => comment.id === data.comment.id)) post.comments.push(data.comment);
    publish('post', post);
  },
  'story:created': data => upsertStory(data.story),
  'story:deleted': data => removeStory(data.storyId),
  'story:viewed': data => applyStoryView(data.storyId, data.view),
  'message:created': onMessageCreated,
  'message:updated': data => upsertMessage(data.conversationId, data.message),
  'message:reaction': data => upsertMessage(data.conversationId, data.message),
  'message:deleted': data => removeMessage(data.conversationId, data.messageId),
  'message:read': data => {
    if (Number(data.userId) === state.user?.id) {
      // Read on another of my devices: clear the badge here too.
      const conversation = conversationById(data.conversationId);
      if (!conversation) return;
      conversation.lastReadMessageId = Math.max(conversation.lastReadMessageId || 0, Number(data.messageId));
      if (!conversation.unread) return;
      if (!conversation.lastMessage?.id || Number(data.messageId) >= conversation.lastMessage.id) patchConversation(conversation.id, { unread: 0 });
      else loadConversations().catch(() => {});
      return;
    }
    applyRead(data.conversationId, data.userId, data.messageId);
  },
  'conversation:updated': data => upsertConversation(data.conversation),
  'conversation:pinned': data => patchConversation(data.conversationId, { pinnedMessage: data.pinnedMessage }),
  typing: data => setTyping(data.conversationId, data.userId, data.typing, data.kind),
  notification: data => addNotification(data)
};

function setStatus(status) {
  if (state.realtime === status) return;
  state.realtime = status;
  publish('realtime:status', status);
}

async function resynchronise() {
  await Promise.allSettled([loadConversations(), loadMembers(true), loadActivity()]);
  for (const [conversationId, store] of state.messages) if (store.loaded) resyncMessages(conversationId).catch(() => {});
  publish('realtime:open');
}

export function connectRealtime() {
  disconnectRealtime();
  setStatus('connecting');
  source = new EventSource('/api/events', { withCredentials: true });
  const current = source;
  source.addEventListener('open', () => {
    if (current !== source) return;
    retryDelay = 2000;
    setStatus('online');
    if (hasConnectedBefore) resynchronise();
    else publish('realtime:open');
    hasConnectedBefore = true;
  });
  for (const [event, handler] of Object.entries(handlers)) {
    source.addEventListener(event, message => {
      if (current !== source) return;
      // Event ids restart when the server restarts, so only an exact replay within one connection is dropped.
      const id = Number(message.lastEventId || 0);
      if (id && id === lastEventId) return;
      if (id) lastEventId = id;
      try { handler(JSON.parse(message.data)); } catch (error) { console.error(`Realtime handler failed for ${event}`, error); }
    });
  }
  source.addEventListener('error', () => {
    if (current !== source) return;
    setStatus(navigator.onLine === false ? 'offline' : 'connecting');
    // EventSource retries by itself while CONNECTING; a CLOSED stream (e.g. a 401 or proxy error) needs a manual retry.
    if (source.readyState === EventSource.CLOSED) {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => { if (state.user) connectRealtime(); }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30000);
    }
  });
}

function resumeIfNeeded() {
  if (document.visibilityState !== 'visible' || !state.user) return;
  if (!source || source.readyState === EventSource.CLOSED) connectRealtime();
}

function onOnline() { if (state.user) connectRealtime(); }
function onOffline() { setStatus('offline'); }

document.addEventListener('visibilitychange', resumeIfNeeded);
window.addEventListener('online', onOnline);
window.addEventListener('offline', onOffline);

export function disconnectRealtime() {
  clearTimeout(reconnectTimer);
  source?.close();
  source = null;
}

export function resetRealtime() {
  disconnectRealtime();
  hasConnectedBefore = false;
  lastEventId = 0;
}
