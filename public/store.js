import { request } from './api.js';

const listeners = new Set();

export const state = {
  user: null,
  needsSetup: false,
  members: [],
  feed: { posts: [], nextCursor: null, loading: false, loaded: false, error: null },
  stories: { items: [], loaded: false },
  conversations: { items: [], loaded: false },
  messages: new Map(),
  activity: { items: [], unread: 0, loaded: false },
  stickers: { packs: [], recent: [], loaded: false },
  typing: new Map(),
  openConversationId: null,
  realtime: 'connecting'
};

export function subscribe(handler) {
  listeners.add(handler);
  return () => listeners.delete(handler);
}

export function publish(event, payload) {
  for (const handler of [...listeners]) {
    try { handler(event, payload); } catch (error) { console.error('Listener failed for', event, error); }
  }
}

export function memberById(id) {
  const numeric = Number(id);
  if (state.user && state.user.id === numeric) return state.user;
  return state.members.find(member => member.id === numeric) || null;
}

/* ------------------------------ members ------------------------------ */

export async function loadMembers(force = false) {
  if (state.members.length && !force) return state.members;
  const { members } = await request('/api/members');
  state.members = members;
  publish('members');
  return members;
}

export function applyPresence({ userId, online, lastSeenAt, hidden }) {
  const id = Number(userId);
  const apply = member => {
    member.online = Boolean(online);
    if (lastSeenAt !== undefined) member.lastSeenAt = lastSeenAt;
    if (hidden !== undefined) member.presenceHidden = Boolean(hidden);
  };
  const member = state.members.find(item => item.id === id);
  if (member) apply(member);
  for (const conversation of state.conversations.items) for (const item of conversation.members) if (item.id === id) apply(item);
  publish('presence', { userId: id, online });
}

export function applyProfile(user) {
  const index = state.members.findIndex(item => item.id === user.id);
  if (index >= 0) state.members[index] = { ...state.members[index], ...user };
  else state.members.push(user);
  if (state.user?.id === user.id) state.user = { ...state.user, ...user };
  for (const post of state.feed.posts) if (post.author.id === user.id) post.author = { ...post.author, displayName: user.displayName, avatarUrl: user.avatarUrl };
  for (const conversation of state.conversations.items) {
    conversation.members = conversation.members.map(member => (member.id === user.id ? { ...member, ...user } : member));
    if (conversation.kind === 'direct' && user.id !== state.user?.id && conversation.members.some(member => member.id === user.id)) conversation.title = user.displayName;
  }
  publish('members');
}

/* -------------------------------- feed -------------------------------- */

export async function loadFeed({ reset = false, more = false } = {}) {
  const feed = state.feed;
  if (feed.loading) return;
  if (reset) { feed.posts = []; feed.nextCursor = null; feed.loaded = false; }
  if (more && !feed.nextCursor) return;
  feed.loading = true;
  feed.error = null;
  publish('feed:loading');
  try {
    const cursor = more && feed.nextCursor ? `?cursor=${feed.nextCursor}` : '';
    const data = await request(`/api/feed${cursor}`);
    const existing = new Set(feed.posts.map(post => post.id));
    feed.posts = [...feed.posts, ...data.posts.filter(post => !existing.has(post.id))];
    feed.nextCursor = data.nextCursor;
    feed.loaded = true;
  } catch (error) {
    feed.error = error.message;
  } finally {
    feed.loading = false;
    publish('feed');
  }
}

/**
 * Re-fetches the newest page and merges it with anything already loaded, so returning to Home
 * (or reconnecting after the phone was asleep) shows new posts without clearing the view.
 */
export async function refreshFeed() {
  const data = await request('/api/feed');
  const oldestFresh = data.posts.at(-1)?.id;
  const retained = state.feed.posts.filter(post => !data.posts.some(fresh => fresh.id === post.id) && oldestFresh && post.id < oldestFresh);
  state.feed.posts = [...data.posts, ...retained];
  if (!state.feed.nextCursor) state.feed.nextCursor = data.nextCursor;
  state.feed.loaded = true;
  publish('feed');
  return state.feed.posts;
}

export function upsertPost(post) {
  const index = state.feed.posts.findIndex(item => item.id === post.id);
  if (index >= 0) state.feed.posts[index] = post;
  else state.feed.posts = [post, ...state.feed.posts];
  publish('post', post);
}

export function removePost(postId) {
  state.feed.posts = state.feed.posts.filter(post => post.id !== Number(postId));
  publish('post:removed', Number(postId));
}

export function patchPost(postId, changes) {
  const post = state.feed.posts.find(item => item.id === Number(postId));
  if (!post) return null;
  Object.assign(post, changes);
  publish('post', post);
  return post;
}

/* ------------------------------- stories ------------------------------- */

export async function loadStories() {
  const { stories } = await request('/api/stories');
  state.stories.items = stories;
  state.stories.loaded = true;
  publish('stories');
  return stories;
}

export function upsertStory(story) {
  const index = state.stories.items.findIndex(item => item.id === story.id);
  if (index >= 0) state.stories.items[index] = { ...state.stories.items[index], ...story };
  else state.stories.items.push(story);
  publish('stories');
}

/** A member viewed one of my stories: add them once, with their latest reaction. */
export function applyStoryView(storyId, view) {
  const story = state.stories.items.find(item => item.id === Number(storyId));
  if (!story || !view) return;
  story.views = [view, ...(story.views || []).filter(item => item.user.id !== view.user.id)];
  story.viewCount = story.views.length;
  publish('story:viewed', { storyId: Number(storyId), view });
}

export function removeStory(storyId) {
  state.stories.items = state.stories.items.filter(story => story.id !== Number(storyId));
  publish('stories');
}

export function activeStoryGroups() {
  const now = Date.now();
  const groups = new Map();
  for (const story of state.stories.items) {
    if (new Date(story.expiresAt).getTime() <= now) continue;
    if (!groups.has(story.author.id)) groups.set(story.author.id, { author: story.author, stories: [] });
    groups.get(story.author.id).stories.push(story);
  }
  const list = [...groups.values()].map(group => ({
    ...group,
    stories: group.stories.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)),
    allViewed: group.stories.every(story => story.viewed || story.author.id === state.user?.id)
  }));
  return list.sort((a, b) => {
    if (a.author.id === state.user?.id) return -1;
    if (b.author.id === state.user?.id) return 1;
    return Number(a.allViewed) - Number(b.allViewed);
  });
}

/* ------------------------------ conversations ------------------------------ */

let conversationsRequest = null;

/** Concurrent callers share one in-flight request instead of firing duplicates. */
export function loadConversations() {
  if (conversationsRequest) return conversationsRequest;
  conversationsRequest = request('/api/conversations').then(({ conversations }) => {
    // Unread counts for the chat that is open on screen are always zero locally.
    for (const conversation of conversations) if (conversation.id === state.openConversationId) conversation.unread = 0;
    state.conversations.items = conversations;
    state.conversations.loaded = true;
    publish('conversations');
    return conversations;
  }).finally(() => { conversationsRequest = null; });
  return conversationsRequest;
}

export function conversationById(id) {
  return state.conversations.items.find(item => item.id === Number(id)) || null;
}

function sortConversations() {
  const at = conversation => new Date(conversation.lastMessage?.createdAt || conversation.updatedAt || 0).getTime();
  state.conversations.items.sort((a, b) => (a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : at(b) - at(a)));
}

export function upsertConversation(conversation) {
  const index = state.conversations.items.findIndex(item => item.id === conversation.id);
  if (conversation.id === state.openConversationId) conversation.unread = 0;
  if (index >= 0) state.conversations.items[index] = { ...state.conversations.items[index], ...conversation };
  else state.conversations.items.push(conversation);
  sortConversations();
  publish('conversations');
}

export function patchConversation(id, changes) {
  const conversation = conversationById(id);
  if (!conversation) return null;
  Object.assign(conversation, changes);
  sortConversations();
  publish('conversations');
  return conversation;
}

/* -------------------------------- messages -------------------------------- */

export function messageKey(message) { return message.id ? `m${message.id}` : `c${message.clientId}`; }

export function messageStore(conversationId) {
  const key = Number(conversationId);
  if (!state.messages.has(key)) state.messages.set(key, { items: [], nextCursor: null, hasNewer: false, loaded: false, loading: false, loadingNewer: false });
  return state.messages.get(key);
}

/** Server messages sorted by id; unconfirmed (optimistic) messages always stay at the end, in send order. */
function sortItems(store) {
  store.items.sort((a, b) => {
    if (a.id && b.id) return a.id - b.id;
    if (a.id) return -1;
    if (b.id) return 1;
    return (a.localSeq || 0) - (b.localSeq || 0);
  });
}

function mergeInto(store, messages) {
  for (const message of messages) {
    const index = store.items.findIndex(item => (message.id && item.id === message.id) || (message.clientId && item.clientId === message.clientId));
    if (index >= 0) store.items[index] = { ...message, localUrl: store.items[index].localUrl };
    else store.items.push(message);
  }
  sortItems(store);
}

function lastServerId(store) {
  for (let index = store.items.length - 1; index >= 0; index -= 1) if (store.items[index].id) return store.items[index].id;
  return 0;
}

async function fetchMessages(conversationId, query = '') {
  return request(`/api/conversations/${conversationId}/messages${query}`);
}

/** Initial load (latest page) or, with `more`, the next older page. */
export async function loadMessages(conversationId, { more = false } = {}) {
  const store = messageStore(conversationId);
  if (store.loading) return store;
  if (more && !store.nextCursor) return store;
  store.loading = true;
  publish('messages:loading', Number(conversationId));
  try {
    const data = await fetchMessages(conversationId, more ? `?before=${store.nextCursor}` : '');
    if (more) {
      mergeInto(store, data.messages);
      store.nextCursor = data.nextCursor;
    } else {
      // A fresh latest page replaces the window but keeps unconfirmed sends.
      store.items = store.items.filter(item => !item.id);
      mergeInto(store, data.messages);
      store.nextCursor = data.nextCursor;
      store.hasNewer = false;
    }
    store.loaded = true;
  } finally {
    store.loading = false;
    publish('messages', Number(conversationId));
  }
  return store;
}

/** Opens a window centred on one message (search result, pinned message, reply quote). */
export async function loadAround(conversationId, messageId) {
  const store = messageStore(conversationId);
  store.loading = true;
  try {
    const data = await fetchMessages(conversationId, `?around=${Number(messageId)}`);
    store.items = store.items.filter(item => !item.id);
    mergeInto(store, data.messages);
    store.nextCursor = data.nextCursor;
    store.hasNewer = data.hasNewer;
    store.loaded = true;
  } finally {
    store.loading = false;
    publish('messages', Number(conversationId));
  }
  return store;
}

export async function loadNewer(conversationId) {
  const store = messageStore(conversationId);
  if (!store.hasNewer || store.loadingNewer) return store;
  store.loadingNewer = true;
  try {
    const data = await fetchMessages(conversationId, `?after=${lastServerId(store)}`);
    mergeInto(store, data.messages);
    store.hasNewer = data.hasNewer;
  } finally {
    store.loadingNewer = false;
    publish('messages', Number(conversationId));
  }
  return store;
}

/**
 * After a reconnect the client may have missed creations, edits, and deletions. The latest page is
 * re-fetched and becomes authoritative for its id range: anything local in that range the server no
 * longer returns was deleted. If more was missed than one page holds, the window is replaced.
 */
export async function resyncMessages(conversationId) {
  const store = messageStore(conversationId);
  if (!store.loaded || store.hasNewer || store.loading) return store;
  const data = await fetchMessages(conversationId);
  const fresh = data.messages;
  const oldestFresh = fresh[0]?.id ?? Infinity;
  const localNewest = lastServerId(store);
  const gap = data.nextCursor && localNewest && localNewest < oldestFresh;
  const freshIds = new Set(fresh.map(message => message.id));
  store.items = store.items.filter(item => {
    if (!item.id) return true;                        // unconfirmed sends are kept
    if (gap) return false;                            // too much missed: start from the fresh page
    if (!data.nextCursor) return freshIds.has(item.id); // the fresh page is the whole history
    return item.id < oldestFresh || freshIds.has(item.id);
  });
  mergeInto(store, fresh);
  if (gap) store.nextCursor = data.nextCursor;
  publish('messages', Number(conversationId));
  return store;
}

/**
 * Inserts or replaces a message. Matching by id and by clientId makes this idempotent: the POST
 * response, the realtime event, another tab's event, and a resync can all deliver the same message
 * and it still appears once. Returns true only when the message was genuinely new.
 */
export function upsertMessage(conversationId, message) {
  const store = messageStore(conversationId);
  const index = store.items.findIndex(item => (message.id && item.id === message.id) || (message.clientId && item.clientId === message.clientId));
  const created = index < 0;
  // A realtime event for a window that is scrolled back in history belongs to the unloaded "newer" part.
  if (created && store.hasNewer && message.id) {
    bumpConversation(conversationId, message);
    return created;
  }
  if (created) store.items.push(message);
  else store.items[index] = { ...message, localUrl: store.items[index].localUrl };
  sortItems(store);
  if (message.id) bumpConversation(conversationId, message);
  publish('message', { conversationId: Number(conversationId), message, created });
  return created;
}

function bumpConversation(conversationId, message) {
  const conversation = conversationById(conversationId);
  if (!conversation) return;
  const currentLast = conversation.lastMessage;
  if (!currentLast || !currentLast.id || message.id >= currentLast.id) {
    conversation.lastMessage = message;
    conversation.updatedAt = message.createdAt;
    sortConversations();
  }
}

export function removeMessage(conversationId, messageId) {
  const store = messageStore(conversationId);
  const before = store.items.length;
  store.items = store.items.filter(item => item.id !== Number(messageId));
  const conversation = conversationById(conversationId);
  if (conversation?.pinnedMessage?.id === Number(messageId)) conversation.pinnedMessage = null;
  if (conversation?.lastMessage?.id === Number(messageId)) {
    conversation.lastMessage = store.items.filter(item => item.id).at(-1) || null;
    if (!conversation.lastMessage) loadConversations().catch(() => {});
  }
  if (store.items.length !== before || conversation) publish('messages', Number(conversationId));
  publish('conversations');
}

export function removePendingMessage(conversationId, clientId) {
  const store = messageStore(conversationId);
  store.items = store.items.filter(item => item.clientId !== clientId || item.id);
  publish('messages', Number(conversationId));
}

export function patchPendingMessage(conversationId, clientId, changes) {
  const store = messageStore(conversationId);
  const message = store.items.find(item => item.clientId === clientId && !item.id);
  if (message) Object.assign(message, changes);
  publish('messages', Number(conversationId));
  return message;
}

export function applyRead(conversationId, userId, messageId) {
  const store = messageStore(conversationId);
  let changed = false;
  const reader = memberById(userId);
  for (const message of store.items) {
    if (message.id && message.id <= Number(messageId) && message.sender.id !== Number(userId) && !message.readBy.some(item => item.id === Number(userId))) {
      message.readBy = [...message.readBy, { id: Number(userId), username: reader?.username || '', displayName: reader?.displayName || '' }];
      changed = true;
    }
  }
  const conversation = conversationById(conversationId);
  if (conversation?.lastMessage?.id && conversation.lastMessage.id <= Number(messageId) && !conversation.lastMessage.readBy.some(item => item.id === Number(userId))) {
    conversation.lastMessage = { ...conversation.lastMessage, readBy: [...conversation.lastMessage.readBy, { id: Number(userId) }] };
    publish('conversations');
  }
  if (changed) publish('messages', Number(conversationId));
}

export function markConversationRead(conversationId) {
  const conversation = conversationById(conversationId);
  if (conversation && conversation.unread) { conversation.unread = 0; publish('conversations'); }
}

export function totalUnreadMessages() {
  return state.conversations.items.reduce((sum, conversation) => sum + (conversation.muted ? 0 : conversation.unread || 0), 0);
}

export function setTyping(conversationId, userId, typing, kind = 'text') {
  const key = Number(conversationId);
  if (!state.typing.has(key)) state.typing.set(key, new Map());
  const map = state.typing.get(key);
  clearTimeout(map.get(Number(userId))?.timer);
  if (typing) map.set(Number(userId), { kind, timer: setTimeout(() => { map.delete(Number(userId)); publish('typing', key); }, 5000) });
  else map.delete(Number(userId));
  publish('typing', key);
}

export function typingUsers(conversationId) {
  return [...(state.typing.get(Number(conversationId))?.entries() || [])]
    .map(([userId, entry]) => ({ user: memberById(userId), kind: entry.kind }))
    .filter(item => item.user);
}

/* --------------------------------- drafts --------------------------------- */

const draftKey = id => `circle-draft-${state.user?.id}-${id}`;
export function getDraft(conversationId) { try { return localStorage.getItem(draftKey(conversationId)) || ''; } catch { return ''; } }
export function setDraft(conversationId, text) {
  try { if (text.trim()) localStorage.setItem(draftKey(conversationId), text); else localStorage.removeItem(draftKey(conversationId)); } catch { /* storage may be full or disabled */ }
}

/* ------------------------------- activity ------------------------------- */

export async function loadActivity() {
  const data = await request('/api/activity');
  state.activity.items = data.notifications;
  state.activity.unread = data.unread;
  state.activity.loaded = true;
  publish('activity');
  return data;
}

export function addNotification(notification) {
  if (state.activity.items.some(item => item.id === notification.id)) return;
  state.activity.items = [notification, ...state.activity.items];
  if (!notification.readAt) state.activity.unread += 1;
  publish('activity');
}

export async function markActivityRead() {
  if (!state.activity.unread) return;
  await request('/api/activity/read', { method: 'POST', body: { all: true } });
  state.activity.items = state.activity.items.map(item => ({ ...item, readAt: item.readAt || new Date().toISOString() }));
  state.activity.unread = 0;
  publish('activity');
}

/* ------------------------------- stickers ------------------------------- */

export async function loadStickers(force = false) {
  if (state.stickers.loaded && !force) return state.stickers;
  const data = await request('/api/stickers');
  state.stickers = { ...data, loaded: true };
  publish('stickers');
  return state.stickers;
}

export function resetState() {
  state.user = null;
  state.members = [];
  state.feed = { posts: [], nextCursor: null, loading: false, loaded: false, error: null };
  state.stories = { items: [], loaded: false };
  state.conversations = { items: [], loaded: false };
  state.messages = new Map();
  state.activity = { items: [], unread: 0, loaded: false };
  state.stickers = { packs: [], recent: [], loaded: false };
  state.typing = new Map();
  state.openConversationId = null;
  publish('reset');
}
