import { spawnSync } from 'node:child_process';
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

  it('R4-B1 rejects tampering before reads or quarantine decisions', async () => {
    const run = await journal.reserve(caller, 'tamper', capability, version, {});
    await journal.update(run.runId, 'dispatching');
    await journal.update(run.runId, 'failure');
    await database.pool.query("UPDATE meridian_runs SET state = 'success', capability = 'hidden' WHERE run_id = $1", [run.runId]);
    await expect(journal.get(run.runId)).rejects.toThrow('Journal authentication failed');
    await expect(journal.list()).rejects.toThrow('Journal authentication failed');
    await expect(journal.hasUnknown(capability)).rejects.toThrow('Journal authentication failed');
    await expect(journal.unknownCapabilities([capability])).rejects.toThrow('Journal authentication failed');
    await expect(journal.reserve(caller, 'tamper-fresh', capability, version, {})).rejects.toThrow('Journal authentication failed');
  });

  it.each([
    "caller = 'subject:other'", "capability = 'hidden'", "version = '2.0.0'",
    "dispatch_intent = true", "created_at = created_at + interval '1 second'",
    "invocation_scope = NULL", "recovery_request = repeat('f', 64)",
  ])('R4-B1 authenticates %s before updating or recovering', async assignment => {
    const run = await journal.reserve(caller, 'tamper-field', capability, version, {});
    await database.pool.query(`UPDATE meridian_runs SET ${assignment} WHERE run_id = $1`, [run.runId]);
    await expect(journal.get(run.runId)).rejects.toThrow('Journal authentication failed');
    await expect(journal.update(run.runId, 'running')).rejects.toThrow('Journal authentication failed');
    await expect(PostgresJournal.recover(database.pool, journal.ownerId, key)).rejects.toThrow('Journal authentication failed');
    expect((await database.pool.query('SELECT owner_id FROM meridian_journal_authority')).rows[0].owner_id).toBe(journal.ownerId);
  });

  it('R4-B1 leaves preexisting unsigned rows unsigned across repeated migration', async () => {
    const run = await journal.reserve(caller, 'unsigned', capability, version, {});
    await database.pool.query('ALTER TABLE meridian_runs DROP COLUMN signature');
    await PostgresJournal.migrate(database.pool);
    await PostgresJournal.migrate(database.pool);
    expect((await database.pool.query('SELECT signature FROM meridian_runs')).rows).toEqual([{ signature: null }]);
    await expect(journal.get(run.runId)).rejects.toThrow('Journal authentication failed');
    await expect(journal.reserve(caller, 'unsigned-fresh', capability, version, {})).rejects.toThrow('Journal authentication failed');
  });

  it('R4-B1 recovery CLI requires the correct key and preserves signed unknown outcomes', async () => {
    const run = await journal.reserve(caller, 'cli-recover', capability, version, {});
    await journal.update(run.runId, 'dispatching');
    const env = { ...process.env, DATABASE_URL: database.connectionString, JOURNAL_HMAC_KEY: 'wrong'.repeat(16) };
    const args = ['--import', 'tsx', 'cli.ts', 'journal-recover', '--owner', journal.ownerId, '--confirm-fenced'];
    const rejected = spawnSync(process.execPath, args, { env, encoding: 'utf8' });
    expect(rejected.status).not.toBe(0);
    expect(rejected.stderr).toContain('Request failed; inspect safe run evidence or server configuration');
    expect((await database.pool.query('SELECT owner_id FROM meridian_journal_authority')).rows[0].owner_id).toBe(journal.ownerId);
    const recovered = spawnSync(process.execPath, args, { env: { ...env, JOURNAL_HMAC_KEY: key }, encoding: 'utf8' });
    expect(recovered.status).toBe(0);
    const marker = (await database.pool.query('SELECT import_id, source_digest FROM meridian_journal_authority')).rows[0];
    const replacement = await PostgresJournal.open(database.pool, key, marker.import_id, marker.source_digest);
    expect(await replacement.get(run.runId)).toMatchObject({ state: 'POST_OUTCOME_UNKNOWN' });
    await expect(replacement.reserve(caller, 'cli-fresh', capability, version, {})).rejects.toMatchObject({ status: 409 });
    await replacement.close();
  });

  it('R4-B3 retries connection acquisition without poisoning', async () => {
    const connect = vi.spyOn(database.pool, 'connect').mockRejectedValueOnce(new Error('offline'));
    await expect(journal.reserve(caller, 'connect-retry', capability, version, {})).rejects.toMatchObject({ status: 503 });
    expect(() => journal.assertHealthy()).not.toThrow();
    connect.mockRestore();
    await expect(journal.reserve(caller, 'connect-retry', capability, version, {})).resolves.toMatchObject({ state: 'reserved' });
  });

  it.each(['BEGIN', 'SET LOCAL'])('R4-B3 retries a %s failure before mutation', async statement => {
    const originalConnect = database.pool.connect.bind(database.pool);
    const connect = vi.spyOn(database.pool, 'connect').mockImplementationOnce((async () => {
      const client = await originalConnect();
      const query = client.query.bind(client);
      client.query = (async (text: string, ...args: unknown[]) => {
        if (text.startsWith(statement)) throw new Error('unavailable');
        return (query as (...args: unknown[]) => Promise<unknown>)(text, ...args);
      }) as typeof client.query;
      return client;
    }) as typeof database.pool.connect);
    await expect(journal.reserve(caller, 'setup-retry', capability, version, {})).rejects.toMatchObject({ status: 503, message: 'Journal is unavailable; retry' });
    expect(() => journal.assertHealthy()).not.toThrow();
    connect.mockRestore();
    await expect(journal.reserve(caller, 'setup-retry', capability, version, {})).resolves.toMatchObject({ state: 'reserved' });
  });

  it('R4-B4 rejects running to reserved', async () => {
    const run = await journal.reserve(caller, 'backwards', capability, version, {});
    await journal.update(run.runId, 'running');
    await expect(journal.update(run.runId, 'reserved')).rejects.toMatchObject({ status: 409, message: 'Run state cannot move backwards' });
  });

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
    const legacyDatabase = await createPostgresFixture();
    try {
      const { invocationScope: _, ...legacyRecord } = privateRun;
      const snapshot: JournalSnapshot = { records: [{ ...legacyRecord, state: 'success' }], aliases: [] };
      const importId = randomUUID(), digest = journalDigest(key, snapshot);
      await PostgresJournal.migrate(legacyDatabase.pool);
      await PostgresJournal.importSnapshot(legacyDatabase.pool, key, snapshot, importId, digest);
      const legacyJournal = await PostgresJournal.open(legacyDatabase.pool, key, importId, digest);
      expect(await legacyJournal.get(privateRun.runId)).not.toHaveProperty('invocationScope');
      expect((await legacyDatabase.pool.query('SELECT invocation_scope FROM meridian_runs')).rows).toEqual([{ invocation_scope: null }]);
      await legacyJournal.close();
    } finally { await legacyDatabase.close(); }

  });

  it('batches owner-scoped direct and alias requests in one transaction', async () => {
    const first = await journal.reserve(caller, 'batch-direct', capability, version, {});
    await journal.update(first.runId, 'success');
    await journal.bindReference(caller, 'batch-alias', first.runId);
    const other = await journal.reserve('other-caller', 'batch-direct', capability, version, {});
    await journal.update(other.runId, 'success');
    const transaction = vi.spyOn(journal as unknown as {
      transaction<T>(work: (client: unknown) => Promise<T>): Promise<T>;
    }, 'transaction');
    expect([...await journal.findRequests(caller, ['batch-alias', 'batch-direct', 'missing', 'batch-alias'])])
      .toEqual([['batch-alias', { ...first, state: 'success' }], ['batch-direct', { ...first, state: 'success' }]]);
    expect(transaction).toHaveBeenCalledTimes(1);
    expect((await journal.findRequests('other-caller', ['batch-direct', 'batch-alias'])).size).toBe(1);
    expect((await journal.findRequests('unrelated', ['batch-direct', 'batch-alias'])).size).toBe(0);
    transaction.mockClear();
    await expect(journal.findRequests(caller, Array(101).fill('batch-direct'))).rejects.toMatchObject({ status: 400 });
    await expect(journal.findRequests(caller, ['invalid key'])).rejects.toMatchObject({ status: 400 });
    expect(await journal.findRequests(caller, [])).toEqual(new Map());
    expect(transaction).not.toHaveBeenCalled();
    expect(() => journal.assertHealthy()).not.toThrow();
  });

  it('reads unknown capability quarantine in one bounded transaction', async () => {
    const run = await journal.reserve(caller, 'unknown-batch', capability, version, {});
    await journal.update(run.runId, 'dispatching');
    await journal.update(run.runId, 'failure');
    const transaction = vi.spyOn(journal as unknown as {
      transaction<T>(work: (client: unknown) => Promise<T>): Promise<T>;
    }, 'transaction');
    expect(await journal.unknownCapabilities([capability, 'read-only', capability])).toEqual(new Set([capability]));
    expect(transaction).toHaveBeenCalledTimes(1);
    transaction.mockClear();
    await expect(journal.unknownCapabilities(Array(101).fill(capability))).rejects.toMatchObject({ status: 400 });
    await expect(journal.unknownCapabilities(['invalid capability'])).rejects.toMatchObject({ status: 400 });
    expect(await journal.unknownCapabilities([])).toEqual(new Set());
    expect(transaction).not.toHaveBeenCalled();
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

  it('R4-B2 reads without waiting for the authority row and retries read timeouts', async () => {
    const blocker = database.openPool();
    const client = await blocker.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT singleton FROM meridian_journal_authority WHERE singleton = true FOR UPDATE');
      await expect(journal.list()).resolves.toEqual([]);
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query('LOCK TABLE meridian_runs IN ACCESS EXCLUSIVE MODE');
      await expect(journal.list()).rejects.toMatchObject({ status: 503, message: 'Journal is busy; retry' });
      expect(() => journal.assertHealthy()).not.toThrow();
      await client.query('ROLLBACK');
      await expect(journal.reserve(caller, 'after-lock-timeout', capability, version, {})).resolves.toMatchObject({ state: 'reserved' });
    } finally {
      await client.query('ROLLBACK');
      client.release();
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
    await PostgresJournal.recover(otherPool, oldOwner, key);
    await expect(journal.list()).rejects.toMatchObject({ status: 409 });
    await expect(journal.update(staleRun.runId, 'failure')).rejects.toMatchObject({ status: 409 });
    await expect(journal.bindReference(caller, 'stale-alias', staleRun.runId)).rejects.toMatchObject({ status: 409 });
    const replacement = await PostgresJournal.open(otherPool, key, marker.rows[0]!.import_id, marker.rows[0]!.source_digest);
    expect(replacement.ownerId).not.toBe(oldOwner);
    await expect(PostgresJournal.recover(otherPool, randomUUID(), key)).rejects.toMatchObject({ status: 409 });
    await replacement.close();
  });

  it('refuses a healthy close with active work and recovers pre and post intent conservatively', async () => {
    const run = await journal.reserve(caller, 'active-key', capability, version, {});
    await expect(journal.close()).rejects.toMatchObject({ status: 409 });
    const recoveryPool = database.openPool();
    await PostgresJournal.recover(recoveryPool, journal.ownerId, key);
    expect((await database.pool.query<{ state: string; dispatch_intent: boolean }>('SELECT state, dispatch_intent FROM meridian_runs')).rows[0]).toEqual({
      state: 'interrupted', dispatch_intent: false,
    });
    const marker = await database.pool.query<{ import_id: string; source_digest: string }>('SELECT import_id, source_digest FROM meridian_journal_authority WHERE singleton = true');
    const replacement = await PostgresJournal.open(recoveryPool, key, marker.rows[0]!.import_id, marker.rows[0]!.source_digest);
    const intent = await replacement.reserve(caller, 'intent-key', capability, version, {});
    await replacement.update(intent.runId, 'dispatching');
    await PostgresJournal.recover(recoveryPool, replacement.ownerId, key);
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
      const imported = await PostgresJournal.open(second.pool, key, importId, digest);
      expect(await imported.get(source.runId)).toMatchObject({ state: 'POST_OUTCOME_UNKNOWN' });
      await imported.close();
      await second.pool.query("UPDATE meridian_runs SET state = 'success' WHERE run_id = $1", [source.runId]);
      await expect(PostgresJournal.importSnapshot(second.pool, key, snapshot, importId, digest, false)).rejects.toThrow('Journal authentication failed');
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
      `INSERT INTO meridian_runs (run_id, kind, caller, capability, version, request, identity, state, signature)
       VALUES ($1, 'replay', 'caller', 'capability', '1.0.0', $2, $3, 'reserved', 'constraint-test')`,
      [first[0], 'f'.repeat(64), first[1]],
    );
    await expect(database.pool.query(
      `UPDATE meridian_runs SET recovery_request = 'bad' WHERE run_id = $1`, [first[0]],
    )).rejects.toThrow();
    await expect(database.pool.query(
      `INSERT INTO meridian_runs (run_id, kind, caller, capability, version, request, identity, state, signature)
       VALUES ($1, 'replay', 'caller', 'capability', '1.0.0', $2, $3, 'running', 'constraint-test')`,
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
