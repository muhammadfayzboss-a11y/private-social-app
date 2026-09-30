import { all, one, run } from './db.js';
import { isOnline, send } from './realtime.js';
import { notificationPrefs } from './settings.js';
import { sendPushToUser } from './webpush.js';
import { iso } from './utils.js';

const SUMMARIES = {
  post_reaction: 'reacted to your post',
  comment: 'commented on your post',
  comment_reply: 'replied to your comment',
  comment_reaction: 'liked your comment',
  story_reaction: 'reacted to your story',
  story_reply: 'replied to your story',
  message_reaction: 'reacted to your message',
  mention: 'mentioned you',
  message: 'sent you a message'
};

// Which notification preference governs push for each kind of activity.
const PREF_FOR_KIND = {
  post_reaction: 'reactions', comment_reaction: 'reactions', story_reaction: 'reactions', message_reaction: 'reactions',
  comment: 'messages', comment_reply: 'messages', story_reply: 'messages', mention: 'mentions'
};

function deepLink(notification) {
  if (notification.entityType === 'conversation') return `/chat/${notification.entityId}`;
  if (notification.entityType === 'post') return `/feed?post=${notification.entityId}`;
  if (notification.entityType === 'story') return '/profile';
  return '/';
}

/**
 * Records an Activity entry (always — it is the member's history) and delivers it live. Push is sent
 * only to members who are offline and have that category of notification switched on.
 */
export function notify(userId, actorId, kind, entityType, entityId, message = '') {
  if (!userId || Number(userId) === Number(actorId)) return null;
  const result = run(`INSERT INTO notifications(user_id, actor_id, kind, entity_type, entity_id, message)
    VALUES (?, ?, ?, ?, ?, ?)`, userId, actorId || null, kind, entityType, String(entityId), message);
  const notification = one(`SELECT n.*, u.username actor_username, u.display_name actor_display_name, u.avatar_media_id actor_avatar_id
    FROM notifications n LEFT JOIN users u ON u.id = n.actor_id WHERE n.id = ?`, result.lastInsertRowid);
  const formatted = formatNotification(notification);
  send(userId, 'notification', formatted);

  const prefs = notificationPrefs(userId);
  if (!isOnline(userId) && prefs[PREF_FOR_KIND[kind] || 'messages'] !== false) {
    const actor = formatted.actor?.displayName || 'Someone';
    const withText = ['comment', 'comment_reply', 'story_reply', 'mention'].includes(kind) && message && prefs.preview !== false;
    sendPushToUser(userId, {
      title: 'Circle',
      body: `${actor} ${SUMMARIES[kind] || 'interacted with your content'}${withText ? `: ${message}` : kind.endsWith('reaction') && message ? ` ${message}` : ''}`,
      url: deepLink(formatted),
      tag: `${formatted.entityType}-${formatted.entityId}`
    }).catch(error => console.error('Push notification failed:', error.message));
  }
  return formatted;
}

const MESSAGE_PREVIEWS = { voice: '🎤 Voice message', image: '📷 Photo', video: '🎬 Video', sticker: 'Sticker', file: '📎 File', story_reply: 'Replied to your story' };

/**
 * Chat messages have their own unread counters, so they are not written to Activity. Offline members
 * get one push per message unless they muted the chat or switched off that category (private chats vs
 * groups). Mentions are delivered separately and reach members even in muted groups.
 */
export function notifyMessage(recipientId, sender, conversationId, message) {
  if (!recipientId || Number(recipientId) === Number(sender.id) || isOnline(recipientId)) return;
  const membership = one(`SELECT cm.muted, c.kind, c.title FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
    WHERE cm.conversation_id = ? AND cm.user_id = ?`, conversationId, recipientId);
  if (!membership || Number(membership.muted)) return;
  const prefs = notificationPrefs(recipientId);
  if (membership.kind === 'group' ? prefs.groups === false : prefs.messages === false) return;
  const text = message.kind === 'text' || message.kind === 'story_reply' ? String(message.body || '').slice(0, 120) : MESSAGE_PREVIEWS[message.kind] || 'New message';
  const title = membership.kind === 'group' ? `${sender.displayName} · ${membership.title}` : sender.displayName || 'Circle';
  sendPushToUser(recipientId, {
    title: prefs.preview === false ? 'Circle' : title,
    body: prefs.preview === false ? 'New message' : text || 'New message',
    url: `/chat/${conversationId}`,
    tag: `conversation-${conversationId}`
  }).catch(error => console.error('Push notification failed:', error.message));
}

/** A member shared a story: offline members who can see it and want story alerts get a push. */
export function notifyStory(authorId, authorName, recipients) {
  for (const recipientId of recipients) {
    if (Number(recipientId) === Number(authorId) || isOnline(recipientId)) continue;
    if (notificationPrefs(recipientId).stories === false) continue;
    sendPushToUser(recipientId, { title: 'Circle', body: `${authorName} shared a new story`, url: '/', tag: `story-${authorId}` })
      .catch(error => console.error('Push notification failed:', error.message));
  }
}

export function formatNotification(row) {
  return {
    id: row.id, kind: row.kind, entityType: row.entity_type, entityId: row.entity_id,
    message: row.message, readAt: iso(row.read_at), createdAt: iso(row.created_at),
    actor: row.actor_id ? { id: row.actor_id, username: row.actor_username, displayName: row.actor_display_name,
      avatarUrl: row.actor_avatar_id ? `/api/media/${row.actor_avatar_id}` : null } : null
  };
}

export function listNotifications(userId, limit = 80) {
  return all(`SELECT n.*, u.username actor_username, u.display_name actor_display_name, u.avatar_media_id actor_avatar_id
    FROM notifications n LEFT JOIN users u ON u.id = n.actor_id WHERE n.user_id = ? ORDER BY n.id DESC LIMIT ?`, userId, limit).map(formatNotification);
}
