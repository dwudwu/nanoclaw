import type { Migration } from './index.js';

export const moduleMemo: Migration = {
  version: 20,
  name: 'memos',
  up(db) {
    db.exec(`
      CREATE TABLE memos (
        id              TEXT PRIMARY KEY,
        agent_group_id  TEXT REFERENCES agent_groups(id) ON DELETE CASCADE,
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
  },
};
