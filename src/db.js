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
