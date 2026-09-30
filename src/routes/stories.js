import { all, one, run } from '../db.js';
import { config } from '../config.js';
import { getOrCreateDirectConversation } from '../conversations.js';
import { createMessage, fanout } from '../messages.js';
import { notify, notifyStory } from '../notifications.js';
import { canSeeStoriesOf, hiddenStoryAuthorIds } from '../privacy.js';
import { broadcast, onlineUserIds, sendMany } from '../realtime.js';
import { getSettings } from '../settings.js';
import { cleanText, HttpError, iso, json, parseJson } from '../utils.js';

function person(row) {
  return { id: row.id, username: row.username, displayName: row.display_name, avatarUrl: row.avatar_media_id ? `/api/media/${row.avatar_media_id}` : null };
}

/**
 * Viewer lists are private to the author. Each member appears at most once per story (the table's
 * primary key is (story_id, user_id)), with the time of their first view and their reaction, if any.
 */
function storyViews(storyId) {
  return all(`SELECT sv.viewed_at, u.id, u.username, u.display_name, u.avatar_media_id, sr.reaction
    FROM story_views sv JOIN users u ON u.id = sv.user_id
    LEFT JOIN story_reactions sr ON sr.story_id = sv.story_id AND sr.user_id = sv.user_id
    WHERE sv.story_id = ? ORDER BY sv.viewed_at DESC`, storyId)
    .map(view => ({ viewedAt: iso(view.viewed_at), reaction: view.reaction || null, user: person(view) }));
}

function formatStory(row, viewerId) {
  const isAuthor = row.author_id === viewerId;
  const views = isAuthor ? storyViews(row.id) : undefined;
  const viewed = isAuthor ? true : Boolean(one('SELECT 1 FROM story_views WHERE story_id = ? AND user_id = ?', row.id, viewerId));
  const reaction = one('SELECT reaction FROM story_reactions WHERE story_id = ? AND user_id = ?', row.id, viewerId)?.reaction || null;
  return {
    id: row.id, caption: row.caption, createdAt: iso(row.created_at), expiresAt: iso(row.expires_at),
    expired: row.expires_at <= new Date().toISOString(),
    allowReplies: getSettings(row.author_id).privacy.storyReplies,
    viewed, views, viewCount: isAuthor ? views.length : undefined, viewerReaction: reaction,
    media: { id: row.media_id, url: `/api/media/${row.media_id}`, mimeType: row.mime_type },
    author: { id: row.author_id, username: row.username, displayName: row.display_name, avatarUrl: row.avatar_media_id ? `/api/media/${row.avatar_media_id}` : null }
  };
}

const STORY_SELECT = `SELECT s.*, m.mime_type, u.username, u.display_name, u.avatar_media_id FROM stories s
  JOIN media m ON m.id = s.media_id JOIN users u ON u.id = s.author_id`;

function getStory(id) {
  return one(`${STORY_SELECT} WHERE s.id = ?`, Number(id));
}

/** A story the viewer may interact with: live, and not hidden from them by the author or a block. */
function liveStory(id, viewerId) {
  const story = getStory(id);
  if (!story || story.expires_at <= new Date().toISOString() || !canSeeStoriesOf(story.author_id, viewerId)) throw new HttpError(404, 'Story is no longer available.');
  return story;
}

/** Members allowed to see an author's stories (everyone minus hidden-from and blocks). */
function storyAudience(authorId) {
  return all('SELECT id FROM users WHERE id <> ?', authorId).map(row => Number(row.id)).filter(id => canSeeStoriesOf(authorId, id));
}

export function registerStoryRoutes(router) {
  router.get('/api/stories', (req, res) => {
    const hidden = hiddenStoryAuthorIds(req.session.user.id);
    const rows = all(`${STORY_SELECT} WHERE s.expires_at > ? ORDER BY s.created_at`, new Date().toISOString())
      .filter(row => row.author_id === req.session.user.id || !hidden.has(row.author_id));
    json(res, 200, { stories: rows.map(row => formatStory(row, req.session.user.id)) });
  });

  // Story privacy: who your stories are hidden from, and whether members can reply to them.
  router.get('/api/stories/privacy', (req, res) => {
    const hiddenFrom = all('SELECT user_id FROM story_hidden WHERE author_id = ?', req.session.user.id).map(row => Number(row.user_id));
    json(res, 200, { hiddenFrom, allowReplies: getSettings(req.session.user.id).privacy.storyReplies });
  });
  router.put('/api/stories/privacy', async (req, res) => {
    const body = await parseJson(req);
    const ids = [...new Set((Array.isArray(body.hiddenFrom) ? body.hiddenFrom : []).map(Number))].filter(id => id !== req.session.user.id && one('SELECT id FROM users WHERE id = ?', id));
    run('DELETE FROM story_hidden WHERE author_id = ?', req.session.user.id);
    for (const id of ids) run('INSERT INTO story_hidden(author_id, user_id) VALUES (?, ?)', req.session.user.id, id);
    // Members who can no longer see the stories drop them immediately.
    const live = all('SELECT id FROM stories WHERE author_id = ? AND expires_at > ?', req.session.user.id, new Date().toISOString());
    for (const story of live) sendMany(ids, 'story:deleted', { storyId: story.id });
    json(res, 200, { hiddenFrom: ids });
  });

  // The author's own history: live and expired stories (kept for STORY_ARCHIVE_DAYS) with viewers.
  // Only ever returns the caller's stories, so nobody can browse someone else's archive.
  router.get('/api/stories/archive', (req, res) => {
    const cutoff = new Date(Date.now() - config.storyArchiveDays * 86400000).toISOString();
    const rows = all(`${STORY_SELECT} WHERE s.author_id = ? AND s.expires_at > ? ORDER BY s.created_at DESC LIMIT 100`, req.session.user.id, cutoff);
    json(res, 200, { stories: rows.map(row => formatStory(row, req.session.user.id)), retentionDays: config.storyArchiveDays });
  });

  router.get('/api/stories/:id/views', (req, res, params) => {
    const story = getStory(params.id);
    if (!story) throw new HttpError(404, 'Story not found.');
    if (story.author_id !== req.session.user.id) throw new HttpError(403, 'Only the author can see who viewed a story.');
    json(res, 200, { views: storyViews(story.id) });
  });

  router.post('/api/stories', async (req, res) => {
    const body = await parseJson(req); const mediaId = Number(body.mediaId);
    if (!one("SELECT id FROM media WHERE id=? AND owner_id=? AND purpose='story'", mediaId, req.session.user.id)) throw new HttpError(403, 'Invalid story media.');
    const caption = cleanText(body.caption, 300, 'Caption');
    const expiresAt = new Date(Date.now() + 86400000).toISOString();
    const result = run('INSERT INTO stories(author_id,media_id,caption,expires_at,created_at) VALUES (?,?,?,?,?)', req.session.user.id, mediaId, caption, expiresAt, new Date().toISOString());
    const row = getStory(result.lastInsertRowid);
    const audience = storyAudience(req.session.user.id);
    const online = new Set(onlineUserIds());
    for (const id of audience) if (online.has(id)) sendMany([id], 'story:created', { story: formatStory(row, id) });
    notifyStory(req.session.user.id, req.session.user.displayName, audience);
    json(res, 201, { story: formatStory(row, req.session.user.id) });
  });

  router.post('/api/stories/:id/view', (req, res, params) => {
    const story = liveStory(params.id, req.session.user.id);
    if (story.author_id === req.session.user.id) return json(res, 200, { ok: true });
    const inserted = run('INSERT OR IGNORE INTO story_views(story_id,user_id,viewed_at) VALUES (?,?,?)', story.id, req.session.user.id, new Date().toISOString()).changes;
    // Only a first view is news to the author; repeat views never create duplicate viewer entries.
    if (inserted) {
      const view = storyViews(story.id).find(item => item.user.id === req.session.user.id);
      sendMany([story.author_id], 'story:viewed', { storyId: story.id, userId: req.session.user.id, view });
    }
    json(res, 200, { ok: true });
  });

  router.post('/api/stories/:id/reaction', async (req, res, params) => {
    const story = liveStory(params.id, req.session.user.id);
    if (story.author_id === req.session.user.id) throw new HttpError(400, 'You cannot react to your own story.');
    const body = await parseJson(req); const selected = cleanText(body.reaction, 16, 'Reaction');
    if (!selected) run('DELETE FROM story_reactions WHERE story_id=? AND user_id=?', story.id, req.session.user.id);
    else run(`INSERT INTO story_reactions(story_id,user_id,reaction) VALUES (?,?,?) ON CONFLICT(story_id,user_id) DO UPDATE SET reaction=excluded.reaction`, story.id, req.session.user.id, selected);
    run('INSERT OR IGNORE INTO story_views(story_id,user_id,viewed_at) VALUES (?,?,?)', story.id, req.session.user.id, new Date().toISOString());
    if (selected) notify(story.author_id, req.session.user.id, 'story_reaction', 'story', story.id, selected);
    const view = storyViews(story.id).find(item => item.user.id === req.session.user.id);
    sendMany([story.author_id], 'story:viewed', { storyId: story.id, userId: req.session.user.id, view });
    json(res, 200, { viewerReaction: selected || null });
  });

  router.post('/api/stories/:id/reply', async (req, res, params) => {
    const story = liveStory(params.id, req.session.user.id);
    if (story.author_id === req.session.user.id) throw new HttpError(400, 'You cannot reply to your own story.');
    if (!getSettings(story.author_id).privacy.storyReplies) throw new HttpError(403, 'Replies to this story are turned off.');
    const body = await parseJson(req); const text = cleanText(body.body, 1200, 'Reply'); if (!text) throw new HttpError(400, 'Reply cannot be empty.');
    const conversationId = getOrCreateDirectConversation(req.session.user.id, story.author_id);
    const { id } = createMessage({ conversationId, senderId: req.session.user.id, kind: 'story_reply', body: text, storyId: story.id });
    notify(story.author_id, req.session.user.id, 'story_reply', 'story', story.id, text.slice(0, 100));
    fanout(conversationId, 'message:created', id);
    json(res, 201, { conversationId, messageId: id });
  });

  router.delete('/api/stories/:id', (req, res, params) => {
    const story = getStory(params.id); if (!story) throw new HttpError(404, 'Story not found.');
    if (story.author_id !== req.session.user.id) throw new HttpError(403, 'You can delete only your own story.');
    run('DELETE FROM stories WHERE id=?', story.id); broadcast('story:deleted', { storyId: story.id }); json(res, 200, { ok: true });
  });

  // Recent stories of one member (for their profile), respecting the same privacy rules.
  router.get('/api/users/:id/stories', (req, res, params) => {
    const authorId = Number(params.id);
    if (!canSeeStoriesOf(authorId, req.session.user.id)) return json(res, 200, { stories: [] });
    const rows = all(`${STORY_SELECT} WHERE s.author_id = ? AND s.expires_at > ? ORDER BY s.created_at`, authorId, new Date().toISOString());
    json(res, 200, { stories: rows.map(row => formatStory(row, req.session.user.id)) });
  });
}
