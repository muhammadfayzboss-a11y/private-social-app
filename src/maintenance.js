/**
 * Background housekeeping: expired sessions, stories past their 24-hour life, and orphaned media files.
 * Stories stop being served to other members the moment they expire; the author keeps them in their
 * archive for STORY_ARCHIVE_DAYS, after which this reclaims the storage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { all, run } from './db.js';


export function pruneSessions() {
  return run('DELETE FROM sessions WHERE expires_at <= ?', new Date().toISOString()).changes;
}

export function pruneExpiredStories() {
  const cutoff = new Date(Date.now() - config.storyArchiveDays * 86400000).toISOString();
  const stale = all('SELECT id, media_id FROM stories WHERE expires_at <= ?', cutoff);
  for (const story of stale) {
    run('DELETE FROM stories WHERE id = ?', story.id);
    run('DELETE FROM media WHERE id = ? AND purpose = ?', story.media_id, 'story');
  }
  return stale.length;
}

export function pruneOrphanMedia() {
  const orphans = all(`SELECT id, storage_key FROM media
    WHERE id NOT IN (SELECT COALESCE(avatar_media_id, 0) FROM users)
      AND id NOT IN (SELECT media_id FROM post_media)
      AND id NOT IN (SELECT media_id FROM stories)
      AND id NOT IN (SELECT COALESCE(media_id, 0) FROM messages WHERE deleted_at IS NULL)
      AND id NOT IN (SELECT COALESCE(avatar_media_id, 0) FROM conversations)
      AND created_at <= ?`, new Date(Date.now() - 86400000).toISOString());
  for (const media of orphans) {
    const file = path.join(config.uploadDir, media.storage_key);
    try { if (fs.existsSync(file)) fs.unlinkSync(file); } catch (error) { console.error('Could not remove media file:', error.message); }
    run('DELETE FROM media WHERE id = ?', media.id);
  }
  return orphans.length;
}

export function runMaintenance() {
  const summary = { sessions: pruneSessions(), stories: pruneExpiredStories(), media: pruneOrphanMedia() };
  if (summary.sessions || summary.stories || summary.media) {
    console.log(`Maintenance: removed ${summary.sessions} sessions, ${summary.stories} expired stories, ${summary.media} orphaned files`);
  }
  return summary;
}

export function scheduleMaintenance(intervalMs = 3600000) {
  runMaintenance();
  const timer = setInterval(runMaintenance, intervalMs);
  timer.unref();
  return timer;
}
