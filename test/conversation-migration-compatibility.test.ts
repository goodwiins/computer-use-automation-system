import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { ConversationStore } from '../src/server/conversations.js';
import { createPostgresFixture } from './fixtures/postgres.js';

const priorSchemaSource = '7fb01a7f82ea8db1a18ca256a4ab411b38a176a2:src/server/conversations.sql';
const priorSchemaSha256 = 'ed127e0cf303a4fec487d4021977310ead80a4f965a784efce7c744ed4d41a79';
const owner = '91111111-1111-4111-8111-111111111111';
const otherOwner = '92222222-2222-4222-8222-222222222222';
const activeId = '91000000-0000-4000-8000-000000000001';
const archivedId = '91000000-0000-4000-8000-000000000002';
const tombstoneId = '91000000-0000-4000-8000-000000000003';
const otherActiveId = '92000000-0000-4000-8000-000000000001';
const runId = '93000000-0000-4000-8000-000000000001';
const activeEventId = '94000000-0000-4000-8000-000000000001';
const activeRunEventId = '94000000-0000-4000-8000-000000000002';
const archivedEventId = '94000000-0000-4000-8000-000000000003';
const otherEventId = '94000000-0000-4000-8000-000000000004';
const currentId = '95000000-0000-4000-8000-000000000001';
const currentEventId = '96000000-0000-4000-8000-000000000001';
const subjectIsolatedId = '95000000-0000-4000-8000-000000000002';

type SourceConversation = {
  id: string;
  owner_id: string;
  archived: boolean;
  revision: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};
type SourceEvent = {
  id: string;
  conversation_id: string;
  sequence: string;
  kind: string;
  role: string;
  run_id: string | null;
  created_at: Date;
};

async function readSourceRows(database: Awaited<ReturnType<typeof createPostgresFixture>>) {
  const conversations = await database.pool.query<SourceConversation>(`
    SELECT id, owner_id, archived, revision, created_at, updated_at, deleted_at
    FROM meridian_conversations ORDER BY id
  `);
  const events = await database.pool.query<SourceEvent>(`
    SELECT id, conversation_id, sequence, kind, role, run_id, created_at
    FROM meridian_conversation_events ORDER BY id
  `);
  return { conversations: conversations.rows, events: events.rows };
}

async function readQuota(database: Awaited<ReturnType<typeof createPostgresFixture>>, subject: string) {
  const result = await database.pool.query<{
    owner_id: string;
    conversation_count: string;
    event_count: string;
    rate_tokens: number;
    rate_refilled_at: Date;
  }>(`
    SELECT owner_id, conversation_count, event_count, rate_tokens, rate_refilled_at
    FROM meridian_conversation_subject_quotas WHERE owner_id = $1
  `, [subject]);
  const row = result.rows[0];
  if (!row) throw new Error(`missing quota row for ${subject}`);
  return row;
}

async function expectQuotaMatchesSource(database: Awaited<ReturnType<typeof createPostgresFixture>>, subject: string) {
  const source = await database.pool.query<{ conversations: string; events: string }>(`
    SELECT count(DISTINCT conversations.id)::bigint AS conversations,
           count(events.id)::bigint AS events
    FROM meridian_conversations conversations
    LEFT JOIN meridian_conversation_events events ON events.conversation_id = conversations.id
    WHERE conversations.owner_id = $1
  `, [subject]);
  const quota = await readQuota(database, subject);
  expect(quota.conversation_count).toBe(source.rows[0]!.conversations);
  expect(quota.event_count).toBe(source.rows[0]!.events);
}

describe.sequential('ConversationStore prior-schema migration compatibility', () => {
  it('upgrades the exact prior schema, preserves legacy rows, and keeps quota/rate isolation', async () => {
    const database = await createPostgresFixture();
    try {
      const priorSchema = await readFile(new URL('./fixtures/conversations-prior.sql', import.meta.url), 'utf8');
      expect(createHash('sha256').update(priorSchema).digest('hex'), `fixture provenance: ${priorSchemaSource}`).toBe(priorSchemaSha256);
      await database.pool.query(priorSchema);
      await database.pool.query(`
        INSERT INTO meridian_conversations
          (id, owner_id, archived, revision, created_at, updated_at, deleted_at)
        VALUES
          ($1, $3, false, 2, '2026-01-01T00:00:00.000Z', '2026-01-01T00:02:00.000Z', NULL),
          ($2, $3, true, 4, '2026-01-01T01:00:00.000Z', '2026-01-01T01:04:00.000Z', NULL),
          ($4, $3, false, 7, '2026-01-01T02:00:00.000Z', '2026-01-01T02:07:00.000Z', '2026-01-01T02:08:00.000Z'),
          ($5, $6, false, 1, '2026-01-02T00:00:00.000Z', '2026-01-02T00:01:00.000Z', NULL)
      `, [activeId, archivedId, owner, tombstoneId, otherActiveId, otherOwner]);
      await database.pool.query(`
        INSERT INTO meridian_conversation_events
          (id, conversation_id, sequence, kind, role, run_id, created_at)
        VALUES
          ($1, $5, 1, 'message_omitted', 'user', NULL, '2026-01-01T00:00:01.000Z'),
          ($2, $5, 2, 'run_linked', 'assistant', $6, '2026-01-01T00:00:02.000Z'),
          ($3, $7, 1, 'message_omitted', 'assistant', NULL, '2026-01-01T01:00:01.000Z'),
          ($4, $8, 1, 'message_omitted', 'user', NULL, '2026-01-02T00:00:01.000Z')
      `, [activeEventId, activeRunEventId, archivedEventId, otherEventId, activeId, runId, archivedId, otherActiveId]);
      const legacyBeforeMigration = await readSourceRows(database);

      let store = new ConversationStore(database.pool);
      await store.migrate();
      const preservedRate = await database.pool.query(`
        UPDATE meridian_conversation_subject_quotas
        SET rate_tokens = 7.5, rate_refilled_at = '2026-01-03T00:00:00.000Z'
        WHERE owner_id = $1
        RETURNING rate_tokens, rate_refilled_at
      `, [owner]);
      expect(preservedRate.rows[0]).toMatchObject({ rate_tokens: 7.5, rate_refilled_at: new Date('2026-01-03T00:00:00.000Z') });
      await store.migrate();
      expect(await readQuota(database, owner)).toMatchObject({
        owner_id: owner,
        conversation_count: '3',
        event_count: '3',
        rate_tokens: 7.5,
        rate_refilled_at: preservedRate.rows[0]!.rate_refilled_at,
      });
      expect(await readQuota(database, otherOwner)).toMatchObject({
        owner_id: otherOwner,
        conversation_count: '1',
        event_count: '1',
      });
      expect(await readSourceRows(database)).toEqual(legacyBeforeMigration);

      await database.closePool(database.pool);
      database.pool = database.openPool();
      store = new ConversationStore(database.pool);

      const active = await store.get(owner, activeId);
      expect(active).toMatchObject({ id: activeId, archived: false, revision: 2, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:02:00.000Z' });
      expect((await store.list(owner)).conversations.map(item => item.id)).toEqual([activeId]);
      expect((await store.list(owner, { archived: true })).conversations.map(item => item.id)).toEqual([archivedId]);
      expect(await store.events(owner, activeId)).toMatchObject({
        events: [
          { id: activeEventId, sequence: 1, kind: 'message_omitted', role: 'user' },
          { id: activeRunEventId, sequence: 2, kind: 'run_linked', role: 'assistant', runId },
        ],
      });
      await expect(store.get(otherOwner, activeId)).rejects.toMatchObject({ status: 404 });
      await expect(store.events(otherOwner, activeId)).rejects.toMatchObject({ status: 404 });
      expect((await store.list(otherOwner)).conversations.map(item => item.id)).toEqual([otherActiveId]);

      await database.pool.query(`
        UPDATE meridian_conversation_subject_quotas
        SET rate_tokens = 0, rate_refilled_at = clock_timestamp()
        WHERE owner_id = $1
      `, [owner]);
      const zeroRateBeforeRetry = await readQuota(database, owner);
      expect(await store.create(owner, activeId)).toEqual(active);
      await expect(store.append(owner, activeId, {
        id: activeEventId, kind: 'message_omitted', role: 'user', expectedRevision: 0,
      })).resolves.toMatchObject({ id: activeEventId, sequence: 1, role: 'user' });
      expect(await readQuota(database, owner)).toEqual(zeroRateBeforeRetry);
      await expect(store.create(owner, currentId)).rejects.toMatchObject({ status: 429, message: 'Conversation write rate limit exceeded' });
      await expect(store.append(owner, activeId, {
        id: '97000000-0000-4000-8000-000000000001', kind: 'message_omitted', role: 'user', expectedRevision: 2,
      })).rejects.toMatchObject({ status: 429, message: 'Conversation write rate limit exceeded' });

      await database.pool.query(`
        UPDATE meridian_conversation_subject_quotas
        SET rate_tokens = 20, rate_refilled_at = clock_timestamp()
        WHERE owner_id = $1
      `, [owner]);
      const created = await store.create(owner, currentId);
      expect(await store.append(owner, currentId, {
        id: currentEventId, kind: 'message_omitted', role: 'assistant', expectedRevision: 0,
      })).toMatchObject({ id: currentEventId, sequence: 1, role: 'assistant' });
      expect(await store.archive(owner, currentId, true, 1)).toMatchObject({ id: currentId, archived: true, revision: 2 });
      expect(await store.archive(owner, currentId, false, 2)).toMatchObject({ id: currentId, archived: false, revision: 3 });
      await store.delete(owner, currentId, 3);
      await expect(store.get(owner, currentId)).rejects.toMatchObject({ status: 404 });
      await expect(store.events(owner, currentId)).rejects.toMatchObject({ status: 404 });
      await expect(store.create(owner, currentId)).rejects.toMatchObject({ status: 409 });
      expect(created).toMatchObject({ id: currentId, revision: 0 });

      await expect(store.create(otherOwner, subjectIsolatedId)).resolves.toMatchObject({ id: subjectIsolatedId });
      expect((await store.list(otherOwner)).conversations.map(item => item.id)).toEqual([otherActiveId, subjectIsolatedId]);
      await expectQuotaMatchesSource(database, owner);
      await expectQuotaMatchesSource(database, otherOwner);

      const legacyAfterMutations = await readSourceRows(database);
      expect(legacyAfterMutations.conversations.filter(row => [activeId, archivedId, tombstoneId, otherActiveId].includes(row.id))).toEqual(
        legacyBeforeMigration.conversations.filter(row => [activeId, archivedId, tombstoneId, otherActiveId].includes(row.id)),
      );
      expect(legacyAfterMutations.events.filter(row => [activeEventId, activeRunEventId, archivedEventId, otherEventId].includes(row.id))).toEqual(
        legacyBeforeMigration.events.filter(row => [activeEventId, activeRunEventId, archivedEventId, otherEventId].includes(row.id)),
      );

      await store.migrate();
      const tombstone = await database.pool.query<SourceConversation>(`
        SELECT id, owner_id, archived, revision, created_at, updated_at, deleted_at
        FROM meridian_conversations WHERE id = $1
      `, [tombstoneId]);
      expect(tombstone.rows[0]).toEqual(legacyBeforeMigration.conversations.find(row => row.id === tombstoneId));
      expect(tombstone.rows[0]!.deleted_at).not.toBeNull();
      await expect(store.create(owner, tombstoneId)).rejects.toMatchObject({ status: 409 });
    } finally {
      await database.close();
    }
  });
});
