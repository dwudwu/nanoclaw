/**
 * Memo module — persistent, searchable agent memory.
 *
 * Registers delivery action handlers for memo_save and memo_delete.
 * The container reads memos.db directly (mounted RO); writes go through
 * system actions → host delivery → this module → memos.db.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import { insertMemo, updateMemo, deleteMemo } from './db.js';
import type { Memo } from '../../types.js';

registerDeliveryAction('memo_save', async (content) => {
  const id = content.id as string;
  const agentGroupId = content.agent_group_id as string;
  const title = content.title as string;
  const memoContent = content.content as string;
  const tags = (content.tags as string) || null;
  const sourceContext = (content.source_context as string) || null;

  if (!id || !agentGroupId || !title || !memoContent) {
    log.warn('memo_save: missing required fields', { id, agentGroupId, title: !!title });
    return;
  }

  // Upsert: try update first, insert if not found
  const updated = updateMemo(id, agentGroupId, { title, content: memoContent, tags });
  if (!updated) {
    const now = new Date().toISOString();
    const memo: Memo = {
      id,
      agent_group_id: agentGroupId,
      title,
      content: memoContent,
      tags,
      source_context: sourceContext,
      created_at: now,
      updated_at: now,
    };
    insertMemo(memo);
  }

  log.info('memo_save applied', { id, agentGroupId });
});

registerDeliveryAction('memo_delete', async (content) => {
  const id = content.id as string;
  const agentGroupId = content.agent_group_id as string;

  if (!id || !agentGroupId) {
    log.warn('memo_delete: missing required fields', { id, agentGroupId });
    return;
  }

  const removed = deleteMemo(id, agentGroupId);
  log.info('memo_delete applied', { id, agentGroupId, removed });
});
