import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { RunLogger } from '../src/evidence/logger.js';
import { validateIdempotencyKey } from '../src/runtime/journal.js';
import { Redactor } from '../src/safety/redact.js';

const ARTIFACT = 'artifacts/meridian-sign-on.v1.0.0.json';
const JOURNAL_KEY = 'hmac-test-key-with-at-least-32-characters';
const PRIVATE_FAILURE = 'PRIVATE_UNREGISTERED';
type BoundaryMode = 'pre' | 'post' | 'returned' | 'construct' | 'write-failure' | 'close' | 'aborted';

const boundary: {
  mode: BoundaryMode;
  beforeDispatch?: () => void;
  dispatchCount: number;
  closeCalls: number;
} = { mode: 'pre', dispatchCount: 0, closeCalls: 0 };

interface BoundaryRun {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
  states: string[];
  result?: string;
  lockPresent: boolean;
  dispatchCount: number;
  closeCalls: number;
}

async function runReplayBoundary(mode: BoundaryMode, dir: string, key = 'boundary-key-1', operator = 'teller-test', extraArgs: string[] = [], command: 'replay' | 'discover' = 'replay'): Promise<BoundaryRun> {
  const previousExitCode = process.exitCode;
  const envKeys = ['OPENAI_API_KEY', 'EVIDENCE_DIR', 'JOURNAL_HMAC_KEY', 'MERIDIAN_TELLER_OPERATOR', 'MERIDIAN_TELLER_PASSWORD', 'MERIDIAN_BRANCH'];
  const previousEnv = new Map(envKeys.map(name => [name, process.env[name]]));
  process.exitCode = undefined;
  Object.assign(process.env, {
    OPENAI_API_KEY: 'offline-test-only',
    EVIDENCE_DIR: dir,
    JOURNAL_HMAC_KEY: JOURNAL_KEY,
    MERIDIAN_TELLER_OPERATOR: operator,
    MERIDIAN_TELLER_PASSWORD: 'offline-test-only',
    MERIDIAN_BRANCH: 'MAIN-001',
  });
  boundary.mode = mode;
  boundary.beforeDispatch = undefined;
  boundary.dispatchCount = 0;
  boundary.closeCalls = 0;

  vi.resetModules();
  vi.doMock('../src/runtime/run.js', async () => {
    const actual = await vi.importActual<typeof import('../src/runtime/run.js')>('../src/runtime/run.js');
    return {
      ...actual,
      createRuntime: (options: Parameters<typeof actual.createRuntime>[0]) => {
        if (boundary.mode === 'construct') throw new Error(PRIVATE_FAILURE);
        boundary.beforeDispatch = options.beforeDispatch ? () => options.beforeDispatch!(undefined as never) : undefined;
        const redactor = new Redactor();
        const logger = new RunLogger(options.kind, redactor, options.evidenceDir, true, options.runId);
        if (boundary.mode === 'write-failure') logger.writeResult = () => { throw new Error(PRIVATE_FAILURE); };
        return {
          surface: { mutationDispatched: false },
          browser: { page: {} as never },
          logger,
          session: {} as never,
          redactor,
          promptRedactor: redactor,
          deadline: Date.now() + 600_000,
          close: async () => { boundary.closeCalls++; if (boundary.mode === 'close') throw new Error(PRIVATE_FAILURE); },
        };
      },
    };
  });
  vi.doMock('../src/replay/executor.js', async () => {
    const actual = await vi.importActual<typeof import('../src/replay/executor.js')>('../src/replay/executor.js');
    return {
      ...actual,
      runReplay: async (_artifact: unknown, _params: Record<string, string | number>, deps: { surface: { mutationDispatched: boolean }; logger: RunLogger }) => {
        if (boundary.mode === 'post') {
          boundary.dispatchCount++;
          boundary.beforeDispatch?.();
          deps.surface.mutationDispatched = true;
          throw new Error(PRIVATE_FAILURE);
        }
        if (boundary.mode !== 'returned') throw new Error(PRIVATE_FAILURE);
        return {
          status: 'failure' as const,
          failure: { code: 'RUN_FAILED', stepId: 'private', intent: 'private', expected: 'private', observed: PRIVATE_FAILURE },
          escalated: false,
          runId: deps.logger.runId,
          evidenceDir: deps.logger.dir,
          recoveries: [],
        };
      },
    };
  });
  vi.doMock('../src/agent/loop.js', async () => {
    const actual = await vi.importActual<typeof import('../src/agent/loop.js')>('../src/agent/loop.js');
    return {
      ...actual,
      runDiscovery: async () => ({ status: 'stopped' as const, trace: [], outputs: {}, finalUrl: 'https://web-sample.interface-hiring.com/signon', stopReason: 'RUN_ABORTED' }),
    };
  });

  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  let failed = false;
  let failure: unknown;
  try {
    const { runCli } = await import('../cli.js');
    await runCli(command === 'replay'
      ? ['replay', '--artifact', ARTIFACT, '--profile', 'meridian', '--idempotency-key', key, ...extraArgs]
      : ['discover', '--name', 'meridian-sign-on', '--goal', 'Sign on', '--profile', 'meridian', '--idempotency-key', key]);
  } catch (caught) {
    failed = true;
    failure = caught;
  }
  const stdout = log.mock.calls.map(call => call.join(' ')).join('\n');
  const stderr = error.mock.calls.map(call => call.join(' ')).join('\n');
  const journalDir = join(dir, 'journal');
  const files = existsSync(journalDir) ? readdirSync(journalDir).filter(name => name.endsWith('.json')) : [];
  const records = files.map(name => JSON.parse(readFileSync(join(journalDir, name), 'utf8')).record as { runId: string; state: string });
  const resultPath = records.map(record => join(dir, record.runId, 'result.json')).find(existsSync);
  const result = resultPath ? readFileSync(resultPath, 'utf8') : undefined;
  const outcome = {
    stdout,
    stderr,
    exitCode: process.exitCode,
    states: records.map(record => record.state),
    ...(result === undefined ? {} : { result }),
    lockPresent: existsSync(join(journalDir, 'server.lock')),
    dispatchCount: boundary.dispatchCount,
    closeCalls: boundary.closeCalls,
  };
  vi.doUnmock('../src/runtime/run.js');
  vi.doUnmock('../src/replay/executor.js');
  vi.doUnmock('../src/agent/loop.js');
  vi.restoreAllMocks();
  vi.resetModules();
  for (const name of envKeys) {
    const value = previousEnv.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  process.exitCode = previousExitCode;
  if (failed) throw failure;
  return outcome;
}

it('rejects invalid request keys before acquiring a journal', () => {
  for (const key of ['', 'space key', '\n', 'x'.repeat(201)]) {
    expect(() => validateIdempotencyKey(key)).toThrow();
  }
  expect(() => validateIdempotencyKey('meridian-new-operation-1')).not.toThrow();
});

it('persists the fixed discovery cancellation code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meridian-cli-boundary-'));
  try {
    const run = await runReplayBoundary('aborted', dir, 'boundary-key-aborted', 'teller-test', [], 'discover');
    expect(run.exitCode).not.toBe(0);
    expect(run.states).toEqual(['failure']);
    expect(run.result).toContain('"code": "RUN_ABORTED"');
    expect(run.result).not.toContain('stopReason');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each([
  ['discover', '--name', 'meridian-sign-on', '--goal', 'Sign on'],
  ['replay', '--artifact', 'artifacts/meridian-sign-on.v1.0.0.json'],
])('rejects an invalid key without retaining resources: %s', (...args) => {
  const dir = mkdtempSync(join(tmpdir(), 'meridian-cli-'));
  try {
    const result = spawnSync(process.execPath,
      ['--import', 'tsx', 'cli.ts', ...args, '--profile', 'meridian',
        '--idempotency-key', 'invalid key'], {
        encoding: 'utf8', timeout: 5000,
        env: {
          PATH: process.env.PATH, HOME: process.env.HOME,
          OPENAI_API_KEY: 'offline-test-only', EVIDENCE_DIR: dir,
          JOURNAL_HMAC_KEY: 'offline-test-key-at-least-32-characters',
          MERIDIAN_TELLER_OPERATOR: 'teller-test',
          MERIDIAN_TELLER_PASSWORD: 'offline-test-only',
          MERIDIAN_BRANCH: 'MAIN-001',
        },
      });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('Idempotency-Key');
    expect(existsSync(join(dir, 'journal', 'server.lock'))).toBe(false);
    expect(readdirSync(dir).filter(name => name !== 'journal')).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it.each([
  ['pre', 'failure', 'RUN_FAILED', 0],
  ['post', 'POST_OUTCOME_UNKNOWN', 'POST_OUTCOME_UNKNOWN', 1],
] as const)('drives thrown %s replay failures through the CLI boundary', async (mode, state, code, dispatchCount) => {
  const dir = mkdtempSync(join(tmpdir(), 'meridian-cli-boundary-'));
  try {
    const run = await runReplayBoundary(mode, dir);
    expect(run.exitCode).not.toBe(0);
    expect(run.states).toEqual([state]);
    expect(run.lockPresent).toBe(false);
    expect(run.dispatchCount).toBe(dispatchCount);
    expect(run.closeCalls).toBe(1);
    expect(`${run.stdout}\n${run.stderr}`).not.toContain(PRIVATE_FAILURE);
    expect(run.result).toContain(`"code": "${code}"`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('projects returned MERIDIAN failures before printing or writing evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meridian-cli-boundary-'));
  try {
    const run = await runReplayBoundary('returned', dir);
    expect(run.exitCode).not.toBe(0);
    expect(run.states).toEqual(['failure']);
    expect(run.lockPresent).toBe(false);
    expect(run.dispatchCount).toBe(0);
    expect(run.closeCalls).toBe(1);
    expect(`${run.stdout}\n${run.stderr}`).not.toContain(PRIVATE_FAILURE);
    expect(run.result).toContain('"sensitiveValuesUnavailable": true');
    expect(run.result).toContain('"code": "RUN_FAILED"');
    expect(run.result).not.toContain(PRIVATE_FAILURE);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('finalizes the journal when runtime construction fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meridian-cli-boundary-'));
  try {
    const run = await runReplayBoundary('construct', dir);
    expect(run.exitCode).not.toBe(0);
    expect(run.states).toEqual(['failure']);
    expect(run.result).toBeUndefined();
    expect(run.lockPresent).toBe(false);
    expect(run.dispatchCount).toBe(0);
    expect(run.closeCalls).toBe(0);
    expect(`${run.stdout}\n${run.stderr}`).not.toContain(PRIVATE_FAILURE);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('handles malformed replay setup before acquiring the journal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meridian-cli-boundary-'));
  try {
    const run = await runReplayBoundary('pre', dir, 'boundary-key-malformed', 'teller-test', ['--fault-route', '/missing-kind']);
    expect(run.exitCode).not.toBe(0);
    expect(run.states).toEqual([]);
    expect(run.result).toBeUndefined();
    expect(run.lockPresent).toBe(false);
    expect(run.dispatchCount).toBe(0);
    expect(run.closeCalls).toBe(0);
    expect(`${run.stdout}\n${run.stderr}`).not.toContain(PRIVATE_FAILURE);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('rejects a conflicting key at the CLI boundary without starting a second runtime', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meridian-cli-boundary-'));
  try {
    const first = await runReplayBoundary('construct', dir, 'boundary-key-conflict', 'teller-one');
    expect(first.states).toEqual(['failure']);
    const conflict = await runReplayBoundary('construct', dir, 'boundary-key-conflict', 'teller-two');
    expect(conflict.exitCode).not.toBe(0);
    expect(conflict.states).toEqual(['failure']);
    expect(conflict.lockPresent).toBe(false);
    expect(conflict.closeCalls).toBe(0);
    expect(conflict.dispatchCount).toBe(0);
    expect(conflict.stderr).toContain('Idempotency key already identifies another request');
    expect(conflict.stderr).not.toContain(PRIVATE_FAILURE);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('keeps terminal journal cleanup when logger writing fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meridian-cli-boundary-'));
  try {
    const run = await runReplayBoundary('write-failure', dir);
    expect(run.exitCode).not.toBe(0);
    expect(run.states).toEqual(['failure']);
    expect(run.result).toBeUndefined();
    expect(run.lockPresent).toBe(false);
    expect(run.closeCalls).toBe(1);
    expect(`${run.stdout}\n${run.stderr}`).not.toContain(PRIVATE_FAILURE);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('keeps terminal journal cleanup when runtime close rejects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meridian-cli-boundary-'));
  try {
    const run = await runReplayBoundary('close', dir);
    expect(run.exitCode).not.toBe(0);
    expect(run.states).toEqual(['failure']);
    expect(run.result).toContain('"code": "RUN_FAILED"');
    expect(run.lockPresent).toBe(false);
    expect(run.closeCalls).toBe(1);
    expect(`${run.stdout}\n${run.stderr}`).not.toContain(PRIVATE_FAILURE);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('supplies the canonical transfer completion validator to discovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'meridian-cli-discovery-'));
  const envKeys = ['OPENAI_API_KEY', 'EVIDENCE_DIR', 'JOURNAL_HMAC_KEY', 'MERIDIAN_TELLER_OPERATOR', 'MERIDIAN_TELLER_PASSWORD', 'MERIDIAN_BRANCH'];
  const previousEnv = new Map(envKeys.map(name => [name, process.env[name]]));
  const previousExitCode = process.exitCode;
  let validator: ((outputs: Record<string, unknown>) => void) | undefined;
  process.exitCode = undefined;
  Object.assign(process.env, {
    OPENAI_API_KEY: 'offline-test-only', EVIDENCE_DIR: dir, JOURNAL_HMAC_KEY: JOURNAL_KEY,
    MERIDIAN_TELLER_OPERATOR: 'teller-test', MERIDIAN_TELLER_PASSWORD: 'offline-test-only', MERIDIAN_BRANCH: 'MAIN-001',
  });
  vi.resetModules();
  vi.doMock('../src/agent/client.js', () => ({ makeLLMClient: () => ({ openai: {}, model: 'fixture' }) }));
  vi.doMock('../src/runtime/run.js', async () => {
    const actual = await vi.importActual<typeof import('../src/runtime/run.js')>('../src/runtime/run.js');
    return {
      ...actual,
      createRuntime: (options: Parameters<typeof actual.createRuntime>[0]) => {
        const redactor = new Redactor();
        return {
          surface: { mutationDispatched: false }, browser: { page: {} as never },
          logger: new RunLogger(options.kind, redactor, options.evidenceDir, true, options.runId), session: {} as never,
          redactor, promptRedactor: redactor, deadline: Date.now() + 600_000, close: async () => {},
        } as unknown as ReturnType<typeof actual.createRuntime>;
      },
    };
  });
  vi.doMock('../src/agent/loop.js', async () => {
    const actual = await vi.importActual<typeof import('../src/agent/loop.js')>('../src/agent/loop.js');
    return {
      ...actual,
      runDiscovery: async (_goal: string, _entry: string, _params: Record<string, string | number>, _origins: string[], deps: Parameters<typeof actual.runDiscovery>[4]) => {
        validator = deps.validateCompletion as unknown as ((outputs: Record<string, unknown>) => void) | undefined;
        validator?.({ confirmation: 'CONF-123', transaction: [{ member: '9001', sourceShare: '9001-A', destinationShare: '9001-B', amount: '1.00', memo: 'fixture', confirmation: 'CONF-123' }] });
        return { status: 'stopped' as const, trace: [], outputs: {}, finalUrl: 'https://web-sample.interface-hiring.com/members/9001/transfer/post', stopReason: 'fixture' };
      },
    };
  });
  try {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runCli } = await import('../cli.js');
    await runCli(['discover', '--name', 'meridian-funds-transfer', '--goal', 'Transfer', '--profile', 'meridian', '--entry', 'https://web-sample.interface-hiring.com/signon', '--idempotency-key', 'cli-discovery-transfer', '--param', 'member=9001', '--param', 'sourceShare=9001-A', '--param', 'destinationShare=9001-B', '--param', 'amount=1.00', '--param', 'memo=fixture']);
    expect(validator).toBeTypeOf('function');
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining('canonical'));
    log.mockRestore(); error.mockRestore();
  } finally {
    vi.doUnmock('../src/agent/client.js'); vi.doUnmock('../src/runtime/run.js'); vi.doUnmock('../src/agent/loop.js'); vi.resetModules(); vi.restoreAllMocks();
    for (const name of envKeys) {
      const value = previousEnv.get(name);
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    process.exitCode = previousExitCode;
    rmSync(dir, { recursive: true, force: true });
  }
});
