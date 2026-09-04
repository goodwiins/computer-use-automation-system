import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Journal } from '../src/runtime/journal.js';
import { InvocationService } from '../src/server/service.js';
import * as runtime from '../src/runtime/run.js';
import { loadProfile, type LiveControl } from '../src/runtime/profile.js';
import { Policy } from '../src/safety/policy.js';
import { RunLogger } from '../src/evidence/logger.js';
import { Redactor } from '../src/safety/redact.js';
import { CapabilityArtifact } from '../src/artifact/schema.js';
import { GuardedSurface, RunAbortedError } from '../src/surface/guarded.js';
import { BrowserSurface } from '../src/surface/browser.js';
import { ControlSession } from '../src/escalation/session.js';
import { runDiscovery } from '../src/agent/loop.js';
import { runReplay } from '../src/replay/executor.js';
import type { Surface } from '../src/surface/types.js';

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'runtime-lifecycle-')); dirs.push(dir); return dir; };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const origin = 'https://web-sample.interface-hiring.com';
const profile = loadProfile('meridian');
const policy = Policy.parse({ allowedOrigins: [origin], allowedActions: ['navigate', 'click', 'fill', 'select', 'extract', 'assert'], riskHandling: { read: 'allow', reversible_write: 'allow', irreversible: 'allow' } });
const target = { description: 'post', strategies: [{ kind: 'nameAttr' as const, name: 'submit' }] };
const report = { strategyUsed: 0, kind: 'nameAttr', matches: 1 };
function fixtureSurface(): Surface {
  return { start: async () => {}, navigate: async () => {}, currentUrl: () => `${origin}/members/1/hold/review`, frameUrls: () => [`${origin}/members/1/hold/review`], observe: async () => ({ url: `${origin}/members/1/hold/review`, title: '', frames: [] }), click: async () => report, fill: async () => report, select: async () => report, readText: async () => ({ text: 'done', report }), isTextVisible: async text => text === 'done', describeTarget: async t => t, screenshot: async () => {}, close: async () => {} };
}
function fixtureArtifact(click = false) {
  return CapabilityArtifact.parse({ schemaVersion: 2, id: 'hold', name: 'hold', description: 'fixture hold', version: '1.0.0', status: 'approved', app: { appId: 'meridian', entryUrl: `${origin}/signon`, allowedOrigins: [origin] }, parameters: [], outputs: [], steps: click ? [{ id: 'post', action: 'click', intent: 'post', target, risk: 'irreversible' }] : [{ id: 'verify', action: 'assert', intent: 'verify', assert: { kind: 'textVisible', text: 'done' } }], successCondition: { kind: 'textVisible', text: 'done' }, provenance: { discoveredAt: '', model: 'offline', discoveryRunId: 'offline', goal: 'offline failure injection' } });
}

it('releases the API slot and finalizes the journal when runtime construction fails', () => {
  vi.stubEnv('MERIDIAN_TELLER_OPERATOR', 'fixture'); vi.stubEnv('MERIDIAN_TELLER_PASSWORD', 'fixture'); vi.stubEnv('MERIDIAN_BRANCH', 'MAIN-001');
  const dir = temp(); const journal = new Journal(join(dir, 'journal'), 'review-journal-key-at-least-32-characters');
  const service = new InvocationService(journal, policy, profile, dir, ['meridian-sign-on']);
  const construct = vi.spyOn(runtime, 'createRuntime').mockImplementation(() => { throw new Error('Injected runtime startup failure'); });
  try {
    expect(() => service.invoke('caller', 'meridian-sign-on', {}, 'first')).toThrow('Injected runtime startup failure');
    const first = [...journal.records.values()][0]!;
    expect(service.invoke('caller', 'meridian-sign-on', {}, 'first')).toEqual({ runId: first.runId });
    expect(service.get('caller', first.runId).state).toBe('failure');
    let nextError = '';
    try { service.invoke('caller', 'meridian-sign-on', {}, 'second'); } catch (e) { nextError = (e as Error).message; }
    const actual = { states: [...journal.records.values()].map(r => r.state), constructs: construct.mock.calls.length, nextError };
    expect(actual).toEqual({ states: ['failure', 'failure'], constructs: 2, nextError: 'Injected runtime startup failure' });
  } finally { journal.close(); }
});

it('retains verified completion when browser cleanup throws', async () => {
  const logger = new RunLogger('replay', new Redactor(), temp(), true);
  const surface = fixtureSurface(); surface.mutationDispatched = true;
  const close = vi.fn(async () => { throw new Error('Injected browser cleanup failure'); });
  const candidate = { surface, logger, close } as unknown as ReturnType<typeof runtime.createRuntime>;
  const outcome = await runtime.executeReplay(fixtureArtifact(), {}, candidate, policy).then(result => ({ result }), error => ({ error: (error as Error).message }));
  const persisted = JSON.parse(readFileSync(join(logger.dir, 'result.json'), 'utf8'));
  expect(persisted.status).toBe('success');
  expect(outcome).toHaveProperty('result.status', 'success');
  expect(readFileSync(join(logger.dir, 'log.jsonl'), 'utf8')).toContain('RUNTIME_CLEANUP_FAILED');
  expect(readFileSync(join(logger.dir, 'log.jsonl'), 'utf8')).not.toContain('Injected browser cleanup failure');
});

it('preserves the original replay error even when cleanup and warning persistence fail', async () => {
  const logger = new RunLogger('replay', new Redactor(), temp(), true);
  const original = new Error('Evidence unavailable');
  vi.spyOn(logger, 'log').mockImplementation(() => { throw original; });
  const candidate = { surface: fixtureSurface(), logger, close: async () => { throw new Error('Cleanup failed'); } } as unknown as ReturnType<typeof runtime.createRuntime>;
  await expect(runtime.executeReplay(fixtureArtifact(), {}, candidate, policy)).rejects.toBe(original);
});

it('isolates deadline notification failures and still closes the browser', async () => {
  vi.useFakeTimers();
  const browserClose = vi.spyOn(BrowserSurface.prototype, 'close').mockResolvedValue();
  const candidate = runtime.createRuntime({
    kind: 'discovery', artifact: 'fixture', version: '1.0.0', policy,
    params: {}, sensitive: [], gate: async () => true, evidenceDir: temp(),
    onClose: () => { throw new Error('Injected private deadline callback failure'); },
  });

  await vi.advanceTimersByTimeAsync(600_000);

  expect(browserClose).toHaveBeenCalledOnce();
  const log = readFileSync(join(candidate.logger.dir, 'log.jsonl'), 'utf8');
  expect(log).toContain('RUNTIME_CLEANUP_FAILED');
  expect(log).not.toContain('Injected private deadline callback failure');
});

it('classifies discovery startup denial before model or escalation', async () => {
  const surface = fixtureSurface();
  surface.start = async () => { throw new RunAbortedError('navigate'); };
  const create = vi.fn();
  const escalate = vi.fn();
  const logger = new RunLogger('discovery', new Redactor(), temp(), true);

  const result = await runDiscovery('read', `${origin}/signon`, {}, [origin], {
    surface, logger,
    openai: { chat: { completions: { create } } } as unknown as Parameters<typeof runDiscovery>[4]['openai'],
    model: 'offline', maxSteps: 1, escalate,
  });

  expect(result).toMatchObject({ status: 'stopped', stopReason: 'RUN_ABORTED', finalUrl: `${origin}/signon` });
  expect(create).not.toHaveBeenCalled();
  expect(escalate).not.toHaveBeenCalled();
});

it('closes a constructed runtime before releasing the slot after setup fails', async () => {
  const dir = temp(); const artifactDir = temp();
  const artifact = fixtureArtifact(); artifact.app.appId = 'cu-nexus';
  writeFileSync(join(artifactDir, 'fixture.json'), JSON.stringify(artifact));
  const journal = new Journal(join(dir, 'journal'), 'review-journal-key-at-least-32-characters');
  const service = new InvocationService(journal, policy, loadProfile('cu-nexus'), dir, ['hold'], artifactDir);
  let release!: () => void;
  const closing = new Promise<void>(resolve => { release = resolve; });
  const close = vi.fn(() => closing);
  const construct = vi.spyOn(runtime, 'createRuntime').mockReturnValue({ close, logger: new RunLogger('replay', new Redactor(), dir, true) } as unknown as ReturnType<typeof runtime.createRuntime>);
  vi.spyOn(journal, 'update').mockImplementationOnce(() => { throw new Error('Setup journal write failed'); });
  try {
    expect(() => service.invoke('caller', 'hold', {}, 'first')).toThrow('Setup journal write failed');
    expect([...journal.records.values()].map(r => r.state)).toEqual(['failure']);
    expect(close).toHaveBeenCalledOnce();
    expect(() => service.invoke('caller', 'hold', {}, 'second')).toThrow('One run is active');
    release();
    await service.close();
    construct.mockImplementation(() => { throw new Error('Next setup attempted'); });
    expect(() => service.invoke('caller', 'hold', {}, 'second')).toThrow('Next setup attempted');
    expect([...journal.records.values()].map(r => r.state)).toEqual(['failure', 'failure']);
  } finally { release(); await service.close(); journal.close(); }
});

it.each(['replay', 'discovery', 'recovery'])('treats denied posting approval as terminal in %s', async mode => {
  const inner = fixtureSurface();
  const live: LiveControl = { url: `${origin}/members/1/hold/review`, destination: `${origin}/members/1/hold/post`, method: 'POST', control: 'Apply Hold', submit: true, operator: 'SUPER1', branch: 'MAIN-001', role: 'SUPERVISOR', conditions: [], facts: { share: '1-A', reason: 'FRAUD' }, tokenPresent: true, error: false };
  const dispatch = vi.fn(async () => report);
  inner.prepareClick = async () => ({ inspect: async () => live, dispatch });
  const gate = vi.fn(async () => false); const beforeDispatch = vi.fn();
  const surface = new GuardedSurface(inner, policy, gate, undefined, { profile, session: new ControlSession(), deadline: Date.now() + 10000, runId: 'offline', artifact: 'hold', version: '1.0.0', operator: 'super1', role: 'SUPERVISOR', branch: 'MAIN-001', beforeDispatch });
  const escalate = vi.fn(async () => 'abort' as const);
  const logger = new RunLogger(mode === 'discovery' ? 'discovery' : 'replay', new Redactor(), temp(), true);
  if (mode === 'discovery') {
    const create = vi.fn(async () => ({ choices: [{ message: { tool_calls: [{ id: 'post', type: 'function', function: { name: 'click', arguments: JSON.stringify({ nameAttr: 'submit', risk: 'irreversible', reason: 'post' }) } }] } }] }));
    const openai = { chat: { completions: { create } } } as unknown as Parameters<typeof runDiscovery>[4]['openai'];
    const result = await runDiscovery('post', `${origin}/signon`, {}, [origin], { surface, logger, openai, model: 'offline', maxSteps: 4, escalate });
    expect(result).toMatchObject({ status: 'stopped', stopReason: 'RUN_ABORTED' });
    expect(create).toHaveBeenCalledOnce();
  } else {
    const artifact = fixtureArtifact(true);
    if (mode === 'recovery') artifact.detectors = [{ id: 'recover', description: 'recover', classification: 'recoverable', match: { kind: 'textVisible', text: 'done' }, recovery: { action: 'click', target } }];
    const result = await runReplay(artifact, {}, { surface, logger, policy, escalate });
    expect(result).toMatchObject({ status: 'failure', failure: { code: 'RUN_ABORTED' }, escalated: false });
  }
  expect(gate).toHaveBeenCalledOnce(); expect(dispatch).not.toHaveBeenCalled(); expect(beforeDispatch).not.toHaveBeenCalled();
  expect(escalate).not.toHaveBeenCalled();
});

it.each([false, true])('keeps API journal and saved result consistent after verified completion; cleanupFails=%s', async cleanupFails => {
  const dir = temp(); const artifactDir = temp();
  const artifact = fixtureArtifact(); artifact.app.appId = 'cu-nexus';
  writeFileSync(join(artifactDir, 'fixture.json'), JSON.stringify(artifact));
  const journal = new Journal(join(dir, 'journal'), 'review-journal-key-at-least-32-characters');
  const service = new InvocationService(journal, policy, loadProfile('cu-nexus'), dir, ['hold'], artifactDir);
  vi.spyOn(runtime, 'createRuntime').mockImplementation(options => {
    const surface = fixtureSurface();
    surface.start = async () => { options.beforeDispatch?.({} as never); surface.mutationDispatched = true; };
    const logger = new RunLogger('replay', new Redactor(), dir, true, options.runId);
    return { surface, logger, redactor: new Redactor(), promptRedactor: new Redactor(), session: options.session,
        browser: { page: {} }, close: async () => { if (cleanupFails) throw new Error('Injected browser cleanup failure'); }, deadline: Date.now() + 10000,
    } as unknown as ReturnType<typeof runtime.createRuntime>;
  });
  try {
    const { runId } = service.invoke('caller', 'hold', {}, 'cleanup-api');
    await vi.waitFor(() => expect(journal.records.get(runId)?.state).not.toBe('dispatching'));
    const saved = JSON.parse(readFileSync(join(dir, runId, 'result.json'), 'utf8'));
    const view = service.get('caller', runId);
    expect(saved.status).toBe('success');
    expect(view.state).toBe('success');
    expect(view.result).toMatchObject({ status: 'success' });
  } finally { await service.close().catch(() => {}); journal.close(); }
});
