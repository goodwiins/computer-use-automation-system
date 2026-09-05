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
import { checkDetectors } from '../src/replay/detectors.js';
import { InsufficientFundsError } from '../src/replay/outcomes.js';
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
  const live: LiveControl = { url: `${origin}/members/1/hold/review`, destination: `${origin}/members/1/hold/post`, method: 'POST', control: 'Apply Hold', submit: true, operator: 'SUPER1', branch: 'MAIN-001', role: 'SUPERVISOR', conditions: [], facts: { share: '1-A', reason: 'FRAUD' }, tokenPresent: true, error: false, frame: { id: 'hold-workarea', name: 'workarea', url: `${origin}/members/1/hold/review`, navigation: 0 } };

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
    expect(result).toMatchObject({ status: 'failure', failure: { code: mode === 'recovery' ? 'RECOVERY_FAILED' : 'RUN_ABORTED' }, escalated: false });
  }
  expect(gate).toHaveBeenCalledTimes(mode === 'recovery' ? 0 : 1); expect(dispatch).not.toHaveBeenCalled(); expect(beforeDispatch).not.toHaveBeenCalled();
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


function discoveryConditionFixture() {
  const inner = fixtureSurface();
  let visible = '';
  inner.isTextVisible = vi.fn(async text => text === visible);
  const surface = new GuardedSurface(inner, policy, async () => true);
  const create = vi.fn(async () => ({ choices: [{ message: { tool_calls: [{ id: 'fixture', type: 'function', function: { name: 'done', arguments: '{}' } }] } }] }));
  const escalate = vi.fn(async () => 'retry' as const);
  const logger = new RunLogger('discovery', new Redactor(), temp(), true);
  const deps: Parameters<typeof runDiscovery>[4] = {
    surface, logger, openai: { chat: { completions: { create } } } as unknown as Parameters<typeof runDiscovery>[4]['openai'],
    model: 'offline', maxSteps: 5, escalate, detectors: profile.detectors,
  };
  return { inner, surface, create, escalate, logger, deps,
    show: (id: string) => { const d = profile.detectors.find(d => d.id === id)!; visible = d.match.kind === 'textVisible' ? d.match.text : ''; },
    clear: () => { visible = ''; },
    run: () => runDiscovery('fixture', `${origin}/signon`, {}, [origin], deps),
  };
}

it.each(profile.detectors.filter(d => d.classification !== 'recoverable'))('stops discovery for profile condition $id before model or approval', async detector => {
  const f = discoveryConditionFixture(); f.show(detector.id);
  expect(await checkDetectors(f.surface, { detectors: profile.detectors })).toEqual(detector);
  const result = await f.run();
  expect(result).toMatchObject({ status: 'stopped', stopReason: detector.outcomeCode });
  expect(result.trace).toEqual([]);
  expect(f.create).not.toHaveBeenCalled(); expect(f.escalate).not.toHaveBeenCalled();
});

it.each(profile.detectors.filter(d => d.classification !== 'recoverable').flatMap(detector =>
  ['done', 'click', 'model-failure', 'observe-failure', 'action-failure'].map(stage => ({ detector, stage }))))('checks $detector.id appearing during $stage before accepting success or retry', async ({ detector, stage }) => {
  const f = discoveryConditionFixture();
  const click = vi.spyOn(f.inner, 'click').mockImplementation(async () => { f.show(detector.id); throw new Error('PRIVATE action failed'); });
  if (stage === 'observe-failure') f.inner.observe = async () => { f.show(detector.id); throw new Error('PRIVATE observation failed'); };
  else f.create.mockImplementation(async () => {
    if (stage !== 'action-failure') f.show(detector.id);
    if (stage === 'model-failure') throw new Error('PRIVATE model failed');
    return { choices: [{ message: { tool_calls: [{ id: 'fixture', type: 'function', function: { name: stage === 'done' ? 'done' : 'click', arguments: JSON.stringify({ text: 'Continue', reason: 'fixture' }) } }] } }] };
  });
  expect(await f.run()).toMatchObject({ status: 'stopped', stopReason: detector.outcomeCode });
  expect(f.create).toHaveBeenCalledTimes(stage === 'observe-failure' ? 0 : 1);
  expect(click).toHaveBeenCalledTimes(stage === 'action-failure' ? 1 : 0);
  expect(f.escalate).not.toHaveBeenCalled();
});

it.each(['cleared', 'persistent', 'another-condition', 'same-route', 'throws', 'abort'] as const)('bounds guarded discovery recovery and refuses continuation: %s', async mode => {
  const f = discoveryConditionFixture(); f.show('maintenance');
  const click = vi.spyOn(f.surface, 'recoverClick');
  const dispatch = vi.spyOn(f.inner, 'click').mockImplementation(async () => {
    if (mode === 'abort') throw new RunAbortedError('click');
    if (mode === 'throws') throw new Error('PRIVATE recovery failure');
    if (mode !== 'persistent') f.clear();
    if (mode === 'another-condition') f.show('server');
    if (mode !== 'same-route') f.inner.currentUrl = () => `${origin}/menu`;
    return report;
  });
  const result = await f.run();
  expect(result).toMatchObject({ status: 'stopped', stopReason: mode === 'abort' ? 'RUN_ABORTED' : mode === 'another-condition' ? 'APPLICATION_ERROR' : ['persistent', 'throws'].includes(mode) ? 'RECOVERY_FAILED' : 'RECOVERY_CHECKPOINT_REQUIRED' });
  expect(click).toHaveBeenCalledExactlyOnceWith(profile.detectors.find(d => d.id === 'maintenance')!.recovery!.target);
  expect(dispatch).toHaveBeenCalledOnce(); expect(result.trace).toEqual([]);
  expect(f.surface.effectiveRisk).toBe('reversible_write');
  expect(f.create).not.toHaveBeenCalled(); expect(f.escalate).not.toHaveBeenCalled();
  const events = readFileSync(join(f.logger.dir, 'log.jsonl'), 'utf8');
  expect(events).toContain('detector.recovering'); expect(events).not.toContain('PRIVATE');
});

it.each(['validation-injected', 'permission', 'maintenance'])('keeps post-intent condition %s unknown without another model call or recovery', async id => {
  const f = discoveryConditionFixture();
  f.create.mockResolvedValue({ choices: [{ message: { tool_calls: [{ id: 'fixture', type: 'function', function: { name: 'click', arguments: JSON.stringify({ text: 'Post', reason: 'fixture' }) } }] } }] });
  const click = vi.spyOn(f.inner, 'click').mockImplementation(async () => { f.surface.mutationDispatched = true; f.show(id); return report; });
  expect(await f.run()).toMatchObject({ status: 'stopped', stopReason: 'POST_OUTCOME_UNKNOWN' });
  expect(f.create).toHaveBeenCalledOnce(); expect(click).toHaveBeenCalledOnce(); expect(f.escalate).not.toHaveBeenCalled();
  expect(readFileSync(join(f.logger.dir, 'log.jsonl'), 'utf8')).not.toContain('detector.recovering');
});

it.each(['business', 'abort', 'unknown'] as const)('retains typed discovery terminal precedence: %s', async mode => {
  const f = discoveryConditionFixture();
  f.create.mockResolvedValue({ choices: [{ message: { tool_calls: [{ id: 'fixture', type: 'function', function: { name: 'click', arguments: JSON.stringify({ text: 'Continue', reason: 'fixture' }) } }] } }] });
  f.inner.click = async () => { f.show('permission'); f.surface.mutationDispatched = mode === 'unknown'; throw mode === 'abort' ? new RunAbortedError('click') : new InsufficientFundsError(); };
  expect(await f.run()).toMatchObject({ status: mode === 'business' ? 'business_outcome' : 'stopped', stopReason: mode === 'business' ? 'INSUFFICIENT_FUNDS' : mode === 'abort' ? 'RUN_ABORTED' : 'POST_OUTCOME_UNKNOWN' });
  expect(f.create).toHaveBeenCalledOnce(); expect(f.escalate).not.toHaveBeenCalled();
});

it.each([false, true])('keeps condition-free verified discovery success: dispatched=%s', async dispatched => {
  const f = discoveryConditionFixture(); f.surface.mutationDispatched = dispatched;
  const validateCompletion = vi.fn(); f.deps.validateCompletion = validateCompletion;
  expect(await f.run()).toMatchObject({ status: 'success' });
  expect(validateCompletion).toHaveBeenCalledOnce(); expect(f.create).toHaveBeenCalledOnce();
});

it('keeps discovery without strict profile integration generic', async () => {
  const f = discoveryConditionFixture(); f.show('permission'); delete f.deps.detectors;
  expect(await f.run()).toMatchObject({ status: 'success' });
  expect(f.inner.isTextVisible).not.toHaveBeenCalled();
});


it.each(['discovery', 'replay'] as const)('requires guarded recovery support in strict %s', async mode => {
  const f = discoveryConditionFixture(); f.show('maintenance'); f.deps.surface = f.inner;
  const click = vi.spyOn(f.inner, 'click');
  const result = mode === 'discovery' ? await f.run() : await runReplay({ ...fixtureArtifact(), detectors: profile.detectors }, {}, { surface: f.inner, logger: f.logger, policy, escalate: f.escalate });
  expect(result.status).toBe(mode === 'discovery' ? 'stopped' : 'failure');
  expect(click).not.toHaveBeenCalled(); expect(f.escalate).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
});

it.each(['discovery', 'replay'] as const)('uses inspected nonmutation recovery only in %s', async mode => {
  for (const hazard of ['none', 'mutation', 'approval', 'post-intent'] as const) {
    const f = discoveryConditionFixture(); f.show('maintenance');
    const live: LiveControl = { url: f.inner.currentUrl(), destination: `${origin}/menu`, method: 'GET', control: 'Continue', submit: false, operator: 'SUPER1', branch: 'MAIN-001', role: 'SUPERVISOR', conditions: [], facts: {}, tokenPresent: true, error: false };
    if (hazard === 'mutation') Object.assign(live, { destination: `${origin}/members/1/hold/post`, method: 'POST', control: 'Apply Hold', submit: true });
    const dispatch = vi.fn(async () => { f.clear(); f.inner.isTextVisible = async text => text === 'done'; return report; });
    f.inner.prepareClick = async () => ({ inspect: async () => live, dispatch });
    const gate = vi.fn(async () => true); const beforeDispatch = vi.fn();
    const recoveryPolicy = hazard === 'approval' ? { ...policy, riskHandling: { ...policy.riskHandling, reversible_write: 'confirm' as const } } : policy;
    const surface = new GuardedSurface(f.inner, recoveryPolicy, gate, undefined, { profile, session: new ControlSession(), deadline: Date.now() + 10000, runId: 'fixture', artifact: 'hold', version: '1.0.0', operator: 'super1', role: 'SUPERVISOR', branch: 'MAIN-001', beforeDispatch });
    surface.mutationDispatched = hazard === 'post-intent'; f.deps.surface = surface;
    const result = mode === 'discovery' ? await f.run() : hazard === 'post-intent'
      ? await surface.recoverClick(profile.detectors.find(d => d.id === 'maintenance')!.recovery!.target!).then(() => 'unexpected', () => ({ status: 'failure' }))
      : await runReplay({ ...fixtureArtifact(), detectors: profile.detectors }, {}, { surface, logger: f.logger, policy: recoveryPolicy, escalate: f.escalate });
    expect(result).toHaveProperty('status', mode === 'discovery' ? 'stopped' : hazard === 'none' ? 'success' : 'failure');
    expect(dispatch).toHaveBeenCalledTimes(hazard === 'none' ? 1 : 0);
    expect(gate).not.toHaveBeenCalled(); expect(beforeDispatch).not.toHaveBeenCalled(); expect(f.escalate).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
  }
});


it.each(['check-error', 'untrusted-code'] as const)('fails closed with safe discovery evidence: %s', async mode => {
  const f = discoveryConditionFixture();
  if (mode === 'check-error') f.inner.isTextVisible = async () => { throw new Error('PRIVATE detector read failed'); };
  else { f.show('permission'); f.deps.detectors = profile.detectors.map(d => ({ ...d, outcomeCode: 'PRIVATE-DYNAMIC-CODE' })); }
  expect(await f.run()).toMatchObject({ status: 'stopped', stopReason: mode === 'check-error' ? 'DISCOVERY_CONDITION_CHECK_FAILED' : 'DISCOVERY_FAILED' });
  expect(f.create).not.toHaveBeenCalled(); expect(f.escalate).not.toHaveBeenCalled();
  expect(readFileSync(join(f.logger.dir, 'log.jsonl'), 'utf8')).not.toContain('PRIVATE');
});

it.each(['model', 'observe'] as const)('preserves explicit cancellation from %s before condition recovery', async stage => {
  const f = discoveryConditionFixture();
  const abort = async () => { f.show('maintenance'); throw new RunAbortedError(stage); };
  if (stage === 'model') f.create.mockImplementation(abort); else f.inner.observe = abort;
  const recover = vi.spyOn(f.surface, 'recoverClick');
  expect(await f.run()).toMatchObject({ status: 'stopped', stopReason: 'RUN_ABORTED' });
  expect(recover).not.toHaveBeenCalled(); expect(f.escalate).not.toHaveBeenCalled();
});

it('does not repeat recovery when terminal evidence persistence fails', async () => {
  const f = discoveryConditionFixture(); f.show('maintenance');
  const recover = vi.spyOn(f.surface, 'recoverClick');
  const original = f.logger.log.bind(f.logger);
  vi.spyOn(f.logger, 'log').mockImplementation((event, data) => { if (event === 'discovery.finish') throw new Error('evidence unavailable'); return original(event, data); });
  await expect(f.run()).rejects.toThrow('evidence unavailable');
  expect(recover).toHaveBeenCalledOnce(); expect(f.create).not.toHaveBeenCalled();
});
