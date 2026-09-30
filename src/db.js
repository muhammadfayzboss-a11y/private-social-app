import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.databasePath), { recursive: true });
export const db = new DatabaseSync(config.databasePath);
db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8'));

export function one(sql, ...params) {
  return db.prepare(sql).get(...params);
}
export function all(sql, ...params) {
  return db.prepare(sql).all(...params);
}
export function run(sql, ...params) {
  return db.prepare(sql).run(...params);
}
export function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

/**
 * Additive migrations for databases created by earlier versions. `schema.sql` only uses
 * CREATE ... IF NOT EXISTS, so new columns on existing tables must be added here, and any
 * index over a new column must be created after that column exists.
 */
function migrate() {
  const columns = table => new Set(all(`PRAGMA table_info(${table})`).map(column => column.name));
  const addColumn = (table, name, definition) => {
    if (!columns(table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  };
  addColumn('messages', 'client_id', 'TEXT');
  addColumn('messages', 'forwarded_from_id', 'INTEGER REFERENCES users(id) ON DELETE SET NULL');
  addColumn('media', 'waveform', 'TEXT');
  addColumn('conversations', 'pinned_message_id', 'INTEGER REFERENCES messages(id) ON DELETE SET NULL');
  addColumn('conversation_members', 'pinned_at', 'TEXT');
  addColumn('conversation_members', 'muted', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('users', 'show_last_seen', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('users', 'read_receipts', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('users', 'settings_json', "TEXT NOT NULL DEFAULT '{}'");
  addColumn('conversation_members', 'archived_at', 'TEXT');
  addColumn('conversation_members', 'marked_unread', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('conversation_members', 'cleared_before_id', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('media', 'thumb', 'TEXT');
  addColumn('messages', 'link_url', 'TEXT');
  rebuildMessagesWithFileKind();

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client ON messages(sender_id, client_id) WHERE client_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_messages_media ON messages(media_id) WHERE media_id IS NOT NULL;
  `);
}

/**
 * SQLite cannot alter a CHECK constraint, so databases created before file messages existed get
 * their messages table rebuilt using SQLite's documented procedure (foreign keys off, copy, swap,
 * verify, foreign keys on). Other tables reference "messages" by name, so they bind to the new table.
 */
function rebuildMessagesWithFileKind() {
  const definition = one("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'")?.sql || '';
  if (!definition || definition.includes("'file'")) return;
  const columns = all('PRAGMA table_info(messages)').map(column => `"${column.name}"`).join(', ');
  const rebuilt = definition
    .replace(/CREATE TABLE\s+(IF NOT EXISTS\s+)?"?messages"?/i, 'CREATE TABLE messages_rebuild')
    .replace("'story_reply')", "'story_reply','file')");
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(rebuilt);
      db.exec(`INSERT INTO messages_rebuild(${columns}) SELECT ${columns} FROM messages`);
      db.exec('DROP TABLE messages');
      db.exec('ALTER TABLE messages_rebuild RENAME TO messages');
      db.exec(fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8').replace(/PRAGMA[^;]*;/g, ''));
      const problems = all('PRAGMA foreign_key_check');
      if (problems.length) throw new Error(`foreign key check failed after migration (${problems.length} rows)`);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

migrate();

export function bootstrapGroupConversation() {
  let conversation = one("SELECT * FROM conversations WHERE kind = 'group' ORDER BY id LIMIT 1");
  if (!conversation) {
    const result = run("INSERT INTO conversations(kind, title) VALUES ('group', 'The Circle')");
    conversation = one('SELECT * FROM conversations WHERE id = ?', result.lastInsertRowid);
  }
  run('INSERT OR IGNORE INTO conversation_members(conversation_id, user_id) SELECT ?, id FROM users', conversation.id);
  return conversation;
}

run('DELETE FROM sessions WHERE expires_at <= ?', new Date().toISOString());
bootstrapGroupConversation();
