import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { MockLanguageModelV3 } from 'ai/test';
import { simulateReadableStream, type UIMessage, type UIMessageChunk } from 'ai';
import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/http.js';
import { Journal, RequestError } from '../src/runtime/journal.js';
import { journalDigest, type JournalSnapshot } from '../src/runtime/journal.js';
import { PostgresJournal } from '../src/runtime/postgres-journal.js';
import type { InvocationService } from '../src/server/service.js';
import { InvocationService as RealInvocationService } from '../src/server/service.js';
import * as runtime from '../src/runtime/run.js';
import { loadProfile, profilePolicy } from '../src/runtime/profile.js';
import { Redactor } from '../src/safety/redact.js';
import { chatRequest, observeGuardedChatStream } from '../src/server/ui/transport.js';
import { publicIntervention } from '../src/runtime/approval.js';
import { createPostgresFixture } from './fixtures/postgres.js';

// All browser/model/run fixtures in this suite are offline. No target is invoked.
const callerToken = 'c'.repeat(32),
  operatorToken = 'o'.repeat(32);
const subjectCaller = {
  subjectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  role: 'caller' as const,
  token: 's'.repeat(32),
};
const runId = '11111111-1111-4111-8111-111111111111';
const secondRunId = '11111111-1111-4111-8111-222222222222';
const approvalId = '22222222-2222-4222-8222-222222222222';
const secondApprovalId = '22222222-2222-4222-8222-333333333333';
const evidencePath = resolve('evidence/test-runs/assistant-ui');
const hostile = '<img src=x onerror=alert(1)>';
const readinessLabels = [
  ['meridian-sign-on', 'Sign on'],
  ['meridian-member-inquiry', 'Member inquiry'],
  ['meridian-member-record', 'Member record'],
  ['meridian-funds-transfer', 'Funds transfer'],
  ['meridian-open-share', 'Open share'],
  ['meridian-update-member', 'Update contact'],
  ['meridian-place-hold', 'Supervisor hold'],
] as const;
const operationContracts = [
  { id: 'meridian-funds-transfer', discovery: true, parameters: [
    { name: 'member', type: 'string', description: 'Member number', required: true, sensitive: true, pattern: '^[0-9]{1,12}$' },
    { name: 'sourceShare', type: 'string', description: 'Stable source share ID', required: true, sensitive: true, pattern: '^[0-9]{1,12}-[A-Za-z0-9-]+$' },
    { name: 'destinationShare', type: 'string', description: 'Stable destination share ID', required: true, sensitive: true, pattern: '^[0-9]{1,12}-[A-Za-z0-9-]+$' },
    { name: 'amount', type: 'string', description: 'Decimal amount', required: true, sensitive: true, format: 'positiveMoney' },
    { name: 'memo', type: 'string', description: 'Transfer memo', required: true, sensitive: true },
  ] },
  { id: 'meridian-open-share', discovery: false, parameters: [
    { name: 'member', type: 'string', description: 'Member number', required: true, sensitive: true, pattern: '^[0-9]{1,12}$' },
    { name: 'shareType', type: 'string', description: 'New share type', required: true, sensitive: false, enum: ['S0001', 'S0070', 'MMKT', 'CERT'] },
    { name: 'deposit', type: 'string', description: 'Decimal initial deposit', required: true, sensitive: true, format: 'positiveMoney' },
  ] },
  { id: 'meridian-update-member', discovery: true, parameters: [
    { name: 'member', type: 'string', description: 'Member number', required: true, sensitive: true, pattern: '^[0-9]{1,12}$' },
    { name: 'email', type: 'string', description: 'Email address', required: true, sensitive: true },
    { name: 'phone', type: 'string', description: 'Phone', required: true, sensitive: true },
    { name: 'address', type: 'string', description: 'Mailing address', required: true, sensitive: true },
  ] },
  { id: 'meridian-place-hold', discovery: true, parameters: [
    { name: 'member', type: 'string', description: 'Member number', required: true, sensitive: true, pattern: '^[0-9]{1,12}$' },
    { name: 'share', type: 'string', description: 'Stable share ID', required: true, sensitive: true, pattern: '^[0-9]{1,12}-[A-Za-z0-9-]+$' },
    { name: 'reason', type: 'string', description: 'Hold reason', required: true, sensitive: false, enum: ['FRAUD', 'LEGAL', 'DECEASED'] },
    { name: 'notes', type: 'string', description: 'Notes', required: true, sensitive: true },
  ] },
] as const;

function walkthroughScreenshotPath(name: string) {
  const outputDir = process.env.MERIDIAN_WALKTHROUGH_SCREENSHOT_DIR
    ? resolve(process.env.MERIDIAN_WALKTHROUGH_SCREENSHOT_DIR)
    : evidencePath;
  mkdirSync(outputDir, { recursive: true });
  return join(outputDir, name);
}

function parseNativeDisplayNumber(output: string): string | undefined {
  if (!/^\d{0,5}\n?$/.test(output) || (output && Number(output) > 65535)) {
    throw new Error('Invalid Xvfb display allocation');
  }
  if (!output.endsWith('\n')) return undefined;
  if (output === '\n') throw new Error('Invalid Xvfb display allocation');
  return `:${Number(output)}`;
}

function readNativeDisplayAllocation(server: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    const pipe = server.stdio[3];
    if (!pipe || !('readable' in pipe)) return reject(new Error('Missing Xvfb display allocation pipe'));
    let output = '';
    const finish = (error?: Error, display?: string) => {
      clearTimeout(timer);
      pipe.removeListener('data', onData);
      pipe.removeListener('end', onEnd);
      server.removeListener('error', onError);
      server.removeListener('exit', onExit);
      if (error) reject(error);
      else resolve(display!);
    };
    const onError = (error: Error) => finish(error);
    const onExit = () => finish(new Error('Xvfb exited before allocating its display'));
    const onEnd = () => finish(new Error('Xvfb display allocation pipe closed without a display'));
    const onData = (chunk: Buffer) => {
      try {
        output += chunk.toString('ascii');
        const display = parseNativeDisplayNumber(output);
        if (server.exitCode !== null || server.signalCode !== null) return onExit();
        if (display) finish(undefined, display);
      } catch (error) {
        finish(error as Error);
      }
    };
    const timer = setTimeout(() => finish(new Error('Timed out waiting for Xvfb display allocation')), 5000);
    pipe.on('data', onData);
    pipe.once('end', onEnd);
    server.once('error', onError);
    server.once('exit', onExit);
    if (server.exitCode !== null || server.signalCode !== null) onExit();
  });
}

function assertOwnedNativeDisplay(native: {
  server: ReturnType<typeof spawn>;
  display: string;
  socket: { dev: number; ino: number };
}) {
  if (!native.server.pid || native.server.exitCode !== null || native.server.signalCode !== null) {
    throw new Error('Owned Xvfb process is not running');
  }
  const socket = statSync(`/tmp/.X11-unix/X${native.display.slice(1)}`);
  if (!socket.isSocket() || socket.dev !== native.socket.dev || socket.ino !== native.socket.ino) {
    throw new Error('Owned Xvfb display socket was replaced');
  }
}

async function startNativeDisplay() {
  if (process.env.MERIDIAN_NATIVE_ZOOM !== '1') throw new Error('Native display requires MERIDIAN_NATIVE_ZOOM=1');
  // -displayfd atomically selects an unused display; only this child can write FD 3.
  const server = spawn('/usr/bin/Xvfb', [
    '-displayfd', '3',
    '-screen', '0', '1441x901x24',
    '-nolisten', 'tcp',
    '-ac',
  ], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
  try {
    const display = await readNativeDisplayAllocation(server);
    // Xvfb's ready message comes from this child after it binds the free socket.
    // Remember that socket identity so a reused display number is never accepted.
    const socket = statSync(`/tmp/.X11-unix/X${display.slice(1)}`);
    const native = { server, display, socket };
    assertOwnedNativeDisplay(native);
    return native;
  } catch (error) {
    try {
      await stopNativeDisplay(server);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'Native display setup and cleanup failed');
    }
    throw error;
  }
}

async function stopNativeDisplay(server: ReturnType<typeof spawn>) {
  if (!server.pid) return;
  if (server.exitCode === null && server.signalCode === null) server.kill('SIGTERM');
  if (server.exitCode === null && server.signalCode === null) {
    await new Promise<void>(resolve => server.once('exit', () => resolve()));
  }
}

async function captureNativeDisplay(native: Awaited<ReturnType<typeof startNativeDisplay>>, outputPath: string) {
  assertOwnedNativeDisplay(native);
  const { display } = native;
  await new Promise<void>((resolve, reject) => {
    execFile('/usr/bin/ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'x11grab', '-framerate', '1', '-video_size', '1440x900',
      '-i', `${display}+0,0`,
      '-frames:v', '1', '-y', outputPath,
    ], { env: { ...process.env, DISPLAY: display } }, error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function nativeLifecycle(key: string, intent: 'action' | 'status' = 'action') {
  return {
    key,
    intent,
    sawTool: false,
    sawStatusTool: false,
    sawOtherTool: false,
    finishReason: undefined as string | undefined,
    finishSeen: false,
    postFinishFailure: false,
    failed: false,
    settled: false,
    toolNames: new Map<string, string>(),
  };
}

function heldNativeStream(chunks: UIMessageChunk[]) {
  let controller!: ReadableStreamDefaultController<UIMessageChunk>;
  let release!: (ending: 'error' | 'close' | 'error-chunk' | 'abort' | 'second-finish') => void;
  let resolvePull!: () => void;
  let index = 0;
  const waiting = new Promise<void>(resolve => { resolvePull = resolve; });
  const stream = new ReadableStream<UIMessageChunk>({
    start(next) { controller = next; },
    pull(next) {
      if (index < chunks.length) {
        next.enqueue(chunks[index++]);
        return;
      }
      return waiting;
    },
    cancel() { resolvePull(); },
  });
  release = ending => {
    if (ending === 'error') controller.error(new Error('native reader failed'));
    else if (ending === 'close') controller.close();
    else if (ending === 'error-chunk') {
      controller.enqueue({ type: 'error', errorText: 'native parsed error' });
      controller.close();
    } else if (ending === 'abort') {
      controller.enqueue({ type: 'abort', reason: 'native abort' });
      controller.close();
    } else {
      controller.enqueue({ type: 'finish', finishReason: 'error' });
      controller.close();
    }
    resolvePull();
  };
  return { stream, release };
}

function readNativeLifecycleStream(
  source: ReadableStream<UIMessageChunk>,
  lifecycle: ReturnType<typeof nativeLifecycle>,
  lifecycles: Map<string, ReturnType<typeof nativeLifecycle>>,
) {
  const complete: string[] = [];
  const uncertain: string[] = [];
  const observed = observeGuardedChatStream(source, lifecycle, lifecycles, {
    complete: current => complete.push(current.key),
    uncertain: key => uncertain.push(key),
  });
  return { observed, complete, uncertain };
}

it.each([
  ['no-tool stop', false],
  ['action-tool tool-calls', true],
] as const)('does not settle a parsed %s lifecycle before a reader error or cancellation', async (_label, withActionTool) => {
  for (const ending of ['error', 'cancel'] as const) {
    const key = `native-${ending}-${withActionTool ? 'action' : 'stop'}`;
    const lifecycle = nativeLifecycle(key);
    const lifecycles = new Map([[key, lifecycle]]);
    const chunks: UIMessageChunk[] = withActionTool ? [
      { type: 'tool-input-available', toolCallId: 'action-call', toolName: 'meridian-member-record', input: { member: 'offline-member' } },
      { type: 'finish', finishReason: 'tool-calls' },
    ] : [{ type: 'finish', finishReason: 'stop' }];
    const source = heldNativeStream(chunks);
    const result = readNativeLifecycleStream(source.stream, lifecycle, lifecycles);
    const reader = result.observed.getReader();
    if (withActionTool) {
      expect((await reader.read()).value?.type).toBe('tool-input-available');
    }
    expect((await reader.read()).value?.type).toBe('finish');
    await vi.waitFor(() => expect(source.release).toBeTypeOf('function'));
    expect(result.complete).toEqual([]);
    expect(result.uncertain).toEqual([]);
    expect(lifecycles.get(key)).toBe(lifecycle);
    if (ending === 'error') {
      source.release('error');
      await expect(reader.read()).rejects.toThrow('native reader failed');
    } else {
      await reader.cancel('consumer stopped');
    }
    expect(result.complete).toEqual([]);
    expect(result.uncertain).toEqual([key]);
    expect(lifecycles.has(key)).toBe(false);
  }
});

it.each([
  ['no-tool stop', false],
  ['action-tool tool-calls', true],
] as const)('settles a clean parsed %s lifecycle only at EOF', async (_label, withActionTool) => {
  const key = `native-eof-${withActionTool ? 'action' : 'stop'}`;
  const lifecycle = nativeLifecycle(key);
  const lifecycles = new Map([[key, lifecycle]]);
  const chunks: UIMessageChunk[] = withActionTool ? [
    { type: 'tool-input-available', toolCallId: 'action-call', toolName: 'meridian-member-record', input: { member: 'offline-member' } },
    { type: 'finish', finishReason: 'tool-calls' },
  ] : [{ type: 'finish', finishReason: 'stop' }];
  const source = heldNativeStream(chunks);
  const result = readNativeLifecycleStream(source.stream, lifecycle, lifecycles);
  const reader = result.observed.getReader();
  if (withActionTool) expect((await reader.read()).value?.type).toBe('tool-input-available');
  expect((await reader.read()).value?.type).toBe('finish');
  expect(result.complete).toEqual([]);
  expect(lifecycles.get(key)).toBe(lifecycle);
  source.release('close');
  await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  expect(result.complete).toEqual([key]);
  expect(result.uncertain).toEqual([]);
  expect(lifecycles.has(key)).toBe(false);
  expect(lifecycle.finishSeen).toBe(true);
  expect(lifecycle.finishReason).toBe(withActionTool ? 'tool-calls' : 'stop');
});

it.each([
  ['parsed error', 'error-chunk'],
  ['parsed abort', 'abort'],
  ['conflicting second finish', 'second-finish'],
] as const)('fails closed for a %s after parsed finish without early completion', async (_label, ending) => {
  for (const withActionTool of [false, true]) {
    const key = `native-late-${ending}-${withActionTool ? 'action' : 'stop'}`;
    const lifecycle = nativeLifecycle(key);
    const lifecycles = new Map([[key, lifecycle]]);
    const chunks: UIMessageChunk[] = withActionTool ? [
      { type: 'tool-input-available', toolCallId: 'action-call', toolName: 'meridian-member-record', input: { member: 'offline-member' } },
      { type: 'finish', finishReason: 'tool-calls' },
    ] : [{ type: 'finish', finishReason: 'stop' }];
    const source = heldNativeStream(chunks);
    const result = readNativeLifecycleStream(source.stream, lifecycle, lifecycles);
    const reader = result.observed.getReader();
    if (withActionTool) expect((await reader.read()).value?.type).toBe('tool-input-available');
    expect((await reader.read()).value?.type).toBe('finish');
    expect(result.complete).toEqual([]);
    expect(lifecycles.get(key)).toBe(lifecycle);
    source.release(ending);
    if (ending === 'error-chunk' || ending === 'abort' || ending === 'second-finish') {
      expect((await reader.read()).value?.type).toBe(ending === 'error-chunk' ? 'error' : ending === 'abort' ? 'abort' : 'finish');
      await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
    }
    expect(result.complete).toEqual([]);
    expect(result.uncertain).toEqual([key]);
    expect(lifecycles.has(key)).toBe(false);
  }
});

it('fails an authorized parsed action after delivering its tool chunk before finish', async () => {
  const key = 'native-pre-finish-action-error';
  const lifecycle = nativeLifecycle(key);
  const lifecycles = new Map([[key, lifecycle]]);
  const source = heldNativeStream([{
    type: 'tool-input-available', toolCallId: 'action-call', toolName: 'meridian-member-record', input: { member: 'offline-member' },
  }]);
  const result = readNativeLifecycleStream(source.stream, lifecycle, lifecycles);
  const reader = result.observed.getReader();
  expect((await reader.read()).value?.type).toBe('tool-input-available');
  expect(lifecycle.sawOtherTool).toBe(true);
  expect(result.complete).toEqual([]);
  expect(result.uncertain).toEqual([]);
  source.release('error');
  await expect(reader.read()).rejects.toThrow('native reader failed');
  expect(result.complete).toEqual([]);
  expect(result.uncertain).toEqual([key]);
  expect(lifecycles.has(key)).toBe(false);
});

it('keeps a parsed status-only lifecycle isolated from a pre-existing action key', async () => {
  const statusKey = 'native-status-key';
  const actionKey = 'native-action-key';
  const statusLifecycle = nativeLifecycle(statusKey, 'status');
  const actionLifecycle = nativeLifecycle(actionKey);
  const lifecycles = new Map([[statusKey, statusLifecycle], [actionKey, actionLifecycle]]);
  const source = heldNativeStream([
    { type: 'tool-input-available', toolCallId: 'status-call', toolName: 'run_status', input: { runId } },
    { type: 'finish', finishReason: 'tool-calls' },
  ]);
  const result = readNativeLifecycleStream(source.stream, statusLifecycle, lifecycles);
  const reader = result.observed.getReader();
  expect((await reader.read()).value?.type).toBe('tool-input-available');
  expect((await reader.read()).value?.type).toBe('finish');
  source.release('close');
  await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  expect(result.complete).toEqual([]);
  expect(result.uncertain).toEqual([]);
  expect(lifecycles.has(statusKey)).toBe(false);
  expect(lifecycles.get(actionKey)).toBe(actionLifecycle);
});
function fixtureAvailability(recordState: 'available' | 'temporarily_unavailable', inquiryState: 'not_recorded' | 'available' = 'not_recorded') {
  return readinessLabels.map(([id, label]) => ({
    id,
    label,
    state: id === 'meridian-member-record' ? recordState : id === 'meridian-member-inquiry' ? inquiryState : 'not_recorded',
    reason: id === 'meridian-member-record' && recordState === 'temporarily_unavailable'
      ? 'Another operation is active'
      : id === 'meridian-member-inquiry' && inquiryState === 'not_recorded' ? 'No approved recording' : 'Approved recording is ready',
  }));
}
const capability = {
  id: 'meridian-member-record',
  version: '1.0.0',
  description: `Read member shares ${hostile}`,
  parameters: [{ name: 'member', type: 'string', description: hostile, required: true, sensitive: true }],
  outputs: [],
  tools: {
    openai: {
      type: 'function',
      function: {
        name: 'meridian-member-record',
        description: 'Read member shares',
        parameters: {
          type: 'object',
          properties: { member: { type: 'string' } },
          required: ['member'],
          additionalProperties: false,
        },
      },
    },
    mcp: {},
  },
};
const initialRun = () => ({
  runId,
  kind: 'replay',
  capability: capability.id,
  version: '1.0.0',
  state: 'running',
  elapsedMs: 0,
  createdAt: '2026-09-05T12:00:00.000Z',
  evidence: ['result.json', 'log.jsonl', 'masked.png'],
});
const cleanup: (() => Promise<void>)[] = [];
const defaultCapability = capability;

type FixtureResources = {
  evidenceDir?: string;
  nativeProfileDir?: string;
  nativeDisplay?: Awaited<ReturnType<typeof startNativeDisplay>>;
  server?: ReturnType<typeof createServer>;
  browser?: Browser | BrowserContext;
};

async function closeFixtureResources(resources: FixtureResources) {
  const failures: unknown[] = [];
  const attempt = async (close: () => Promise<void> | void) => {
    try {
      await close();
    } catch (error) {
      failures.push(error);
    }
  };
  await attempt(async () => resources.browser?.close());
  await attempt(async () => {
    if (!resources.server?.listening) return;
    resources.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => resources.server!.close(error => {
      if (error) reject(error);
      else resolve();
    }));
  });
  await attempt(() => {
    if (resources.evidenceDir) rmSync(resources.evidenceDir, { recursive: true, force: true });
  });
  await attempt(() => {
    if (resources.nativeProfileDir) rmSync(resources.nativeProfileDir, { recursive: true, force: true });
  });
  await attempt(async () => {
    if (resources.nativeDisplay) await stopNativeDisplay(resources.nativeDisplay.server);
  });
  if (failures.length) throw new AggregateError(failures, 'fixture cleanup failed');
}

function registerFixtureCleanup(resources: FixtureResources) {
  let closed = false;
  const close = async () => {
    if (closed) return;
    await closeFixtureResources(resources);
    closed = true;
  };
  cleanup.push(close);
  return close;
}

async function withFixtureCleanup<T>(setup: (resources: FixtureResources) => Promise<T>) {
  const resources: FixtureResources = {};
  const close = registerFixtureCleanup(resources);
  try {
    return await setup(resources);
  } catch (error) {
    try {
      await close();
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'fixture setup and cleanup failed');
    }
    throw error;
  }
}

afterEach(async () => {
  const failures: unknown[] = [];
  for (const close of cleanup.splice(0).reverse()) {
    try { await close(); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'fixture teardown failed');
});

it.each([
  ['ordinary browser setup', { failSetupAfter: 'browser' }],
  ...(process.env.MERIDIAN_NATIVE_ZOOM === '1'
    ? [['native browser setup', { nativeZoom200: true, failSetupAfter: 'browser' }]] as const
    : []),
] as const)('registers idempotent teardown before %s can fail', async (_label, options) => {
  expect(cleanup).toHaveLength(0);
  await expect(fixture(false, undefined, options)).rejects.toThrow('injected fixture setup failure');
  expect(cleanup).toHaveLength(1);
  const [close] = cleanup.splice(0);
  if (!close) throw new Error('fixture teardown was not registered');
  await close();
  await close();
});

it('surfaces setup and cleanup errors and retries the registered teardown', async () => {
  const browser = await chromium.launch();
  const closeBrowser = browser.close.bind(browser);
  const setupError = new Error('setup failed after allocation');
  const cleanupError = new Error('browser close failed once');
  const directory = mkdtempSync(join(tmpdir(), 'assistant-ui-cleanup-failure-'));
  vi.spyOn(browser, 'close').mockRejectedValueOnce(cleanupError);
  try {
    const result = await withFixtureCleanup(async resources => {
      resources.browser = browser;
      resources.evidenceDir = directory;
      throw setupError;
    }).catch(error => error);
    expect(result).toBeInstanceOf(AggregateError);
    expect(result.errors[0]).toBe(setupError);
    expect(result.errors[1]).toBeInstanceOf(AggregateError);
    expect(result.errors[1].errors).toEqual([cleanupError]);
    expect(existsSync(directory)).toBe(false);
    expect(browser.isConnected()).toBe(true);
    const close = cleanup[0];
    expect(close).toBeTypeOf('function');
    await close!();
    expect(browser.isConnected()).toBe(false);
    await close!();
  } finally {
    await closeBrowser();
  }
});

it('refuses native display setup unless explicitly opted in', async () => {
  const previous = process.env.MERIDIAN_NATIVE_ZOOM;
  delete process.env.MERIDIAN_NATIVE_ZOOM;
  let display: Awaited<ReturnType<typeof startNativeDisplay>> | undefined;
  try {
    const result = await startNativeDisplay().then(value => { display = value; return value; }, error => error);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toContain('MERIDIAN_NATIVE_ZOOM=1');
  } finally {
    if (display) await stopNativeDisplay(display.server);
    if (previous === undefined) delete process.env.MERIDIAN_NATIVE_ZOOM;
    else process.env.MERIDIAN_NATIVE_ZOOM = previous;
  }
});

it('reads only a complete valid display allocation from the spawned child pipe', async () => {
  expect(parseNativeDisplayNumber('')).toBeUndefined();
  expect(parseNativeDisplayNumber('12')).toBeUndefined();
  expect(parseNativeDisplayNumber('127\n')).toBe(':127');
  expect(parseNativeDisplayNumber('0\n')).toBe(':0');
  for (const invalid of ['-1\n', ':7\n', '7\n8\n', '7junk\n', '65536\n']) {
    expect(() => parseNativeDisplayNumber(invalid)).toThrow('Invalid Xvfb display allocation');
  }
  // A real Node child exercises the private FD protocol without any native X binaries.
  const child = spawn(process.execPath, ['-e', "require('node:fs').writeSync(3, '12'); setTimeout(() => require('node:fs').writeSync(3, '7\\n'), 20); setInterval(() => {}, 1000)"], {
    stdio: ['ignore', 'ignore', 'ignore', 'pipe'],
  });
  try {
    expect(await readNativeDisplayAllocation(child)).toBe(':127');
  } finally {
    await stopNativeDisplay(child);
  }
});

it('rejects native allocation when its child exits or emits malformed output', async () => {
  for (const script of ["process.exit(1)", "require('node:fs').writeSync(3, 'other display\\n'); setInterval(() => {}, 1000)"]) {
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });
    try {
      await expect(readNativeDisplayAllocation(child)).rejects.toThrow(/Xvfb exited|pipe closed|Invalid Xvfb display allocation/);
    } finally {
      await stopNativeDisplay(child);
    }
  }
});

it.skipIf(process.env.MERIDIAN_NATIVE_ZOOM !== '1')('allocates distinct owned native displays and refuses capture after ownership ends', async () => {
  const first = await startNativeDisplay();
  let second: Awaited<ReturnType<typeof startNativeDisplay>> | undefined;
  const output = join(mkdtempSync(join(tmpdir(), 'assistant-ui-display-ownership-')), 'forbidden.png');
  try {
    second = await startNativeDisplay();
    expect(second.display).not.toBe(first.display);
    expect(() => assertOwnedNativeDisplay(first)).not.toThrow();
    expect(() => assertOwnedNativeDisplay(second!)).not.toThrow();
    expect(() => assertOwnedNativeDisplay({ ...first, socket: second!.socket })).toThrow('socket was replaced');
    await stopNativeDisplay(first.server);
    await expect(captureNativeDisplay(first, output)).rejects.toThrow('Owned Xvfb process is not running');
    expect(existsSync(output)).toBe(false);
  } finally {
    await stopNativeDisplay(first.server);
    if (second) await stopNativeDisplay(second.server);
    rmSync(resolve(output, '..'), { recursive: true, force: true });
  }
});

async function fixture(
  localTeller = false,
  availabilityOverride?: () => unknown,
  options: {
    subjectTokens?: typeof subjectCaller[];
    holdRefreshCapabilities?: boolean;
    nativeZoom200?: boolean;
    failSetupAfter?: 'browser';
    capabilityId?: string;
    capability?: typeof capability;
    appId?: string;
  } = {},
) {
  return withFixtureCleanup(async resources => {  const capability = {
    ...(options.capability ?? defaultCapability),
    id: options.capabilityId ?? (options.capability ?? defaultCapability).id,
  };
  const evidenceDir = mkdtempSync(join(tmpdir(), 'assistant-ui-'));
  resources.evidenceDir = evidenceDir;
  mkdirSync(join(evidenceDir, runId));
  mkdirSync(evidencePath, { recursive: true });
  writeFileSync(join(evidenceDir, runId, 'result.json'), JSON.stringify({ text: hostile }));
  writeFileSync(
    join(evidenceDir, runId, 'log.jsonl'),
    JSON.stringify({ event: 'action.end', attempt: 1, elapsedMs: 0 }) + '\n',
  );
  writeFileSync(
    join(evidenceDir, runId, 'masked.png'),
    Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ),
  );
  const state = {
    runs: [] as Record<string, any>[],
    historyHidden: new Set<string>(),
    requests: [] as { path: string; method?: string; authorization?: string; body?: any; key?: string }[],
    invocations: new Map<string, string>(),
    decisions: [] as string[],
    toolSchemas: [] as string[],
    partialStream: false,
    noTool: false,
    finishReason: 'tool-calls' as string | undefined,
    omitFinishReason: false,
    postFinishMode: '' as '' | 'error' | 'open' | 'error-chunk' | 'second-finish',
    postFinishRelease: undefined as (() => void) | undefined,
    capabilityReads: 0,
    capabilityPartial: false,
    releaseCapabilityBody: undefined as (() => void) | undefined,
    offline: false,
    actionToolName: undefined as string | undefined,
    actionToolInput: undefined as Record<string, unknown> | undefined,
  };
  const service = {
    profile: { appId: options.appId ?? 'meridian' },
    journal: { findRequest: () => undefined, bindReference: () => {} },
    requestContexts: () => new Map(),
    evidenceDir,
    catalog: () => [capability],
    operationContracts: () => operationContracts,
    availability: () => availabilityOverride ? availabilityOverride() : [
      ['meridian-sign-on', 'Sign on'],
      ['meridian-member-inquiry', 'Member inquiry'],
      ['meridian-member-record', 'Member record'],
      ['meridian-funds-transfer', 'Funds transfer'],
      ['meridian-open-share', 'Open share'],
      ['meridian-update-member', 'Update contact'],
      ['meridian-place-hold', 'Supervisor hold'],
    ].map(([id, label]) => service.catalog().some((entry) => entry.id === id)
      ? { id, label, state: 'available', reason: 'Approved recording is ready' }
      : { id, label, state: 'not_recorded', reason: 'No approved recording' }),
    history: (principal: string) => {
      if (state.offline) throw new RequestError(503, 'Offline fixture disconnected');
      return state.runs.filter((r) => !state.historyHidden.has(r.runId)).map((r) =>
        principal === 'operator'
          ? r
          : {
              ...r,
              intervention: r.intervention ? { kind: 'risk_approval', awaitingOperator: true } : undefined,
},
      );
    },
    get: (principal: string, id: string) => {
      const run = state.runs.find((r) => r.runId === id);
      if (!run) throw new RequestError(404, 'Unknown run');
      return principal === 'operator'
        ? run
        : {
            ...run,
            intervention: run.intervention ? { kind: 'risk_approval', awaitingOperator: true } : undefined,
          };
    },
    invoke: vi.fn((_principal: string, id: string, args: unknown, key: string, _role = 'TELLER', lookupOnly = false) => {
      const fingerprint = JSON.stringify([id, args]);
      if (state.invocations.has(key) && state.invocations.get(key) !== fingerprint)
        throw new RequestError(409, 'Conflicting idempotency key');
      if (lookupOnly && !state.invocations.has(key)) throw new RequestError(404, 'No accepted request found');
      if (!state.invocations.has(key)) {
        state.invocations.set(key, fingerprint);
        state.runs.push({ ...initialRun(), capability: id });
      }
      return { runId };
    }),
    discover: vi.fn((_principal: string, id: string, args: unknown, key: string, role = 'TELLER', lookupOnly = false) => {
      const fingerprint = JSON.stringify(['discovery', id, args, role]);
      if (state.invocations.has(key) && state.invocations.get(key) !== fingerprint)
        throw new RequestError(409, 'Conflicting idempotency key');
      if (lookupOnly && !state.invocations.has(key)) throw new RequestError(404, 'No accepted request found');
      if (!state.invocations.has(key)) {
        state.invocations.set(key, fingerprint);
        state.runs.push({ ...initialRun(), kind: 'discovery', capability: id });
      }
      return { runId };
    }),
    decide: (_principal: string, id: string, interventionId: string, decision: string) => {
      const run = state.runs.find((r) => r.runId === id);
      if (
        !run?.intervention ||
        run.intervention.id !== interventionId ||
        run.intervention.expiresAt <= Date.now()
      )
        throw new RequestError(409, 'Stale intervention');
      state.decisions.push(decision);
      delete run.intervention;
      run.state = 'running';
    },
  };
  const model = new MockLanguageModelV3({
    doGenerate: async options => ({
      content: [{ type: 'tool-call', toolCallId: 'route', toolName: 'route_request', input: JSON.stringify({
        intent: JSON.stringify(options.prompt.at(-1)).includes('Did that finish?') ? 'status' : 'invoke',
      }) }],
      finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
      warnings: [],
    }),
    doStream: async options => {
      const serializedTools = JSON.stringify(options.tools ?? {});
      state.toolSchemas.push(serializedTools);
      const statusOnly = !serializedTools.includes(capability.id);
      const statusNeedsNoTool = statusOnly && state.runs.length === 0;
      const finishReason = statusNeedsNoTool && state.finishReason === 'tool-calls'
        ? 'stop'
        : state.finishReason ?? 'tool-calls';
      if (state.partialStream) {
        return {
          stream: new ReadableStream<{ type: string; [key: string]: unknown }>({
            start(controller) {
              controller.enqueue({ type: 'stream-start', warnings: [] });
              controller.enqueue({
                type: 'tool-call',
                toolCallId: 'partial-tool',
                toolName: capability.id,
                input: JSON.stringify({ member: 'offline-member' }),
              });
              controller.error(new Error('fixture stream truncated after tool input'));
            },
          }) as ReadableStream<never>,
        };
      }
      if (state.postFinishMode) {
        const chunks = [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'text' },
          { type: 'text-delta', id: 'text', delta: hostile },
          { type: 'text-end', id: 'text' },
          ...(statusNeedsNoTool || state.noTool ? [] : [{
            type: 'tool-call',
            toolCallId: 'offline-tool',
            toolName: state.actionToolName ?? (statusOnly ? 'run_status' : capability.id),
            input: JSON.stringify(state.actionToolInput ?? (statusOnly && !state.actionToolName ? { runId } : { member: 'offline-member' })),
          }]),
          {
            type: 'finish',
            ...(state.omitFinishReason ? {} : { finishReason: { unified: finishReason, raw: finishReason } }),
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ];
        let index = 0;
        let released = false;
        return {
          stream: new ReadableStream<{ type: string; [key: string]: unknown }>({
            pull(controller) {
              if (index < chunks.length) {
                controller.enqueue(chunks[index++]);
                return;
              }
              if (released) {
                controller.close();
                return;
              }
              return new Promise<void>(resolve => {
                state.postFinishRelease = () => {
                  state.postFinishRelease = undefined;
                  released = true;
                  if (state.postFinishMode === 'error') controller.error(new Error('fixture reader failed after finish'));
                  else if (state.postFinishMode === 'error-chunk') controller.enqueue({ type: 'error', error: new Error('fixture error chunk after finish') });
                  else if (state.postFinishMode === 'second-finish') controller.enqueue({ type: 'finish', finishReason: { unified: 'error', raw: 'error' }, usage: {} });
                  resolve();
                };
              });
            },
            cancel() {
              state.postFinishRelease = undefined;
            },
          }) as ReadableStream<never>,
        };
      }
      return {
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'text' },
          { type: 'text-delta', id: 'text', delta: hostile },
          { type: 'text-end', id: 'text' },
          ...(statusNeedsNoTool || state.noTool ? [] : [{
            type: 'tool-call',
            toolCallId: 'offline-tool',
            toolName: state.actionToolName ?? (statusOnly ? 'run_status' : capability.id),
            input: JSON.stringify(state.actionToolInput ?? (statusOnly && !state.actionToolName ? { runId } : { member: 'offline-member' })),
          }]),
          {
            type: 'finish',
            ...(state.omitFinishReason ? {} : { finishReason: { unified: finishReason, raw: finishReason } }),
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
              outputTokens: { total: 1, text: 1, reasoning: 0 },
            },
          },
        ],
      }) as ReadableStream<never>,
      };
    },
  });
  const server = createServer();
  resources.server = server;
  server.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  const app = createApp(service as unknown as InvocationService, {
    callerToken,
    operatorToken,
    subjectTokens: options.subjectTokens,
    port,
    localTellerLogin: localTeller ? { teller: 'TELLER1', supervisor: 'SUPER1' } : undefined,
    chatModel: model,
  });
  server.on('request', (req, res) => {
    const record = {
      path: req.url!,
      method: req.method,
      authorization: req.headers.authorization,
      key: req.headers['idempotency-key'] as string,
      body: undefined as any,
    };
    state.requests.push(record);
    if (req.url === '/capabilities') {
      state.capabilityReads++;
      if (options.holdRefreshCapabilities && state.capabilityReads === 2) {
        state.capabilityPartial = true;
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.write('{"principal":"caller",');
        let release!: () => void;
        const held = new Promise<void>(resolve => {
          release = resolve;
          state.releaseCapabilityBody = resolve;
        });
        req.once('aborted', release);
        void held.then(() => {
          state.releaseCapabilityBody = undefined;
          if (!res.destroyed && !res.writableEnded) res.end('"capabilities":[],"availability":[]}');
        });
        return;
      }
    }
    let body = '';
    req.on('data', (data) => {
      body += data;
    });
    req.on('end', () => {
      if (body) record.body = JSON.parse(body);
    });
    app(req, res);
  });
  let browser: Browser | BrowserContext;
  let nativeProfileDir: string | undefined;
  let nativeDisplay: Awaited<ReturnType<typeof startNativeDisplay>> | undefined;
  if (options.nativeZoom200) {
    nativeProfileDir = mkdtempSync(join(tmpdir(), 'assistant-ui-native-zoom-'));
    resources.nativeProfileDir = nativeProfileDir;
    mkdirSync(join(nativeProfileDir, 'Default'), { recursive: true });
    const zoomLevel200 = Math.log(2) / Math.log(1.2);
    const preferences = {
      partition: { default_zoom_level: { x: zoomLevel200 } },
      credentials_enable_service: false,
      profile: { password_manager_enabled: false },
    };
    writeFileSync(join(nativeProfileDir, 'Default', 'Preferences'), JSON.stringify(preferences));
    nativeDisplay = await startNativeDisplay();
    resources.nativeDisplay = nativeDisplay;
    assertOwnedNativeDisplay(nativeDisplay);
    browser = await chromium.launchPersistentContext(nativeProfileDir, {
      headless: false,
      viewport: null,
      env: { ...process.env, DISPLAY: nativeDisplay.display },
      args: [
        '--window-size=1440,900',
        '--window-position=0,0',
        '--kiosk',
        '--disable-save-password-bubble',
        '--disable-features=PasswordManagerOnboarding,PasswordManagerSavePrompt',
      ],
    });
    resources.browser = browser;
  } else {
    browser = await chromium.launch();
    resources.browser = browser;
  }
  if (options.failSetupAfter === 'browser') throw new Error('injected fixture setup failure');
  const page = 'pages' in browser
    ? (browser.pages()[0] ?? await browser.newPage())
    : await browser.newPage();
  const errors: string[] = [];
  await page.addInitScript(() => {
    (window as any).cspViolations = [];
    document.addEventListener('securitypolicyviolation', (event) =>
      (window as any).cspViolations.push({
        directive: event.violatedDirective,
        blocked: event.blockedURI,
        source: event.sourceFile,
        line: event.lineNumber,
        sample: event.sample,
      }),
    );
  });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (message) => {
    if (message.type() === 'error' && !message.text().includes('Failed to load resource'))
      errors.push(message.text());
  });
  await page.route('**/*', (route) =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const url = `http://127.0.0.1:${port}`;
  const documentResponse = await page.goto(url);
  expect(documentResponse?.headers()['content-security-policy']).toContain("script-src 'self'");
  expect(documentResponse?.headers()['content-security-policy']).not.toContain('unsafe-inline');
  async function connect(token = callerToken) {
    const disconnect = page.getByRole('button', { name: 'Disconnect', exact: true });
    if (await disconnect.isVisible()) await disconnect.click();
    await page.locator('#credential').fill(token);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.locator('#workspace').waitFor();
    await page.getByRole('button', { name: /^Activity/ }).click();
  }
  return { state, service, model, browser, page, connect, errors, url, evidenceDir, nativeDisplay };
  });
}
async function visible(page: Page, selector: string, text: string) {
  await page.waitForFunction(
    ({ selector, text }) => document.querySelector(selector)?.textContent?.includes(text),
    { selector, text },
  );
}
async function expectNoHorizontalOverflow(page: Page, selector: string) {
  const dimensions = await page.locator(selector).evaluate((node) => ({
    clientWidth: (node as HTMLElement).clientWidth,
    scrollWidth: (node as HTMLElement).scrollWidth,
  }));
  expect(dimensions.clientWidth).toBeGreaterThan(0);
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth);
}
async function settleConversationLayout(page: Page) {
  await page.locator('.chat').waitFor({ state: 'visible' });
  // Let the viewport ResizeObserver and queued scroll restoration finish before simulating a new user scroll.
  await page.evaluate(() => new Promise<void>(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))));
}
async function expectKeyboardVisibleFocus(target: Locator) {
  const focusStyle = await target.evaluate((node) => {
    const style = getComputedStyle(node);
    return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
  });
  expect(focusStyle.style).not.toBe('none');
  expect(focusStyle.width).toBeGreaterThanOrEqual(2);
}

it('recovers a real PostgreSQL chat action after the browser loses its response before tool output', async () => {
  for (const role of ['TELLER', 'SUPERVISOR']) {
    vi.stubEnv(`MERIDIAN_${role}_OPERATOR`, role);
    vi.stubEnv(`MERIDIAN_${role}_PASSWORD`, 'fixture-password');
  }
  vi.stubEnv('MERIDIAN_BRANCH', 'MAIN-001');
  const database = await createPostgresFixture();
  const dir = mkdtempSync(join(tmpdir(), 'chat-postgres-ui-'));
  const hmacKey = 'chat-postgres-ui-fixture-hmac-key-32-characters';
  const snapshot: JournalSnapshot = { records: [], aliases: [] };
  const importId = randomUUID();
  const digest = journalDigest(hmacKey, snapshot);
  await PostgresJournal.migrate(database.pool);
  await PostgresJournal.importSnapshot(database.pool, hmacKey, snapshot, importId, digest);
  const journal = await PostgresJournal.open(database.pool, hmacKey, importId, digest);
  const profile = loadProfile('meridian');
  const service = new RealInvocationService(journal, profilePolicy(profile), profile, dir,
    ['meridian-member-inquiry'], 'artifacts');
  const create = vi.spyOn(runtime, 'createRuntime').mockImplementation(() => ({
    surface: { mutationDispatched: false, currentUrl: () => 'https://web-sample.interface-hiring.com/signon' },
    promptRedactor: new Redactor(), close: async () => {},
  }) as unknown as ReturnType<typeof runtime.createRuntime>);
  const replay = vi.spyOn(runtime, 'executeReplay').mockResolvedValue({
    status: 'success', outputs: { members: [{ memberNumber: '9001', name: 'Fixture Member' }] },
    runId: 'offline-chat-fixture', evidenceDir: dir, recoveries: [],
  });
  const invoke = vi.spyOn(service, 'invoke');
  const actionArgs = [
    { searchMode: 'number', searchValue: '9001' },
    { searchMode: 'number', searchValue: '9002' },
  ] as const;
  const state = {
    requests: [] as { path: string; method?: string; key?: string; body?: unknown }[],
    toolSchemas: [] as string[][],
    actionToolCalls: 0,
    statusToolCalls: 0,
    actionIndex: 0,
    dropResponse: true,
    responseLossBeforeToolOutput: false,
    responseHadToolInput: false,
    responseWrites: [] as string[],
    deliveredWrites: [] as string[],
  };
  let originalRunId = '';
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'tool-call' as const, toolCallId: 'route', toolName: 'route_request', input: JSON.stringify({ intent: 'invoke' }) }],
      finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage, warnings: [],
    }),
    doStream: async options => {
      const names = Array.isArray(options.tools)
        ? options.tools.map(tool => tool.name)
        : Object.keys(options.tools ?? {});
      state.toolSchemas.push(names);
      if (names.includes('meridian-member-inquiry')) {
        state.actionToolCalls++;
        const args = actionArgs[state.actionIndex++] ?? actionArgs.at(-1)!;
        return {
          stream: simulateReadableStream({ chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: `action-${state.actionToolCalls}`, toolName: 'meridian-member-inquiry', input: JSON.stringify(args) },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage },
          ] }) as ReadableStream<never>,
        };
      }
      if (names.includes('run_status')) {
        state.statusToolCalls++;
        return {
          stream: simulateReadableStream({ chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: `status-${state.statusToolCalls}`, toolName: 'run_status', input: JSON.stringify({ runId: originalRunId }) },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage },
          ] }) as ReadableStream<never>,
        };
      }
      return {
        stream: simulateReadableStream({ chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'text' },
          { type: 'text-delta', id: 'text', delta: 'Please provide a member number.' },
          { type: 'text-end', id: 'text' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
        ] }) as ReadableStream<never>,
      };
    },
  });
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP test server');
  const port = address.port;
  const app = createApp(service, { callerToken, operatorToken, port, chatModel: model });
  server.on('request', (req, res) => {
    const record = { path: req.url!, method: req.method, key: req.headers['idempotency-key'] as string | undefined, body: undefined as unknown };
    state.requests.push(record);
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { if (body) record.body = JSON.parse(body); });
    if (req.url === '/api/chat' && state.dropResponse) {
      const originalWrite = res.write.bind(res);
      let observed = '';
      res.write = ((chunk: unknown, ...args: unknown[]) => {
        const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
        observed += text;
        state.responseWrites.push(text);
        const toolOutput = observed.indexOf('"type":"tool-output-available"');
        if (toolOutput >= 0) {
          state.responseHadToolInput = observed.includes('"type":"tool-input-available"')
            || observed.includes('"type":"tool-input-start"');
          state.dropResponse = false;
          state.responseLossBeforeToolOutput = true;
          res.destroy();
          return false;
        }
        state.deliveredWrites.push(text);
        return (originalWrite as (...writeArgs: unknown[]) => boolean)(chunk, ...args);
      }) as typeof res.write;
    }
    app(req, res);
  });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error' && !message.text().includes('Failed to load resource')) errors.push(message.text());
  });
  await page.route('**/*', route =>
    new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
  );
  const url = `http://127.0.0.1:${port}`;
  try {
    await page.goto(url);
    await page.locator('#credential').fill(callerToken);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.locator('#workspace').waitFor();
    const message = page.getByRole('textbox', { name: 'Your request', exact: true });
    await message.fill('Find member 9001');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByText('Acceptance is unconfirmed.', { exact: false }).waitFor();
    await vi.waitFor(async () => {
      const records = await journal.list();
      expect(records).toHaveLength(1);
      expect(records[0]?.state).toBe('success');
    });
    const firstRecord = (await journal.list())[0]!;
    originalRunId = firstRecord.runId;
    expect(state.responseLossBeforeToolOutput).toBe(true);
    expect(state.responseHadToolInput).toBe(true);
    expect(state.deliveredWrites.join('')).not.toContain('"type":"tool-output-available"');
    const originalKey = state.requests.find(request => request.path === '/api/chat')?.key;
    expect(originalKey).toBeTruthy();

    // While the response is unresolved, chat is forced through the status-only model path.
    await message.fill('Did that finish?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await vi.waitFor(() => expect(state.statusToolCalls).toBe(1));
    expect(state.toolSchemas[1]).toEqual(['run_status']);
    expect(state.actionToolCalls).toBe(1);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(replay).toHaveBeenCalledTimes(1);
    expect((await journal.list())).toHaveLength(1);

    // A direct submit is disabled by the same hold and dispatches no request.
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    await page.getByText('Invoke an approved capability directly', { exact: true }).click();
    const directSubmit = page.getByRole('button', { name: 'Invoke capability', exact: true });
    expect(await directSubmit.isDisabled()).toBe(true);
    const directPostsBefore = state.requests.filter(request => request.path.endsWith('/invoke')).length;
    await page.locator('#invoke').evaluate((form: HTMLFormElement) => form.requestSubmit());
    await page.waitForTimeout(100);
    expect(state.requests.filter(request => request.path.endsWith('/invoke'))).toHaveLength(directPostsBefore);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(replay).toHaveBeenCalledTimes(1);

    await page.getByRole('button', { name: 'Look up original request', exact: true }).click();
    await page.getByText(`The original request was bound to run ${originalRunId}.`, { exact: false }).waitFor();
    const lookup = state.requests.find(request => request.path === '/api/chat/request');
    expect(lookup).toMatchObject({ method: 'GET', key: originalKey });
    expect(lookup?.body).toBeUndefined();
    await page.waitForFunction(() => !document.body.textContent?.includes('Chat messages are status-only while this action request is being confirmed'));

    // Once the exact terminal run and available capability are confirmed, a later action gets a new key/run.
    await message.fill('Find member 9002');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await vi.waitFor(() => expect(state.actionToolCalls).toBe(2));
    await vi.waitFor(async () => expect((await journal.list())).toHaveLength(2));
    const secondRunId = (await journal.list()).find(record => record.runId !== originalRunId)?.runId;
    expect(secondRunId).toBeTruthy();
    await vi.waitFor(async () => expect((await journal.get(secondRunId!))?.state).toBe('success'));
    const actionPosts = state.requests.filter(request => request.path === '/api/chat' && (request.body as { intent?: string } | undefined)?.intent === 'auto');
    expect(actionPosts).toHaveLength(2);
    expect(actionPosts[1]?.key).not.toBe(originalKey);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenCalledTimes(2);
    expect(replay).toHaveBeenCalledTimes(2);

    // Missing/malformed recovery is fixed and model-free; a quarantined local inquiry cannot replay.
    const missing = await fetch(`${url}/api/chat/request`, { headers: { Authorization: `Bearer ${callerToken}`, 'Idempotency-Key': 'missing-chat-key' } });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'No accepted request found' });
    const malformed = await fetch(`${url}/api/chat/request`, { headers: { Authorization: `Bearer ${callerToken}`, 'Idempotency-Key': 'bad key' } });
    expect(malformed.status).toBe(400);
    const unknown = await journal.reserve('caller', 'local-inquiry-unknown', 'meridian-member-inquiry', '1.0.0',
      { searchMode: 'number', searchValue: '9010' }, 'replay', { invocationScope: 'public' });
    await journal.update(unknown.runId, 'dispatching');
    await journal.update(unknown.runId, 'failure');
    const beforeUnknown = { invokes: invoke.mock.calls.length, creates: create.mock.calls.length, replays: replay.mock.calls.length };
    const blocked = await fetch(`${url}/capabilities/meridian-member-inquiry/invoke`, {
      method: 'POST', headers: { Authorization: `Bearer ${callerToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'local-inquiry-fresh' },
      body: JSON.stringify({ args: { searchMode: 'number', searchValue: '9011' } }),
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toEqual({ error: 'This capability has an unknown posting outcome. Use a separate read-only inquiry; do not retry it.', acceptance: 'rejected' });
    expect(await journal.findRequest('caller', 'local-inquiry-fresh')).toBeUndefined();
    expect(invoke).toHaveBeenCalledTimes(beforeUnknown.invokes + 1);
    expect(create).toHaveBeenCalledTimes(beforeUnknown.creates);
    expect(replay).toHaveBeenCalledTimes(beforeUnknown.replays);
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await service.close().catch(() => {});
    await journal.close().catch(() => {});
    await database.close();
    create.mockRestore();
    replay.mockRestore();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
}, 60000);
it('preserves the conversation across responsive Activity navigation', async () => {
  const { page, state, errors } = await fixture(true);
  state.runs.push(initialRun());
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('#workspace').waitFor();
  await page.getByRole('heading', { name: 'How can I help you today?' }).waitFor();
  expect(await page.locator('script[src*="/_next/static/"]').count()).toBeGreaterThan(0);
  const activity = page.getByRole('button', { name: 'Activity', exact: true });
  const message = page.getByRole('textbox', { name: 'Your request', exact: true });
  const messages = page.locator('.messages');
  const back = page.getByRole('button', { name: 'Back to conversation', exact: true });
  const threadRoot = page.locator('.thread-root');
  await activity.click();
  expect(await page.getByRole('heading', { name: 'Capability catalog', exact: true }).isVisible()).toBe(true);
  await page.locator('#runs [data-run-id]').waitFor();
  await activity.click();
  expect(await activity.getAttribute('aria-expanded')).toBe('false');
  await threadRoot.evaluate((node) => {
    (node as HTMLElement & { __unit7Mounted?: boolean }).__unit7Mounted = true;
  });
  await message.fill('Draft survives Activity');
  await page.locator('.conversation').evaluate((node) => {
    (node as HTMLElement).style.minHeight = '1200px';
  });
  const status = page.locator('#runs [role="status"]').first();
  const navigationTargets = /(?:\/api\/chat|\/invoke|\/decision|\/cancel|\/transaction)/;
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await settleConversationLayout(page);
    await messages.evaluate((node) => {
      (node as HTMLElement).scrollTop = 320;
    });
    expect(await messages.evaluate((node) => (node as HTMLElement).scrollTop)).toBe(320);
    expect(await threadRoot.evaluate((node) =>
      (node as HTMLElement & { __unit7Mounted?: boolean }).__unit7Mounted,
    )).toBe(true);
    expect(await message.inputValue()).toBe('Draft survives Activity');
    expect(await status.innerText()).toMatch(/executing|review|complete|progress/i);
    await expectNoHorizontalOverflow(page, '.messages');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const requestsBeforeNavigation = state.requests.length;

    await activity.focus();
    await page.keyboard.press('Enter');
    expect(await page.getByRole('heading', { name: 'Capability catalog', exact: true }).isVisible()).toBe(true);
    await expectNoHorizontalOverflow(page, '.activity-panel');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 320 || width === 1440) {
      await page.screenshot({ path: walkthroughScreenshotPath(`activity-${width}.png`), fullPage: true });
    }
    if (width <= 768) {
      expect(await back.isVisible()).toBe(true);
      expect(await back.evaluate((node) => node === document.activeElement)).toBe(true);
      await page.keyboard.press('Tab');
      const disclosure = page.locator('summary').filter({ hasText: 'Invoke an approved capability directly' });
      expect(await disclosure.evaluate(node => node === document.activeElement)).toBe(true);
      await page.keyboard.press('Shift+Tab');
      expect(await back.evaluate(node => node === document.activeElement)).toBe(true);
      await page.keyboard.press('Enter');
      expect(await activity.getAttribute('aria-expanded')).toBe('false');
      expect(await activity.evaluate((node) => node === document.activeElement)).toBe(true);
    } else {
      expect(await back.isVisible()).toBe(false);
      expect(await page.locator('.chat').isVisible()).toBe(true);
      expect(await page.locator('.activity-panel').isVisible()).toBe(true);
      await activity.focus();
      await page.keyboard.press('Enter');
      expect(await activity.getAttribute('aria-expanded')).toBe('false');
    }
    await page.waitForFunction(() => (document.querySelector('.messages') as HTMLElement | null)?.scrollTop === 320);
    expect(await message.inputValue()).toBe('Draft survives Activity');
    expect(await status.innerText()).toMatch(/executing|review|complete|progress/i);
    expect(await threadRoot.evaluate((node) =>
      (node as HTMLElement & { __unit7Mounted?: boolean }).__unit7Mounted,
    )).toBe(true);
    expect(await messages.evaluate((node) => (node as HTMLElement).scrollTop)).toBe(320);
    const navigationPosts = state.requests.slice(requestsBeforeNavigation).filter(request =>
      request.method === 'POST' && navigationTargets.test(request.path),
    );
    expect(navigationPosts).toEqual([]);
  }
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => (window as any).cspViolations)).toEqual([]);
}, 30000);

it('moves Activity focus with the responsive breakpoint while the panel stays open', async () => {
  const { page, connect, errors } = await fixture();
  await connect();
  const activity = page.getByRole('button', { name: 'Activity', exact: true });
  const back = page.getByRole('button', { name: 'Back to conversation', exact: true });

  await page.setViewportSize({ width: 768, height: 900 });
  await back.waitFor({ state: 'visible' });
  expect(await page.getByRole('heading', { name: 'Capability catalog', exact: true }).isVisible()).toBe(true);
  expect(await back.isVisible()).toBe(true);
  await page.waitForFunction(() => document.activeElement?.textContent?.includes('Back to conversation'));
  expect(await back.evaluate((node) => node === document.activeElement)).toBe(true);

  await page.setViewportSize({ width: 1440, height: 900 });
  await back.waitFor({ state: 'hidden' });
  expect(await back.isVisible()).toBe(false);
  await page.waitForFunction(() => document.activeElement === document.querySelector('.workspace-header button'));
  expect(await activity.evaluate((node) => node === document.activeElement)).toBe(true);

  await page.setViewportSize({ width: 320, height: 900 });
  await back.waitFor({ state: 'visible' });
  expect(await back.isVisible()).toBe(true);
  await page.waitForFunction(() => document.activeElement?.textContent?.includes('Back to conversation'));
  expect(await back.evaluate((node) => node === document.activeElement)).toBe(true);
  expect(errors).toEqual([]);
}, 15000);

it('preserves a newer conversation scroll position when closing wide Activity', async () => {
  const { page, connect, errors } = await fixture();
  await connect();
  await page.setViewportSize({ width: 1440, height: 900 });
  const activity = page.getByRole('button', { name: 'Activity', exact: true });
  const messages = page.locator('.messages');
  await page.locator('.conversation').evaluate((node) => {
    (node as HTMLElement).style.minHeight = '1200px';
  });
  await activity.click();
  await settleConversationLayout(page);
  await messages.evaluate((node) => {
    (node as HTMLElement).scrollTop = 120;
  });
  expect(await messages.evaluate((node) => (node as HTMLElement).scrollTop)).toBe(120);

  await activity.click();
  await messages.evaluate((node) => {
    (node as HTMLElement).scrollTop = 520;
  });
  expect(await messages.evaluate((node) => (node as HTMLElement).scrollTop)).toBe(520);
  await activity.click();
  expect(await messages.evaluate((node) => (node as HTMLElement).scrollTop)).toBe(520);
  expect(errors).toEqual([]);
}, 15000);

it('restores narrow conversation scroll after crossing the breakpoint while Activity stays open', async () => {
  const { page, connect, errors } = await fixture();
  await connect();
  const activity = page.getByRole('button', { name: 'Activity', exact: true });
  const back = page.getByRole('button', { name: 'Back to conversation', exact: true });
  const messages = page.locator('.messages');
  await page.locator('.conversation').evaluate((node) => {
    (node as HTMLElement).style.minHeight = '1200px';
  });

  await page.setViewportSize({ width: 320, height: 900 });
  await back.waitFor({ state: 'visible' });
  await activity.click();
  await settleConversationLayout(page);
  await messages.evaluate((node) => {
    (node as HTMLElement).scrollTop = 180;
  });
  expect(await messages.evaluate((node) => (node as HTMLElement).scrollTop)).toBe(180);
  await activity.click();
  expect(await back.isVisible()).toBe(true);

  await page.setViewportSize({ width: 1440, height: 900 });
  await settleConversationLayout(page);
  expect(await page.locator('.chat').isVisible()).toBe(true);
  await page.setViewportSize({ width: 320, height: 900 });
  await back.waitFor({ state: 'visible' });
  expect(await back.isVisible()).toBe(true);
  await back.click();
  await page.waitForFunction(() => (document.querySelector('.messages') as HTMLElement | null)?.scrollTop === 180);
  expect(await messages.evaluate((node) => (node as HTMLElement).scrollTop)).toBe(180);
  expect(errors).toEqual([]);
}, 15000);

it('retains focus on visible Activity controls across breakpoint changes', async () => {
  const { page, connect, errors } = await fixture();
  await connect();
  const activity = page.getByRole('button', { name: 'Activity', exact: true });
  const back = page.getByRole('button', { name: 'Back to conversation', exact: true });
  const refresh = page.getByRole('button', { name: 'Refresh', exact: true });
  const catalogDisclosure = page.locator('summary').filter({ hasText: 'Invoke an approved capability directly' });
  for (const control of [refresh, catalogDisclosure]) {
    await control.focus();
    await page.setViewportSize({ width: 320, height: 900 });
    await back.waitFor({ state: 'visible' });
    expect(await control.isVisible()).toBe(true);
    expect(await control.evaluate((node) => node === document.activeElement)).toBe(true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await back.waitFor({ state: 'hidden' });
    expect(await control.isVisible()).toBe(true);
    expect(await control.evaluate((node) => node === document.activeElement)).toBe(true);
  }

  await page.setViewportSize({ width: 320, height: 900 });
  await back.waitFor({ state: 'visible' });
  await back.focus();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForFunction(() => document.activeElement === document.querySelector('.workspace-header button'));
  expect(await activity.evaluate((node) => node === document.activeElement)).toBe(true);

  await activity.focus();
  await page.setViewportSize({ width: 320, height: 900 });
  await page.waitForFunction(() => document.activeElement?.textContent?.includes('Back to conversation'));
  expect(await back.evaluate((node) => node === document.activeElement)).toBe(true);
  expect(errors).toEqual([]);
}, 15000);

it('restores the latest scroll after wide Activity becomes narrow before closing', async () => {
  const { page, connect, errors } = await fixture();
  await connect();
  const activity = page.getByRole('button', { name: 'Activity', exact: true });
  const back = page.getByRole('button', { name: 'Back to conversation', exact: true });
  const messages = page.locator('.messages');
  await page.locator('.conversation').evaluate((node) => {
    (node as HTMLElement).style.minHeight = '1200px';
  });

  await page.setViewportSize({ width: 320, height: 900 });
  await back.waitFor({ state: 'visible' });
  await activity.click();
  await settleConversationLayout(page);
  await messages.evaluate((node) => {
    (node as HTMLElement).scrollTop = 180;
  });
  await activity.click();
  expect(await back.isVisible()).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
  await settleConversationLayout(page);
  await messages.evaluate((node) => {
    (node as HTMLElement).scrollTop = 520;
  });
  expect(await messages.evaluate((node) => (node as HTMLElement).scrollTop)).toBe(520);
  await page.setViewportSize({ width: 320, height: 900 });
  await back.waitFor({ state: 'visible' });
  // A queued viewport event must still observe the retained reading position while chat is visually hidden.
  expect(await page.locator('.chat').isVisible()).toBe(false);
  expect(await messages.evaluate(node => node.scrollTop)).toBe(520);
  await messages.evaluate(node => node.dispatchEvent(new Event('scroll')));
  await back.click();
  await page.waitForFunction(() => (document.querySelector('.messages') as HTMLElement | null)?.scrollTop === 520);
  expect(await messages.evaluate((node) => (node as HTMLElement).scrollTop)).toBe(520);
  await settleConversationLayout(page);
  // Later streamed content must not resume following the bottom after Activity hides a scrolled-up conversation.
  await page.locator('.conversation').evaluate((node) => {
    (node as HTMLElement).style.minHeight = '1202px';
  });
  await settleConversationLayout(page);
  expect(await messages.evaluate((node) => (node as HTMLElement).scrollTop)).toBe(520);
  expect(errors).toEqual([]);
}, 15000);

it.skipIf(process.env.MERIDIAN_NATIVE_ZOOM !== '1')('actual Chromium browser zoom at 200%', async () => {
  const { page, state, connect, errors, nativeDisplay } = await fixture(false, undefined, { nativeZoom200: true });
  state.runs.push(initialRun());
  await connect();
  const metrics = await page.evaluate(() => ({
    devicePixelRatio,
    visualViewportScale: visualViewport?.scale ?? null,
    innerWidth,
    innerHeight,
    outerWidth,
    outerHeight,
    documentWidth: document.documentElement.scrollWidth,
  }));
  console.info(`[native-zoom] ${JSON.stringify(metrics)}`);
  expect(metrics.devicePixelRatio).toBe(2);
  expect(metrics.visualViewportScale).toBe(1);
  expect(metrics.innerWidth).toBe(720);
  expect(metrics.documentWidth).toBeLessThanOrEqual(metrics.innerWidth);
  expect(metrics.outerWidth).toBe(1440);
  expect(metrics.outerHeight).toBe(900);
  expect(nativeDisplay?.display).toMatch(/^:\d+$/);
  const catalogHeading = page.getByRole('heading', { name: 'Capability catalog', exact: true });
  await catalogHeading.waitFor();
  const catalogBounds = await catalogHeading.boundingBox();
  expect(catalogBounds).not.toBeNull();
  expect(catalogBounds!.x + catalogBounds!.width).toBeLessThanOrEqual(metrics.innerWidth);
  const catalogOverflow = await catalogHeading.evaluate((node) => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
  }));
  expect(catalogOverflow.scrollWidth).toBeLessThanOrEqual(catalogOverflow.clientWidth);
  const activity = page.getByRole('button', { name: 'Activity', exact: true });
  const back = page.getByRole('button', { name: 'Back to conversation', exact: true });
  const message = page.getByRole('textbox', { name: 'Your request', exact: true });
  const status = page.locator('#runs [role="status"]').first();
  expect(await back.isVisible()).toBe(true);
  await back.focus();
  await page.keyboard.press('Enter');
  await message.fill('Native zoom draft survives Activity');
  expect(await status.innerText()).toMatch(/executing|review|complete|progress/i);
  const requestsBeforeNavigation = state.requests.length;
  await activity.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('heading', { name: 'Capability catalog', exact: true }).waitFor();
  expect(await back.isVisible()).toBe(true);
  expect(await back.evaluate((node) => node === document.activeElement)).toBe(true);
  await expectKeyboardVisibleFocus(back);
  const nativeScreenshotPath = walkthroughScreenshotPath('native-zoom-200.png');
  await page.waitForTimeout(250);
  await captureNativeDisplay(nativeDisplay!, nativeScreenshotPath);
  const nativeScreenshot = readFileSync(nativeScreenshotPath);
  expect({
    width: nativeScreenshot.readUInt32BE(16),
    height: nativeScreenshot.readUInt32BE(20),
  }).toEqual({ width: 1440, height: 900 });
  await page.keyboard.press('Enter');
  expect(await message.inputValue()).toBe('Native zoom draft survives Activity');
  expect(await status.innerText()).toMatch(/executing|review|complete|progress/i);
  const navigationPosts = state.requests.slice(requestsBeforeNavigation).filter(request =>
    request.method === 'POST' && /(?:\/api\/chat|\/invoke|\/decision|\/cancel|\/transaction)/.test(request.path),
  );
  expect(navigationPosts).toEqual([]);
  expect(errors).toEqual([]);
}, 30000);

it('connects a local teller without input and exposes supervisor sign-on fields', async () => {
  const { page, errors } = await fixture(true);
  const role = page.getByLabel('Role', { exact: true });
  await role.waitFor();
  expect(await role.inputValue()).toBe('teller');
  expect(await page.locator('#credential').count()).toBe(0);
  await role.focus();
  await page.keyboard.press('Tab');
  expect(await page.getByLabel('Branch', { exact: true }).evaluate(el => el === document.activeElement)).toBe(true);
  await page.keyboard.press('Tab');
  expect(await page.getByRole('button', { name: 'Connect', exact: true }).evaluate(el => el === document.activeElement)).toBe(true);
  await page.keyboard.press('Enter');
  await visible(page, '#status', 'Connected as caller');
  expect(await page.locator('#operator').count()).toBe(0);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await role.selectOption('operator');
  expect(await page.locator('#workspace').count()).toBe(0);
  const operator = page.getByLabel('Operator', { exact: true });
  const password = page.getByLabel('Password', { exact: true });
  expect(await operator.inputValue()).toBe('');
  expect(await password.inputValue()).toBe('');
  expect(await page.locator('#credential').count()).toBe(0);
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await role.isVisible()).toBe(true);
    expect(await page.locator('#login').evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  }
  expect(errors.filter(error => !error.includes('Failed to load resource'))).toEqual([]);
}, 15000);

it.each(['MAIN-001', 'WEST-014', 'EAST-022'])('Connect signs on at selected branch %s before opening chat', async branch => {
  const { page, service, state, errors } = await fixture(true);
  service.catalog = () => [{ ...capability, id: 'meridian-sign-on', parameters: [] }];
  await page.getByLabel('Role', { exact: true }).waitFor();
  const dropdown = page.getByLabel('Branch', { exact: true });
  expect(await dropdown.locator('option').allTextContents()).toEqual(['MAIN-001 - Main Office', 'WEST-014 - Westside', 'EAST-022 - Eastgate']);
  await dropdown.selectOption(branch);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  expect(await dropdown.inputValue()).toBe(branch);
  expect(await dropdown.isDisabled()).toBe(true);
  await vi.waitFor(() => expect(service.invoke).toHaveBeenCalledTimes(1));
  state.runs[0]!.capability = 'meridian-sign-on';
  await visible(page, '#status', 'Signing in to Meridian');
  expect(await page.locator('#workspace').count()).toBe(0);
  expect(await page.getByRole('button', { name: 'Connecting…', exact: true }).isDisabled()).toBe(true);
  expect(service.invoke.mock.calls[0]?.slice(0, 3)).toEqual(['caller', 'meridian-sign-on', {}]);
  expect(service.invoke.mock.calls[0]?.[4]).toBe('TELLER');
  Object.assign(state.runs[0]!, { state: 'success', result: {
    status: 'success', outputs: { operator: 'TELLER1', role: 'TELLER', branch },
  } });
  await visible(page, '#status', `Signed in as TELLER1 · TELLER · Branch ${branch}`);
  await page.locator('#workspace').waitFor();
  await page.getByText(`Selected branch: ${branch}`, { exact: true }).waitFor();
  expect(state.requests.find(request => request.path === '/session/teller')?.body).toEqual({ branch });
  expect(service.invoke).toHaveBeenCalledTimes(1);
  expect(state.requests.filter(request => request.path === '/api/chat')).toHaveLength(0);
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
  expect(errors).toEqual([]);
}, 15000);

it.each(['failure', 'wrong-role', 'wrong-branch', 'cancel'] as const)('Connect does not open chat after sign-on %s', async outcome => {
  const { page, service, state } = await fixture(true);
  service.catalog = () => [{ ...capability, id: 'meridian-sign-on', parameters: [] }];
  // Hold the authoritative read until the test sets the terminal outcome.
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/runs/' + runId, async route => { await waiting; await route.continue(); });
  await page.getByLabel('Role', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await vi.waitFor(() => expect(service.invoke).toHaveBeenCalledTimes(1));
  Object.assign(state.runs[0]!, { capability: 'meridian-sign-on', state: outcome === 'failure' ? 'failure' : 'success',
    result: { status: 'success', outputs: { operator: 'TELLER1', role: outcome === 'wrong-role' ? 'SUPERVISOR' : 'TELLER', branch: 'OTHER' } } });
  if (outcome === 'cancel') await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  release();
  await visible(page, '#status', outcome === 'cancel' ? 'Disconnected' : outcome === 'failure' ? 'Sign-on did not complete' : 'Sign-on did not confirm');
  expect(await page.locator('#workspace').count()).toBe(0);
  expect(service.invoke).toHaveBeenCalledTimes(1);
}, 15000);

it('connects a local supervisor using operator and password, clearing the password after submit', async () => {
  vi.stubEnv('MERIDIAN_SUPERVISOR_OPERATOR', 'SUPER1');
  vi.stubEnv('MERIDIAN_SUPERVISOR_PASSWORD', 'offline-supervisor-password');
  vi.stubEnv('MERIDIAN_BRANCH', 'MAIN');
  try {
    const { page, service, state, errors } = await fixture(true);
    const role = page.getByLabel('Role', { exact: true });
    await role.waitFor();
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await visible(page, '#status', 'Connected as caller');
    expect(await page.locator('#login').isHidden()).toBe(true);
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    expect(await page.locator('#login').isVisible()).toBe(true);
    await role.selectOption('operator');
    expect(await page.locator('#credential').count()).toBe(0);
    const operator = page.getByLabel('Operator', { exact: true });
    const password = page.getByLabel('Password', { exact: true });
    expect(await operator.inputValue()).toBe('');
    await operator.fill('SUPER1');
    await password.fill('wrong-password');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await visible(page, '#status', 'Check operator and password');
    expect(await password.inputValue()).toBe('');
    expect(await page.locator('#workspace').count()).toBe(0);
    expect(service.invoke).not.toHaveBeenCalled();
    await page.waitForTimeout(1100); // Local login throttle intentionally covers failed attempts.
    await operator.fill('SUPER1');
    await password.fill('offline-supervisor-password');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await vi.waitFor(() => expect(service.invoke).toHaveBeenCalledTimes(1));
    expect(await password.inputValue()).toBe('');
    expect(await page.locator('#workspace').count()).toBe(0);
    Object.assign(state.runs[0]!, { capability: 'meridian-sign-on', state: 'success', result: {
      status: 'success', outputs: { operator: 'SUPER1', role: 'SUPERVISOR', branch: 'MAIN' },
    } });
    await visible(page, '#status', 'Signed in as SUPER1 · SUPERVISOR · Branch MAIN');
    expect(await page.locator('#login').isHidden()).toBe(true);
    const disconnect = page.getByRole('button', { name: 'Disconnect', exact: true });
    expect(await disconnect.count()).toBe(1);
    await page.locator('#workspace').waitFor();
    expect(state.requests.filter(request => request.path === '/api/chat')).toHaveLength(0);
    expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
    expect(errors).toEqual([]);
    for (const width of [320, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      const button = await disconnect.boundingBox();
      const section = await page.locator('.session').boundingBox();
      expect(button!.height).toBeGreaterThanOrEqual(64);
      expect(button!.width).toBeCloseTo(section!.width, 0);
    }
  } finally { vi.unstubAllEnvs(); }
}, 15000);
it('shows linked identity only for the exact balance in this login, hides stale names, and never invokes on render', async () => {
  const { page, state, connect, service, errors } = await fixture();
  const verified = { status: 'verified', memberNumber: 'offline-member', name: `Verified ${hostile}`, inquiryRunId: approvalId };
  state.runs.push({ ...initialRun(), runId: approvalId, state: 'success', inputs: { member: 'offline-member' },
    memberIdentity: { ...verified, name: 'Previous session name' }, result: { status: 'success', outputs: { balance: '50.00' } } });
  await connect();
  await visible(page, '#runs', 'Member identity unavailable.');
  expect(await page.locator('#runs').innerText()).not.toContain('Previous session name');
  await page.locator('#message').fill('Read offline-member shares');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#messages [data-run-id]').waitFor();
  const run = state.runs.find(r => r.runId === runId)!;
  Object.assign(run, { state: 'success', inputs: { member: 'offline-member' }, sensitiveValuesUnavailable: false,
    memberIdentity: { status: 'pending', inquiryRunId: approvalId },
    result: { status: 'success', outputs: { shares: [{ balance: '1200.10' }] } } });
  await visible(page, '#messages [data-run-id]', 'Verifying member identity');
  run.memberIdentity = verified;
  await visible(page, '#messages [data-run-id]', verified.name);
  expect(await page.locator('#messages [aria-label="Member identity"]').innerText()).toContain('Member offline-member');
  expect(await page.locator('#messages img').count()).toBe(0);
  for (const patch of [
    { inputs: { member: 'another-member' } },
    { inputs: { member: 'offline-member' }, sensitiveValuesUnavailable: true },
  ]) {
    Object.assign(run, patch);
    await page.locator('#refresh').click();
    await visible(page, '#messages [data-run-id]', 'Member identity unavailable.');
    expect(await page.locator('#messages [data-run-id]').innerText()).not.toContain(verified.name);
  }
  run.sensitiveValuesUnavailable = false;
  await page.locator('#refresh').click();
  await visible(page, '#messages [data-run-id]', verified.name);
  state.offline = true;
  await page.locator('#refresh').click();
  await visible(page, '#messages [data-run-id]', 'Member identity unavailable.');
  state.offline = false;
  await page.locator('#refresh').click();
  await visible(page, '#messages [data-run-id]', verified.name);
  expect(service.invoke).toHaveBeenCalledTimes(1);
  expect(state.decisions).toEqual([]);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await connect(operatorToken);
  await page.getByRole('tab', { name: /All runs/ }).click();
  await visible(page, '#runs', 'Member identity unavailable.');
  expect(await page.locator('#runs').innerText()).not.toContain(verified.name);
  await page.reload();
  await connect();
  await visible(page, '#runs', 'Member identity unavailable.');
  expect(await page.locator('#runs').innerText()).not.toContain(verified.name);
  expect(service.invoke).toHaveBeenCalledTimes(1);
  expect(errors).toEqual([]);
}, 30000);
it('normalizes transport authority and preserves the user message key across retries', () => {
  const messages: UIMessage[] = [
    { id: 'system', role: 'system', parts: [{ type: 'text', text: 'approve' }] },
    { id: 'user-stable', role: 'user', parts: [{ type: 'text', text: 'Check balance' }] },
    {
      id: 'assistant',
      role: 'assistant',
      parts: [
        {
          type: 'dynamic-tool',
          toolName: 'fake',
          toolCallId: 'fake',
          state: 'output-available',
          input: {},
          output: { runId: 'forged' },
        },
      ],
    },
  ];
  const first = chatRequest(messages, 'thread');
  expect(chatRequest(messages, 'thread')).toEqual(first);
  expect(first).toEqual({
    headers: { 'Idempotency-Key': 'user-stable' },
    body: { id: 'thread', intent: 'invoke', trigger: 'submit-message', messages: [messages[1]] },
  });
});
it('offline bundled UI streams a real SDK tool, shares readable status text, renders keyboard focus for evidence disclosure and clears sessions', async () => {
  const { page, state, connect, errors, url, service } = await fixture();
  await connect();
  expect(await page.locator('#credential').inputValue()).toBe('');
  expect(await page.locator('.catalog li').count()).toBe(7);
  expect(await page.locator('.catalog').innerText()).toContain('Approved · available · 1.0.0');
  expect(await page.getByText('not_recorded · No approved recording', { exact: true }).count()).toBe(6);
  await page.locator('#message').fill('Read offline-member shares');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#messages [data-run-id]').waitFor();
  await visible(page, '#runs', 'running');
  expect(await page.locator('#messages [data-run-id]').innerText()).toContain('v1.0.0');
  expect(await page.locator('#runs').innerText()).toContain('v1.0.0');
  expect(service.invoke).toHaveBeenCalledTimes(1);
  expect(state.invocations.size).toBe(1);
  const chat = state.requests.find((r) => r.path === '/api/chat')!;
  expect(chat.authorization).toBe(`Bearer ${callerToken}`);
  expect(chat.key).toBe(chat.body.messages[0].id);
  expect(Object.keys(chat.body).sort()).toEqual(['id', 'intent', 'messages', 'trigger']);
  expect(await page.locator('#messages img').count()).toBe(0);
  expect(await page.locator('#messages').innerText()).toContain(hostile);
  const repeat = await page.evaluate(
    async ({ body, key, token }) =>
      (
        await fetch('/api/chat', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Idempotency-Key': key,
          },
          body: JSON.stringify(body),
        })
      ).text(),
    { body: chat.body, key: chat.key!, token: callerToken },
  );
  expect(repeat).toContain(runId);
  expect(state.invocations.size).toBe(1);
  Object.assign(state.runs[0]!, {
    state: 'success',
    elapsedMs: 2476,
    result: {
      status: 'success',
      outputs: {
        balance: '1200.10',
        shares: [{ shareId: 'offline-share', balance: '1200.10', status: hostile }],
      },
    },
  });
  await visible(page, '#messages [data-run-id]', '$1,200.10');
  await visible(page, '#runs', '$1,200.10');
  expect(await page.locator('#messages [data-run-id]').getAttribute('data-run-id')).toBe(
    await page.locator('#runs [data-run-id]').getAttribute('data-run-id'),
  );
  const runStatus = page.locator('#runs [data-run-id] .badge[role="status"]');
  // Production break caught: replacing the human-readable state label with a class or color would hide progress from assistive technology.
  expect(await runStatus.innerText()).toMatch(/In progress|Awaiting review|Completed|Run stopped/);
  const evidenceDisclosure = page.getByText('Run details and evidence', { exact: true }).first();
  await page.locator('#runs [data-run-id] .table-scroll').focus();
  await page.keyboard.press('Tab');
  // Production break caught: removing the evidence disclosure from the sequential Tab order would strand keyboard users before its controls.
  expect(await evidenceDisclosure.evaluate(element => element === document.activeElement)).toBe(true);
  // Production break caught: overriding :focus-visible would make the evidence disclosure invisible to keyboard users.
  await expectKeyboardVisibleFocus(evidenceDisclosure);
  await evidenceDisclosure.click();
  await evidenceDisclosure.focus();
  const resultEvidence = page.getByRole('button', { name: 'View result.json', exact: true });
  await resultEvidence.waitFor();
  let resultEvidenceFocused = false;
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press('Tab');
    if (await resultEvidence.evaluate(element => element === document.activeElement)) {
      resultEvidenceFocused = true;
      break;
    }
  }
  expect(resultEvidenceFocused).toBe(true);
  // Production break caught: removing a keyboard-visible indicator from evidence controls would fail this computed-style assertion.
  await expectKeyboardVisibleFocus(resultEvidence);
  await resultEvidence.click();
  await visible(page, '.evidence pre', hostile);
  expect(state.requests.find((r) => r.path.endsWith('/evidence/result.json'))?.authorization).toBe(
    `Bearer ${callerToken}`,
  );
  expect((await fetch(`${url}/runs/${runId}/evidence/result.json`)).status).toBe(401);
  await page.getByRole('button', { name: 'View log.jsonl', exact: true }).click();
  await visible(page, '.evidence pre', 'action.end');
  expect(await page.getByRole('list', { name: 'Recorded events' }).count()).toBe(1);
  await page.evaluate(() => {
    const revoke = URL.revokeObjectURL;
    (window as any).revocations = 0;
    URL.revokeObjectURL = (value) => {
      (window as any).revocations++;
      revoke(value);
    };
  });
  await page.getByRole('button', { name: 'View masked.png', exact: true }).click();
  await page.locator('.evidence img').waitFor();
  await page.getByRole('button', { name: 'View result.json', exact: true }).click();
  await visible(page, '.evidence pre', hostile);
  expect(await page.evaluate(() => (window as any).revocations)).toBe(1);
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: join(evidencePath, `offline-${width}.png`), fullPage: true });
  }
  await page.locator('#refresh').focus();
  expect(await page.locator('#refresh').evaluate((e) => e === document.activeElement)).toBe(true);
  const before = state.requests.filter((r) => r.path === '/runs').length;
  await page.keyboard.press('Enter');
  await vi.waitFor(() =>
    expect(state.requests.filter((r) => r.path === '/runs').length).toBeGreaterThan(before),
  );
  await page.locator('#message').fill('Keyboard draft');
  await page.locator('#message').focus();
  await page.keyboard.press('Tab');
  expect(
    await page
      .getByRole('button', { name: 'Send', exact: true })
      .evaluate((e) => e === document.activeElement),
  ).toBe(true);
  state.offline = true;
  await page.locator('#refresh').click();
  await visible(page, '#workspace', 'Disconnected from run updates');
  state.offline = false;
  await page.locator('#refresh').click();
  await page.waitForFunction(
    () => !document.querySelector('#workspace')?.textContent?.includes('Disconnected from run updates'),
  );
  expect(state.invocations.size).toBe(1);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  expect(await page.locator('#workspace').count()).toBe(0);
  await connect();
  expect(await page.locator('#messages').innerText()).not.toContain('Read offline-member shares');
  await visible(page, '#runs', runId);
  await page.reload();
  expect(await page.locator('#workspace').count()).toBe(0);
  expect(await page.locator('#credential').inputValue()).toBe('');
  expect(await page.evaluate(() => (window as any).cspViolations)).toEqual([]);
  expect(errors).toEqual([]);
}, 30000);
it('reconciles a clean tool-bearing chat stream with its exact key before readiness clears the hold', async () => {
  const { page, state, service, connect } = await fixture();
  let lookupMethod = '';
  let lookupKey = '';
  let lookupBody: string | null = null;
  await page.route('**/api/chat/request', async route => {
    lookupMethod = route.request().method();
    lookupKey = route.request().headers()['idempotency-key'] ?? '';
    lookupBody = route.request().postData();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ kind: 'run', runId, capability: capability.id, state: 'running' }),
    });
  });
  await connect();
  await page.locator('#message').fill('Read offline-member shares');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#messages [data-run-id]').first().waitFor();
  await vi.waitFor(() => expect(lookupKey).toBeTruthy());

  const chat = state.requests.find(request => request.path === '/api/chat');
  expect(chat?.method).toBe('POST');
  expect(chat?.key).toBe(lookupKey);
  expect(chat?.body.intent).toBe('auto');
  expect(lookupMethod).toBe('GET');
  expect(lookupBody).toBeNull();
  expect(state.invocations.size).toBe(1);
  expect(await page.getByText(`The original request was bound to run ${runId}.`, { exact: false }).count()).toBe(1);

  await page.getByText('Invoke an approved capability directly', { exact: true }).click();
  const invoke = page.getByRole('button', { name: 'Invoke capability', exact: true });
  expect(await invoke.isDisabled()).toBe(true);
  expect(state.requests.filter(request => request.path.endsWith('/invoke'))).toHaveLength(0);

  state.runs[0]!.state = 'success';
  service.availability = () => fixtureAvailability('available');
  await page.locator('#refresh').click();
  await vi.waitFor(async () => expect(await invoke.isDisabled()).toBe(false));
  expect(state.invocations.size).toBe(1);
}, 30000);
const malformedLookupCases: Array<[string, unknown]> = [
  ['extra fields', { kind: 'run', runId, capability: capability.id, state: 'running', args: { member: 'offline-member' } }],
  ['whitespace capability', { kind: 'run', runId, capability: ' ', state: 'running' }],
  ['unknown state', { kind: 'run', runId, capability: capability.id, state: 'invented' }],
  ['nested binding', { kind: 'run', runId, capability: { id: capability.id }, state: 'running' }],
  ['null body', null],
];
it.each(malformedLookupCases)('keeps an uncertain hold for %s lookup responses', async (_label, payload) => {
  const { page, state, service, connect } = await fixture();
  await page.route('**/api/chat', async route => {
    const key = route.request().headers()['idempotency-key'] ?? '';
    service.invoke('caller', capability.id, { member: 'offline-member' }, key);
    await route.abort();
    await page.unroute('**/api/chat');
  });
  await page.route('**/api/chat/request', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await connect();
  await page.locator('#message').fill('Read offline-member shares');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Look up original request', exact: true }).click();
  await page.getByText('Lookup returned an invalid run binding.', { exact: false }).waitFor();
  expect(state.invocations.size).toBe(1);
  await page.getByText('Invoke an approved capability directly', { exact: true }).click();
  expect(await page.getByRole('button', { name: 'Invoke capability', exact: true }).isDisabled()).toBe(true);
}, 30000);

it('keeps a valid lookup binding held when cached run capability disagrees', async () => {
  const { page, state, service, connect } = await fixture();
  const mismatch = 'meridian-member-inquiry';
  await page.route('**/api/chat', async route => {
    const key = route.request().headers()['idempotency-key'] ?? '';
    service.invoke('caller', capability.id, { member: 'offline-member' }, key);
    await route.abort();
    await page.unroute('**/api/chat');
  });
  await page.route('**/api/chat/request', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ kind: 'run', runId, capability: mismatch, state: 'success' }),
  }));
  await connect();
  await page.locator('#message').fill('Read offline-member shares');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Look up original request', exact: true }).click();
  await page.getByText(`The original request was bound to run ${runId}.`, { exact: false }).waitFor();
  state.runs[0]!.state = 'success';
  state.runs[0]!.memberIdentity = { status: 'verified', memberNumber: 'offline-member' };
  service.availability = () => fixtureAvailability('available');
  await page.locator('#refresh').click();
  await page.getByText('Invoke an approved capability directly', { exact: true }).click();
  expect(await page.getByRole('button', { name: 'Invoke capability', exact: true }).isDisabled()).toBe(true);
  expect(state.invocations.size).toBe(1);
}, 30000);
const nonCleanFinishCases: Array<[string, string, boolean]> = [
  ['length', 'length', false],
  ['error', 'error', false],
  ['content-filter', 'content-filter', false],
  ['other', 'other', false],
  ['missing reason', 'stop', false],
  ['tool with length', 'length', true],
  ['stop with action tool', 'stop', true],
  ['tool-calls without a tool', 'tool-calls', false],
];
it.each(nonCleanFinishCases)('keeps the action hold uncertain for %s finish responses', async (_label, reason, withTool) => {
  const { page, state, connect } = await fixture();
  state.finishReason = reason;
  state.noTool = !withTool;
  if (reason === 'stop' && !withTool) state.omitFinishReason = true;
  let lookupCount = 0;
  await page.route('**/api/chat/request', async route => {
    lookupCount += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ kind: 'run', runId, capability: capability.id, state: 'running' }),
    });
  });
  await connect();
  await page.locator('#message').fill('Read offline-member shares');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Acceptance is unconfirmed. The original request may still run or may have completed.', { exact: false }).waitFor();
  expect(lookupCount).toBe(0);
  expect(state.invocations.size).toBe(withTool && reason === 'stop' ? 1 : 0);
  if (withTool) expect(state.toolSchemas.at(-1)).toContain(capability.id);
  await page.getByText('Invoke an approved capability directly', { exact: true }).click();
  expect(await page.getByRole('button', { name: 'Invoke capability', exact: true }).isDisabled()).toBe(true);
}, 30000);

it('settles a run_status-only auto response without a lookup after the prior action clears', async () => {
  const { page, state, service, connect } = await fixture();
  const lookupKeys: string[] = [];
  await page.route('**/api/chat/request', async route => {
    lookupKeys.push(route.request().headers()['idempotency-key'] ?? '');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ kind: 'run', runId, capability: capability.id, state: 'running' }),
    });
  });
  await connect();
  await page.locator('#message').fill('Read offline-member shares');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#messages [data-run-id]').first().waitFor();
  await vi.waitFor(() => expect(lookupKeys).toHaveLength(1));
  const originalKey = lookupKeys[0];
  state.runs[0]!.state = 'success';
  service.availability = () => fixtureAvailability('available');
  await page.locator('#refresh').click();
  await page.getByText('Invoke an approved capability directly', { exact: true }).click();
  const admitted = page.getByRole('button', { name: 'Invoke capability', exact: true });
  await vi.waitFor(async () => expect(await admitted.isDisabled()).toBe(false));

  await page.locator('#message').fill('Did that finish?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await vi.waitFor(() => expect(state.requests.filter(request => request.path === '/api/chat')).toHaveLength(2));
  expect(lookupKeys).toEqual([originalKey]);
  const statusChat = state.requests.filter(request => request.path === '/api/chat').at(-1);
  expect(statusChat?.body.intent).toBe('auto');
  expect(state.toolSchemas.at(-1)).toContain('run_status');
  expect(state.toolSchemas.at(-1)).not.toContain(capability.id);
  expect(state.invocations.size).toBe(1);
  await page.getByText('Using a previously accepted run. No new operation was started.', { exact: true }).last().waitFor();
  expect(lookupKeys).toEqual([originalKey]);

  await page.locator('#fields input').fill('new-member');
  await admitted.click();
  await vi.waitFor(() => expect(state.invocations.size).toBe(2));
}, 30000);
it('keeps a no-tool stop hold active until a later reader error', async () => {
  const { page, state, connect } = await fixture();
  state.noTool = true;
  state.finishReason = 'stop';
  state.postFinishMode = 'error';
  let lookupCount = 0;
  await page.route('**/api/chat/request', async route => {
    lookupCount += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ kind: 'run', runId, capability: capability.id, state: 'success' }) });
  });
  await connect();
  await page.locator('#message').fill('Read offline-member shares');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await vi.waitFor(() => expect(state.postFinishRelease).toBeTypeOf('function'));
  expect(await page.getByRole('button', { name: 'Start a separate request', exact: true }).count()).toBe(0);
  state.postFinishRelease?.();
  await page.getByText('Acceptance is unconfirmed. The original request may still run or may have completed.', { exact: false }).waitFor();
  expect(lookupCount).toBe(0);
  await page.getByText('Invoke an approved capability directly', { exact: true }).click();
  expect(await page.getByRole('button', { name: 'Invoke capability', exact: true }).isDisabled()).toBe(true);
}, 30000);

it('keeps an action-tool tool-calls hold through finish until transport cancellation', async () => {
  const { page, state, connect } = await fixture();
  state.postFinishMode = 'open';
  let lookupCount = 0;
  await page.route('**/api/chat/request', async route => {
    lookupCount += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ kind: 'run', runId, capability: capability.id, state: 'running' }) });
  });
  await connect();
  await page.locator('#message').fill('Read offline-member shares');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await vi.waitFor(() => expect(state.postFinishRelease).toBeTypeOf('function'));
  expect(state.toolSchemas.at(-1)).toContain(capability.id);
  expect(await page.getByRole('button', { name: 'Start a separate request', exact: true }).count()).toBe(0);
  await page.getByRole('button', { name: 'Stop response', exact: true }).click();
  await page.getByText('Acceptance is unconfirmed. The original request may still run or may have completed.', { exact: false }).waitFor();
  expect(lookupCount).toBe(0);
  expect(state.invocations.size).toBe(1);
  await page.getByText('Invoke an approved capability directly', { exact: true }).click();
  expect(await page.getByRole('button', { name: 'Invoke capability', exact: true }).isDisabled()).toBe(true);
}, 30000);

it('releases the hold after a prepare-only turn and starts the run on the confirmed facts', async () => {
  const { page, state, connect } = await fixture(false, undefined, { capabilityId: 'meridian-funds-transfer' });
  const transferFacts = { member: '102777', sourceShare: '102777-MMKT-47', destinationShare: '102777-S0001-48', amount: '1.00', memo: 'demo' };
  state.actionToolName = 'prepare_funds_transfer';
  state.actionToolInput = transferFacts;
  await page.route('**/api/chat/request', async route => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ kind: 'run', runId, capability: 'meridian-funds-transfer', state: 'running' }) });
  });
  await connect();
  await page.locator('#message').fill('Transfer for member 102777');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Funds Transfer prepared', { exact: false }).waitFor();
  expect(await page.getByText('Acceptance is unconfirmed', { exact: false }).count()).toBe(0);
  expect(await page.getByRole('button', { name: 'Look up original request', exact: true }).count()).toBe(0);
  expect(state.toolSchemas.at(-1)).toContain('prepare_funds_transfer');
  expect(state.invocations.size).toBe(0);

  state.actionToolName = 'meridian-funds-transfer';
  state.actionToolInput = transferFacts;
  await page.locator('#message').fill('confirm');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('The original request was bound to run', { exact: false }).waitFor();
  expect(state.invocations.size).toBe(1);
  const chats = state.requests.filter(request => request.path === '/api/chat');
  expect(chats).toHaveLength(2);
  expect(chats[0]?.body.intent).toBe('auto');
  expect(chats[1]?.body.intent).toBe('auto');
  expect(state.toolSchemas.at(-1)).toContain('meridian-funds-transfer');
}, 30000);

it.each(['error-chunk', 'second-finish'] as const)('keeps a no-tool stop hold for a %s after-finish stream', async mode => {
  const { page, state, connect } = await fixture();
  state.noTool = true;
  state.finishReason = 'stop';
  state.postFinishMode = mode;
  let lookupCount = 0;
  await page.route('**/api/chat/request', async route => {
    lookupCount += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ kind: 'run', runId, capability: capability.id, state: 'success' }) });
  });
  await connect();
  await page.locator('#message').fill('Read offline-member shares');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await vi.waitFor(() => expect(state.postFinishRelease).toBeTypeOf('function'));
  expect(await page.getByRole('button', { name: 'Start a separate request', exact: true }).count()).toBe(0);
  state.postFinishRelease?.();
  await page.getByText('Acceptance is unconfirmed. The original request may still run or may have completed.', { exact: false }).waitFor();
  expect(lookupCount).toBe(0);
  await page.getByText('Invoke an approved capability directly', { exact: true }).click();
  expect(await page.getByRole('button', { name: 'Invoke capability', exact: true }).isDisabled()).toBe(true);
}, 30000);
it('holds a lost chat action across status-only chat and direct submission until exact lookup or abandonment', async () => {
  const { page, state, service, connect } = await fixture();
  let originalKey = '';
  await page.route('**/api/chat', async route => {
    originalKey = route.request().headers()['idempotency-key'] ?? '';
    service.invoke('caller', capability.id, { member: 'offline-member' }, originalKey);
    state.runs[0]!.state = 'success';
    service.availability = () => fixtureAvailability('available');
    await route.abort();
    await page.unroute('**/api/chat');
  });
  await connect();
  await page.locator('#message').fill('Read offline-member shares');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Acceptance is unconfirmed. The original request may still run or may have completed.', { exact: false }).waitFor();
  expect(state.invocations.size).toBe(1);
  expect(originalKey).toBeTruthy();
  const accepted = state.runs[0]!;
  expect(accepted.state).toBe('success');
  await page.locator('#refresh').click();

  await page.locator('#message').fill('Did that finish?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await visible(page, '#messages', 'Using a previously accepted run');
  const chats = state.requests.filter(request => request.path === '/api/chat');
  expect(chats).toHaveLength(1);
  expect(chats[0]?.key).not.toBe(originalKey);
  expect(chats[0]?.body.intent).toBe('status');
  expect(state.toolSchemas.at(-1)).toContain('run_status');
  expect(state.toolSchemas.at(-1)).not.toContain(capability.id);
  expect(state.invocations.size).toBe(1);

  await page.locator('#message').fill('Read offline-member shares again');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
  const statusChats = state.requests.filter(request => request.path === '/api/chat');
  expect(statusChats).toHaveLength(2);
  expect(statusChats[1]?.key).not.toBe(originalKey);
  expect(statusChats[1]?.body.intent).toBe('status');
  expect(state.toolSchemas.at(-1)).toContain('run_status');
  expect(state.toolSchemas.at(-1)).not.toContain(capability.id);
  expect(state.invocations.size).toBe(1);

  await page.getByText('Invoke an approved capability directly', { exact: true }).click();
  await page.locator('#fields input').fill('new-member');
  const invoke = page.getByRole('button', { name: 'Invoke capability', exact: true });
  expect(await invoke.isDisabled()).toBe(true);
  await page.locator('#invoke').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await page.waitForTimeout(100);
  expect(state.requests.filter(request => request.path.endsWith('/invoke'))).toHaveLength(0);

  let lookupKey = '';
  await page.route('**/api/chat/request', route => {
    lookupKey = route.request().headers()['idempotency-key'] ?? '';
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'No accepted request found' }),
    });
  });
  await page.getByRole('button', { name: 'Look up original request', exact: true }).click();
  await visible(page, '#messages', 'Acceptance remains unconfirmed');
  expect(lookupKey).toBe(originalKey);
  expect(state.invocations.size).toBe(1);

  await page.unroute('**/api/chat/request');
  await page.route('**/api/chat/request', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ kind: 'run', runId, capability: capability.id, state: 'success' }),
  }));
  await page.getByRole('button', { name: 'Look up original request', exact: true }).click();
  await page.getByText(`The original request was bound to run ${runId}.`, { exact: false }).waitFor();
  await vi.waitFor(async () => expect(await invoke.isDisabled()).toBe(false));
  await invoke.click();
  await visible(page, '#runs', runId);
  const invokes = state.requests.filter(request => request.path.endsWith('/invoke'));
  expect(invokes).toHaveLength(1);
  expect(invokes[0]?.key).not.toBe(originalKey);
  expect(state.invocations.size).toBe(2);
}, 30000);
it('abandons only local chat recovery and sends a deliberate new key without auto-submit', async () => {
  const { page, state, service, connect } = await fixture();
  let originalKey = '';
  await page.route('**/api/chat', async route => {
    originalKey = route.request().headers()['idempotency-key'] ?? '';
    service.invoke('caller', capability.id, { member: 'offline-member' }, originalKey);
    await route.abort();
    await page.unroute('**/api/chat');
  });
  await connect();
  await page.locator('#message').fill('Read offline-member shares');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Start a separate request', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Start a separate request', exact: true }).click();
  expect(state.invocations.size).toBe(1);
  expect(state.requests.filter(request => request.path === '/api/chat')).toHaveLength(0);
  await page.locator('#message').fill('Read offline-member shares again');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#messages [data-run-id]').last().waitFor();
  await vi.waitFor(() => expect(state.invocations.size).toBe(2));
  const chatKeys = state.requests.filter(request => request.path === '/api/chat').map(request => request.key);
  expect(chatKeys).toHaveLength(1);
  expect(chatKeys[0]).not.toBe(originalKey);
}, 30000);
it('keeps a terminal unknown chat run quarantined while allowing only a local inquiry escape', async () => {
  const { page, state, service, connect } = await fixture();
  const inquiry = { ...capability, id: 'meridian-member-inquiry' };
  service.catalog = () => [capability, inquiry];
  service.availability = () => fixtureAvailability('temporarily_unavailable', 'available');
  let originalKey = '';
  await page.route('**/api/chat', async route => {
    originalKey = route.request().headers()['idempotency-key'] ?? '';
    service.invoke('caller', capability.id, { member: 'offline-member' }, originalKey);
    state.runs[0]!.state = 'POST_OUTCOME_UNKNOWN';
    await route.abort();
    await page.unroute('**/api/chat');
  });
  await connect();
  await page.locator('#message').fill('Read offline-member shares');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Look up original request', exact: true }).waitFor();
  await page.route('**/api/chat/request', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ kind: 'run', runId, capability: capability.id, state: 'POST_OUTCOME_UNKNOWN' }),
  }));
  await page.getByRole('button', { name: 'Look up original request', exact: true }).click();
  await page.getByRole('button', { name: 'Start a separate inquiry', exact: true }).waitFor();
  expect(await page.getByRole('button', { name: 'Invoke capability', exact: true }).count()).toBe(0);
  const requestsBeforeEscape = state.requests.length;
  await page.getByRole('button', { name: 'Start a separate inquiry', exact: true }).click();
  expect(state.requests).toHaveLength(requestsBeforeEscape);
  expect(state.invocations.size).toBe(1);

  await page.getByText('Invoke an approved capability directly', { exact: true }).click();
  await page.locator('#capability').selectOption(capability.id);
  expect(await page.getByRole('button', { name: 'Invoke capability', exact: true }).isDisabled()).toBe(true);
  await page.locator('#capability').selectOption(inquiry.id);
  await page.locator('#fields input').fill('new-member');
  const invoke = page.getByRole('button', { name: 'Invoke capability', exact: true });
  await vi.waitFor(async () => expect(await invoke.isDisabled()).toBe(false));
  await invoke.click();
  await vi.waitFor(() => expect(state.invocations.size).toBe(2));
  const invokes = state.requests.filter(request => request.path.endsWith('/invoke'));
  expect(invokes).toHaveLength(1);
  expect(invokes[0]?.path).toBe(`/capabilities/${inquiry.id}/invoke`);
  expect(invokes[0]?.key).not.toBe(originalKey);
}, 30000);

it('keeps the direct hold through a status-only chat and parsed partial stream failure', async () => {
  const { page, state, connect } = await fixture();
  await connect();
  await page.getByText('Invoke an approved capability directly', { exact: true }).click();
  await page.locator('#fields input').fill('offline-member');
  let first = true;
  await page.route('**/capabilities/*/invoke', async route => {
    if (first) {
      first = false;
      await route.fetch();
      await route.abort();
      return;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Invoke capability', exact: true }).click();
  await page.getByText('Acceptance is unconfirmed. The original request may still run or may have completed.', { exact: false }).waitFor();
  await page.locator('#message').fill('Read offline-member shares');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
  const statusChat = state.requests.filter(request => request.path === '/api/chat').at(-1);
  expect(statusChat?.body.intent).toBe('status');
  expect(state.toolSchemas.at(-1)).not.toContain(capability.id);
  expect(state.invocations.size).toBe(1);
  expect(await page.getByRole('button', { name: 'Invoke capability', exact: true }).isDisabled()).toBe(true);

  state.partialStream = true;
  await page.locator('#message').fill('Read offline-member shares again');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Acceptance is unconfirmed. The original request may still run or may have completed.', { exact: false }).waitFor();
  expect(state.invocations.size).toBe(1);
  state.partialStream = false;
  const afterPartial = state.requests.filter(request => request.path === '/api/chat').at(-1);
  expect(afterPartial?.body.intent).toBe('status');
  expect(state.toolSchemas.at(-1)).toContain('run_status');
  expect(state.toolSchemas.at(-1)).not.toContain(capability.id);
}, 30000);

it('keeps a bound chat hold while linked identity work is pending', async () => {
  const { page, state, service, connect } = await fixture();
  let originalKey = '';
  await page.route('**/api/chat', async route => {
    originalKey = route.request().headers()['idempotency-key'] ?? '';
    service.invoke('caller', capability.id, { member: 'offline-member' }, originalKey);
    state.runs[0]!.state = 'success';
    state.runs[0]!.memberIdentity = { status: 'pending', inquiryRunId: approvalId };
    await route.abort();
    await page.unroute('**/api/chat');
  });
  await connect();
  await page.locator('#message').fill('Read offline-member shares');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Look up original request', exact: true }).waitFor();
  await page.route('**/api/chat/request', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ kind: 'run', runId, capability: capability.id, state: 'success' }),
  }));
  await page.getByRole('button', { name: 'Look up original request', exact: true }).click();
  await page.getByText(`The original request was bound to run ${runId}.`, { exact: false }).waitFor();
  await page.getByText('Invoke an approved capability directly', { exact: true }).click();
  const invoke = page.getByRole('button', { name: 'Invoke capability', exact: true });
  expect(await invoke.isDisabled()).toBe(true);
  expect(state.requests.filter(request => request.path.endsWith('/invoke'))).toHaveLength(0);
  state.runs[0]!.memberIdentity = { status: 'verified', inquiryRunId: approvalId, memberNumber: 'offline-member' };
  await page.locator('#refresh').click();
  await vi.waitFor(async () => expect(await invoke.isDisabled()).toBe(false));
  expect(originalKey).toBeTruthy();
}, 30000);
it('renders a bounded, inert recorded timeline and polls active evidence with authenticated GETs only', async () => {
  const { page, state, connect, evidenceDir, errors } = await fixture();
  const event = (seq: number, name: string, data: Record<string, unknown> = {}) =>
    JSON.stringify({
      event: name,
      seq,
      ts: new Date(Date.UTC(2026, 8, 5, 12, 0, seq)).toISOString(),
      ...data,
    });
  const lines = [
    event(0, 'replay.start'),
    JSON.stringify({ event: '__proto__' }),
    event(1, 'step.start', { action: 'click', risk: 'read', stepId: 'private-step-id' }),
    JSON.stringify({ event: 'constructor' }),
    event(2, 'action.start', { action: 'click', attempt: 1, requestedRisk: 'read' }),
    event(3, 'risk.classified', {
      attempt: 1,
      requestedRisk: 'read',
      effectiveRisk: 'read',
      mutation: false,
      method: 'GET',
    }),
    event(4, 'action.end', { action: 'click', attempt: 1, effectiveRisk: 'read', status: 'success', ms: 12 }),
    event(5, 'step.ok', { action: 'click', ms: 13, isRetry: false }),
    event(6, 'discovery.observe', { turn: 2, url: `https://private.invalid/${hostile}` }),
    event(7, 'discovery.decision', { turn: 2, args: { private: hostile } }),
    ...Array.from({ length: 50 }, (_, index) => event(index + 8, 'step.resolution')),
    event(58, 'action.start', { action: hostile, attempt: -1, error: hostile }),
    event(58, 'replay.success'),
    '{malformed',
  ];
  writeFileSync(join(evidenceDir, runId, 'log.jsonl'), `${lines.join('\n')}\n`);
  state.runs.push(initialRun());
  await connect();
  expect(state.requests.filter((request) => request.path.endsWith('/evidence/log.jsonl'))).toHaveLength(0);

  const card = page.locator(`[data-run-id="${runId}"]`).last();
  await card.getByText('Run details and evidence', { exact: true }).click();
  const timeline = card.getByRole('list', { name: 'Recorded step timeline' });
  await timeline.waitFor();
  expect(await timeline.locator('li').count()).toBe(50);
  await visible(page, `[data-run-id="${runId}"] .timeline`, 'Showing the newest 50 of 59');
  await visible(page, `[data-run-id="${runId}"] .timeline`, 'Timeline may be incomplete.');
  await visible(page, `[data-run-id="${runId}"] .timeline`, '2 unrecognized log lines were omitted.');
  expect(await card.locator('.timeline').innerText()).not.toContain(hostile);
  expect(await card.locator('.timeline').innerText()).not.toContain('private-step-id');
  expect(await card.locator('.timeline').innerText()).not.toContain('private.invalid');
  await page.setViewportSize({ width: 1024, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(evidencePath, 'timeline-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 320, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: join(evidencePath, 'timeline-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1024, height: 900 });
  await card.getByRole('button', { name: 'Show 9 older events', exact: true }).click();
  expect(await timeline.locator('li').count()).toBe(59);
  await visible(page, `[data-run-id="${runId}"] .timeline`, 'Replay started');
  await visible(page, `[data-run-id="${runId}"] .timeline`, 'Step started');
  await visible(page, `[data-run-id="${runId}"] .timeline`, 'Step completed');
  await visible(page, `[data-run-id="${runId}"] .timeline`, 'Discovery turn 2');
  await visible(page, `[data-run-id="${runId}"] .timeline`, 'Attempt 1');
  await visible(page, `[data-run-id="${runId}"] .timeline`, 'Sequence 0');
  expect(
    state.requests.find((request) => request.path.endsWith('/evidence/log.jsonl'))?.authorization,
  ).toBe(`Bearer ${callerToken}`);

  const posts = state.requests.filter((request) => request.method === 'POST').length;
  lines.splice(-2, 2, event(59, 'replay.success'));
  writeFileSync(join(evidenceDir, runId, 'log.jsonl'), `${lines.join('\n')}\n`);
  await visible(page, `[data-run-id="${runId}"] .timeline`, 'Replay completed successfully');
  expect(state.requests.filter((request) => request.method === 'POST')).toHaveLength(posts);

  await card.getByText('Run details and evidence', { exact: true }).click();
  const reads = state.requests.filter((request) => request.path.endsWith('/evidence/log.jsonl')).length;
  await page.waitForTimeout(1_200);
  expect(state.requests.filter((request) => request.path.endsWith('/evidence/log.jsonl'))).toHaveLength(reads);
  expect(errors).toEqual([]);
}, 30000);
it('keeps historical timeline data on refresh errors and cancels late active reads on close or disconnect', async () => {
  const { page, state, connect, evidenceDir, errors } = await fixture();
  const missingRunId = '55555555-5555-4555-8555-555555555555';
  writeFileSync(
    join(evidenceDir, runId, 'log.jsonl'),
    `${JSON.stringify({ event: 'replay.success', seq: 0, ts: '2026-09-05T12:00:00.000Z' })}\n`,
  );
  state.runs.push(
    { ...initialRun(), state: 'success' },
    { ...initialRun(), runId: missingRunId, state: 'success', evidence: [] },
  );
  await connect();

  const card = page.locator(`[data-run-id="${runId}"]`).last();
  await card.getByText('Run details and evidence', { exact: true }).click();
  await card.getByRole('list', { name: 'Recorded step timeline' }).waitFor();
  const completedReads = state.requests.filter((request) => request.path.endsWith('/evidence/log.jsonl')).length;
  await page.waitForTimeout(1_200);
  expect(state.requests.filter((request) => request.path.endsWith('/evidence/log.jsonl'))).toHaveLength(completedReads);

  let failedReads = 0;
  const evidencePattern = `**/runs/${runId}/evidence/log.jsonl`;
  await page.route(evidencePattern, (route) => {
    failedReads++;
    return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"offline"}' });
  });
  await card.getByRole('button', { name: 'Refresh timeline', exact: true }).click();
  await visible(page, `[data-run-id="${runId}"] .timeline`, 'Last recorded entries remain shown');
  expect(failedReads).toBe(1);
  expect(await card.getByRole('list', { name: 'Recorded step timeline' }).count()).toBe(1);
  await page.unroute(evidencePattern);

  const missing = page.locator(`[data-run-id="${missingRunId}"]`).last();
  await missing.getByText('Run details and evidence', { exact: true }).click();
  await visible(page, `[data-run-id="${missingRunId}"] .timeline`, 'No recorded timeline is available');
  expect(state.requests.some((request) => request.path.includes(missingRunId) && request.path.includes('evidence'))).toBe(false);

  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let heldReads = 0;
  await page.route(evidencePattern, async (route) => {
    heldReads++;
    await held;
    await route
      .fulfill({
        contentType: 'application/jsonl',
        body: `${JSON.stringify({ event: 'action.start', seq: 99, ts: '2026-09-05T12:01:39.000Z', action: 'click', attempt: 99 })}\n`,
      })
      .catch(() => {});
  });
  state.runs[0] = { ...state.runs[0], state: 'running' };
  await page.locator('#refresh').click();
  await vi.waitFor(() => expect(heldReads).toBe(1));
  await page.waitForTimeout(1_200);
  expect(heldReads).toBe(1);
  await card.getByText('Run details and evidence', { exact: true }).click();
  release();
  await page.waitForTimeout(1_200);
  expect(heldReads).toBe(1);
  await page.unroute(evidencePattern);

  await card.getByText('Run details and evidence', { exact: true }).click();
  await vi.waitFor(() =>
    expect(state.requests.filter((request) => request.path.endsWith('/evidence/log.jsonl')).length).toBeGreaterThan(completedReads),
  );
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  const disconnectedReads = state.requests.filter((request) => request.path.endsWith('/evidence/log.jsonl')).length;
  await page.waitForTimeout(1_200);
  expect(state.requests.filter((request) => request.path.endsWith('/evidence/log.jsonl'))).toHaveLength(disconnectedReads);
  expect(errors).toEqual([]);
}, 30000);
it('offline operator review controls require live authority, keyboard focus, browser-expired submission and never retry unknown posting', async () => {
  const { page, state, connect, errors } = await fixture();
  const intervention = publicIntervention({
    id: approvalId,
    expiresAt: Date.now() + 60000,
    request: { kind: 'risk_approval', reason: 'Review exact operation', capability: capability.id, goal: 'Transfer fixture', url: 'https://offline.example/review?api_key=short-secret' },
    action: {
      runId, artifact: capability.id, version: '1.0.0', stepId: 'post',
      destination: 'https://offline.example/post?sid=short-secret',
      method: 'POST',
      operator: 'offline-teller',
      branch: 'OFFLINE',
      role: 'TELLER',
      facts: { amount: '25.00', body: 'hidden-body', token: 'hidden-token' },
      visibleFacts: { amount: '25.00', sourceShare: 'OFFLINE-A', destinationShare: 'OFFLINE-B', api_key: 'short-secret' },
      tokenPresent: true,
      control: 'Post',
    },
  });
  state.runs.push({ ...initialRun(), state: 'awaiting-human', intervention });
  let releaseHistory!: () => void;
  const historyReady = new Promise<void>(resolve => { releaseHistory = resolve; });
  await page.route('**/runs', async route => { await historyReady; await route.continue(); });
  await connect();
  await page.getByText('Loading authenticated history…', { exact: true }).waitFor();
  expect(await page.locator('#invoke button').isDisabled()).toBe(true);
  releaseHistory();
  const callerReview = page.getByRole('button', { name: 'Review request', exact: true }).first();
  await callerReview.waitFor();
  await callerReview.click();
  await page.getByRole('dialog').waitFor();
  expect(await page.getByRole('dialog').innerText()).not.toContain('offline-teller');
  expect(await page.getByRole('dialog').getByRole('button', { name: /Confirm|Refuse|Retry|Stop/ }).count()).toBe(0);
  await page.keyboard.press('Escape');
  expect(await page.getByRole('dialog').isVisible()).toBe(false);
  expect(await callerReview.evaluate(element => element === document.activeElement)).toBe(true);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await connect(operatorToken);
  const review = page.getByRole('button', { name: 'Review request', exact: true }).first();
  await review.focus();
  await review.click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  expect(await dialog.getAttribute('data-run-id')).toBe(runId);
  expect(await page.getByRole('dialog').count()).toBe(1);
  const heading = dialog.getByRole('heading', { name: 'Review request', exact: true });
  // Production break caught: autofocus on an approval action instead of the neutral heading could trigger an accidental transaction.
  expect(await heading.evaluate(element => element === document.activeElement)).toBe(true);
  await page.keyboard.press('Tab');
  const dialogFocusTargets = [
    dialog.getByRole('button', { name: 'Close', exact: true }),
    dialog.getByText('Details', { exact: true }),
    dialog.getByRole('button', { name: 'Confirm request', exact: true }),
    dialog.getByRole('button', { name: 'Refuse request', exact: true }),
  ];
  const outsideFocusSet = dialog.locator('.approval > p').first();
  await outsideFocusSet.evaluate(element => {
    element.setAttribute('tabindex', '-1');
    (element as HTMLElement).focus();
  });
  // Production break caught: a focusable dialog descendant outside the computed control set must wrap back to the neutral heading.
  expect(await outsideFocusSet.evaluate(element => element === document.activeElement)).toBe(true);
  await page.keyboard.press('Tab');
  expect(await heading.evaluate(element => element === document.activeElement)).toBe(true);
  await outsideFocusSet.evaluate(element => element.removeAttribute('tabindex'));
  await page.keyboard.press('Tab');
  for (let index = 0; index < dialogFocusTargets.length + 2; index++) {
    // Production break caught: losing native modal containment would let Tab move focus behind this open review dialog.
    expect(await page.evaluate(() => document.activeElement?.closest('dialog[open]')?.getAttribute('data-run-id'))).toBe(runId);
    if (index < dialogFocusTargets.length) {
      // Production break caught: removing the global keyboard focus indicator would make review actions undiscoverable.
      await expectKeyboardVisibleFocus(dialogFocusTargets[index]!);
    }
    await page.keyboard.press('Tab');
  }
  await page.keyboard.press('Escape');
  // Production break caught: failing to restore focus after cancel strands keyboard users outside the review they opened.
  expect(await review.evaluate(element => element === document.activeElement)).toBe(true);
  await review.click();
  await dialog.waitFor();
  const approve = page.getByRole('button', { name: 'Confirm request', exact: true });
  await approve.waitFor();
  expect(await dialog.innerText()).toContain('25.00');
  expect(await dialog.innerText()).not.toMatch(/short-secret|hidden-body|hidden-token|visibleFacts|businessValues/);
  await page.screenshot({ path: join(evidencePath, 'review-dialog-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.screenshot({ path: walkthroughScreenshotPath('review-320.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });
  let releaseDecision!: () => void;
  const decisionReady = new Promise<void>(resolve => { releaseDecision = resolve; });
  // Keep the submission state observable before authoritative refresh removes the approval panel.
  await page.route(`**/runs/${runId}/decision`, async route => { await decisionReady; await route.continue(); }, { times: 1 });
  try {
    await approve.focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    const submitted = dialog.locator('[role="status"]', { hasText: 'Decision submitted. Waiting for authoritative run updates.' });
    await submitted.waitFor();
    expect(await approve.isDisabled()).toBe(true);
    expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
    expect(state.decisions).toEqual([]);
  } finally { releaseDecision(); }
  await vi.waitFor(() => expect(state.decisions).toEqual(['approve']));
  expect(state.requests.find(request => request.path.endsWith('/decision'))?.body).toEqual({ approvalId, decision: 'approve' });
  state.runs[0] = {
    ...initialRun(),
    state: 'awaiting-human',
    intervention: { ...intervention, id: '66666666-6666-4666-8666-666666666666', expiresAt: Date.now() - 1 },
  };
  await page.keyboard.press('Escape');
  await page.locator('#refresh').click();
  await page.getByRole('button', { name: 'Review request', exact: true }).first().click();
  await visible(page, '.approval', 'Estimated deadline passed.');
  // Production break caught: exposing expiry only through styling would hide the actionable error from screen-reader users.
  expect(await page.locator('.approval').innerText()).toContain('Estimated deadline passed.');
  expect(await approve.isEnabled()).toBe(true);
  const expiredRefuse = page.getByRole('button', { name: 'Refuse request', exact: true });
  expect(await expiredRefuse.isEnabled()).toBe(true);
  const expiredClose = dialog.getByRole('button', { name: 'Close', exact: true });
  const expiredDetails = dialog.getByText('Details', { exact: true });
  await heading.focus();
  await page.keyboard.press('Tab');
  expect(await expiredClose.evaluate(element => element === document.activeElement)).toBe(true);
  await page.keyboard.press('Tab');
  expect(await expiredDetails.evaluate(element => element === document.activeElement)).toBe(true);
  const hiddenDetailsValue = expiredDetails.locator('..').locator('dd').first();
  await hiddenDetailsValue.evaluate(element => element.setAttribute('tabindex', '0'));
  expect(await expiredDetails.locator('..').locator('dl').isVisible()).toBe(false);
  await expiredDetails.focus();
  await page.keyboard.press('Tab');
  // Closed Details descendants must stay out of the sequential focus order.
  expect(await approve.evaluate(element => element === document.activeElement)).toBe(true);
  await hiddenDetailsValue.evaluate(element => element.removeAttribute('tabindex'));
  await expiredDetails.click();
  expect(await expiredDetails.locator('..').locator('dl').isVisible()).toBe(true);
  await expiredDetails.focus();
  await page.keyboard.press('Tab');
  // A browser-estimated deadline does not disable server-authorized actions.
  expect(await approve.evaluate(element => element === document.activeElement)).toBe(true);
  await page.keyboard.press('Tab');
  expect(await expiredRefuse.evaluate(element => element === document.activeElement)).toBe(true);
  await page.keyboard.press('Tab');
  expect(await heading.evaluate(element => element === document.activeElement)).toBe(true);
  await page.keyboard.press('Shift+Tab');
  expect(await expiredRefuse.evaluate(element => element === document.activeElement)).toBe(true);
  await page.keyboard.press('Shift+Tab');
  expect(await approve.evaluate(element => element === document.activeElement)).toBe(true);
  await page.keyboard.press('Shift+Tab');
  expect(await expiredDetails.evaluate(element => element === document.activeElement)).toBe(true);
  await page.keyboard.press('Shift+Tab');
  expect(await expiredClose.evaluate(element => element === document.activeElement)).toBe(true);
  await page.keyboard.press('Shift+Tab');
  // Production break caught: Shift+Tab from the first control must wrap to the neutral heading, not escape the modal.
  expect(await heading.evaluate(element => element === document.activeElement)).toBe(true);
  await expiredRefuse.click();
  await vi.waitFor(() => expect(state.requests.filter(request => request.path.endsWith('/decision'))).toHaveLength(2));
  expect(state.requests.filter(request => request.path.endsWith('/decision')).at(-1)?.body).toEqual({
    approvalId: '66666666-6666-4666-8666-666666666666', decision: 'abort',
  });
  state.runs[0] = {
    ...initialRun(), step: 'submit-transfer',
    state: 'awaiting-human',
    intervention: {
      ...intervention,
      id: '33333333-3333-4333-8333-333333333333',
      request: { kind: 'locator_failed', reason: 'Repair the exact active page', capability: capability.id, goal: 'Repair fixture', url: 'https://offline.example/review' },
    },
  };
  await page.keyboard.press('Escape');
  await page.locator('#refresh').click();
  await page.getByRole('button', { name: 'Review request', exact: true }).first().click();
  const retry = page.getByRole('button', { name: 'Retry after repair' });
  await retry.waitFor();
  await dialog.getByText('submit-transfer', { exact: true }).waitFor();
  await dialog.getByText('https://offline.example/review', { exact: true }).waitFor();
  await heading.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  expect(await retry.evaluate(element => element === document.activeElement)).toBe(true);
  // Production break caught: a retry control without a keyboard-visible indicator is unreachable for keyboard-only repair.
  await expectKeyboardVisibleFocus(retry);
  // Production break caught: changing retry to an icon-only action would remove its readable recovery name.
  expect(await retry.innerText()).toBe('Retry after repair');
  const stop = page.getByRole('button', { name: 'Stop request', exact: true });
  await page.keyboard.press('Tab');
  expect(await stop.evaluate(element => element === document.activeElement)).toBe(true);
  await page.keyboard.press('Tab');
  // Production break caught: forward Tab from the last enabled repair action must wrap to the neutral heading.
  expect(await heading.evaluate(element => element === document.activeElement)).toBe(true);
  await page.keyboard.press('Shift+Tab');
  // Production break caught: reverse Tab from the neutral heading must wrap to the last enabled repair action.
  expect(await stop.evaluate(element => element === document.activeElement)).toBe(true);
  await page.keyboard.press('Shift+Tab');
  expect(await retry.evaluate(element => element === document.activeElement)).toBe(true);
  await retry.focus();
  await retry.click();
  await vi.waitFor(() => expect(state.decisions).toEqual(['approve', 'retry']));
  state.runs[0] = {
    ...initialRun(),
    state: 'awaiting-human',
    intervention: { ...intervention, id: '44444444-4444-4444-8444-444444444444' },
  };
  await page.keyboard.press('Escape');
  await page.locator('#refresh').click();
  await page.getByRole('button', { name: 'Review request', exact: true }).first().click();
  await page.getByRole('button', { name: 'Refuse request', exact: true }).click();
  await vi.waitFor(() => expect(state.decisions).toEqual(['approve', 'retry', 'abort']));
  state.runs[0] = { ...initialRun(), state: 'POST_OUTCOME_UNKNOWN', intervention };
  await page.keyboard.press('Escape');
  await page.locator('#refresh').click();
  await page.getByRole('tab', { name: /All runs/ }).click();
  await visible(page, '#runs', 'POST_OUTCOME_UNKNOWN');
  expect(await page.getByRole('button', { name: /Retry|Confirm|Refuse/ }).count()).toBe(0);
  await page.screenshot({ path: join(evidencePath, 'offline-unknown.png'), fullPage: true });
  expect(await page.evaluate(() => (window as any).cspViolations)).toEqual([]);
  expect(errors).toEqual([]);
}, 60000);

it.each([
  ['operator accept', operatorToken, 'Accept', 'approve'],
  ['operator reject', operatorToken, 'Reject', 'abort'],
  ['caller', callerToken, undefined, undefined],
] as const)('shows exact inline approval only to the %s and shares one decision lock with Activity', async (_role, token, buttonLabel, expectedDecision) => {
  const { page, state, service, connect } = await fixture();
  const intervention = publicIntervention({
    id: approvalId,
    expiresAt: Date.now() + 60000,
    request: { kind: 'risk_approval', reason: 'Review exact operation', capability: capability.id, goal: 'Read fixture', url: 'https://offline.example/review' },
    action: {
      runId, artifact: capability.id, version: '1.0.0', stepId: 'post',
      destination: 'https://offline.example/post', method: 'POST', operator: 'offline-teller', branch: 'OFFLINE', role: 'TELLER',
      facts: { private: 'withheld' }, visibleFacts: { member: 'offline-member', action: 'Read shares' }, tokenPresent: true, control: 'Post',
    },
  });
  await page.route('**/api/chat', async route => {
    const key = route.request().headers()['idempotency-key'] ?? '';
    service.invoke('caller', capability.id, { member: 'offline-member' }, key);
    state.runs[0] = { ...state.runs[0], state: 'awaiting-human', intervention };
    await route.abort();
    await page.unroute('**/api/chat');
  });
  await connect(token);
  await page.locator('#message').fill('Read offline-member shares');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Look up original request', exact: true }).waitFor({ timeout: 5000 });
  await page.route('**/api/chat/request', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ kind: 'run', runId, capability: capability.id, state: 'awaiting-human' }),
  }));
  await page.getByRole('button', { name: 'Look up original request', exact: true }).click();
  const chatCard = page.locator(`.chat-recovery [data-run-id="${runId}"]`).first();
  await chatCard.waitFor({ timeout: 5000 });
  if (buttonLabel) await chatCard.getByRole('button', { name: buttonLabel, exact: true }).waitFor({ timeout: 5000 });
  expect(await chatCard.getByRole('button', { name: 'Accept', exact: true }).count()).toBe(buttonLabel ? 1 : 0);
  expect(await chatCard.getByRole('button', { name: 'Reject', exact: true }).count()).toBe(buttonLabel ? 1 : 0);
  if (!buttonLabel) return;

  await chatCard.getByText('offline-member', { exact: true }).waitFor();
  await chatCard.getByText('Read shares', { exact: true }).waitFor();
  let posts = 0;
  let decision: unknown;
  await page.route('**/decision', route => {
    posts += 1;
    decision = route.request().postDataJSON();
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  const inlineDecision = chatCard.getByRole('button', { name: buttonLabel, exact: true });
  await inlineDecision.click();
  await vi.waitFor(() => expect(posts).toBe(1));
  expect(decision).toEqual({ approvalId, decision: expectedDecision });
  const inlineSubmitted = chatCard.getByText('Decision submitted. Waiting for authoritative run updates.', { exact: true });
  await inlineSubmitted.waitFor();
  expect(await inlineSubmitted.evaluate(element => element === document.activeElement)).toBe(true);
  await chatCard.getByRole('button', { name: 'Review request', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const dialogConfirm = dialog.getByRole('button', { name: 'Confirm request', exact: true });
  await dialogConfirm.waitFor();
  expect(await dialogConfirm.isDisabled()).toBe(true);
  expect(await dialog.getByRole('button', { name: 'Refuse request', exact: true }).isDisabled()).toBe(true);
  await dialogConfirm.evaluate(button => (button as HTMLButtonElement).click());
  expect(posts).toBe(1);
  expect(state.decisions).toEqual([]);
}, 30000);

it('claims one shared recovery probe across inline and dialog panels before a newer decision', async () => {
  const { page, state, service, connect } = await fixture();
  const intervention = publicIntervention({
    id: approvalId, expiresAt: Date.now() + 60000,
    request: { kind: 'risk_approval', reason: 'Review exact operation', capability: capability.id, goal: 'Read fixture', url: 'https://offline.example/review' },
    action: {
      runId, artifact: capability.id, version: '1.0.0', stepId: 'post', destination: 'https://offline.example/post',
      method: 'POST', operator: 'offline-teller', branch: 'OFFLINE', role: 'TELLER', facts: {},
      visibleFacts: { member: 'offline-member' }, tokenPresent: true, control: 'Post',
    },
  });
  await page.route('**/api/chat', async route => {
    service.invoke('caller', capability.id, { member: 'offline-member' }, route.request().headers()['idempotency-key'] ?? '');
    state.runs[0] = { ...state.runs[0], state: 'awaiting-human', intervention };
    await route.abort();
    await page.unroute('**/api/chat');
  });
  await connect(operatorToken);
  await page.locator('#message').fill('Read offline-member shares');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Look up original request', exact: true }).waitFor();
  await page.route('**/api/chat/request', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ kind: 'run', runId, capability: capability.id, state: 'awaiting-human' }),
  }));
  await page.getByRole('button', { name: 'Look up original request', exact: true }).click();
  const chatCard = page.locator(`.chat-recovery [data-run-id="${runId}"]`).first();
  const accept = chatCard.getByRole('button', { name: 'Accept', exact: true });
  await accept.waitFor();
  await chatCard.getByRole('button', { name: 'Review request', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const dialogConfirm = dialog.getByRole('button', { name: 'Confirm request', exact: true });
  await dialogConfirm.waitFor();

  let posts = 0;
  await page.route('**/decision', async route => { posts += 1; await route.abort(); });
  let releaseProbe!: () => void;
  const heldProbe = new Promise<void>(resolve => { releaseProbe = resolve; });
  let probes = 0;
  await page.route(`**/runs/${runId}`, async route => { probes += 1; await heldProbe; await route.continue(); });
  await dialogConfirm.click();
  await page.getByText('Refresh to inspect authoritative state.', { exact: false }).first().waitFor();
  expect(await dialogConfirm.isDisabled()).toBe(true);
  expect(await dialog.getByRole('button', { name: 'Refuse request', exact: true }).isDisabled()).toBe(true);
  const heading = dialog.getByRole('heading', { name: 'Review request', exact: true });
  const uncertainClose = dialog.getByRole('button', { name: 'Close', exact: true });
  const uncertainDetails = dialog.getByText('Details', { exact: true });
  await heading.focus();
  await page.keyboard.press('Tab');
  expect(await uncertainClose.evaluate(element => element === document.activeElement)).toBe(true);
  await page.keyboard.press('Tab');
  expect(await uncertainDetails.evaluate(element => element === document.activeElement)).toBe(true);
  const hiddenDetailsValue = uncertainDetails.locator('..').locator('dd').first();
  await hiddenDetailsValue.evaluate(element => element.setAttribute('tabindex', '0'));
  await uncertainDetails.focus();
  await page.keyboard.press('Tab');
  // Production break caught: a closed Details child and disabled unconfirmed actions must stay outside the dialog focus order.
  expect(await heading.evaluate(element => element === document.activeElement)).toBe(true);
  await hiddenDetailsValue.evaluate(element => element.removeAttribute('tabindex'));
  await page.keyboard.press('Shift+Tab');
  expect(await uncertainDetails.evaluate(element => element === document.activeElement)).toBe(true);
  await page.keyboard.press('Shift+Tab');
  expect(await uncertainClose.evaluate(element => element === document.activeElement)).toBe(true);
  await page.keyboard.press('Shift+Tab');
  expect(await heading.evaluate(element => element === document.activeElement)).toBe(true);
  // The two mounted panels claim one shared recovery probe for the exact pending intervention.
  await vi.waitFor(() => expect(probes).toBe(1));
  await page.waitForTimeout(50);
  expect(probes).toBe(1);
  releaseProbe();
  await page.getByText('The server confirms this intervention is still pending.', { exact: false }).first().waitFor();
  await vi.waitFor(async () => expect(await dialogConfirm.isEnabled()).toBe(true));

  await page.unroute('**/decision');
  await page.route('**/decision', route => { posts += 1; return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }); });
  await dialogConfirm.click();
  await vi.waitFor(() => expect(posts).toBe(2));
  expect(await dialogConfirm.isDisabled()).toBe(true);
  expect(await accept.isDisabled()).toBe(true);
  await page.waitForTimeout(50);
  expect(await dialogConfirm.isDisabled()).toBe(true);
  expect(posts).toBe(2);
}, 30000);

it.each(['chat', 'guided'] as const)('resets only the active %s inline panel on replacement without approving newly presented facts', async surface => {
  const capabilityId = 'meridian-funds-transfer';
  const { page, state, service, connect, errors } = await fixture(false, undefined, { capabilityId });
  page.setDefaultTimeout(5000);
  const intervention = publicIntervention({
    id: approvalId, expiresAt: Date.now() + 60000,
    request: { kind: 'risk_approval', reason: 'Review exact operation', capability: capabilityId, goal: 'Transfer fixture', url: 'https://offline.example/review' },
    action: {
      runId, artifact: capabilityId, version: '1.0.0', stepId: 'post', destination: 'https://offline.example/post',
      method: 'POST', operator: 'offline-teller', branch: 'OFFLINE', role: 'TELLER',
      facts: { amount: '25.00' }, visibleFacts: { amount: '25.00', memo: 'original' }, tokenPresent: true, control: 'Post',
    },
  });
  await page.route('**/api/chat', async route => {
    service.invoke('caller', capabilityId, { member: 'offline-member' }, route.request().headers()['idempotency-key'] ?? '');
    state.runs[0] = { ...state.runs[0], state: 'awaiting-human', intervention };
    await route.abort();
    await page.unroute('**/api/chat');
  });
  await connect(operatorToken);
  await page.locator('#message').fill('Transfer fixture');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Look up original request', exact: true }).waitFor();
  await page.route('**/api/chat/request', route => route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ kind: 'run', runId, capability: capabilityId, state: 'awaiting-human' }),
  }));
  await page.getByRole('button', { name: 'Look up original request', exact: true }).click();
  const chatCard = page.locator(`.chat-recovery [data-run-id="${runId}"]`);
  const guidedCard = page.locator(`.guided-operations [data-run-id="${runId}"]`);
  const activeCard = surface === 'chat' ? chatCard : guidedCard;
  await chatCard.getByRole('button', { name: 'Accept', exact: true }).waitFor();
  await guidedCard.getByRole('button', { name: 'Accept', exact: true }).waitFor();
  async function replace(id: string) {
    state.runs[0] = { ...state.runs[0], intervention: publicIntervention({
      ...intervention, id,
      action: { ...intervention.action!, visibleFacts: { amount: '99.00', memo: id } },
    }) };
    // Authenticated polling refreshes both mounted copies without moving focus through a refresh-button click.
    await chatCard.getByText(id, { exact: true }).waitFor();
    await guidedCard.getByText(id, { exact: true }).waitFor();
  }
  const message = page.locator('#message');
  await message.focus();
  await replace('33333333-3333-4333-8333-333333333333');
  expect(await message.evaluate(element => element === document.activeElement)).toBe(true);
  const refresh = page.locator('#refresh');
  await refresh.focus();
  await replace('44444444-4444-4444-8444-444444444444');
  expect(await refresh.evaluate(element => element === document.activeElement)).toBe(true);
  const review = activeCard.getByRole('button', { name: 'Review request', exact: true });
  await review.scrollIntoViewIfNeeded();
  const geometry = await review.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    const footer = document.querySelector('.composer-footer')!.getBoundingClientRect();
    return { button: rect.toJSON(), footer: footer.toJSON(), hit: hit?.outerHTML, unobscured: Boolean(hit && element.contains(hit)), viewport: { width: innerWidth, height: innerHeight } };
  });
  writeFileSync(walkthroughScreenshotPath(`replacement-${surface}-geometry.json`), JSON.stringify(geometry, null, 2));
  await page.screenshot({ path: walkthroughScreenshotPath(`replacement-${surface}.png`) });
  expect(geometry.unobscured).toBe(true);
  await review.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Confirm transfer', exact: true }).focus();
  await replace('55555555-5555-4555-8555-555555555555');
  expect(await dialog.getByRole('heading', { name: 'Review request', exact: true }).evaluate(element => element === document.activeElement)).toBe(true);
  await page.keyboard.press('Escape');

  const decision = activeCard.getByRole('button', { name: surface === 'chat' ? 'Accept' : 'Reject', exact: true });
  await decision.focus();
  await replace(secondApprovalId);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(100);
  expect(state.requests.filter(request => request.path.endsWith('/decision'))).toEqual([]);
  expect(await activeCard.getByRole('heading', { name: 'Operator approval required', exact: true }).evaluate(element => element === document.activeElement)).toBe(true);
  await decision.click();
  const expectedDecision = surface === 'chat' ? 'approve' : 'abort';
  await vi.waitFor(() => expect(state.decisions).toEqual([expectedDecision]));
  expect(state.requests.filter(request => request.path.endsWith('/decision')).map(request => ({ path: request.path, body: request.body }))).toEqual([
    { path: `/runs/${runId}/decision`, body: { approvalId: secondApprovalId, decision: expectedDecision } },
  ]);
  expect(errors).toEqual([]);
}, 30000);

it('neutral replacement focus resets when an open review receives a replacement intervention', async () => {
  const { page, state, connect } = await fixture();
  const intervention = publicIntervention({
    id: approvalId,
    expiresAt: Date.now() + 60000,
    request: { kind: 'risk_approval', reason: 'Review exact operation', capability: capability.id, goal: 'Transfer fixture', url: 'https://offline.example/review' },
    action: {
      runId, artifact: capability.id, version: '1.0.0', stepId: 'post',
      destination: 'https://offline.example/post', method: 'POST', operator: 'offline-teller', branch: 'OFFLINE', role: 'TELLER',
      facts: { amount: '25.00', memo: 'original' }, visibleFacts: { amount: '25.00', memo: 'original' }, tokenPresent: true, control: 'Post',
    },
  });
  const replacementId = '55555555-5555-4555-8555-555555555555';
  state.runs.push({ ...initialRun(), state: 'awaiting-human', intervention });
  await connect(operatorToken);
  await page.getByRole('button', { name: 'Review request', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  const heading = dialog.getByRole('heading', { name: 'Review request', exact: true });
  const confirm = page.getByRole('button', { name: 'Confirm request', exact: true });
  await confirm.waitFor();
  await confirm.focus();
  state.runs[0] = {
    ...initialRun(),
    state: 'awaiting-human',
    intervention: publicIntervention({
      ...intervention,
      id: replacementId,
      action: { ...intervention.action!, facts: { amount: '99.00', memo: 'replacement' }, visibleFacts: { amount: '99.00', memo: 'replacement' } },
    }),
  };
  // The native modal intentionally blocks the Activity panel; let authenticated polling replace the intervention in place.
  await page.waitForTimeout(1800);
  await visible(page, '.approval', '99.00');
  expect(await heading.evaluate(element => element === document.activeElement)).toBe(true);
  await page.keyboard.press('Enter');
  expect(state.decisions).toEqual([]);
  await confirm.click();
  await vi.waitFor(() => expect(state.decisions).toEqual(['approve']));
  expect(state.requests.filter(request => request.path.endsWith('/decision')).at(-1)?.body).toEqual({
    approvalId: replacementId,
    decision: 'approve',
  });
}, 15000);

it('collects and reviews all four guided operations without starting a request', async () => {
  const { page, state, connect } = await fixture();
  await connect(operatorToken);
  const guided = page.locator('.guided-operations');
  const cases = [
    ['meridian-funds-transfer', [
      ['Member number', '9001'], ['From share', '9001-S001'], ['To share', '9001-S002'],
      ['Amount', '25.00'], ['Memo', 'Rent'],
    ]],
    ['meridian-open-share', [
      ['Member number', '9002'], ['Share type', 'MMKT'], ['Initial deposit', '100.00'],
    ]],
    ['meridian-update-member', [
      ['Member number', '9003'], ['Email', 'member@example.test'], ['Phone', '555-0103'],
      ['Mailing address', '3 Main Street'],
    ]],
    ['meridian-place-hold', [
      ['Member number', '9004'], ['Share', '9004-S001'], ['Reason code', 'FRAUD'], ['Notes', 'Review required'],
    ]],
  ] as const;
  for (const [operation, fields] of cases) {
    await guided.getByLabel('Operation').selectOption(operation);
    for (const [label, value] of fields) {
      const control = guided.getByLabel(label, { exact: true });
      if (await control.evaluate(element => element instanceof HTMLSelectElement)) await control.selectOption(value);
      else await control.fill(value);
    }
    await guided.getByRole('button', { name: 'Preview request', exact: true }).click();
    const preview = guided.locator('.operation-preview');
    await preview.getByText('Request preparation · This preview does not submit a transaction.', { exact: true }).waitFor();
    for (const [label, value] of fields) {
      const presented = ['Amount', 'Initial deposit'].includes(label) ? `$${value}` : value;
      await preview.getByText(presented, { exact: true }).waitFor();
    }
    await guided.getByRole('button', { name: 'Edit request', exact: true }).click();
  }
  expect(state.requests.filter(request => request.path.endsWith('/invoke') || request.path.endsWith('/discover'))).toEqual([]);
}, 30000);

it('requires supervisor context for hold and recovers an operator-selected role with the exact discovery request', async () => {
  const { page, state, connect } = await fixture();
  const guided = page.locator('.guided-operations');
  const fillHold = async () => {
    await guided.getByLabel('Operation').selectOption('meridian-place-hold');
    await guided.getByLabel('Member number', { exact: true }).fill('9004');
    await guided.getByLabel('Share', { exact: true }).fill('9004-S001');
    await guided.getByLabel('Reason code', { exact: true }).selectOption('FRAUD');
    await guided.getByLabel('Notes', { exact: true }).fill('Review required');
    await guided.getByRole('button', { name: 'Preview request', exact: true }).click();
  };
  await connect(callerToken);
  await fillHold();
  await guided.getByText('Only an authenticated operator can start supervised discovery.', { exact: true }).waitFor();
  expect(await guided.getByLabel('Target role', { exact: true }).count()).toBe(0);
  expect(await guided.getByRole('button', { name: 'Start supervised discovery', exact: true }).count()).toBe(0);

  await connect(operatorToken);
  await guided.getByLabel('Operation').selectOption('meridian-place-hold');
  const targetRole = guided.getByLabel('Target role', { exact: true });
  expect(await targetRole.inputValue()).toBe('SUPERVISOR');
  expect(await targetRole.isDisabled()).toBe(true);
  await guided.getByLabel('Operation').selectOption('meridian-funds-transfer');
  await guided.getByLabel('Member number', { exact: true }).fill('9004');
  await guided.getByLabel('From share', { exact: true }).fill('9004-S001');
  await guided.getByLabel('To share', { exact: true }).fill('9004-S002');
  await guided.getByLabel('Amount', { exact: true }).fill('25.00');
  await guided.getByLabel('Memo', { exact: true }).fill('Review required');
  await targetRole.selectOption('SUPERVISOR');
  await guided.getByRole('button', { name: 'Preview request', exact: true }).click();
  await guided.getByText('Requested target role: SUPERVISOR', { exact: false }).waitFor();
  let first = true;
  await page.route('**/capabilities/meridian-funds-transfer/discover', async route => {
    if (first) {
      first = false;
      await route.fetch();
      await route.abort();
      return;
    }
    await route.continue();
  });
  await guided.getByRole('button', { name: 'Start supervised discovery', exact: true }).click();
  await guided.getByRole('alert').waitFor();
  expect(await guided.getByRole('alert').textContent()).toContain('Acceptance is unconfirmed.');
  await guided.getByRole('button', { name: 'Look up original request', exact: true }).click();
  await guided.getByText(`Accepted run: ${runId}.`, { exact: false }).waitFor();
  const requests = state.requests.filter(request => request.path === '/capabilities/meridian-funds-transfer/discover');
  expect(requests).toHaveLength(2);
  expect(requests[0]?.body).toEqual({
    args: { member: '9004', sourceShare: '9004-S001', destinationShare: '9004-S002', amount: '25.00', memo: 'Review required' },
    operator: 'SUPERVISOR',
  });
  expect(requests[1]?.body).toEqual({ ...requests[0]?.body, lookupOnly: true });
  expect(requests[1]?.key).toBe(requests[0]?.key);
}, 30000);

it('starts an available guided transfer and restores pending inline approval from authenticated history after reconnect', async () => {
  const { page, state, service, connect } = await fixture();
  const transfer = {
    ...capability,
    id: 'meridian-funds-transfer',
    parameters: operationContracts[0].parameters.map(parameter => ({ ...parameter })),
    tools: { ...capability.tools, openai: { ...capability.tools.openai, function: { ...capability.tools.openai.function, name: 'meridian-funds-transfer' } } },
  };
  service.catalog = () => [transfer];
  await connect(operatorToken);
  const guided = page.locator('.guided-operations');
  await guided.getByLabel('Operation').selectOption(transfer.id);
  await guided.getByLabel('Member number', { exact: true }).fill('9001');
  await guided.getByLabel('From share', { exact: true }).fill('9001-S001');
  await guided.getByLabel('To share', { exact: true }).fill('9001-S002');
  await guided.getByLabel('Amount', { exact: true }).fill('25.00');
  await guided.getByLabel('Memo', { exact: true }).fill('Rent');
  await guided.getByLabel('Target role', { exact: true }).selectOption('SUPERVISOR');
  await guided.getByRole('button', { name: 'Preview request', exact: true }).click();
  await guided.getByRole('button', { name: 'Start operation', exact: true }).click();
  await guided.getByText(`Accepted run: ${runId}.`, { exact: false }).waitFor();
  await guided.getByText('Request preparation · This preview does not submit a transaction.', { exact: true }).waitFor();
  expect(await guided.getByText('Nothing has been posted', { exact: false }).count()).toBe(0);
  const invoked = state.requests.filter(request => request.path === `/capabilities/${transfer.id}/invoke`);
  expect(invoked).toHaveLength(1);
  expect(invoked[0]?.body).toEqual({
    args: { member: '9001', sourceShare: '9001-S001', destinationShare: '9001-S002', amount: '25.00', memo: 'Rent' },
    operator: 'SUPERVISOR',
  });

  state.runs[0] = {
    ...state.runs[0], state: 'awaiting-human',
    intervention: publicIntervention({
      id: approvalId, expiresAt: Date.now() + 60000,
      request: { kind: 'risk_approval', reason: 'Review transfer', capability: transfer.id, goal: 'Transfer fixture', url: 'https://offline.example/review' },
      action: {
        runId, artifact: transfer.id, version: '1.0.0', stepId: 'post', destination: 'https://offline.example/post', method: 'POST',
        operator: 'offline-teller', branch: 'OFFLINE', role: 'TELLER', tokenPresent: true, control: 'Post',
        facts: { member: '9001', sourceShare: '9001-S001', destinationShare: '9001-S002', amount: '25.00', memo: 'Rent' },
        visibleFacts: { member: '9001', sourceShare: '9001-S001', destinationShare: '9001-S002', amount: '25.00', memo: 'Rent' },
      },
    }),
  };
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await connect(operatorToken);
  const current = page.locator('.guided-operations').locator(`[data-run-id="${runId}"]`);
  await current.getByRole('button', { name: 'Accept', exact: true }).waitFor();
  await current.getByText('$25.00', { exact: true }).waitFor();

  const recovered = state.runs.find(run => run.runId === runId)!;
  Object.assign(recovered, {
    state: 'success', intervention: undefined, finishedAt: new Date().toISOString(),
    result: { status: 'success', outputs: { confirmation: 'Posted' } },
  });
  await page.locator('#refresh').click();
  await current.getByRole('status').filter({ hasText: 'Completed' }).waitFor();
  await current.getByText('Posted', { exact: true }).waitFor();
  expect(await current.getByRole('button', { name: /Accept|Reject|Retry/ }).count()).toBe(0);
  await guided.getByRole('button', { name: 'Dismiss result', exact: true }).click();
  expect(await current.count()).toBe(0);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  expect(await page.locator('#workspace').count()).toBe(0);
  expect(await page.getByRole('button', { name: 'Connect', exact: true }).isVisible()).toBe(true);
}, 20000);

it('retains a recovered rejected operation until its authoritative result is dismissed', async () => {
  const { page, state, service, connect } = await fixture();
  const transfer = {
    ...capability,
    id: 'meridian-funds-transfer',
    parameters: operationContracts[0].parameters.map(parameter => ({ ...parameter })),
    tools: { ...capability.tools, openai: { ...capability.tools.openai, function: { ...capability.tools.openai.function, name: 'meridian-funds-transfer' } } },
  };
  service.catalog = () => [transfer];
  state.runs.push({
    ...initialRun(), capability: transfer.id, state: 'awaiting-human',
    intervention: publicIntervention({
      id: approvalId, expiresAt: Date.now() + 60000,
      request: { kind: 'risk_approval', reason: 'Review transfer', capability: transfer.id, goal: 'Transfer fixture', url: 'https://offline.example/review' },
      action: {
        runId, artifact: transfer.id, version: '1.0.0', stepId: 'post', destination: 'https://offline.example/post', method: 'POST',
        operator: 'offline-teller', branch: 'OFFLINE', role: 'TELLER', tokenPresent: true, control: 'Post',
        facts: { member: '9001', amount: '25.00' }, visibleFacts: { member: '9001', amount: '25.00' },
      },
    }),
  });
  await connect(operatorToken);
  const guided = page.locator('.guided-operations');
  const current = guided.locator(`[data-run-id="${runId}"]`);
  await current.getByRole('button', { name: 'Reject', exact: true }).waitFor();
  const recovered = state.runs.find(run => run.runId === runId)!;
  Object.assign(recovered, { state: 'interrupted', intervention: undefined });
  await page.locator('#refresh').click();
  await current.getByRole('status').filter({ hasText: 'Interrupted' }).waitFor();
  expect(await current.getByRole('button', { name: /Accept|Reject|Retry/ }).count()).toBe(0);
  await guided.getByRole('button', { name: 'Dismiss result', exact: true }).click();
  expect(await current.count()).toBe(0);
}, 15000);

it('offline direct invocation keeps an uncertain request key, query/auth boundaries and evidence paths remain guarded', async () => {
  const { page, state, service, connect, errors, url } = await fixture();
  await page.locator('#credential').fill('invalid');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await visible(page, '#status', 'Credential rejected');
  expect(await page.locator('#workspace').count()).toBe(0);
  expect(await page.locator('#credential').inputValue()).toBe('');
  await connect(operatorToken);
  await page.getByRole('tab', { name: /All runs/ }).click();
  await visible(page, '#runs', '');
  await page.getByText('Invoke an approved capability directly', { exact: true }).click();
  await page.locator('#fields input').fill('offline-member');
  await page.locator('#operator').selectOption('SUPERVISOR');
  let firstKey: string | undefined;
  await page.route('**/capabilities/*/invoke', async (route) => {
    firstKey = route.request().headers()['idempotency-key'];
    await route.fetch();
    await route.abort();
    await page.unroute('**/capabilities/*/invoke');
  });
  await page.getByRole('button', { name: 'Invoke capability', exact: true }).click();
  await visible(page, '#invoke + p', 'Acceptance is unconfirmed');
  await page.getByText('The original request may still run or may have completed.', { exact: false }).waitFor();
  state.runs[0]!.state = 'success';
  expect(state.runs[0]!.state).toBe('success');
  const inquiry = { ...capability, id: 'meridian-member-inquiry' };
  service.catalog = () => [capability, inquiry];
  service.availability = () => fixtureAvailability('available', 'available');
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/capabilities')),
    page.locator('#refresh').click(),
  ]);
  await page.locator('#capability').selectOption(inquiry.id);
  await page.locator('#operator').selectOption('TELLER');
  await page.locator('#fields input').fill('changed-member');
  const invokeButton = page.getByRole('button', { name: 'Invoke capability', exact: true });
  expect(await invokeButton.isDisabled()).toBe(true);
  await page.locator('#invoke').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await page.waitForTimeout(100);
  let invokes = state.requests.filter((r) => r.path.endsWith('/invoke'));
  expect(invokes).toHaveLength(1);
  await page.getByRole('button', { name: 'Start a separate request', exact: true }).click();
  expect(state.requests.filter((r) => r.path.endsWith('/invoke'))).toHaveLength(1);
  service.availability = () => fixtureAvailability('temporarily_unavailable');
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/capabilities')),
    page.locator('#refresh').click(),
  ]);
  await vi.waitFor(async () => expect(await invokeButton.isDisabled()).toBe(true));
  await page.locator('#invoke').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await page.waitForTimeout(100);
  expect(state.requests.filter((r) => r.path.endsWith('/invoke'))).toHaveLength(1);
  service.availability = () => fixtureAvailability('available', 'available');
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/capabilities')),
    page.locator('#refresh').click(),
  ]);
  await invokeButton.click();
  await visible(page, '#runs', runId);
  invokes = state.requests.filter((r) => r.path.endsWith('/invoke'));
  expect(invokes).toHaveLength(2);
  expect(invokes[0]?.key).toBe(firstKey);
  expect(invokes[1]?.key).not.toBe(firstKey);
  expect(state.invocations.size).toBe(2);
  expect(invokes[0]?.body).toEqual({ args: { member: 'offline-member' }, operator: 'SUPERVISOR' });
  expect(invokes[1]?.path).toBe(`/capabilities/${inquiry.id}/invoke`);
  expect(invokes[1]?.body).toEqual({ args: { member: 'changed-member' }, operator: 'TELLER' });
  expect(await page.locator('#fields input').inputValue()).toBe('changed-member');
  state.runs[0]!.evidence.push('../private.json');
  await page.locator('#refresh').click();
  await page.getByText('Run details and evidence', { exact: true }).first().click();
  await page.getByRole('list', { name: 'Recorded step timeline' }).waitFor();
  const requestsBefore = state.requests.length;
  await page.getByRole('button', { name: 'View ../private.json', exact: true }).click();
  await visible(page, '.evidence', 'Unsupported evidence file');
  expect(state.requests.length).toBe(requestsBefore);
  const queryResponse = await fetch(`${url}/capabilities?role=operator&__proto__[polluted]=true`, {
    headers: { Authorization: `Bearer ${callerToken}` },
  });
  expect(queryResponse.status).toBe(200);
  expect((await queryResponse.json()).principal).toBe('caller');
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  expect((await fetch(`${url}/capabilities?authorization=${operatorToken}`)).status).toBe(401);
  await page.route('**/runs', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"expired"}' }),
  );
  await page.locator('#refresh').click();
  await page.locator('#workspace').waitFor({ state: 'detached' });
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  expect(errors).toEqual([]);
}, 20000);
it('recovers a response-lost direct request with its original body and key while availability is unavailable', async () => {
  const { page, state, service, connect } = await fixture();
  const inquiry = { ...capability, id: 'meridian-member-inquiry' };
  await connect(operatorToken);
  await page.getByText('Invoke an approved capability directly', { exact: true }).click();
  await page.locator('#fields input').fill('offline-member');
  let first = true;
  await page.route('**/capabilities/*/invoke', async route => {
    if (first) {
      first = false;
      await route.fetch();
      await route.abort();
      return;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Invoke capability', exact: true }).click();
  await visible(page, '#invoke + p', 'Acceptance is unconfirmed');
  await page.locator('#fields input').fill('changed-member');
  service.catalog = () => [capability, inquiry];
  service.availability = () => fixtureAvailability('temporarily_unavailable', 'available');
  await page.locator('#refresh').click();
  await page.getByText('temporarily_unavailable · Another operation is active', { exact: true }).waitFor();
  expect(await page.getByRole('button', { name: 'Invoke capability', exact: true }).isDisabled()).toBe(true);
  await page.locator('#capability').selectOption(inquiry.id);
  await page.locator('#operator').selectOption('SUPERVISOR');
  const recovery = page.getByRole('button', { name: 'Look up original request', exact: true });
  await recovery.waitFor();
  await recovery.click();
  await page.getByText(`Accepted run: ${runId}.`, { exact: false }).waitFor();
  const invokes = state.requests.filter(request => request.path.endsWith('/invoke'));
  expect(invokes).toHaveLength(2);
  expect(invokes[1]?.body).toEqual({ ...invokes[0]?.body, lookupOnly: true });
  expect(invokes[1]?.key).toBe(invokes[0]?.key);
  expect(invokes[1]?.path).toBe(`/capabilities/${capability.id}/invoke`);
  expect(state.invocations.size).toBe(1);
});
it('recovers a terminal unknown response-lost request under its original key without a new operation', async () => {
  const { page, state, service, connect } = await fixture();
  await connect();
  await page.getByText('Invoke an approved capability directly', { exact: true }).click();
  await page.locator('#fields input').fill('offline-member');
  let first = true;
  await page.route('**/capabilities/*/invoke', async route => {
    if (first) {
      first = false;
      await route.fetch();
      await route.abort();
      return;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Invoke capability', exact: true }).click();
  await visible(page, '#invoke + p', 'Acceptance is unconfirmed');
  state.runs[0]!.state = 'POST_OUTCOME_UNKNOWN';
  service.availability = () => fixtureAvailability('temporarily_unavailable');
  await page.locator('#refresh').click();
  await page.getByText('temporarily_unavailable · Another operation is active', { exact: true }).waitFor();
  const recovery = page.getByRole('button', { name: 'Look up original request', exact: true });
  await recovery.waitFor();
  await recovery.click();
  await page.getByText(`Accepted run: ${runId}.`, { exact: false }).waitFor();
  const invokes = state.requests.filter(request => request.path.endsWith('/invoke'));
  expect(invokes).toHaveLength(2);
  expect(invokes[1]?.body).toEqual({ ...invokes[0]?.body, lookupOnly: true });
  expect(invokes[1]?.key).toBe(invokes[0]?.key);
  expect(state.invocations.size).toBe(1);
});
it('uses lookup-only recovery after a request is lost before server acceptance', async () => {
  const { page, state, service, connect } = await fixture();
  await connect();
  await page.getByText('Invoke an approved capability directly', { exact: true }).click();
  await page.locator('#fields input').fill('offline-member');
  let first = true;
  await page.route('**/capabilities/*/invoke', async route => {
    if (first) {
      first = false;
      await route.abort();
      return;
    }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Invoke capability', exact: true }).click();
  await visible(page, '#invoke + p', 'Acceptance is unconfirmed');
  service.availability = () => fixtureAvailability('temporarily_unavailable');
  await page.locator('#refresh').click();
  await page.getByText('temporarily_unavailable · Another operation is active', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Look up original request', exact: true }).click();
  await visible(page, '#invoke + p', 'No accepted request was found');
  const invokes = state.requests.filter(request => request.path.endsWith('/invoke'));
  expect(invokes).toHaveLength(1);
  expect(invokes[0]?.body).toEqual({ args: { member: 'offline-member' }, lookupOnly: true });
  expect(state.invocations.size).toBe(0);
});
it('offline refresh requested during an older history read still observes an accepted direct run', async () => {
  const { page, state, connect } = await fixture();
  await connect();
  await page.getByText('No visible runs.', { exact: false }).waitFor();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let intercepted = false;
  await page.route('**/runs', async (route) => {
    if (intercepted) return route.continue();
    intercepted = true;
    await held;
    await route.fulfill({ contentType: 'application/json', body: '[]' });
  });
  await page.locator('#refresh').click();
  await vi.waitFor(() => expect(intercepted).toBe(true));
  await page.getByText('Invoke an approved capability directly', { exact: true }).click();
  await page.locator('#fields input').fill('offline-member');
  await page.getByRole('button', { name: 'Invoke capability', exact: true }).click();
  await vi.waitFor(() => expect(state.invocations.size).toBe(1));
  await page.getByText(`Accepted run: ${runId}.`, { exact: false }).waitFor();
  release();
  await visible(page, '#runs', runId);
}, 15000);
it('offline stopping the response preserves its accepted run and exposes no mutation replay action', async () => {
  const { page, model, state, connect } = await fixture();
  page.setDefaultTimeout(5000);
  let finishResponse!: () => void;
  const held = new Promise<void>((resolve) => {
    finishResponse = resolve;
  });
  model.doStream = async () => ({
    stream: simulateReadableStream({
      chunkDelayInMs: 1000,
      chunks: [
        { type: 'stream-start', warnings: [] },
        {
          type: 'tool-call',
          toolCallId: 'offline-stopped',
          toolName: capability.id,
          input: JSON.stringify({ member: 'offline-member' }),
        },
        {
          type: 'finish',
          finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage: {
            inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
            outputTokens: { total: 1, text: 1, reasoning: 0 },
          },
        },
      ],
    }).pipeThrough(new TransformStream({ flush: () => held })) as ReadableStream<never>,
  });
  try {
    await connect();
    await page
      .getByText('No visible runs. Send a request to start an available capability.', { exact: true })
      .waitFor();
    await page.locator('#message').fill('Read offline-member shares');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await vi.waitFor(() => expect(state.invocations.size).toBe(1), { interval: 20, timeout: 5000 });
    const stop = page.getByRole('button', { name: 'Stop response', exact: true });
    await stop.waitFor();
    expect(await stop.isVisible()).toBe(true);
    expect(await stop.textContent()).toContain('Stop response');
    await stop.click();
    await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
    await page.locator('#refresh').click();
    await visible(page, '#runs', runId);
    expect(state.invocations.size).toBe(1);
    expect(state.decisions).toEqual([]);
    expect(await page.getByRole('button', { name: /regenerate|retry|edit|branch/i }).count()).toBe(0);
    const explanation = page.getByText('Stopping the response does not cancel a run or undo a transaction.', { exact: true });
    expect(await explanation.count()).toBe(1);
    expect(await explanation.isVisible()).toBe(true);
  } finally {
    finishResponse();
  }
}, 15000);
it('bounds assistant text and serialized UTF-8 history without changing the latest operation or key', () => {
  const message = (id: string, role: 'user' | 'assistant', text: string): UIMessage => ({
    id,
    role,
    parts: [{ type: 'text', text }],
  });
  const current = message(
    'stable-current',
    'user',
    'Transfer exactly 25.00 from A to B; memo "approved facts"',
  );
  const normalized = chatRequest(
    [message('assistant-long', 'assistant', 'x'.repeat(4001)), current],
    'thread',
  );
  expect(normalized.body.messages[0]?.parts[0]?.text).toHaveLength(4000);
  expect(normalized.body.messages.at(-1)).toEqual(current);
  for (const content of [
    'x'.repeat(4000),
    '界'.repeat(4000),
    '\u0000'.repeat(4000),
    '"\\\n'.repeat(1300),
    '😀'.repeat(2000),
  ]) {
    const messages = [
      ...Array.from({ length: 10 }, (_, index) =>
        message(`old-${index}`, index % 2 ? 'assistant' : 'user', content),
      ),
      current,
    ];
    const request = chatRequest(messages, 'thread');
    expect(new TextEncoder().encode(JSON.stringify(request.body)).byteLength).toBeLessThanOrEqual(32768);
    expect(request.body.messages.length).toBeLessThan(messages.length);
    expect(request.body.messages.at(-1)).toEqual(current);
    expect(request.headers['Idempotency-Key']).toBe(current.id);
    expect(chatRequest(messages, 'thread')).toEqual(request);
  }
  const exact = message('exact', 'user', '界'.repeat(4000));
  expect(chatRequest([exact], 'thread').body.messages).toEqual([exact]);
  expect(
    chatRequest(
      Array.from({ length: 30 }, (_, index) => message(`user-${index}`, 'user', 'facts')),
      'thread',
    ).body.messages,
  ).toHaveLength(20);
  for (const invalid of [
    message('long', 'user', 'x'.repeat(4001)),
    {
      ...exact,
      parts: [
        { type: 'text' as const, text: 'a'.repeat(2000) },
        { type: 'text' as const, text: 'b'.repeat(2000) },
      ],
    },
    message('bad identity', 'user', 'facts'),
  ]) {
    expect(() => chatRequest([invalid], 'thread')).toThrow(/No request was sent/);
  }
});
it('offline oversized request sends no POST and a subsequent valid send clears the error', async () => {
  const { page, state, connect } = await fixture();
  await connect();
  await page.locator('#message').evaluate((element) => element.removeAttribute('maxlength'));
  await page.locator('#message').fill('x'.repeat(4001));
  expect((await page.locator('#message').inputValue()).length).toBe(4001);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'at most 4000 characters' }).waitFor();
  expect(state.requests.filter((request) => request.path === '/api/chat')).toHaveLength(0);
  expect(state.invocations.size).toBe(0);
  await page.locator('#message').fill('Read offline-member shares');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.locator('#messages [data-run-id]').waitFor();
  expect(state.requests.filter((request) => request.path === '/api/chat')).toHaveLength(1);
  expect(state.invocations.size).toBe(1);
  expect(await page.getByRole('alert').filter({ hasText: 'No request was sent' }).count()).toBe(0);
}, 15000);
it('offline polling survives identical failures, recovers automatically and stops after unmount', async () => {
  const { page, state, connect } = await fixture();
  state.offline = true;
  await connect();
  await vi.waitFor(
    () =>
      expect(state.requests.filter((request) => request.path === '/runs').length).toBeGreaterThanOrEqual(3),
    { timeout: 6000 },
  );
  state.offline = false;
  state.runs.push({ ...initialRun(), state: 'success' });
  await visible(page, '#runs', runId);
  expect(await page.getByText('Disconnected from run updates.', { exact: false }).count()).toBe(0);
  state.offline = true;
  await page.locator('#refresh').click();
  await visible(page, '#workspace', 'Disconnected from run updates');
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  const reads = state.requests.filter((request) => request.path === '/runs').length;
  await page.waitForTimeout(1700);
  expect(state.requests.filter((request) => request.path === '/runs')).toHaveLength(reads);
}, 15000);
it('offline disconnect, auth expiry and pagehide restore the login form with empty credentials', async () => {
  const { page, state, connect } = await fixture();
  await connect();
  expect(await page.locator('#credential').isHidden()).toBe(true);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  expect(await page.locator('#credential').inputValue()).toBe('');
  const attempts = state.requests.filter((request) => request.path === '/capabilities').length;
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  expect(state.requests.filter((request) => request.path === '/capabilities')).toHaveLength(attempts);
  await connect();
  expect(await page.locator('#credential').isHidden()).toBe(true);
  await page.route('**/runs', (route) =>
    route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"expired"}' }),
  );
  await page.locator('#refresh').click();
  await page.locator('#workspace').waitFor({ state: 'detached' });
  expect(await page.locator('#credential').inputValue()).toBe('');
  await page.unroute('**/runs');
  await connect();
  expect(await page.locator('#credential').isHidden()).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  await page.locator('#workspace').waitFor({ state: 'detached' });
  expect(await page.locator('#credential').inputValue()).toBe('');
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
}, 15000);

it('disables credential entry and dispatch in a UI-only deployment', async () => {
  const { page, url, state } = await fixture();
  await page.route(url + '/', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: (await response.text()).replace('<html lang="en">', '<html lang="en" data-ui-preview="true">') });
  });
  await page.reload();
  expect(await page.getByRole('note').textContent()).toContain('Backend not connected');
  expect(await page.getByLabel('API credential').isDisabled()).toBe(true);
  expect(await page.getByRole('button', { name: 'Connect', exact: true }).isDisabled()).toBe(true);
  await page.locator('#login').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(state.requests.filter(request => request.path === '/capabilities' || request.method === 'POST')).toEqual([]);
});

it('retains an accepted direct run through a history outage without a second invocation', async () => {
  const { page, state, connect } = await fixture();
  await connect();
  await page.getByText('No visible runs.', { exact: false }).waitFor();
  await page.getByText('Invoke an approved capability directly', { exact: true }).click();
  await page.locator('#fields input').fill('offline-member');
  state.offline = true;
  await page.getByRole('button', { name: 'Invoke capability', exact: true }).click();
  await page.getByText(`Accepted run: ${runId}.`, { exact: false }).waitFor();
  await page.getByText('Disconnected from run updates.', { exact: false }).waitFor();
  expect(await page.getByRole('button', { name: 'Invoke capability', exact: true }).isDisabled()).toBe(true);
  expect(await page.locator('#fields input').inputValue()).toBe('offline-member');
  expect(state.invocations.size).toBe(1);
  state.runs[0]!.state = 'success';
  state.offline = false;
  await page.locator('#refresh').click();
  await visible(page, '#runs', runId);
  await page.getByRole('button', { name: 'Start another invocation', exact: true }).waitFor();
  expect(state.requests.filter(r => r.path.endsWith('/invoke'))).toHaveLength(1);
}, 15000);

it('keeps exact-run locks through switch-away and unlocks only after fresh confirmation', async () => {
  const { page, state, connect } = await fixture();
  state.runs.push({ ...initialRun(), state: 'awaiting-human', intervention: {
    id: approvalId, expiresAt: Date.now() + 60000,
    request: { kind: 'locator_failed', reason: 'Repair fixture' },
  } });
  state.runs.push({ ...initialRun(), runId: secondRunId, state: 'awaiting-human', intervention: {
    id: secondApprovalId, expiresAt: Date.now() + 60000,
    request: { kind: 'locator_failed', reason: 'Second repair fixture' },
  } });
  await connect(operatorToken);
  const firstCard = page.locator(`[data-run-id="${runId}"]`);
  const secondCard = page.locator(`[data-run-id="${secondRunId}"]`);
  const firstReview = firstCard.getByRole('button', { name: 'Review request', exact: true });
  const secondReview = secondCard.getByRole('button', { name: 'Review request', exact: true });
  await firstReview.focus();
  await firstReview.click();
  const firstRetry = page.getByRole('button', { name: 'Retry after repair' });
  await firstRetry.waitFor();
  let posts = 0;
  let firstDecisionPath = '';
  let firstDecisionApproval = '';
  await page.route('**/decision', async route => {
    const body = JSON.parse(route.request().postData() ?? '{}') as { approvalId?: string };
    posts++;
    if (body.approvalId === approvalId) {
      firstDecisionPath = route.request().url();
      firstDecisionApproval = body.approvalId;
      state.offline = true;
      await route.abort();
    } else await route.continue();
  });
  await firstRetry.click();
  await page.getByText('Refresh to inspect authoritative state.', { exact: false }).waitFor();
  expect(await firstRetry.isDisabled()).toBe(true);
  await page.keyboard.press('Escape');
  expect(await page.locator('dialog').isVisible()).toBe(false);
  state.offline = false;
  await page.locator('#refresh').click();
  await secondReview.click();
  const secondRetry = page.getByRole('button', { name: 'Retry after repair' });
  await secondRetry.waitFor();
  expect(await secondRetry.isDisabled()).toBe(false);
  expect(posts).toBe(1);
  await page.keyboard.press('Escape');
  await page.clock.setFixedTime(Date.now() + 3_600_000);
  let releaseProbe!: () => void;
  const heldProbe = new Promise<void>(resolve => { releaseProbe = resolve; });
  let probes = 0;
  await page.route(`**/runs/${runId}`, async route => { probes++; await heldProbe; await route.continue(); });
  await page.locator('#refresh').click();
  await firstReview.click();
  await vi.waitFor(() => expect(probes).toBe(1));
  expect(await firstRetry.isDisabled()).toBe(true);
  await page.keyboard.press('Escape');
  expect(await page.locator('dialog').isVisible()).toBe(false);
  await secondReview.click();
  expect(await secondRetry.isDisabled()).toBe(false);
  releaseProbe();
  expect(await secondRetry.isDisabled()).toBe(false);
  await page.keyboard.press('Escape');
  await firstReview.click();
  await page.getByText('The server confirms this intervention is still pending.', { exact: false }).waitFor();
  expect(probes).toBe(1);
  await vi.waitFor(async () => expect(await firstRetry.isDisabled()).toBe(false));
  expect(posts).toBe(1);
  expect(state.decisions).toEqual([]);
  expect(firstDecisionPath).toContain(`/runs/${runId}/decision`);
  expect(firstDecisionApproval).toBe(approvalId);
  await page.unroute('**/decision');
  await firstRetry.click();
  await vi.waitFor(() => expect(state.decisions).toEqual(['retry']));
}, 15000);

it('keeps contact-update confirmation available when a hidden value collides with the capability name', async () => {
  const { page, state, connect, errors } = await fixture();
  const secrets = new Redactor();
  secrets.addSensitiveValues(['update', 'private-credential']);
  const capability = 'meridian-update-member';
  const intervention = publicIntervention({
    id: approvalId, expiresAt: Date.now() + 60000,
    request: { kind: 'risk_approval', reason: 'Review exact operation', capability, goal: 'Update contact', url: 'https://offline.example/members/9001/update' },
    action: {
      runId, artifact: capability, version: '1.0.0', stepId: 's13',
      destination: 'https://offline.example/members/9001/update?token=private-credential',
      method: 'POST', operator: 'offline-teller', branch: 'OFFLINE', role: 'TELLER',
      facts: { member: '9001', token: 'private-credential' }, visibleFacts: { member: '9001' }, tokenPresent: true, control: 'Save Changes',
    },
  }, secrets);
  state.runs.push({ ...initialRun(), capability, state: 'awaiting-human', intervention });
  await connect(operatorToken);
  await page.getByRole('button', { name: 'Review request', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  const confirm = dialog.getByRole('button', { name: 'Confirm contact update', exact: true });
  await confirm.waitFor();
  expect(await confirm.isDisabled()).toBe(false);
  await dialog.getByText('Target session: Verified for this run', { exact: false }).waitFor();
  expect(await dialog.innerText()).not.toContain('private-credential');
  expect(state.decisions).toEqual([]);

  // A real identity mismatch must still disable confirmation; masking cannot waive it.
  state.runs[0]!.intervention!.action!.artifact = 'meridian-place-hold';
  await page.keyboard.press('Escape');
  await page.locator('#refresh').click();
  await page.getByRole('button', { name: 'Review request', exact: true }).first().click();
  expect(await confirm.isDisabled()).toBe(true);
  expect(await dialog.getByRole('button', { name: 'Refuse request', exact: true }).isDisabled()).toBe(false);
  expect(state.decisions).toEqual([]);
  expect(errors).toEqual([]);
}, 15000);

it('fails closed for mismatched or incomplete action context while keeping refusal available', async () => {
  const { page, state, connect } = await fixture();
  const intervention = publicIntervention({
    id: approvalId,
    expiresAt: Date.now() + 60000,
    request: { kind: 'risk_approval', reason: 'Review exact operation', capability: capability.id, goal: 'Transfer fixture', url: 'https://offline.example/review' },
    action: {
      runId: 'different-run', artifact: capability.id, version: '1.0.0', stepId: 'post',
      destination: 'https://offline.example/post', method: 'POST', operator: 'offline-teller', branch: 'OFFLINE', role: 'TELLER',
      facts: { amount: '25.00' }, tokenPresent: true, control: 'Post',
    },
  });
  state.runs.push({ ...initialRun(), state: 'awaiting-human', intervention });
  await connect(operatorToken);
  const review = page.getByRole('button', { name: 'Review request', exact: true }).first();
  await review.click();
  const confirm = page.getByRole('button', { name: 'Confirm request', exact: true });
  const refuse = page.getByRole('button', { name: 'Refuse request', exact: true });
  await confirm.waitFor();
  expect(await confirm.isDisabled()).toBe(true);
  expect(await refuse.isDisabled()).toBe(false);
  state.runs[0] = {
    ...initialRun(), state: 'awaiting-human',
    intervention: publicIntervention({
      ...intervention,
      id: '33333333-3333-4333-8333-333333333333',
      action: { ...intervention.action!, runId, facts: {} },
    }),
  };
  await page.keyboard.press('Escape');
  await page.locator('#refresh').click();
  await review.click();
  expect(await page.getByRole('button', { name: 'Confirm request', exact: true }).isDisabled()).toBe(true);
  await page.getByRole('button', { name: 'Refuse request', exact: true }).click();
  await vi.waitFor(() => expect(state.decisions).toEqual(['abort']));
}, 15000);

it('renders strict and legacy business outcome codes while dropping arbitrary values', async () => {
  const { page, state, connect, evidenceDir } = await fixture();
  writeFileSync(join(evidenceDir, runId, 'log.jsonl'), [
    { event: 'replay.business_outcome', code: 'NO_SUCH_MEMBER' },
    { event: 'replay.business_outcome', outcomeCode: 'INSUFFICIENT_FUNDS' },
    { event: 'replay.business_outcome', outcomeCode: hostile },
  ].map(row => JSON.stringify(row)).join('\n'));
  state.runs.push({ ...initialRun(), state: 'success' });
  await connect();
  await page.getByText('Run details and evidence', { exact: true }).click();
  const timeline = page.getByRole('list', { name: 'Recorded step timeline' });
  await timeline.getByText('Code: NO_SUCH_MEMBER', { exact: true }).waitFor();
  await timeline.getByText('Code: INSUFFICIENT_FUNDS', { exact: true }).waitFor();
  expect(await timeline.innerText()).not.toContain(hostile);
}, 15000);

it('allows a separate direct inquiry after unknown posting without replaying the unknown capability', async () => {
  const { page, state, service, connect } = await fixture();
  const inquiry = { ...capability, id: 'meridian-member-inquiry' };
  service.catalog = () => [capability, inquiry];
  await connect();
  await page.getByText('Invoke an approved capability directly', { exact: true }).click();
  await page.locator('#fields input').fill('offline-member');
  await page.getByRole('button', { name: 'Invoke capability', exact: true }).click();
  await page.getByText(`Accepted run: ${runId}.`, { exact: false }).waitFor();
  state.runs[0]!.state = 'POST_OUTCOME_UNKNOWN';
  await page.locator('#refresh').click();
  await page.getByRole('button', { name: 'Choose a separate inquiry', exact: true }).click();
  await page.getByRole('button', { name: 'Invoke capability', exact: true }).click();
  await page.getByText('This capability has an unknown posting outcome.', { exact: false }).waitFor();
  expect(state.requests.filter(r => r.path.endsWith('/invoke'))).toHaveLength(1);
  await page.locator('#capability').selectOption(inquiry.id);
  await page.locator('#fields input').fill('offline-member');
  await page.getByRole('button', { name: 'Invoke capability', exact: true }).click();
  await vi.waitFor(() => expect(state.requests.filter(r => r.path.endsWith('/invoke'))).toHaveLength(2));
  expect(state.requests.filter(r => r.path.endsWith('/invoke')).map(r => r.path)).toEqual([
    `/capabilities/${capability.id}/invoke`, `/capabilities/${inquiry.id}/invoke`,
  ]);
}, 15000);

it.each(['direct', 'chat'] as const)('releases a confirmed pre-admission %s rejection without original-key recovery', async kind => {
  const { page, state, service, connect } = await fixture();
  const dir = mkdtempSync(join(tmpdir(), 'rejected-browser-'));
  const journal = new Journal(join(dir, 'journal'), 'r'.repeat(64));
  const profile = loadProfile('meridian');
  const actual = new RealInvocationService(journal, profilePolicy(profile), profile, dir, []);
  cleanup.push(async () => { journal.close(); rmSync(dir, { recursive: true, force: true }); });
  // Use the real admission boundary; the displayed capability is no longer authorized.
  service.invoke.mockImplementation((principal, id, args, key, role, lookupOnly) =>
    actual.invoke(principal as 'caller', id, args as Record<string, string | number>, key, role as 'TELLER', lookupOnly) as never);
  await connect();
  if (kind === 'direct') {
    await page.getByText('Invoke an approved capability directly', { exact: true }).click();
    await page.locator('#fields input').fill('offline-member');
    await page.getByRole('button', { name: 'Invoke capability', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'not authorized' }).waitFor();
    await vi.waitFor(async () => expect(await page.getByRole('button', { name: 'Invoke capability', exact: true }).isEnabled()).toBe(true));
  } else {
    await page.locator('#message').fill('Read this member');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await vi.waitFor(() => expect(service.invoke).toHaveBeenCalledOnce());
    await page.locator('#message').fill('Read another member');
    await vi.waitFor(async () => expect(await page.getByRole('button', { name: 'Send', exact: true }).isEnabled()).toBe(true));
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await vi.waitFor(() => expect(state.requests.filter(item => item.path === '/api/chat')).toHaveLength(2));
    expect(state.requests.filter(item => item.path === '/api/chat').at(-1)?.body.intent).toBe('auto');
  }
  expect(state.requests.filter(item => item.path === '/api/chat/request')).toHaveLength(0);
  expect(state.requests.filter(item => item.body?.lookupOnly)).toHaveLength(0);
  expect(journal.list()).toEqual([]);
}, 20000);

it('keeps polling after a terminal run waits on another operation to release readiness', async () => {
  const { page, state, service, connect } = await fixture();
  await connect();
  await page.getByText('Invoke an approved capability directly', { exact: true }).click();
  await page.locator('#fields input').fill('offline-member');
  await page.getByRole('button', { name: 'Invoke capability', exact: true }).click();
  await page.getByText(`Accepted run: ${runId}.`, { exact: false }).waitFor();
  state.runs[0]!.state = 'success';
  state.runs[0]!.memberIdentity = { status: 'unavailable' };
  service.availability = () => fixtureAvailability('temporarily_unavailable');
  await page.locator('#refresh').click();
  await visible(page, '#runs', 'success');
  // Allow the prior running-state interval and in-flight refresh to settle.
  await page.waitForTimeout(1800);
  const release = page.getByRole('button', { name: 'Start another invocation', exact: true });
  expect(await release.count()).toBe(0);
  service.availability = () => fixtureAvailability('available');
  await release.waitFor({ timeout: 5000 });
  expect(state.invocations.size).toBe(1);
  expect(state.requests.filter(request => request.path === '/api/chat')).toHaveLength(0);
}, 15000);

it('polls a terminal direct hold until exact capability availability recovers without resubmitting', async () => {
  const { page, state, service, connect } = await fixture();
  await connect();
  await page.getByText('Invoke an approved capability directly', { exact: true }).click();
  await page.locator('#fields input').fill('offline-member');
  await page.getByRole('button', { name: 'Invoke capability', exact: true }).click();
  await page.getByText(`Accepted run: ${runId}.`, { exact: false }).waitFor();
  state.runs[0]!.state = 'success';
  state.runs[0]!.memberIdentity = { status: 'verified', memberNumber: 'offline-member' };
  service.availability = () => fixtureAvailability('temporarily_unavailable');
  await page.locator('#refresh').click();
  expect(await page.getByRole('button', { name: 'Start another invocation', exact: true }).count()).toBe(0);

  await page.locator('#message').fill('Did that finish?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await vi.waitFor(() => expect(state.requests.filter(request => request.path === '/api/chat')).toHaveLength(1));
  const statusChat = state.requests.filter(request => request.path === '/api/chat').at(-1);
  expect(statusChat?.body.intent).toBe('status');
  expect(state.toolSchemas.at(-1)).toContain('run_status');
  expect(state.toolSchemas.at(-1)).not.toContain(capability.id);
  expect(state.invocations.size).toBe(1);

  service.availability = () => fixtureAvailability('available');
  const release = page.getByRole('button', { name: 'Start another invocation', exact: true });
  await release.waitFor({ timeout: 5000 });
  expect(state.invocations.size).toBe(1);
  expect(state.requests.filter(request => request.path === '/api/chat')).toHaveLength(1);
  await release.click();
  await page.locator('#fields input').fill('new-member');
  await page.getByRole('button', { name: 'Invoke capability', exact: true }).click();
  await vi.waitFor(() => expect(state.invocations.size).toBe(2));
}, 30000);

it.each(['direct', 'chat'] as const)('releases a completed non-Meridian %s action with authoritative empty availability', async kind => {
  // Capability names do not identify the application profile.
  const generic = { ...capability, id: 'meridian-funds-transfer' };
  const { page, state, connect, errors } = await fixture(false, () => [], { capability: generic, appId: 'cu-nexus' });
  await connect();
  if (kind === 'direct') {
    await page.getByText('Invoke an approved capability directly', { exact: true }).click();
    await page.locator('#fields input').fill('offline-member');
    await page.getByRole('button', { name: 'Invoke capability', exact: true }).click();
  } else {
    await page.route('**/api/chat/request', route => route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ kind: 'run', runId, capability: generic.id, state: 'running' }) }));
    await page.locator('#message').fill('Read this member');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
  }
  await vi.waitFor(() => expect(state.invocations.size).toBe(1));
  state.runs[0]!.state = 'success';
  state.runs[0]!.memberIdentity = { status: 'unavailable' };
  await page.locator('#refresh').click();
  if (kind === 'direct') {
    const release = page.getByRole('button', { name: 'Start another invocation', exact: true });
    await release.waitFor({ timeout: 5000 });
    await release.click();
    expect(await page.getByRole('button', { name: 'Invoke capability', exact: true }).isEnabled()).toBe(true);
  } else {
    await page.locator('#message').fill('Read another member');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await vi.waitFor(() => expect(state.requests.filter(item => item.path === '/api/chat')).toHaveLength(2));
    expect(state.requests.filter(item => item.path === '/api/chat').at(-1)?.body.intent).toBe('auto');
  }
  expect(errors).toEqual([]);
}, 20000);

const unusableAvailability: Array<[string, () => unknown]> = [
  ['empty', (): unknown[] => []],
  ['partial', (): unknown[] => [{ id: 'meridian-member-record', label: 'Member record', state: 'available', reason: 'Approved recording is ready' }]],
  ['missing', (): undefined => undefined],
];
it.each(unusableAvailability)('fails closed with %s availability metadata and sends no direct invoke POST', async (_kind, availability) => {
  const { page, state, connect } = await fixture(false, availability);
  await connect();
  await page.getByText('Invoke an approved capability directly', { exact: true }).click();
  expect(await page.getByRole('button', { name: 'Invoke capability', exact: true }).isDisabled()).toBe(true);
  expect(await page.getByText('Availability unavailable', { exact: true }).count()).toBe(7);
  expect(state.requests.filter(request => request.path.endsWith('/invoke'))).toHaveLength(0);
});

it('keeps the latest capability catalog when refresh metadata omits capabilities', async () => {
  const { page, service, connect } = await fixture();
  const inquiry = { ...capability, id: 'meridian-member-inquiry' };
  service.catalog = () => [inquiry];
  await connect();
  await page.getByText('Invoke an approved capability directly', { exact: true }).click();
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/capabilities')),
    page.locator('#refresh').click(),
  ]);
  expect(await page.locator('#capability option[value="meridian-member-inquiry"]').count()).toBe(1);
  await page.route('**/capabilities', async route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ principal: 'caller', availability: [] }),
  }));
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/capabilities')),
    page.locator('#refresh').click(),
  ]);
  expect(await page.locator('#capability option[value="meridian-member-inquiry"]').count()).toBe(1);
  await vi.waitFor(async () => expect(await page.getByText('Availability unavailable', { exact: true }).count()).toBe(7));
  await page.unroute('**/capabilities');
});

it('keeps capability selection available while a selected capability is blocked', async () => {
  const inquiry = { ...capability, id: 'meridian-member-inquiry' };
  let inquiryState: 'not_recorded' | 'available' = 'not_recorded';
  const labels = [
    ['meridian-sign-on', 'Sign on'],
    ['meridian-member-inquiry', 'Member inquiry'],
    ['meridian-member-record', 'Member record'],
    ['meridian-funds-transfer', 'Funds transfer'],
    ['meridian-open-share', 'Open share'],
    ['meridian-update-member', 'Update contact'],
    ['meridian-place-hold', 'Supervisor hold'],
  ];
  const { page, state, service, connect } = await fixture(false, () => labels.map(([id, label]) => ({
    id,
    label,
    state: id === inquiry.id ? inquiryState : id === capability.id ? 'available' : 'not_recorded',
    reason: id === inquiry.id && inquiryState === 'not_recorded' ? 'No approved recording' : 'Approved recording is ready',
  })));
  service.catalog = () => [capability, inquiry];
  await connect();
  await page.getByText('Invoke an approved capability directly', { exact: true }).click();
  await page.locator('#capability').selectOption(inquiry.id);
  expect(await page.locator('#capability').isDisabled()).toBe(false);
  expect(await page.getByRole('button', { name: 'Invoke capability', exact: true }).isDisabled()).toBe(true);
  inquiryState = 'available';
  await Promise.all([
    page.waitForResponse(response => response.url().endsWith('/capabilities')),
    page.locator('#refresh').click(),
  ]);
  await vi.waitFor(async () => expect(await page.getByRole('button', { name: 'Invoke capability', exact: true }).isDisabled()).toBe(false));
  await page.locator('#fields input').fill('offline-member');
  await page.getByRole('button', { name: 'Invoke capability', exact: true }).click();
  await page.getByText(`Accepted run: ${runId}.`, { exact: false }).waitFor();
  expect(state.requests.filter(request => request.path.endsWith('/invoke'))).toHaveLength(1);
  expect(state.requests.filter(request => request.path.endsWith('/invoke')).at(-1)?.path).toBe(`/capabilities/${inquiry.id}/invoke`);
});

it.each(['restored', 'chat'] as const)('blocks an unknown %s run after reload and reconnect while allowing a distinct inquiry', async (origin) => {
  const { page, state, service, connect } = await fixture();
  const inquiry = { ...capability, id: 'meridian-member-inquiry' };
  service.catalog = () => [capability, inquiry];
  if (origin === 'restored') state.runs.push({ ...initialRun(), state: 'POST_OUTCOME_UNKNOWN' });
  await connect();
  if (origin === 'chat') {
    await page.locator('#message').fill('Read offline-member shares');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('#messages [data-run-id]').waitFor();
    state.runs[0]!.state = 'POST_OUTCOME_UNKNOWN';
    await page.locator('#refresh').click();
  }
  await visible(page, '#runs', 'POST_OUTCOME_UNKNOWN');
  if (origin === 'chat') {
    await page.getByRole('button', { name: 'Start a separate request', exact: true }).click();
  }
  const before = state.requests.filter(r => r.path.endsWith('/invoke')).length;
  for (const transition of ['current', 'reload', 'reconnect']) {
    if (transition === 'reload') { await page.reload(); await connect(); }
    if (transition === 'reconnect') { await page.getByRole('button', { name: 'Disconnect', exact: true }).click(); await connect(); }
    await visible(page, '#runs', 'POST_OUTCOME_UNKNOWN');
    await page.getByText('Invoke an approved capability directly', { exact: true }).click();
    await page.locator('#fields input').fill('offline-member');
    await page.getByRole('button', { name: 'Invoke capability', exact: true }).click();
    await page.getByText('This capability has an unknown posting outcome.', { exact: false }).waitFor();
    expect(state.requests.filter(r => r.path.endsWith('/invoke'))).toHaveLength(before);
  }
  await page.locator('#capability').selectOption(inquiry.id);
  await page.locator('#fields input').fill('offline-member');
  await page.getByRole('button', { name: 'Invoke capability', exact: true }).click();
  await vi.waitFor(() => expect(state.requests.filter(r => r.path.endsWith('/invoke'))).toHaveLength(before + 1));
  expect(state.requests.filter(r => r.path.endsWith('/invoke')).at(-1)?.path).toBe(`/capabilities/${inquiry.id}/invoke`);
}, 20000);

it('status text shows the authoritative step and announces meaningful state changes without elapsed-time chatter', async () => {
  const { page, state, connect } = await fixture();
  state.runs.push({ ...initialRun(), step: hostile });
  await connect();
  const card = page.locator('#runs article');
  const status = card.locator('.badge[role="status"]');
  await status.waitFor();
  expect(await status.getAttribute('aria-live')).toBe('polite');
  expect(await status.getAttribute('aria-atomic')).toBe('true');
  expect(await status.innerText()).toContain(runId);
  await card.getByText(`Current step: ${hostile}`, { exact: true }).waitFor();
  expect(await card.locator('img').count()).toBe(0);
  const before = await status.textContent();
  state.runs[0]!.elapsedMs = 10000;
  await page.locator('#refresh').click();
  await card.getByText('Elapsed: 10.0 s', { exact: true }).waitFor();
  expect(await status.textContent()).toBe(before);
  const expectedLabels = {
    'awaiting-human': 'Awaiting review',
    success: 'Completed',
    business_outcome: 'Member not found',
    POST_OUTCOME_UNKNOWN: 'Unable to verify outcome',
  } as const;
  for (const next of ['awaiting-human', 'success', 'business_outcome', 'POST_OUTCOME_UNKNOWN'] as const) {
    state.runs[0]!.state = next;
    state.runs[0]!.step = 'safe-current-step';
    state.runs[0]!.result = next === 'success'
      ? { status: 'success' }
      : next === 'business_outcome' ? { status: next, outcomeCode: 'NO_SUCH_MEMBER' } : undefined;
    await page.locator('#refresh').click();
    await vi.waitFor(async () => expect(await status.textContent()).toContain(next));
    // Production break caught: replacing state labels with color or CSS classes would remove the status name from visible text.
    expect(await status.innerText()).toContain(expectedLabels[next]);
    if (next === 'business_outcome') {
      expect(await status.textContent()).toContain('Member not found');
      await card.getByText('Run details and evidence', { exact: true }).click();
      expect(await card.getByLabel('Raw run details').textContent()).toContain('NO_SUCH_MEMBER');
    }
  }
  await card.getByText('Current step: safe-current-step', { exact: true }).waitFor();
}, 15000);

it('labels history reuse as an existing run rather than a new operation', async () => {
  const { page, state, service, connect } = await fixture();
  state.runs.push({ ...initialRun(), state: 'success' });
  service.invoke.mockReturnValue({ runId, reused: true } as ReturnType<typeof service.invoke>);
  await connect();
  await page.locator('#message').fill('Read offline-member shares');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Using a previously accepted run. No new operation was started.', { exact: true }).waitFor();
  expect(state.invocations.size).toBe(0);
}, 15000);

it('infers new requests and status follow-ups without a request-type selector', async () => {
  const { page, state, service } = await fixture();
  const lookupKeys: string[] = [];
  await page.route('**/api/chat/request', async route => {
    lookupKeys.push(route.request().headers()['idempotency-key'] ?? '');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ kind: 'run', runId, capability: capability.id, state: 'running' }),
    });
  });
  await page.locator('#credential').fill(callerToken);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('#workspace').waitFor();
  await page.getByRole('button', { name: /^Activity/ }).click();
  expect(await page.getByLabel('Request type', { exact: true }).count()).toBe(0);
  // The fixture model always tries invocation, even when only status is authorized.
  await page.locator('#message').fill('Did that finish?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
  expect(state.invocations.size).toBe(0);
  await page.waitForTimeout(100);
  await page.locator('#message').fill('Read offline-member.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
  await vi.waitFor(() => expect(state.invocations.size).toBe(1));
  await vi.waitFor(() => expect(lookupKeys).toHaveLength(1));
  const originalKey = lookupKeys[0];
  state.runs[0]!.state = 'success';
  service.availability = () => fixtureAvailability('available');
  await page.locator('#refresh').dispatchEvent('click');
  await page.waitForTimeout(100);
  await page.getByText('Invoke an approved capability directly', { exact: true }).click();
  const directInvoke = page.getByRole('button', { name: 'Invoke capability', exact: true });
  await vi.waitFor(async () => expect(await directInvoke.isDisabled()).toBe(false));
  await page.locator('#message').fill('Did that finish?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await vi.waitFor(() => expect(state.requests.filter(request => request.path === '/api/chat')).toHaveLength(3));
  await page.getByText('Using a previously accepted run. No new operation was started.', { exact: true }).last().waitFor();
  expect(lookupKeys).toEqual([originalKey]);
  const statusChat = state.requests.filter(request => request.path === '/api/chat').at(-1);
  expect(statusChat?.body.intent).toBe('auto');
  expect(state.toolSchemas.at(-1)).toContain('run_status');
  expect(state.toolSchemas.at(-1)).not.toContain(capability.id);
  await vi.waitFor(() => expect(state.invocations.size).toBe(1));
  await page.locator('#message').fill('Read offline-member again.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await vi.waitFor(() => expect(state.invocations.size).toBe(2));
  const chatKeys = state.requests.filter(request => request.path === '/api/chat').map(request => request.key);
  expect(chatKeys).toHaveLength(4);
  expect(chatKeys[0]).toBeTruthy();
  expect(chatKeys[1]).toBeTruthy();
  expect(chatKeys[2]).not.toBe(originalKey);
  expect(chatKeys[3]).not.toBe(originalKey);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await page.locator('#credential').fill(callerToken);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await page.locator('#workspace').waitFor();
  expect(await page.getByLabel('Request type', { exact: true }).count()).toBe(0);
}, 15000);


it('can stop the response before any run output arrives without exposing a retry', async () => {
  const { page, model, connect } = await fixture();
  const original = model.doStream;
  let release!: () => void;
  const held = new Promise<void>(done => { release = done; });
  model.doStream = async options => { await held; return original(options); };
  try {
    await connect();
    await page.locator('#message').fill('Read offline-member.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByRole('button', { name: 'Stop response', exact: true }).click();
    await page.getByRole('button', { name: 'Send', exact: true }).waitFor();
  } finally { release(); }
}, 15000);

it.each([
  ['missing principal', { capabilities: [], availability: [] }],
  ['unsupported principal', { principal: 'supervisor', capabilities: [], availability: [] }],
  ['malformed subject identity', { principal: 'caller', subjectId: 'not-a-uuid', capabilities: [], availability: [] }],
] as const)('rejects %s capability authority during initial connect', async (_label, metadata) => {
  const { page, state } = await fixture();
  await page.route('**/capabilities', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(metadata),
  }));
  await page.locator('#credential').fill(callerToken);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await visible(page, '#status', 'Invalid capability authority');
  expect(await page.locator('#workspace').count()).toBe(0);
  expect(state.requests.filter(request => request.path === '/runs')).toHaveLength(0);
}, 15000);

it('keeps a replacement session connected when an old capability refresh is aborted during reconnect', async () => {
  const { page, state, connect } = await fixture(false, undefined, { holdRefreshCapabilities: true });
  await connect(callerToken);
  await vi.waitFor(() => expect(state.capabilityPartial).toBe(true));
  try {
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await page.locator('#credential').fill(callerToken);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByText('Connected as caller. Credentials remain in page memory.', { exact: true }).waitFor();
    await page.locator('#workspace').waitFor();
    await page.waitForTimeout(250);
    expect(await page.locator('#workspace').count()).toBe(1);
    expect(await page.locator('#status').innerText()).toBe('Connected as caller. Credentials remain in page memory.');
    expect(state.capabilityReads).toBeGreaterThanOrEqual(4);
  } finally {
    state.releaseCapabilityBody?.();
  }
}, 15000);

it.each([
  ['missing principal', { capabilities: [], availability: [] }],
  ['mismatched principal', { principal: 'caller', capabilities: [], availability: [] }],
  ['malformed subject identity', { principal: 'operator', subjectId: 'not-a-uuid', capabilities: [], availability: [] }],
  ['changed readiness policy', { principal: 'operator', capabilities: [], availability: [], readinessRequired: false }],
  ['malformed readiness policy', { principal: 'operator', capabilities: [], availability: [], readinessRequired: 'false' }],
] as const)('disconnects before publishing history or fetching watched extras when refresh authority is %s', async (_label, metadata) => {
  const { page, state, connect } = await fixture();
  state.runs.push({
    ...initialRun(),
    state: 'awaiting-human',
    intervention: { id: approvalId, expiresAt: Date.now() + 60000, request: { kind: 'locator_failed', reason: 'Review fixture' } },
  });
  await connect(operatorToken);
  const review = page.locator(`[data-run-id="${runId}"]`).getByRole('button', { name: 'Review request', exact: true });
  await review.click();
  await page.keyboard.press('Escape');
  const watchedReadsBefore = state.requests.filter(request => request.path === `/runs/${runId}`).length;
  let malformed = false;
  await page.route('**/capabilities', route => malformed
    ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(metadata) })
    : route.continue());
  state.runs.splice(0);
  malformed = true;
  await page.locator('#refresh').click();
  await page.locator('#workspace').waitFor({ state: 'detached' });
  expect(state.requests.filter(request => request.path === `/runs/${runId}`).length).toBe(watchedReadsBefore);
}, 15000);

it('disconnects when a subject refresh loses the authenticated subject identity', async () => {
  const { page, state, connect } = await fixture(false, undefined, { subjectTokens: [subjectCaller] });
  state.runs.push({
    ...initialRun(),
    state: 'awaiting-human',
    intervention: { id: approvalId, expiresAt: Date.now() + 60000, request: { kind: 'locator_failed', reason: 'Review fixture' } },
  });
  await connect(subjectCaller.token);
  const review = page.locator(`[data-run-id="${runId}"]`).getByRole('button', { name: 'Review request', exact: true });
  await review.click();
  await page.keyboard.press('Escape');
  let malformed = false;
  await page.route('**/capabilities', route => malformed
    ? route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ principal: 'caller', capabilities: [capability], availability: fixtureAvailability('available', 'available') }),
      })
    : route.continue());
  state.runs.splice(0);
  malformed = true;
  await page.locator('#refresh').click();
  await page.locator('#workspace').waitFor({ state: 'detached' });
  expect(state.requests.filter(request => request.path === `/runs/${runId}`)).toHaveLength(0);
}, 15000);

it('keeps saved conversation row controls keyboard reachable without a local shortcut', async () => {
  const { page, connect } = await fixture(true, undefined, { subjectTokens: [subjectCaller] });
  expect(await page.locator('#login-role').count()).toBe(0);
  expect(await page.getByText('TELLER1', { exact: false }).count()).toBe(0);
  const regularId = '30000000-0000-4000-8000-000000000001';
  const record = {
    id: regularId,
    archived: false,
    revision: 0,
    createdAt: '2026-09-08T00:00:00.000Z',
    updatedAt: '2026-09-08T00:00:00.000Z',
  };
  let deleted = false;
  const conversationRequests: string[] = [];
  await page.route('**/conversations**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    conversationRequests.push(`${request.method()} ${path}${url.search}`);
    if (request.method() === 'GET' && path === '/conversations') {
      const archived = url.searchParams.get('archived') === 'true';
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ conversations: !deleted && record.archived === archived ? [record] : [] }),
      });
    }
    if (request.method() === 'GET' && path === `/conversations/${regularId}/events`) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ events: [] }) });
    }
    if (request.method() === 'GET' && path === `/conversations/${regularId}`) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(record) });
    }
    if (request.method() === 'PATCH' && path === `/conversations/${regularId}`) {
      const body = request.postDataJSON() as { archived?: boolean };
      record.archived = body.archived === true;
      record.revision += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(record) });
    }
    if (request.method() === 'DELETE' && path === `/conversations/${regularId}`) {
      deleted = true;
      record.archived = true;
      return route.fulfill({ status: 204, body: '' });
    }
    return route.continue();
  });
  await connect(subjectCaller.token);
  await page.getByText('Dashboard access: Caller', { exact: true }).waitFor();
  const activity = page.getByRole('button', { name: 'Activity', exact: true });
  await activity.click();
  const savedConversations = page.getByRole('navigation', { name: 'Saved conversations', exact: true });
  await savedConversations.waitFor();
  const newConversation = savedConversations.getByRole('button', { name: 'New conversation', exact: true });
  expect(await page.locator('.sidebar').getByRole('navigation', { name: 'Saved conversations', exact: true }).count()).toBe(1);
  expect(await page.locator('.chat .conversation-navigation').count()).toBe(0);
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const navBounds = await savedConversations.boundingBox();
    const sidebarBounds = await page.locator('.sidebar').boundingBox();
    const mainBounds = await page.locator('.main-pane').boundingBox();
    expect(navBounds!.x).toBeGreaterThanOrEqual(sidebarBounds!.x);
    expect(navBounds!.x + navBounds!.width).toBeLessThanOrEqual(sidebarBounds!.x + sidebarBounds!.width);
    if (width > 700) expect(navBounds!.x + navBounds!.width).toBeLessThanOrEqual(mainBounds!.x);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: 'Disconnect', exact: true }).focus();
  await page.keyboard.press('Tab');
  expect(await newConversation.evaluate(element => element === document.activeElement)).toBe(true);
  // Production break caught: removing :focus-visible from saved-thread controls would hide the keyboard position.
  await expectKeyboardVisibleFocus(newConversation);
  expect(await newConversation.innerText()).toBe('New conversation');
  const open = savedConversations.getByRole('button', { name: 'Open Saved conversation', exact: true });
  await page.waitForTimeout(250);
  await page.keyboard.press('Tab');
  // Production break caught: removing a saved row's trigger from sequential focus would prevent keyboard opening.
  expect(await open.evaluate(element => element === document.activeElement)).toBe(true);
  await expectKeyboardVisibleFocus(open);
  await page.keyboard.press('Enter');
  await vi.waitFor(() => expect(conversationRequests.some(path => path === `GET /conversations/${regularId}/events?after=0&limit=100`)).toBe(true));
  const row = open.locator('..');
  const archive = row.getByRole('button', { name: 'Archive conversation', exact: true });
  const deleteRegular = row.getByRole('button', { name: 'Delete conversation', exact: true });
  await page.keyboard.press('Tab');
  expect(await archive.evaluate(element => element === document.activeElement)).toBe(true);
  // Production break caught: saved-row archive must remain visibly keyboard focusable.
  await expectKeyboardVisibleFocus(archive);
  await page.keyboard.press('Tab');
  expect(await deleteRegular.evaluate(element => element === document.activeElement)).toBe(true);
  // Production break caught: saved-row delete must remain visibly keyboard focusable.
  await expectKeyboardVisibleFocus(deleteRegular);
  await page.keyboard.press('Shift+Tab');
  expect(await archive.evaluate(element => element === document.activeElement)).toBe(true);
  await page.keyboard.press('Enter');
  await vi.waitFor(() => expect(record.archived).toBe(true));
  const restore = savedConversations.getByRole('button', { name: 'Restore conversation', exact: true });
  await restore.waitFor();
  await newConversation.focus();
  await page.keyboard.press('Tab');
  // Production break caught: a restored row's action must be reached by sequential keyboard traversal, not only by a script-driven focus call.
  expect(await restore.evaluate(element => element === document.activeElement)).toBe(true);
  // Production break caught: archived saved rows must expose a keyboard-reachable restore action.
  await expectKeyboardVisibleFocus(restore);
  await page.keyboard.press('Enter');
  await vi.waitFor(() => expect(record.archived).toBe(false));
  const restoredOpen = savedConversations.getByRole('button', { name: 'Open Saved conversation', exact: true });
  await restoredOpen.waitFor();
  const restoredRow = restoredOpen.locator('..');
  const archiveRestored = restoredRow.getByRole('button', { name: 'Archive conversation', exact: true });
  await newConversation.focus();
  await page.keyboard.press('Tab');
  expect(await restoredOpen.evaluate(element => element === document.activeElement)).toBe(true);
  await page.keyboard.press('Tab');
  expect(await archiveRestored.evaluate(element => element === document.activeElement)).toBe(true);
  // Production break caught: archiving the restored row must remain a real keyboard action in the natural control state.
  await page.keyboard.press('Enter');
  await vi.waitFor(() => expect(record.archived).toBe(true));
  const deleteArchived = savedConversations.getByRole('button', { name: 'Delete conversation', exact: true });
  const restoreAgain = savedConversations.getByRole('button', { name: 'Restore conversation', exact: true });
  await restoreAgain.waitFor();
  await newConversation.focus();
  await page.keyboard.press('Tab');
  expect(await restoreAgain.evaluate(element => element === document.activeElement)).toBe(true);
  await page.keyboard.press('Tab');
  // Production break caught: the archived Delete action must be activated from keyboard, not merely traversed.
  expect(await deleteArchived.evaluate(element => element === document.activeElement)).toBe(true);
  await expectKeyboardVisibleFocus(deleteArchived);
  await page.keyboard.press('Enter');
  await vi.waitFor(() => expect(deleted).toBe(true));
  await vi.waitFor(async () => expect(await page.getByRole('button', { name: /Open Saved conversation|Restore conversation/ }).count()).toBe(0));
  expect(conversationRequests).toContain(`PATCH /conversations/${regularId}`);
  expect(conversationRequests).toContain(`DELETE /conversations/${regularId}`);
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await savedConversations.waitFor({ state: 'detached' });
}, 15000);

it('keeps dashboard, chat, target, branch, and direct request roles distinct', async () => {
  const { page, connect } = await fixture();
  await connect(operatorToken);
  await page.getByText('Dashboard access: Operator', { exact: true }).waitFor();
  await page.getByText('Chat execution: Teller', { exact: true }).waitFor();
  await page.getByText('Target session: Not verified', { exact: true }).waitFor();
  await page.getByText('Branch: Not verified', { exact: true }).waitFor();
  await page.getByText('Invoke an approved capability directly', { exact: true }).click();
  await page.locator('#operator').selectOption('SUPERVISOR');
  await page.getByText('Direct request role: SUPERVISOR', { exact: true }).waitFor();
  await page.getByText('Chat execution remains Teller', { exact: false }).waitFor();
  expect(await page.getByText('Target session: Not verified', { exact: true }).count()).toBeGreaterThan(0);
  expect(await page.getByText('Branch: Not verified', { exact: true }).count()).toBeGreaterThan(0);
}, 15000);

it('operator Activity filters start in a review-first queue with accurate counts and keyboard focus', async () => {
  const staleRunId = '11111111-1111-4111-8111-333333333333';
  const noInterventionRunId = '11111111-1111-4111-8111-444444444444';
  const { page, state, connect } = await fixture();
  state.runs.push(
    { ...initialRun(), state: 'awaiting-human', intervention: { id: approvalId, expiresAt: Date.now() + 60000, request: { kind: 'locator_failed', reason: 'Needs review' } } },
    { ...initialRun(), runId: staleRunId, state: 'success', intervention: { id: secondApprovalId, expiresAt: Date.now() + 60000, request: { kind: 'locator_failed', reason: 'Stale intervention' } } },
    { ...initialRun(), runId: noInterventionRunId, state: 'awaiting-human' },
  );
  await connect(operatorToken);
  await page.getByRole('heading', { name: 'Operator Activity', exact: true }).waitFor();
  const needs = page.getByRole('tab', { name: /Needs review/ });
  const all = page.getByRole('tab', { name: /All runs/ });
  await vi.waitFor(async () => {
    expect(await needs.innerText()).toContain('(1)');
    expect(await all.innerText()).toContain('(3)');
  });
  expect(await needs.getAttribute('aria-selected')).toBe('true');
  expect(await page.locator(`#runs [data-run-id="${runId}"]`).count()).toBeGreaterThan(0);
  expect(await page.locator(`#runs [data-run-id="${staleRunId}"]`).count()).toBe(0);
  await needs.focus();
  await page.keyboard.press('Tab');
  expect(await all.evaluate(element => element === document.activeElement)).toBe(true);
  // Production break caught: removing :focus-visible styling from Activity tabs would hide the current filter during keyboard navigation.
  await expectKeyboardVisibleFocus(all);
  await page.keyboard.press('Shift+Tab');
  expect(await needs.evaluate(element => element === document.activeElement)).toBe(true);
  // Production break caught: the first Activity filter must retain a visible indicator when reached by reverse keyboard traversal.
  await expectKeyboardVisibleFocus(needs);
  await needs.focus();
  await page.keyboard.press('ArrowRight');
  expect(await all.getAttribute('aria-selected')).toBe('true');
  expect(await page.locator(`#runs [data-run-id="${staleRunId}"]`).count()).toBeGreaterThan(0);
  await page.keyboard.press('ArrowLeft');
  expect(await needs.getAttribute('aria-selected')).toBe('true');
  state.runs[0]!.state = 'success';
  await page.locator('#refresh').click();
  await vi.waitFor(async () => expect(await needs.innerText()).toContain('(0)'));
  expect(await page.locator(`#runs [data-run-id="${runId}"]`).count()).toBe(0);
}, 15000);

it('does not recover an opened review by id after authenticated history deliberately omits it', async () => {
  const { page, state, connect } = await fixture();
  state.runs.push({
    ...initialRun(),
    state: 'awaiting-human',
    sensitiveValuesUnavailable: true,
    intervention: { id: approvalId, expiresAt: Date.now() + 60000, request: {
      kind: 'replay_stuck', capability: 'meridian-member-inquiry',
      goal: 'Complete the linked identity check.',
      reason: 'Linked identity check needs operator attention.', url: '(unavailable)',
    } },
  });
  await connect(operatorToken);
  await page.locator(`[data-run-id="${runId}"]`).getByRole('button', { name: 'Review request', exact: true }).click();
  await page.keyboard.press('Escape');

  state.runs[0]!.state = 'failure';
  delete state.runs[0]!.intervention;
  state.historyHidden.add(runId);
  const refresh = async () => {
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/runs')),
      page.locator('#refresh').click(),
    ]);
  };
  await refresh();
  await refresh();

  expect(state.requests.filter(request => request.path === `/runs/${runId}`)).toHaveLength(0);
  await page.getByRole('tab', { name: /All runs/ }).click();
  expect(await page.locator(`#runs [data-run-id="${runId}"]`).count()).toBe(0);
}, 15000);

it('gives callers history and operator-support guidance without takeover controls', async () => {
  const { page, state, connect } = await fixture();
  state.runs.push({
    ...initialRun(),
    state: 'awaiting-human',
    intervention: { id: approvalId, expiresAt: Date.now() + 60000, request: { kind: 'risk_approval', reason: 'Operator review required' } },
  });
  await connect(callerToken);
  await page.getByText('Run history', { exact: true }).waitFor();
  await page.getByText('If this request needs an operator, it will remain waiting here.', { exact: true }).waitFor();
  expect(await page.getByRole('button', { name: /take over|transfer|assign/i }).count()).toBe(0);
  expect(await page.getByRole('button', { name: 'Review request', exact: true }).count()).toBe(1);
  await page.getByRole('button', { name: 'Review request', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  expect(await page.getByRole('dialog').getByRole('button', { name: /Confirm|Refuse|Retry|Stop/ }).count()).toBe(0);
}, 15000);

it.each(['running', 'awaiting-human'] as const)('blocks unrecorded discovery after reconnect while a run is %s', async (runState) => {
  const { page, state, connect } = await fixture();
  state.runs.push({ ...initialRun(), state: runState });
  await connect(operatorToken);
  for (const reconnect of [false, true]) {
    if (reconnect) {
      await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
      await connect(operatorToken);
    }

    const guided = page.locator('.guided-operations');
    expect(await guided.getByLabel('Operation').inputValue()).toBe('meridian-funds-transfer');
    await vi.waitFor(async () => expect(await guided.textContent()).toContain('Another operation is active. Resolve its current run before starting another operation.'));
    expect(await guided.getByRole('button', { name: 'Start supervised discovery', exact: true }).count()).toBe(0);

  }
  state.runs[0]!.state = 'success';
  await page.locator('#refresh').click();
  const guided = page.locator('.guided-operations');
  await vi.waitFor(async () => expect(await guided.getByRole('button', { name: 'Preview request', exact: true }).isDisabled()).toBe(false));
  await guided.getByText('No approved recording exists. An operator may explicitly start supervised discovery for a private draft.', { exact: true }).waitFor();
  expect(state.requests.filter(request => request.path.endsWith('/discover'))).toEqual([]);
}, 20000);
