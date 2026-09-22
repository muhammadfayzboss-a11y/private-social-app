import { one, run, transaction } from './db.js';

/** Returns the existing two-person conversation between the members, creating it on first use. */
export function getOrCreateDirectConversation(userId, otherUserId) {
  const existing = one(`SELECT c.id FROM conversations c
    JOIN conversation_members x ON x.conversation_id = c.id
    JOIN conversation_members y ON y.conversation_id = c.id
    WHERE c.kind = 'direct' AND x.user_id = ? AND y.user_id = ?
      AND (SELECT COUNT(*) FROM conversation_members z WHERE z.conversation_id = c.id) = 2
    LIMIT 1`, userId, otherUserId);
  if (existing) return Number(existing.id);

  return Number(transaction(() => {
    const created = run("INSERT INTO conversations(kind, created_by) VALUES ('direct', ?)", userId);
    run('INSERT INTO conversation_members(conversation_id, user_id) VALUES (?, ?), (?, ?)',
      created.lastInsertRowid, userId, created.lastInsertRowid, otherUserId);
    return created.lastInsertRowid;
  }));
}
