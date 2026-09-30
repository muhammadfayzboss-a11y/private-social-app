import fs from 'node:fs';
import { all, one, run, transaction } from '../db.js';
import { rateLimit } from '../auth.js';
import { getOrCreateDirectConversation } from '../conversations.js';
import { MESSAGE_KINDS } from '../contracts.js';
import { ensureLinkPreview } from '../linkPreview.js';
import {
  assertMember, createMessage, fanout, firstLink, getMessage, lastVisibleMessage, listMessages, memberIds, rawMessage, unreadCount, validClientId, VISIBLE
} from '../messages.js';
import { notify, notifyMessage } from '../notifications.js';
import { blockedByIds, blockedEitherWay, isBlocked, readReceiptsEnabled } from '../privacy.js';
import { isOnline, sendMany } from '../realtime.js';
import { stickerFile, syncStickerPacks } from '../stickers.js';
import { cleanText, HttpError, iso, json, parseJson, publicUser } from '../utils.js';

const SENDABLE_KINDS = MESSAGE_KINDS.filter(kind => kind !== 'story_reply');
const FORWARDABLE_KINDS = new Set(['text', 'image', 'video', 'voice', 'sticker', 'story_reply', 'file']);
const MEDIA_PURPOSES = { image: ['chat'], video: ['chat'], voice: ['voice'], file: ['file'] };
const MEDIA_FAMILY = { image: /^image\//, video: /^video\//, voice: /^audio\//, file: /./ };

function optionalId(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new HttpError(400, 'Invalid cursor.');
  return number;
}

function idList(value, max = 100) {
  const ids = [...new Set((Array.isArray(value) ? value : []).map(Number))].filter(id => Number.isInteger(id) && id > 0);
  if (!ids.length) throw new HttpError(400, 'Choose at least one message.');
  if (ids.length > max) throw new HttpError(400, `You can act on up to ${max} messages at once.`);
  return ids;
}

function cleanWaveform(value) {
  if (!Array.isArray(value)) return null;
  const bars = value.slice(0, 64).map(item => Math.max(0, Math.min(100, Math.round(Number(item) || 0))));
  return bars.length ? JSON.stringify(bars) : null;
}

/** The founding "The Circle" group contains everyone and cannot be left. */
function mainGroupId() { return one("SELECT id FROM conversations WHERE kind = 'group' ORDER BY id LIMIT 1")?.id; }

function formatConversation(c, viewerId, hiddenFrom = blockedByIds(viewerId)) {
  const members = all(`SELECT u.* FROM conversation_members cm JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id = ? ORDER BY u.display_name`, c.id)
    .map(user => publicUser(user, isOnline(user.id), { self: user.id === viewerId, hiddenFrom }));
  const pinnedMessage = c.pinned_message_id ? getMessage(c.pinned_message_id, viewerId) : null;
  const other = c.kind === 'direct' ? members.find(member => member.id !== viewerId) : null;
  const lastMessage = lastVisibleMessage(c.id, viewerId);
  return {
    id: c.id, kind: c.kind,
    title: c.kind === 'direct' ? (other?.displayName || 'Direct message') : c.title,
    members,
    lastMessage,
    unread: unreadCount(c.id, viewerId, c.last_read_message_id),
    markedUnread: Boolean(Number(c.marked_unread)),
    lastReadMessageId: c.last_read_message_id || 0,
    pinned: Boolean(c.pinned_at), pinnedAt: iso(c.pinned_at), muted: Boolean(Number(c.muted)),
    archived: Boolean(c.archived_at), archivedAt: iso(c.archived_at),
    cleared: Number(c.cleared_before_id || 0) > 0 && !lastMessage,
    pinnedMessage: pinnedMessage && !pinnedMessage.deletedAt ? pinnedMessage : null,
    isMainGroup: c.kind === 'group' && c.id === mainGroupId(),
    createdBy: c.created_by,
    blocked: other ? { byMe: isBlocked(viewerId, other.id), byThem: isBlocked(other.id, viewerId) } : null,
    updatedAt: iso(c.updated_at)
  };
}

function membershipRow(conversationId, viewerId) {
  return assertMember(conversationId, viewerId);
}

function conversationFor(conversationId, viewerId) {
  return formatConversation(membershipRow(conversationId, viewerId), viewerId);
}

/** Pushes each member their own rendering of a conversation (titles and flags are viewer-specific). */
function broadcastConversation(conversationId, members = memberIds(conversationId)) {
  for (const member of members) {
    const row = one(`SELECT c.*, cm.muted, cm.pinned_at, cm.last_read_message_id, cm.archived_at, cm.marked_unread, cm.cleared_before_id
      FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id WHERE c.id = ? AND cm.user_id = ?`, conversationId, member);
    if (row) sendMany([member], 'conversation:updated', { conversation: formatConversation(row, member) });
  }
}

/** A soft delete keeps the row (so replies can say "deleted message") but strips all content. */
function deleteForEveryone(message) {
  transaction(() => {
    run(`UPDATE messages SET deleted_at = ?, body = '', media_id = NULL, sticker_id = NULL, link_url = NULL WHERE id = ?`, new Date().toISOString(), message.id);
    run('DELETE FROM message_reactions WHERE message_id = ?', message.id);
    run('UPDATE conversations SET pinned_message_id = NULL WHERE pinned_message_id = ?', message.id);
  });
}

function escapeLike(text) { return text.replace(/[\\%_]/g, char => `\\${char}`); }

/** Direct chats are closed in both directions once either member blocks the other. */
function assertCanSend(conversation, userId) {
  if (conversation.kind !== 'direct') return;
  const other = one('SELECT user_id FROM conversation_members WHERE conversation_id = ? AND user_id <> ?', conversation.id, userId)?.user_id;
  if (other && blockedEitherWay(userId, other)) throw new HttpError(403, isBlocked(userId, other) ? 'Unblock this member to send messages.' : 'You cannot message this member.');
}

/** "@username" mentions in groups reach the mentioned member even when the group is muted. */
function notifyMentions(conversation, sender, text) {
  if (conversation.kind !== 'group' || !text.includes('@')) return;
  const names = new Set([...text.matchAll(/(?:^|[^\w@])@([a-z0-9_]{3,24})\b/gi)].map(match => match[1].toLowerCase()));
  if (!names.size) return;
  const members = all(`SELECT u.id, u.username FROM conversation_members cm JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id = ?`, conversation.id);
  for (const member of members) {
    if (member.id !== sender.id && names.has(member.username.toLowerCase())) notify(member.id, sender.id, 'mention', 'conversation', conversation.id, text.slice(0, 100));
  }
}

function afterCreate(conversation, sender, id, { kind, text }) {
  const members = memberIds(conversation.id);
  // Everyone, including the sender's other tabs and devices, receives the event; clients dedupe by id.
  fanout(conversation.id, 'message:created', id, members);
  for (const recipient of members) notifyMessage(recipient, sender, conversation.id, { kind, body: text });
  notifyMentions(conversation, sender, text);
  const link = one('SELECT link_url FROM messages WHERE id = ?', id)?.link_url;
  if (link) ensureLinkPreview(link).then(changed => { if (changed) fanout(conversation.id, 'message:updated', id); }).catch(() => {});
}

export function registerChatRoutes(router) {
  router.get('/api/conversations', (req, res) => {
    const viewerId = req.session.user.id;
    const hiddenFrom = blockedByIds(viewerId);
    const rows = all(`SELECT c.*, cm.last_read_message_id, cm.pinned_at, cm.muted, cm.archived_at, cm.marked_unread, cm.cleared_before_id FROM conversations c
      JOIN conversation_members cm ON cm.conversation_id = c.id WHERE cm.user_id = ?`, viewerId);
    const conversations = rows.map(row => formatConversation(row, viewerId, hiddenFrom))
      // A chat deleted "for me" stays out of the list until someone writes in it again.
      .filter(conversation => !conversation.cleared)
      .sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        const at = conversation => new Date(conversation.lastMessage?.createdAt || conversation.updatedAt).getTime();
        return at(b) - at(a);
      });
    json(res, 200, { conversations });
  });

  router.get('/api/conversations/:id', (req, res, params) => {
    json(res, 200, { conversation: conversationFor(params.id, req.session.user.id) });
  });

  router.post('/api/conversations/direct', async (req, res) => {
    const body = await parseJson(req);
    const target = one('SELECT id FROM users WHERE id = ?', Number(body.userId));
    if (!target || target.id === req.session.user.id) throw new HttpError(400, 'Choose another member.');
    const conversationId = getOrCreateDirectConversation(req.session.user.id, target.id);
    // Opening a chat you previously deleted brings it back.
    run('UPDATE conversation_members SET archived_at = NULL WHERE conversation_id = ? AND user_id = ? AND archived_at IS NOT NULL AND cleared_before_id > 0', conversationId, req.session.user.id);
    json(res, 200, { conversationId });
  });

  router.post('/api/conversations/group', async (req, res) => {
    const body = await parseJson(req);
    const title = cleanText(body.title, 64, 'Group name');
    if (!title) throw new HttpError(400, 'Give the group a name.');
    const ids = [...new Set((Array.isArray(body.memberIds) ? body.memberIds : []).map(Number))].filter(id => id !== req.session.user.id);
    if (!ids.length) throw new HttpError(400, 'Add at least one member.');
    for (const id of ids) if (!one('SELECT id FROM users WHERE id = ?', id)) throw new HttpError(400, 'One of those members does not exist.');
    const conversationId = Number(transaction(() => {
      const created = run("INSERT INTO conversations(kind, title, created_by) VALUES ('group', ?, ?)", title, req.session.user.id);
      for (const id of [req.session.user.id, ...ids]) run('INSERT INTO conversation_members(conversation_id, user_id) VALUES (?, ?)', created.lastInsertRowid, id);
      return created.lastInsertRowid;
    }));
    broadcastConversation(conversationId);
    json(res, 201, { conversation: conversationFor(conversationId, req.session.user.id) });
  });

  router.patch('/api/conversations/:id', async (req, res, params) => {
    const conversation = membershipRow(params.id, req.session.user.id);
    if (conversation.kind !== 'group') throw new HttpError(400, 'Only groups can be renamed.');
    if (conversation.created_by !== req.session.user.id && req.session.user.role !== 'admin') throw new HttpError(403, 'Only the group creator or admin can rename it.');
    const body = await parseJson(req);
    const title = cleanText(body.title, 64, 'Group name');
    if (!title) throw new HttpError(400, 'Give the group a name.');
    run('UPDATE conversations SET title = ? WHERE id = ?', title, conversation.id);
    broadcastConversation(conversation.id);
    json(res, 200, { conversation: conversationFor(conversation.id, req.session.user.id) });
  });

  router.post('/api/conversations/:id/leave', (req, res, params) => {
    const conversation = membershipRow(params.id, req.session.user.id);
    if (conversation.kind !== 'group' || conversation.id === mainGroupId()) throw new HttpError(400, 'You cannot leave this conversation.');
    const remaining = memberIds(conversation.id).filter(id => id !== req.session.user.id);
    run('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?', conversation.id, req.session.user.id);
    sendMany([req.session.user.id], 'conversation:removed', { conversationId: conversation.id });
    broadcastConversation(conversation.id, remaining);
    json(res, 200, { ok: true });
  });

  // Per-member preferences: pin, mute, archive, and "mark as unread".
  router.post('/api/conversations/:id/settings', async (req, res, params) => {
    const conversation = membershipRow(params.id, req.session.user.id);
    const body = await parseJson(req);
    const userId = req.session.user.id;
    const update = (column, value) => run(`UPDATE conversation_members SET ${column} = ? WHERE conversation_id = ? AND user_id = ?`, value, conversation.id, userId);
    if (typeof body.pinned === 'boolean') update('pinned_at', body.pinned ? new Date().toISOString() : null);
    if (typeof body.muted === 'boolean') update('muted', body.muted ? 1 : 0);
    if (typeof body.archived === 'boolean') update('archived_at', body.archived ? new Date().toISOString() : null);
    if (typeof body.markedUnread === 'boolean') update('marked_unread', body.markedUnread ? 1 : 0);
    const formatted = conversationFor(conversation.id, userId);
    sendMany([userId], 'conversation:updated', { conversation: formatted });
    json(res, 200, { conversation: formatted });
  });

  /** "Delete chat" for me: hides the whole history from me only; the chat returns if someone writes again. */
  router.post('/api/conversations/:id/clear', (req, res, params) => {
    const conversation = membershipRow(params.id, req.session.user.id);
    const lastId = Number(one('SELECT MAX(id) id FROM messages WHERE conversation_id = ?', conversation.id)?.id || 0);
    run(`UPDATE conversation_members SET cleared_before_id = ?, last_read_message_id = MAX(COALESCE(last_read_message_id, 0), ?), marked_unread = 0, pinned_at = NULL
      WHERE conversation_id = ? AND user_id = ?`, lastId, lastId, conversation.id, req.session.user.id);
    sendMany([req.session.user.id], 'conversation:removed', { conversationId: conversation.id, cleared: true });
    json(res, 200, { ok: true });
  });

  router.get('/api/conversations/:id/messages', (req, res, params, url) => {
    const conversation = membershipRow(params.id, req.session.user.id);
    const query = url.searchParams;
    json(res, 200, listMessages(conversation.id, req.session.user.id, {
      before: optionalId(query.get('before')), after: optionalId(query.get('after')), around: optionalId(query.get('around'))
    }));
  });

  router.post('/api/conversations/:id/messages', async (req, res, params) => {
    const userId = req.session.user.id;
    const conversation = membershipRow(params.id, userId);
    rateLimit(`message:${userId}`, 60, 20000);
    assertCanSend(conversation, userId);
    const body = await parseJson(req);
    const kind = String(body.kind || 'text');
    if (!SENDABLE_KINDS.includes(kind)) throw new HttpError(400, 'Unsupported message type.');
    const clientId = validClientId(body.clientId);
    const text = cleanText(body.body, 4000, 'Message');
    const mediaId = body.mediaId ? Number(body.mediaId) : null;
    const stickerId = body.stickerId ? String(body.stickerId) : null;
    const replyToId = body.replyToId ? Number(body.replyToId) : null;

    if (kind === 'text' && !text) throw new HttpError(400, 'Message cannot be empty.');
    if (MEDIA_PURPOSES[kind]) {
      const purposes = MEDIA_PURPOSES[kind];
      const media = one(`SELECT id, mime_type FROM media WHERE id = ? AND owner_id = ? AND purpose IN (${purposes.map(() => '?').join(',')})`, mediaId, userId, ...purposes);
      if (!media) throw new HttpError(403, 'Invalid message media.');
      if (!MEDIA_FAMILY[kind].test(media.mime_type)) throw new HttpError(400, 'The attachment does not match the message type.');
    }
    if (kind === 'sticker' && !one('SELECT id FROM stickers WHERE id = ?', stickerId)) throw new HttpError(400, 'Sticker is unavailable.');
    if (replyToId && !one('SELECT id FROM messages WHERE id = ? AND conversation_id = ? AND deleted_at IS NULL', replyToId, conversation.id)) throw new HttpError(400, 'Reply target is invalid.');

    const { id, created } = createMessage({ conversationId: conversation.id, senderId: userId, kind, body: text, mediaId, stickerId, replyToId, clientId });
    if (!created) return json(res, 200, { message: getMessage(id, userId), duplicate: true });

    if (kind === 'voice') {
      const durationMs = Math.round(Number(body.durationMs));
      run('UPDATE media SET duration_ms = COALESCE(?, duration_ms), waveform = COALESCE(?, waveform) WHERE id = ? AND owner_id = ?',
        Number.isFinite(durationMs) && durationMs > 0 && durationMs < 3600000 ? durationMs : null, cleanWaveform(body.waveform), mediaId, userId);
    }
    if (stickerId) run(`INSERT INTO user_stickers(user_id,sticker_id,last_used_at,use_count) VALUES (?,?,CURRENT_TIMESTAMP,1)
      ON CONFLICT(user_id,sticker_id) DO UPDATE SET last_used_at=CURRENT_TIMESTAMP,use_count=use_count+1`, userId, stickerId);
    // Writing in a chat you had marked as unread means you have obviously read it.
    run('UPDATE conversation_members SET marked_unread = 0 WHERE conversation_id = ? AND user_id = ?', conversation.id, userId);

    afterCreate(conversation, req.session.user, id, { kind, text });
    json(res, 201, { message: getMessage(id, userId) });
  });

  router.post('/api/conversations/:id/read', async (req, res, params) => {
    const conversation = membershipRow(params.id, req.session.user.id);
    const body = await parseJson(req);
    const messageId = Number(body.messageId || 0);
    if (messageId && !one('SELECT id FROM messages WHERE id = ? AND conversation_id = ?', messageId, conversation.id)) throw new HttpError(400, 'Invalid message.');
    const changed = run(`UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ? AND COALESCE(last_read_message_id, 0) < ?`,
      messageId, conversation.id, req.session.user.id, messageId).changes;
    run('UPDATE conversation_members SET marked_unread = 0 WHERE conversation_id = ? AND user_id = ?', conversation.id, req.session.user.id);
    // Only an advancing read pointer is news. Members with read receipts off only tell their own devices.
    if (changed) {
      const audience = readReceiptsEnabled(req.session.user.id) ? memberIds(conversation.id) : [req.session.user.id];
      sendMany(audience, 'message:read', { conversationId: conversation.id, userId: req.session.user.id, messageId });
    }
    json(res, 200, { ok: true, unread: unreadCount(conversation.id, req.session.user.id, Math.max(messageId, conversation.last_read_message_id || 0)) });
  });

  router.post('/api/conversations/:id/typing', async (req, res, params) => {
    const conversation = membershipRow(params.id, req.session.user.id);
    const body = await parseJson(req);
    const recipients = memberIds(conversation.id).filter(id => id !== req.session.user.id && !blockedEitherWay(id, req.session.user.id));
    sendMany(recipients, 'typing', { conversationId: conversation.id, userId: req.session.user.id, typing: Boolean(body.typing), kind: body.kind === 'voice' ? 'voice' : 'text' });
    json(res, 200, { ok: true });
  });

  router.post('/api/conversations/:id/pin', async (req, res, params) => {
    const conversation = membershipRow(params.id, req.session.user.id);
    const body = await parseJson(req);
    const messageId = body.messageId ? Number(body.messageId) : null;
    if (messageId && !one('SELECT id FROM messages WHERE id = ? AND conversation_id = ? AND deleted_at IS NULL', messageId, conversation.id)) throw new HttpError(400, 'That message cannot be pinned.');
    run('UPDATE conversations SET pinned_message_id = ? WHERE id = ?', messageId, conversation.id);
    for (const member of memberIds(conversation.id)) {
      sendMany([member], 'conversation:pinned', { conversationId: conversation.id, pinnedMessage: messageId ? getMessage(messageId, member) : null });
    }
    json(res, 200, { pinnedMessage: messageId ? getMessage(messageId, req.session.user.id) : null });
  });

  /** Shared content of one chat: media (photos/videos), files, links, or voice messages, newest first. */
  router.get('/api/conversations/:id/media', (req, res, params, url) => {
    const conversation = membershipRow(params.id, req.session.user.id);
    const type = url.searchParams.get('type') || 'all';
    const before = optionalId(url.searchParams.get('before')) ?? Number.MAX_SAFE_INTEGER;
    const filters = {
      all: "m.kind IN ('image','video','voice','file') AND m.media_id IS NOT NULL",
      media: "m.kind IN ('image','video') AND m.media_id IS NOT NULL",
      files: "m.kind = 'file' AND m.media_id IS NOT NULL",
      voice: "m.kind = 'voice' AND m.media_id IS NOT NULL",
      links: "m.link_url IS NOT NULL"
    };
    if (!filters[type]) throw new HttpError(400, 'Unknown media type.');
    const viewerId = req.session.user.id;
    const rows = all(`SELECT m.id FROM messages m WHERE m.conversation_id = ? AND ${filters[type]} AND m.id < ? AND ${VISIBLE}
      ORDER BY m.id DESC LIMIT 61`, conversation.id, before, viewerId, viewerId);
    const page = rows.slice(0, 60);
    const items = page.map(row => getMessage(row.id, viewerId)).filter(Boolean);
    json(res, 200, { items, nextCursor: rows.length > 60 ? page.at(-1).id : null });
  });

  router.patch('/api/messages/:id', async (req, res, params) => {
    const message = rawMessage(params.id);
    membershipRow(message.conversation_id, req.session.user.id);
    if (message.sender_id !== req.session.user.id) throw new HttpError(403, 'You can edit only your own messages.');
    if (message.deleted_at) throw new HttpError(410, 'This message was deleted.');
    if (!['text', 'image', 'video', 'file'].includes(message.kind)) throw new HttpError(400, 'This message cannot be edited.');
    const body = await parseJson(req);
    const text = cleanText(body.body, 4000, 'Message');
    if (!text && message.kind === 'text') throw new HttpError(400, 'Message cannot be empty.');
    if (text !== message.body) {
      const link = message.kind === 'text' ? firstLink(text) : null;
      run('UPDATE messages SET body = ?, edited_at = ?, link_url = ? WHERE id = ?', text, new Date().toISOString(), link, message.id);
      fanout(message.conversation_id, 'message:updated', message.id);
      if (link) ensureLinkPreview(link).then(changed => { if (changed) fanout(message.conversation_id, 'message:updated', message.id); }).catch(() => {});
    }
    json(res, 200, { message: getMessage(message.id, req.session.user.id) });
  });

  function deleteMessages(conversationId, userId, ids, scope) {
    const rows = ids.map(id => one('SELECT * FROM messages WHERE id = ? AND conversation_id = ?', id, conversationId));
    if (rows.some(row => !row)) throw new HttpError(404, 'One of those messages does not exist in this chat.');
    if (scope === 'everyone' && rows.some(row => row.sender_id !== userId)) throw new HttpError(403, 'You can delete only your own message.');
    if (scope === 'everyone') {
      for (const row of rows) if (!row.deleted_at) deleteForEveryone(row);
      for (const row of rows) sendMany(memberIds(conversationId), 'message:deleted', { conversationId, messageId: row.id, scope: 'everyone' });
    } else {
      transaction(() => { for (const row of rows) run('INSERT OR IGNORE INTO message_hidden(message_id, user_id) VALUES (?, ?)', row.id, userId); });
      for (const row of rows) sendMany([userId], 'message:deleted', { conversationId, messageId: row.id, scope: 'me' });
    }
  }

  /**
   * scope=everyone (default for your own messages) removes the content for all members and syncs the
   * removal in real time; scope=me hides any message from your own history only.
   */
  router.delete('/api/messages/:id', (req, res, params, url) => {
    const message = rawMessage(params.id);
    membershipRow(message.conversation_id, req.session.user.id);
    const isMine = message.sender_id === req.session.user.id;
    const scope = url.searchParams.get('scope') || (isMine ? 'everyone' : 'me');
    if (!['everyone', 'me'].includes(scope)) throw new HttpError(400, 'Unknown delete scope.');
    deleteMessages(message.conversation_id, req.session.user.id, [message.id], scope);
    json(res, 200, { ok: true, scope });
  });

  router.post('/api/conversations/:id/messages/delete', async (req, res, params) => {
    const conversation = membershipRow(params.id, req.session.user.id);
    const body = await parseJson(req);
    const scope = body.scope === 'everyone' ? 'everyone' : 'me';
    const ids = idList(body.messageIds);
    deleteMessages(conversation.id, req.session.user.id, ids, scope);
    json(res, 200, { ok: true, scope, deleted: ids.length });
  });

  router.post('/api/messages/:id/reaction', async (req, res, params) => {
    const message = rawMessage(params.id);
    membershipRow(message.conversation_id, req.session.user.id);
    if (message.deleted_at) throw new HttpError(410, 'This message was deleted.');
    const body = await parseJson(req);
    const selected = cleanText(body.reaction, 16, 'Reaction');
    const previous = one('SELECT reaction FROM message_reactions WHERE message_id = ? AND user_id = ?', message.id, req.session.user.id)?.reaction;
    if (selected) run(`INSERT INTO message_reactions(message_id,user_id,reaction) VALUES (?,?,?) ON CONFLICT(message_id,user_id) DO UPDATE SET reaction=excluded.reaction, created_at=CURRENT_TIMESTAMP`, message.id, req.session.user.id, selected);
    else run('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?', message.id, req.session.user.id);
    fanout(message.conversation_id, 'message:reaction', message.id);
    if (selected && selected !== previous) notify(message.sender_id, req.session.user.id, 'message_reaction', 'conversation', message.conversation_id, selected);
    json(res, 200, { message: getMessage(message.id, req.session.user.id) });
  });

  function forward(sourceIds, targets, user) {
    const sources = sourceIds.map(id => rawMessage(id));
    for (const source of sources) {
      membershipRow(source.conversation_id, user.id);
      if (source.deleted_at) throw new HttpError(410, 'One of those messages was deleted.');
      if (!FORWARDABLE_KINDS.has(source.kind)) throw new HttpError(400, 'This message cannot be forwarded.');
    }
    const conversations = targets.map(target => membershipRow(target, user.id));
    for (const conversation of conversations) assertCanSend(conversation, user.id);
    rateLimit(`message:${user.id}`, 60, 20000);
    const created = [];
    for (const conversation of conversations) {
      for (const source of sources.sort((a, b) => a.id - b.id)) {
        const kind = source.kind === 'story_reply' ? 'text' : source.kind;
        const { id } = createMessage({
          conversationId: conversation.id, senderId: user.id, kind, body: source.body,
          mediaId: source.media_id, stickerId: source.sticker_id, forwardedFromId: source.forwarded_from_id || source.sender_id
        });
        afterCreate(conversation, user, id, { kind, text: source.body });
        created.push(getMessage(id, user.id));
      }
    }
    return created;
  }

  router.post('/api/messages/:id/forward', async (req, res, params) => {
    const body = await parseJson(req);
    const targets = [...new Set((Array.isArray(body.conversationIds) ? body.conversationIds : []).map(Number))].slice(0, 10);
    if (!targets.length) throw new HttpError(400, 'Choose at least one chat.');
    json(res, 201, { messages: forward([Number(params.id)], targets, req.session.user) });
  });

  router.post('/api/messages/forward', async (req, res) => {
    const body = await parseJson(req);
    const targets = [...new Set((Array.isArray(body.conversationIds) ? body.conversationIds : []).map(Number))].slice(0, 10);
    if (!targets.length) throw new HttpError(400, 'Choose at least one chat.');
    json(res, 201, { messages: forward(idList(body.messageIds, 50), targets, req.session.user) });
  });

  /**
   * Searches only what the caller can already read: messages in their own conversations (excluding
   * deleted/hidden/cleared ones), member names and usernames, and posts. `type` narrows to media,
   * files, links, or voice; `conversationId` searches inside one chat.
   */
  router.get('/api/search', (req, res, params, url) => {
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 80);
    const type = url.searchParams.get('type') || 'all';
    const conversationId = optionalId(url.searchParams.get('conversationId'));
    const viewerId = req.session.user.id;
    if (conversationId) membershipRow(conversationId, viewerId);
    const needsQuery = type === 'all' || type === 'messages';
    if (needsQuery && q.length < 2) return json(res, 200, { query: q, members: [], messages: [], posts: [] });
    const like = `%${escapeLike(q)}%`;
    const hiddenFrom = blockedByIds(viewerId);
    const members = type === 'all' && !conversationId ? all(`SELECT * FROM users WHERE (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\') ORDER BY display_name LIMIT 10`, like, like)
      .map(user => publicUser(user, isOnline(user.id), { self: user.id === viewerId, hiddenFrom })) : [];
    const kindFilter = {
      all: "m.kind IN ('text','story_reply','image','video','file') AND (m.body LIKE ? ESCAPE '\\' OR med.original_name LIKE ? ESCAPE '\\')",
      messages: "m.kind IN ('text','story_reply') AND m.body LIKE ? ESCAPE '\\'",
      media: "m.kind IN ('image','video') AND m.media_id IS NOT NULL",
      files: "m.kind = 'file' AND m.media_id IS NOT NULL",
      links: 'm.link_url IS NOT NULL',
      voice: "m.kind = 'voice' AND m.media_id IS NOT NULL"
    }[type];
    if (!kindFilter) throw new HttpError(400, 'Unknown search filter.');
    const textParams = type === 'all' ? [like, like] : type === 'messages' ? [like] : [];
    const optionalText = !needsQuery && q.length >= 2 ? " AND (m.body LIKE ? ESCAPE '\\' OR med.original_name LIKE ? ESCAPE '\\' OR m.link_url LIKE ? ESCAPE '\\')" : '';
    const optionalParams = optionalText ? [like, like, like] : [];
    const rows = all(`SELECT m.id FROM messages m
      JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
      LEFT JOIN media med ON med.id = m.media_id
      WHERE ${VISIBLE} AND ${kindFilter}${optionalText} ${conversationId ? 'AND m.conversation_id = ?' : ''}
      ORDER BY m.id DESC LIMIT ${conversationId ? 200 : 40}`,
      viewerId, viewerId, viewerId, ...textParams, ...optionalParams, ...(conversationId ? [conversationId] : []));
    const titles = new Map();
    const messages = rows.map(row => getMessage(row.id, viewerId)).filter(Boolean).map(message => {
      if (!titles.has(message.conversationId)) titles.set(message.conversationId, conversationFor(message.conversationId, viewerId).title);
      return { ...message, conversationTitle: titles.get(message.conversationId) };
    });
    const posts = type === 'all' && !conversationId ? all(`SELECT p.id, p.body, p.created_at, u.id author_id, u.display_name FROM posts p JOIN users u ON u.id = p.author_id
      WHERE p.body LIKE ? ESCAPE '\\' ORDER BY p.id DESC LIMIT 10`, like)
      .map(post => ({ id: post.id, body: post.body.slice(0, 200), createdAt: iso(post.created_at), author: { id: post.author_id, displayName: post.display_name } })) : [];
    json(res, 200, { query: q, type, members, messages, posts });
  });

  router.get('/api/stickers', (req, res) => {
    const favorites = new Set(all('SELECT sticker_id FROM user_stickers WHERE user_id = ? AND favorite = 1', req.session.user.id).map(row => row.sticker_id));
    const packs = all('SELECT * FROM sticker_packs WHERE active=1 ORDER BY sort_order,name').map(p => ({
      ...p, coverUrl: p.cover_sticker_id ? `/api/stickers/${p.cover_sticker_id}/file` : null,
      stickers: all('SELECT id,name FROM stickers WHERE pack_id=? ORDER BY sort_order,name', p.id).map(s => ({ ...s, url: `/api/stickers/${s.id}/file`, favorite: favorites.has(s.id) }))
    }));
    const recent = all(`SELECT s.id,s.name FROM user_stickers us JOIN stickers s ON s.id=us.sticker_id WHERE us.user_id=? AND us.last_used_at IS NOT NULL ORDER BY us.last_used_at DESC LIMIT 20`, req.session.user.id)
      .map(s => ({ ...s, url: `/api/stickers/${s.id}/file` }));
    json(res, 200, { packs, recent });
  });
  router.post('/api/stickers/reload', (req, res) => {
    if (req.session.user.role !== 'admin') throw new HttpError(403, 'Only the group admin can reload sticker packs.');
    json(res, 200, { stickersLoaded: syncStickerPacks() });
  });
  router.get('/api/stickers/:id/file', (req, res, params) => {
    const sticker = one('SELECT * FROM stickers WHERE id=?', params.id);
    if (!sticker) throw new HttpError(404, 'Sticker not found.');
    const file = stickerFile(sticker);
    if (!file || !fs.existsSync(file)) throw new HttpError(404, 'Sticker file is missing.');
    const stat = fs.statSync(file);
    res.writeHead(200, { 'content-type': sticker.mime_type, 'content-length': stat.size, 'cache-control': 'private, max-age=604800', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" });
    fs.createReadStream(file).pipe(res);
  });
  router.post('/api/stickers/:id/favorite', async (req, res, params) => {
    if (!one('SELECT id FROM stickers WHERE id=?', params.id)) throw new HttpError(404, 'Sticker not found.');
    const body = await parseJson(req);
    run(`INSERT INTO user_stickers(user_id,sticker_id,favorite) VALUES (?,?,?) ON CONFLICT(user_id,sticker_id) DO UPDATE SET favorite=excluded.favorite`, req.session.user.id, params.id, body.favorite ? 1 : 0);
    json(res, 200, { favorite: Boolean(body.favorite) });
  });
}
