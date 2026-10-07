// The service's SQLite state: schema, additive migrations for older data folders, and query helpers.
import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { join } from 'node:path';

export function openDatabase(dataDir) {
  const path = join(dataDir, 'data.sqlite');
  const db = new DatabaseSync(path); chmodSync(path, 0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS tokens (token TEXT PRIMARY KEY, createdAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT UNIQUE NOT NULL);
    CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), title TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL, updatedAt INTEGER NOT NULL, error TEXT, sessionStarted INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, chatId TEXT NOT NULL REFERENCES chats(id), role TEXT NOT NULL, text TEXT NOT NULL, createdAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS prompts (id TEXT PRIMARY KEY, chatId TEXT NOT NULL, text TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, chatId TEXT NOT NULL REFERENCES chats(id), tool TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL, createdAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, chatId TEXT, type TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS runtimes (chatId TEXT PRIMARY KEY, pid INTEGER NOT NULL, startTime TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS raw_events (id INTEGER PRIMARY KEY AUTOINCREMENT, chatId TEXT NOT NULL, json TEXT NOT NULL);
  `);
  const columns = table => db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
  // Columns added since 0.1, in the order they arrived. Each is added once to a folder that lacks it.
  for (const [table, column, type] of [
    ['prompts', 'mode', 'TEXT'], ['prompts', 'model', 'TEXT'], ['prompts', 'effort', 'TEXT'],
    ['projects', 'lastUsedAt', 'INTEGER NOT NULL DEFAULT 0'],
    ['chats', 'model', "TEXT NOT NULL DEFAULT 'default'"], ['chats', 'effort', "TEXT NOT NULL DEFAULT 'default'"], ['chats', 'agent', "TEXT NOT NULL DEFAULT 'claude'"], ['chats', 'agentSession', 'TEXT'],
    ['prompts', 'agent', 'TEXT'], ['chats', 'contextTokens', 'INTEGER'], ['chats', 'contextWindow', 'INTEGER'],
    ['prompts', 'attachments', 'TEXT'], ['prompts', 'delivery', 'TEXT'], ['prompts', 'startedAt', 'INTEGER'], ['prompts', 'endedAt', 'INTEGER'],
    ['messages', 'attachments', 'TEXT'], ['messages', 'kind', 'TEXT'], ['chats', 'forkFrom', 'TEXT'], ['chats', 'activity', 'TEXT'],
    // 0.7: Codex speed tier per chat and per recorded prompt; project icons.
    ['chats', 'speed', 'TEXT'], ['prompts', 'speed', 'TEXT'],
    ['projects', 'icon', 'TEXT'], ['projects', 'iconType', 'TEXT'], ['projects', 'iconSource', 'TEXT'], ['projects', 'iconCheckedAt', 'INTEGER'],
    // 0.8: the one General project, for chats that belong to no project folder.
    ['projects', 'general', 'INTEGER NOT NULL DEFAULT 0'],
    ['chats', 'thinking', 'TEXT'],
  ]) if (!columns(table).includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  db.exec(`CREATE TABLE IF NOT EXISTS deleted_chats (id TEXT PRIMARY KEY, deletedAt INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS messages_chat ON messages(chatId);
    CREATE INDEX IF NOT EXISTS approvals_chat ON approvals(chatId);
    CREATE INDEX IF NOT EXISTS raw_events_chat ON raw_events(chatId);
    CREATE TABLE IF NOT EXISTS hidden_sessions (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, chatId TEXT, type TEXT NOT NULL, size INTEGER NOT NULL, createdAt INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS subagents (id TEXT NOT NULL, chatId TEXT NOT NULL, promptId TEXT, agent TEXT NOT NULL, title TEXT, kind TEXT, model TEXT, effort TEXT, status TEXT NOT NULL, activity TEXT, startedAt INTEGER NOT NULL, endedAt INTEGER, toolUses INTEGER, tokens INTEGER, PRIMARY KEY (chatId, id));`);
  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  const transaction = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } };
  const setting = key => get('SELECT value FROM settings WHERE key=?', key)?.value;
  const saveSetting = (key, value) => run('INSERT OR REPLACE INTO settings VALUES (?,?)', key, value);
  return { db, get, all, run, transaction, setting, saveSetting };
}
