// Upgrading a database created by an earlier version must keep every row and relationship intact.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

test('an existing database gains file messages and new columns without losing data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'circle-migration-'));
  const file = path.join(dir, 'old.db');
  // Reconstruct the previous schema: the messages CHECK constraint did not allow 'file'.
  const oldSchema = fs.readFileSync(path.resolve('src/schema.sql'), 'utf8')
    .replace("'story_reply','file')", "'story_reply')")
    .replace('  session_id INTEGER NOT NULL,\n', '')
    .replace('  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,\n  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE', '  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE');
  const old = new DatabaseSync(file);
  old.exec(oldSchema);
  old.exec(`INSERT INTO users(id, username, display_name, password_hash) VALUES (1, 'mara', 'Mara', 'x'), (2, 'ana', 'Ana', 'x');
    INSERT INTO conversations(id, kind, title) VALUES (1, 'group', 'The Circle');
    INSERT INTO conversation_members(conversation_id, user_id, last_read_message_id) VALUES (1, 1, 2), (1, 2, 1);
    INSERT INTO messages(id, conversation_id, sender_id, kind, body) VALUES (1, 1, 1, 'text', 'first'), (2, 1, 2, 'text', 'reply');
    UPDATE messages SET reply_to_id = 1 WHERE id = 2;
    INSERT INTO message_reactions(message_id, user_id, reaction) VALUES (1, 2, '🔥');
    INSERT INTO sessions(id, user_id, token_hash, csrf_token, expires_at) VALUES (1, 1, 'legacy-token', 'csrf', '2099-01-01T00:00:00.000Z');
    INSERT INTO push_subscriptions(user_id, endpoint, subscription_json) VALUES (1, 'https://push.example/legacy', '{}');`);
  assert.throws(() => old.exec("INSERT INTO messages(conversation_id, sender_id, kind) VALUES (1, 1, 'file')"), /CHECK/);
  old.close();

  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '-e', "await import('./src/db.js')"], {
    env: { ...process.env, NODE_OPTIONS: '', NODE_ENV: 'test', DATABASE_PATH: file, UPLOAD_DIR: path.join(dir, 'uploads'), STICKER_DIR: path.resolve('stickers') }
  });

  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  assert.match(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'messages'").get().sql, /'file'/);
  assert.deepEqual(db.prepare('SELECT id, body, reply_to_id FROM messages ORDER BY id').all().map(row => ({ ...row })),
    [{ id: 1, body: 'first', reply_to_id: null }, { id: 2, body: 'reply', reply_to_id: 1 }]);
  assert.equal(db.prepare('SELECT COUNT(*) count FROM message_reactions').get().count, 1);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0);
  const columns = db.prepare('PRAGMA table_info(conversation_members)').all().map(column => column.name);
  for (const name of ['archived_at', 'marked_unread', 'cleared_before_id', 'pinned_at', 'muted']) assert.ok(columns.includes(name), `${name} added`);
  const pushColumns = db.prepare('PRAGMA table_info(push_subscriptions)').all().map(column => column.name);
  assert.ok(pushColumns.includes('session_id'), 'push subscriptions gain their device session');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM push_subscriptions').get().count, 0, 'unsafe unbound legacy push endpoints are removed');
  db.exec("INSERT INTO messages(conversation_id, sender_id, kind) VALUES (1, 1, 'file')");
  // Cascades still point at the rebuilt table.
  db.exec('DELETE FROM messages WHERE id = 1');
  assert.equal(db.prepare('SELECT COUNT(*) count FROM message_reactions').get().count, 0);
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages'").all().map(row => row.name);
  for (const name of ['idx_messages_conversation', 'idx_messages_client', 'idx_messages_media', 'idx_messages_links']) assert.ok(indexes.includes(name), `${name} rebuilt`);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
