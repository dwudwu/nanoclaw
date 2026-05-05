import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { initTestMemoDb, closeMemoDb } from '../../db/memo-db.js';
import type { Memo } from '../../types.js';
import { insertMemo, getMemo, updateMemo, deleteMemo, searchMemos, listMemos } from './db.js';

function now() {
  return new Date().toISOString();
}

function makeMemo(overrides: Partial<Memo> = {}): Memo {
  return {
    id: `memo-${Math.random().toString(36).slice(2, 8)}`,
    agent_group_id: 'ag-1',
    title: 'Test Memo',
    content: 'Some test content for the memo',
    tags: null,
    source_context: null,
    created_at: now(),
    updated_at: now(),
    ...overrides,
  };
}

beforeEach(() => {
  initTestMemoDb();
});

afterEach(() => {
  closeMemoDb();
});

describe('insertMemo + getMemo', () => {
  it('round-trips a memo', () => {
    const memo = makeMemo({ title: 'My Title', content: 'My Content', tags: 'food,music' });
    insertMemo(memo);
    const fetched = getMemo(memo.id, 'ag-1');
    expect(fetched).toBeDefined();
    expect(fetched!.title).toBe('My Title');
    expect(fetched!.content).toBe('My Content');
    expect(fetched!.tags).toBe('food,music');
  });

  it('returns undefined for non-existent id', () => {
    expect(getMemo('nope', 'ag-1')).toBeUndefined();
  });
});

describe('updateMemo', () => {
  it('updates partial fields and bumps updated_at', () => {
    const memo = makeMemo({ updated_at: '2020-01-01T00:00:00.000Z' });
    insertMemo(memo);
    const result = updateMemo(memo.id, 'ag-1', { title: 'New Title' });
    expect(result).toBe(true);
    const fetched = getMemo(memo.id, 'ag-1')!;
    expect(fetched.title).toBe('New Title');
    expect(fetched.content).toBe(memo.content);
    expect(fetched.updated_at).not.toBe('2020-01-01T00:00:00.000Z');
  });

  it('returns false for non-existent memo', () => {
    expect(updateMemo('nope', 'ag-1', { title: 'X' })).toBe(false);
  });

  it('returns false when no fields provided', () => {
    const memo = makeMemo();
    insertMemo(memo);
    expect(updateMemo(memo.id, 'ag-1', {})).toBe(false);
  });
});

describe('deleteMemo', () => {
  it('deletes and returns true', () => {
    const memo = makeMemo();
    insertMemo(memo);
    expect(deleteMemo(memo.id, 'ag-1')).toBe(true);
    expect(getMemo(memo.id, 'ag-1')).toBeUndefined();
  });

  it('returns false on second delete', () => {
    const memo = makeMemo();
    insertMemo(memo);
    deleteMemo(memo.id, 'ag-1');
    expect(deleteMemo(memo.id, 'ag-1')).toBe(false);
  });
});

describe('searchMemos', () => {
  it('finds memos by content keyword', () => {
    insertMemo(makeMemo({ title: 'Sushi Place', content: 'Great omakase restaurant in Orchard Road', tags: 'food' }));
    insertMemo(makeMemo({ title: 'Meeting Notes', content: 'Discussed quarterly targets' }));
    const results = searchMemos('ag-1', 'restaurant');
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('Sushi Place');
    expect(results[0].rank).toBeDefined();
  });

  it('finds memos by title keyword', () => {
    insertMemo(makeMemo({ title: 'Docker Benchmarks', content: 'Sequential write tests' }));
    const results = searchMemos('ag-1', 'Docker');
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('Docker Benchmarks');
  });

  it('returns empty for no match', () => {
    insertMemo(makeMemo({ title: 'Hello', content: 'World' }));
    expect(searchMemos('ag-1', 'xyzzyplugh')).toHaveLength(0);
  });

  it('returns empty for empty query', () => {
    insertMemo(makeMemo());
    expect(searchMemos('ag-1', '')).toHaveLength(0);
  });

  it('handles FTS5 operator injection without throwing', () => {
    insertMemo(makeMemo({ title: 'Safe Memo', content: 'Normal content here' }));
    expect(() => searchMemos('ag-1', 'AND OR NOT * "hello" (test)')).not.toThrow();
  });

  it('respects limit', () => {
    for (let i = 0; i < 10; i++) {
      insertMemo(makeMemo({ title: `Memo ${i}`, content: 'shared keyword banana' }));
    }
    const results = searchMemos('ag-1', 'banana', 3);
    expect(results.length).toBe(3);
  });
});

describe('listMemos', () => {
  it('lists memos ordered by updated_at DESC', () => {
    insertMemo(makeMemo({ id: 'old', title: 'Old', updated_at: '2020-01-01T00:00:00.000Z' }));
    insertMemo(makeMemo({ id: 'new', title: 'New', updated_at: '2025-01-01T00:00:00.000Z' }));
    const list = listMemos('ag-1');
    expect(list[0].id).toBe('new');
    expect(list[1].id).toBe('old');
  });

  it('filters by tag', () => {
    insertMemo(makeMemo({ id: 'm1', tags: 'food,music' }));
    insertMemo(makeMemo({ id: 'm2', tags: 'work' }));
    const list = listMemos('ag-1', { tag: 'food' });
    expect(list.length).toBe(1);
    expect(list[0].id).toBe('m1');
  });

  it('respects limit and offset', () => {
    for (let i = 0; i < 5; i++) {
      insertMemo(makeMemo({ id: `m-${i}`, updated_at: `2025-01-0${i + 1}T00:00:00.000Z` }));
    }
    const page = listMemos('ag-1', { limit: 2, offset: 2 });
    expect(page.length).toBe(2);
  });
});

describe('tenant isolation', () => {
  it('getMemo scoped to agent group', () => {
    const memo = makeMemo({ agent_group_id: 'ag-1' });
    insertMemo(memo);
    expect(getMemo(memo.id, 'ag-1')).toBeDefined();
    expect(getMemo(memo.id, 'ag-2')).toBeUndefined();
  });

  it('searchMemos scoped to agent group', () => {
    insertMemo(makeMemo({ agent_group_id: 'ag-1', content: 'unique keyword platypus' }));
    expect(searchMemos('ag-1', 'platypus')).toHaveLength(1);
    expect(searchMemos('ag-2', 'platypus')).toHaveLength(0);
  });

  it('updateMemo scoped to agent group', () => {
    const memo = makeMemo({ agent_group_id: 'ag-1' });
    insertMemo(memo);
    expect(updateMemo(memo.id, 'ag-2', { title: 'Hacked' })).toBe(false);
    expect(getMemo(memo.id, 'ag-1')!.title).toBe(memo.title);
  });

  it('deleteMemo scoped to agent group', () => {
    const memo = makeMemo({ agent_group_id: 'ag-1' });
    insertMemo(memo);
    expect(deleteMemo(memo.id, 'ag-2')).toBe(false);
    expect(getMemo(memo.id, 'ag-1')).toBeDefined();
  });

  it('listMemos scoped to agent group', () => {
    insertMemo(makeMemo({ agent_group_id: 'ag-1' }));
    insertMemo(makeMemo({ agent_group_id: 'ag-2' }));
    expect(listMemos('ag-1')).toHaveLength(1);
    expect(listMemos('ag-2')).toHaveLength(1);
  });
});

describe('global memos (agent_group_id = null)', () => {
  it('global memo visible to all groups via getMemo', () => {
    const memo = makeMemo({ id: 'global-1', agent_group_id: null });
    insertMemo(memo);
    expect(getMemo('global-1', 'ag-1')).toBeDefined();
    expect(getMemo('global-1', 'ag-2')).toBeDefined();
  });

  it('global memo appears in searchMemos for any group', () => {
    insertMemo(makeMemo({ agent_group_id: null, content: 'global keyword mango' }));
    expect(searchMemos('ag-1', 'mango')).toHaveLength(1);
    expect(searchMemos('ag-2', 'mango')).toHaveLength(1);
  });

  it('global memo appears in listMemos for any group', () => {
    insertMemo(makeMemo({ agent_group_id: null }));
    expect(listMemos('ag-1')).toHaveLength(1);
    expect(listMemos('ag-2')).toHaveLength(1);
  });

  it('global memo can be updated from any group', () => {
    insertMemo(makeMemo({ id: 'global-2', agent_group_id: null, title: 'Old' }));
    expect(updateMemo('global-2', 'ag-1', { title: 'New' })).toBe(true);
    expect(getMemo('global-2', 'ag-2')!.title).toBe('New');
  });

  it('global memo can be deleted from any group', () => {
    insertMemo(makeMemo({ id: 'global-3', agent_group_id: null }));
    expect(deleteMemo('global-3', 'ag-1')).toBe(true);
    expect(getMemo('global-3', 'ag-2')).toBeUndefined();
  });

  it('scoped memo still invisible to other groups', () => {
    insertMemo(makeMemo({ agent_group_id: 'ag-1', content: 'secret keyword papaya' }));
    expect(searchMemos('ag-1', 'papaya')).toHaveLength(1);
    expect(searchMemos('ag-2', 'papaya')).toHaveLength(0);
  });
});
