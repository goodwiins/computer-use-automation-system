import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { createPostgresFixture } from './fixtures/postgres.js';
import { Journal, journalDigest, readJournalSnapshot, type JournalRecord, type JournalSnapshot } from '../src/runtime/journal.js';
import { importJournal, readAuthorityMarker } from '../src/runtime/journal-maintenance.js';
import { PostgresJournal } from '../src/runtime/postgres-journal.js';

const key = 'journal-maintenance-test-key-0123456789abcdef0123456789abcdef';
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'journal-maintenance-'));
  dirs.push(dir);
  return dir;
}

function signed(path: string, record: unknown): void {
  writeFileSync(path, JSON.stringify({ record, signature: journalDigest(key, record) }));
}

function fixtureSnapshot(dir: string): { snapshot: JournalSnapshot; direct: JournalRecord; unknown: JournalRecord } {
  const journal = new Journal(join(dir, 'journal'), key);
  const direct = journal.reserve('caller', 'direct-key', 'read-only', '1.0.0', { member: '42' });
  journal.update(direct.runId, 'success');
  journal.bindReference('caller', 'alias-key', direct.runId);
  journal.close();
  const unknown: JournalRecord = {
    kind: 'replay', runId: randomUUID(), caller: 'caller', capability: 'write', version: '1.0.0',
    request: 'c'.repeat(64), identity: 'd'.repeat(64), createdAt: new Date().toISOString(), state: 'dispatching',
  };
  signed(join(dir, 'journal', `${unknown.runId}.json`), unknown);
  return { snapshot: readJournalSnapshot(join(dir, 'journal'), key), direct, unknown };
}

afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe.sequential('filesystem journal maintenance', () => {
  it('imports authenticated direct and alias identities, converts dispatching safely, and restarts in PostgreSQL', async () => {
    const dir = tempDir();
    const { snapshot, direct, unknown } = fixtureSnapshot(dir);
    expect(snapshot.records.map(record => record.runId)).toContain(direct.runId);
    expect(snapshot.aliases).toHaveLength(1);
    const database = await createPostgresFixture();
    try {
      await PostgresJournal.migrate(database.pool);
      await importJournal(join(dir, 'journal'), database.pool, key);
      const marker = readAuthorityMarker(join(dir, 'journal'), key);
      expect(marker.digest).toBe(journalDigest(key, snapshot));
      const journal = await PostgresJournal.open(database.pool, key, marker.importId, marker.digest);
      expect((await journal.get(direct.runId))?.identity).toBe(direct.identity);
      expect((await journal.get(unknown.runId))?.state).toBe('POST_OUTCOME_UNKNOWN');
      expect((await journal.findRequest('caller', 'alias-key'))?.runId).toBe(direct.runId);
      await journal.close();
      expect(() => new Journal(join(dir, 'journal'), key)).toThrow(/fenced/);
      await importJournal(join(dir, 'journal'), database.pool, key);
    } finally { await database.close(); }
  });

  it('rejects tampered snapshots before database rows and leaves a pending fence on database failure', async () => {
    const dir = tempDir();
    const { unknown } = fixtureSnapshot(dir);
    const path = join(dir, 'journal', `${unknown.runId}.json`);
    writeFileSync(path, JSON.stringify({ record: unknown, signature: '0'.repeat(64) }));
    const database = await createPostgresFixture();
    try {
      await PostgresJournal.migrate(database.pool);
      await expect(importJournal(join(dir, 'journal'), database.pool, key)).rejects.toThrow(/authentication/);
      expect(existsSync(join(dir, 'journal', 'postgres-authority.json'))).toBe(false);
      const failingPool = { connect: async () => { throw new Error('fixture database unavailable'); } } as unknown as Pool;
      writeFileSync(path, JSON.stringify({ record: unknown, signature: journalDigest(key, unknown) }));
      await expect(importJournal(join(dir, 'journal'), failingPool, key)).rejects.toThrow();
      const pending = JSON.parse(readFileSync(join(dir, 'journal', 'postgres-authority.json'), 'utf8')).record;
      expect(pending.phase).toBe('pending');
      expect(() => readAuthorityMarker(join(dir, 'journal'), key)).toThrow(/pending/);
      expect(() => new Journal(join(dir, 'journal'), key)).toThrow(/fenced/);
    } finally { await database.close(); }
  });

  it('rejects a live filesystem server or another importer and refuses marker digest drift', async () => {
    const dir = tempDir();
    const { snapshot } = fixtureSnapshot(dir);
    const journalDir = join(dir, 'journal');
    const database = await createPostgresFixture();
    try {
      await PostgresJournal.migrate(database.pool);
      writeFileSync(join(journalDir, 'server.lock'), 'fixture');
      await expect(importJournal(journalDir, database.pool, key)).rejects.toThrow(/running/);
      rmSync(join(journalDir, 'server.lock'));
      writeFileSync(join(journalDir, 'startup.lock'), 'fixture');
      await expect(importJournal(journalDir, database.pool, key)).rejects.toThrow(/progress/);
      rmSync(join(journalDir, 'startup.lock'));
      mkdirSync(journalDir, { recursive: true });
      signed(join(journalDir, 'postgres-authority.json'), { importId: randomUUID(), digest: 'e'.repeat(64), phase: 'complete' });
      await expect(importJournal(journalDir, database.pool, key)).rejects.toThrow(/does not match/);
      expect(journalDigest(key, snapshot)).not.toBe('e'.repeat(64));
    } finally { await database.close(); }
  });
});
