/**
 * Standalone memo database.
 *
 * Separate file (data/memos.db) mounted into containers read-only.
 * Uses DELETE journal mode for cross-mount coherency (same reason as
 * session inbound/outbound DBs — WAL's mmap isn't visible across VirtioFS).
 *
 * Single writer: the host process. Containers read directly via bun:sqlite.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { log } from '../log.js';

let _memoDB: Database.Database | null = null;

export function getMemoDb(): Database.Database {
  if (!_memoDB) throw new Error('Memo DB not initialized. Call initMemoDb() first.');
  return _memoDB;
}

export function initMemoDb(dataDir: string): Database.Database {
  const dbPath = path.join(dataDir, 'memos.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  _memoDB = new Database(dbPath);
  _memoDB.pragma('journal_mode = DELETE');
  _memoDB.pragma('foreign_keys = ON');

  _memoDB.exec(`
    CREATE TABLE IF NOT EXISTS memos (
      id              TEXT PRIMARY KEY,
      agent_group_id  TEXT,
      title           TEXT NOT NULL,
      content         TEXT NOT NULL,
      tags            TEXT,
      source_context  TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_memos_agent_group ON memos(agent_group_id);
    CREATE INDEX IF NOT EXISTS idx_memos_updated ON memos(agent_group_id, updated_at);
  `);

  // FTS5 virtual table — CREATE VIRTUAL TABLE IF NOT EXISTS is supported
  const hasFts = _memoDB
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='memos_fts' LIMIT 1")
    .get();
  if (!hasFts) {
    _memoDB.exec(`
      CREATE VIRTUAL TABLE memos_fts USING fts5(
        title, content, tags,
        content='memos', content_rowid='rowid'
      );

      CREATE TRIGGER memos_ai AFTER INSERT ON memos BEGIN
        INSERT INTO memos_fts(rowid, title, content, tags)
        VALUES (NEW.rowid, NEW.title, NEW.content, NEW.tags);
      END;

      CREATE TRIGGER memos_ad AFTER DELETE ON memos BEGIN
        INSERT INTO memos_fts(memos_fts, rowid, title, content, tags)
        VALUES ('delete', OLD.rowid, OLD.title, OLD.content, OLD.tags);
      END;

      CREATE TRIGGER memos_au AFTER UPDATE ON memos BEGIN
        INSERT INTO memos_fts(memos_fts, rowid, title, content, tags)
        VALUES ('delete', OLD.rowid, OLD.title, OLD.content, OLD.tags);
        INSERT INTO memos_fts(rowid, title, content, tags)
        VALUES (NEW.rowid, NEW.title, NEW.content, NEW.tags);
      END;
    `);
  }

  log.info('Memo DB initialized', { path: dbPath });
  return _memoDB;
}

export function closeMemoDb(): void {
  _memoDB?.close();
  _memoDB = null;
}

/** For tests — creates an in-memory memo DB with full schema. */
export function initTestMemoDb(): Database.Database {
  _memoDB = new Database(':memory:');
  _memoDB.pragma('foreign_keys = ON');
  _memoDB.exec(`
    CREATE TABLE memos (
      id              TEXT PRIMARY KEY,
      agent_group_id  TEXT,
      title           TEXT NOT NULL,
      content         TEXT NOT NULL,
      tags            TEXT,
      source_context  TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
    CREATE INDEX idx_memos_agent_group ON memos(agent_group_id);
    CREATE INDEX idx_memos_updated ON memos(agent_group_id, updated_at);

    CREATE VIRTUAL TABLE memos_fts USING fts5(
      title, content, tags,
      content='memos', content_rowid='rowid'
    );

    CREATE TRIGGER memos_ai AFTER INSERT ON memos BEGIN
      INSERT INTO memos_fts(rowid, title, content, tags)
      VALUES (NEW.rowid, NEW.title, NEW.content, NEW.tags);
    END;

    CREATE TRIGGER memos_ad AFTER DELETE ON memos BEGIN
      INSERT INTO memos_fts(memos_fts, rowid, title, content, tags)
      VALUES ('delete', OLD.rowid, OLD.title, OLD.content, OLD.tags);
    END;

    CREATE TRIGGER memos_au AFTER UPDATE ON memos BEGIN
      INSERT INTO memos_fts(memos_fts, rowid, title, content, tags)
      VALUES ('delete', OLD.rowid, OLD.title, OLD.content, OLD.tags);
      INSERT INTO memos_fts(rowid, title, content, tags)
      VALUES (NEW.rowid, NEW.title, NEW.content, NEW.tags);
    END;
  `);
  return _memoDB;
}
