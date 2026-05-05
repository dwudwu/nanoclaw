/**
 * Memo MCP tools: memo_save, memo_search, memo_list, memo_delete.
 *
 * Reads go directly against /workspace/memos.db (mounted RO from host).
 * Writes are system actions routed through outbound.db → host delivery.
 */
import { Database } from 'bun:sqlite';
import fs from 'fs';

import { loadConfig } from '../config.js';
import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const MEMO_DB_PATH = '/workspace/memos.db';

function log(msg: string): void {
  console.error(`[mcp-tools/memo] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function generateId(): string {
  return `memo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function openMemoDb(): Database | null {
  if (!fs.existsSync(MEMO_DB_PATH)) return null;
  try {
    const db = new Database(MEMO_DB_PATH, { readonly: true });
    db.exec('PRAGMA busy_timeout = 3000');
    return db;
  } catch (e) {
    log(`Failed to open memo DB: ${e}`);
    return null;
  }
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

const memoSave: McpToolDefinition = {
  tool: {
    name: 'memo_save',
    description:
      'Save a memo to persistent memory. Use this to remember facts, preferences, project context, or anything that should persist across sessions. If a memo with the same id exists, it will be updated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: { type: 'string', description: 'Short title for the memo (used in search results)' },
        content: { type: 'string', description: 'The memo content — can be multi-line' },
        tags: {
          type: 'string',
          description: 'Comma-separated tags for categorization (e.g. "preference,coding-style")',
        },
        id: {
          type: 'string',
          description: 'Optional memo ID for updates. Omit to create a new memo.',
        },
      },
      required: ['title', 'content'],
    },
  },
  async handler(args) {
    const title = args.title as string;
    const content = args.content as string;
    const tags = (args.tags as string) || null;
    const id = (args.id as string) || generateId();

    if (!title || !content) return err('title and content are required');

    const config = loadConfig();
    const agentGroupId = config.agentGroupId;
    if (!agentGroupId) return err('agent group ID not configured');

    writeMessageOut({
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'system',
      content: JSON.stringify({
        action: 'memo_save',
        id,
        agent_group_id: agentGroupId,
        title,
        content,
        tags,
      }),
    });

    log(`memo_save: ${id} "${title}"`);
    return ok(`Memo saved (id: ${id})`);
  },
};

const memoSearch: McpToolDefinition = {
  tool: {
    name: 'memo_search',
    description:
      'Search memos by keyword. Uses full-text search across titles, content, and tags. Returns the most relevant matches.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query (keywords)' },
        limit: { type: 'number', description: 'Max results (default 5)' },
      },
      required: ['query'],
    },
  },
  async handler(args) {
    const query = args.query as string;
    const limit = (args.limit as number) || 5;
    if (!query) return err('query is required');

    const config = loadConfig();
    const agentGroupId = config.agentGroupId;
    if (!agentGroupId) return err('agent group ID not configured');

    const db = openMemoDb();
    if (!db) return ok('No memos yet.');

    try {
      const sanitized = sanitizeFtsQuery(query);
      if (!sanitized) return ok('No results (query too short or all stop words).');

      let rows: Array<Record<string, unknown>>;
      try {
        rows = db
          .prepare(
            `SELECT m.*, bm25(memos_fts) AS rank,
                    snippet(memos_fts, 1, '<b>', '</b>', '...', 32) AS snippet
             FROM memos m
             JOIN memos_fts ON memos_fts.rowid = m.rowid
             WHERE memos_fts MATCH $query AND (m.agent_group_id = $agentGroupId OR m.agent_group_id IS NULL)
             ORDER BY rank
             LIMIT $limit`,
          )
          .all({ $query: sanitized, $agentGroupId: agentGroupId, $limit: limit }) as Array<Record<string, unknown>>;
      } catch {
        const pattern = `%${query}%`;
        rows = db
          .prepare(
            `SELECT *, 0 AS rank, '' AS snippet FROM memos
             WHERE (agent_group_id = $agentGroupId OR agent_group_id IS NULL)
               AND (title LIKE $pattern OR content LIKE $pattern OR tags LIKE $pattern)
             ORDER BY updated_at DESC
             LIMIT $limit`,
          )
          .all({ $agentGroupId: agentGroupId, $pattern: pattern, $limit: limit }) as Array<Record<string, unknown>>;
      }

      if (rows.length === 0) return ok('No memos found matching that query.');

      const lines = rows.map((r) => {
        const tags = r.tags ? ` [${r.tags}]` : '';
        return `- **${r.title}**${tags} (id: ${r.id})\n  ${(r.snippet as string) || (r.content as string).slice(0, 100)}`;
      });

      return ok(lines.join('\n\n'));
    } finally {
      db.close();
    }
  },
};

const memoList: McpToolDefinition = {
  tool: {
    name: 'memo_list',
    description: 'List saved memos, optionally filtered by tag. Returns titles and IDs.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tag: { type: 'string', description: 'Filter by tag (exact match within comma-separated tags)' },
        limit: { type: 'number', description: 'Max results (default 20)' },
        offset: { type: 'number', description: 'Offset for pagination (default 0)' },
      },
    },
  },
  async handler(args) {
    const tag = args.tag as string | undefined;
    const limit = (args.limit as number) || 20;
    const offset = (args.offset as number) || 0;

    const config = loadConfig();
    const agentGroupId = config.agentGroupId;
    if (!agentGroupId) return err('agent group ID not configured');

    const db = openMemoDb();
    if (!db) return ok('No memos yet.');

    try {
      let rows: Array<Record<string, unknown>>;
      if (tag) {
        rows = db
          .prepare(
            `SELECT * FROM memos
             WHERE (agent_group_id = $agentGroupId OR agent_group_id IS NULL)
               AND (',' || tags || ',') LIKE $tagPattern
             ORDER BY updated_at DESC
             LIMIT $limit OFFSET $offset`,
          )
          .all({ $agentGroupId: agentGroupId, $tagPattern: `%,${tag},%`, $limit: limit, $offset: offset }) as Array<
          Record<string, unknown>
        >;
      } else {
        rows = db
          .prepare(
            `SELECT * FROM memos
             WHERE agent_group_id = $agentGroupId OR agent_group_id IS NULL
             ORDER BY updated_at DESC
             LIMIT $limit OFFSET $offset`,
          )
          .all({ $agentGroupId: agentGroupId, $limit: limit, $offset: offset }) as Array<Record<string, unknown>>;
      }

      if (rows.length === 0) return ok('No memos found.');

      const lines = rows.map((r) => {
        const tags = r.tags ? ` [${r.tags}]` : '';
        const preview = (r.content as string).slice(0, 60).replace(/\n/g, ' ');
        return `- **${r.title}**${tags} (id: ${r.id}) — ${preview}`;
      });

      return ok(lines.join('\n'));
    } finally {
      db.close();
    }
  },
};

const memoDelete: McpToolDefinition = {
  tool: {
    name: 'memo_delete',
    description: 'Delete a memo by ID. Use memo_list or memo_search to find the ID first.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Memo ID to delete' },
      },
      required: ['id'],
    },
  },
  async handler(args) {
    const id = args.id as string;
    if (!id) return err('id is required');

    const config = loadConfig();
    const agentGroupId = config.agentGroupId;
    if (!agentGroupId) return err('agent group ID not configured');

    writeMessageOut({
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'system',
      content: JSON.stringify({
        action: 'memo_delete',
        id,
        agent_group_id: agentGroupId,
      }),
    });

    log(`memo_delete: ${id}`);
    return ok(`Memo deleted (id: ${id})`);
  },
};

registerTools([memoSave, memoSearch, memoList, memoDelete]);
