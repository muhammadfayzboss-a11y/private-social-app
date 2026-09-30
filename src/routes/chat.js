import fs from 'node:fs';
import { all, one, run, transaction } from '../db.js';
import { rateLimit } from '../auth.js';
import { getOrCreateDirectConversation } from '../conversations.js';
import { MESSAGE_KINDS } from '../contracts.js';
import {
  assertMember, createMessage, fanout, formatMessages, getMessage, lastVisibleMessage, listMessages, memberIds, rawMessage, unreadCount, validClientId
} from '../messages.js';
import { notifyMessage } from '../notifications.js';
import { isOnline, sendMany } from '../realtime.js';
import { stickerFile, syncStickerPacks } from '../stickers.js';
import { cleanText, HttpError, iso, json, parseJson, publicUser } from '../utils.js';

const SENDABLE_KINDS = MESSAGE_KINDS.filter(kind => kind !== 'story_reply');
const FORWARDABLE_KINDS = new Set(['text', 'image', 'video', 'voice', 'sticker', 'story_reply']);

function optionalId(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new HttpError(400, 'Invalid cursor.');
  return number;
}

function cleanWaveform(value) {
  if (!Array.isArray(value)) return null;
  const bars = value.slice(0, 64).map(item => Math.max(0, Math.min(100, Math.round(Number(item) || 0))));
  return bars.length ? JSON.stringify(bars) : null;
}

function formatConversation(c, viewerId) {
  const members = all(`SELECT u.* FROM conversation_members cm JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id = ? ORDER BY u.display_name`, c.id)
    .map(user => publicUser(user, isOnline(user.id), { self: user.id === viewerId }));
  const pinnedMessage = c.pinned_message_id ? getMessage(c.pinned_message_id, viewerId) : null;
  return {
    id: c.id, kind: c.kind,
    title: c.kind === 'direct' ? (members.find(member => member.id !== viewerId)?.displayName || 'Direct message') : c.title,
    members,
    lastMessage: lastVisibleMessage(c.id, viewerId),
    unread: unreadCount(c.id, viewerId, c.last_read_message_id),
    lastReadMessageId: c.last_read_message_id || 0,
    pinned: Boolean(c.pinned_at), pinnedAt: iso(c.pinned_at), muted: Boolean(Number(c.muted)),
    pinnedMessage: pinnedMessage && !pinnedMessage.deletedAt ? pinnedMessage : null,
    updatedAt: iso(c.updated_at)
  };
}

function conversationFor(conversationId, viewerId) {
  return formatConversation(assertMember(conversationId, viewerId), viewerId);
}

/** A soft delete keeps the row (so replies can say "deleted message") but strips all content. */
function deleteForEveryone(message) {
  transaction(() => {
    run(`UPDATE messages SET deleted_at = ?, body = '', media_id = NULL, sticker_id = NULL WHERE id = ?`, new Date().toISOString(), message.id);
    run('DELETE FROM message_reactions WHERE message_id = ?', message.id);
    run('UPDATE conversations SET pinned_message_id = NULL WHERE pinned_message_id = ?', message.id);
  });
}

function escapeLike(text) { return text.replace(/[\\%_]/g, char => `\\${char}`); }

export function registerChatRoutes(router) {
  router.get('/api/conversations', (req, res) => {
    const viewerId = req.session.user.id;
    const rows = all(`SELECT c.*, cm.last_read_message_id, cm.pinned_at, cm.muted FROM conversations c
      JOIN conversation_members cm ON cm.conversation_id = c.id WHERE cm.user_id = ?`, viewerId);
    const conversations = rows.map(row => formatConversation(row, viewerId)).sort((a, b) => {
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
    json(res, 200, { conversationId: getOrCreateDirectConversation(req.session.user.id, target.id) });
  });

  // Per-member preferences: pinning a chat to the top of the list and muting its notifications.
  router.post('/api/conversations/:id/settings', async (req, res, params) => {
    const conversation = assertMember(params.id, req.session.user.id);
    const body = await parseJson(req);
    if (typeof body.pinned === 'boolean') run('UPDATE conversation_members SET pinned_at = ? WHERE conversation_id = ? AND user_id = ?', body.pinned ? new Date().toISOString() : null, conversation.id, req.session.user.id);
    if (typeof body.muted === 'boolean') run('UPDATE conversation_members SET muted = ? WHERE conversation_id = ? AND user_id = ?', body.muted ? 1 : 0, conversation.id, req.session.user.id);
    const formatted = conversationFor(conversation.id, req.session.user.id);
    sendMany([req.session.user.id], 'conversation:updated', { conversation: formatted });
    json(res, 200, { conversation: formatted });
  });

  router.get('/api/conversations/:id/messages', (req, res, params, url) => {
    const conversation = assertMember(params.id, req.session.user.id);
    const query = url.searchParams;
    json(res, 200, listMessages(conversation.id, req.session.user.id, {
      before: optionalId(query.get('before')), after: optionalId(query.get('after')), around: optionalId(query.get('around'))
    }));
  });

  router.post('/api/conversations/:id/messages', async (req, res, params) => {
    const userId = req.session.user.id;
    const conversation = assertMember(params.id, userId);
    rateLimit(`message:${userId}`, 60, 20000);
    const body = await parseJson(req);
    const kind = String(body.kind || 'text');
    if (!SENDABLE_KINDS.includes(kind)) throw new HttpError(400, 'Unsupported message type.');
    const clientId = validClientId(body.clientId);
    const text = cleanText(body.body, 4000, 'Message');
    const mediaId = body.mediaId ? Number(body.mediaId) : null;
    const stickerId = body.stickerId ? String(body.stickerId) : null;
    const replyToId = body.replyToId ? Number(body.replyToId) : null;

    if (kind === 'text' && !text) throw new HttpError(400, 'Message cannot be empty.');
    if (['image', 'video', 'voice'].includes(kind)) {
      const purposes = kind === 'voice' ? ['voice'] : ['chat'];
      const media = one(`SELECT id, mime_type FROM media WHERE id = ? AND owner_id = ? AND purpose IN (${purposes.map(() => '?').join(',')})`, mediaId, userId, ...purposes);
      if (!media) throw new HttpError(403, 'Invalid message media.');
      const family = kind === 'voice' ? 'audio/' : kind === 'image' ? 'image/' : 'video/';
      if (!media.mime_type.startsWith(family)) throw new HttpError(400, 'The attachment does not match the message type.');
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

    // Everyone, including the sender's other tabs and devices, receives the event; clients dedupe by id.
    const members = memberIds(conversation.id);
    fanout(conversation.id, 'message:created', id, members);
    for (const recipient of members) notifyMessage(recipient, req.session.user, conversation.id, { kind, body: text });
    json(res, 201, { message: getMessage(id, userId) });
  });

  router.post('/api/conversations/:id/read', async (req, res, params) => {
    const conversation = assertMember(params.id, req.session.user.id);
    const body = await parseJson(req);
    const messageId = Number(body.messageId || 0);
    if (messageId && !one('SELECT id FROM messages WHERE id = ? AND conversation_id = ?', messageId, conversation.id)) throw new HttpError(400, 'Invalid message.');
    const changed = run(`UPDATE conversation_members SET last_read_message_id = ? WHERE conversation_id = ? AND user_id = ? AND COALESCE(last_read_message_id, 0) < ?`,
      messageId, conversation.id, req.session.user.id, messageId).changes;
    // Only an advancing read pointer is news; repeated reads of the same message are silent.
    if (changed) sendMany(memberIds(conversation.id), 'message:read', { conversationId: conversation.id, userId: req.session.user.id, messageId });
    json(res, 200, { ok: true, unread: unreadCount(conversation.id, req.session.user.id, Math.max(messageId, conversation.last_read_message_id || 0)) });
  });

  router.post('/api/conversations/:id/typing', async (req, res, params) => {
    const conversation = assertMember(params.id, req.session.user.id);
    const body = await parseJson(req);
    sendMany(memberIds(conversation.id).filter(id => id !== req.session.user.id), 'typing', { conversationId: conversation.id, userId: req.session.user.id, typing: Boolean(body.typing), kind: body.kind === 'voice' ? 'voice' : 'text' });
    json(res, 200, { ok: true });
  });

  router.post('/api/conversations/:id/pin', async (req, res, params) => {
    const conversation = assertMember(params.id, req.session.user.id);
    const body = await parseJson(req);
    const messageId = body.messageId ? Number(body.messageId) : null;
    if (messageId && !one('SELECT id FROM messages WHERE id = ? AND conversation_id = ? AND deleted_at IS NULL', messageId, conversation.id)) throw new HttpError(400, 'That message cannot be pinned.');
    run('UPDATE conversations SET pinned_message_id = ? WHERE id = ?', messageId, conversation.id);
    for (const member of memberIds(conversation.id)) {
      sendMany([member], 'conversation:pinned', { conversationId: conversation.id, pinnedMessage: messageId ? getMessage(messageId, member) : null });
    }
    json(res, 200, { pinnedMessage: messageId ? getMessage(messageId, req.session.user.id) : null });
  });

  // Photos and videos shared in one conversation, newest first, for the chat's media gallery.
  router.get('/api/conversations/:id/media', (req, res, params, url) => {
    const conversation = assertMember(params.id, req.session.user.id);
    const before = optionalId(url.searchParams.get('before')) ?? Number.MAX_SAFE_INTEGER;
    const rows = all(`SELECT m.id FROM messages m WHERE m.conversation_id = ? AND m.kind IN ('image','video','voice') AND m.media_id IS NOT NULL
      AND m.deleted_at IS NULL AND m.id < ? AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?)
      ORDER BY m.id DESC LIMIT 61`, conversation.id, before, req.session.user.id);
    const page = rows.slice(0, 60);
    const messages = page.map(row => getMessage(row.id, req.session.user.id)).filter(Boolean);
    json(res, 200, { items: messages, nextCursor: rows.length > 60 ? page.at(-1).id : null });
  });

  router.patch('/api/messages/:id', async (req, res, params) => {
    const message = rawMessage(params.id);
    assertMember(message.conversation_id, req.session.user.id);
    if (message.sender_id !== req.session.user.id) throw new HttpError(403, 'You can edit only your own messages.');
    if (message.deleted_at) throw new HttpError(410, 'This message was deleted.');
    if (message.kind !== 'text') throw new HttpError(400, 'Only text messages can be edited.');
    const body = await parseJson(req);
    const text = cleanText(body.body, 4000, 'Message');
    if (!text) throw new HttpError(400, 'Message cannot be empty.');
    if (text !== message.body) {
      run('UPDATE messages SET body = ?, edited_at = ? WHERE id = ?', text, new Date().toISOString(), message.id);
      fanout(message.conversation_id, 'message:updated', message.id);
    }
    json(res, 200, { message: getMessage(message.id, req.session.user.id) });
  });

  /**
   * scope=everyone (default for your own messages) removes the content for all members and syncs the
   * removal in real time; scope=me hides any message from your own history only.
   */
  router.delete('/api/messages/:id', (req, res, params, url) => {
    const message = rawMessage(params.id);
    assertMember(message.conversation_id, req.session.user.id);
    const isMine = message.sender_id === req.session.user.id;
    const scope = url.searchParams.get('scope') || (isMine ? 'everyone' : 'me');
    if (!['everyone', 'me'].includes(scope)) throw new HttpError(400, 'Unknown delete scope.');
    if (scope === 'everyone') {
      if (!isMine) throw new HttpError(403, 'You can delete only your own message.');
      if (!message.deleted_at) deleteForEveryone(message);
      sendMany(memberIds(message.conversation_id), 'message:deleted', { conversationId: message.conversation_id, messageId: message.id, scope: 'everyone' });
    } else {
      run('INSERT OR IGNORE INTO message_hidden(message_id, user_id) VALUES (?, ?)', message.id, req.session.user.id);
      sendMany([req.session.user.id], 'message:deleted', { conversationId: message.conversation_id, messageId: message.id, scope: 'me' });
    }
    json(res, 200, { ok: true, scope });
  });

  router.post('/api/messages/:id/reaction', async (req, res, params) => {
    const message = rawMessage(params.id);
    assertMember(message.conversation_id, req.session.user.id);
    if (message.deleted_at) throw new HttpError(410, 'This message was deleted.');
    const body = await parseJson(req);
    const selected = cleanText(body.reaction, 16, 'Reaction');
    if (selected) run(`INSERT INTO message_reactions(message_id,user_id,reaction) VALUES (?,?,?) ON CONFLICT(message_id,user_id) DO UPDATE SET reaction=excluded.reaction, created_at=CURRENT_TIMESTAMP`, message.id, req.session.user.id, selected);
    else run('DELETE FROM message_reactions WHERE message_id = ? AND user_id = ?', message.id, req.session.user.id);
    fanout(message.conversation_id, 'message:reaction', message.id);
    json(res, 200, { message: getMessage(message.id, req.session.user.id) });
  });

  router.post('/api/messages/:id/forward', async (req, res, params) => {
    const source = rawMessage(params.id);
    assertMember(source.conversation_id, req.session.user.id);
    if (source.deleted_at) throw new HttpError(410, 'This message was deleted.');
    if (!FORWARDABLE_KINDS.has(source.kind)) throw new HttpError(400, 'This message cannot be forwarded.');
    const body = await parseJson(req);
    const targets = [...new Set((Array.isArray(body.conversationIds) ? body.conversationIds : []).map(Number))].slice(0, 10);
    if (!targets.length) throw new HttpError(400, 'Choose at least one chat.');
    for (const target of targets) assertMember(target, req.session.user.id);
    rateLimit(`message:${req.session.user.id}`, 60, 20000);
    const originalSender = source.forwarded_from_id || source.sender_id;
    const created = targets.map(target => {
      const { id } = createMessage({
        conversationId: target, senderId: req.session.user.id, kind: source.kind === 'story_reply' ? 'text' : source.kind,
        body: source.body, mediaId: source.media_id, stickerId: source.sticker_id, forwardedFromId: originalSender
      });
      fanout(target, 'message:created', id);
      for (const recipient of memberIds(target)) notifyMessage(recipient, req.session.user, target, { kind: source.kind, body: source.body });
      return getMessage(id, req.session.user.id);
    });
    json(res, 201, { messages: created });
  });

  /**
   * Searches only what the caller can already read: messages in their own conversations (excluding
   * deleted/hidden ones), member names, and posts.
   */
  router.get('/api/search', (req, res, params, url) => {
    const q = String(url.searchParams.get('q') || '').trim().slice(0, 80);
    if (q.length < 2) return json(res, 200, { query: q, members: [], messages: [], posts: [] });
    const viewerId = req.session.user.id;
    const like = `%${escapeLike(q)}%`;
    const members = all(`SELECT * FROM users WHERE (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\') ORDER BY display_name LIMIT 10`, like, like)
      .map(user => publicUser(user, isOnline(user.id), { self: user.id === viewerId }));
    const messageRows = all(`SELECT m.*, u.username sender_username, u.display_name sender_display_name, u.avatar_media_id sender_avatar_media_id,
        NULL mime_type, NULL duration_ms, NULL waveform, NULL media_width, NULL media_height, NULL sticker_name,
        NULL reply_body, NULL reply_kind, NULL reply_deleted, NULL reply_sender_id, NULL reply_sender_name, NULL forwarded_name
      FROM messages m JOIN users u ON u.id = m.sender_id
      JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
      WHERE m.deleted_at IS NULL AND m.kind IN ('text','story_reply') AND m.body LIKE ? ESCAPE '\\'
        AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?)
      ORDER BY m.id DESC LIMIT 30`, viewerId, like, viewerId);
    const titles = new Map();
    const messages = formatMessages(messageRows, viewerId).map(message => {
      if (!titles.has(message.conversationId)) titles.set(message.conversationId, conversationFor(message.conversationId, viewerId).title);
      return { ...message, conversationTitle: titles.get(message.conversationId) };
    });
    const posts = all(`SELECT p.id, p.body, p.created_at, u.id author_id, u.display_name FROM posts p JOIN users u ON u.id = p.author_id
      WHERE p.body LIKE ? ESCAPE '\\' ORDER BY p.id DESC LIMIT 10`, like)
      .map(post => ({ id: post.id, body: post.body.slice(0, 200), createdAt: iso(post.created_at), author: { id: post.author_id, displayName: post.display_name } }));
    json(res, 200, { query: q, members, messages, posts });
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
