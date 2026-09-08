import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { journalDigest, type JournalSnapshot } from '../src/runtime/journal.js';
import { PostgresJournal } from '../src/runtime/postgres-journal.js';
import { createPostgresFixture } from './fixtures/postgres.js';

const key = 'postgres-projection-lock-test-key-0123456789';
const caller = 'caller';
const capability = 'meridian-funds-transfer';
const version = '1.0.0';

type Database = Awaited<ReturnType<typeof createPostgresFixture>>;
type Projection = {
  name: string;
  execute: (journal: PostgresJournal) => Promise<unknown>;
};

const projections: Projection[] = [
  { name: 'get', execute: journal => journal.get(randomUUID()) },
  { name: 'getMany', execute: journal => journal.getMany([randomUUID()]) },
  { name: 'list', execute: journal => journal.list() },
  { name: 'recent', execute: journal => journal.recent(caller) },
  { name: 'unknownCapabilities', execute: journal => journal.unknownCapabilities([capability]) },
  { name: 'findRequests', execute: journal => journal.findRequests(caller, ['find-request-key-01234567890123456789']) },
];

async function expectCompletes<T>(promise: Promise<T>, timeoutMs = 1_500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Projection did not complete within ${timeoutMs}ms`)), timeoutMs);
  });
  try { return await Promise.race([promise, timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

/** Pause a projection after its authority read until released. */
function gateFirstAuthorityLock(pool: Pool) {
  let armed = true;
  let heldResolve!: () => void;
  let releaseResolve!: () => void;
  const held = new Promise<void>(resolve => { heldResolve = resolve; });
  const released = new Promise<void>(resolve => { releaseResolve = resolve; });
  const originalConnect = pool.connect.bind(pool);

  (pool as Pool & { connect: typeof pool.connect }).connect = (async () => {
    const client = await originalConnect();
    const originalQuery = client.query.bind(client);
    let intercepted = false;
    client.query = (async (text: unknown, ...args: unknown[]) => {
      const result = await (originalQuery as (...queryArgs: unknown[]) => Promise<unknown>)(text, ...args);
      if (armed && !intercepted && typeof text === 'string'
        && /FROM meridian_journal_authority/i.test(text)) {
        intercepted = true;
        armed = false;
        heldResolve();
        await released;
      }
      return result;
    }) as typeof client.query;
    return client;
  }) as typeof pool.connect;

  return {
    held,
    release: () => {
      releaseResolve();
      pool.connect = originalConnect;
    },
  };
}

describe.sequential('PostgresJournal projection locks', () => {
  let database: Database;
  let journal: PostgresJournal;

  beforeEach(async () => {
    database = await createPostgresFixture();
    await PostgresJournal.migrate(database.pool);
    const snapshot: JournalSnapshot = { records: [], aliases: [] };
    const importId = randomUUID();
    const digest = journalDigest(key, snapshot);
    await PostgresJournal.importSnapshot(database.pool, key, snapshot, importId, digest);
    journal = await PostgresJournal.open(database.pool, key, importId, digest);
  });

  afterEach(async () => {
    await Promise.resolve(journal?.close()).catch(() => {});
    await database.close();
  });

  it.each(projections)('allows concurrent $name projections while the first read holds authority', async ({ execute }) => {
    const gate = gateFirstAuthorityLock(database.pool);
    const firstRead = execute(journal);
    await gate.held;
    const secondRead = execute(journal);

    try {
      await expectCompletes(secondRead);
    } finally {
      gate.release();
      await firstRead.catch(() => {});
      await secondRead.catch(() => {});
    }
  }, 15_000);

  it('allows mutations while a projection is paused after checking authority', async () => {
    const gate = gateFirstAuthorityLock(database.pool);
    const firstRead = journal.list();
    await gate.held;
    let writer: Promise<Awaited<ReturnType<PostgresJournal['reserve']>>> | undefined;

    try {
      writer = journal.reserve(caller, 'blocked-writer', capability, version, {});
      await expectCompletes(writer);
      gate.release();
      await firstRead.catch(() => {});
      await expect(writer).resolves.toMatchObject({ state: 'reserved' });
    } finally {
      gate.release();
      await firstRead.catch(() => {});
      await writer?.catch(() => {});
    }
  }, 10_000);

  it('allows ownership changes during a projection and fences subsequent old-owner work', async () => {
    const gate = gateFirstAuthorityLock(database.pool);
    const firstRead = journal.list();
    await gate.held;
    const recoveryPool = database.openPool();
    let recovery: Promise<void> | undefined;

    try {
      recovery = PostgresJournal.recover(recoveryPool, journal.ownerId, key);
      await expectCompletes(recovery);
      gate.release();
      await firstRead.catch(() => {});
      await expect(recovery).resolves.toBeUndefined();
      await expect(journal.list()).rejects.toMatchObject({ status: 409 });
    } finally {
      gate.release();
      await firstRead.catch(() => {});
      await recovery?.catch(() => {});
      await database.closePool(recoveryPool);
    }
  }, 10_000);

  it('fails closed for projections after authority ownership is lost', async () => {
    const recoveryPool = database.openPool();
    try {
      await PostgresJournal.recover(recoveryPool, journal.ownerId, key);
      await expect(journal.getMany([randomUUID()])).rejects.toMatchObject({ status: 409 });
      await expect(journal.list()).rejects.toMatchObject({ status: 409 });
    } finally {
      await database.closePool(recoveryPool);
    }
  });
});
