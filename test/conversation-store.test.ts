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

  it('namespaces conversation and event identities by owner', async () => {
    const namespaceOwner = '31111111-1111-4111-8111-111111111111';
    const namespaceOtherOwner = '32222222-2222-4222-8222-222222222222';
    const conversationId = randomUUID();
    const eventId = randomUUID();
    const first = await store.create(namespaceOwner, conversationId);
    const second = await store.create(namespaceOtherOwner, conversationId);
    expect(first.id).toBe(second.id);
    await expect(store.create(namespaceOwner, conversationId)).resolves.toEqual(first);
    await expect(store.append(namespaceOwner, conversationId, {
      id: eventId, kind: 'message_omitted', role: 'user', expectedRevision: 0,
    })).resolves.toMatchObject({ id: eventId, sequence: 1 });
    await expect(store.append(namespaceOtherOwner, conversationId, {
      id: eventId, kind: 'message_omitted', role: 'assistant', expectedRevision: 0,
    })).resolves.toMatchObject({ id: eventId, sequence: 1 });
    const otherConversation = randomUUID();
    await store.create(namespaceOwner, otherConversation);
    await expect(store.append(namespaceOwner, otherConversation, {
      id: eventId, kind: 'message_omitted', role: 'user', expectedRevision: 0,
    })).rejects.toMatchObject({ status: 409, message: 'Conversation event conflicts with an existing event' });
    expect((await store.events(namespaceOwner, conversationId)).events).toHaveLength(1);
    expect((await store.events(namespaceOtherOwner, conversationId)).events).toHaveLength(1);
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

const quotaOwner = '33333333-3333-4333-8333-333333333333';
const quotaOtherOwner = '44444444-4444-4444-8444-444444444444';
const quotaBoundaryOwner = '55555555-5555-4555-8555-555555555555';
const testUuid = (prefix: string, value: number) => `${prefix}${value.toString(16).padStart(12, '0')}`;

type QuotaSnapshot = {
  sourceConversationCount: number;
  sourceEventCount: number;
  conversationCount: number;
  eventCount: number;
  rateTokens: number;
};

async function quotaSnapshot(database: Awaited<ReturnType<typeof createPostgresFixture>>, owner: string): Promise<QuotaSnapshot> {
  const source = await database.pool.query<{ conversations: string; events: string }>(`
    SELECT count(DISTINCT conversations.id)::bigint AS conversations, count(events.id)::bigint AS events
    FROM meridian_conversations conversations
    LEFT JOIN meridian_conversation_events events ON events.conversation_id = conversations.id
    WHERE conversations.owner_id = $1
  `, [owner]);
  const quota = await database.pool.query<{ conversations: string; events: string; tokens: number }>(`
    SELECT conversation_count AS conversations, event_count AS events, rate_tokens AS tokens
    FROM meridian_conversation_subject_quotas WHERE owner_id = $1
  `, [owner]);
  const sourceRow = source.rows[0]!;
  const quotaRow = quota.rows[0]!;
  return {
    sourceConversationCount: Number(sourceRow.conversations),
    sourceEventCount: Number(sourceRow.events),
    conversationCount: Number(quotaRow.conversations),
    eventCount: Number(quotaRow.events),
    rateTokens: Number(quotaRow.tokens),
  };
}

async function resetQuotaRate(database: Awaited<ReturnType<typeof createPostgresFixture>>, owner: string) {
  await database.pool.query(
    `UPDATE meridian_conversation_subject_quotas
     SET rate_tokens = 20, rate_refilled_at = clock_timestamp()
     WHERE owner_id = $1`,
    [owner],
  );
}

function expectQuotaSnapshotConsistent(snapshot: QuotaSnapshot) {
  expect(snapshot.conversationCount).toBe(snapshot.sourceConversationCount);
  expect(snapshot.eventCount).toBe(snapshot.sourceEventCount);
}

function expectSuccessfulTokenDelta(before: QuotaSnapshot, after: QuotaSnapshot, successfulMutations: number) {
  const delta = before.rateTokens - after.rateTokens;
  expect(delta).toBeGreaterThanOrEqual(successfulMutations - 0.75);
  expect(delta).toBeLessThanOrEqual(successfulMutations + 0.75);
}

async function createSourceSchema(database: Awaited<ReturnType<typeof createPostgresFixture>>) {
  await database.pool.query(`
    CREATE TABLE meridian_conversations (
      id uuid PRIMARY KEY,
      owner_id uuid NOT NULL,
      archived boolean NOT NULL DEFAULT false,
      revision bigint NOT NULL DEFAULT 0 CHECK (revision BETWEEN 0 AND 9007199254740991),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      deleted_at timestamptz
    );
    CREATE TABLE meridian_conversation_events (
      id uuid PRIMARY KEY,
      conversation_id uuid NOT NULL REFERENCES meridian_conversations (id),
      sequence bigint NOT NULL CHECK (sequence BETWEEN 0 AND 9007199254740991),
      kind text NOT NULL CHECK (kind IN ('message_omitted', 'run_linked')),
      role text NOT NULL CHECK (role IN ('user', 'assistant')),
      run_id uuid,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      UNIQUE (conversation_id, sequence),
      CHECK ((kind = 'run_linked' AND run_id IS NOT NULL) OR (kind = 'message_omitted' AND run_id IS NULL))
    );
  `);
}

async function seedConversationRows(database: Awaited<ReturnType<typeof createPostgresFixture>>, owner: string, count: number, prefix: string) {
  await database.pool.query(`
    INSERT INTO meridian_conversations (id, owner_id)
    SELECT ($3 || lpad(value::text, 12, '0'))::uuid, $1
    FROM generate_series(1, $2::int) AS values(value)
  `, [owner, count, prefix]);
  return Array.from({ length: count }, (_, index) => `${prefix}${(index + 1).toString(16).padStart(12, '0')}`);
}

async function seedEvents(database: Awaited<ReturnType<typeof createPostgresFixture>>, owner: string, conversationId: string, count: number, prefix: string) {
  await database.pool.query(`
    INSERT INTO meridian_conversation_events (id, owner_id, conversation_id, sequence, kind, role)
    SELECT ($4 || lpad(value::text, 12, '0'))::uuid, $1, $2, value, 'message_omitted', 'user'
    FROM generate_series(1, $3::int) AS values(value)
  `, [owner, conversationId, count, prefix]);
  return Array.from({ length: count }, (_, index) => `${prefix}${(index + 1).toString(16).padStart(12, '0')}`);
}

describe.sequential('ConversationStore durable quotas', () => {
  it('reconciles source rows into durable subject quotas without trimming or resetting rate fields', async () => {
    const database = await createPostgresFixture();
    try {
      await createSourceSchema(database);
      await database.pool.query(`
        INSERT INTO meridian_conversations (id, owner_id, archived)
        VALUES
          ('51000000-0000-4000-8000-000000000001', $1, false),
          ('51000000-0000-4000-8000-000000000002', $1, true),
          ('51000000-0000-4000-8000-000000000003', $1, false),
          ('52000000-0000-4000-8000-000000000001', $2, false)
      `, [quotaOwner, quotaOtherOwner]);
      await database.pool.query(`
        UPDATE meridian_conversations
        SET deleted_at = clock_timestamp()
        WHERE id = '51000000-0000-4000-8000-000000000003'
      `);
      await database.pool.query(`
        INSERT INTO meridian_conversation_events (id, conversation_id, sequence, kind, role)
        VALUES
          ('61000000-0000-4000-8000-000000000001', '51000000-0000-4000-8000-000000000001', 1, 'message_omitted', 'user'),
          ('61000000-0000-4000-8000-000000000002', '51000000-0000-4000-8000-000000000002', 1, 'message_omitted', 'user'),
          ('62000000-0000-4000-8000-000000000001', '52000000-0000-4000-8000-000000000001', 1, 'message_omitted', 'assistant')
      `);
      await database.pool.query(`
        INSERT INTO meridian_conversations (id, owner_id)
        SELECT ('53000000-0000-4000-8000-' || lpad(value::text, 12, '0'))::uuid, $1
        FROM generate_series(1, 129) AS values(value);
      `, [quotaOwner]);
      await database.pool.query(`
        INSERT INTO meridian_conversation_events (id, conversation_id, sequence, kind, role)
        SELECT ('63000000-0000-4000-8000-' || lpad(value::text, 12, '0'))::uuid,
               '53000000-0000-4000-8000-000000000001'::uuid, value, 'message_omitted', 'user'
        FROM generate_series(1, 4097) AS values(value);
      `);
      const store = new ConversationStore(database.pool);
      await store.migrate();
      const before = await database.pool.query(`
        UPDATE meridian_conversation_subject_quotas
        SET rate_tokens = 3.25, rate_refilled_at = '2025-01-02T03:04:05.000Z'
        WHERE owner_id = $1
        RETURNING rate_tokens, rate_refilled_at
      `, [quotaOwner]);
      expect(before.rows[0]).toMatchObject({ rate_tokens: 3.25, rate_refilled_at: new Date('2025-01-02T03:04:05.000Z') });
      await expect(store.migrate()).resolves.toBeUndefined();
      const quotas = await database.pool.query(`
        SELECT owner_id, conversation_count, event_count, rate_tokens, rate_refilled_at
        FROM meridian_conversation_subject_quotas ORDER BY owner_id
      `);
      expect(quotas.rows).toHaveLength(2);
      expect(quotas.rows.find(row => row.owner_id === quotaOwner)).toMatchObject({
        conversation_count: '132', event_count: '4099', rate_tokens: 3.25,
        rate_refilled_at: before.rows[0]!.rate_refilled_at,
      });
      expect(quotas.rows.find(row => row.owner_id === quotaOtherOwner)).toMatchObject({
        conversation_count: '1', event_count: '1',
      });
      expect((await database.pool.query('SELECT count(*)::int AS count FROM meridian_conversations')).rows[0]).toEqual({ count: 133 });
      expect((await database.pool.query('SELECT count(*)::int AS count FROM meridian_conversation_events')).rows[0]).toEqual({ count: 4100 });
    } finally {
      await database.close();
    }
  });

  it('enforces conversation and subject event capacity, preserves exact retries, and releases deleted events', async () => {
    const database = await createPostgresFixture();
    try {
      const store = new ConversationStore(database.pool);
      await store.migrate();
      const conversations = await seedConversationRows(database, quotaOwner, 128, '70000000-0000-4000-8000-');
      await store.migrate();
      const boundary = conversations[0]!;
      const created = await store.create(quotaOwner, boundary);
      expect(await store.create(quotaOwner, boundary)).toEqual(created);
      await expect(store.create(quotaOwner, testUuid('71000000-0000-4000-8000-', 1))).rejects.toMatchObject({
        status: 507, message: 'Conversation quota exceeded',
      });

      const deletionBoundary = await seedConversationRows(database, quotaBoundaryOwner, 128, '71000000-0000-4000-8000-');
      await seedEvents(database, quotaBoundaryOwner, deletionBoundary[0]!, 1, '71010000-0000-4000-9000-');
      await database.pool.query('UPDATE meridian_conversations SET revision = 1 WHERE id = $1', [deletionBoundary[0]]);
      await store.migrate();
      const beforeDelete = await quotaSnapshot(database, quotaBoundaryOwner);
      expectQuotaSnapshotConsistent(beforeDelete);
      expect(beforeDelete).toMatchObject({ sourceConversationCount: 128, sourceEventCount: 1, conversationCount: 128, eventCount: 1 });
      await store.delete(quotaBoundaryOwner, deletionBoundary[0]!, 1);
      const afterDelete = await quotaSnapshot(database, quotaBoundaryOwner);
      expectQuotaSnapshotConsistent(afterDelete);
      expect(afterDelete).toMatchObject({ sourceConversationCount: 128, sourceEventCount: 0, conversationCount: 128, eventCount: 0 });
      await expect(store.create(quotaBoundaryOwner, deletionBoundary[0]!)).rejects.toMatchObject({ status: 409 });
      await expect(store.append(quotaBoundaryOwner, deletionBoundary[1]!, {
        id: testUuid('71020000-0000-4000-9000-', 1), kind: 'message_omitted', role: 'user', expectedRevision: 0,
      })).resolves.toMatchObject({ sequence: 1 });

      const eventConversation = testUuid('72000000-0000-4000-8000-', 1);
      await store.create(quotaOtherOwner, eventConversation);
      const eventIds = await seedEvents(database, quotaOtherOwner, eventConversation, 512, '73000000-0000-4000-9000-');
      await database.pool.query('UPDATE meridian_conversations SET revision = 512 WHERE id = $1', [eventConversation]);
      await store.migrate();
      const retry = await store.append(quotaOtherOwner, eventConversation, {
        id: eventIds[0]!, kind: 'message_omitted', role: 'user', expectedRevision: 0,
      });
      expect(retry.sequence).toBe(1);
      await expect(store.append(quotaOtherOwner, eventConversation, {
        id: testUuid('74000000-0000-4000-9000-', 1), kind: 'message_omitted', role: 'user', expectedRevision: 512,
      })).rejects.toMatchObject({ status: 507, message: 'Conversation quota exceeded' });

      const subjectConversations = await seedConversationRows(database, quotaOwner, 9, '75000000-0000-4000-8000-');
      for (const [index, conversationId] of subjectConversations.entries()) {
        if (index < 8) {
          await seedEvents(database, quotaOwner, conversationId, 512, `${(0x76 + index).toString(16).padStart(8, '0')}-0000-4000-9000-`);
          await database.pool.query('UPDATE meridian_conversations SET revision = 512 WHERE id = $1', [conversationId]);
        }
      }
      await store.migrate();
      const openSubjectConversation = subjectConversations[8]!;
      await expect(store.append(quotaOwner, openSubjectConversation, {
        id: testUuid('77000000-0000-4000-9000-', 1), kind: 'message_omitted', role: 'user', expectedRevision: 0,
      })).rejects.toMatchObject({ status: 507, message: 'Conversation quota exceeded' });
      await store.delete(quotaOwner, subjectConversations[0]!, 512);
      await expect(store.create(quotaOwner, subjectConversations[0]!)).rejects.toMatchObject({ status: 409 });
      await expect(store.append(quotaOwner, openSubjectConversation, {
        id: testUuid('77000000-0000-4000-9000-', 2), kind: 'message_omitted', role: 'user', expectedRevision: 0,
      })).resolves.toMatchObject({ sequence: 1 });
      const counts = await database.pool.query(`
        SELECT conversation_count, event_count
        FROM meridian_conversation_subject_quotas WHERE owner_id = $1
      `, [quotaOwner]);
      expect(counts.rows[0]).toMatchObject({ conversation_count: '137', event_count: '3585' });
    } finally {
      await database.close();
    }
  });

  it('persists the twenty-mutation write bucket and refills from PostgreSQL time', async () => {
    const database = await createPostgresFixture();
    try {
      let store = new ConversationStore(database.pool);
      await store.migrate();
      const conversationId = testUuid('78000000-0000-4000-8000-', 1);
      await store.create(quotaOwner, conversationId);
      for (let expectedRevision = 0; expectedRevision < 19; expectedRevision++) {
        await store.append(quotaOwner, conversationId, {
          id: testUuid('79000000-0000-4000-9000-', expectedRevision + 1),
          kind: 'message_omitted', role: 'user', expectedRevision,
        });
      }
      const exact = {
        id: testUuid('79000000-0000-4000-9000-', 1), kind: 'message_omitted' as const, role: 'user' as const, expectedRevision: 0,
      };
      const setZeroCheckpoint = async () => database.pool.query(
        `UPDATE meridian_conversation_subject_quotas
         SET rate_tokens = 0, rate_refilled_at = clock_timestamp()
         WHERE owner_id = $1`,
        [quotaOwner],
      );
      const readRate = async () => database.pool.query<{ rate_tokens: number; rate_refilled_at: Date }>(
        'SELECT rate_tokens, rate_refilled_at FROM meridian_conversation_subject_quotas WHERE owner_id = $1',
        [quotaOwner],
      );
      await setZeroCheckpoint();
      const before = await readRate();
      await expect(store.append(quotaOwner, conversationId, exact)).resolves.toMatchObject({ sequence: 1 });
      const afterExact = await readRate();
      expect(afterExact.rows[0]).toEqual(before.rows[0]);
      await setZeroCheckpoint();
      const beforeReopen429 = await readRate();
      await expect(store.append(quotaOwner, conversationId, {
        id: testUuid('79000000-0000-4000-9000-', 20), kind: 'message_omitted', role: 'user', expectedRevision: 19,
      })).rejects.toMatchObject({ status: 429, message: 'Conversation write rate limit exceeded' });
      const afterFirst429 = await readRate();
      expect(afterFirst429.rows[0]).toEqual(beforeReopen429.rows[0]);
      await database.closePool(database.pool);
      database.pool = database.openPool();
      store = new ConversationStore(database.pool);
      const afterReopen = await readRate();
      expect(afterReopen.rows[0]).toEqual(afterFirst429.rows[0]);
      await setZeroCheckpoint();
      const beforeSecond429 = await readRate();
      await expect(store.append(quotaOwner, conversationId, {
        id: testUuid('79000000-0000-4000-9000-', 20), kind: 'message_omitted', role: 'user', expectedRevision: 19,
      })).rejects.toMatchObject({ status: 429, message: 'Conversation write rate limit exceeded' });
      const afterSecond429 = await readRate();
      expect(afterSecond429.rows[0]).toEqual(beforeSecond429.rows[0]);
      await setZeroCheckpoint();
      await database.pool.query('SELECT pg_sleep(1.1)');
      await expect(store.append(quotaOwner, conversationId, {
        id: testUuid('79000000-0000-4000-9000-', 20), kind: 'message_omitted', role: 'user', expectedRevision: 19,
      })).resolves.toMatchObject({ sequence: 20 });

      const capacityConversation = testUuid('81000000-0000-4000-8000-', 1);
      await store.create(quotaOtherOwner, capacityConversation);
      await seedEvents(database, quotaOtherOwner, capacityConversation, 512, '82000000-0000-4000-9000-');
      await database.pool.query('UPDATE meridian_conversations SET revision = 512 WHERE id = $1', [capacityConversation]);
      await store.migrate();
      await database.pool.query(
        `UPDATE meridian_conversation_subject_quotas
         SET rate_tokens = 0, rate_refilled_at = clock_timestamp()
         WHERE owner_id = $1`,
        [quotaOtherOwner],
      );
      await expect(store.append(quotaOtherOwner, capacityConversation, {
        id: testUuid('83000000-0000-4000-9000-', 1), kind: 'message_omitted', role: 'user', expectedRevision: 512,
      })).rejects.toMatchObject({ status: 507, message: 'Conversation quota exceeded' });
    } finally {
      await database.close();
    }
  });

  it('serializes concurrent owners through quota rows and rolls back failed races', async () => {
    const database = await createPostgresFixture();
    const secondPool = database.openPool();
    try {
      const firstStore = new ConversationStore(database.pool);
      const secondStore = new ConversationStore(secondPool);
      await firstStore.migrate();
      await database.pool.query(
        `INSERT INTO meridian_conversation_subject_quotas (owner_id)
         VALUES ($1), ($2) ON CONFLICT (owner_id) DO NOTHING`,
        [quotaOwner, quotaOtherOwner],
      );
      const firstConversation = testUuid('7a000000-0000-4000-8000-', 1);
      const secondConversation = testUuid('7a000000-0000-4000-8000-', 2);
      await resetQuotaRate(database, quotaOwner);
      const beforeCreates = await quotaSnapshot(database, quotaOwner);
      const created = await Promise.all([
        firstStore.create(quotaOwner, firstConversation),
        secondStore.create(quotaOwner, secondConversation),
      ]);
      expect(created.map(item => item.id).sort()).toEqual([firstConversation, secondConversation].sort());
      const afterCreates = await quotaSnapshot(database, quotaOwner);
      expectQuotaSnapshotConsistent(afterCreates);
      expect(afterCreates).toMatchObject({ sourceConversationCount: 2, sourceEventCount: 0, conversationCount: 2, eventCount: 0 });
      expectSuccessfulTokenDelta(beforeCreates, afterCreates, 2);

      const retryId = testUuid('7b000000-0000-4000-8000-', 1);
      await resetQuotaRate(database, quotaOwner);
      const beforeCreateRetry = await quotaSnapshot(database, quotaOwner);
      const retries = await Promise.all([firstStore.create(quotaOwner, retryId), secondStore.create(quotaOwner, retryId)]);
      expect(retries[0]).toEqual(retries[1]);
      const afterCreateRetry = await quotaSnapshot(database, quotaOwner);
      expectQuotaSnapshotConsistent(afterCreateRetry);
      expect(afterCreateRetry).toMatchObject({ sourceConversationCount: 3, sourceEventCount: 0, conversationCount: 3, eventCount: 0 });
      expectSuccessfulTokenDelta(beforeCreateRetry, afterCreateRetry, 1);
      const event = {
        id: testUuid('7c000000-0000-4000-9000-', 1), kind: 'message_omitted' as const, role: 'user' as const, expectedRevision: 0,
      };
      await resetQuotaRate(database, quotaOwner);
      const beforeEventRetry = await quotaSnapshot(database, quotaOwner);
      const eventRetries = await Promise.all([
        firstStore.append(quotaOwner, firstConversation, event),
        secondStore.append(quotaOwner, firstConversation, event),
      ]);
      expect(eventRetries[0]).toEqual(eventRetries[1]);
      const afterEventRetry = await quotaSnapshot(database, quotaOwner);
      expectQuotaSnapshotConsistent(afterEventRetry);
      expect(afterEventRetry).toMatchObject({ sourceConversationCount: 3, sourceEventCount: 1, conversationCount: 3, eventCount: 1 });
      expectSuccessfulTokenDelta(beforeEventRetry, afterEventRetry, 1);
      await resetQuotaRate(database, quotaOwner);
      const beforeCompeting = await quotaSnapshot(database, quotaOwner);
      const competing = await Promise.allSettled([
        firstStore.append(quotaOwner, secondConversation, { ...event, id: testUuid('7d000000-0000-4000-9000-', 1) }),
        secondStore.append(quotaOwner, secondConversation, { ...event, id: testUuid('7d000000-0000-4000-9000-', 2) }),
      ]);
      expect(competing.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(competing.filter(result => result.status === 'rejected')).toMatchObject([{ reason: { status: 409 } }]);
      const afterCompeting = await quotaSnapshot(database, quotaOwner);
      expectQuotaSnapshotConsistent(afterCompeting);
      expect(afterCompeting).toMatchObject({ sourceConversationCount: 3, sourceEventCount: 2, conversationCount: 3, eventCount: 2 });
      expectSuccessfulTokenDelta(beforeCompeting, afterCompeting, 1);

      const globallyConflictingId = testUuid('7e000000-0000-4000-9000-', 1);
      const otherConversation = await firstStore.create(quotaOtherOwner, testUuid('7f000000-0000-4000-8000-', 1));
      await resetQuotaRate(database, quotaOwner);
      await resetQuotaRate(database, quotaOtherOwner);
      const beforeGlobalOwner = await quotaSnapshot(database, quotaOwner);
      const beforeGlobalOtherOwner = await quotaSnapshot(database, quotaOtherOwner);
      const globalRace = await Promise.allSettled([
        firstStore.append(quotaOwner, firstConversation, { ...event, id: globallyConflictingId, expectedRevision: 1 }),
        secondStore.append(quotaOtherOwner, otherConversation.id, { ...event, id: globallyConflictingId, expectedRevision: 0 }),
      ]);
      expect(globalRace.filter(result => result.status === 'fulfilled')).toHaveLength(2);
      const afterGlobalOwner = await quotaSnapshot(database, quotaOwner);
      const afterGlobalOtherOwner = await quotaSnapshot(database, quotaOtherOwner);
      expectQuotaSnapshotConsistent(afterGlobalOwner);
      expectQuotaSnapshotConsistent(afterGlobalOtherOwner);
      expect(afterGlobalOwner.sourceEventCount + afterGlobalOtherOwner.sourceEventCount).toBe(
        beforeGlobalOwner.sourceEventCount + beforeGlobalOtherOwner.sourceEventCount + 2,
      );
      expect(afterGlobalOwner.eventCount + afterGlobalOtherOwner.eventCount).toBe(
        beforeGlobalOwner.eventCount + beforeGlobalOtherOwner.eventCount + 2,
      );
      const globalOwnerEventDelta = afterGlobalOwner.eventCount - beforeGlobalOwner.eventCount;
      const globalOtherEventDelta = afterGlobalOtherOwner.eventCount - beforeGlobalOtherOwner.eventCount;
      expect([globalOwnerEventDelta, globalOtherEventDelta].sort()).toEqual([1, 1]);
      expectSuccessfulTokenDelta(beforeGlobalOwner, afterGlobalOwner, globalOwnerEventDelta);
      expectSuccessfulTokenDelta(beforeGlobalOtherOwner, afterGlobalOtherOwner, globalOtherEventDelta);

      const mixedConversation = await firstStore.create(quotaOtherOwner, testUuid('84000000-0000-4000-8000-', 1));
      await firstStore.append(quotaOtherOwner, mixedConversation.id, {
        id: testUuid('85000000-0000-4000-9000-', 1), kind: 'message_omitted', role: 'user', expectedRevision: 0,
      });
      await resetQuotaRate(database, quotaOtherOwner);
      const beforeMixed = await quotaSnapshot(database, quotaOtherOwner);
      const mixed = await Promise.allSettled([
        firstStore.append(quotaOtherOwner, mixedConversation.id, {
          id: testUuid('85000000-0000-4000-9000-', 2), kind: 'message_omitted', role: 'user', expectedRevision: 1,
        }),
        secondStore.delete(quotaOtherOwner, mixedConversation.id, 1),
      ]);
      expect(mixed.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect([404, 409]).toContain(mixed.find(result => result.status === 'rejected')?.reason.status);
      const afterMixed = await quotaSnapshot(database, quotaOtherOwner);
      expectQuotaSnapshotConsistent(afterMixed);
      expect(afterMixed.conversationCount).toBe(beforeMixed.conversationCount);
      expect(Math.abs(afterMixed.eventCount - beforeMixed.eventCount)).toBe(1);
      expectSuccessfulTokenDelta(beforeMixed, afterMixed, 1);

      const finalOwner = await quotaSnapshot(database, quotaOwner);
      const finalOtherOwner = await quotaSnapshot(database, quotaOtherOwner);
      expectQuotaSnapshotConsistent(finalOwner);
      expectQuotaSnapshotConsistent(finalOtherOwner);
    } finally {
      await database.closePool(secondPool);
      await database.close();
    }
  });

  it('lets an unrelated subject mutate while another subject quota row is held', async () => {
    const database = await createPostgresFixture();
    try {
      const store = new ConversationStore(database.pool);
      await store.migrate();
      const holder = await database.pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('INSERT INTO meridian_conversation_subject_quotas (owner_id) VALUES ($1)', [quotaOwner]);
        await holder.query('SELECT owner_id FROM meridian_conversation_subject_quotas WHERE owner_id = $1 FOR UPDATE', [quotaOwner]);
        const independent = store.create(quotaOtherOwner, testUuid('80000000-0000-4000-8000-', 1));
        await expect(Promise.race([
          independent,
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error('unrelated subject was blocked')), 1000)),
        ])).resolves.toMatchObject({ id: '80000000-0000-4000-8000-000000000001' });
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
    } finally {
      await database.close();
    }
  });
});
