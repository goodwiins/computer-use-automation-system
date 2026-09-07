import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { journalDigest, journalRecoveryDigest, type JournalSnapshot } from '../src/runtime/journal.js';
import { POSTGRES_LOCK_TIMEOUT_MS, PostgresJournal } from '../src/runtime/postgres-journal.js';
import { createPostgresFixture } from './fixtures/postgres.js';

const key = 'postgres-journal-test-key-0123456789abcdef0123456789abcdef';
const caller = 'caller';
const capability = 'meridian-funds-transfer';
const version = '1.0.0';

describe.sequential('PostgresJournal', () => {
  let database: Awaited<ReturnType<typeof createPostgresFixture>>;
  let journal: PostgresJournal;

  beforeEach(async () => {
    database = await createPostgresFixture();
    await PostgresJournal.migrate(database.pool);
    const snapshot: JournalSnapshot = { records: [], aliases: [] };
    const importId = randomUUID();
    await PostgresJournal.importSnapshot(database.pool, key, snapshot, importId, journalDigest(key, snapshot));
    journal = await PostgresJournal.open(database.pool, key, importId, journalDigest(key, snapshot));
  });

  afterEach(async () => { await database.close(); });

  it('serializes same-key reservations and rejects changed or competing active work', async () => {
    const request = { member: '42', amount: '1.00' };
    const pair = await Promise.all([
      journal.reserve(caller, 'same-key', capability, version, request),
      journal.reserve(caller, 'same-key', capability, version, request),
    ]);
    expect(pair[0]!.runId).toBe(pair[1]!.runId);
    expect(journalDigest(key, request)).toBe(pair[0]!.request);
    expect(await journal.list()).toHaveLength(1);
    await expect(journal.reserve(caller, 'same-key', capability, version, { ...request, amount: '2.00' }))
      .rejects.toMatchObject({ status: 409 });
    await expect(journal.reserve(caller, 'other-key', 'another-capability', version, request))
      .rejects.toMatchObject({ status: 429 });
    expect((await journal.lookup(caller, 'same-key', request)).existing?.runId).toBe(pair[0]!.runId);
    expect((await journal.get(pair[0]!.runId))?.state).toBe('reserved');
  });

  it('keeps dispatch intent terminal and blocks a fresh capability key after failure', async () => {
    const run = await journal.reserve(caller, 'dispatch-key', capability, version, {});
    await journal.update(run.runId, 'dispatching');
    await journal.update(run.runId, 'failure');
    expect((await journal.get(run.runId))?.state).toBe('POST_OUTCOME_UNKNOWN');
    await expect(journal.update(run.runId, 'success')).rejects.toThrow(/Terminal/);
    await expect(journal.reserve(caller, 'fresh-key', capability, version, {})).rejects.toMatchObject({ status: 409 });
    expect((await journal.reserve(caller, 'dispatch-key', capability, version, {})).runId).toBe(run.runId);
  });

  it('quarantines a business outcome after durable dispatch intent but preserves one before intent', async () => {
    const before = await journal.reserve(caller, 'business-before-key', capability, version, {});
    await journal.update(before.runId, 'business_outcome');
    expect((await journal.get(before.runId))?.state).toBe('business_outcome');

    const after = await journal.reserve(caller, 'business-after-key', capability, version, {});
    await journal.update(after.runId, 'dispatching');
    await journal.update(after.runId, 'business_outcome');
    expect((await journal.get(after.runId))?.state).toBe('POST_OUTCOME_UNKNOWN');
    expect(await journal.hasUnknown(capability)).toBe(true);
  });

  it('shares direct and alias identities and preserves them across a healthy restart', async () => {
    const request = { amount: '1.00' };
    const original = await journal.reserve(caller, 'direct-key', 'read-only', version, request);
    await journal.update(original.runId, 'success');
    await expect(journal.bindReference(caller, 'direct-key', original.runId)).rejects.toMatchObject({ status: 409 });
    await journal.bindReference(caller, 'status-key', original.runId);
    await expect(journal.bindReference(caller, 'status-key', original.runId)).resolves.toBeUndefined();
    expect((await journal.findRequest(caller, 'status-key'))?.runId).toBe(original.runId);
    expect(await journal.findRequest('other-caller', 'status-key')).toBeUndefined();
    await expect(journal.bindReference('other-caller', 'forged-key', original.runId)).rejects.toMatchObject({ status: 403 });
    expect((await journal.reserve(caller, 'status-key', 'read-only', version, request)).runId).toBe(original.runId);
    await expect(journal.reserve(caller, 'status-key', 'read-only', version, { amount: '2.00' })).rejects.toMatchObject({ status: 409 });

    const importId = await database.pool.query<{ import_id: string }>('SELECT import_id FROM meridian_journal_authority WHERE singleton = true');
    const digest = await database.pool.query<{ source_digest: string }>('SELECT source_digest FROM meridian_journal_authority WHERE singleton = true');
    await journal.close();
    journal = await PostgresJournal.open(database.pool, key, importId.rows[0]!.import_id, digest.rows[0]!.source_digest);
    expect((await journal.lookup(caller, 'status-key', request)).existing?.runId).toBe(original.runId);
    expect((await journal.get(original.runId))?.state).toBe('success');
    await journal.close();
  });

  it('matches recovery only for the exact owner key and domain-separated public request digest', async () => {
    const recoveryRequest = {
      capability: 'meridian-member-record', args: { member: 'PRIVATE_RECOVERY_MEMBER' }, role: 'TELLER',
    };
    const original = await journal.reserve(caller, 'recovery-key', 'meridian-member-record', version,
      { mode: 'replay', capability: 'meridian-member-record', version, args: { member: 'normalized' }, context: null },
      'replay', { invocationScope: 'public', recoveryRequest });
    await journal.update(original.runId, 'success');
    await journal.bindReference(caller, 'recovery-status-alias', original.runId);

    expect(original.recoveryRequest).toBe(journalRecoveryDigest(key, recoveryRequest));
    expect(await journal.recover(caller, 'recovery-key', recoveryRequest)).toMatchObject({
      existing: { runId: original.runId }, matches: true, direct: true,
    });
    expect(await journal.recover(caller, 'recovery-status-alias', recoveryRequest)).toMatchObject({
      existing: { runId: original.runId }, matches: true, direct: false,
    });
    expect(await journal.recover(caller, 'recovery-key', {
      ...recoveryRequest, args: { member: 'changed' },
    })).toMatchObject({ existing: { runId: original.runId }, matches: false });
    expect(await journal.recover(caller, 'recovery-key', {
      ...recoveryRequest, capability: 'meridian-member-inquiry',
    })).toMatchObject({ existing: { runId: original.runId }, matches: false });
    expect(await journal.recover(caller, 'recovery-key', {
      ...recoveryRequest, role: 'SUPERVISOR',
    })).toMatchObject({ existing: { runId: original.runId }, matches: false });
    expect(await journal.recover('other-caller', 'recovery-key', recoveryRequest)).toEqual({
      existing: undefined, matches: false, direct: false,
    });
    const persisted = await database.pool.query<{ recovery_request: string }>(
      'SELECT recovery_request FROM meridian_runs WHERE run_id = $1', [original.runId],
    );
    expect(persisted.rows).toEqual([{ recovery_request: journalRecoveryDigest(key, recoveryRequest) }]);
    expect(JSON.stringify(persisted.rows)).not.toContain('PRIVATE_RECOVERY_MEMBER');
  });

  it('persists explicit invocation scope and leaves legacy NULL scope unclassified', async () => {
    const publicRun = await journal.reserve(caller, 'public-member-key', 'meridian-member-inquiry', version,
      { searchMode: 'number', searchValue: '42' }, 'replay', { invocationScope: 'public' });
    await journal.update(publicRun.runId, 'success');
    const privateRun = await journal.reserve(caller, 'private-member-key', 'meridian-member-inquiry', version,
      { searchMode: 'number', searchValue: '43' }, 'replay', { invocationScope: 'member-identity' });
    expect((await journal.get(publicRun.runId))?.invocationScope).toBe('public');
    expect((await journal.get(privateRun.runId))?.invocationScope).toBe('member-identity');
    await journal.update(privateRun.runId, 'success');
    await database.pool.query('UPDATE meridian_runs SET invocation_scope = NULL WHERE run_id = $1', [privateRun.runId]);
    const legacy = await journal.get(privateRun.runId);
    expect(legacy).not.toHaveProperty('invocationScope');
    const rows = await database.pool.query<{ invocation_scope: string | null }>(
      'SELECT invocation_scope FROM meridian_runs WHERE run_id IN ($1, $2) ORDER BY run_id',
      [publicRun.runId, privateRun.runId],
    );
    expect(rows.rows.map(row => row.invocation_scope).sort()).toEqual([null, 'public']);
  });

  it('reads one bounded, deduplicated run batch in one authority transaction', async () => {
    const first = await journal.reserve(caller, 'pg-batch-first', capability, version, {});
    await journal.update(first.runId, 'success');
    const second = await journal.reserve(caller, 'pg-batch-second', capability, version, {});
    await journal.update(second.runId, 'failure');
    const transaction = vi.spyOn(journal as unknown as {
      transaction<T>(work: (client: unknown) => Promise<T>): Promise<T>;
    }, 'transaction');

    const records = await journal.getMany([second.runId, first.runId, second.runId, randomUUID()]);

    expect([...records]).toEqual([
      [second.runId, { ...second, state: 'failure' }],
      [first.runId, { ...first, state: 'success' }],
    ]);
    expect(transaction).toHaveBeenCalledTimes(1);
    await expect(journal.getMany(Array.from({ length: 101 }, () => first.runId))).rejects.toMatchObject({ status: 400 });
    await expect(journal.getMany(['AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'])).rejects.toMatchObject({ status: 400 });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it('adds nullable scope and recovery columns to an existing journal and keeps migration idempotent', async () => {
    await database.pool.query('ALTER TABLE meridian_runs DROP COLUMN invocation_scope CASCADE');
    await database.pool.query('ALTER TABLE meridian_runs DROP COLUMN recovery_request CASCADE');
    const before = await database.pool.query<{ count: string }>(
      `SELECT count(*) FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'meridian_runs' AND column_name IN ('invocation_scope', 'recovery_request')`,
    );
    expect(before.rows[0]?.count).toBe('0');
    await expect(PostgresJournal.migrate(database.pool)).resolves.toBeUndefined();
    await expect(PostgresJournal.migrate(database.pool)).resolves.toBeUndefined();
    const after = await database.pool.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'meridian_runs' AND column_name IN ('invocation_scope', 'recovery_request')
       ORDER BY column_name`,
    );
    expect(after.rows).toEqual([{ is_nullable: 'YES' }, { is_nullable: 'YES' }]);
  });

  it('rejects private scope outside the internal member inquiry capability', async () => {
    await expect(journal.reserve(caller, 'bad-private-scope', capability, version, {}, 'replay', {
      invocationScope: 'member-identity',
    })).rejects.toMatchObject({ status: 400 });
    await expect(database.pool.query(
      `INSERT INTO meridian_runs
        (run_id, kind, caller, capability, version, request, identity, state, invocation_scope)
       VALUES ($1, 'replay', 'caller', 'other-capability', '1.0.0', $2, $3, 'success', 'member-identity')`,
      [randomUUID(), 'a'.repeat(64), 'b'.repeat(64)],
    )).rejects.toThrow();
  });

  it('discards a PostgreSQL client after an uncertain static transaction commit', async () => {
    const pool = database.pool;
    const originalConnect = pool.connect.bind(pool);
    let releasedWithDiscard: boolean | undefined;
    (pool as Pool & { connect: typeof pool.connect }).connect = (async () => {
      const client = await originalConnect();
      const originalRelease = client.release.bind(client);
      client.release = (discard?: boolean) => { releasedWithDiscard = discard; originalRelease(discard); };
      const originalQuery = client.query.bind(client);
      client.query = (async (text: unknown, ...args: unknown[]) => {
        const result = await (originalQuery as (...queryArgs: unknown[]) => Promise<unknown>)(text, ...args);
        if (typeof text === 'string' && text.trim().toUpperCase() === 'COMMIT') throw new Error('lost acknowledgement');
        return result;
      }) as typeof client.query;
      return client;
    }) as typeof pool.connect;
    try {
      await expect(PostgresJournal.migrate(pool)).rejects.toThrow(/Journal operation failed/);
      expect(releasedWithDiscard).toBe(true);
    } finally { pool.connect = originalConnect; }
  });

  it('poisons the instance after its authority lock exceeds the bounded budget', async () => {
    const blocker = database.openPool();
    const blockerClient = await blocker.connect();
    await blockerClient.query('BEGIN');
    await blockerClient.query('SELECT singleton FROM meridian_journal_authority WHERE singleton = true FOR UPDATE');
    const started = Date.now();
    try {
      const failure = await journal.list().then(() => undefined, error => error as Error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure?.message).toBe('Journal storage outcome uncertain; restart or recover required');
      expect(failure?.message).not.toContain('canceling statement');
      expect(Date.now() - started).toBeLessThan(POSTGRES_LOCK_TIMEOUT_MS + 1_500);
      expect(() => journal.assertHealthy()).toThrow('Journal storage outcome uncertain; restart or recover required');
      const followUp = Date.now();
      await expect(journal.get(randomUUID())).rejects.toThrow('Journal storage outcome uncertain; restart or recover required');
      expect(Date.now() - followUp).toBeLessThan(500);
      await expect(journal.reserve(caller, 'after-lock-timeout', capability, version, {}))
        .rejects.toThrow('Journal storage outcome uncertain; restart or recover required');
    } finally {
      await blockerClient.query('ROLLBACK');
      blockerClient.release();
      await database.closePool(blocker);
    }
  });

  it('bounds and sanitizes a static startup lock failure', async () => {
    const marker = (await database.pool.query<{ import_id: string; source_digest: string }>(
      'SELECT import_id, source_digest FROM meridian_journal_authority WHERE singleton = true',
    )).rows[0]!;
    const blocker = database.openPool();
    const blockerClient = await blocker.connect();
    const opener = database.openPool();
    await blockerClient.query('BEGIN');
    await blockerClient.query('SELECT singleton FROM meridian_journal_authority WHERE singleton = true FOR UPDATE');
    const started = Date.now();
    try {
      const failure = await PostgresJournal.open(opener, key, marker.import_id, marker.source_digest)
        .then(() => undefined, error => error as Error);
      expect(failure).toBeInstanceOf(Error);
      expect(failure?.message).toBe('Journal operation failed');
      expect(failure?.message).not.toContain('canceling statement');
      expect(Date.now() - started).toBeLessThan(POSTGRES_LOCK_TIMEOUT_MS + 1_500);
    } finally {
      await blockerClient.query('ROLLBACK');
      blockerClient.release();
      await database.closePool(blocker);
      await database.closePool(opener);
    }
  });

  it('recovers by exact owner, fences the stale instance, and permits a new owner', async () => {
    const otherPool = database.openPool();
    const oldOwner = journal.ownerId;
    const staleRun = await journal.reserve(caller, 'stale-owner-run', capability, version, {});
    const marker = await otherPool.query<{ import_id: string; source_digest: string }>(
      'SELECT import_id, source_digest FROM meridian_journal_authority WHERE singleton = true',
    );
    await expect(PostgresJournal.open(otherPool, key, marker.rows[0]!.import_id, marker.rows[0]!.source_digest))
      .rejects.toMatchObject({ status: 409 });
    await PostgresJournal.recover(otherPool, oldOwner);
    await expect(journal.list()).rejects.toMatchObject({ status: 409 });
    await expect(journal.update(staleRun.runId, 'failure')).rejects.toMatchObject({ status: 409 });
    await expect(journal.bindReference(caller, 'stale-alias', staleRun.runId)).rejects.toMatchObject({ status: 409 });
    const replacement = await PostgresJournal.open(otherPool, key, marker.rows[0]!.import_id, marker.rows[0]!.source_digest);
    expect(replacement.ownerId).not.toBe(oldOwner);
    await expect(PostgresJournal.recover(otherPool, randomUUID())).rejects.toMatchObject({ status: 409 });
    await replacement.close();
  });

  it('refuses a healthy close with active work and recovers pre and post intent conservatively', async () => {
    const run = await journal.reserve(caller, 'active-key', capability, version, {});
    await expect(journal.close()).rejects.toMatchObject({ status: 409 });
    const recoveryPool = database.openPool();
    await PostgresJournal.recover(recoveryPool, journal.ownerId);
    expect((await database.pool.query<{ state: string; dispatch_intent: boolean }>('SELECT state, dispatch_intent FROM meridian_runs')).rows[0]).toEqual({
      state: 'interrupted', dispatch_intent: false,
    });
    const marker = await database.pool.query<{ import_id: string; source_digest: string }>('SELECT import_id, source_digest FROM meridian_journal_authority WHERE singleton = true');
    const replacement = await PostgresJournal.open(recoveryPool, key, marker.rows[0]!.import_id, marker.rows[0]!.source_digest);
    const intent = await replacement.reserve(caller, 'intent-key', capability, version, {});
    await replacement.update(intent.runId, 'dispatching');
    await PostgresJournal.recover(recoveryPool, replacement.ownerId);
    expect((await database.pool.query<{ state: string; dispatch_intent: boolean }>('SELECT state, dispatch_intent FROM meridian_runs WHERE run_id = $1', [intent.runId])).rows[0]).toEqual({
      state: 'POST_OUTCOME_UNKNOWN', dispatch_intent: true,
    });
  });

  it('rejects reads and writes after an acknowledged-unknown commit and keeps the owner held', async () => {
    const pool = database.pool;
    const originalConnect = pool.connect.bind(pool);
    let armed = true;
    (pool as Pool & { connect: typeof pool.connect }).connect = (async () => {
      const client = await originalConnect();
      const originalQuery = client.query.bind(client);
      client.query = (async (text: unknown, ...args: unknown[]) => {
        const result = await (originalQuery as (...queryArgs: unknown[]) => Promise<unknown>)(text, ...args);
        if (armed && typeof text === 'string' && text.trim().toUpperCase() === 'COMMIT') {
          armed = false;
          throw new Error('lost acknowledgement PRIVATE request payload');
        }
        return result;
      }) as typeof client.query;
      return client;
    }) as typeof pool.connect;
    try {
      await expect(journal.reserve(caller, 'uncertain-key', capability, version, { private: 'PRIVATE request payload' }))
        .rejects.toThrow(/restart|required|storage/i);
      expect(() => journal.assertHealthy()).toThrow(/restart|required|storage/i);
      await expect(journal.list()).rejects.toThrow(/restart|required|storage/i);
      await expect(journal.reserve(caller, 'after-uncertain-key', capability, version, {}))
        .rejects.toThrow(/restart|required|storage/i);
    } finally {
      pool.connect = originalConnect;
    }
    const rows = await database.pool.query<{ count: string; owner_id: string | null }>(
      `SELECT (SELECT count(*) FROM meridian_runs) AS count, owner_id::text FROM meridian_journal_authority WHERE singleton = true`,
    );
    expect(Number(rows.rows[0]!.count)).toBe(1);
    expect(rows.rows[0]!.owner_id).toBe(journal.ownerId);
  });

  it('imports historical states and preserves the authenticated marker on repeat', async () => {
    const source = { runId: randomUUID(), caller, capability, version, request: 'a'.repeat(64),
      recoveryRequest: 'd'.repeat(64), identity: 'b'.repeat(64), createdAt: new Date().toISOString(),
      state: 'dispatching' as const, kind: 'replay' as const };
    const alias = { caller, identity: 'c'.repeat(64), request: source.request, runId: source.runId };
    const snapshot: JournalSnapshot = { records: [source], aliases: [alias] };
    const importId = randomUUID(), digest = journalDigest(key, snapshot);
    await journal.close();
    await expect(PostgresJournal.importSnapshot(database.pool, key, snapshot, importId, digest, false)).rejects.toMatchObject({ status: 409 });

    const uninitialized = await createPostgresFixture();
    try {
      await PostgresJournal.migrate(uninitialized.pool);
      await expect(PostgresJournal.importSnapshot(uninitialized.pool, key, snapshot, importId, digest, false)).rejects.toMatchObject({ status: 409 });
      expect((await uninitialized.pool.query('SELECT count(*)::int AS count FROM meridian_journal_authority')).rows[0]?.count).toBe(0);
    } finally { await uninitialized.close(); }

    const malformed = await createPostgresFixture();
    try {
      await PostgresJournal.migrate(malformed.pool);
      const duplicateDirect: JournalSnapshot = {
        records: [source, { ...source, runId: randomUUID() }],
        aliases: [],
      };
      const duplicateAlias: JournalSnapshot = {
        records: [source],
        aliases: [alias, { ...alias }],
      };
      const mismatchedAlias: JournalSnapshot = {
        records: [source],
        aliases: [{ ...alias, caller: 'different-caller' }],
      };
      for (const malformedSnapshot of [duplicateDirect, duplicateAlias, mismatchedAlias]) {
        await expect(PostgresJournal.importSnapshot(
          malformed.pool,
          key,
          malformedSnapshot,
          randomUUID(),
          journalDigest(key, malformedSnapshot),
        )).rejects.toMatchObject({ status: 409 });
        const counts = await malformed.pool.query<{ runs: number; requests: number; authority: number }>(
          `SELECT
             (SELECT count(*)::int FROM meridian_runs) AS runs,
             (SELECT count(*)::int FROM meridian_run_requests) AS requests,
             (SELECT count(*)::int FROM meridian_journal_authority) AS authority`,
        );
        expect(counts.rows[0]).toEqual({ runs: 0, requests: 0, authority: 0 });
      }
    } finally { await malformed.close(); }

    const second = await createPostgresFixture();
    try {
      await PostgresJournal.migrate(second.pool);
      await PostgresJournal.importSnapshot(second.pool, key, snapshot, importId, digest);
      expect((await second.pool.query<{ state: string; dispatch_intent: boolean; recovery_request: string }>(
        'SELECT state, dispatch_intent, recovery_request FROM meridian_runs',
      )).rows[0]).toEqual({
        state: 'POST_OUTCOME_UNKNOWN', dispatch_intent: true, recovery_request: source.recoveryRequest,
      });
      expect((await second.pool.query('SELECT identity, caller, request, run_id, is_alias FROM meridian_run_requests ORDER BY is_alias')).rows).toHaveLength(2);
      await second.pool.query("UPDATE meridian_runs SET state = 'success' WHERE run_id = $1", [source.runId]);
      await PostgresJournal.importSnapshot(second.pool, key, snapshot, importId, digest, false);
      expect((await second.pool.query('SELECT count(*)::int AS count FROM meridian_runs')).rows[0]?.count).toBe(1);
      expect((await second.pool.query('SELECT state FROM meridian_runs WHERE run_id = $1', [source.runId])).rows[0]?.state).toBe('success');
    } finally { await second.close(); }
  });

  it('enforces hash and active-state constraints in PostgreSQL', async () => {
    await expect(database.pool.query(
      `INSERT INTO meridian_runs (run_id, kind, caller, capability, version, request, identity, created_at, state)
       VALUES ($1, 'replay', 'caller', 'capability', '1.0.0', 'bad', $2, clock_timestamp(), 'reserved')`,
      [randomUUID(), 'd'.repeat(64)],
    )).rejects.toThrow();
    const first = [randomUUID(), 'e'.repeat(64)];
    await database.pool.query(
      `INSERT INTO meridian_runs (run_id, kind, caller, capability, version, request, identity, state)
       VALUES ($1, 'replay', 'caller', 'capability', '1.0.0', $2, $3, 'reserved')`,
      [first[0], 'f'.repeat(64), first[1]],
    );
    await expect(database.pool.query(
      `UPDATE meridian_runs SET recovery_request = 'bad' WHERE run_id = $1`, [first[0]],
    )).rejects.toThrow();
    await expect(database.pool.query(
      `INSERT INTO meridian_runs (run_id, kind, caller, capability, version, request, identity, state)
       VALUES ($1, 'replay', 'caller', 'capability', '1.0.0', $2, $3, 'running')`,
      [randomUUID(), 'a'.repeat(64), 'b'.repeat(64)],
    )).rejects.toThrow();
  });

  it('never stores raw request values or exposes them through validation errors', async () => {
    const canary = 'PRIVATE target credential approval request must never persist';
    const validationCanary = 'PRIVATE validation canary must never appear in an error';
    const validationError = await journal.reserve(caller, 'bad\nkey', capability, version, { validationCanary })
      .then(() => undefined, (error: unknown) => error);
    expect(validationError).toMatchObject({ status: 400 });
    expect(validationError).toBeInstanceOf(Error);
    expect((validationError as Error).message).not.toContain(validationCanary);
    await journal.reserve(caller, 'raw-key', capability, version, { canary });
    const values = await database.pool.query<{ value: string }>(
      `SELECT string_agg(value, '|') AS value FROM (
         SELECT run_id::text AS value FROM meridian_runs
         UNION ALL SELECT kind FROM meridian_runs
         UNION ALL SELECT caller FROM meridian_runs
         UNION ALL SELECT capability FROM meridian_runs
         UNION ALL SELECT version FROM meridian_runs
         UNION ALL SELECT request FROM meridian_runs
         UNION ALL SELECT recovery_request FROM meridian_runs
         UNION ALL SELECT identity FROM meridian_runs
         UNION ALL SELECT state FROM meridian_runs
         UNION ALL SELECT identity FROM meridian_run_requests
         UNION ALL SELECT caller FROM meridian_run_requests
         UNION ALL SELECT request FROM meridian_run_requests
         UNION ALL SELECT run_id::text FROM meridian_run_requests
       ) values`,
    );
    expect(values.rows[0]?.value ?? '').not.toContain(canary);
  });
});
