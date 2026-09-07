import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPostgresFixture } from './fixtures/postgres.js';
import { Journal, journalDigest, readJournalSnapshot, type JournalRecord, type JournalSnapshot } from '../src/runtime/journal.js';
import { importJournal, readAuthorityMarker } from '../src/runtime/journal-maintenance.js';
import { openRunJournal } from '../src/runtime/open-journal.js';
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
      expect(snapshot.records.find(record => record.runId === direct.runId)?.request).toBe(direct.request);
      expect(snapshot.records.find(record => record.runId === direct.runId)?.identity).toBe(direct.identity);
      expect(snapshot.aliases[0]).toMatchObject({ caller: direct.caller, request: direct.request, runId: direct.runId });
      const directSnapshot = snapshot.records.find(record => record.runId === direct.runId)!;
      expect(JSON.parse(readFileSync(join(dir, 'journal', `${direct.runId}.json`), 'utf8')).signature)
        .toBe(journalDigest(key, directSnapshot));
      const alias = snapshot.aliases[0]!;
      expect(JSON.parse(readFileSync(join(dir, 'journal', 'aliases', `${alias.identity}.json`), 'utf8')).signature)
        .toBe(journalDigest(key, alias));
      const journal = await PostgresJournal.open(database.pool, key, marker.importId, marker.digest);
      expect((await journal.get(direct.runId))?.identity).toBe(direct.identity);
      expect((await journal.get(unknown.runId))?.state).toBe('POST_OUTCOME_UNKNOWN');
      expect((await journal.findRequest('caller', 'alias-key'))?.runId).toBe(direct.runId);
      const imported = await database.pool.query<{ identity: string; request: string; run_id: string; is_alias: boolean }>(
        'SELECT identity, request, run_id::text, is_alias FROM meridian_run_requests WHERE run_id = $1 ORDER BY is_alias, identity',
        [direct.runId],
      );
      expect(imported.rows).toEqual([
        { identity: directSnapshot.identity, request: directSnapshot.request, run_id: direct.runId, is_alias: false },
        { identity: snapshot.aliases[0]!.identity, request: snapshot.aliases[0]!.request, run_id: direct.runId, is_alias: true },
      ].sort((a, b) => Number(a.is_alias) - Number(b.is_alias) || a.identity.localeCompare(b.identity)));
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

  it('rejects malformed records, filename and alias owner mismatches, and duplicate identities before import', () => {
    const dir = tempDir();
    const { snapshot, direct } = fixtureSnapshot(dir);
    const journalDir = join(dir, 'journal');
    const wrongName = randomUUID();
    signed(join(journalDir, `${wrongName}.json`), { ...direct, runId: randomUUID() });
    expect(() => readJournalSnapshot(journalDir, key)).toThrow(/filename mismatch|duplicate/);
    unlinkSync(join(journalDir, `${wrongName}.json`));
    const duplicateRun = randomUUID();
    signed(join(journalDir, `${duplicateRun}.json`), { ...direct, runId: duplicateRun, identity: direct.identity });
    expect(() => readJournalSnapshot(journalDir, key)).toThrow(/duplicate/);
    unlinkSync(join(journalDir, `${duplicateRun}.json`));
    for (const file of readdirSync(join(journalDir, 'aliases'))) unlinkSync(join(journalDir, 'aliases', file));
    const alias = snapshot.aliases[0]!;
    signed(join(journalDir, 'aliases', `${alias.identity}.json`), { ...alias, caller: 'other-caller' });
    expect(() => readJournalSnapshot(journalDir, key)).toThrow(/alias/);
    writeFileSync(join(journalDir, 'invalid.json'), 'not json');
    expect(() => readJournalSnapshot(journalDir, key)).toThrow();
  });

  it('serializes concurrent imports, recovers a lost acknowledgment by repeat, and refuses complete marker initialization on an empty target', async () => {
    const dir = tempDir();
    fixtureSnapshot(dir);
    const database = await createPostgresFixture();
    const secondPool = database.openPool();
    try {
      const results = await Promise.allSettled([
        importJournal(join(dir, 'journal'), database.pool, key),
        importJournal(join(dir, 'journal'), secondPool, key),
      ]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(result => result.status === 'rejected').map(result => (result as PromiseRejectedResult).reason.message))
        .toContain('Journal import is already in progress');
    } finally { await database.close(); }

    const lostDir = tempDir();
    fixtureSnapshot(lostDir);
    const lost = await createPostgresFixture();
    const originalConnect = lost.pool.connect.bind(lost.pool);
    let commits = 0;
    (lost.pool as Pool & { connect: typeof lost.pool.connect }).connect = (async () => {
      const client = await originalConnect();
      const query = client.query.bind(client);
      client.query = (async (text: unknown, ...args: unknown[]) => {
        const result = await (query as (...queryArgs: unknown[]) => Promise<unknown>)(text, ...args);
        if (typeof text === 'string' && text.trim().toUpperCase() === 'COMMIT' && ++commits === 2) throw new Error('lost acknowledgement');
        return result;
      }) as typeof client.query;
      return client;
    }) as typeof lost.pool.connect;
    try {
      await expect(importJournal(join(lostDir, 'journal'), lost.pool, key)).rejects.toThrow();
      expect(() => readAuthorityMarker(join(lostDir, 'journal'), key)).toThrow(/pending/);
      lost.pool.connect = originalConnect;
      await importJournal(join(lostDir, 'journal'), lost.pool, key);
      expect(readAuthorityMarker(join(lostDir, 'journal'), key).importId).toBeTruthy();
      const empty = await createPostgresFixture();
      try {
        await expect(importJournal(join(lostDir, 'journal'), empty.pool, key)).rejects.toThrow(/not initialized|already initialized/);
      } finally { await empty.close(); }
    } finally { lost.pool.connect = originalConnect; await lost.close(); }
  });

  it('dispatches maintenance CLI without entering runtime code and validates recovery flags', () => {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: process.env.PATH, EVIDENCE_DIR: tempDir() };
    delete env.DATABASE_URL;
    const imported = spawnSync(process.execPath, ['--import', 'tsx', 'cli.ts', 'journal-import'], { cwd: process.cwd(), env, encoding: 'utf8' });
    expect(imported.status).not.toBe(0);
    expect(`${imported.stdout}${imported.stderr}`).toContain('DATABASE_URL is required');
    const invalid = spawnSync(process.execPath, ['--import', 'tsx', 'cli.ts', 'journal-recover', '--owner', 'bad', '--confirm-fenced'], { cwd: process.cwd(), env, encoding: 'utf8' });
    expect(invalid.status).not.toBe(0);
    expect(`${invalid.stdout}${invalid.stderr}`).toContain('--owner must be a UUID');
    const missingConfirmation = spawnSync(process.execPath, ['--import', 'tsx', 'cli.ts', 'journal-recover', '--owner', '11111111-1111-4111-8111-111111111111'], { cwd: process.cwd(), env, encoding: 'utf8' });
    expect(missingConfirmation.status).not.toBe(0);
    expect(`${missingConfirmation.stdout}${missingConfirmation.stderr}`).toContain('--confirm-fenced');
  });

  it('runs a valid journal-import CLI path without entering runtime, model, browser, or server code', async () => {
    const poolEnd = vi.fn().mockResolvedValue(undefined);
    class FakePool { end = poolEnd; }
    const importJournalCall = vi.fn().mockResolvedValue(undefined);
    const makeLLMClient = vi.fn(() => { throw new Error('model tripwire'); });
    const createRuntime = vi.fn(() => { throw new Error('runtime tripwire'); });
    const serve = vi.fn(() => { throw new Error('server tripwire'); });
    vi.resetModules();
    vi.doMock('pg', () => ({ Pool: FakePool }));
    vi.doMock('../src/runtime/journal-maintenance.js', () => ({ importJournal: importJournalCall }));
    vi.doMock('../src/agent/client.js', () => ({ makeLLMClient }));
    vi.doMock('../src/runtime/run.js', () => ({ createRuntime }));
    vi.doMock('../src/server/http.js', () => ({ serve }));
    vi.stubEnv('DATABASE_URL', 'postgresql://fixture.invalid/unused');
    vi.stubEnv('JOURNAL_HMAC_KEY', key);
    try {
      const { runCli } = await import('../cli.js');
      await runCli(['journal-import']);
      expect(importJournalCall).toHaveBeenCalledOnce();
      expect(importJournalCall.mock.calls[0]![1]).toBeInstanceOf(FakePool);
      expect(poolEnd).toHaveBeenCalledOnce();
      expect(makeLLMClient).not.toHaveBeenCalled();
      expect(createRuntime).not.toHaveBeenCalled();
      expect(serve).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('pg');
      vi.doUnmock('../src/runtime/journal-maintenance.js');
      vi.doUnmock('../src/agent/client.js');
      vi.doUnmock('../src/runtime/run.js');
      vi.doUnmock('../src/server/http.js');
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });

  it('does not remove a replacement startup lock it does not own', async () => {
    const dir = tempDir();
    fixtureSnapshot(dir);
    const journalDir = join(dir, 'journal');
    const migrate = vi.spyOn(PostgresJournal, 'migrate').mockImplementation(async () => {
      unlinkSync(join(journalDir, 'startup.lock'));
      writeFileSync(join(journalDir, 'startup.lock'), 'replacement-owner');
    });
    const imported = vi.spyOn(PostgresJournal, 'importSnapshot').mockResolvedValue(undefined);
    try {
      await importJournal(journalDir, {} as Pool, key);
      expect(readFileSync(join(journalDir, 'startup.lock'), 'utf8')).toBe('replacement-owner');
      expect(migrate).toHaveBeenCalledOnce();
      expect(imported).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
      unlinkSync(join(journalDir, 'startup.lock'));
    }
  });

  it('runtime opener rejects a target whose PostgreSQL marker identity does not match', async () => {
    const dir = tempDir();
    const { snapshot } = fixtureSnapshot(dir);
    const journalDir = join(dir, 'journal');
    const database = await createPostgresFixture();
    try {
      await PostgresJournal.migrate(database.pool);
      await importJournal(journalDir, database.pool, key);
      const marker = readAuthorityMarker(journalDir, key);
      signed(join(journalDir, 'postgres-authority.json'), { ...marker, importId: randomUUID(), phase: 'complete' });
      vi.stubEnv('RUN_JOURNAL', 'postgres');
      await expect(openRunJournal(journalDir, key, database.pool)).rejects.toThrow(/does not match/);
      expect(journalDigest(key, snapshot)).toBe(marker.digest);
    } finally { await database.close(); }
  });
});
