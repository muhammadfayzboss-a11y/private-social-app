/**
 * Message persistence and formatting shared by the chat and story routes.
 *
 * Rules enforced here:
 * - Every message has a stable server id; a sender-supplied `clientId` makes creation idempotent, so
 *   a retried or duplicated request can never produce a second message.
 * - Messages deleted for everyone, and messages a member deleted for themselves, never leave the API.
 * - Payloads are viewer-specific (isMine, clientId), so fan-out renders one payload per member.
 */
import { all, one, run, transaction } from './db.js';
import { sendMany } from './realtime.js';
import { HttpError, iso } from './utils.js';

export const PAGE_SIZE = 50;

const SELECT = `SELECT m.*, u.username sender_username, u.display_name sender_display_name, u.avatar_media_id sender_avatar_media_id,
  med.mime_type, med.duration_ms, med.waveform, med.width media_width, med.height media_height,
  s.name sticker_name,
  r.body reply_body, r.kind reply_kind, r.deleted_at reply_deleted, r.sender_id reply_sender_id, ru.display_name reply_sender_name,
  fu.display_name forwarded_name
  FROM messages m
  JOIN users u ON u.id = m.sender_id
  LEFT JOIN media med ON med.id = m.media_id
  LEFT JOIN stickers s ON s.id = m.sticker_id
  LEFT JOIN messages r ON r.id = m.reply_to_id
  LEFT JOIN users ru ON ru.id = r.sender_id
  LEFT JOIN users fu ON fu.id = m.forwarded_from_id`;

/** Visible = not deleted for everyone and not hidden by this viewer. Bind the viewer id once. */
const VISIBLE = `m.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?)`;

export function memberIds(conversationId) {
  return all('SELECT user_id FROM conversation_members WHERE conversation_id = ?', conversationId).map(row => Number(row.user_id));
}

export function assertMember(conversationId, userId) {
  const conversation = one(`SELECT c.*, cm.muted, cm.pinned_at, cm.last_read_message_id FROM conversations c
    JOIN conversation_members cm ON cm.conversation_id = c.id WHERE c.id = ? AND cm.user_id = ?`, Number(conversationId), userId);
  if (!conversation) throw new HttpError(403, 'You do not have access to this conversation.');
  return conversation;
}

function parseWaveform(value) {
  if (!value) return null;
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : null; } catch { return null; }
}

/** Formats many rows with two queries total instead of two per message. */
export function formatMessages(rows, viewerId) {
  if (!rows.length) return [];
  const ids = rows.map(row => row.id);
  const placeholders = ids.map(() => '?').join(',');
  const reactions = all(`SELECT mr.message_id, mr.reaction, u.id, u.username, u.display_name FROM message_reactions mr
    JOIN users u ON u.id = mr.user_id WHERE mr.message_id IN (${placeholders}) ORDER BY mr.created_at`, ...ids);
  const byMessage = new Map();
  for (const reaction of reactions) {
    if (!byMessage.has(reaction.message_id)) byMessage.set(reaction.message_id, []);
    byMessage.get(reaction.message_id).push({ reaction: reaction.reaction, user: { id: reaction.id, username: reaction.username, displayName: reaction.display_name } });
  }
  const conversationIds = [...new Set(rows.map(row => row.conversation_id))];
  const readers = new Map(conversationIds.map(id => [id, all(`SELECT cm.user_id id, cm.last_read_message_id last_read, u.username, u.display_name
    FROM conversation_members cm JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id = ?`, id)]));
  return rows.map(row => formatRow(row, viewerId, byMessage.get(row.id) || [], readers.get(row.conversation_id) || []));
}

function formatRow(row, viewerId, reactions, members) {
  const deleted = Boolean(row.deleted_at);
  const isMine = row.sender_id === viewerId;
  return {
    id: row.id,
    clientId: isMine ? row.client_id || null : null,
    conversationId: row.conversation_id,
    kind: row.kind,
    body: deleted ? '' : row.body,
    media: !deleted && row.media_id ? {
      id: row.media_id, url: `/api/media/${row.media_id}`, mimeType: row.mime_type,
      durationMs: row.duration_ms ?? null, waveform: parseWaveform(row.waveform), width: row.media_width ?? null, height: row.media_height ?? null
    } : null,
    sticker: !deleted && row.sticker_id ? { id: row.sticker_id, name: row.sticker_name, url: `/api/stickers/${row.sticker_id}/file` } : null,
    replyTo: row.reply_to_id ? {
      id: row.reply_to_id, body: row.reply_deleted ? '' : row.reply_body, kind: row.reply_kind, deleted: Boolean(row.reply_deleted),
      sender: row.reply_sender_id ? { id: row.reply_sender_id, displayName: row.reply_sender_name } : null
    } : null,
    forwardedFrom: row.forwarded_from_id ? { id: row.forwarded_from_id, displayName: row.forwarded_name || 'Former member' } : null,
    storyId: row.story_id,
    sender: {
      id: row.sender_id, username: row.sender_username, displayName: row.sender_display_name,
      avatarUrl: row.sender_avatar_media_id ? `/api/media/${row.sender_avatar_media_id}` : null
    },
    reactions,
    readBy: members.filter(member => member.id !== row.sender_id && Number(member.last_read || 0) >= row.id)
      .map(member => ({ id: member.id, username: member.username, displayName: member.display_name })),
    isMine,
    editedAt: iso(row.edited_at),
    deletedAt: iso(row.deleted_at),
    createdAt: iso(row.created_at)
  };
}

export function getMessage(id, viewerId) {
  const row = one(`${SELECT} WHERE m.id = ?`, Number(id));
  return row ? formatMessages([row], viewerId)[0] : null;
}

export function rawMessage(id) {
  const row = one('SELECT * FROM messages WHERE id = ?', Number(id));
  if (!row) throw new HttpError(404, 'Message not found.');
  return row;
}

/**
 * Cursor pagination over the visible history. `before` pages backwards (older), `after` pages forwards
 * (used to catch up after a reconnect), and `around` opens a window centred on one message (search
 * results, pinned message, reply quotes).
 */
export function listMessages(conversationId, viewerId, { before, after, around, limit = PAGE_SIZE } = {}) {
  const base = `${SELECT} WHERE m.conversation_id = ? AND ${VISIBLE}`;
  let rows; let hasOlder; let hasNewer = false;
  if (around) {
    const half = Math.floor(limit / 2);
    const older = all(`${base} AND m.id <= ? ORDER BY m.id DESC LIMIT ?`, conversationId, viewerId, around, half + 1).reverse();
    const newer = all(`${base} AND m.id > ? ORDER BY m.id ASC LIMIT ?`, conversationId, viewerId, around, half + 1);
    hasOlder = older.length > half; if (hasOlder) older.shift();
    hasNewer = newer.length > half; if (hasNewer) newer.pop();
    rows = [...older, ...newer];
  } else if (after !== undefined) {
    rows = all(`${base} AND m.id > ? ORDER BY m.id ASC LIMIT ?`, conversationId, viewerId, after, limit + 1);
    hasNewer = rows.length > limit; if (hasNewer) rows.pop();
    hasOlder = null;
  } else {
    rows = all(`${base} AND m.id < ? ORDER BY m.id DESC LIMIT ?`, conversationId, viewerId, before ?? Number.MAX_SAFE_INTEGER, limit + 1);
    hasOlder = rows.length > limit; if (hasOlder) rows.pop();
    rows.reverse();
  }
  return {
    messages: formatMessages(rows, viewerId),
    nextCursor: hasOlder ? rows[0]?.id ?? null : null,
    hasNewer
  };
}

export function lastVisibleMessage(conversationId, viewerId) {
  const row = one(`${SELECT} WHERE m.conversation_id = ? AND ${VISIBLE} ORDER BY m.id DESC LIMIT 1`, conversationId, viewerId);
  return row ? formatMessages([row], viewerId)[0] : null;
}

export function unreadCount(conversationId, viewerId, lastReadId) {
  return Number(one(`SELECT COUNT(*) count FROM messages m WHERE m.conversation_id = ? AND m.id > ? AND m.sender_id <> ? AND ${VISIBLE}`,
    conversationId, lastReadId || 0, viewerId, viewerId).count);
}

/** Sends a message event to every member, each rendered from that member's perspective. */
export function fanout(conversationId, event, messageId, recipients = memberIds(conversationId)) {
  for (const recipient of recipients) {
    const message = getMessage(messageId, recipient);
    if (message) sendMany([recipient], event, { conversationId: Number(conversationId), message });
  }
}

export function validClientId(value) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(text)) throw new HttpError(400, 'Invalid client message id.');
  return text;
}

/**
 * Inserts a message exactly once per (sender, clientId). Returns `{ id, created }`; when the same
 * clientId arrives again the original id is returned with `created: false` and nothing is re-sent.
 */
export function createMessage({ conversationId, senderId, kind, body = '', mediaId = null, stickerId = null, replyToId = null, storyId = null, forwardedFromId = null, clientId = null }) {
  if (clientId) {
    const existing = one('SELECT id, conversation_id FROM messages WHERE sender_id = ? AND client_id = ?', senderId, clientId);
    if (existing) {
      if (existing.conversation_id !== Number(conversationId)) throw new HttpError(409, 'That client message id was already used.');
      return { id: Number(existing.id), created: false };
    }
  }
  try {
    const id = transaction(() => {
      const result = run(`INSERT INTO messages(conversation_id, sender_id, kind, body, media_id, sticker_id, reply_to_id, story_id, forwarded_from_id, client_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, conversationId, senderId, kind, body, mediaId, stickerId, replyToId, storyId, forwardedFromId, clientId);
      run('UPDATE conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', conversationId);
      run('UPDATE conversation_members SET last_read_message_id = MAX(COALESCE(last_read_message_id, 0), ?) WHERE conversation_id = ? AND user_id = ?',
        result.lastInsertRowid, conversationId, senderId);
      return Number(result.lastInsertRowid);
    });
    return { id, created: true };
  } catch (error) {
    // The unique (sender_id, client_id) index is the last line of defence against concurrent duplicates.
    if (clientId && /UNIQUE/i.test(error.message)) {
      const existing = one('SELECT id FROM messages WHERE sender_id = ? AND client_id = ?', senderId, clientId);
      if (existing) return { id: Number(existing.id), created: false };
    }
    throw error;
  }
}
