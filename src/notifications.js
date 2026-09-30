import { all, one, run } from './db.js';
import { isOnline, send } from './realtime.js';
import { sendPushToUser } from './webpush.js';
import { iso } from './utils.js';

const SUMMARIES = {
  post_reaction: 'reacted to your post',
  comment: 'commented on your post',
  comment_reply: 'replied to your comment',
  comment_reaction: 'liked your comment',
  story_reaction: 'reacted to your story',
  story_reply: 'replied to your story',
  message: 'sent you a message'
};

function deepLink(notification) {
  if (notification.entityType === 'conversation') return `/chat/${notification.entityId}`;
  if (notification.entityType === 'post') return `/?post=${notification.entityId}`;
  return '/';
}

export function notify(userId, actorId, kind, entityType, entityId, message = '') {
  if (!userId || Number(userId) === Number(actorId)) return null;
  const result = run(`INSERT INTO notifications(user_id, actor_id, kind, entity_type, entity_id, message)
    VALUES (?, ?, ?, ?, ?, ?)`, userId, actorId || null, kind, entityType, String(entityId), message);
  const notification = one(`SELECT n.*, u.username actor_username, u.display_name actor_display_name, u.avatar_media_id actor_avatar_id
    FROM notifications n LEFT JOIN users u ON u.id = n.actor_id WHERE n.id = ?`, result.lastInsertRowid);
  const formatted = formatNotification(notification);
  send(userId, 'notification', formatted);

  // Someone with the app open already sees the live update, so push only reaches disconnected devices.
  if (!isOnline(userId)) {
    const actor = formatted.actor?.displayName || 'Someone';
    sendPushToUser(userId, {
      title: 'Circle',
      body: `${actor} ${SUMMARIES[kind] || 'interacted with your content'}${['comment', 'comment_reply', 'story_reply', 'message'].includes(kind) && message ? `: ${message}` : ''}`,
      url: deepLink(formatted),
      tag: `${formatted.entityType}-${formatted.entityId}`
    }).catch(error => console.error('Push notification failed:', error.message));
  }
  return formatted;
}

const MESSAGE_PREVIEWS = { voice: '🎤 Voice message', image: '📷 Photo', video: '🎬 Video', sticker: 'Sticker', story_reply: 'Replied to your story' };

/**
 * Chat messages already have their own unread counters, so they are not written to the Activity
 * feed (that used to bury real activity under "sent you a message"). Members who are offline still
 * get one push per message unless they muted the conversation. The tag collapses a burst from one
 * chat into a single notification on the lock screen.
 */
export function notifyMessage(recipientId, sender, conversationId, message) {
  if (!recipientId || Number(recipientId) === Number(sender.id) || isOnline(recipientId)) return;
  const muted = one('SELECT muted FROM conversation_members WHERE conversation_id = ? AND user_id = ?', conversationId, recipientId)?.muted;
  if (Number(muted)) return;
  const preview = message.kind === 'text' || message.kind === 'story_reply' ? String(message.body || '').slice(0, 120) : MESSAGE_PREVIEWS[message.kind] || 'New message';
  sendPushToUser(recipientId, {
    title: sender.displayName || 'Circle',
    body: preview || 'New message',
    url: `/chat/${conversationId}`,
    tag: `conversation-${conversationId}`
  }).catch(error => console.error('Push notification failed:', error.message));
}

export function formatNotification(row) {
  return {
    id: row.id, kind: row.kind, entityType: row.entity_type, entityId: row.entity_id,
    message: row.message, readAt: iso(row.read_at), createdAt: iso(row.created_at),
    actor: row.actor_id ? { id: row.actor_id, username: row.actor_username, displayName: row.actor_display_name,
      avatarUrl: row.actor_avatar_id ? `/api/media/${row.actor_avatar_id}` : null } : null
  };
}

export function listNotifications(userId, limit = 50) {
  return all(`SELECT n.*, u.username actor_username, u.display_name actor_display_name, u.avatar_media_id actor_avatar_id
    FROM notifications n LEFT JOIN users u ON u.id = n.actor_id WHERE n.user_id = ? ORDER BY n.id DESC LIMIT ?`, userId, limit).map(formatNotification);
}
