import { REACTIONS } from '../contracts.js';
import { all, one, run, transaction } from '../db.js';
import { isOnline, broadcast } from '../realtime.js';
import { notify } from '../notifications.js';
import { receiveUpload, sendMedia, UPLOAD_PURPOSES } from '../storage.js';
import { rateLimit } from '../auth.js';
import { blockedByIds, isBlocked } from '../privacy.js';
import { cleanText, HttpError, iso, json, parseJson, publicUser } from '../utils.js';

const allowedReactions = new Set(REACTIONS);
function reaction(value) {
  const result = String(value || 'heart');
  if (!allowedReactions.has(result)) throw new HttpError(400, 'Unsupported reaction.');
  return result;
}

function formatComment(row, viewerId) {
  const reactions = all('SELECT reaction, COUNT(*) count FROM comment_reactions WHERE comment_id = ? GROUP BY reaction', row.id);
  const mine = one('SELECT reaction FROM comment_reactions WHERE comment_id = ? AND user_id = ?', row.id, viewerId)?.reaction || null;
  return {
    id: row.id, postId: row.post_id, parentId: row.parent_id, body: row.body, editedAt: iso(row.edited_at), createdAt: iso(row.created_at),
    author: { id: row.author_id, username: row.username, displayName: row.display_name, avatarUrl: row.avatar_media_id ? `/api/media/${row.avatar_media_id}` : null },
    reactions: Object.fromEntries(reactions.map(item => [item.reaction, Number(item.count)])), viewerReaction: mine
  };
}

export function formatPost(row, viewerId) {
  const media = all(`SELECT m.id, m.mime_type, m.width, m.height, m.duration_ms FROM post_media pm JOIN media m ON m.id = pm.media_id
    WHERE pm.post_id = ? ORDER BY pm.position`, row.id).map(item => ({ id: item.id, url: `/api/media/${item.id}`, mimeType: item.mime_type, width: item.width, height: item.height, durationMs: item.duration_ms }));
  const reactions = all('SELECT reaction, COUNT(*) count FROM post_reactions WHERE post_id = ? GROUP BY reaction', row.id);
  const mine = one('SELECT reaction FROM post_reactions WHERE post_id = ? AND user_id = ?', row.id, viewerId)?.reaction || null;
  const comments = all(`SELECT c.*, u.username, u.display_name, u.avatar_media_id FROM comments c JOIN users u ON u.id = c.author_id
    WHERE c.post_id = ? ORDER BY c.created_at`, row.id).map(comment => formatComment(comment, viewerId));
  return {
    id: row.id, body: row.body, editedAt: iso(row.edited_at), createdAt: iso(row.created_at),
    author: { id: row.author_id, username: row.username, displayName: row.display_name, avatarUrl: row.avatar_media_id ? `/api/media/${row.avatar_media_id}` : null },
    media, reactions: Object.fromEntries(reactions.map(item => [item.reaction, Number(item.count)])), viewerReaction: mine, comments
  };
}

function getPost(id) {
  return one(`SELECT p.*, u.username, u.display_name, u.avatar_media_id FROM posts p JOIN users u ON u.id = p.author_id WHERE p.id = ?`, Number(id));
}

export function registerSocialRoutes(router) {
  router.post('/api/media', async (req, res) => {
    const purpose = String(new URL(req.url, 'http://local').searchParams.get('purpose') || 'general');
    if (!UPLOAD_PURPOSES.includes(purpose)) throw new HttpError(400, 'Unsupported upload purpose.');
    rateLimit(`upload:${req.session.user.id}`, 40, 60000);
    const media = await receiveUpload(req, req.session.user.id, purpose);
    json(res, 201, { media: { id: media.id, url: `/api/media/${media.id}`, mimeType: media.mime_type, sizeBytes: media.size_bytes, name: media.original_name } });
  }, { raw: true });

  router.get('/api/media/:id', (req, res, params, url) => {
    const media = one('SELECT * FROM media WHERE id = ?', Number(params.id));
    if (!media) throw new HttpError(404, 'Media not found.');
    const userId = req.session.user.id;
    // Avatars and posts are shared with the whole circle; stories only while they are live (the author
    // keeps access for their archive); chat media only for members of a conversation that uses it.
    // Story media also honours the author's "hide my stories from" list and blocks in either direction.
    const accessible = media.owner_id === userId || one(`SELECT 1 FROM users WHERE avatar_media_id = ?
      UNION SELECT 1 FROM post_media WHERE media_id = ?
      UNION SELECT 1 FROM stories s WHERE s.media_id = ? AND (s.author_id = ? OR (s.expires_at > ?
        AND NOT EXISTS (SELECT 1 FROM story_hidden sh WHERE sh.author_id = s.author_id AND sh.user_id = ?)
        AND NOT EXISTS (SELECT 1 FROM user_blocks b WHERE (b.blocker_id = s.author_id AND b.blocked_id = ?) OR (b.blocker_id = ? AND b.blocked_id = s.author_id))))
      UNION SELECT 1 FROM messages m JOIN conversation_members cm ON cm.conversation_id = m.conversation_id
        WHERE m.media_id = ? AND m.deleted_at IS NULL AND cm.user_id = ? LIMIT 1`,
      media.id, media.id, media.id, userId, new Date().toISOString(), userId, userId, userId, media.id, userId);
    if (!accessible) throw new HttpError(403, 'You do not have access to this media.');
    sendMedia(req, res, media, { download: url.searchParams.get('download') === '1' });
  });

  router.patch('/api/profile', async (req, res) => {
    const body = await parseJson(req);
    const displayName = cleanText(body.displayName, 50, 'Display name');
    if (!displayName) throw new HttpError(400, 'Display name is required.');
    const bio = cleanText(body.bio, 180, 'Bio');
    // An omitted avatarMediaId keeps the current photo; an explicit null removes it.
    const currentAvatarId = one('SELECT avatar_media_id FROM users WHERE id = ?', req.session.user.id)?.avatar_media_id || null;
    const avatarId = body.avatarMediaId === undefined ? currentAvatarId : (body.avatarMediaId === null ? null : Number(body.avatarMediaId) || null);
    if (avatarId && avatarId !== currentAvatarId) {
      const owned = one("SELECT id FROM media WHERE id = ? AND owner_id = ? AND purpose = 'avatar'", avatarId, req.session.user.id);
      if (!owned) throw new HttpError(403, 'Invalid profile photo.');
    }
    run('UPDATE users SET display_name = ?, bio = ?, avatar_media_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', displayName, bio, avatarId, req.session.user.id);
    const user = one('SELECT * FROM users WHERE id = ?', req.session.user.id);
    broadcast('profile:updated', { user: publicUser(user, isOnline(user.id)) }, null, user.id);
    json(res, 200, { user: publicUser(user, true, { self: true }) });
  });

  router.patch('/api/profile/privacy', async (req, res) => {
    const body = await parseJson(req);
    const changes = {};
    if (body.showLastSeen !== undefined) {
      if (typeof body.showLastSeen !== 'boolean') throw new HttpError(400, 'Choose whether to show your last seen time.');
      changes.show_last_seen = body.showLastSeen ? 1 : 0;
    }
    if (body.readReceipts !== undefined) {
      if (typeof body.readReceipts !== 'boolean') throw new HttpError(400, 'Choose whether to send read receipts.');
      changes.read_receipts = body.readReceipts ? 1 : 0;
    }
    if (!Object.keys(changes).length) throw new HttpError(400, 'Choose a privacy setting to change.');
    for (const [column, value] of Object.entries(changes)) run(`UPDATE users SET ${column} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, value, req.session.user.id);
    const user = one('SELECT * FROM users WHERE id = ?', req.session.user.id);
    const online = isOnline(user.id);
    broadcast('profile:updated', { user: publicUser(user, online) }, null, user.id);
    // Others must see presence changes immediately, not on their next reload.
    if ('show_last_seen' in changes) {
      broadcast('presence', changes.show_last_seen ? { userId: user.id, online, lastSeenAt: iso(user.last_seen_at) } : { userId: user.id, online: false, lastSeenAt: null, hidden: true }, null, user.id);
    }
    json(res, 200, { user: publicUser(user, true, { self: true }) });
  });

  router.get('/api/profiles/:id', (req, res, params) => {
    const user = one('SELECT * FROM users WHERE id = ?', Number(params.id));
    if (!user) throw new HttpError(404, 'Member not found.');
    const self = user.id === req.session.user.id;
    const posts = all(`SELECT p.*, u.username, u.display_name, u.avatar_media_id FROM posts p JOIN users u ON u.id = p.author_id WHERE p.author_id = ? ORDER BY p.id DESC LIMIT 50`, user.id).map(post => formatPost(post, req.session.user.id));
    const stats = {
      posts: Number(one('SELECT COUNT(*) count FROM posts WHERE author_id = ?', user.id).count),
      activeStories: Number(one('SELECT COUNT(*) count FROM stories WHERE author_id = ? AND expires_at > ?', user.id, new Date().toISOString()).count)
    };
    const viewerId = req.session.user.id;
    // The direct chat you share with this member (if any) powers the profile's shared-media tabs.
    const direct = self ? null : one(`SELECT c.id FROM conversations c
      JOIN conversation_members x ON x.conversation_id = c.id AND x.user_id = ?
      JOIN conversation_members y ON y.conversation_id = c.id AND y.user_id = ?
      WHERE c.kind = 'direct' LIMIT 1`, viewerId, user.id);
    json(res, 200, {
      user: publicUser(user, isOnline(user.id), { self, hiddenFrom: blockedByIds(viewerId) }), posts, stats,
      relationship: self ? null : { blockedByMe: isBlocked(viewerId, user.id), directConversationId: direct?.id || null }
    });
  });

  router.get('/api/feed', (req, res) => {
    const url = new URL(req.url, 'http://local');
    const cursor = Number(url.searchParams.get('cursor') || Number.MAX_SAFE_INTEGER);
    const rows = all(`SELECT p.*, u.username, u.display_name, u.avatar_media_id FROM posts p JOIN users u ON u.id = p.author_id
      WHERE p.id < ? ORDER BY p.id DESC LIMIT 16`, cursor);
    json(res, 200, { posts: rows.map(post => formatPost(post, req.session.user.id)), nextCursor: rows.length === 16 ? rows.at(-1).id : null });
  });

  router.post('/api/posts', async (req, res) => {
    const body = await parseJson(req);
    const text = cleanText(body.body, 2200, 'Post');
    const mediaIds = [...new Set((body.mediaIds || []).map(Number))].slice(0, 10);
    if (!text && !mediaIds.length) throw new HttpError(400, 'Add text or media to your post.');
    for (const id of mediaIds) if (!one("SELECT id FROM media WHERE id = ? AND owner_id = ? AND purpose = 'post'", id, req.session.user.id)) throw new HttpError(403, 'Invalid post media.');
    const postId = transaction(() => {
      const result = run('INSERT INTO posts(author_id, body) VALUES (?, ?)', req.session.user.id, text);
      mediaIds.forEach((id, position) => run('INSERT INTO post_media(post_id, media_id, position) VALUES (?, ?, ?)', result.lastInsertRowid, id, position));
      return result.lastInsertRowid;
    });
    const post = formatPost(getPost(postId), req.session.user.id);
    broadcast('post:created', { post }, null, req.session.user.id);
    json(res, 201, { post });
  });

  router.patch('/api/posts/:id', async (req, res, params) => {
    const post = getPost(params.id);
    if (!post) throw new HttpError(404, 'Post not found.');
    if (post.author_id !== req.session.user.id) throw new HttpError(403, 'You can edit only your own posts.');
    const body = await parseJson(req); const text = cleanText(body.body, 2200, 'Post');
    if (!text && !one('SELECT 1 FROM post_media WHERE post_id = ?', post.id)) throw new HttpError(400, 'A post cannot be empty.');
    run('UPDATE posts SET body = ?, edited_at = CURRENT_TIMESTAMP WHERE id = ?', text, post.id);
    const updated = formatPost(getPost(post.id), req.session.user.id);
    broadcast('post:updated', { post: updated });
    json(res, 200, { post: updated });
  });

  router.delete('/api/posts/:id', (req, res, params) => {
    const post = getPost(params.id);
    if (!post) throw new HttpError(404, 'Post not found.');
    if (post.author_id !== req.session.user.id && req.session.user.role !== 'admin') throw new HttpError(403, 'You can delete only your own posts.');
    run('DELETE FROM posts WHERE id = ?', post.id);
    broadcast('post:deleted', { postId: post.id });
    json(res, 200, { ok: true });
  });

  router.post('/api/posts/:id/reaction', async (req, res, params) => {
    const post = getPost(params.id); if (!post) throw new HttpError(404, 'Post not found.');
    const body = await parseJson(req); const selected = body.reaction ? reaction(body.reaction) : null;
    if (selected) run(`INSERT INTO post_reactions(post_id, user_id, reaction) VALUES (?, ?, ?)
      ON CONFLICT(post_id, user_id) DO UPDATE SET reaction = excluded.reaction, created_at = CURRENT_TIMESTAMP`, post.id, req.session.user.id, selected);
    else run('DELETE FROM post_reactions WHERE post_id = ? AND user_id = ?', post.id, req.session.user.id);
    if (selected) notify(post.author_id, req.session.user.id, 'post_reaction', 'post', post.id, selected);
    const formatted = formatPost(getPost(post.id), req.session.user.id);
    broadcast('post:reaction', { postId: post.id, reactions: formatted.reactions });
    json(res, 200, { reactions: formatted.reactions, viewerReaction: selected });
  });

  router.post('/api/posts/:id/comments', async (req, res, params) => {
    const post = getPost(params.id); if (!post) throw new HttpError(404, 'Post not found.');
    const body = await parseJson(req); const text = cleanText(body.body, 800, 'Comment');
    if (!text) throw new HttpError(400, 'Comment cannot be empty.');
    const parentId = body.parentId ? Number(body.parentId) : null;
    const parent = parentId ? one('SELECT * FROM comments WHERE id = ? AND post_id = ?', parentId, post.id) : null;
    if (parentId && !parent) throw new HttpError(400, 'Reply target is invalid.');
    const result = run('INSERT INTO comments(post_id, author_id, parent_id, body) VALUES (?, ?, ?, ?)', post.id, req.session.user.id, parentId, text);
    const row = one(`SELECT c.*, u.username, u.display_name, u.avatar_media_id FROM comments c JOIN users u ON u.id = c.author_id WHERE c.id = ?`, result.lastInsertRowid);
    const comment = formatComment(row, req.session.user.id);
    notify(post.author_id, req.session.user.id, 'comment', 'post', post.id, text.slice(0, 100));
    if (parent) notify(parent.author_id, req.session.user.id, 'comment_reply', 'comment', parent.id, text.slice(0, 100));
    broadcast('comment:created', { postId: post.id, comment });
    json(res, 201, { comment });
  });

  router.post('/api/comments/:id/reaction', async (req, res, params) => {
    const comment = one('SELECT * FROM comments WHERE id = ?', Number(params.id)); if (!comment) throw new HttpError(404, 'Comment not found.');
    const body = await parseJson(req); const selected = body.reaction ? reaction(body.reaction) : null;
    if (selected) run(`INSERT INTO comment_reactions(comment_id, user_id, reaction) VALUES (?, ?, ?) ON CONFLICT(comment_id,user_id) DO UPDATE SET reaction=excluded.reaction`, comment.id, req.session.user.id, selected);
    else run('DELETE FROM comment_reactions WHERE comment_id = ? AND user_id = ?', comment.id, req.session.user.id);
    if (selected) notify(comment.author_id, req.session.user.id, 'comment_reaction', 'comment', comment.id, selected);
    json(res, 200, { ok: true });
  });
}
