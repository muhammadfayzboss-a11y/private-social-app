import { request } from './api.js';
import {
  addNotification, applyPresence, applyProfile, conversationById, loadConversations, loadMembers,
  loadMessages, messageStore, patchPost, publish, removePost, removeStory, state, setTyping, upsertMessage, upsertPost, upsertStory
} from './store.js';

let source = null;
let reconnectTimer = null;

const handlers = {
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
  'story:viewed': data => publish('story:viewed', data),
  'message:created': async data => {
    if (data.message) {
      const isOpen = window.location.pathname === `/chat/${data.conversationId}`;
      upsertMessage(data.conversationId, data.message);
      const conversation = conversationById(data.conversationId);
      if (conversation && !isOpen) conversation.unread = (conversation.unread || 0) + 1;
      publish('conversations');
      if (isOpen) request(`/api/conversations/${data.conversationId}/read`, { method: 'POST', body: { messageId: data.message.id } }).catch(() => {});
    } else {
      await loadConversations().catch(() => {});
      if (messageStore(data.conversationId).loaded) await loadMessages(data.conversationId).catch(() => {});
    }
  },
  'message:deleted': data => {
    const store = messageStore(data.conversationId);
    const message = store.items.find(item => item.id === Number(data.messageId));
    if (message) { message.deletedAt = new Date().toISOString(); message.body = ''; message.media = null; message.sticker = null; }
    publish('messages', Number(data.conversationId));
  },
  'message:reaction': data => upsertMessage(data.conversationId, data.message),
  'message:read': data => {
    const store = messageStore(data.conversationId);
    for (const message of store.items) {
      if (message.id <= Number(data.messageId) && message.isMine && !message.readBy.some(reader => reader.id === Number(data.userId))) {
        const reader = state.members.find(member => member.id === Number(data.userId));
        message.readBy.push({ id: Number(data.userId), username: reader?.username || '', displayName: reader?.displayName || '' });
      }
    }
    publish('messages', Number(data.conversationId));
  },
  typing: data => setTyping(data.conversationId, data.userId, data.typing),
  notification: data => addNotification(data)
};

export function connectRealtime() {
  disconnectRealtime();
  source = new EventSource('/api/events', { withCredentials: true });
  source.addEventListener('open', () => publish('realtime:open'));
  for (const [event, handler] of Object.entries(handlers)) {
    source.addEventListener(event, message => {
      try { handler(JSON.parse(message.data)); } catch (error) { console.error(`Realtime handler failed for ${event}`, error); }
    });
  }
  source.addEventListener('error', () => {
    publish('realtime:closed');
    if (source?.readyState === EventSource.CLOSED) {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => { if (state.user) connectRealtime(); }, 3000);
    }
  });
  document.addEventListener('visibilitychange', resumeIfNeeded);
}

function resumeIfNeeded() {
  if (document.visibilityState === 'visible' && state.user && (!source || source.readyState === EventSource.CLOSED)) {
    connectRealtime();
    loadMembers(true).catch(() => {});
    loadConversations().catch(() => {});
  }
}

export function disconnectRealtime() {
  clearTimeout(reconnectTimer);
  document.removeEventListener('visibilitychange', resumeIfNeeded);
  source?.close();
  source = null;
}
