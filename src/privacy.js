/**
 * Server-side privacy rules. Every rule is enforced here, on the server, so changing an id in a
 * request can never reveal something the owner chose to hide.
 *
 * - Blocking: the blocked member cannot send the blocker direct messages, cannot see the blocker's
 *   last seen / online status or stories, and the blocker stops seeing theirs.
 * - Story privacy: authors can hide all their stories from chosen members.
 * - Read receipts: members who turn them off neither share nor see read state (reciprocal).
 */
import { all, one } from './db.js';

export function isBlocked(blockerId, blockedId) {
  return Boolean(one('SELECT 1 FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?', blockerId, blockedId));
}

export function blockedEitherWay(a, b) {
  return Boolean(one('SELECT 1 FROM user_blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)', a, b, b, a));
}

/** Members in either direction of a block relationship: presence is hidden reciprocally. */
export function blockedByIds(viewerId) {
  return new Set(all(`SELECT blocker_id id FROM user_blocks WHERE blocked_id = ?
    UNION SELECT blocked_id FROM user_blocks WHERE blocker_id = ?`, viewerId, viewerId).map(row => Number(row.id)));
}

export function blockedIds(userId) {
  return blockedByIds(userId);
}

/** Authors whose stories `viewerId` may not see (hidden by the author, or blocked either way). */
export function hiddenStoryAuthorIds(viewerId) {
  return new Set(all(`SELECT author_id id FROM story_hidden WHERE user_id = ?
    UNION SELECT blocker_id FROM user_blocks WHERE blocked_id = ?
    UNION SELECT blocked_id FROM user_blocks WHERE blocker_id = ?`, viewerId, viewerId, viewerId).map(row => Number(row.id)));
}

export function canSeeStoriesOf(authorId, viewerId) {
  if (Number(authorId) === Number(viewerId)) return true;
  return !hiddenStoryAuthorIds(viewerId).has(Number(authorId));
}

export function readReceiptsEnabled(userId) {
  return Number(one('SELECT read_receipts FROM users WHERE id = ?', userId)?.read_receipts ?? 1) === 1;
}
