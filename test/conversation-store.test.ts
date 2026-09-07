import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConversationStore, type AppendEvent } from '../src/server/conversations.js';
import { createPostgresFixture } from './fixtures/postgres.js';

const owner = '11111111-1111-4111-8111-111111111111';
const otherOwner = '22222222-2222-4222-8222-222222222222';
const ids = {
  first: '10000000-0000-4000-8000-000000000001',
  second: '10000000-0000-4000-8000-000000000002',
  third: '10000000-0000-4000-8000-000000000003',
};

describe.sequential('ConversationStore', () => {
  let database: Awaited<ReturnType<typeof createPostgresFixture>>;
  let store: ConversationStore;

  beforeAll(async () => {
    database = await createPostgresFixture();
    store = new ConversationStore(database.pool);
    await store.migrate();
  });
  afterAll(async () => { await database.close(); });

  it('overrides connection URL search_path options with its disposable schema', async () => {
    const original = process.env.TEST_DATABASE_URL!;
    const url = new URL(original);
    url.searchParams.set('options', '-c search_path=public');
    let isolated: Awaited<ReturnType<typeof createPostgresFixture>> | undefined;
    try {
      process.env.TEST_DATABASE_URL = url.toString();
      isolated = await createPostgresFixture();
      const current = await isolated.pool.query<{ schema: string }>('SELECT current_schema() AS schema');
      expect(current.rows[0]?.schema).toMatch(/^test_conversations_[0-9a-f]{32}$/);
    } finally {
      process.env.TEST_DATABASE_URL = original;
      await isolated?.close();
    }
  });

  it('creates idempotently, isolates owners, paginates by UUID, and survives a reopened pool', async () => {
    const created = await Promise.all(Object.values(ids).map(id => store.create(owner, id)));
    expect(created[0]).toMatchObject({ id: ids.first, archived: false, revision: 0 });
    expect(typeof created[0]?.createdAt).toBe('string');
    expect(await store.create(owner, ids.first)).toEqual(created[0]);
    await expect(store.get(otherOwner, ids.first)).rejects.toMatchObject({ status: 404 });

    const page1 = await store.list(owner, { limit: 2 });
    expect(page1.conversations.map(conversation => conversation.id)).toEqual([ids.first, ids.second]);
    expect(page1.nextCursor).toBe(ids.second);
    const page2 = await store.list(owner, { after: page1.nextCursor, limit: 2 });
    expect(page2.conversations.map(conversation => conversation.id)).toEqual([ids.third]);
    expect(page2.nextCursor).toBeUndefined();
    expect((await store.list(otherOwner)).conversations).toEqual([]);

    await store.append(owner, ids.third, {
      id: randomUUID(), kind: 'message_omitted', role: 'user', expectedRevision: 0,
    });
    const history = await store.events(owner, ids.third);
    await database.closePool(database.pool);
    database.pool = database.openPool();
    store = new ConversationStore(database.pool);
    expect(await store.get(owner, ids.first)).toEqual(created[0]);
    expect(await store.events(owner, ids.third)).toEqual(history);
  });

  it('deduplicates an identical concurrent event before stale checks and rejects conflicting reuse', async () => {
    const event = {
      id: randomUUID(), kind: 'run_linked', role: 'assistant', runId: randomUUID(), expectedRevision: 0,
    } as const;
    const appended = await Promise.all([store.append(owner, ids.first, event), store.append(owner, ids.first, event)]);
    expect(appended[0]).toEqual(appended[1]);
    expect(appended[0]).toMatchObject({ id: event.id, sequence: 1, kind: event.kind, role: event.role, runId: event.runId });
    expect((await store.events(owner, ids.first)).events).toEqual([appended[0]]);
    await expect(store.append(owner, ids.first, { ...event, runId: randomUUID() })).rejects.toMatchObject({ status: 409 });
    await expect(store.append(otherOwner, ids.first, event)).rejects.toMatchObject({ status: 404 });
  });

  it('serializes competing events and allocates revision-backed sequences', async () => {
    const conversationId = randomUUID();
    await store.create(owner, conversationId);
    const competing = [
      { id: randomUUID(), kind: 'message_omitted', role: 'user', expectedRevision: 0 } as const,
      { id: randomUUID(), kind: 'message_omitted', role: 'assistant', expectedRevision: 0 } as const,
    ];
    const results = await Promise.allSettled(competing.map(event => store.append(owner, conversationId, event)));
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } });

    const first = (await store.events(owner, conversationId)).events[0]!;
    const second = await store.append(owner, conversationId, {
      id: randomUUID(), kind: 'message_omitted', role: 'assistant', expectedRevision: 1,
    });
    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect((await store.get(owner, conversationId)).revision).toBe(2);
  });

  it('paginates events in sequence order', async () => {
    const conversationId = randomUUID();
    await store.create(owner, conversationId);
    for (let expectedRevision = 0; expectedRevision < 3; expectedRevision++) {
      await store.append(owner, conversationId, {
        id: randomUUID(), kind: 'message_omitted', role: expectedRevision % 2 ? 'assistant' : 'user', expectedRevision,
      });
    }
    const page1 = await store.events(owner, conversationId, { limit: 2 });
    expect(page1.events.map(event => event.sequence)).toEqual([1, 2]);
    expect(page1.nextCursor).toBe(2);
    const page2 = await store.events(owner, conversationId, { after: page1.nextCursor, limit: 2 });
    expect(page2.events.map(event => event.sequence)).toEqual([3]);
    expect(page2.nextCursor).toBeUndefined();
  });

  it('makes archived conversations read-only until a revision-checked unarchive', async () => {
    const conversationId = randomUUID();
    await store.create(owner, conversationId);
    const archived = await store.archive(owner, conversationId, true, 0);
    expect(archived).toMatchObject({ archived: true, revision: 1 });
    expect((await store.list(owner, { archived: true })).conversations.map(item => item.id)).toContain(conversationId);
    expect((await store.list(owner)).conversations.map(item => item.id)).not.toContain(conversationId);
    await expect(store.append(owner, conversationId, {
      id: randomUUID(), kind: 'message_omitted', role: 'user', expectedRevision: 1,
    })).rejects.toMatchObject({ status: 409 });
    await expect(store.archive(owner, conversationId, false, 0)).rejects.toMatchObject({ status: 409 });
    expect(await store.get(owner, conversationId)).toEqual(archived);
    expect(await store.archive(owner, conversationId, false, 1)).toMatchObject({ archived: false, revision: 2 });
    expect(await store.append(owner, conversationId, {
      id: randomUUID(), kind: 'message_omitted', role: 'user', expectedRevision: 2,
    })).toMatchObject({ sequence: 3 });
    await expect(store.archive(otherOwner, conversationId, true, 2)).rejects.toMatchObject({ status: 404 });
  });

  it('deletes events atomically, hides tombstones, and prevents resurrection', async () => {
    const conversationId = randomUUID();
    await store.create(owner, conversationId);
    await store.append(owner, conversationId, {
      id: randomUUID(), kind: 'run_linked', role: 'assistant', runId: randomUUID(), expectedRevision: 0,
    });
    await expect(store.delete(otherOwner, conversationId, 1)).rejects.toMatchObject({ status: 404 });
    await expect(store.delete(owner, conversationId, 0)).rejects.toMatchObject({ status: 409 });
    expect((await store.events(owner, conversationId)).events).toHaveLength(1);

    await store.delete(owner, conversationId, 1);
    await expect(store.get(owner, conversationId)).rejects.toMatchObject({ status: 404 });
    await expect(store.events(owner, conversationId)).rejects.toMatchObject({ status: 404 });
    await expect(store.create(owner, conversationId)).rejects.toMatchObject({ status: 409 });
    expect((await database.pool.query('SELECT count(*)::int AS count FROM meridian_conversation_events WHERE conversation_id = $1', [conversationId])).rows[0]).toEqual({ count: 0 });
  });

  it('rejects malformed and raw inputs before they reach PostgreSQL', async () => {
    const conversationId = randomUUID();
    await store.create(owner, conversationId);
    const canary = 'PRIVATE raw conversation text must never persist';
    const valid: AppendEvent = {
      id: randomUUID(), kind: 'message_omitted', role: 'user', expectedRevision: 0,
    };
    const invalid: unknown[][] = [
      [`subject:${owner}`, randomUUID()],
      ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'.toUpperCase(), randomUUID()],
      [owner, 'not-a-uuid'],
    ];
    for (const args of invalid) {
      await expect(store.create(args[0] as string, args[1] as string)).rejects.toMatchObject({ status: 400 });
    }
    for (const event of [
      { ...valid, text: canary },
      { ...valid, role: 'operator' },
      { ...valid, kind: 'raw_message' },
      { ...valid, id: 'not-a-uuid' },
      { ...valid, expectedRevision: -1 },
      { ...valid, runId: randomUUID() },
      { ...valid, kind: 'run_linked' },
    ]) {
      await expect(store.append(owner, conversationId, event as AppendEvent)).rejects.toMatchObject({ status: 400 });
    }
    await expect(store.list(owner, { limit: 101 })).rejects.toMatchObject({ status: 400 });
    await expect(store.events(owner, conversationId, { after: -1 })).rejects.toMatchObject({ status: 400 });
    const serialized = (await database.pool.query(
      'SELECT coalesce(string_agg(row_to_json(event)::text, $1), $1) AS value FROM meridian_conversation_events event WHERE conversation_id = $2',
      ['', conversationId],
    )).rows[0]?.value;
    expect(serialized).not.toContain(canary);
  });
});
