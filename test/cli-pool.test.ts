import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import type { RunJournal } from '../src/runtime/journal.js';
import { RunLogger } from '../src/evidence/logger.js';
import { Redactor } from '../src/safety/redact.js';

const runId = '11111111-1111-4111-8111-111111111111';
const key = 'cli-idle-pool-key';
const journalKey = 'cli-idle-pool-hmac-key-with-at-least-32-characters';

class FakePool extends EventEmitter {
  static latest?: FakePool;
  readonly end = vi.fn(async () => {});
  constructor(readonly options: unknown) {
    super();
    FakePool.latest = this;
  }
}

const cleanupModules = () => {
  vi.doUnmock('pg');
  vi.doUnmock('../src/runtime/open-journal.js');
  vi.doUnmock('../src/replay/executor.js');
  vi.doUnmock('../src/runtime/run.js');
  vi.doUnmock('../src/agent/loop.js');
  vi.doUnmock('../src/agent/client.js');
  vi.resetModules();
  vi.restoreAllMocks();
};

afterEach(() => cleanupModules());

it.each(['replay', 'discover'] as const)('handles an idle PostgreSQL error during %s, stops dispatch, closes once, and retains ownership', async command => {
  const root = mkdtempSync(join(tmpdir(), 'cli-idle-pool-'));
  const previousExitCode = process.exitCode;
  const env = new Map(['RUN_JOURNAL', 'DATABASE_URL', 'JOURNAL_HMAC_KEY', 'EVIDENCE_DIR', 'MERIDIAN_TELLER_OPERATOR', 'MERIDIAN_TELLER_PASSWORD', 'MERIDIAN_BRANCH']
    .map(name => [name, process.env[name]]));
  const record = {
    kind: 'replay' as const,
    runId,
    caller: 'operator',
    capability: 'meridian-sign-on',
    version: '1.0.0',
    request: 'a'.repeat(64),
    identity: 'b'.repeat(64),
    createdAt: new Date().toISOString(),
    state: 'reserved' as const,
  };
  const journal = {
    lookup: vi.fn(async () => ({ existing: undefined, identity: 'c'.repeat(64), digest: 'd'.repeat(64) })),
    reserve: vi.fn(async () => record),
    get: vi.fn(async () => record),
    update: vi.fn(async (_runId: string, state: typeof record.state) => { record.state = state; }),
    assertHealthy: vi.fn(),
    close: vi.fn(async () => {}),
  } as unknown as RunJournal;
  let runtimeOptions: { assertDispatchAllowed?: () => void } | undefined;
  let emittedError: unknown;
  let guardError: unknown;
  let nativeDispatches = 0;
  const runtimeClose = vi.fn(async () => {});
  const evidenceDir = join(root, runId);
  const logger = new RunLogger('replay', new Redactor(), evidenceDir, true, runId);

  Object.assign(process.env, {
    RUN_JOURNAL: 'postgres',
    DATABASE_URL: 'postgresql://fixture.invalid/meridian',
    JOURNAL_HMAC_KEY: journalKey,
    EVIDENCE_DIR: root,
    MERIDIAN_TELLER_OPERATOR: 'TELLER',
    MERIDIAN_TELLER_PASSWORD: 'fixture-password',
    MERIDIAN_BRANCH: 'MAIN-001',
  });
  process.exitCode = undefined;
  vi.resetModules();
  vi.doMock('pg', () => ({ Pool: FakePool }));
  vi.doMock('../src/runtime/open-journal.js', () => ({ openRunJournal: vi.fn(async () => journal) }));
  const failExecution = vi.fn(async () => {
      try { FakePool.latest!.emit('error', new Error('idle client failure')); }
      catch (error) { emittedError = error; }
      await Promise.resolve();
      try { runtimeOptions?.assertDispatchAllowed?.(); }
      catch (error) { guardError = error; }
      if (!guardError) nativeDispatches++;
      throw new Error('synthetic replay failure');
  });
  vi.doMock('../src/replay/executor.js', () => ({ runReplay: failExecution }));
  vi.doMock('../src/agent/loop.js', () => ({ runDiscovery: failExecution }));
  vi.doMock('../src/agent/client.js', () => ({ makeLLMClient: () => ({ openai: {}, model: 'offline' }) }));
  vi.doMock('../src/runtime/run.js', async () => {
    const actual = await vi.importActual<typeof import('../src/runtime/run.js')>('../src/runtime/run.js');
    return {
      ...actual,
      createRuntime: (options: Parameters<typeof actual.createRuntime>[0]) => {
        runtimeOptions = options;
        return {
          surface: { mutationDispatched: false },
          browser: { page: {} as never },
          logger,
          session: {} as never,
          redactor: new Redactor(),
          promptRedactor: new Redactor(),
          deadline: Date.now() + 600_000,
          close: runtimeClose,
        } as unknown as ReturnType<typeof actual.createRuntime>;
      },
    };
  });

  try {
    const { runCli } = await import('../cli.js');
    await runCli([command, ...(command === 'replay'
      ? ['--artifact', 'artifacts/meridian-sign-on.v1.0.0.json']
      : ['--goal', 'Sign on', '--name', 'meridian-sign-on']), '--profile', 'meridian', '--idempotency-key', key]);
    expect(emittedError).toBeUndefined();
    expect(guardError).toEqual(expect.objectContaining({ message: expect.stringMatching(/authoritative journal|pool/i) }));
    expect(nativeDispatches).toBe(0);
    // The poisoned pool makes the terminal journal write unsafe; the owner
    // remains fenced for explicit recovery while safe evidence records the
    // conservative failure/unknown status.
    expect(record.state).toBe('running');
    expect(readFileSync(join(evidenceDir, runId, 'result.json'), 'utf8')).toContain('POST_OUTCOME_UNKNOWN');
    expect(runtimeClose).toHaveBeenCalledTimes(1);
    expect(journal.close).not.toHaveBeenCalled();
    expect(FakePool.latest?.end).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
  } finally {
    for (const [name, value] of env) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    process.exitCode = previousExitCode;
    rmSync(root, { recursive: true, force: true });
  }
});
