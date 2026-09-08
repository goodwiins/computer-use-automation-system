import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { openExecutionJournal, type ExecutionJournalHandle } from '../cli.js';
import { importJournal } from '../src/runtime/journal-maintenance.js';
import { createPostgresFixture } from './fixtures/postgres.js';

it('handles termination of its own idle PostgreSQL connection and retains dispatch authority after closing runtime', async () => {
  const database = await createPostgresFixture();
  const dir = mkdtempSync(join(tmpdir(), 'cli-real-pool-'));
  const key = 'cli-real-pool-test-key-with-32-characters';
  const priorExitCode = process.exitCode;
  let opened: ExecutionJournalHandle | undefined;
  try {
    await importJournal(join(dir, 'journal'), database.pool, key);
    vi.stubEnv('RUN_JOURNAL', 'postgres');
    vi.stubEnv('DATABASE_URL', database.connectionString);
    vi.stubEnv('JOURNAL_HMAC_KEY', key);
    vi.stubEnv('EVIDENCE_DIR', dir);
    opened = await openExecutionJournal(true);
    const run = await opened.journal!.reserve('operator', 'isolated-idle-failure', 'meridian-sign-on', '1.0.0', {});
    await opened.journal!.update(run.runId, 'dispatching');
    const close = vi.fn(async () => {});
    const runtime = { close, cleanupFailed: false, logger: { log: vi.fn() } } as unknown as Parameters<typeof opened.attachRuntime>[0];
    opened.attachRuntime(runtime);
    const ownerBefore = (await database.pool.query('SELECT owner_id FROM meridian_journal_authority')).rows[0].owner_id;
    const connection = await opened.pool!.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    expect(opened.pool!.idleCount).toBeGreaterThan(0);
    const application = new URL(database.connectionString).searchParams.get('application_name');
    const terminated = await database.pool.query<{ stopped: boolean }>(
      'SELECT pg_terminate_backend(pid) AS stopped FROM pg_stat_activity WHERE pid = $1 AND application_name = $2 AND pid <> pg_backend_pid()',
      [connection.rows[0]!.pid, application]);
    expect(terminated.rows).toEqual([{ stopped: true }]);
    await vi.waitFor(() => expect(opened!.isPoisoned()).toBe(true));
    await opened.closeRuntime();
    await opened.closeRuntime();
    expect(close).toHaveBeenCalledOnce();
    expect(() => opened!.assertHealthy()).toThrow(/pool failure/);
    expect(opened.shouldRetainOwnership(runtime)).toBe(true);
    expect(process.exitCode).toBe(1);
    expect((await database.pool.query('SELECT owner_id FROM meridian_journal_authority')).rows[0].owner_id).toBe(ownerBefore);
    expect((await database.pool.query('SELECT state, dispatch_intent FROM meridian_runs WHERE run_id = $1', [run.runId])).rows)
      .toEqual([{ state: 'dispatching', dispatch_intent: true }]);
  } finally {
    await opened?.closeRuntime();
    await opened?.pool?.end();
    vi.unstubAllEnvs();
    process.exitCode = priorExitCode;
    await database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
