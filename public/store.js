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
  typing: new Map()
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

export function applyPresence({ userId, online, lastSeenAt }) {
  const member = state.members.find(item => item.id === Number(userId));
  if (!member) return;
  member.online = online;
  if (lastSeenAt) member.lastSeenAt = lastSeenAt;
  publish('presence', { userId: Number(userId), online });
}

export function applyProfile(user) {
  const index = state.members.findIndex(item => item.id === user.id);
  if (index >= 0) state.members[index] = { ...state.members[index], ...user };
  else state.members.push(user);
  if (state.user?.id === user.id) state.user = { ...state.user, ...user };
  for (const post of state.feed.posts) if (post.author.id === user.id) post.author = { ...post.author, displayName: user.displayName, avatarUrl: user.avatarUrl };
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
  if (index >= 0) state.stories.items[index] = story;
  else state.stories.items.push(story);
  publish('stories');
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

export async function loadConversations() {
  const { conversations } = await request('/api/conversations');
  state.conversations.items = conversations;
  state.conversations.loaded = true;
  publish('conversations');
  return conversations;
}

export function conversationById(id) {
  return state.conversations.items.find(item => item.id === Number(id)) || null;
}

export function messageStore(conversationId) {
  const key = Number(conversationId);
  if (!state.messages.has(key)) state.messages.set(key, { items: [], nextCursor: null, loaded: false, loading: false });
  return state.messages.get(key);
}

export async function loadMessages(conversationId, { more = false } = {}) {
  const store = messageStore(conversationId);
  if (store.loading) return store;
  if (more && !store.nextCursor) return store;
  store.loading = true;
  publish('messages:loading', Number(conversationId));
  try {
    const before = more && store.nextCursor ? `?before=${store.nextCursor}` : '';
    const data = await request(`/api/conversations/${conversationId}/messages${before}`);
    const existing = new Set(store.items.map(message => message.id));
    const fresh = data.messages.filter(message => !existing.has(message.id));
    store.items = [...fresh, ...store.items].sort((a, b) => a.id - b.id);
    store.nextCursor = data.nextCursor;
    store.loaded = true;
  } finally {
    store.loading = false;
    publish('messages', Number(conversationId));
  }
  return store;
}

export function upsertMessage(conversationId, message) {
  const store = messageStore(conversationId);
  const index = store.items.findIndex(item => item.id === message.id);
  if (index >= 0) store.items[index] = message;
  else store.items.push(message);
  store.items.sort((a, b) => a.id - b.id);
  const conversation = conversationById(conversationId);
  if (conversation) {
    conversation.lastMessage = message;
    conversation.updatedAt = message.createdAt;
    state.conversations.items.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }
  publish('message', { conversationId: Number(conversationId), message });
}

export function markConversationRead(conversationId) {
  const conversation = conversationById(conversationId);
  if (conversation) conversation.unread = 0;
  publish('conversations');
}

export function totalUnreadMessages() {
  return state.conversations.items.reduce((sum, conversation) => sum + (conversation.unread || 0), 0);
}

export function setTyping(conversationId, userId, typing) {
  const key = Number(conversationId);
  if (!state.typing.has(key)) state.typing.set(key, new Map());
  const map = state.typing.get(key);
  clearTimeout(map.get(Number(userId)));
  if (typing) map.set(Number(userId), setTimeout(() => { map.delete(Number(userId)); publish('typing', key); }, 4000));
  else map.delete(Number(userId));
  publish('typing', key);
}

export function typingUsers(conversationId) {
  return [...(state.typing.get(Number(conversationId))?.keys() || [])].map(memberById).filter(Boolean);
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
  state.activity.items = [notification, ...state.activity.items];
  state.activity.unread += 1;
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
  publish('reset');
}
