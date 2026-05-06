import { getMemoDb } from '../../db/memo-db.js';
import type { Memo, MemoSearchResult } from '../../types.js';

export function insertMemo(memo: Memo): void {
  getMemoDb()
    .prepare(
      `INSERT INTO memos (id, agent_group_id, title, content, tags, source_context, created_at, updated_at)
       VALUES (@id, @agent_group_id, @title, @content, @tags, @source_context, @created_at, @updated_at)`,
    )
    .run(memo);
}

export function getMemo(id: string, agentGroupId: string): Memo | undefined {
  return getMemoDb()
    .prepare('SELECT * FROM memos WHERE id = ? AND (agent_group_id = ? OR agent_group_id IS NULL)')
    .get(id, agentGroupId) as Memo | undefined;
}

export function updateMemo(
  id: string,
  agentGroupId: string,
  updates: Partial<Pick<Memo, 'title' | 'content' | 'tags'>>,
): boolean {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id, agent_group_id: agentGroupId };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return false;

  fields.push('updated_at = @updated_at');
  values.updated_at = new Date().toISOString();

  const result = getMemoDb()
    .prepare(
      `UPDATE memos SET ${fields.join(', ')} WHERE id = @id AND (agent_group_id = @agent_group_id OR agent_group_id IS NULL)`,
    )
    .run(values);
  return result.changes > 0;
}

export function deleteMemo(id: string, agentGroupId: string): boolean {
  const result = getMemoDb()
    .prepare('DELETE FROM memos WHERE id = ? AND (agent_group_id = ? OR agent_group_id IS NULL)')
    .run(id, agentGroupId);
  return result.changes > 0;
}

function sanitizeFtsQuery(query: string): string {
  const stripped = query
    .replace(/\b(AND|OR|NOT|NEAR)\b/gi, '')
    .replace(/[*"()^{}+]/g, '')
    .trim();
  const words = stripped.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return '';
  return words.map((w) => `"${w}"`).join(' ');
}

export function searchMemos(agentGroupId: string, query: string, limit = 5): MemoSearchResult[] {
  const sanitized = sanitizeFtsQuery(query);
  if (!sanitized) return [];

  try {
    return getMemoDb()
      .prepare(
        `SELECT m.*, bm25(memos_fts) AS rank,
                snippet(memos_fts, 1, '<b>', '</b>', '...', 32) AS snippet
         FROM memos m
         JOIN memos_fts ON memos_fts.rowid = m.rowid
         WHERE memos_fts MATCH ? AND (m.agent_group_id = ? OR m.agent_group_id IS NULL)
         ORDER BY rank
         LIMIT ?`,
      )
      .all(sanitized, agentGroupId, limit) as MemoSearchResult[];
  } catch {
    const pattern = `%${query}%`;
    return getMemoDb()
      .prepare(
        `SELECT *, 0 AS rank, '' AS snippet FROM memos
         WHERE (agent_group_id = ? OR agent_group_id IS NULL)
           AND (title LIKE ? OR content LIKE ? OR tags LIKE ?)
         ORDER BY updated_at DESC
         LIMIT ?`,
      )
      .all(agentGroupId, pattern, pattern, pattern, limit) as MemoSearchResult[];
  }
}

export function listMemos(agentGroupId: string, opts?: { tag?: string; limit?: number; offset?: number }): Memo[] {
  const limit = opts?.limit ?? 20;
  const offset = opts?.offset ?? 0;

  if (opts?.tag) {
    return getMemoDb()
      .prepare(
        `SELECT * FROM memos
         WHERE (agent_group_id = ? OR agent_group_id IS NULL) AND (',' || tags || ',') LIKE ?
         ORDER BY updated_at DESC
         LIMIT ? OFFSET ?`,
      )
      .all(agentGroupId, `%,${opts.tag},%`, limit, offset) as Memo[];
  }

  return getMemoDb()
    .prepare(
      `SELECT * FROM memos WHERE agent_group_id = ? OR agent_group_id IS NULL
       ORDER BY updated_at DESC
       LIMIT ? OFFSET ?`,
    )
    .all(agentGroupId, limit, offset) as Memo[];
}
