import { evaluateRun } from '../src/evidence/evaluate.js';
import { hintToDescriptor } from '../src/agent/tools.js';
import { extractText } from '../src/artifact/schema.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Journal } from '../src/runtime/journal.js';
import { applyMeridianContract, assertTransferEligibility, assertTransferFacts, assertTransferOutputs, meridianContracts, meridianTransferMemberTable } from '../src/runtime/contracts.js';
import { Approval } from '../src/runtime/approval.js';
import { OperatorConsole } from '../src/escalation/operator.js';
import { ControlSession } from '../src/escalation/session.js';
import { CapabilityArtifact, moneyCents, validOutput, validateParams, type OutputValue } from '../src/artifact/schema.js';
import * as clients from '../src/agent/client.js';
import { runDiscovery } from '../src/agent/loop.js';
import * as runtime from '../src/runtime/run.js';
import { recordArtifact } from '../src/artifact/recorder.js';
import { toToolSchema } from '../src/artifact/tools.js';
import { GuardedSurface } from '../src/surface/guarded.js';
import { BrowserSurface } from '../src/surface/browser.js';
import { Policy } from '../src/safety/policy.js';
import { loadProfile, type LiveControl } from '../src/runtime/profile.js';
import { RunLogger } from '../src/evidence/logger.js';
import { Redactor } from '../src/safety/redact.js';
import { runReplay } from '../src/replay/executor.js';
import { promoteToApproved } from '../src/artifact/promote.js';
import type { Surface } from '../src/surface/types.js';
import { createApp } from '../src/server/http.js';
import { InvocationService } from '../src/server/service.js';
import express from 'express';
import { chromium } from 'playwright';
import { request as httpRequest, createServer } from 'node:http';

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'meridian-')); dirs.push(dir); return dir; };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const key = 'hmac-test-key-with-at-least-32-characters';
const profile = loadProfile('meridian');
const origin = 'https://web-sample.interface-hiring.com';
const policy = Policy.parse({ allowedOrigins: [origin], allowedActions: ['navigate', 'click', 'fill', 'select', 'extract', 'assert'], riskHandling: { read: 'allow', reversible_write: 'allow', irreversible: 'allow' } });
const control: LiveControl = { url: `${origin}/members/1/hold/review`, destination: `${origin}/members/1/hold/post`, method: 'POST', control: 'Apply Hold', submit: true, operator: 'SUPER1', branch: 'MAIN-001', role: 'SUPERVISOR', conditions: [], facts: { share: '1-A', reason: 'FRAUD' }, tokenPresent: true, error: false };
const target = { description: 'submit', strategies: [{ kind: 'nameAttr' as const, name: 'submit' }] };
function guarded(overrides: Partial<Surface> = {}, gate = async () => true, context = {}, onAction?: (event: string, data: Record<string, unknown>) => void, onDispatch?: (expected: LiveControl) => void | Promise<void>, onInspect?: () => void | Promise<void>) {
  let live = structuredClone(control);
  const dispatch = vi.fn(async () => ({ strategyUsed: 0, kind: 'nameAttr', matches: 1 }));
  const surface: Surface = { start: async () => {}, navigate: async () => {}, observe: async () => ({ url: control.url, title: '', frames: [] }), currentUrl: () => control.url, frameUrls: () => [control.url], click: dispatch, fill: dispatch, select: dispatch, readText: async () => ({ text: 'ok', report: await dispatch() }), isTextVisible: async text => text === 'done', describeTarget: async t => t, screenshot: async () => {}, close: async () => {}, prepareClick: async () => ({ inspect: async () => { await onInspect?.(); return structuredClone(live); }, dispatch: async expected => { await onDispatch?.(expected); return dispatch(); } }), ...overrides };
  const session = new ControlSession();
  const beforeDispatch = vi.fn();
  return { surface: new GuardedSurface(surface, policy, gate, undefined, { profile, session, deadline: Date.now() + 10000, runId: randomUUID(), artifact: 'hold', version: '1.0.0', operator: 'super1', role: 'SUPERVISOR', branch: 'MAIN-001', beforeDispatch, ...context }, onAction), dispatch, session, beforeDispatch, change: (c: Partial<LiveControl>) => { live = { ...live, ...c }; } };
}

function stepReportingArtifact() {
  const input = (name: string) => ({ description: name, strategies: [{ kind: 'nameAttr' as const, name }] });
  return {
    schemaVersion: 2,
    id: 'meridian-member-record',
    name: 'meridian-member-record',
    description: 'Report the current member record step',
    version: '1.0.0',
    status: 'approved',
    app: { appId: 'meridian', entryUrl: `${origin}/fixture`, allowedOrigins: [origin] },
    parameters: [],
    outputs: [{ name: 'shares', type: 'table', description: 'Shares', columns: [{ name: 'share', selector: 'td', type: 'string' }] }],
    steps: [
      { id: 'operator', intent: 'operator', action: 'fill', target: input('operator'), value: '{{operator}}', risk: 'reversible_write' },
      { id: 'password', intent: 'password', action: 'fill', target: input('password'), value: '{{password}}', risk: 'reversible_write' },
      { id: 'branch', intent: 'branch', action: 'fill', target: input('branch'), value: '{{branch}}', risk: 'reversible_write' },
      { id: 'shares', intent: 'read shares', action: 'extract', target: { description: 'shares', strategies: [{ kind: 'css' as const, selector: '#shares' }] }, extract: { output: 'shares', columns: [{ name: 'share', selector: 'td', type: 'string' }] }, risk: 'read' },
      { id: 'verify-member', intent: 'verify member checkpoint', action: 'assert', assert: { kind: 'textVisible' as const, text: 'ASSERT READY' }, risk: 'read', timeoutMs: 1 },
    ],
    successCondition: { kind: 'urlMatches' as const, pattern: '.*' },
    detectors: [{ id: 'fatal-fixture', description: 'fatal fixture condition', match: { kind: 'textVisible' as const, text: 'FATAL FIXTURE' }, classification: 'fatal' as const, outcomeCode: 'FIXTURE_FATAL' }],
    provenance: { discoveredAt: '', model: '', discoveryRunId: '', goal: '' },
  };
}

it('passes the requested timeout to non-profile click inspection', async () => {
  const inspect = vi.fn(async (_hint: unknown, _timeoutMs?: number) => target);
  const click = vi.fn(async () => ({ strategyUsed: 0, kind: 'nameAttr', matches: 1 }));
  const inner = {
    describeTarget: inspect, click,
    currentUrl: () => `${origin}/menu`, frameUrls: () => [],
  } as unknown as Surface;
  const surface = new GuardedSurface(inner, policy, async () => true);
  await surface.click(target, 75, 'read');
  expect(inspect).toHaveBeenCalledWith(target, expect.any(Number));
  expect(inspect.mock.calls[0]![1]).toBeGreaterThan(0);
  expect(inspect.mock.calls[0]![1]).toBeLessThanOrEqual(75);
});

it('shares the click budget and refuses dispatch after inspection expires', async () => {
  const inspect = vi.fn(async () => {
    await new Promise(resolve => setTimeout(resolve, 25));
    return target;
  });
  const click = vi.fn(async () => ({ strategyUsed: 0, kind: 'nameAttr', matches: 1 }));
  const inner = { describeTarget: inspect, click, currentUrl: () => `${origin}/menu`, frameUrls: () => [] } as unknown as Surface;
  const surface = new GuardedSurface(inner, policy, async () => true);
  await expect(surface.click(target, 10, 'read')).rejects.toThrow(/timeout/i);
  expect(click).not.toHaveBeenCalled();
});

it('does not spend the click budget while waiting for human approval', async () => {
  vi.useFakeTimers();
  const click = vi.fn(async (_target: unknown, _timeoutMs?: number) => ({ strategyUsed: 0, kind: 'nameAttr', matches: 1 }));
  const inner = { describeTarget: async () => target, click, currentUrl: () => `${origin}/menu`, frameUrls: () => [] } as unknown as Surface;
  const gate = vi.fn(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 500));
    return true;
  });
  const approvalPolicy = Policy.parse({ ...policy, riskHandling: { ...policy.riskHandling, irreversible: 'escalate' } });
  const pending = new GuardedSurface(inner, approvalPolicy, gate).click(target, 50, 'irreversible');
  for (let i = 0; i < 5 && !gate.mock.calls.length; i++) await Promise.resolve();
  expect(gate).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(500);
  await pending;
  const remaining = click.mock.calls[0]![1] as number;
  expect(remaining).toBeGreaterThan(0);
  expect(remaining).toBeLessThanOrEqual(50);
});

it('blocks a profile read dispatch after an absolute deadline expires during approval', async () => {
  vi.useFakeTimers();
  const live: LiveControl = { ...control, url: `${origin}/members`, destination: `${origin}/members`, method: 'GET', control: 'Search', submit: false };
  const report = { strategyUsed: 0, kind: 'nameAttr' as const, matches: 1 };
  const inspect = vi.fn(async () => structuredClone(live));
  const dispatch = vi.fn(async () => report);
  const inner = {
    start: async () => {}, navigate: async () => {}, observe: async () => ({ url: live.url, title: '', frames: [] }),
    currentUrl: () => live.url, frameUrls: () => [live.url], click: dispatch, fill: dispatch, select: dispatch,
    readText: async () => ({ text: 'ok', report }), isTextVisible: async () => false, describeTarget: async (t: unknown) => t,
    screenshot: async () => {}, close: async () => {}, prepareClick: async () => ({ inspect, dispatch }),
  } as unknown as Surface;
  const gate = vi.fn(async () => {
    vi.setSystemTime(Date.now() + 50);
    return true;
  });
  const beforeDispatch = vi.fn();
  const events: string[] = [];
  const approvalPolicy = Policy.parse({ ...policy, riskHandling: { ...policy.riskHandling, read: 'escalate' } });
  const surface = new GuardedSurface(inner, approvalPolicy, gate, undefined, {
    profile, session: new ControlSession(), deadline: Date.now() + 20, runId: randomUUID(), artifact: 'hold',
    version: '1.0.0', operator: 'super1', role: 'SUPERVISOR', branch: 'MAIN-001', beforeDispatch,
  }, event => events.push(event));
  const pending = surface.click(target, 500, 'read');
  const rejected = expect(pending).rejects.toThrow(/Run deadline expired/);
  for (let i = 0; i < 10 && !gate.mock.calls.length; i++) await Promise.resolve();
  expect(gate).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(50);
  await rejected;
  expect(dispatch).not.toHaveBeenCalled();
  expect(beforeDispatch).not.toHaveBeenCalled();
  expect(events).not.toContain('mutation.intent');
});

it('blocks a profile mutation intent and dispatch after revalidation crosses the absolute deadline', async () => {
  vi.useFakeTimers();
  const inspect = vi.fn(async () => {
    if (inspect.mock.calls.length === 2) vi.setSystemTime(Date.now() + 50);
    return structuredClone(control);
  });
  const report = { strategyUsed: 0, kind: 'nameAttr' as const, matches: 1 };
  const dispatch = vi.fn(async () => report);
  const inner = {
    start: async () => {}, navigate: async () => {}, observe: async () => ({ url: control.url, title: '', frames: [] }),
    currentUrl: () => control.url, frameUrls: () => [control.url], click: dispatch, fill: dispatch, select: dispatch,
    readText: async () => ({ text: 'ok', report }), isTextVisible: async () => false, describeTarget: async (t: unknown) => t,
    screenshot: async () => {}, close: async () => {}, prepareClick: async () => ({ inspect, dispatch }),
  } as unknown as Surface;
  const gate = vi.fn(async () => true);
  const beforeDispatch = vi.fn();
  const events: string[] = [];
  const surface = new GuardedSurface(inner, policy, gate, undefined, {
    profile, session: new ControlSession(), deadline: Date.now() + 20, runId: randomUUID(), artifact: 'hold',
    version: '1.0.0', operator: 'super1', role: 'SUPERVISOR', branch: 'MAIN-001', beforeDispatch,
  }, event => events.push(event));
  const pending = surface.click(target, 500, 'read');
  const rejected = expect(pending).rejects.toThrow(/Run deadline expired/);
  for (let i = 0; i < 10 && inspect.mock.calls.length < 2; i++) await Promise.resolve();
  expect(inspect).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(50);
  await rejected;
  expect(dispatch).not.toHaveBeenCalled();
  expect(beforeDispatch).not.toHaveBeenCalled();
  expect(events).not.toContain('mutation.intent');
});

describe('durable request identity', () => {
  it('deduplicates after restart, detects changed context, and never resumes dispatch', () => {
    const dir = temp(); let journal = new Journal(dir, key);
    const request = { args: { member: 'PRIVATE-MEMBER' }, role: 'TELLER' };
    const first = journal.reserve('caller', 'request-1', 'transfer', '1.0.0', request);
    expect(journal.reserve('caller', 'request-1', 'transfer', '1.0.0', request).runId).toBe(first.runId);
    expect(() => new Journal(dir, key)).toThrow(/already in use/);
    journal.update(first.runId, 'dispatching'); journal.close();
    journal = new Journal(dir, key);
    expect(journal.reserve('caller', 'request-1', 'transfer', '1.0.0', request).state).toBe('POST_OUTCOME_UNKNOWN');
    expect(() => journal.lookup('caller', 'request-1', { ...request, role: 'SUPERVISOR' })).toThrow(/another request/);
    expect(readFileSync(join(dir, `${first.runId}.json`), 'utf8')).not.toContain('PRIVATE-MEMBER');
    journal.close();
    expect(() => new Journal(dir, 'another-secret-key-that-is-32-characters')).toThrow(/authentication failed/);
  });
  it('marks reserved runs interrupted and rejects tampered records', () => {
    const dir = temp(); let journal = new Journal(dir, key);
    const first = journal.reserve('caller', 'r', 'inquiry', '1.0.0', {}); journal.close();
    journal = new Journal(dir, key); expect(journal.records.get(first.runId)?.state).toBe('interrupted'); journal.close();
    const path = join(dir, `${first.runId}.json`); writeFileSync(path, readFileSync(path, 'utf8').replace('interrupted', 'success'));
    expect(() => new Journal(dir, key)).toThrow(/authentication failed/);
  });

  it('returns an existing service run before creating another runtime', () => {
    const names = ['MERIDIAN_TELLER_OPERATOR', 'MERIDIAN_TELLER_PASSWORD', 'MERIDIAN_SUPERVISOR_OPERATOR', 'MERIDIAN_SUPERVISOR_PASSWORD', 'MERIDIAN_BRANCH'];
    const previous = new Map(names.map(name => [name, process.env[name]]));
    const dir = temp();
    const journal = new Journal(join(dir, 'journal'), key);
    const createRuntime = vi.spyOn(runtime, 'createRuntime');
    process.env.MERIDIAN_TELLER_OPERATOR = 'TELLER-ONE';
    process.env.MERIDIAN_TELLER_PASSWORD = 'TELLER-PASSWORD';
    process.env.MERIDIAN_SUPERVISOR_OPERATOR = 'SUPERVISOR-ONE';
    process.env.MERIDIAN_SUPERVISOR_PASSWORD = 'SUPERVISOR-PASSWORD';
    process.env.MERIDIAN_BRANCH = 'MAIN-001';
    try {
      const service = new InvocationService(journal, policy, profile, temp(), ['meridian-member-record'], 'artifacts');
      const request = { mode: 'replay', capability: 'meridian-member-record', version: '1.0.0', args: { member: '123' }, context: { operator: 'TELLER-ONE', branch: 'MAIN-001', role: 'TELLER' } };
      const record = journal.reserve('operator', 'same-key', 'meridian-member-record', '1.0.0', request);
      expect(service.invoke('operator', 'meridian-member-record', { member: '123' }, 'same-key', 'TELLER').runId).toBe(record.runId);
      expect(createRuntime).not.toHaveBeenCalled();
      expect(() => service.invoke('operator', 'meridian-member-record', { member: '124' }, 'same-key', 'TELLER')).toThrow(/another request/);
      expect(() => service.invoke('operator', 'meridian-member-record', { member: '123' }, 'same-key', 'SUPERVISOR')).toThrow(/another request/);
      expect(createRuntime).not.toHaveBeenCalled();
    } finally {
      journal.close();
      for (const name of names) {
        const value = previous.get(name);
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
    }
  });
});

describe('single-use interventions and live controls', () => {
  it('permits one sign-on and refuses mid-flow navigation or redirected login actions', async () => {
    let url = `${origin}/signon`;
    const run = guarded({ currentUrl: () => url });
    run.change({ ...control, destination: `${origin}/signon`, control: 'Sign On', method: 'POST', submit: true });
    await run.surface.start(url);
    await run.surface.fill(target, 'server-reference');
    await run.surface.click(target);
    url = `${origin}/menu`;
    await expect(run.surface.navigate(`${origin}/signon`)).rejects.toThrow(/Mid-flow/);
    await expect(run.surface.click(target)).rejects.toThrow(/Mid-flow/);
    await expect(run.surface.start(`${origin}/signon`)).rejects.toThrow(/only once/);
    url = `${origin}/signon`;
    await expect(run.surface.fill(target, 'server-reference')).rejects.toThrow(/Session ended/);
    expect(run.dispatch).toHaveBeenCalledTimes(2);
  });
  it('expires, rejects stale IDs, and serializes abort', async () => {
    vi.useFakeTimers(); const session = new ControlSession(); const approval = new Approval(session, () => {}, Date.now() + 600000);
    const request = { kind: 'replay_stuck' as const, capability: 'c', goal: '', reason: '', url: '' };
    const pending = approval.wait(request); const id = approval.pending!.id;
    expect(session.currentOwner).toBe('human'); approval.decide(id, 'abort');
    expect(await pending).toBe('abort'); expect(() => approval.decide(id, 'retry')).toThrow(/Stale/);
    const expired = approval.wait(request); await vi.advanceTimersByTimeAsync(300000); expect(await expired).toBe('abort'); expect(session.currentOwner).toBe('automation');
  });

  it('allows one approved mutation and blocks wrong, stale, and aborted approval before dispatch', async () => {
    const waitForApproval = async (approval: Approval) => {
      for (let i = 0; i < 50 && !approval.pending; i++) await Promise.resolve();
      expect(approval.pending).toBeDefined();
      return approval.pending!.id;
    };
    const makeRun = () => {
      const approval = new Approval(new ControlSession(), () => {}, Date.now() + 600_000);
      const gate = vi.fn(async () => {
        const pending = approval.wait({ kind: 'risk_approval', capability: 'hold', goal: 'apply hold', reason: 'apply hold', url: origin });
        return (await pending) === 'approve';
      });
      return { approval, run: guarded({}, gate) };
    };

    const blocked = makeRun();
    const rejected = expect(blocked.run.surface.click(target, 1000, 'read')).rejects.toThrow(/aborted/);
    const blockedId = await waitForApproval(blocked.approval);
    expect(() => blocked.approval.decide(randomUUID(), 'abort')).toThrow(/Stale/);
    expect(() => blocked.approval.decide(blockedId, 'retry')).toThrow(/does not match/);
    blocked.approval.decide(blockedId, 'abort');
    await rejected;
    expect(() => blocked.approval.decide(blockedId, 'abort')).toThrow(/Stale/);
    expect(blocked.run.dispatch).not.toHaveBeenCalled();
    expect(blocked.run.beforeDispatch).not.toHaveBeenCalled();

    const approved = makeRun();
    const dispatched = approved.run.surface.click(target, 1000, 'read');
    const approvedId = await waitForApproval(approved.approval);
    approved.approval.decide(approvedId, 'approve');
    await dispatched;
    expect(approved.run.dispatch).toHaveBeenCalledTimes(1);
    expect(approved.run.beforeDispatch).toHaveBeenCalledOnce();
    expect(approved.run.surface.mutationDispatched).toBe(true);
  });
  it('requires approval for a down-labelled post even if policy allows it', async () => {
    const gate = vi.fn(async () => false); const run = guarded({}, gate);
    await expect(run.surface.click(target, 100, 'read')).rejects.toThrow(/aborted/);
    expect(gate).toHaveBeenCalledOnce(); expect(run.dispatch).not.toHaveBeenCalled(); expect(run.beforeDispatch).not.toHaveBeenCalled();
  });
  it.each(['facts', 'operator', 'destination', 'tokenPresent', 'role'] as const)('invalidates changed %s before dispatch', async field => {
    const run = guarded({}, async () => { run.change({ [field]: field === 'facts' ? { share: 'CHANGED' } : field === 'tokenPresent' ? false : 'CHANGED' }); return true; });
    await expect(run.surface.click(target)).rejects.toThrow(/invalidated/); expect(run.dispatch).not.toHaveBeenCalled();
  });
  it('denies automation during handoff, supervisor mismatch and unknown form controls', async () => {
    const run = guarded(); run.session.transfer('human', 'repair'); await expect(run.surface.click(target)).rejects.toThrow(/Human owns/);
    const teller = guarded({}, async () => true, { role: 'TELLER' }); await expect(teller.surface.click(target)).rejects.toThrow(/authority/);
    const unknown = guarded(); unknown.change({ control: 'Anything Else' }); await expect(unknown.surface.click(target)).rejects.toThrow(/Unknown form/);
  });
  it('journals before dispatch and refuses retry or escalation after uncertain posting', async () => {
    const run = guarded({ prepareClick: async () => ({ inspect: async () => control, dispatch: async () => { expect(run.beforeDispatch).toHaveBeenCalledOnce(); throw new Error('network lost'); } }) });
    const artifact = CapabilityArtifact.parse({ schemaVersion: 2, id: 'hold', name: 'hold', description: 'hold', version: '1.0.0', status: 'approved', app: { appId: 'meridian', entryUrl: `${origin}/signon`, allowedOrigins: [origin] }, parameters: [], outputs: [], steps: [{ id: 'post', action: 'click', intent: 'post', target, risk: 'read' }], successCondition: { kind: 'textVisible', text: 'done' }, provenance: { discoveredAt: '', model: '', discoveryRunId: '', goal: '' } });
    const escalate = vi.fn(async () => 'retry' as const);
    const result = await runReplay(artifact, {}, { surface: run.surface, logger: new RunLogger('replay', new Redactor(), temp()), policy, escalate });
    expect(result.status === 'failure' && result.failure.code).toBe('POST_OUTCOME_UNKNOWN'); expect(escalate).not.toHaveBeenCalled();
  });
});

it.each([
  ['pre-dispatch', false],
  ['post-intent', true],
] as const)('finalizes a replay journal after a thrown %s failure', async (phase, intent) => {
  const dir = temp(); const journal = new Journal(join(dir, 'journal'), key);
  const record = journal.reserve('operator', `cli-${phase}`, 'hold', '1.0.0', {});
  const logger = new RunLogger('replay', new Redactor(), dir, true, record.runId);
  const beforeDispatch = vi.fn(() => { if (intent) journal.update(record.runId, 'dispatching'); else throw new Error('raw pre-dispatch detail'); });
  const dispatch = vi.fn(async () => { throw new Error('raw post-intent detail'); });
  const run = guarded({ prepareClick: async () => ({ inspect: async () => control, dispatch }) }, async () => true,
    { runId: record.runId, beforeDispatch });
  const artifact = CapabilityArtifact.parse({ schemaVersion: 2, id: 'hold', name: 'hold', description: 'hold', version: '1.0.0', status: 'approved', app: { appId: 'meridian', entryUrl: `${origin}/signon`, allowedOrigins: [origin] }, parameters: [], outputs: [], steps: [{ id: 'post', action: 'click', intent: 'post', target, risk: 'read' }], successCondition: { kind: 'textVisible', text: 'done' }, provenance: { discoveredAt: '', model: '', discoveryRunId: '', goal: '' } });
  try {
    journal.update(record.runId, 'running');
    const result = await runReplay(artifact, {}, { surface: run.surface, logger, policy });
    const state = result.status === 'failure' && (intent || run.surface.mutationDispatched) ? 'POST_OUTCOME_UNKNOWN' : result.status;
    journal.update(record.runId, state);
    expect(result.status).toBe('failure');
    expect(result.status === 'failure' && result.failure.code).toBe(intent ? 'POST_OUTCOME_UNKNOWN' : undefined);
    expect(beforeDispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledTimes(intent ? 1 : 0);
    expect(readFileSync(join(logger.dir, 'result.json'), 'utf8')).not.toMatch(/raw pre-dispatch detail|raw post-intent detail/);
    expect(journal.records.get(record.runId)?.state).toBe(intent ? 'POST_OUTCOME_UNKNOWN' : 'failure');
  } finally { journal.close(); }
  expect(existsSync(join(dir, 'journal', 'server.lock'))).toBe(false);
});

it('validates decimal money and output types without exposing server inputs', () => {
  expect(moneyCents('0.01')).toBe(1); expect(moneyCents('12.3')).toBe(1230);
  for (const value of ['NaN', 'Infinity', '1e2', '1.005', '-1', '01']) expect(() => moneyCents(value)).toThrow();
  expect(validOutput({ name: 'table', type: 'table', description: '', columns: [{ name: 'balance', selector: 'td', type: 'money' }] }, [{ balance: '12.30' }])).toBe(true);
  expect(validOutput({ name: 'table', type: 'table', description: '' }, '[]')).toBe(false);
  const a = CapabilityArtifact.parse({ ...JSON.parse(readFileSync('test/fixtures/hand-lookup.json', 'utf8')), schemaVersion: 2, parameters: [{ name: 'password', type: 'string', description: 'secret', source: 'server' }, { name: 'amount', type: 'number', description: '' }] });
  expect(toToolSchema(a).openai.function.parameters.properties).not.toHaveProperty('password');
  expect(validateParams(a, { password: 'x', amount: Infinity }).ok).toBe(false);
  const memberContract = { ...a, parameters: meridianContracts['meridian-member-record'].parameters };
  expect(validateParams(memberContract, { member: '100234?inject=server' }).ok).toBe(false);
  expect(validateParams(memberContract, { member: '100234' }).ok).toBe(true);
});

function memberRecordArtifact(outputs: Array<Record<string, unknown>>) {
  return CapabilityArtifact.parse({
    schemaVersion: 2,
    id: 'meridian-member-record',
    name: 'meridian-member-record',
    description: 'Read member shares',
    version: '1.0.0',
    status: 'draft',
    app: { appId: 'meridian', entryUrl: `${origin}/signon`, allowedOrigins: [origin] },
    parameters: [],
    outputs,
    steps: [
      { id: 'operator', intent: 'operator', action: 'fill', value: '{{operator}}', risk: 'reversible_write' },
      { id: 'password', intent: 'password', action: 'fill', value: '{{password}}', risk: 'reversible_write' },
      { id: 'branch', intent: 'branch', action: 'fill', value: '{{branch}}', risk: 'reversible_write' },
      { id: 'checkpoint', intent: 'checkpoint', action: 'assert', assert: { kind: 'textVisible', text: 'Member Profile' }, risk: 'read' },
      { id: 'shares', intent: 'shares', action: 'extract', target: { description: 'shares', strategies: [{ kind: 'css', selector: '#shares' }] }, extract: { output: 'shares', columns: [{ name: 'share', selector: 'td', type: 'string' }] }, risk: 'read' },
    ],
    successCondition: { kind: 'urlMatches', pattern: '/members/{{member}}$' },
    detectors: [],
    provenance: { discoveredAt: '', model: '', discoveryRunId: '', goal: '' },
  });
}

function transferOutputDeclarations(): Array<Record<string, unknown>> {
  const columns = [
    { name: 'member', selector: 'td:nth-of-type(1)', type: 'string', sensitive: true },
    { name: 'sourceShare', selector: 'td:nth-of-type(2)', type: 'string', sensitive: true },
    { name: 'destinationShare', selector: 'td:nth-of-type(3)', type: 'string', sensitive: true },
    { name: 'amount', selector: 'td:nth-of-type(4)', type: 'money', sensitive: true },
    { name: 'memo', selector: 'td:nth-of-type(5)', type: 'string', sensitive: true },
    { name: 'confirmation', selector: 'td:nth-of-type(6)', type: 'string', sensitive: true },
  ];
  return [
    { name: 'confirmation', type: 'string', description: 'Confirmation', sensitive: true },
    { name: 'transaction', type: 'table', description: 'Transaction', sensitive: true, minRows: 1, columns },
  ];
}

function transferArtifact(outputs: Array<Record<string, unknown>> = transferOutputDeclarations()) {
  const transactionTarget = { description: 'transaction', strategies: [{ kind: 'css' as const, selector: '#transaction' }] };
  const confirmationTarget = { description: 'confirmation', strategies: [{ kind: 'css' as const, selector: '#confirmation' }] };
  const columns = (outputs.find(output => output.name === 'transaction')?.columns ?? []) as Array<Record<string, unknown>>;
  return CapabilityArtifact.parse({
    schemaVersion: 2,
    id: 'meridian-funds-transfer',
    name: 'meridian-funds-transfer',
    description: 'Transfer funds',
    version: '1.0.0',
    status: 'draft',
    app: { appId: 'meridian', entryUrl: `${origin}/signon`, allowedOrigins: [origin] },
    parameters: [],
    outputs,
    steps: [
      { id: 'operator', intent: 'operator', action: 'fill', value: '{{operator}}', risk: 'reversible_write' },
      { id: 'password', intent: 'password', action: 'fill', value: '{{password}}', risk: 'reversible_write' },
      { id: 'branch', intent: 'branch', action: 'select', value: '{{branch}}', risk: 'reversible_write' },
      { id: 'checkpoint', intent: 'checkpoint', action: 'assert', assert: { kind: 'textVisible' as const, text: 'Transfer complete' }, risk: 'read' },
      { id: 'post', intent: 'post transfer', action: 'click', target, risk: 'irreversible' },
      { id: 'post-checkpoint', intent: 'verify posted transfer', action: 'assert', assert: { kind: 'textVisible' as const, text: 'Transfer complete' }, risk: 'read' },
      { id: 'confirmation', intent: 'record confirmation', action: 'extract', target: confirmationTarget, extract: { output: 'confirmation', pattern: '(.+)' }, risk: 'read' },
      { id: 'transaction', intent: 'record transaction', action: 'extract', target: transactionTarget, extract: { output: 'transaction', columns, rowSelector: 'tr' }, risk: 'read' },
    ],
    successCondition: { kind: 'textVisible' as const, text: 'Transfer complete' },
    detectors: [],
    provenance: { discoveredAt: '', model: '', discoveryRunId: '', goal: '' },
  });
}

describe('MERIDIAN output contracts', () => {
  const shares = { name: 'shares', type: 'table', description: 'Shares', columns: [{ name: 'share', selector: 'td', type: 'string' }] };

  it.each([
    ['missing', []],
    ['duplicate', [shares, shares]],
    ['wrong', [{ name: 'members', type: 'string', description: 'Wrong output' }]],
  ])('rejects %s output declarations before direct application', (_kind, outputs) => {
    expect(() => applyMeridianContract(memberRecordArtifact(outputs))).toThrow(/output/i);
  });

  it('requires the exact output declaration when promoting to approved', () => {
    expect(() => promoteToApproved(JSON.stringify(memberRecordArtifact([])))).toThrow(/output/i);
    const approved = JSON.parse(promoteToApproved(JSON.stringify(memberRecordArtifact([shares]))));
    expect(approved.status).toBe('approved');
    expect(approved.outputs).toEqual([{ ...shares, minRows: 1 }]);
  });
});

describe('MERIDIAN funds-transfer semantic checks', () => {
  const request = {
    member: '9001', sourceShare: '9001-A', destinationShare: '9001-B',
    amount: '1.00', memo: 'fixture',
  };
  const rows = [
    { share: '9001-A', status: 'OPEN', balance: '2.00' },
    { share: '9001-B', status: 'OPEN', balance: '0.00' },
  ];

  it('accepts one exact member row per requested open share with enough funds', () => {
    expect(() => assertTransferEligibility(request, '9001', rows)).not.toThrow();
  });

  it.each([
    ['wrong member', '9999', rows],
    ['duplicate source row', '9001', [rows[0]!, rows[0]!, rows[1]!]],
    ['missing destination row', '9001', [rows[0]!]],
    ['same source and destination', '9001', rows],
    ['closed requested row despite unrelated open row', '9001', [{ ...rows[0]!, status: 'CLOSED' }, rows[1]!, { share: '9001-C', status: 'OPEN', balance: '9.00' }]],
    ['malformed source balance', '9001', [{ ...rows[0]!, balance: 'not-money' }, rows[1]!]],
    ['insufficient source balance', '9001', [{ ...rows[0]!, balance: '0.99' }, rows[1]!]],
    ['nonpositive amount', '9001', rows],
  ] as const)('rejects %s before transfer', (kind, member, actualRows) => {
    const expected = kind === 'same source and destination' ? { ...request, destinationShare: request.sourceShare } : kind === 'nonpositive amount' ? { ...request, amount: '0.00' } : request;
    expect(() => assertTransferEligibility(expected, member, actualRows as Array<{ share: string; status: string; balance: string }>)).toThrow();
  });

  it.each([
    ['member', { ...request, member: '9002' }],
    ['source share', { ...request, sourceShare: '9001-C' }],
    ['destination share', { ...request, destinationShare: '9001-C' }],
    ['amount', { ...request, amount: '2.00' }],
    ['memo', { ...request, memo: 'changed' }],
  ] as const)('rejects a changed review fact: %s', (_kind, actual) => {
    expect(() => assertTransferFacts(request, actual)).toThrow();
  });

  it('accepts equivalent positive decimal amounts when their integer cents match', () => {
    expect(() => assertTransferFacts(request, { ...request, amount: '1.0' })).not.toThrow();
  });

  it('accepts one canonical headerless transaction row and matching confirmation', () => {
    const outputs: Record<string, OutputValue> = {
      confirmation: 'CONF-123',
      transaction: [{ ...request, confirmation: 'CONF-123' }],
    };
    expect(() => assertTransferOutputs(request, outputs)).not.toThrow();
  });

  it.each([
    ['missing confirmation', { transaction: [{ ...request, confirmation: 'CONF-123' }] }],
    ['blank confirmation', { confirmation: '  ', transaction: [{ ...request, confirmation: '  ' }] }],
    ['missing transaction', { confirmation: 'CONF-123' }],
    ['duplicate transaction rows', { confirmation: 'CONF-123', transaction: [{ ...request, confirmation: 'CONF-123' }, { ...request, confirmation: 'CONF-123' }] }],
    ['header row', { confirmation: 'CONF-123', transaction: [{ member: 'Member', sourceShare: 'Source', destinationShare: 'Destination', amount: 'Amount', memo: 'Memo', confirmation: 'Confirmation' }, { ...request, confirmation: 'CONF-123' }] }],
    ['legacy field/value row', { confirmation: 'CONF-123', transaction: [{ field: 'Member:', value: '9001' }] }],
    ['extra row field', { confirmation: 'CONF-123', transaction: [{ ...request, confirmation: 'CONF-123', extra: 'unexpected' }] }],
    ['wrong transaction confirmation', { confirmation: 'CONF-123', transaction: [{ ...request, confirmation: 'CONF-999' }] }],
    ['wrong transaction value', { confirmation: 'CONF-123', transaction: [{ ...request, amount: '2.00', confirmation: 'CONF-123' }] }],
    ['extra output', { confirmation: 'CONF-123', transaction: [{ ...request, confirmation: 'CONF-123' }], extra: 'unexpected' }],
  ] as const)('rejects %s output shape or value', (_kind, outputs) => {
    expect(() => assertTransferOutputs(request, outputs as Record<string, OutputValue>)).toThrow();
  });

  it('rejects legacy and malformed transfer output declarations before application', () => {
    const legacy = transferOutputDeclarations();
    legacy[1]!.columns = [
      { name: 'field', selector: 'td:nth-of-type(1)', type: 'string', sensitive: true },
      { name: 'value', selector: 'td:nth-of-type(2)', type: 'string', sensitive: true },
    ];
    expect(() => applyMeridianContract(transferArtifact(legacy))).toThrow(/canonical|transfer/i);

    const wrongType = transferOutputDeclarations();
    (wrongType[1]!.columns as Array<Record<string, unknown>>)[3]!.type = 'string';
    expect(() => applyMeridianContract(transferArtifact(wrongType))).toThrow(/canonical|transfer/i);

    const wrongOutputType = transferOutputDeclarations();
    wrongOutputType[1]!.type = 'string';
    expect(() => applyMeridianContract(transferArtifact(wrongOutputType))).toThrow(/canonical|transfer/i);

    const wrongExtraction = transferArtifact();
    const extract = wrongExtraction.steps.find(step => step.id === 'transaction')!.extract!;
    extract.columns = [{ name: 'field', selector: 'td', type: 'string', sensitive: true }];
    expect(() => applyMeridianContract(wrongExtraction)).toThrow(/canonical|transfer/i);
  });

  it('promotes a canonical transfer declaration with the observed selectors deferred to the new recording', () => {
    const approved = applyMeridianContract(transferArtifact());
    expect(approved.outputs.find(output => output.name === 'transaction')).toMatchObject({ type: 'table', minRows: 1, sensitive: true });
    expect(approved.outputs.find(output => output.name === 'transaction')?.columns?.map(column => [column.name, column.type, column.sensitive])).toEqual([
      ['member', 'string', true], ['sourceShare', 'string', true], ['destinationShare', 'string', true],
      ['amount', 'money', true], ['memo', 'string', true], ['confirmation', 'string', true],
    ]);
  });
});

describe('MERIDIAN guarded transfer path', () => {
  const request = {
    member: '9001', sourceShare: '9001-A', destinationShare: '9001-B',
    amount: '1.00', memo: 'fixture',
  };
  const validReviewFacts = {
    member: request.member,
    from: request.sourceShare,
    to: request.destinationShare,
    amount: request.amount,
    memo: request.memo,
    'review:Member:': '9001 - Fixture Member',
    'review:From:': '9001-A ($2.00)',
    'review:To:': '9001-B ($0.00)',
    'review:Amount:': '$1.00',
    'review:Memo:': 'fixture',
  };
  const eligibleRows = [
    { shareId: '9001-A', type: 'S0001', balance: '2.00', status: 'OPEN' },
    { shareId: '9001-B', type: 'S0001', balance: '0.00', status: 'OPEN' },
    { shareId: '9001-C', type: 'S0001', balance: '9.00', status: 'OPEN' },
  ];

  function transferHarness(rows = eligibleRows, facts = validReviewFacts, onAction?: (event: string, data: Record<string, unknown>) => void) {
    let url = `${origin}/members`;
    let navigation = 0;
    let frameId = 'transfer-workarea';
    let frameUrl = url;
    const memberUrl = `${origin}/members/9001`;
    const transferUrl = `${origin}/members/9001/transfer`;
    const reviewUrl = `${origin}/members/9001/transfer/review`;
    const postUrl = `${origin}/members/9001/transfer/post`;
    const frame = () => ({ id: frameId, name: 'workarea', url: frameUrl, navigation });
    const gate = vi.fn(async () => true);
    let onInspect: (() => void | Promise<void>) | undefined;
    const run = guarded({
      currentUrl: () => url,
      currentFrame: frame,
      lastResolvedFrame: frame,
      frameUrls: () => [`${origin}/frameset`, url],
      readTable: async () => rows,
    }, gate, { transfer: { expected: request, memberTable: meridianTransferMemberTable } }, onAction, async expected => {
      if (expected.destination === memberUrl) url = memberUrl;
      else if (expected.destination === transferUrl) url = transferUrl;
      else if (expected.destination === reviewUrl) url = reviewUrl;
      else if (expected.destination === postUrl) url = postUrl;
      frameUrl = url;
      navigation++;
    }, async () => onInspect?.());
    return {
      run,
      gate,
      setLive(next: Partial<LiveControl>) { run.change({ ...next, frame: next.frame ?? frame() }); },
      setUrl(next: string) { url = next; frameUrl = next; navigation++; },
      setFrame(next: { id?: string; url?: string }) { if (next.id) frameId = next.id; if (next.url) frameUrl = next.url; },
      setInspect(next: () => void | Promise<void>) { onInspect = next; },
      memberUrl,
      transferUrl,
      reviewUrl,
      postUrl,
      facts,
      frame,
    };
  }

  async function eligibleTransfer(rows = eligibleRows, facts = validReviewFacts) {
    const harness = transferHarness(rows, facts);
    await harness.run.surface.start(`${origin}/members`);
    harness.setUrl(harness.memberUrl);
    harness.setLive({ url: harness.memberUrl, destination: harness.memberUrl, method: 'GET', control: 'Select member', submit: false, facts: {} });
    await harness.run.surface.click(target);
    harness.setLive({ url: harness.memberUrl, destination: harness.transferUrl, method: 'GET', control: 'Transfer', submit: false, facts: {} });
    await harness.run.surface.click(target);
    harness.setLive({ url: harness.transferUrl, destination: harness.reviewUrl, method: 'POST', control: 'Continue', submit: true, facts: { ...facts } });
    await harness.run.surface.click(target);
    harness.setLive({ url: harness.reviewUrl, destination: harness.postUrl, method: 'POST', control: 'Post Transfer', submit: true, facts: { ...facts } });
    harness.run.dispatch.mockClear();
    return harness;
  }

  it('requires the current member table eligibility before entering transfer', async () => {
    const rows = [
      { ...eligibleRows[0]!, status: 'CLOSED' },
      eligibleRows[1]!,
      eligibleRows[2]!,
    ];
    const harness = transferHarness(rows);
    await harness.run.surface.start(`${origin}/members`);
    harness.setUrl(harness.memberUrl);
    harness.setLive({ url: harness.memberUrl, destination: harness.memberUrl, method: 'GET', control: 'Select member', submit: false, facts: {} });
    await expect(harness.run.surface.click(target)).rejects.toThrow(/transfer facts failed validation/i);
    expect(harness.run.dispatch).toHaveBeenCalledOnce();
    expect(harness.gate).not.toHaveBeenCalled();
  });

  it('keeps member eligibility extraction inside the member-selection action lifecycle', async () => {
    const logger = new RunLogger('replay', new Redactor(), temp(), true);
    const harness = transferHarness(eligibleRows, validReviewFacts, (event, data) => logger.log(event, data));
    await harness.run.surface.start(`${origin}/members`);
    harness.setUrl(harness.memberUrl);
    harness.setLive({ url: harness.memberUrl, destination: harness.memberUrl, method: 'GET', control: 'Select member', submit: false, facts: {} });
    await harness.run.surface.click(target);
    const events = readFileSync(join(logger.dir, 'log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as { event: string; attempt: number });
    const starts = events.filter(event => event.event === 'action.start');
    const ends = events.filter(event => event.event === 'action.end');
    expect(ends.map(event => event.attempt)).toEqual(starts.map(event => event.attempt));
  });

  it('invalidates eligibility after an out-of-band page and rejects a direct transfer link', async () => {
    const harness = transferHarness();
    await harness.run.surface.start(`${origin}/members`);
    harness.setUrl(harness.memberUrl);
    harness.setLive({ url: harness.memberUrl, destination: harness.memberUrl, method: 'GET', control: 'Select member', submit: false, facts: {} });
    await harness.run.surface.click(target);
    harness.run.dispatch.mockClear();
    harness.setUrl(`${origin}/menu`);
    harness.setLive({ url: `${origin}/menu`, destination: harness.transferUrl, method: 'GET', control: 'Transfer', submit: false, facts: {} });
    await expect(harness.run.surface.click(target)).rejects.toThrow(/transfer/i);
    expect(harness.gate).not.toHaveBeenCalled();
    expect(harness.run.beforeDispatch).not.toHaveBeenCalled();
    expect(harness.run.dispatch).not.toHaveBeenCalled();
    expect(harness.run.surface.mutationDispatched).toBe(false);
  });

  it('does not advance transfer state when the working frame navigates during inspection', async () => {
    const harness = transferHarness();
    await harness.run.surface.start(`${origin}/members`);
    harness.setUrl(harness.memberUrl);
    harness.setLive({ url: harness.memberUrl, destination: harness.memberUrl, method: 'GET', control: 'Select member', submit: false, facts: {} });
    await harness.run.surface.click(target);
    harness.run.dispatch.mockClear();
    harness.setLive({ url: harness.memberUrl, destination: harness.transferUrl, method: 'GET', control: 'Transfer', submit: false, facts: {} });
    harness.setInspect(async () => { harness.setUrl(harness.transferUrl); harness.setUrl(harness.memberUrl); });
    await expect(harness.run.surface.click(target)).rejects.toThrow(/frame/i);
    expect(harness.gate).not.toHaveBeenCalled();
    expect(harness.run.beforeDispatch).not.toHaveBeenCalled();
    expect(harness.run.dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['native member', 'member', '9999'],
    ['native source', 'from', '9001-C'],
    ['native destination', 'to', '9001-C'],
    ['native amount', 'amount', '2.00'],
    ['native memo', 'memo', 'changed'],
    ['visible member', 'review:Member:', '9999 - Fixture Member'],
    ['visible source', 'review:From:', '9001-C ($9.00)'],
    ['visible destination', 'review:To:', '9001-C ($9.00)'],
    ['visible amount', 'review:Amount:', '$2.00'],
    ['visible memo', 'review:Memo:', 'changed'],
    ['visible member prefix collision', 'review:Member:', '90010 - Fixture Member'],
    ['visible share malformed suffix', 'review:From:', '9001-A (2.00)'],
    ['visible amount missing currency', 'review:Amount:', '1.00'],
  ] as const)('rejects %s before the human gate or post dispatch', async (_kind, key, value) => {
    const harness = await eligibleTransfer();
    harness.setLive({ facts: { ...validReviewFacts, [key]: value } });
    await expect(harness.run.surface.click(target)).rejects.toThrow(/transfer/i);
    expect(harness.gate).not.toHaveBeenCalled();
    expect(harness.run.dispatch).not.toHaveBeenCalled();
    expect(harness.run.beforeDispatch).not.toHaveBeenCalled();
  });

  it('rechecks native and visible facts after approval and refuses changed state', async () => {
    const harness = await eligibleTransfer();
    harness.gate.mockImplementationOnce(async () => {
      harness.setLive({ facts: { ...validReviewFacts, 'review:Memo:': 'changed' } });
      return true;
    });
    await expect(harness.run.surface.click(target)).rejects.toThrow(/invalidated/i);
    expect(harness.gate).toHaveBeenCalledOnce();
    expect(harness.run.beforeDispatch).not.toHaveBeenCalled();
    expect(harness.run.dispatch).not.toHaveBeenCalled();
  });

  it('rejects a stale post control when the working frame is replaced before approval', async () => {
    const harness = await eligibleTransfer();
    harness.setFrame({ id: 'replacement-frame', url: harness.reviewUrl });
    await expect(harness.run.surface.click(target, 1000, 'irreversible')).rejects.toThrow(/frame/i);
    expect(harness.gate).not.toHaveBeenCalled();
    expect(harness.run.beforeDispatch).not.toHaveBeenCalled();
    expect(harness.run.dispatch).not.toHaveBeenCalled();
  });

  it('rejects an away-and-back working-frame navigation during approval', async () => {
    const harness = await eligibleTransfer();
    harness.gate.mockImplementationOnce(async () => {
      harness.setUrl(harness.transferUrl);
      harness.setUrl(harness.reviewUrl);
      return true;
    });
    await expect(harness.run.surface.click(target, 1000, 'irreversible')).rejects.toThrow(/frame/i);
    expect(harness.gate).toHaveBeenCalledOnce();
    expect(harness.run.beforeDispatch).not.toHaveBeenCalled();
    expect(harness.run.dispatch).not.toHaveBeenCalled();
    expect(harness.run.surface.mutationDispatched).toBe(false);
  });

  it('dispatches one approved transfer with parsed visible display facts', async () => {
    const harness = await eligibleTransfer();
    await harness.run.surface.click(target, 1000, 'irreversible');
    expect(harness.gate).toHaveBeenCalledOnce();
    expect(harness.run.beforeDispatch).toHaveBeenCalledOnce();
    expect(harness.run.dispatch).toHaveBeenCalledOnce();
    expect(harness.run.surface.mutationDispatched).toBe(true);
  });

  it.each([
    ['with a transfer binding', { transfer: { expected: request, memberTable: meridianTransferMemberTable } }],
    ['without a transfer binding', {}],
  ])('refuses another operation for a funds-transfer run %s', async (_case, transferContext) => {
    const gate = vi.fn(async () => true);
    const run = guarded({}, gate, { artifact: 'meridian-funds-transfer', ...transferContext });
    run.change({
      destination: `${origin}/members/9001/update`, method: 'POST', control: 'Save Changes', submit: true,
    });

    await expect(run.surface.click(target)).rejects.toThrow(/transfer/i);
    expect(gate).not.toHaveBeenCalled();
    expect(run.beforeDispatch).not.toHaveBeenCalled();
    expect(run.surface.mutationDispatched).toBe(false);
    expect(run.dispatch).not.toHaveBeenCalled();
  });
});

it('stops discovery with unknown outcome when completion details fail after intent', async () => {
  const request = { member: '9001', sourceShare: '9001-A', destinationShare: '9001-B', amount: '1.00', memo: 'fixture' };
  const calls = [
    { name: 'click', args: { nameAttr: 'submit', reason: 'post transfer', risk: 'irreversible' } },
    { name: 'extract', args: { nameAttr: 'result', outputName: 'confirmation', reason: 'record confirmation' } },
    { name: 'done', args: { summary: 'complete' } },
  ];
  const stub = guarded({ readText: async () => ({ text: 'ok', report: { strategyUsed: 0, kind: 'nameAttr', matches: 1 } }) });
  const client = { chat: { completions: { create: async () => {
    const call = calls.shift()!;
    return { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: randomUUID(), type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] };
  } } } } as unknown as Parameters<typeof runDiscovery>[4]['openai'];
  const logger = new RunLogger('discovery', new Redactor(), temp(), true);
  const result = await runDiscovery('transfer', `${origin}/menu`, request, [origin], {
    surface: stub.surface,
    logger,
    openai: client,
    model: 'fixture',
    maxSteps: calls.length,
    validateCompletion: outputs => assertTransferOutputs(request, outputs),
  });
  expect(result.status).toBe('stopped');
  expect(result.stopReason).toBe('POST_OUTCOME_UNKNOWN');
  expect(stub.dispatch).toHaveBeenCalledOnce();
  const log = readFileSync(join(logger.dir, 'log.jsonl'), 'utf8');
  expect(log).toContain('"event":"discovery.finish"');
  expect(log).toContain('"status":"stopped"');
  expect(log.split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>).some(event => event.event === 'discovery.finish' && event.status === 'success')).toBe(false);
});

it('runs discovery completion validation before emitting success', async () => {
  const calls = [{ name: 'done', args: { summary: 'complete' } }];
  const stub = guarded();
  const client = { chat: { completions: { create: async () => {
    const call = calls.shift()!;
    return { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: randomUUID(), type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] };
  } } } } as unknown as Parameters<typeof runDiscovery>[4]['openai'];
  const logger = new RunLogger('discovery', new Redactor(), temp(), true);
  const validateCompletion = vi.fn();
  const result = await runDiscovery('read', `${origin}/menu`, {}, [origin], {
    surface: stub.surface, logger, openai: client, model: 'fixture', maxSteps: 1, validateCompletion,
  });
  expect(result.status).toBe('success');
  expect(validateCompletion).toHaveBeenCalledOnce();
  expect(validateCompletion).toHaveBeenCalledWith({});
  const events = readFileSync(join(logger.dir, 'log.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
  expect(events.some(event => event.event === 'discovery.finish' && event.status === 'success')).toBe(true);
});

it('terminates replay unknown after one post when the canonical transaction row is wrong', async () => {
  const artifact = applyMeridianContract(transferArtifact());
  artifact.status = 'approved';
  artifact.steps = artifact.steps.filter(step => ['post', 'post-checkpoint', 'confirmation', 'transaction'].includes(step.id));
  const report = { strategyUsed: 0, kind: 'css', matches: 1 } as const;
  const surface: Surface = {
    mutationDispatched: false,
    start: async () => {},
    observe: async () => ({ url: `${origin}/members/9001/transfer/post`, title: '', frames: [] }),
    currentUrl: () => `${origin}/members/9001/transfer/post`,
    frameUrls: () => [`${origin}/members/9001/transfer/post`],
    navigate: async () => {},
    click: async () => { surface.mutationDispatched = true; return report; },
    fill: async () => report,
    select: async () => report,
    readText: async () => ({ text: 'CONF-123', report }),
    readTable: async () => [{ member: '9001', sourceShare: '9001-A', destinationShare: '9001-B', amount: '2.00', memo: 'fixture', confirmation: 'CONF-123' }],
    isTextVisible: async text => text === 'Transfer complete',
    describeTarget: async descriptor => descriptor,
    screenshot: async () => {},
    close: async () => {},
  };
  const logger = new RunLogger('replay', new Redactor(), temp(), true);
  const params = { member: '9001', sourceShare: '9001-A', destinationShare: '9001-B', amount: '1.00', memo: 'fixture', operator: 'SUPER1', password: 'secret', branch: 'MAIN-001' };
  const result = await runReplay(artifact, params, { surface, logger, policy });
  expect(result.status).toBe('failure');
  expect(result.status === 'failure' && result.failure.code).toBe('POST_OUTCOME_UNKNOWN');
  expect(surface.mutationDispatched).toBe(true);
  const log = readFileSync(join(logger.dir, 'log.jsonl'), 'utf8');
  expect(log).toContain('"event":"replay.failure"');
  expect(log).not.toContain('"event":"replay.success"');
});

describe('numeric replay extraction', () => {
  async function replayWithText(text: string) {
    const artifact = JSON.parse(readFileSync('test/fixtures/hand-lookup.json', 'utf8'));
    artifact.schemaVersion = 2;
    artifact.app.entryUrl = `${origin}/`;
    artifact.app.allowedOrigins = [origin];
    artifact.outputs[0].type = 'number';
    const urls = [`${origin}/`, `${origin}/members`, `${origin}/members`, `${origin}/members/12345`];
    let click = 0;
    const surface: Surface = {
      start: async () => {},
      observe: async () => ({ url: urls.at(-1)!, title: '', frames: [] }),
      currentUrl: () => urls[Math.min(click, urls.length - 1)]!,
      frameUrls: () => [urls[Math.min(click, urls.length - 1)]!],
      navigate: async () => {},
      click: async () => ({ strategyUsed: 0, kind: 'role', matches: 1 }),
      fill: async () => ({ strategyUsed: 0, kind: 'nameAttr', matches: 1 }),
      select: async () => ({ strategyUsed: 0, kind: 'nameAttr', matches: 1 }),
      readText: async () => ({ text, report: { strategyUsed: 0, kind: 'css', matches: 1 } }),
      isTextVisible: async visibleText => visibleText === 'Member Profile',
      describeTarget: async target => target,
      screenshot: async () => {},
      close: async () => {},
    };
    surface.click = async () => {
      click++;
      return { strategyUsed: 0, kind: 'role', matches: 1 };
    };
    return runReplay(CapabilityArtifact.parse(artifact), { memberId: '12345' }, { surface, logger: new RunLogger('replay', new Redactor(), temp()), policy: Policy.parse({ ...policy, allowedOrigins: [origin] }) });
  }

  it('rejects blank numeric text and preserves a real zero', async () => {
    const blank = await replayWithText(' \t ');
    expect(blank.status).toBe('failure');
    expect(blank.status === 'failure' && blank.failure.stepId).toBe('s6');

    const zero = await replayWithText('0');
    expect(zero.status).toBe('success');
    expect(zero.status === 'success' && zero.outputs.savingsBalance).toBe(0);
  });
});

it('resolves parameterized extraction patterns with regex escaping during replay', async () => {
  const artifact = recordArtifact({
    name: 'parameterized-extract', description: '', goal: 'Read a value', entryUrl: `${origin}/`,
    params: { needle: 'a.b+' }, sensitiveParams: [], allowedOrigins: [origin], appId: 'test', appDetectors: [], model: 'test', discoveryRunId: 'test',
  }, {
    status: 'success', outputs: { result: 'a.b+' }, finalUrl: `${origin}/done`, trace: [{
      action: 'extract', reason: 'read value', outputName: 'result', pattern: 'value=(a.b+)', extractedText: 'a.b+', urlAfter: `${origin}/done`,
      descriptor: { description: 'result', strategies: [{ kind: 'nameAttr', name: 'result' }] },
    }],
  });
  artifact.status = 'approved';
  expect(artifact.steps[0]!.extract?.pattern).toBe('value=({{needle}})');
  const surface: Surface = {
    start: async () => {},
    observe: async () => ({ url: `${origin}/done`, title: '', frames: [] }),
    currentUrl: () => `${origin}/done`,
    frameUrls: () => [`${origin}/done`],
    navigate: async () => {},
    click: async () => ({ strategyUsed: 0, kind: 'role', matches: 1 }),
    fill: async () => ({ strategyUsed: 0, kind: 'nameAttr', matches: 1 }),
    select: async () => ({ strategyUsed: 0, kind: 'nameAttr', matches: 1 }),
    readText: async () => ({ text: 'value=a.b+', report: { strategyUsed: 0, kind: 'nameAttr', matches: 1 } }),
    isTextVisible: async () => false,
    describeTarget: async target => target,
    screenshot: async () => {},
    close: async () => {},
  };
  const result = await runReplay(artifact, { needle: 'a.b+' }, { surface, logger: new RunLogger('replay', new Redactor(), temp()), policy });
  expect(result.status).toBe('success');
  expect(result.status === 'success' && result.outputs.result).toBe('a.b+');
});

it.each(["abc'\\def", '123', '4', '{{member}}', '\\31 23'])('drops unsafe CSS %s without echoing data', selector => {
  const a = recordArtifact({ name: 'safe', description: '', goal: '', entryUrl: origin, params: { member: selector === '\\31 23' ? '123' : selector }, sensitiveParams: ['member'], allowedOrigins: [origin], appId: 'test', appDetectors: [], model: 'test', discoveryRunId: 'test' }, { status: 'success', outputs: { invented: 'never extracted' }, finalUrl: origin, trace: [{ action: 'click', reason: '', urlAfter: origin, descriptor: { description: '', strategies: [{ kind: 'css', selector: `[data-id="${selector}"]` }, { kind: 'nameAttr', name: 'safe' }] } }] });
  expect(a.steps[0]!.target!.strategies).toEqual([{ kind: 'nameAttr', name: 'safe' }]); expect(a.outputs).toEqual([]);
});

it('keeps short structural indices and empty inputs without corrupting templates', () => {
  const a = recordArtifact({ name: 'safe', description: '', goal: 'test', entryUrl: origin, params: { empty: '', col: '4' }, sensitiveParams: [], allowedOrigins: [origin], appId: 'test', appDetectors: [], model: 'test', discoveryRunId: 'test' }, { status: 'success', outputs: {}, finalUrl: origin, trace: [{ action: 'fill', value: '', reason: '', urlAfter: origin, descriptor: { description: '', strategies: [{ kind: 'css', selector: 'td:nth-of-type(4)' }] } }] });
  expect(a.steps[0]!.target!.strategies[0]).toEqual({ kind: 'css', selector: 'td:nth-of-type(4)' });
  expect(a.steps[0]!.value).toBe('{{empty}}');
});

it('authenticates API/evidence, denies caller decisions and rejects hostile origins', async () => {
  const dir = temp(), artifactDir = temp(); const journal = new Journal(join(dir, 'journal'), key);
  const run = journal.reserve('operator', 'r', 'hold', '1.0.0', {});
  const service = new InvocationService(journal, policy, profile, dir, [], artifactDir);
  const app = createApp(service, { callerToken: 'c'.repeat(32), operatorToken: 'o'.repeat(32), port: 4180 });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  const address = server.address() as { port: number };
  const request = (path: string, headers = {}, method = 'GET', body?: string) => new Promise<{ status: number; headers: Headers }>((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: address.port, path, method, headers: { Host: '127.0.0.1:4180', 'Content-Type': 'application/json', ...headers } }, response => {
      response.resume(); response.on('end', () => resolve({ status: response.statusCode!, headers: new Headers(response.headers as Record<string, string>) }));
    }); req.on('error', reject); if (body) req.write(body); req.end();
  });
  try {
    expect((await request('/capabilities')).status).toBe(401);
    const caller = { Authorization: `Bearer ${'c'.repeat(32)}` };
    expect((await request(`/runs/${run.runId}`, caller)).status).toBe(403);
    expect((await request('/capabilities', { ...caller, Origin: 'https://evil.test' })).status).toBe(403);
    expect((await request(`/runs/${run.runId}/decision`, caller, 'POST', JSON.stringify({ approvalId: randomUUID(), decision: 'approve' }))).status).toBe(403);
    const fixture = CapabilityArtifact.parse(JSON.parse(readFileSync('test/fixtures/hand-lookup.json', 'utf8')));
    vi.spyOn(service, 'catalog').mockReturnValue([{ id: fixture.id, version: fixture.version, description: fixture.description, parameters: fixture.parameters, outputs: fixture.outputs, tools: toToolSchema(fixture) }]);
    let tool = 'run_status';
    const create = vi.fn(async () => ({ choices: [{ message: { tool_calls: [{ function: { name: tool, arguments: JSON.stringify({ runId: run.runId }) } }] } }] }));
    vi.spyOn(clients, 'makeLLMClient').mockReturnValue({ model: 'fixture', openai: { chat: { completions: { create } } } as unknown as ReturnType<typeof clients.makeLLMClient>['openai'] });
    const chatHeaders = { Authorization: `Bearer ${'o'.repeat(32)}`, 'Idempotency-Key': 'chat-status' };
    const chatBody = JSON.stringify({ messages: [{ role: 'user', content: 'Get status' }] });
    expect((await request('/chat', chatHeaders, 'POST', chatBody)).status).toBe(403); // operator chat is caller-bound
    for (tool of ['approve', 'select_supervisor']) expect((await request('/chat', chatHeaders, 'POST', chatBody)).status).toBe(403);

    const session = new ControlSession();
    const approval = new Approval(session, () => {}, Date.now() + 600_000);
    const pending = approval.wait({ kind: 'replay_stuck', capability: 'hold', goal: 'apply hold', reason: 'stuck', url: origin });
    service.live.set(run.runId, { state: 'awaiting-human', inputs: {}, started: Date.now(), approval });
    const operator = { Authorization: `Bearer ${'o'.repeat(32)}` };
    expect((await request(`/runs/${run.runId}/decision`, operator, 'POST', JSON.stringify({ approvalId: randomUUID(), decision: 'retry' }))).status).toBe(409);
    const approvalId = approval.pending!.id;
    expect((await request(`/runs/${run.runId}/decision`, operator, 'POST', JSON.stringify({ approvalId, decision: 'approve' }))).status).toBe(409);
    expect((await request(`/runs/${run.runId}/decision`, operator, 'POST', JSON.stringify({ approvalId, decision: 'abort' }))).status).toBe(200);
    expect(await pending).toBe('abort');
    expect((await request(`/runs/${run.runId}/decision`, operator, 'POST', JSON.stringify({ approvalId, decision: 'retry' }))).status).toBe(409);
    expect((await request(`/runs/${run.runId}/evidence/missing.json`, caller)).status).toBe(403);
    expect((await request(`/runs/${run.runId}/evidence/missing.json`, operator)).status).toBe(404);
    expect(journal.records.size).toBe(1);
    const response = await request('/capabilities', caller); expect(response.status).toBe(200); expect(response.headers.get('content-security-policy')).toContain("object-src 'none'");
  } finally { await new Promise<void>(r => server.close(() => r())); journal.close(); }
});

it('reports assert-only and fatal-detector steps through the service API', async () => {
  const previous = {
    operator: process.env.MERIDIAN_TELLER_OPERATOR,
    password: process.env.MERIDIAN_TELLER_PASSWORD,
    branch: process.env.MERIDIAN_BRANCH,
  };
  process.env.MERIDIAN_TELLER_OPERATOR = 'SUPER1';
  process.env.MERIDIAN_TELLER_PASSWORD = 'SECRET';
  process.env.MERIDIAN_BRANCH = 'MAIN-001';
  let fatalVisible = false;
  vi.spyOn(runtime, 'createRuntime').mockImplementation(options => {
    let currentStep = '(start)';
    const surface = {
      get currentStep() { return currentStep; },
      setStep: (id: string) => { currentStep = id; },
      start: async () => {},
      observe: async () => ({ url: `${origin}/fixture`, title: '', frames: [] }),
      currentUrl: () => `${origin}/fixture`,
      frameUrls: () => [`${origin}/fixture`],
      navigate: async () => {},
      click: async () => ({ strategyUsed: 0, kind: 'css', matches: 1 }),
      fill: async () => ({ strategyUsed: 0, kind: 'nameAttr', matches: 1 }),
      select: async () => ({ strategyUsed: 0, kind: 'nameAttr', matches: 1 }),
      readText: async () => ({ text: '', report: { strategyUsed: 0, kind: 'css', matches: 1 } }),
      readTable: async () => [{ share: 'A' }],
      isTextVisible: async (text: string) => text === 'ASSERT READY' || (text === 'FATAL FIXTURE' && fatalVisible && currentStep === 'verify-member'),
      describeTarget: async (target: Parameters<Surface['describeTarget']>[0]) => target,
      screenshot: async () => {},
      close: async () => {},
    } as unknown as ReturnType<typeof runtime.createRuntime>['surface'];
    const logger = new RunLogger(options.kind, new Redactor(), options.evidenceDir ?? temp(), true, options.runId, options.onEvent);
    return {
      surface,
      browser: { page: {} } as ReturnType<typeof runtime.createRuntime>['browser'],
      logger,
      session: options.session ?? new ControlSession(),
      redactor: new Redactor(),
      promptRedactor: new Redactor(),
      deadline: Date.now() + 600_000,
      close: async () => {},
    } as ReturnType<typeof runtime.createRuntime>;
  });

  const runFixture = async (keyName: string) => {
    const dir = temp();
    const artifactDir = temp();
    writeFileSync(join(artifactDir, 'fixture.json'), JSON.stringify(stepReportingArtifact()));
    const journal = new Journal(join(dir, 'journal'), key);
    const service = new InvocationService(journal, policy, profile, dir, ['meridian-member-record'], artifactDir);
    try {
      const runId = service.invoke('caller', 'meridian-member-record', { member: '1' }, keyName).runId;
      await service.close();
      return service.get('caller', runId);
    } finally { journal.close(); }
  };

  try {
    fatalVisible = false;
    expect((await runFixture('assert-step')).step).toBe('verify-member');
    fatalVisible = true;
    const fatal = await runFixture('fatal-step');
    expect(fatal.step).toBe('verify-member');
    expect(fatal.result).toMatchObject({ status: 'failure', failure: { stepId: 'verify-member', code: 'FIXTURE_FATAL' } });
  } finally {
    if (previous.operator === undefined) delete process.env.MERIDIAN_TELLER_OPERATOR; else process.env.MERIDIAN_TELLER_OPERATOR = previous.operator;
    if (previous.password === undefined) delete process.env.MERIDIAN_TELLER_PASSWORD; else process.env.MERIDIAN_TELLER_PASSWORD = previous.password;
    if (previous.branch === undefined) delete process.env.MERIDIAN_BRANCH; else process.env.MERIDIAN_BRANCH = previous.branch;
  }
});

it('extracts typed rows and blocks unsolicited browser POSTs through the real surface', async () => {
  const app = express(); let posted = 0;
  app.get('/menu', (_req, res) => res.send('<p>Signed on as J. SUPERVISOR (SUPERVISOR)</p><p>OPR SUPER1 | BR MAIN-001 | SID fixture-session</p>'));
  app.get('/members', (_req, res) => res.send('<table id="shares"><tr><th>Share</th><th>Balance</th></tr><tr><td>A</td><td>$12.30</td></tr></table><select name="share"><option value="A">A ($12.30)</option><option value="B">B ($3.00)</option></select>'));
  app.post('/members/1/update', (_req, res) => { posted++; res.end('saved'); });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r)); const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  const capturedSensitive: string[] = [];
  const browser = new BrowserSurface({ allowedOrigins: [origin], profile, sensitive: values => capturedSensitive.push(...values) });
  try {
    await browser.start(`${origin}/members`);
    const table = (await browser.observe()).frames[0]!.tables![0]!;
    expect(table.headers).toEqual(['Share', 'Balance']);
    await expect(browser.readText({ description: 'missing frame', frame: 'missing', strategies: [{ kind: 'css', selector: '#shares' }] })).rejects.toThrow(/Requested frame does not exist/);
    expect(table.headerCells).toEqual(['th', 'th']);
    expect(await browser.page.locator(table.selector).count()).toBe(1);
    const rows = await browser.readTable({ description: 'shares', strategies: [{ kind: 'css', selector: '#shares' }] }, [{ name: 'share', selector: 'td:nth-child(1)', type: 'string' }, { name: 'balance', selector: 'td:nth-child(2)', type: 'money' }]);
    expect(rows).toEqual([{ share: 'A', balance: '12.30' }]);
    expect(capturedSensitive).toContain('12.30');
    await browser.select({ description: 'share', strategies: [{ kind: 'nameAttr', name: 'share' }] }, 'B', 1000, 'read', 'value');
    expect(await browser.page.locator('select').inputValue()).toBe('B');
    await browser.page.evaluate(() => fetch('/members/1/update', { method: 'POST' }).catch(() => {})); expect(posted).toBe(0);
    const dir = temp(); const logger = new RunLogger('replay', new Redactor(), dir, true); logger.log('error', { password: 'PRIVATE', params: { member: 'PRIVATE' }, observed: 'PRIVATE' }); logger.writeResult({ status: 'success', outputs: { name: 'PRIVATE' } });
    expect(readdirSync(logger.dir).map(f => readFileSync(join(logger.dir, f), 'utf8')).join('')).not.toContain('PRIVATE');
  } finally { await browser.close(); await new Promise<void>(r => server.close(() => r())); }
}, 15000);

it('scopes transfer review facts to its form table and rejects duplicate labels', async () => {
  const app = express();
  const review = (variant: 'duplicate' | 'nested' | 'hidden-table' | 'hidden-row' | 'hidden-label-child' | 'hidden-value-child' | 'clean' = 'clean') => {
    const duplicate = variant === 'duplicate';
    const tableStyle = variant === 'hidden-table' ? ' style="display:none"' : '';
    const rowStyle = variant === 'hidden-row' ? ' style="display:none"' : '';
    const row = (label: string, value: string) => `<tr${rowStyle}><td class="lbl">${variant === 'hidden-label-child' && label === 'Amount:' ? `<span style="display:none">${label}</span>` : label}</td><td>${variant === 'hidden-value-child' && label === 'Amount:' ? `<span style="display:none">${value}</span>` : value}</td></tr>`;
    const nested = variant === 'nested' ? '<tr><td colspan="2"><table id="nested-decoy"><tr><td class="lbl">Member:</td><td>9001 - Decoy</td></tr><tr><td class="lbl">From:</td><td>9001-A ($99.00)</td></tr><tr><td class="lbl">To:</td><td>9001-B ($0.00)</td></tr><tr><td class="lbl">Amount:</td><td>$99.00</td></tr><tr><td class="lbl">Memo:</td><td>decoy</td></tr></table></td></tr>' : '';
    const rows = [row('Member:', '9001 - Fixture Member'), row('From:', '9001-A ($2.00)'), row('To:', '9001-B ($0.00)'), row('Amount:', '$1.00'), row('Memo:', 'fixture')].join('');
    return `<form method="post" action="/members/9001/transfer/post"><input type="hidden" name="_token" value="TOKEN"><select name="from"><option value="9001-A" selected>9001-A</option></select><select name="to"><option value="9001-B" selected>9001-B</option></select><input name="amount" value="1.00"><textarea name="memo">fixture</textarea><table id="actual-review"${tableStyle}>${rows}${duplicate ? '<tr><td class="lbl">Memo:</td><td>conflicting</td></tr>' : ''}${nested}</table><input type="submit" value="Post Transfer"></form><table><tr><td class="lbl">Member:</td><td>unrelated</td></tr></table>`;
  };
  app.get('/members/9001/transfer/review', (req, res) => res.send(review(req.query.duplicate === '1' ? 'duplicate' : req.query.nested === '1' ? 'nested' : req.query.hiddenTable === '1' ? 'hidden-table' : req.query.hiddenRow === '1' ? 'hidden-row' : req.query.hiddenLabelChild === '1' ? 'hidden-label-child' : req.query.hiddenValueChild === '1' ? 'hidden-value-child' : 'clean')));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const localOrigin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = new BrowserSurface({ allowedOrigins: [localOrigin] });
  const post = { description: 'Post Transfer', strategies: [{ kind: 'role' as const, role: 'button', name: 'Post Transfer' }] };
  try {
    await browser.start(`${localOrigin}/members/9001/transfer/review`);
    const prepared = await browser.prepareClick(post);
    const inspected = await prepared.inspect();
    expect(inspected.facts).toMatchObject({
      member: '9001', from: '9001-A', to: '9001-B', amount: '1.00', memo: 'fixture',
      'review:Member:': '9001 - Fixture Member', 'review:From:': '9001-A ($2.00)', 'review:To:': '9001-B ($0.00)',
      'review:Amount:': '$1.00', 'review:Memo:': 'fixture',
    });
    expect(inspected.frame).toMatchObject({ name: '', url: `${localOrigin}/members/9001/transfer/review`, navigation: expect.any(Number) });
    expect(browser.currentFrame()).toEqual(inspected.frame);
    await browser.navigate(`${localOrigin}/members/9001/transfer/review?nested=1`);
    const nested = await browser.prepareClick(post);
    await expect(nested.inspect()).rejects.toThrow(/ambiguous/);
    await browser.navigate(`${localOrigin}/members/9001/transfer/review?duplicate=1`);
    const duplicate = await browser.prepareClick(post);
    await expect(duplicate.inspect()).rejects.toThrow(/Duplicate form fact/);
    await browser.navigate(`${localOrigin}/members/9001/transfer/review?hiddenTable=1`);
    const hiddenTable = await browser.prepareClick(post);
    await expect(hiddenTable.inspect()).rejects.toThrow(/ambiguous/);
    await browser.navigate(`${localOrigin}/members/9001/transfer/review?hiddenRow=1`);
    const hiddenRow = await browser.prepareClick(post);
    await expect(hiddenRow.inspect()).rejects.toThrow(/ambiguous/);
    await browser.navigate(`${localOrigin}/members/9001/transfer/review?hiddenLabelChild=1`);
    const hiddenLabelChild = await browser.prepareClick(post);
    await expect(hiddenLabelChild.inspect()).rejects.toThrow(/ambiguous/);
    await browser.navigate(`${localOrigin}/members/9001/transfer/review?hiddenValueChild=1`);
    const hiddenValueChild = await browser.prepareClick(post);
    await expect(hiddenValueChild.inspect()).resolves.toMatchObject({ facts: { 'review:Amount:': '' } });
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 15000);

it('allows a native Continue form before the transfer review page', async () => {
  const app = express();
  app.get('/members/9001/transfer', (_req, res) => res.send('<form method="post" action="/members/9001/transfer/review"><input type="hidden" name="_token" value="TOKEN"><select name="from"><option value="9001-A" selected>9001-A</option></select><select name="to"><option value="9001-B" selected>9001-B</option></select><input name="amount" value="1.00"><textarea name="memo">fixture</textarea><input type="submit" value="Continue"></form>'));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const localOrigin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = new BrowserSurface({ allowedOrigins: [localOrigin] });
  const continueTarget = { description: 'Continue', strategies: [{ kind: 'role' as const, role: 'button', name: 'Continue' }] };
  try {
    await browser.start(`${localOrigin}/members/9001/transfer`);
    const prepared = await browser.prepareClick(continueTarget);
    await expect(prepared.inspect()).resolves.toMatchObject({ facts: { member: '9001', from: '9001-A', to: '9001-B', amount: '1.00', memo: 'fixture' } });
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 15000);

it('keeps a legitimate transfer control bound to its workarea frame in a frameset', async () => {
  const app = express();
  let posted = 0;
  const form = '<form method="post" action="/members/9001/transfer/post"><input type="hidden" name="_token" value="TOKEN"><select name="from"><option value="9001-A" selected>9001-A</option></select><select name="to"><option value="9001-B" selected>9001-B</option></select><input name="amount" value="1.00"><textarea name="memo">fixture</textarea><table><tr><td class="lbl">Member:</td><td>9001 - Fixture Member</td></tr><tr><td class="lbl">From:</td><td>9001-A ($2.00)</td></tr><tr><td class="lbl">To:</td><td>9001-B ($0.00)</td></tr><tr><td class="lbl">Amount:</td><td>$1.00</td></tr><tr><td class="lbl">Memo:</td><td>fixture</td></tr></table><input type="submit" value="Post Transfer"></form>';
  app.get('/frameset', (_req, res) => res.type('html').send('<frameset cols="20%,80%"><frame name="nav" src="/nav"><frame name="workarea" src="/members/9001/transfer/review"></frameset>'));
  app.get('/nav', (_req, res) => res.send('<p>Navigation</p>'));
  app.get('/members/9001/transfer/review', (_req, res) => res.send(form));
  app.post('/members/9001/transfer/post', (_req, res) => { posted++; res.send('<p>posted</p>'); });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const localOrigin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = new BrowserSurface({ allowedOrigins: [localOrigin] });
  const post = { description: 'Post Transfer', strategies: [{ kind: 'role' as const, role: 'button', name: 'Post Transfer' }] };
  try {
    await browser.start(`${localOrigin}/frameset`);
    expect(browser.currentUrl()).toBe(`${localOrigin}/members/9001/transfer/review`);
    const prepared = await browser.prepareClick(post);
    const live = await prepared.inspect();
    expect(live.frame).toMatchObject({ name: 'workarea', url: `${localOrigin}/members/9001/transfer/review`, navigation: expect.any(Number) });
    expect(browser.currentFrame()).toEqual(live.frame);
    await prepared.dispatch(live, 3000);
    expect(posted).toBe(1);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 15000);

it('stops replay with no target POST when the browser closes before intervention', async () => {
  const app = express();
  let posted = 0;
  app.get('/start', (_req, res) => res.send('<form method="post" action="/mutate"><input type="submit" value="Mutate"></form>'));
  app.post('/mutate', (_req, res) => { posted++; res.end('mutated'); });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  const localOrigin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = new BrowserSurface({ allowedOrigins: [localOrigin] });
  const start = browser.start.bind(browser);
  browser.start = async entryUrl => { await start(entryUrl); await browser.page.close(); };
  const logger = new RunLogger('replay', new Redactor(), temp());
  const session = new ControlSession();
  const escalated = vi.fn(async request => new OperatorConsole(browser.page, logger, session).intervene(request));
  const artifact = CapabilityArtifact.parse({
    schemaVersion: 1, id: 'closed-browser', name: 'closed-browser', description: 'closed browser fixture', version: '1.0.0', status: 'approved',
    app: { appId: 'fixture', entryUrl: `${localOrigin}/start`, allowedOrigins: [localOrigin] }, parameters: [], outputs: [],
    steps: [{ id: 'mutate', intent: 'submit mutation', action: 'click', target: { description: 'Mutate', strategies: [{ kind: 'role', role: 'button', name: 'Mutate' }] }, risk: 'read' }],
    successCondition: { kind: 'urlMatches', pattern: '.*' }, detectors: [],
    provenance: { discoveredAt: '', model: '', discoveryRunId: '', goal: '' },
  });
  try {
    const result = await runReplay(artifact, {}, { surface: browser, logger, policy: Policy.parse({ ...policy, allowedOrigins: [localOrigin] }), escalate: escalated });
    expect(result.status).toBe('failure');
    if (result.status === 'failure') expect(result.escalated).toBe(true);
    expect(escalated).toHaveBeenCalledOnce();
    expect(session.currentOwner).toBe('automation');
    expect(browser.page.isClosed()).toBe(true);
    expect(posted).toBe(0);
  } finally { await browser.close(); await new Promise<void>(r => server.close(() => r())); }
}, 15000);

it('downgrades an unknown-page screenshot to metadata-only evidence', async () => {
  const app = express();
  app.get('/known', (_req, res) => res.send('<main>known</main>'));
  app.get('/unknown', (_req, res) => res.send('<main>unknown</main>'));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  const localOrigin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const localProfile = { ...profile, entryUrl: `${localOrigin}/known`, routes: ['^/known$', '^/unknown$'], maskSelectors: ['body'] };
  const browser = new BrowserSurface({ allowedOrigins: [localOrigin], profile: localProfile });
  const logger = new RunLogger('replay', new Redactor(), temp(), true);
  try {
    await browser.start(`${localOrigin}/known`);
    await browser.navigate(`${localOrigin}/unknown`);
    localProfile.routes = ['^/known$'];
    expect(await logger.screenshot(browser, 'unknown-page')).toBe('(metadata-only evidence)');
    expect(readFileSync(join(logger.dir, 'log.jsonl'), 'utf8')).toContain('evidence.warning');
    expect(readFileSync(join(logger.dir, 'log.jsonl'), 'utf8')).not.toContain('/unknown');
    expect(readdirSync(logger.dir).some(file => file.endsWith('.png'))).toBe(false);
  } finally { await browser.close(); await new Promise<void>(r => server.close(() => r())); }
}, 15000);

it('rechecks a real form before approved dispatch and masks dynamic evidence end to end', async () => {
  const app = express(); let posted = 0;
  app.get('/menu', (_req, res) => res.send('<p>Signed on as J. SUPERVISOR (SUPERVISOR)</p><p>OPR SUPER1 | BR MAIN-001 | SID fixture-session</p>'));
  app.get('/members/1/update', (_req, res) => res.send('<p>OPR SUPER1 | BR MAIN-001 | SID fixture-session</p><div class="box" style="width:500px;height:180px"><span id="member">PRIVATE-FIRST</span><form method="post" action="/members/1/update"><input type="hidden" name="_token" value="TOKEN-PRIVATE"><input name="email" value="first@example.test"><input name="phone" value="5550001111"><input name="address" value="PRIVATE STREET"><input type="submit" value="Save Changes"></form></div>'));
  app.post('/members/1/update', (_req, res) => { posted++; res.end('<h1>Saved</h1>'); });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r)); const address = server.address() as { port: number };
  const localOrigin = `http://127.0.0.1:${address.port}`;
  const redactor = new Redactor();
  const promptRedactor = new Redactor();
  const browser = new BrowserSurface({ allowedOrigins: [localOrigin], profile: { ...profile, maskSelectors: ['.box', 'p', 'input', 'textarea', 'select'] }, sensitive: (values, secrets = []) => { redactor.addSensitiveValues(values); promptRedactor.addSensitiveValues(secrets); } });
  let changed = true;
  const gate = async () => { if (changed) await browser.page.locator('[name=email]').fill('changed@example.test'); return true; };
  const guard = new GuardedSurface(browser, { ...policy, allowedOrigins: [localOrigin] }, gate, undefined, { profile, session: new ControlSession(), deadline: Date.now() + 10000, runId: randomUUID(), artifact: 'update', version: '1.0.0', operator: 'super1', branch: 'MAIN-001', role: 'SUPERVISOR', beforeDispatch: () => expect(posted).toBe(0) });
  const button = { description: 'Save Changes', strategies: [{ kind: 'role' as const, role: 'button', name: 'Save Changes' }] };
  try {
    await guard.start(`${localOrigin}/menu`);
    await guard.navigate(`${localOrigin}/members/1/update`);
    const logger = new RunLogger('replay', redactor, temp(), true);
    const first = await logger.screenshot(guard, 'first');
    expect(promptRedactor.redactString('TOKEN-PRIVATE first@example.test')).not.toContain('TOKEN-PRIVATE');
    expect(promptRedactor.redactString('TOKEN-PRIVATE first@example.test')).toContain('first@example.test');
    expect(redactor.redactString('first@example.test')).not.toContain('first@example.test');
    await browser.page.locator('#member').evaluate(e => { e.textContent = 'PRIVATE-OTHER'; });
    await browser.page.locator('[name=email]').fill('other@example.test');
    const second = await logger.screenshot(guard, 'second');
    expect(readFileSync(first).equals(readFileSync(second))).toBe(true);
    logger.log('sample', { observed: 'TOKEN-PRIVATE', outputs: { member: 'PRIVATE-OTHER' } });
    expect(readdirSync(logger.dir).filter(f => !f.endsWith('.png')).map(f => readFileSync(join(logger.dir, f), 'utf8')).join('')).not.toMatch(/TOKEN-PRIVATE|PRIVATE-OTHER|example.test/);
    await expect(guard.click(button, 3000, 'read')).rejects.toThrow(/invalidated/); expect(posted).toBe(0);
    changed = false;
    await guard.click(button, 3000, 'read'); expect(posted).toBe(1); expect(guard.mutationDispatched).toBe(true);
  } finally { await browser.close(); await new Promise<void>(r => server.close(() => r())); }
}, 15000);

it.each(['role', 'session', 'detector', 'token', 'submit-handler', 'formdata-handler'] as const)('refuses a real posting after %s changes', async scenario => {
  const app = express(); let posted = 0;
  app.get('/menu', (_req, res) => res.send(`<p>Signed on as J. OPERATOR (${scenario === 'role' ? 'TELLER' : 'SUPERVISOR'})</p><p>OPR SUPER1 | BR MAIN-001 | SID session-one</p>`));
  app.get('/members/1/update', (_req, res) => res.send('<p id="identity">OPR SUPER1 | BR MAIN-001 | SID session-one</p><form method="post"><input type="hidden" name="_token" value="private-token"><input name="email" value="approved@example.test"><input type="submit" value="Save Changes"></form>'));
  app.post('/members/1/update', (_req, res) => { posted++; res.end('Saved'); });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  const localOrigin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = new BrowserSurface({ allowedOrigins: [localOrigin], profile });
  const beforeDispatch = vi.fn();
  const gate = vi.fn(async () => {
    await browser.page.evaluate(kind => {
      if (kind === 'session') document.querySelector('#identity')!.textContent = 'OPR SUPER1 | BR MAIN-001 | SID session-two';
      if (kind === 'detector') document.body.append('YOUR SESSION HAS TIMED OUT');
      if (kind === 'token') (document.querySelector('[name=_token]') as HTMLInputElement).value = 'replacement-token';
      if (kind === 'submit-handler') document.querySelector('form')!.addEventListener('submit', () => { (document.querySelector('[name=email]') as HTMLInputElement).value = 'unapproved@example.test'; });
      if (kind === 'formdata-handler') document.querySelector('form')!.addEventListener('formdata', e => { e.formData.set('email', 'unapproved@example.test'); });
    }, scenario);
    return true;
  });
  const guard = new GuardedSurface(browser, { ...policy, allowedOrigins: [localOrigin] }, gate, undefined, { profile, session: new ControlSession(), deadline: Date.now() + 10000, runId: randomUUID(), artifact: 'update', version: '1.0.0', operator: 'super1', branch: 'MAIN-001', role: 'SUPERVISOR', beforeDispatch });
  try {
    await guard.start(`${localOrigin}/menu`); await guard.navigate(`${localOrigin}/members/1/update`);
    await expect(guard.click({ description: 'save', strategies: [{ kind: 'role', role: 'button', name: 'Save Changes' }] }, 1000)).rejects.toThrow();
    expect(posted).toBe(0);
    expect(beforeDispatch).toHaveBeenCalledTimes(scenario === 'submit-handler' ? 1 : 0);
    expect(guard.mutationDispatched).toBe(scenario === 'submit-handler');
    if (scenario === 'role') expect(gate).not.toHaveBeenCalled();
  } finally { await browser.close(); await new Promise<void>(r => server.close(() => r())); }
});

it('records assertions, resolves credential references privately, and ignores invented done outputs', async () => {
  const calls = [
    { name: 'fill', args: { nameAttr: 'password', value: '{{password}}', reason: 'sign on' } },
    { name: 'select', args: { nameAttr: 'branch', value: '{{branch}}', selectBy: 'value', reason: 'select configured branch' } },
    { name: 'assert', args: { kind: 'textVisible', text: 'done', reason: 'verify' } },
    { name: 'done', args: { summary: 'complete', outputs: { invented: 'not extracted' } } },
  ];
  const requests: string[] = []; const fill = vi.fn(async (_target: unknown, _value: string) => ({ strategyUsed: 0, kind: 'nameAttr', matches: 1 }));
  const select = vi.fn(async (_target: unknown, _value: string) => ({ strategyUsed: 0, kind: 'nameAttr', matches: 1 }));
  const stub = guarded({ fill, select, isTextVisible: async text => text === 'done' });
  const client = { chat: { completions: { create: async (request: unknown) => {
    requests.push(JSON.stringify(request)); const call = calls.shift()!;
    return { choices: [{ message: { role: 'assistant', tool_calls: [{ id: randomUUID(), type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] };
  } } } } as unknown as Parameters<typeof runDiscovery>[4]['openai'];
  const result = await runDiscovery('sign on', `${origin}/signon`, { password: '{{password}}' }, [origin], { surface: stub.surface, logger: new RunLogger('discovery', new Redactor(), temp(), true), openai: client, model: 'fixture', maxSteps: 5, boundParams: { password: 'SECRET-LITERAL', branch: 'MAIN-001' } });
  expect(result.status).toBe('success'); expect(result.trace[0]?.value).toBe('{{password}}'); expect(result.trace[2]?.action).toBe('assert');
  expect(select.mock.calls[0]?.[1]).toBe('MAIN-001');
  expect(fill.mock.calls[0]?.[1]).toBe('SECRET-LITERAL'); expect(requests.join('')).not.toContain('SECRET-LITERAL'); expect(result.outputs).toEqual({});
});

it('redacts extracted secrets before sending tool results to discovery', async () => {
  const requests: string[] = [];
  const calls = [ { name: 'extract', args: { nameAttr: 'result', outputName: 'result', reason: 'read' } }, { name: 'done', args: { summary: 'done' } } ];
  const stub = guarded({ readText: async () => ({ text: 'SID PRIVATE-SESSION', report: { strategyUsed: 0, kind: 'nameAttr', matches: 1 } }) });
  const client = { chat: { completions: { create: async (request: unknown) => {
    requests.push(JSON.stringify(request)); const call = calls.shift()!;
    return { choices: [{ message: { role: 'assistant', tool_calls: [{ id: randomUUID(), type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] };
  } } } } as unknown as Parameters<typeof runDiscovery>[4]['openai'];
  const result = await runDiscovery('read', `${origin}/signon`, {}, [origin], { surface: stub.surface, logger: new RunLogger('discovery', new Redactor(), temp(), true), openai: client, model: 'fixture', maxSteps: 2, sanitizeObservation: text => text.replaceAll('PRIVATE-SESSION', '[REDACTED]') });
  expect(result.outputs.result).toBe('SID PRIVATE-SESSION');
  expect(requests.join('')).not.toContain('PRIVATE-SESSION');
  expect(requests[1]).toContain('SID [REDACTED]');
});

it('renders the dashboard and hostile chat strings inertly without storing credentials', async () => {
  const dir = temp(), artifactDir = temp();
  const artifact = JSON.parse(readFileSync('test/fixtures/hand-lookup.json', 'utf8'));
  artifact.status = 'approved'; artifact.parameters[0].description = '<img src=x onerror=alert(1)>';
  writeFileSync(join(artifactDir, 'lookup.json'), JSON.stringify(artifact));
  const journal = new Journal(join(dir, 'journal'), key);
  const service = new InvocationService(journal, policy, loadProfile('cu-nexus'), dir, [artifact.id], artifactDir);
  const server = createServer(); server.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  const address = server.address() as { port: number };
  server.on('request', createApp(service, { callerToken: 'c'.repeat(32), operatorToken: 'o'.repeat(32), port: address.port }));
  const browser = await chromium.launch(); const page = await browser.newPage();
  try {
    await page.route('**/runs', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify([
      { runId: 'known-run', kind: 'replay', capability: artifact.id, state: 'success', elapsedMs: 2476, evidence: [], result: { status: 'success', outputs: {} } },
      { runId: 'zero-run', kind: 'replay', capability: artifact.id, state: 'success', elapsedMs: 0, evidence: [], result: { status: 'success', outputs: {} } },
      { runId: 'historical-run', kind: 'replay', capability: artifact.id, state: 'success', sensitiveValuesUnavailable: true, evidence: [], result: { status: 'success', outputs: {} } },
    ]) }));
    await page.goto(`http://127.0.0.1:${address.port}`); await page.locator('#credential').fill('o'.repeat(32)); await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.locator('#workspace').waitFor({ state: 'visible' });
    expect(await page.locator('#role-label').isVisible()).toBe(true);
    expect(await page.locator('#credential').inputValue()).toBe(''); expect(await page.locator('#fields img').count()).toBe(0);
    expect(await page.locator('#runs article').filter({ hasText: 'Elapsed: 2.5 s' }).count()).toBe(1);
    expect(await page.locator('#runs article').filter({ hasText: 'Elapsed: 0 ms' }).count()).toBe(1);
    const historical = page.locator('#runs article').filter({ hasText: 'Historical sensitive values are unavailable.' });
    expect(await historical.count()).toBe(1); expect(await historical.getByText(/Elapsed:/).count()).toBe(0);
    await page.route('**/chat', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ message: '<img src=x onerror=alert(1)>' }) }));
    await page.locator('#message').fill('Check my balance'); await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('#messages p').first().waitFor(); expect(await page.locator('#messages img').count()).toBe(0);
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
    await page.locator('#credential').fill('c'.repeat(32)); await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('status')?.textContent?.includes('Connected as caller'));
    expect(await page.locator('#role-label').isHidden()).toBe(true);
  } finally { await browser.close(); await new Promise<void>(r => server.close(() => r())); journal.close(); }
}, 15000);

it('extracts a single named value without returning its surrounding session data', () => {
  expect(extractText('OPR TELLER1 | BR MAIN-001 | SID PRIVATE', 'OPR\\s+(\\S+)')).toBe('TELLER1');
  expect(extractText('plain legacy output')).toBe('plain legacy output');
  for (const text of ['no operator', 'OPR ONE OPR TWO']) expect(() => extractText(text, 'OPR\\s+(\\S+)')).toThrow();
});

it('maps the displayed main-frame label to the actual main frame', () => {
  expect(hintToDescriptor({ frame: '(main)', nameAttr: 'operator' }, 'fill').frame).toBe('');
});

it('masks whole sensitive values before their overlapping prefixes', () => {
  const redactor = new Redactor();
  redactor.addSensitiveValues(['100234', '100234-S0001']);
  expect(redactor.redactString('100234-S0001')).toBe('•••redacted•••');
});

it('requires every server-reference login action before discovery submits sign-on', async () => {
  const dispatch = vi.fn(async () => ({ strategyUsed: 0, kind: 'role', matches: 1 }));
  const surface = guarded({ currentUrl: () => `${origin}/signon`, click: dispatch }).surface;
  const messages: string[] = [];
  const calls = [{ name: 'click', args: { role: 'button', name: 'Sign On', reason: 'sign on', risk: 'reversible_write' } }, { name: 'done', args: { summary: 'stopped' } }];
  const client = { chat: { completions: { create: async (request: unknown) => {
    messages.push(JSON.stringify(request)); const call = calls.shift()!;
    return { choices: [{ message: { role: 'assistant', tool_calls: [{ id: randomUUID(), type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] };
  } } } } as unknown as Parameters<typeof runDiscovery>[4]['openai'];
  await runDiscovery('sign on', `${origin}/signon`, {}, [origin], { surface, logger: new RunLogger('discovery', new Redactor(), temp()), openai: client, model: 'fixture', maxSteps: 2, boundParams: { operator: 'runtime-user', password: 'runtime-secret', branch: 'runtime-branch' } });
  expect(dispatch).not.toHaveBeenCalled();
  expect(messages[1]).toContain('Record the explicit server-reference');
  expect(messages.join('')).not.toContain('runtime-secret');
});


it.each([false, true])('evaluates real runtime attempts with observer failure and uncertain=%s', async uncertain => {
  const dir = temp(); const journal = new Journal(join(dir, 'journal'), key);
  const record = journal.reserve('test', 'request', 'hold', '1.0.0', {});
  const logger = new RunLogger('replay', new Redactor(), dir, true, record.runId, async () => { throw new Error('offline telemetry'); });
  const dispatch = vi.fn(async () => { if (uncertain) throw new Error('lost response'); return { strategyUsed: 0, kind: 'role', matches: 1 }; });
  const run = guarded({ prepareClick: async () => ({ inspect: async () => control, dispatch }) }, async () => true,
    { runId: record.runId, beforeDispatch: () => journal.update(record.runId, 'dispatching') }, (event, data) => logger.log(event, data));
  const artifact = CapabilityArtifact.parse({ schemaVersion: 2, id: 'hold', name: 'hold', description: 'hold', version: '1.0.0', status: 'approved', app: { appId: 'meridian', entryUrl: `${origin}/signon`, allowedOrigins: [origin] }, parameters: [], outputs: [], steps: [{ id: 'post', action: 'click', intent: 'post', target, risk: 'read' }], successCondition: { kind: 'textVisible', text: 'done' }, provenance: { discoveredAt: '', model: '', discoveryRunId: '', goal: '' } });
  const escalate = vi.fn(async () => 'retry' as const);
  try {
    journal.update(record.runId, 'running');
    const result = await runReplay(artifact, {}, { surface: run.surface, logger, policy, escalate });
    journal.update(record.runId, result.status);
    expect(dispatch).toHaveBeenCalledTimes(1); expect(escalate).not.toHaveBeenCalled();
    const evidence = readFileSync(join(logger.dir, 'log.jsonl'), 'utf8');
    expect(evaluateRun(evidence, journal.records.get(record.runId)!)).toMatchObject({ status: uncertain ? 'unknown' : 'pass', mutationIntents: 1, riskDisagreements: 1 });
    expect(evidence).not.toContain(origin);
    const service = new InvocationService(journal, policy, profile, dir, [], temp());
    // A stale in-memory presentation must never override terminal journal truth.
    service.live.set(record.runId, { state: 'failure', inputs: {}, started: 0, approval: new Approval(new ControlSession(), () => {}, Date.now() + 1000) });
    expect(service.get('operator', record.runId).state).toBe(uncertain ? 'POST_OUTCOME_UNKNOWN' : 'success');
  } finally { journal.close(); }
});


it('assigns a fresh guarded attempt to an operator retry of the same replay step', async () => {
  const logger = new RunLogger('replay', new Redactor(), temp(), true);
  let count = 0;
  const dispatch = async () => { if (++count === 1) throw new Error('read interrupted'); return { strategyUsed: 0, kind: 'role', matches: 1 }; };
  const live = { ...control, submit: false, method: 'GET', destination: `${origin}/members` };
  const run = guarded({ prepareClick: async () => ({ inspect: async () => live, dispatch }) }, async () => true, {}, (event, data) => logger.log(event, data));
  const artifact = CapabilityArtifact.parse({ schemaVersion: 2, id: 'inquiry', name: 'inquiry', description: 'inquiry', version: '1.0.0', status: 'approved', app: { appId: 'meridian', entryUrl: `${origin}/signon`, allowedOrigins: [origin] }, parameters: [], outputs: [], steps: [{ id: 'read', action: 'click', intent: 'read', target, risk: 'read' }], successCondition: { kind: 'textVisible', text: 'done' }, provenance: { discoveredAt: '', model: '', discoveryRunId: '', goal: '' } });
  const result = await runReplay(artifact, {}, { surface: run.surface, logger, policy, escalate: async () => 'retry' });
  expect(result.status).toBe('success'); expect(count).toBe(2);
  const events = readFileSync(join(logger.dir, 'log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(events.filter(e => e.event === 'action.start' && e.action === 'click').map(e => e.attempt)).toEqual([2, 3]);
  expect(events.filter(e => e.event === 'action.end' && e.action === 'click').map(e => e.status)).toEqual(['failure', 'success']);
});
