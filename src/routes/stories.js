import { all, one, run } from '../db.js';
import { getOrCreateDirectConversation } from '../conversations.js';
import { notify } from '../notifications.js';
import { broadcast, sendMany } from '../realtime.js';
import { cleanText, HttpError, json, parseJson } from '../utils.js';

function formatStory(row, viewerId) {
  const views = all(`SELECT sv.viewed_at, u.id, u.username, u.display_name, u.avatar_media_id FROM story_views sv JOIN users u ON u.id=sv.user_id WHERE sv.story_id=? ORDER BY sv.viewed_at`, row.id)
    .map(v => ({ viewedAt: v.viewed_at, user: { id: v.id, username: v.username, displayName: v.display_name, avatarUrl: v.avatar_media_id ? `/api/media/${v.avatar_media_id}` : null } }));
  const reaction = one('SELECT reaction FROM story_reactions WHERE story_id=? AND user_id=?', row.id, viewerId)?.reaction || null;
  return { id: row.id, caption: row.caption, createdAt: row.created_at, expiresAt: row.expires_at, viewed: views.some(v => v.user.id === viewerId), views: row.author_id === viewerId ? views : undefined, viewerReaction: reaction,
    media: { id: row.media_id, url: `/api/media/${row.media_id}`, mimeType: row.mime_type },
    author: { id: row.author_id, username: row.username, displayName: row.display_name, avatarUrl: row.avatar_media_id ? `/api/media/${row.avatar_media_id}` : null } };
}

function getStory(id) {
  return one(`SELECT s.*, m.mime_type, u.username, u.display_name, u.avatar_media_id FROM stories s JOIN media m ON m.id=s.media_id JOIN users u ON u.id=s.author_id WHERE s.id=?`, Number(id));
}

export function registerStoryRoutes(router) {
  router.get('/api/stories', (req, res) => {
    const rows = all(`SELECT s.*, m.mime_type, u.username, u.display_name, u.avatar_media_id FROM stories s JOIN media m ON m.id=s.media_id JOIN users u ON u.id=s.author_id WHERE s.expires_at>? ORDER BY s.created_at`, new Date().toISOString());
    json(res, 200, { stories: rows.map(row => formatStory(row, req.session.user.id)) });
  });

  router.post('/api/stories', async (req, res) => {
    const body = await parseJson(req); const mediaId = Number(body.mediaId);
    if (!one("SELECT id FROM media WHERE id=? AND owner_id=? AND purpose='story'", mediaId, req.session.user.id)) throw new HttpError(403, 'Invalid story media.');
    const caption = cleanText(body.caption, 300, 'Caption');
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    const result = run('INSERT INTO stories(author_id,media_id,caption,expires_at) VALUES (?,?,?,?)', req.session.user.id, mediaId, caption, expiresAt);
    const story = formatStory(getStory(result.lastInsertRowid), req.session.user.id);
    broadcast('story:created', { story }, null, req.session.user.id);
    json(res, 201, { story });
  });

  router.post('/api/stories/:id/view', (req, res, params) => {
    const story = getStory(params.id); if (!story || story.expires_at <= new Date().toISOString()) throw new HttpError(404, 'Story is no longer available.');
    run('INSERT OR IGNORE INTO story_views(story_id,user_id) VALUES (?,?)', story.id, req.session.user.id);
    if (story.author_id !== req.session.user.id) sendMany([story.author_id], 'story:viewed', { storyId: story.id, userId: req.session.user.id });
    json(res, 200, { ok: true });
  });

  router.post('/api/stories/:id/reaction', async (req, res, params) => {
    const story = getStory(params.id); if (!story || story.expires_at <= new Date().toISOString()) throw new HttpError(404, 'Story is no longer available.');
    const body = await parseJson(req); const selected = cleanText(body.reaction, 24, 'Reaction');
    if (!selected) run('DELETE FROM story_reactions WHERE story_id=? AND user_id=?', story.id, req.session.user.id);
    else run(`INSERT INTO story_reactions(story_id,user_id,reaction) VALUES (?,?,?) ON CONFLICT(story_id,user_id) DO UPDATE SET reaction=excluded.reaction`, story.id, req.session.user.id, selected);
    if (selected) notify(story.author_id, req.session.user.id, 'story_reaction', 'story', story.id, selected);
    json(res, 200, { viewerReaction: selected || null });
  });

  router.post('/api/stories/:id/reply', async (req, res, params) => {
    const story = getStory(params.id); if (!story || story.expires_at <= new Date().toISOString()) throw new HttpError(404, 'Story is no longer available.');
    if (story.author_id === req.session.user.id) throw new HttpError(400, 'You cannot reply to your own story.');
    const body = await parseJson(req); const text = cleanText(body.body, 1200, 'Reply'); if (!text) throw new HttpError(400, 'Reply cannot be empty.');
    const conversationId = getOrCreateDirectConversation(req.session.user.id, story.author_id);
    const result = run(`INSERT INTO messages(conversation_id,sender_id,kind,body,story_id) VALUES (?,?,'story_reply',?,?)`, conversationId, req.session.user.id, text, story.id);
    run('UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?', conversationId);
    notify(story.author_id, req.session.user.id, 'story_reply', 'story', story.id, text.slice(0,100));
    sendMany([story.author_id], 'message:created', { conversationId, messageId: Number(result.lastInsertRowid) });
    json(res, 201, { conversationId, messageId: Number(result.lastInsertRowid) });
  });

  router.delete('/api/stories/:id', (req, res, params) => {
    const story = getStory(params.id); if (!story) throw new HttpError(404, 'Story not found.');
    if (story.author_id !== req.session.user.id) throw new HttpError(403, 'You can delete only your own story.');
    run('DELETE FROM stories WHERE id=?', story.id); broadcast('story:deleted', { storyId: story.id }); json(res, 200, { ok:true });
  });
}
