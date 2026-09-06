import { evaluateRun } from '../src/evidence/evaluate.js';
import { hintToDescriptor } from '../src/agent/tools.js';
import { extractText } from '../src/artifact/schema.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Journal } from '../src/runtime/journal.js';
import { applyMeridianContract, assertHoldEligibility, assertHoldFacts, assertHoldResult, assertMemberUpdateFacts, assertOpenShareFacts, assertOpenShareResult, assertTransferEligibility, assertTransferFacts, assertTransferOutputs, meridianContracts, meridianMemberContactTable, meridianTransferMemberTable } from '../src/runtime/contracts.js';
import { Approval, publicIntervention } from '../src/runtime/approval.js';
import { describePendingApproval, requestApproval, startApprovalServer } from '../src/escalation/approval-cli.js';
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
import { InsufficientFundsError } from '../src/replay/outcomes.js';
import { promoteToApproved } from '../src/artifact/promote.js';
import type { Surface } from '../src/surface/types.js';
import { createApp } from '../src/server/http.js';
import { InvocationService } from '../src/server/service.js';
import express from 'express';
import { chromium, type Page } from 'playwright';
import { request as httpRequest, createServer } from 'node:http';
import type { Duplex } from 'node:stream';

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'meridian-')); dirs.push(dir); return dir; };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const key = 'hmac-test-key-with-at-least-32-characters';
const profile = loadProfile('meridian');
const origin = 'https://web-sample.interface-hiring.com';
const requestOpenShare = () => ({ member: '9001', shareType: 'S0001', deposit: '5.00' });
const requestMemberUpdate = () => ({ member: '9001', email: 'member@example.test', phone: '5550001111', address: '1 Main Street' });
const requestHold = () => ({ member: '9001', share: '9001-S0001-1', reason: 'FRAUD', notes: 'fixture' });
const policy = Policy.parse({ allowedOrigins: [origin], allowedActions: ['navigate', 'click', 'fill', 'select', 'extract', 'assert'], riskHandling: { read: 'allow', reversible_write: 'allow', irreversible: 'allow' } });
const control: LiveControl = { url: `${origin}/members/1/hold/review`, destination: `${origin}/members/1/hold/post`, method: 'POST', control: 'Apply Hold', submit: true, operator: 'SUPER1', branch: 'MAIN-001', role: 'SUPERVISOR', conditions: [], facts: { share: '1-A', reason: 'FRAUD' }, tokenPresent: true, error: false,
  frame: { id: 'fixture-workarea', name: 'workarea', url: `${origin}/members/1/hold/review`, navigation: 1 } };
const target = { description: 'submit', strategies: [{ kind: 'nameAttr' as const, name: 'submit' }] };
function guarded(overrides: Partial<Surface> = {}, gate = async () => true, context = {}, onAction?: (event: string, data: Record<string, unknown>) => void, onDispatch?: (expected: LiveControl) => void | Promise<void>, onInspect?: () => void | Promise<void>, policyOverride = policy) {
  let live = structuredClone(control);
  const dispatch = vi.fn(async () => ({ strategyUsed: 0, kind: 'nameAttr', matches: 1 }));
  const surface: Surface = { start: async () => {}, navigate: async () => {}, observe: async () => ({ url: control.url, title: '', frames: [] }), currentUrl: () => control.url, frameUrls: () => [control.url], click: dispatch, fill: dispatch, select: dispatch, readText: async () => ({ text: 'ok', report: await dispatch() }), isTextVisible: async text => text === 'done', describeTarget: async t => t, screenshot: async () => {}, close: async () => {}, prepareClick: async () => ({ inspect: async () => { await onInspect?.(); return structuredClone(live); }, dispatch: async expected => { await onDispatch?.(expected); return dispatch(); } }), ...overrides };
  const session = new ControlSession();
  const beforeDispatch = vi.fn();
  return { surface: new GuardedSurface(surface, policyOverride, gate, undefined, { profile, session, deadline: Date.now() + 10000, runId: randomUUID(), artifact: 'hold', version: '1.0.0', operator: 'super1', role: 'SUPERVISOR', branch: 'MAIN-001', beforeDispatch, ...context }, onAction), dispatch, session, beforeDispatch, change: (c: Partial<LiveControl>) => { live = { ...live, ...c }; } };
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
    app: { appId: 'meridian', entryUrl: `${origin}/fixture?member={{member}}`, allowedOrigins: [origin] },
    parameters: meridianContracts['meridian-member-record'].parameters,
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
  it('rejects a down-labelled mismatched canonical operation before approval or intent', async () => {
    const gate = vi.fn(async () => true);
    const run = guarded({}, gate, { artifact: 'meridian-open-share' });
    await expect(run.surface.click(target, 100, 'read')).rejects.toThrow(/operation/i);
    expect(gate).not.toHaveBeenCalled();
    expect(run.beforeDispatch).not.toHaveBeenCalled();
    expect(run.dispatch).not.toHaveBeenCalled();
  });
  it.each([
    ['meridian-place-hold', '/members/9001/hold/review', '/members/9001/hold/post', 'Apply Hold'],
  ] as const)('fails closed when canonical %s has no request binding', async (artifact, url, destination, controlName) => {
    const gate = vi.fn(async () => true);
    const run = guarded({}, gate, { artifact });
    run.change({ url: `${origin}${url}`, destination: `${origin}${destination}`, control: controlName,
      frame: { ...control.frame!, url: `${origin}${url}` } });
    await expect(run.surface.click(target, 100, 'read')).rejects.toThrow(/hold/i);
    expect(gate).not.toHaveBeenCalled();
    expect(run.beforeDispatch).not.toHaveBeenCalled();
    expect(run.dispatch).not.toHaveBeenCalled();
  });
  it('rejects a strict hold mutation without source-frame origin evidence', async () => {
    const gate = vi.fn(async () => true);
    const run = guarded({}, gate, { artifact: 'meridian-place-hold' });
    run.change({ frame: undefined });
    await expect(run.surface.click(target, 100, 'read')).rejects.toThrow(/frame|origin/i);
    expect(gate).not.toHaveBeenCalled();
    expect(run.beforeDispatch).not.toHaveBeenCalled();
    expect(run.dispatch).not.toHaveBeenCalled();
    expect(run.surface.mutationDispatched).toBe(false);
  });
  it('fails closed when a canonical open-share post has no request binding', async () => {
    const gate = vi.fn(async () => true);
    const run = guarded({}, gate, { artifact: 'meridian-open-share' });
    run.change({ url: `${origin}/members/9001/open-share/review`, destination: `${origin}/members/9001/open-share/post`, control: 'Open Share' });
    await expect(run.surface.click(target, 100, 'read')).rejects.toThrow(/open-share/i);
    expect(gate).not.toHaveBeenCalled();
    expect(run.beforeDispatch).not.toHaveBeenCalled();
    expect(run.dispatch).not.toHaveBeenCalled();
  });
  it('fails closed when a canonical member update has no request binding', async () => {
    const gate = vi.fn(async () => true);
    const run = guarded({}, gate, { artifact: 'meridian-update-member' });
    run.change({ url: `${origin}/members/9001/update`, destination: `${origin}/members/9001/update`, control: 'Save Changes' });
    await expect(run.surface.click(target, 100, 'read')).rejects.toThrow(/member-update/i);
    expect(gate).not.toHaveBeenCalled();
    expect(run.beforeDispatch).not.toHaveBeenCalled();
    expect(run.dispatch).not.toHaveBeenCalled();
  });
  it('confines every bound write to its own operation before start, navigation, or control dispatch', async () => {
    const cases = [
      {
        artifact: 'meridian-funds-transfer',
        context: { transfer: { expected: { member: '9001', sourceShare: '9001-A', destinationShare: '9001-B', amount: '1.00', memo: 'fixture' }, memberTable: meridianTransferMemberTable } },
        entry: '/members/9001/hold',
        review: '/members/9001/hold/review',
      },
      {
        artifact: 'meridian-open-share',
        context: { openShare: { expected: requestOpenShare(), memberTable: meridianTransferMemberTable, contactTable: meridianMemberContactTable } },
        entry: '/members/9001/transfer',
        review: '/members/9001/transfer/review',
      },
      {
        artifact: 'meridian-update-member',
        context: { memberUpdate: { expected: requestMemberUpdate(), contactTable: meridianMemberContactTable } },
        entry: '/members/9001/hold',
        review: '/members/9001/hold/review',
      },
      {
        artifact: 'meridian-place-hold',
        context: { hold: { expected: requestHold(), memberTable: meridianTransferMemberTable, contactTable: meridianMemberContactTable } },
        entry: '/members/9001/transfer',
        review: '/members/9001/transfer/review',
      },
    ];
    for (const fixture of cases) {
      for (const action of ['start', 'navigate', 'click'] as const) {
        const start = vi.fn(async () => {});
        const navigate = vi.fn(async () => {});
        const observe = vi.fn(async () => ({ url: `${origin}/members`, title: '', frames: [] }));
        const run = guarded({ start, navigate, observe }, vi.fn(async () => true), {
          artifact: fixture.artifact,
          ...fixture.context,
        });
        const attempted = action === 'start'
          ? run.surface.start(`${origin}${fixture.entry}`)
          : action === 'navigate'
            ? run.surface.navigate(`${origin}${fixture.entry}`)
            : (run.change({
              url: `${origin}/members`, destination: `${origin}${fixture.review}`,
              method: 'POST', submit: true, facts: {},
            }), run.surface.click(target));
        await expect(attempted).rejects.toThrow(/operation|transfer/i);
        expect(start).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
        expect(observe).not.toHaveBeenCalled();
        expect(run.dispatch).not.toHaveBeenCalled();
        expect(run.beforeDispatch).not.toHaveBeenCalled();
      }
    }
  });
  it.each(['meridian-sign-on', 'meridian-member-inquiry', 'meridian-member-record'] as const)('rejects mutation dispatch for canonical read capability %s', async artifact => {
    const gate = vi.fn(async () => true);
    const run = guarded({}, gate, { artifact });
    await expect(run.surface.click(target, 100, 'read')).rejects.toThrow(/operation/i);
    expect(gate).not.toHaveBeenCalled();
    expect(run.beforeDispatch).not.toHaveBeenCalled();
    expect(run.dispatch).not.toHaveBeenCalled();
  });
  it('retains mutation compatibility for a legacy artifact ID', async () => {
    const gate = vi.fn(async () => true);
    const run = guarded({}, gate, { artifact: 'hold' });
    await run.surface.click(target, 100, 'read');
    expect(gate).toHaveBeenCalledOnce();
    expect(run.beforeDispatch).toHaveBeenCalledOnce();
    expect(run.dispatch).toHaveBeenCalledOnce();
  });
  it.each([
    ['meridian-sign-on', '/signon', '/signon', 'Sign On'],
    ['meridian-open-share', '/members/9001/open-share', '/members/9001/open-share/review', 'Continue'],
  ] as const)('permits nonmutation sign-on or review for %s', async (artifact, url, destination, controlName) => {
    const gate = vi.fn(async () => true);
    const run = guarded({}, gate, { artifact });
    run.change({ url: `${origin}${url}`, destination: `${origin}${destination}`, control: controlName });
    await run.surface.click(target, 100, 'read');
    expect(gate).not.toHaveBeenCalled();
    expect(run.beforeDispatch).not.toHaveBeenCalled();
    expect(run.dispatch).toHaveBeenCalledOnce();
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

it('binds one newly observed open share to the exact request and output', () => {
  const request = { member: '9001', shareType: 'S0001', deposit: '5.00' };
  const observed = { ...request, shareId: '9001-S0001-NEW' };
  expect(() => assertOpenShareResult(request, ['9001-S0001-OLD'], observed, { shareId: observed.shareId })).not.toThrow();
  for (const actual of [
    { ...observed, member: '9999' },
    { ...observed, shareType: 'S0070' },
    { ...observed, deposit: '5.01' },
    { ...observed, shareId: '' },
  ]) expect(() => assertOpenShareResult(request, ['9001-S0001-OLD'], actual, { shareId: observed.shareId })).toThrow();
  expect(() => assertOpenShareResult(request, [observed.shareId], observed, { shareId: observed.shareId })).toThrow();
  expect(() => assertOpenShareResult(request, ['OLD', 'OLD'], observed, { shareId: observed.shareId })).toThrow();
  expect(() => assertOpenShareResult(request, ['OLD'], observed, {})).toThrow();
  expect(() => assertOpenShareResult(request, ['OLD'], observed, { shareId: '' })).toThrow();
  expect(() => assertOpenShareResult(request, ['OLD'], observed, { shareId: 'stale' })).toThrow();
  expect(() => assertOpenShareFacts({ ...request, deposit: '0.00' }, request)).toThrow();
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
    parameters: meridianContracts['meridian-member-record'].parameters,
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
    parameters: meridianContracts['meridian-funds-transfer'].parameters,
    outputs,
    steps: [
      { id: 'operator', intent: 'operator', action: 'fill', value: '{{operator}}', risk: 'reversible_write' },
      { id: 'password', intent: 'password', action: 'fill', value: '{{password}}', risk: 'reversible_write' },
      { id: 'branch', intent: 'branch', action: 'select', value: '{{branch}}', risk: 'reversible_write' },
      ...meridianContracts['meridian-funds-transfer'].parameters.map(parameter => ({
        id: `input-${parameter.name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`,
        intent: parameter.description,
        action: 'fill' as const,
        target: { description: parameter.description, strategies: [{ kind: 'nameAttr' as const, name: parameter.name }] },
        value: `{{${parameter.name}}}`,
        risk: 'reversible_write' as const,
      })),
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

type ScalarWriteId = 'meridian-open-share' | 'meridian-update-member' | 'meridian-place-hold';
const scalarWriteOutput = {
  'meridian-open-share': 'shareId',
  'meridian-update-member': 'saved',
  'meridian-place-hold': 'heldShare',
} as const;

function scalarWriteArtifact(id: ScalarWriteId) {
  const output = scalarWriteOutput[id];
  return CapabilityArtifact.parse({
    schemaVersion: 2, id, name: id, description: id, version: '1.0.0', status: 'draft',
    app: { appId: 'meridian', entryUrl: `${origin}/signon`, allowedOrigins: [origin] },
    parameters: meridianContracts[id].parameters,
    outputs: [{ name: output, type: 'string', description: 'Result' }],
    steps: [
      { id: 'operator', intent: 'operator', action: 'fill', value: '{{operator}}', risk: 'reversible_write' },
      { id: 'password', intent: 'password', action: 'fill', value: '{{password}}', risk: 'reversible_write' },
      { id: 'branch', intent: 'branch', action: 'select', value: '{{branch}}', risk: 'reversible_write' },
      ...meridianContracts[id].parameters.map(parameter => ({
        id: `input-${parameter.name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`,
        intent: parameter.description, action: 'fill' as const, value: `{{${parameter.name}}}`, risk: 'reversible_write' as const,
      })),
      { id: 'post', intent: 'post', action: 'click', target, risk: 'irreversible' },
      { id: 'post-checkpoint', intent: 'verify', action: 'assert', assert: { kind: 'textVisible', text: 'Complete' }, risk: 'read' },
      { id: 'result', intent: 'result', action: 'extract', target, extract: { output }, risk: 'read' },
    ],
    successCondition: { kind: 'textVisible', text: 'Complete' }, detectors: [],
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

  it.each([
    ['missing', []],
    ['duplicate', [...meridianContracts['meridian-member-record'].parameters, meridianContracts['meridian-member-record'].parameters[0]!]],
    ['extra', [...meridianContracts['meridian-member-record'].parameters, { name: 'extra', type: 'string' as const, description: 'Extra', required: true, sensitive: false }]],
  ])('rejects %s public parameter declarations', (_kind, parameters) => {
    const artifact = memberRecordArtifact([shares]);
    artifact.parameters = parameters;
    expect(() => applyMeridianContract(artifact)).toThrow(/parameter/i);
  });

  it('rejects promotion when metadata is the only reference to a required public parameter', () => {
    const artifact = memberRecordArtifact([shares]);
    artifact.description = 'Read member {{member}}';
    artifact.successCondition = { kind: 'urlMatches', pattern: '/members/current$' };
    expect(() => promoteToApproved(JSON.stringify(artifact))).toThrow(/executable.*member/i);
  });

  const literalMemberRecord = () => CapabilityArtifact.parse(JSON.parse(
    readFileSync('artifacts/meridian-member-record.v1.0.0.json', 'utf8').replaceAll('{{member}}', '9001'),
  ));

  it('rejects an ignored table extraction pattern as the only public parameter reference', () => {
    const artifact = literalMemberRecord();
    const table = artifact.steps.find(step => step.action === 'extract' && step.extract?.columns);
    if (!table?.extract) throw new Error('Expected the genuine member-record table extraction');
    table.extract.pattern = '{{member}}';
    expect(() => applyMeridianContract(artifact)).toThrow(/executable.*member/i);
    expect(() => promoteToApproved(JSON.stringify(artifact))).toThrow(/executable.*member/i);
  });

  it('accepts a scalar extraction pattern as an executable public parameter reference', () => {
    const artifact = literalMemberRecord();
    const tableIndex = artifact.steps.findIndex(step => step.action === 'extract' && step.extract?.columns);
    const target = artifact.steps[tableIndex]!.target!;
    artifact.steps.splice(tableIndex, 0, {
      id: 'member-pattern', intent: 'Match the requested member', action: 'extract', target,
      extract: { output: 'shares', pattern: '^Member {{member}}$' }, risk: 'read', timeoutMs: 10_000,
    });
    expect(() => applyMeridianContract(artifact)).not.toThrow();
  });

  it.each(Object.keys(scalarWriteOutput) as ScalarWriteId[])('rejects table output/extraction shapes for %s', id => {
    const artifact = scalarWriteArtifact(id);
    artifact.outputs[0] = {
      name: scalarWriteOutput[id], type: 'table', description: 'Malformed result',
      columns: [{ name: 'value', selector: 'td', type: 'string' }],
    };
    artifact.steps.find(step => step.id === 'result')!.extract!.columns = [{ name: 'value', selector: 'td', type: 'string' }];
    expect(() => applyMeridianContract(artifact)).toThrow(/scalar string output/i);
  });

  it('rejects mixed scalar/table metadata and duplicate extraction during promotion', () => {
    const mixed = scalarWriteArtifact('meridian-open-share');
    mixed.outputs[0]!.columns = [{ name: 'value', selector: 'td', type: 'string' }];
    expect(() => promoteToApproved(JSON.stringify(mixed))).toThrow(/scalar string output/i);

    const duplicate = scalarWriteArtifact('meridian-update-member');
    duplicate.steps.push({ ...duplicate.steps.find(step => step.id === 'result')!, id: 'result-copy' });
    expect(() => promoteToApproved(JSON.stringify(duplicate))).toThrow(/scalar string output/i);
  });
});

it('rejects a malformed open-share table output in direct replay before browser start', async () => {
  const artifact = scalarWriteArtifact('meridian-open-share');
  artifact.status = 'approved';
  artifact.outputs[0] = {
    name: 'shareId', type: 'table', description: 'Malformed result',
    columns: [{ name: 'shareId', selector: 'td', type: 'string' }],
  };
  artifact.steps.find(step => step.id === 'result')!.extract!.columns = [{ name: 'shareId', selector: 'td', type: 'string' }];
  const run = guarded();
  const start = vi.spyOn(run.surface, 'start');
  const result = await runReplay(artifact, requestOpenShare(), {
    surface: run.surface, logger: new RunLogger('replay', new Redactor(), temp(), true), policy,
    validateCompletion: vi.fn(),
  });
  expect(result).toMatchObject({ status: 'failure', failure: { stepId: '(pre-flight)', intent: 'validate scalar write outputs' } });
  expect(start).not.toHaveBeenCalled();
  expect(run.beforeDispatch).not.toHaveBeenCalled();
  expect(run.dispatch).not.toHaveBeenCalled();
});

it('refuses an incomplete canonical transfer before allocating runtime evidence', () => {
  const evidenceDir = temp();
  expect(() => runtime.createRuntime({
    kind: 'discovery', artifact: 'meridian-funds-transfer', version: '1.0.0', policy, profile,
    params: { member: '9001' }, sensitive: [], gate: async () => false, evidenceDir,
  })).toThrow(/complete transfer request/i);
  expect(readdirSync(evidenceDir)).toEqual([]);
});

it('refuses an incomplete canonical open share before allocating runtime evidence', () => {
  const evidenceDir = temp();
  expect(() => runtime.createRuntime({
    kind: 'discovery', artifact: 'meridian-open-share', version: '1.0.0', policy, profile,
    params: { member: '9001', shareType: 'S0001' }, sensitive: [], gate: async () => false, evidenceDir,
  })).toThrow(/complete request/i);
  expect(readdirSync(evidenceDir)).toEqual([]);
});

it('refuses an incomplete canonical member update before allocating runtime evidence', () => {
  const evidenceDir = temp();
  expect(() => runtime.createRuntime({
    kind: 'discovery', artifact: 'meridian-update-member', version: '1.0.0', policy, profile,
    params: { member: '9001', email: 'member@example.test', phone: '5550001111' }, sensitive: [], gate: async () => false, evidenceDir,
  })).toThrow(/complete request/i);
  expect(readdirSync(evidenceDir)).toEqual([]);
});

it('refuses an incomplete canonical hold before allocating runtime evidence', () => {
  const evidenceDir = temp();
  expect(() => runtime.createRuntime({
    kind: 'discovery', artifact: 'meridian-place-hold', version: '1.0.0', policy, profile,
    params: { member: '9001', share: '9001-S0001-1', reason: 'FRAUD' }, sensitive: [], gate: async () => false, evidenceDir,
  })).toThrow(/complete request/i);
  expect(readdirSync(evidenceDir)).toEqual([]);
});

it('creates the canonical open-share runtime with a completion boundary', async () => {
  const candidate = runtime.createRuntime({
    kind: 'replay', artifact: 'meridian-open-share', version: '1.0.0', policy, profile,
    params: requestOpenShare(), sensitive: [], gate: async () => false, evidenceDir: temp(),
    operator: { operator: 'teller-test', password: 'secret', branch: 'MAIN-001', role: 'TELLER' },
    beforeDispatch: () => {},
  });
  expect(candidate.validateCompletion).toBeTypeOf('function');
  await candidate.close();
});

it('creates the canonical member-update runtime with a completion boundary', async () => {
  const candidate = runtime.createRuntime({
    kind: 'replay', artifact: 'meridian-update-member', version: '1.0.0', policy, profile,
    params: requestMemberUpdate(), sensitive: [], gate: async () => false, evidenceDir: temp(),
    operator: { operator: 'teller-test', password: 'secret', branch: 'MAIN-001', role: 'TELLER' },
    beforeDispatch: () => {},
  });
  expect(candidate.validateCompletion).toBeTypeOf('function');
  await candidate.close();
});

it('creates the canonical supervisor-hold runtime with a completion boundary', async () => {
  const candidate = runtime.createRuntime({
    kind: 'replay', artifact: 'meridian-place-hold', version: '1.0.0', policy, profile,
    params: requestHold(), sensitive: [], gate: async () => false, evidenceDir: temp(),
    operator: { operator: 'supervisor-test', password: 'secret', branch: 'MAIN-001', role: 'SUPERVISOR' },
    beforeDispatch: () => {},
  });
  expect(candidate.validateCompletion).toBeTypeOf('function');
  await candidate.close();
});

it('allows a cu-nexus runtime whose capability ID matches the canonical transfer', async () => {
  const candidate = runtime.createRuntime({
    kind: 'discovery', artifact: 'meridian-funds-transfer', version: '1.0.0', policy,
    profile: loadProfile('cu-nexus'), params: {}, sensitive: [], gate: async () => false,
  });
  expect(candidate.surface).toBeDefined();
  await candidate.close();
});

it.each(['meridian-open-share', 'meridian-update-member', 'meridian-place-hold'])('keeps generic discovery named %s free of strict completion binding', async artifact => {
  const candidate = runtime.createRuntime({
    kind: 'discovery', artifact, version: '1.0.0', policy,
    profile: loadProfile('cu-nexus'), params: {}, sensitive: [], gate: async () => false,
  });
  expect(candidate.validateCompletion).toBeUndefined();
  await candidate.close();

  const calls = [{ name: 'done', args: { summary: 'generic complete' } }];
  const stub = guarded();
  const client = { chat: { completions: { create: async () => {
    const call = calls.shift()!;
    return { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: randomUUID(), type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] };
  } } } } as unknown as Parameters<typeof runDiscovery>[4]['openai'];
  await expect(runDiscovery('generic', `${origin}/menu`, {}, [origin], {
    surface: stub.surface, logger: new RunLogger('discovery', new Redactor(), temp()), openai: client,
    model: 'fixture', maxSteps: 1, validateCompletion: candidate.validateCompletion,
  })).resolves.toMatchObject({ status: 'success' });
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

  it('classifies only valid underfunding as insufficient funds', () => {
    expect(() => assertTransferEligibility(request, '9001', [
      { ...rows[0]!, balance: '0.99' }, rows[1]!,
    ])).toThrow(InsufficientFundsError);
    for (const balance of ['not-money', '']) {
      expect(() => assertTransferEligibility(request, '9001', [
        { ...rows[0]!, balance }, rows[1]!,
      ])).toThrow('Transfer facts failed validation');
    }
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

it.each([false, true])('keeps funds outcome phase correct: intent=%s', async afterIntent => {
  const artifact = applyMeridianContract(transferArtifact());
  artifact.status = 'approved';
  artifact.steps = artifact.steps.filter(step => step.id === 'post');
  const params = { member: '9001', sourceShare: '9001-A', destinationShare: '9001-B',
    amount: '1.00', memo: 'fixture', operator: 'SUPER1', password: 'secret', branch: 'MAIN-001' };
  const report = { strategyUsed: 0, kind: 'nameAttr', matches: 1 } as const;
  const surface: Surface = {
    mutationDispatched: false,
    start: async () => {}, navigate: async () => {},
    currentUrl: () => `${origin}/members/9001`,
    frameUrls: () => [`${origin}/members/9001`],
    observe: async () => ({ url: `${origin}/members/9001`, title: '', frames: [] }),
    click: vi.fn(async () => {
      surface.mutationDispatched = afterIntent;
      throw new InsufficientFundsError();
    }),
    fill: async () => report, select: async () => report,
    readText: async () => ({ text: '', report }),
    isTextVisible: async () => false, describeTarget: async descriptor => descriptor,
    screenshot: async () => {}, close: async () => {},
  };
  const escalate = vi.fn(async () => 'abort' as const);
  const logger = new RunLogger('replay', new Redactor(), temp(), true);
  const replay = await runReplay(artifact, params, { surface, logger, policy, escalate });
  expect(replay).toMatchObject(afterIntent
    ? { status: 'failure', failure: { code: 'POST_OUTCOME_UNKNOWN' } }
    : { status: 'business_outcome', outcomeCode: 'INSUFFICIENT_FUNDS' });
  expect(JSON.parse(readFileSync(join(logger.dir, 'result.json'), 'utf8'))).toMatchObject(
    afterIntent ? { status: 'failure' } : { status: 'business_outcome', outcomeCode: 'INSUFFICIENT_FUNDS' });
  expect(surface.click).toHaveBeenCalledOnce();
  expect(escalate).not.toHaveBeenCalled();

  surface.mutationDispatched = false;
  vi.mocked(surface.click).mockClear();
  const create = vi.fn(async () => ({ choices: [{ message: {
    role: 'assistant', content: '', tool_calls: [{ id: 'funds-check', type: 'function',
      function: { name: 'click', arguments: JSON.stringify({ nameAttr: 'submit', reason: 'transfer', risk: 'irreversible' }) } }],
  } }] }));
  const openai = { chat: { completions: { create } } } as unknown as Parameters<typeof runDiscovery>[4]['openai'];
  const discovery = await runDiscovery('transfer', `${origin}/members/9001`, params, [origin], {
    surface, logger: new RunLogger('discovery', new Redactor(), temp(), true),
    openai, model: 'fixture', maxSteps: 3, escalate,
  });
  expect(discovery).toMatchObject(afterIntent
    ? { status: 'stopped', stopReason: 'POST_OUTCOME_UNKNOWN' }
    : { status: 'business_outcome', outcomeCode: 'INSUFFICIENT_FUNDS' });
  expect(create).toHaveBeenCalledOnce();
  expect(surface.click).toHaveBeenCalledOnce();
  expect(escalate).not.toHaveBeenCalled();
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

  it.each([
    { entry: 'start', failure: '' },
    { entry: 'navigate', failure: '' },
    { entry: 'start', failure: 'wrong-member' },
    { entry: 'navigate', failure: 'wrong-member' },
    { entry: 'navigate', failure: 'changed-frame' },
    { entry: 'navigate', failure: 'closed-share' },
    { entry: 'navigate', failure: 'duplicate-share' },
    { entry: 'navigate', failure: 'insufficient' },
    { entry: 'navigate', failure: 'stale-checkpoint' },
  ])('captures the real transfer member checkpoint after $entry (failure=$failure)', async ({ entry, failure }) => {
    let transferVisits = 0;
    let wrongMemberVisits = 0;
    let posts = 0;
    const rows = eligibleRows.map(row => ({ ...row }));
    if (failure === 'closed-share') rows[0]!.status = 'CLOSED';
    if (failure === 'insufficient') rows[0]!.balance = '0.99';
    if (failure === 'duplicate-share') rows.push({ ...rows[0]! });
    const shares = `<table><tr><th>Share</th><th>Type</th><th>Balance</th><th>Status</th></tr>${rows.map(row => `<tr><td>${row.shareId}</td><td>${row.type}</td><td>$${row.balance}</td><td>${row.status}</td></tr>`).join('')}</table>`;
    let member = `<p>OPR SUPER1 | BR MAIN-001 | SID fixture-session</p><table><tbody><tr></tr><tr></tr><tr><td><table><tr><td>Member No.:</td><td>9001</td></tr></table>${shares}<a href="/members/9001/transfer">Transfer</a></td></tr></tbody></table>`;
    const app = express();
    app.get('/members', (_req, res) => res.send('<a href="/members/9001">9001 - Fixture Member</a>'));
    app.get('/members/9001', (_req, res) => res.send(member));
    app.get('/members/9999', (_req, res) => { wrongMemberVisits++; res.send(member); });
    app.get('/members/9001/transfer', (_req, res) => { transferVisits++; res.send('<p>Transfer form</p>'); });
    app.post('*', (_req, res) => { posts++; res.send('unexpected post'); });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const localOrigin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const browser = new BrowserSurface({ allowedOrigins: [localOrigin], profile });
    const readTable = browser.readTable.bind(browser);
    const extracted = vi.spyOn(browser, 'readTable').mockImplementation(async (...args) => {
      const result = await readTable(...args);
      if (failure === 'changed-frame') await browser.page.reload();
      return result;
    });
    const beforeDispatch = vi.fn();
    const events: Array<{ event: string; attempt: unknown }> = [];
    const surface = new GuardedSurface(browser, Policy.parse({ ...policy, allowedOrigins: [localOrigin] }), async () => true, undefined, {
      profile, session: new ControlSession(), deadline: Date.now() + 10000,
      runId: randomUUID(), artifact: 'meridian-funds-transfer', version: '1.0.0',
      operator: 'super1', role: 'SUPERVISOR', branch: 'MAIN-001', beforeDispatch,
      transfer: { expected: request, memberTable: meridianTransferMemberTable },
    }, (event, data) => events.push({ event, attempt: data.attempt }));
    try {
      if (entry === 'navigate') await surface.start(`${localOrigin}/members`);
      const memberUrl = `${localOrigin}/members/${failure === 'wrong-member' ? '9999' : '9001'}`;
      const visit = entry === 'start' ? surface.start(memberUrl) : surface.navigate(memberUrl);
      if (failure === 'stale-checkpoint') {
        await visit;
        member = member.replace('<td>OPEN</td>', '<td>CLOSED</td>');
        await expect(surface.navigate(memberUrl)).rejects.toThrow(/transfer/i);
        await expect(surface.click({ description: 'Transfer', strategies: [{ kind: 'role', role: 'link', name: 'Transfer' }] })).rejects.toThrow(/frame|eligibility/i);
        expect(transferVisits).toBe(0);
      } else if (failure) {
        await expect(visit).rejects.toThrow(failure === 'insufficient' ? InsufficientFundsError : /member|bound|frame|transfer/i);
        await expect(surface.navigate(`${localOrigin}/members/9001/transfer`)).rejects.toThrow(/eligibility|frame/i);
        expect(transferVisits).toBe(0);
      } else {
        await visit;
        expect(extracted).toHaveBeenCalledOnce();
        await surface.navigate(memberUrl);
        expect(extracted).toHaveBeenCalledTimes(2);
        for (const suffix of ['', '/review', '/post']) {
          await expect(surface.navigate(`${localOrigin}/members/9001/transfer${suffix}`)).rejects.toThrow(/eligibility|route/i);
        }
        await surface.click({ description: 'Transfer', strategies: [{ kind: 'role', role: 'link', name: 'Transfer' }] });
        expect(transferVisits).toBe(1);
        expect(surface.currentUrl()).toBe(`${localOrigin}/members/9001/transfer`);
      }
      expect(wrongMemberVisits).toBe(0);
      expect(posts).toBe(0);
      expect(beforeDispatch).not.toHaveBeenCalled();
      expect(events.some(event => event.event === 'mutation.intent')).toBe(false);
      expect(events.filter(event => event.event === 'action.end').map(event => event.attempt))
        .toEqual(events.filter(event => event.event === 'action.start').map(event => event.attempt));
    } finally {
      await browser.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  function transferHarness(rows = eligibleRows, facts = validReviewFacts, onAction?: (event: string, data: Record<string, unknown>) => void, expected = request) {
    let currentRows: Array<Record<string, string>> = rows;
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
    const readOnlyPage = vi.fn(async (requestedUrl: string) => ({
      url: requestedUrl,
      frameUrls: [requestedUrl],
      identity: { operator: 'SUPER1', branch: 'MAIN-001', trusted: true },
      tables: [currentRows],
    }));
    let onInspect: (() => void | Promise<void>) | undefined;
    const run = guarded({
      currentUrl: () => url,
      currentFrame: frame,
      lastResolvedFrame: frame,
      frameUrls: () => [`${origin}/frameset`, url],
      readTable: async () => currentRows,
      readOnlyPage,
    }, gate, { artifact: 'meridian-funds-transfer', transfer: { expected, memberTable: meridianTransferMemberTable } }, onAction, async expectedControl => {
      if (expectedControl.destination === memberUrl) url = memberUrl;
      else if (expectedControl.destination === transferUrl) url = transferUrl;
      else if (expectedControl.destination === reviewUrl) url = reviewUrl;
      else if (expectedControl.destination === postUrl) url = postUrl;
      frameUrl = url;
      navigation++;
    }, async () => onInspect?.());
    return {
      run,
      gate,
      readOnlyPage,
      setLive(next: Partial<LiveControl>) { run.change({ ...next, frame: next.frame ?? frame() }); },
      setUrl(next: string) { url = next; frameUrl = next; navigation++; },
      setFrame(next: { id?: string; url?: string }) { if (next.id) frameId = next.id; if (next.url) frameUrl = next.url; },
      setInspect(next: () => void | Promise<void>) { onInspect = next; },
      setRows(next: Array<Record<string, string>>) { currentRows = next; },
      memberUrl,
      transferUrl,
      reviewUrl,
      postUrl,
      facts,
      frame,
    };
  }

  async function eligibleTransfer(rows = eligibleRows, facts = validReviewFacts, expected = request) {
    const harness = transferHarness(rows, facts, undefined, expected);
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

  it('stops underfunding before any approval or mutation intent', async () => {
    const harness = transferHarness([{ ...eligibleRows[0]!, balance: '0.99' }, ...eligibleRows.slice(1)]);
    await harness.run.surface.start(`${origin}/members`);
    harness.setUrl(harness.memberUrl);
    harness.setLive({ url: harness.memberUrl, destination: harness.memberUrl,
      method: 'GET', control: 'Select member', submit: false, facts: {} });
    await expect(harness.run.surface.click(target)).rejects.toThrow(InsufficientFundsError);
    expect(harness.gate).not.toHaveBeenCalled();
    expect(harness.run.beforeDispatch).not.toHaveBeenCalled();
    expect(harness.run.surface.mutationDispatched).toBe(false);
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

  it.each([
    ['closed source', [{ ...eligibleRows[0]!, status: 'CLOSED' }, eligibleRows[1]!, eligibleRows[2]!], Error],
    ['held destination', [eligibleRows[0]!, { ...eligibleRows[1]!, status: 'HOLD' }, eligibleRows[2]!], Error],
    ['newly insufficient source', [{ ...eligibleRows[0]!, balance: '0.50' }, eligibleRows[1]!, eligibleRows[2]!], InsufficientFundsError],
  ] as const)('rechecks %s changed during approval before transfer intent', async (_case, rows, expectedError) => {
    const harness = await eligibleTransfer();
    harness.gate.mockImplementationOnce(async () => {
      harness.setRows([...rows]);
      return true;
    });

    await expect(harness.run.surface.click(target, 1000, 'irreversible')).rejects.toThrow(
      expectedError === InsufficientFundsError ? InsufficientFundsError : /transfer/i,
    );
    expect(harness.readOnlyPage).toHaveBeenCalledOnce();
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
    expect(harness.readOnlyPage).toHaveBeenCalledOnce();
  });

  it('projects inspected hidden credentials through the guard, prompt, socket and API while preserving visible transfer facts', async () => {
    const app = express();
    app.get('/menu', (_req, res) => res.send(`<script>history.replaceState(null, "", "/members/9001/transfer/review")</script><p>OPR SUPER1 | BR MAIN-001 | SID session-private</p>
      <form method="post" action="/members/9001/transfer/post">
      <input type="hidden" name="_token" value="token-private"><input type="hidden" name="nonce" value="nonce-private"><input type="hidden" name="sid" value="sid-private"><input type="hidden" name="csrf" value="csrf-private">
      <input type="hidden" name="from" value="9001-A"><input type="hidden" name="to" value="9001-B"><input type="hidden" name="amount" value="1.00"><input type="hidden" name="memo" value="fixture">
      <input type="password" value="password-private"><input name="visible" value="visible-business">
      <table>${Object.entries(validReviewFacts).filter(([key]) => key.startsWith('review:')).map(([key, value]) => `<tr><td class="lbl">${key.slice(7)}</td><td>${value}</td></tr>`).join('')}</table>
      <input type="submit" value="Post Transfer"></form>`));
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const localOrigin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const secrets = new Redactor();
    const browser = new BrowserSurface({ allowedOrigins: [localOrigin], profile, sensitive: (_values, hidden = [], credentials = []) => {
      secrets.addSensitiveValues(hidden, true); secrets.addSensitiveValues(credentials);
    } });
    const originalDir = process.env.CU_APPROVAL_DIR;
    const approvalDir = mkdtempSync('/tmp/cu-ap-');
    process.env.CU_APPROVAL_DIR = approvalDir;
    try {
      await browser.start(`${localOrigin}/menu`);
      const prepared = await browser.prepareClick({ description: 'post', strategies: [{ kind: 'role', role: 'button', name: 'Post Transfer' }] });
      const inspected = await prepared.inspect();
      const raw = structuredClone(inspected.facts);
      const harness = await eligibleTransfer(eligibleRows, inspected.facts as typeof validReviewFacts);
      harness.setLive({ facts: inspected.facts, visibleFacts: inspected.visibleFacts });
      harness.gate.mockImplementation(async (...args: unknown[]) => {
        const context = args[3] as import('../src/runtime/approval.js').ActionContext;
        expect(context.facts).toEqual(raw);
        const approval = new Approval(new ControlSession(), () => {}, Date.now() + 10_000);
        const waiting = approval.wait({ kind: 'risk_approval', capability: 'transfer', goal: 'review', reason: 'nonce-private', url: `${localOrigin}/review?member=9001&sid=sid-private#csrf-private` }, context);
        const transport = await startApprovalServer(context.runId, approval, secrets);
        try {
          const prompt = describePendingApproval(approval.pending, secrets);
          const socket = await requestApproval(context.runId, { action: 'status' });
          const journal = new Journal(temp(), key);
          const record = journal.reserve('caller', 'projection-test', 'transfer', '1', {});
          const service = new InvocationService(journal, policy, profile, temp(), [], temp());
          service.live.set(record.runId, { state: 'awaiting-human', inputs: {}, started: Date.now(), approval, redactor: secrets });
          const api = service.get('operator', record.runId).intervention as ReturnType<typeof publicIntervention>;
          expect(service.get('caller', record.runId).intervention).toEqual({ kind: 'risk_approval', awaitingOperator: true });
          journal.close();
          expect(socket).toEqual({ ok: true, pending: prompt });
          expect(api.action).toEqual(prompt.action);
          expect(prompt.action!.facts).toMatchObject({ 'review:Member:': '9001 - Fixture Member', 'review:Amount:': '$1.00', visible: 'visible-business' });
          expect(prompt.action!.facts).not.toHaveProperty('amount');
          expect(JSON.stringify([prompt, socket, api])).not.toMatch(/nonce-private|sid-private|csrf-private|token-private|password-private|session-private|businessValues|visibleFacts/);
          expect(context.facts).toEqual(raw);
          expect(approval.pending!.action!.facts).toEqual(raw);
        } finally { approval.cancel(); await waiting; await transport.close(); }
        return false;
      });
      await expect(harness.run.surface.click(target, 1000, 'irreversible')).rejects.toThrow(/aborted/i);
      expect(harness.run.dispatch).not.toHaveBeenCalled();
      expect(harness.run.beforeDispatch).not.toHaveBeenCalled();
      expect(inspected.facts).toEqual(raw);
      expect(secrets.forVisibleValues(['session-private', 'password-private', 'nonce-private']).redactString('session-private password-private nonce-private')).not.toMatch(/session-private|password-private|nonce-private/);
    } finally {
      if (originalDir === undefined) delete process.env.CU_APPROVAL_DIR; else process.env.CU_APPROVAL_DIR = originalDir;
      rmSync(approvalDir, { recursive: true, force: true });
      await browser.close(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 15_000);

  it('compares rendered transfer memo after edge trimming while keeping native memo exact', async () => {
    const expected = { ...request, memo: ' fixture ' };
    const renderedFacts = { ...validReviewFacts, memo: expected.memo, 'review:Memo:': 'fixture' };
    const accepted = await eligibleTransfer(eligibleRows, renderedFacts, expected);
    await expect(accepted.run.surface.click(target, 1000, 'irreversible')).resolves.toBeDefined();
    expect(accepted.run.beforeDispatch).toHaveBeenCalledOnce();
    expect(accepted.run.dispatch).toHaveBeenCalledOnce();
    expect(() => assertTransferOutputs(expected, {
      confirmation: 'CONF-123',
      transaction: [{ ...expected, memo: 'fixture', confirmation: 'CONF-123' }],
    })).not.toThrow();

    const changedNative = await eligibleTransfer(eligibleRows, renderedFacts, expected);
    changedNative.setLive({ facts: { ...renderedFacts, memo: 'fixture' } });
    await expect(changedNative.run.surface.click(target)).rejects.toThrow(/transfer/i);
    expect(changedNative.gate).not.toHaveBeenCalled();
    expect(changedNative.run.beforeDispatch).not.toHaveBeenCalled();
    expect(changedNative.run.dispatch).not.toHaveBeenCalled();
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

    await expect(run.surface.click(target)).rejects.toThrow(/transfer|operation/i);
    expect(gate).not.toHaveBeenCalled();
    expect(run.beforeDispatch).not.toHaveBeenCalled();
    expect(run.surface.mutationDispatched).toBe(false);
    expect(run.dispatch).not.toHaveBeenCalled();
  });
});

describe('MERIDIAN guarded open-share path', () => {
  const request = { member: '9001', shareType: 'S0001', deposit: '5.00' };
  const hostedTypeLabels = {
    S0001: 'Regular Shares', S0070: 'Share Draft (Checking)', MMKT: 'Money Market', CERT: 'Certificate',
  } as const;
  const priorRows = [
    { shareId: '9001-S0001-OLD', type: 'Regular Shares', balance: '2.00', status: 'OPEN' },
    { shareId: '9001-S0070-OLD', type: 'Share Draft (Checking)', balance: '8.00', status: 'OPEN' },
  ];
  const reviewFacts = (expected = request) => ({
    member: expected.member, type: expected.shareType, deposit: expected.deposit,
    'review:Member:': `${expected.member} - Fixture Member`,
    'review:Share Type:': `${expected.shareType} - ${hostedTypeLabels[expected.shareType as keyof typeof hostedTypeLabels]}`,
    'review:Initial Deposit:': `$${expected.deposit}`,
  });
  const facts = reviewFacts();

  function harness(initialRows = priorRows, expected = request, allowedOrigins = [origin]) {
    let rows = initialRows;
    let completionRedirectOrigin: string | undefined;
    const operationOrigin = allowedOrigins[1] ?? allowedOrigins[0]!;
    let url = `${operationOrigin}/members`;
    let navigation = 0;
    let frameId = 'open-share-workarea';
    const frame = () => ({ id: frameId, name: 'workarea', url, navigation });
    const gate = vi.fn(async () => true);
    const resolveNavigation = (next: string) => completionRedirectOrigin ? new URL(new URL(next).pathname, completionRedirectOrigin).toString() : next;
    const start = vi.fn(async next => {
      url = resolveNavigation(next);
      navigation++;
    });
    const navigate = vi.fn(async next => {
      url = resolveNavigation(next);
      navigation++;
    });
    const run = guarded({
      start,
      currentUrl: () => url,
      currentFrame: frame,
      lastResolvedFrame: frame,
      frameUrls: () => [`${operationOrigin}/frameset`, url],
      navigate,
      readTable: async () => rows,
    }, gate, { artifact: 'meridian-open-share', openShare: { expected, memberTable: meridianTransferMemberTable, contactTable: meridianMemberContactTable } }, undefined,
    async expected => { url = expected.destination; navigation++; }, undefined, Policy.parse({ ...policy, allowedOrigins }));
    const setLive = (next: Partial<LiveControl>) => run.change({ ...next, frame: next.frame ?? frame() });
    const memberUrl = `${operationOrigin}/members/9001`;
    const openUrl = `${memberUrl}/open-share`;
    const reviewUrl = `${openUrl}/review`;
    const postUrl = `${openUrl}/post`;
    return {
      run, gate, start, navigate, startUrl: `${operationOrigin}/members`, memberUrl, openUrl, reviewUrl, postUrl,
      setRows(next: typeof priorRows) { rows = next; },
      setFrame(id: string) { frameId = id; },
      redirectCompletionTo(nextOrigin: string) { completionRedirectOrigin = nextOrigin; },
      setLive,
    };
  }

  async function reviewedOpenShare(expected = request, allowedOrigins = [origin]) {
    const h = harness(priorRows, expected, allowedOrigins);
    const expectedFacts = reviewFacts(expected);
    await h.run.surface.start(h.startUrl);
    h.setLive({ url: h.startUrl, destination: h.memberUrl, method: 'GET', control: '9001 - Fixture Member', submit: false, facts: {} });
    await h.run.surface.click(target);
    h.setLive({ url: h.memberUrl, destination: h.openUrl, method: 'GET', control: 'Open New Share', submit: false, facts: {} });
    await h.run.surface.click(target);
    h.setLive({ url: h.openUrl, destination: h.reviewUrl, method: 'POST', control: 'Continue', submit: true, facts: expectedFacts });
    await h.run.surface.click(target);
    h.setLive({ url: h.reviewUrl, destination: h.postUrl, method: 'POST', control: 'Open Share', submit: true, facts: expectedFacts });
    h.run.dispatch.mockClear();
    return h;
  }

  it.each([
    ['native member', 'member', '9999'],
    ['native type', 'type', 'S0070'],
    ['native deposit', 'deposit', '5.01'],
    ['visible member', 'review:Member:', '9999 - Fixture Member'],
    ['visible type', 'review:Share Type:', 'S0070 - Share Draft (Checking)'],
    ['visible type label for the requested code', 'review:Share Type:', 'S0001 - Certificate'],
    ['visible deposit', 'review:Initial Deposit:', '$5.01'],
  ] as const)('rejects changed %s before approval or mutation intent', async (_case, key, value) => {
    const h = await reviewedOpenShare();
    h.setLive({ facts: { ...facts, [key]: value } });
    await expect(h.run.surface.click(target)).rejects.toThrow(/open-share|review facts/i);
    expect(h.gate).not.toHaveBeenCalled();
    expect(h.run.beforeDispatch).not.toHaveBeenCalled();
    expect(h.run.dispatch).not.toHaveBeenCalled();
  });

  it.each(['start', 'navigate'] as const)('captures prior shares after direct %s at the requested member and completes the valid flow', async entry => {
    const h = harness();
    if (entry === 'start') await h.run.surface.start(h.memberUrl);
    else {
      await h.run.surface.start(h.startUrl);
      await h.run.surface.navigate(h.memberUrl);
    }
    h.setLive({ url: h.memberUrl, destination: h.openUrl, method: 'GET', control: 'Open New Share', submit: false, facts: {} });
    await h.run.surface.click(target);
    h.setLive({ url: h.openUrl, destination: h.reviewUrl, method: 'POST', control: 'Continue', submit: true, facts });
    await h.run.surface.click(target);
    h.setLive({ url: h.reviewUrl, destination: h.postUrl, method: 'POST', control: 'Open Share', submit: true, facts });
    await h.run.surface.click(target);
    h.setRows([...priorRows, { shareId: '9001-S0001-NEW', type: 'Regular Shares', balance: '5.00', status: 'OPEN' }]);
    await expect(h.run.surface.validateOpenShareCompletion({ shareId: '9001-S0001-NEW' })).resolves.toBeUndefined();
    expect(h.run.beforeDispatch).toHaveBeenCalledOnce();
    expect(h.run.surface.mutationDispatched).toBe(true);
  });

  it('refuses direct member navigation when the member or resolved origin is not the request', async () => {
    const wrongMember = harness();
    await wrongMember.run.surface.start(wrongMember.startUrl);
    await expect(wrongMember.run.surface.navigate(`${origin}/members/9999`)).rejects.toThrow(/member|bound/i);
    expect(wrongMember.navigate).not.toHaveBeenCalled();
    expect(wrongMember.run.beforeDispatch).not.toHaveBeenCalled();
    expect(wrongMember.run.surface.mutationDispatched).toBe(false);

    const otherOrigin = 'https://alternate-web-sample.interface-hiring.com';
    const wrongOrigin = harness(priorRows, request, [otherOrigin, origin]);
    await wrongOrigin.run.surface.start(wrongOrigin.startUrl);
    wrongOrigin.redirectCompletionTo(otherOrigin);
    await expect(wrongOrigin.run.surface.navigate(wrongOrigin.memberUrl)).rejects.toThrow(/frame/i);
    expect(wrongOrigin.run.beforeDispatch).not.toHaveBeenCalled();
    expect(wrongOrigin.run.surface.mutationDispatched).toBe(false);
  });

  it('rejects a wrong-member open-share link before native dispatch', async () => {
    const h = harness();
    await h.run.surface.start(h.startUrl);
    h.setLive({ url: h.startUrl, destination: `${origin}/members/9999`, method: 'GET', control: '9999 - Other Member', submit: false, facts: {} });
    await expect(h.run.surface.click(target)).rejects.toThrow(/member|bound/i);
    expect(h.run.dispatch).not.toHaveBeenCalled();
    expect(h.run.beforeDispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['another member', `${origin}/members/9999/open-share/review`, [origin], 'POST'],
    ['another allowed origin', 'https://alternate-web-sample.interface-hiring.com/members/9001/open-share/review', ['https://alternate-web-sample.interface-hiring.com', origin], 'POST'],
    ['another operation stage', `${origin}/members/9001/transfer/review`, [origin], 'POST'],
    ['the expected review with the wrong method', `${origin}/members/9001/open-share/review`, [origin], 'GET'],
  ] as const)('rejects an intermediate Continue to %s before approval, intent, or dispatch', async (_case, destination, allowedOrigins, method) => {
    const h = harness(priorRows, request, [...allowedOrigins]);
    await h.run.surface.start(h.startUrl);
    h.setLive({ url: h.startUrl, destination: h.memberUrl, method: 'GET', control: '9001 - Fixture Member', submit: false, facts: {} });
    await h.run.surface.click(target);
    h.setLive({ url: h.memberUrl, destination: h.openUrl, method: 'GET', control: 'Open New Share', submit: false, facts: {} });
    await h.run.surface.click(target);
    h.run.dispatch.mockClear();
    h.setLive({ url: h.openUrl, destination, method, control: 'Continue', submit: true, facts });

    await expect(h.run.surface.click(target)).rejects.toThrow(/transition|origin|operation|member|bound/i);
    expect(h.gate).not.toHaveBeenCalled();
    expect(h.run.beforeDispatch).not.toHaveBeenCalled();
    expect(h.run.dispatch).not.toHaveBeenCalled();
    expect(h.run.surface.mutationDispatched).toBe(false);
  });

  it('rechecks the member frame and review facts after approval', async () => {
    const h = await reviewedOpenShare();
    h.gate.mockImplementationOnce(async () => {
      h.setLive({ facts: { ...facts, deposit: '5.01' } });
      return true;
    });
    await expect(h.run.surface.click(target)).rejects.toThrow(/invalidated/i);
    expect(h.run.beforeDispatch).not.toHaveBeenCalled();
    expect(h.run.dispatch).not.toHaveBeenCalled();
  });

  it('rejects a wrong member destination and a replaced review frame', async () => {
    const wrongMember = await reviewedOpenShare();
    wrongMember.setLive({ destination: `${origin}/members/9999/open-share/post` });
    await expect(wrongMember.run.surface.click(target)).rejects.toThrow(/open-share|member|bound/i);
    expect(wrongMember.gate).not.toHaveBeenCalled();
    const wrongFrame = await reviewedOpenShare();
    wrongFrame.setFrame('replacement-frame');
    await expect(wrongFrame.run.surface.click(target)).rejects.toThrow(/frame/i);
    expect(wrongFrame.gate).not.toHaveBeenCalled();
  });

  it('rejects missing native or visible review facts', async () => {
    for (const key of ['deposit', 'review:Initial Deposit:']) {
      const h = await reviewedOpenShare();
      const missing = { ...facts } as Record<string, string>;
      delete missing[key];
      h.setLive({ facts: missing });
      await expect(h.run.surface.click(target)).rejects.toThrow(/facts/i);
      expect(h.gate).not.toHaveBeenCalled();
    }
  });

  it.each(Object.entries(hostedTypeLabels))('maps hosted %s member-table labels before exact completion comparison', async (shareType, label) => {
    const expected = { ...request, shareType };
    const h = await reviewedOpenShare(expected);
    await h.run.surface.click(target);
    expect(h.run.beforeDispatch).toHaveBeenCalledOnce();
    expect(h.run.dispatch).toHaveBeenCalledOnce();
    h.setRows([...priorRows, { shareId: `9001-${shareType}-NEW`, type: label, balance: '5.00', status: 'OPEN' }]);
    await expect(h.run.surface.validateOpenShareCompletion({ shareId: `9001-${shareType}-NEW` })).resolves.toBeUndefined();
  });

  it('reads open-share completion from the bound operation origin', async () => {
    const boundOrigin = 'https://alternate-web-sample.interface-hiring.com';
    const h = await reviewedOpenShare(request, [origin, boundOrigin]);
    await h.run.surface.click(target);
    h.setRows([...priorRows, { shareId: '9001-S0001-NEW', type: 'Regular Shares', balance: '5.00', status: 'OPEN' }]);
    await expect(h.run.surface.validateOpenShareCompletion({ shareId: '9001-S0001-NEW' })).resolves.toBeUndefined();
    expect(h.navigate).toHaveBeenCalledWith(h.memberUrl);
    expect(h.navigate).not.toHaveBeenCalledWith(`${origin}/members/9001`);
  });

  it('requires OPEN only for the new share and preserves unrelated prior statuses', async () => {
    const existing = [{ ...priorRows[0]!, status: 'HOLD' }, { ...priorRows[1]!, status: 'CLOSED' }];
    const h = harness(existing);
    await h.run.surface.start(h.startUrl);
    h.setLive({ url: h.startUrl, destination: h.memberUrl, method: 'GET', control: '9001 - Fixture Member', submit: false, facts: {} });
    await h.run.surface.click(target);
    h.setLive({ url: h.memberUrl, destination: h.openUrl, method: 'GET', control: 'Open New Share', submit: false, facts: {} });
    await h.run.surface.click(target);
    h.setLive({ url: h.openUrl, destination: h.reviewUrl, method: 'POST', control: 'Continue', submit: true, facts });
    await h.run.surface.click(target);
    h.setLive({ url: h.reviewUrl, destination: h.postUrl, method: 'POST', control: 'Open Share', submit: true, facts });
    await h.run.surface.click(target);
    h.setRows([...existing, { shareId: '9001-S0001-NEW', type: 'Regular Shares', balance: '5.00', status: 'OPEN' }]);
    await expect(h.run.surface.validateOpenShareCompletion({ shareId: '9001-S0001-NEW' })).resolves.toBeUndefined();
  });

  it('rejects a cross-origin native post before approval or mutation intent', async () => {
    const otherOrigin = 'https://alternate-web-sample.interface-hiring.com';
    const h = await reviewedOpenShare(request, [otherOrigin, origin]);
    h.setLive({ destination: `${otherOrigin}/members/9001/open-share/post` });
    await expect(h.run.surface.click(target)).rejects.toThrow(/origin/i);
    expect(h.gate).not.toHaveBeenCalled();
    expect(h.run.beforeDispatch).not.toHaveBeenCalled();
    expect(h.run.dispatch).not.toHaveBeenCalled();
    expect(h.run.surface.mutationDispatched).toBe(false);
  });

  it('rejects a cross-origin transition after capturing member pre-state', async () => {
    const otherOrigin = 'https://alternate-web-sample.interface-hiring.com';
    const h = harness(priorRows, request, [otherOrigin, origin]);
    await h.run.surface.start(h.startUrl);
    h.setLive({ url: h.startUrl, destination: h.memberUrl, method: 'GET', control: '9001 - Fixture Member', submit: false, facts: {} });
    await h.run.surface.click(target);
    h.run.dispatch.mockClear();
    h.setLive({
      url: h.memberUrl, destination: `${otherOrigin}/members/9001/open-share`, method: 'GET',
      control: 'Open New Share', submit: false, facts: {},
    });
    await expect(h.run.surface.click(target)).rejects.toThrow(/frame|origin/i);
    expect(h.gate).not.toHaveBeenCalled();
    expect(h.run.beforeDispatch).not.toHaveBeenCalled();
    expect(h.run.dispatch).not.toHaveBeenCalled();
    expect(h.run.surface.mutationDispatched).toBe(false);
  });

  it('rejects completion redirected to another allowed origin with the same member path', async () => {
    const otherOrigin = 'https://alternate-web-sample.interface-hiring.com';
    const h = await reviewedOpenShare(request, [otherOrigin, origin]);
    await h.run.surface.click(target);
    h.setRows([...priorRows, { shareId: '9001-S0001-NEW', type: 'Regular Shares', balance: '5.00', status: 'OPEN' }]);
    h.redirectCompletionTo(otherOrigin);
    await expect(h.run.surface.validateOpenShareCompletion({ shareId: '9001-S0001-NEW' })).rejects.toThrow(/frame|origin/i);
  });

  it.each([
    ['stale result', priorRows, '9001-S0001-OLD'],
    ['wrong type', [...priorRows, { shareId: '9001-NEW', type: 'Share Draft (Checking)', balance: '5.00', status: 'OPEN' }], '9001-NEW'],
    ['wrong balance', [...priorRows, { shareId: '9001-NEW', type: 'Regular Shares', balance: '6.00', status: 'OPEN' }], '9001-NEW'],
    ['wrong status', [...priorRows, { shareId: '9001-NEW', type: 'Regular Shares', balance: '5.00', status: 'HOLD' }], '9001-NEW'],
    ['unrecognized type', [...priorRows, { shareId: '9001-NEW', type: 'Unknown Shares', balance: '5.00', status: 'OPEN' }], '9001-NEW'],
    ['ambiguous additions', [...priorRows, { shareId: '9001-NEW-1', type: 'Regular Shares', balance: '5.00', status: 'OPEN' }, { shareId: '9001-NEW-2', type: 'Regular Shares', balance: '5.00', status: 'OPEN' }], '9001-NEW-1'],
    ['duplicate resulting ID', [...priorRows, { shareId: '9001-NEW', type: 'Regular Shares', balance: '5.00', status: 'OPEN' }, { shareId: '9001-NEW', type: 'Regular Shares', balance: '5.00', status: 'OPEN' }], '9001-NEW'],
    ['concurrent prior-row removal', [priorRows[0]!, { shareId: '9001-NEW', type: 'Regular Shares', balance: '5.00', status: 'OPEN' }], '9001-NEW'],
  ] as const)('rejects %s during fresh completion verification', async (_case, rows, output) => {
    const h = await reviewedOpenShare();
    await h.run.surface.click(target);
    h.setRows([...rows]);
    await expect(h.run.surface.validateOpenShareCompletion({ shareId: output })).rejects.toThrow(/open-share/i);
  });

  it('rejects duplicate prior IDs before entering the open-share form', async () => {
    const h = harness([priorRows[0]!, priorRows[0]!]);
    await h.run.surface.start(`${origin}/members`);
    h.setLive({ url: `${origin}/members`, destination: h.memberUrl, method: 'GET', control: '9001 - Fixture Member', submit: false, facts: {} });
    await expect(h.run.surface.click(target)).rejects.toThrow(/missing or ambiguous/i);
    expect(h.gate).not.toHaveBeenCalled();
    expect(h.run.beforeDispatch).not.toHaveBeenCalled();
  });

  it('does not let public recovery reverse the ordinary open-share stage', async () => {
    const h = harness();
    await h.run.surface.start(h.startUrl);
    h.setLive({ url: h.startUrl, destination: h.memberUrl, method: 'GET', control: '9001 - Fixture Member', submit: false, facts: {} });
    await h.run.surface.click(target);
    h.setLive({ url: h.memberUrl, destination: h.openUrl, method: 'GET', control: 'Open New Share', submit: false, facts: {} });
    await h.run.surface.click(target);
    h.run.dispatch.mockClear();
    h.setLive({ url: h.openUrl, destination: h.memberUrl, method: 'GET', control: 'Continue', submit: false, facts: {} });
    const maintenance = profile.detectors.find(detector => detector.id === 'maintenance')!;
    await expect(h.run.surface.recoverClick(maintenance.recovery!.target!)).rejects.toThrow(/transition/i);
    expect(h.run.dispatch).not.toHaveBeenCalled();
    expect(h.gate).not.toHaveBeenCalled();
    expect(h.run.beforeDispatch).not.toHaveBeenCalled();
  });
});

it.each([
  { checkpoint: 'visible', hidden: false, hiddenMember: false, visibleSubstring: false, displayedMember: '9001', fault: false, query: '', succeeds: true },
  { checkpoint: 'visible with configured maintenance fault', hidden: false, hiddenMember: false, visibleSubstring: false, displayedMember: '9001', fault: true, query: '', succeeds: true },
  { checkpoint: 'wrong-member', hidden: false, hiddenMember: false, visibleSubstring: false, displayedMember: '9999', fault: false, query: '', succeeds: false },
  { checkpoint: 'hidden member value', hidden: false, hiddenMember: true, visibleSubstring: false, displayedMember: '9001', fault: false, query: '', succeeds: false },
  { checkpoint: 'hidden', hidden: true, hiddenMember: false, visibleSubstring: false, displayedMember: '9001', fault: false, query: '', succeeds: false },
  { checkpoint: 'hidden with visible substring decoy', hidden: true, hiddenMember: false, visibleSubstring: true, displayedMember: '9001', fault: false, query: '', succeeds: false },
  { checkpoint: 'visible with arbitrary query', hidden: false, hiddenMember: false, visibleSubstring: false, displayedMember: '9001', fault: false, query: '?inject=maintenance', succeeds: false },
])('$checkpoint member checkpoint bounds the observed open-share maintenance path', async ({ hidden, hiddenMember, visibleSubstring, displayedMember, fault, query, succeeds }) => {
  let openVisits = 0;
  let memberVisits = 0;
  let faultRedirected = false;
  const app = express();
  const shares = '<table><tr><th>Share</th><th>Type</th><th>Balance</th><th>Status</th></tr><tr><td>9001-S0001</td><td>Regular Shares</td><td>$2.00</td><td>OPEN</td></tr></table>';
  const contact = `<table><tbody><tr><td${hidden ? ' style="display:none"' : ''}>Member No.:</td><td${hiddenMember ? ' style="display:none"' : ''}>${displayedMember}</td><td>Name:</td><td>Fixture</td></tr><tr><td>E-mail:</td><td>fixture@example.test</td><td>Phone:</td><td>5550001111</td></tr><tr><td>Address:</td><td>1 Main Street</td></tr></tbody></table>`;
  const member = `<table><tbody><tr></tr><tr></tr><tr><td>${contact}${shares}<a href="/members/9001/open-share${query}">Open New Share</a></td></tr></tbody></table>${visibleSubstring ? '<p>Previous Member No.: unavailable</p>' : ''}`;
  app.get('/members', (_req, res) => res.send('<a href="/members/9001">9001 - Fixture Member</a>'));
  app.get('/members/9001', (_req, res) => { memberVisits++; res.send(member); });
  app.get('/members/9001/open-share', (req, res) => {
    if (req.query.inject === 'maintenance' && !faultRedirected) {
      faultRedirected = true;
      return res.redirect(req.originalUrl);
    }
    openVisits++;
    res.send(openVisits === 1
      ? '<p>SCHEDULED MAINTENANCE IN PROGRESS</p><a href="/members/9001">Continue</a>'
      : '<form method="post" action="/members/9001/open-share/review"><input type="submit" value="Continue"></form>');
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const localOrigin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const localProfile = { ...profile, entryUrl: `${localOrigin}/members` };
  const localPolicy = Policy.parse({ ...policy, allowedOrigins: [localOrigin] });
  const configuredFault = fault ? { kind: 'maintenance' as const, path: '/members/9001/open-share' } : undefined;
  const browser = new BrowserSurface({ allowedOrigins: [localOrigin], profile: localProfile, fault: configuredFault });
  const gate = vi.fn(async () => true);
  const beforeDispatch = vi.fn();
  const events: string[] = [];
  const surface = new GuardedSurface(browser, localPolicy, gate, undefined, {
    profile: localProfile, session: new ControlSession(), deadline: Date.now() + 10000,
    runId: randomUUID(), artifact: 'meridian-open-share', version: '1.0.0',
    operator: 'super1', role: 'SUPERVISOR', branch: 'MAIN-001', beforeDispatch,
    fault: configuredFault,
    openShare: { expected: requestOpenShare(), memberTable: meridianTransferMemberTable, contactTable: meridianMemberContactTable },
  }, event => events.push(event));
  try {
    await surface.start(`${localOrigin}/members`);
    await surface.click({ description: 'member', strategies: [{ kind: 'role', role: 'link', name: '9001 - Fixture Member' }] });
    await surface.click({ description: 'open', strategies: [{ kind: 'role', role: 'link', name: 'Open New Share' }] });
    const interrupted = surface.currentFrame()!;
    expect(await surface.isTextVisible('SCHEDULED MAINTENANCE IN PROGRESS')).toBe(true);
    if (!succeeds) {
      await expect(surface.recoverOperation('maintenance', 5000)).rejects.toThrow(/frame/i);
      expect(surface.currentUrl()).toBe(query ? `${localOrigin}/members/9001/open-share${query}` : `${localOrigin}/members/9001`);
      if (visibleSubstring) expect(await surface.isTextVisible('Member No.:', surface.currentFrame()!.name)).toBe(true);
      expect(openVisits).toBe(1);
      expect(memberVisits).toBe(query ? 1 : 2);
      expect(gate).not.toHaveBeenCalled();
      expect(beforeDispatch).not.toHaveBeenCalled();
      expect(events).not.toContain('mutation.intent');
      return;
    }
    await surface.recoverOperation('maintenance', 5000);
    const restored = surface.currentFrame()!;
    expect(surface.currentUrl()).toBe(`${localOrigin}/members/9001/open-share`);
    expect(restored).toMatchObject({ id: interrupted.id, name: interrupted.name });
    expect(restored.navigation).toBeGreaterThan(interrupted.navigation);
    expect(await surface.isTextVisible('SCHEDULED MAINTENANCE IN PROGRESS')).toBe(false);
    await expect(surface.recoverOperation('maintenance', 5000)).rejects.toThrow(/already attempted/i);
    expect(openVisits).toBe(2);
    expect(memberVisits).toBe(2);
    expect(gate).not.toHaveBeenCalled();
    expect(beforeDispatch).not.toHaveBeenCalled();
    expect(events).not.toContain('mutation.intent');
  } finally {
    await surface.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 15000);

it('refuses open-share operation recovery without a trusted bound interruption', async () => {
  const run = guarded({}, async () => true, {
    artifact: 'meridian-open-share',
    openShare: { expected: requestOpenShare(), memberTable: meridianTransferMemberTable, contactTable: meridianMemberContactTable },
  });
  await expect(run.surface.recoverOperation('maintenance')).rejects.toThrow(/trusted|bound/i);
  expect(run.dispatch).not.toHaveBeenCalled();
  expect(run.beforeDispatch).not.toHaveBeenCalled();
  expect(run.surface.mutationDispatched).toBe(false);
});


describe('MERIDIAN guarded member-update path', () => {
  const request = requestMemberUpdate();
  const contactRow = (overrides: Record<string, string> = {}) => ({
    memberLabel: 'Member No.:', member: request.member, nameLabel: 'Name:', name: 'Fixture Member',
    emailLabel: 'E-mail:', email: request.email, phoneLabel: 'Phone:', phone: request.phone,
    addressLabel: 'Address:', address: request.address, ...overrides,
  });

  function harness(gate = vi.fn(async () => true), initialRows: Array<Record<string, string>> = [contactRow()], operationOrigin = origin, completionRedirectOrigin?: string, expected = request) {
    let rows = initialRows;
    let url = `${operationOrigin}/members/9001/update`;
    let navigation = 0;
    let frameId = 'update-workarea';
    let changeFrameDuringRead = false;
    const navigate = vi.fn(async (next: string) => { url = completionRedirectOrigin ? new URL(new URL(next).pathname, completionRedirectOrigin).toString() : next; navigation++; });
    const frame = () => ({ id: frameId, name: 'workarea', url, navigation });
    const run = guarded({
      currentUrl: () => url,
      currentFrame: frame,
      lastResolvedFrame: frame,
      frameUrls: () => [`${operationOrigin}/frameset`, url],
      navigate,
      readTable: async () => { if (changeFrameDuringRead) frameId = 'replacement-workarea'; return rows; },
    }, gate, { artifact: 'meridian-update-member', memberUpdate: { expected, contactTable: meridianMemberContactTable } }, undefined,
    async expected => { url = expected.destination; navigation++; }, undefined,
    Policy.parse({ ...policy, allowedOrigins: operationOrigin === origin ? [origin] : ['https://policy-first.example', operationOrigin, ...(completionRedirectOrigin ? [completionRedirectOrigin] : [])] }));
    const setLive = (next: Partial<LiveControl> = {}) => run.change({
      url: `${operationOrigin}/members/9001/update`, destination: `${operationOrigin}/members/9001/update`, method: 'POST',
      control: 'Save Changes', submit: true, facts: { ...expected }, frame: frame(), ...next,
    });
    setLive();
    return {
      run, gate, navigate, setLive, currentUrl: () => url,
      setUrl(next: string) { url = next; navigation++; },
      setRows(next: Array<Record<string, string>>) { rows = next; },
      replaceFrame() { frameId = 'replacement-workarea'; },
      replaceFrameDuringRead() { changeFrameDuringRead = true; },
    };
  }

  it('compares member update facts exactly without contact normalization', () => {
    expect(() => assertMemberUpdateFacts(request, { ...request })).not.toThrow();
    for (const [field, value] of [['member', '09001'], ['email', 'MEMBER@example.test'], ['phone', '(555) 000-1111'], ['address', '1 Main St.']] as const) {
      expect(() => assertMemberUpdateFacts(request, { ...request, [field]: value })).toThrow(/member-update/i);
    }
  });

  it('enters the update form through the normal member-record link before saving', async () => {
    const h = harness();
    const memberUrl = `${origin}/members/9001`;
    const updateUrl = `${memberUrl}/update`;
    h.setUrl(memberUrl);
    h.setLive({ url: memberUrl, destination: updateUrl, method: 'GET', control: 'Update Member', submit: false, facts: {} });
    await h.run.surface.click(target);
    expect(h.gate).not.toHaveBeenCalled();
    expect(h.run.beforeDispatch).not.toHaveBeenCalled();
    expect(h.run.surface.mutationDispatched).toBe(false);
    expect(h.currentUrl()).toBe(updateUrl);

    h.setLive();
    await h.run.surface.click(target);
    expect(h.gate).toHaveBeenCalledOnce();
    expect(h.run.beforeDispatch).toHaveBeenCalledOnce();
    expect(h.run.dispatch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['link', false],
    ['GET form', true],
  ] as const)('rejects a wrong-member update GET before native navigation or %s dispatch', async (_kind, submit) => {
    const direct = harness();
    await expect(direct.run.surface.navigate(`${origin}/members/9999/update`)).rejects.toThrow(/member|bound/i);
    expect(direct.navigate).not.toHaveBeenCalled();
    expect(direct.run.dispatch).not.toHaveBeenCalled();

    const link = harness();
    link.setUrl(`${origin}/members/9001`);
    link.setLive({ url: `${origin}/members/9001`, destination: `${origin}/members/9999/update`, method: 'GET', control: 'Update Member', submit, facts: {} });
    await expect(link.run.surface.click(target)).rejects.toThrow(/member|bound/i);
    expect(link.run.dispatch).not.toHaveBeenCalled();
    expect(link.gate).not.toHaveBeenCalled();
  });

  it.each([
    ['member', '9999'], ['email', 'other@example.test'], ['phone', '5550002222'], ['address', '2 Main Street'],
  ] as const)('rejects a changed native %s before approval or intent', async (field, value) => {
    const h = harness();
    h.setLive({ facts: { ...request, [field]: value } });
    await expect(h.run.surface.click(target)).rejects.toThrow(/member-update/i);
    expect(h.gate).not.toHaveBeenCalled();
    expect(h.run.beforeDispatch).not.toHaveBeenCalled();
    expect(h.run.dispatch).not.toHaveBeenCalled();
  });

  it('rejects missing facts, a wrong route member or origin, and a replaced form frame', async () => {
    const missing = harness();
    const facts = { ...request } as Record<string, string>;
    delete facts.phone;
    missing.setLive({ facts });
    await expect(missing.run.surface.click(target)).rejects.toThrow(/facts/i);
    expect(missing.gate).not.toHaveBeenCalled();

    const wrongMember = harness();
    wrongMember.setLive({ destination: `${origin}/members/9999/update` });
    await expect(wrongMember.run.surface.click(target)).rejects.toThrow(/member-update|member selection|bound/i);
    expect(wrongMember.gate).not.toHaveBeenCalled();

    const wrongOrigin = harness();
    wrongOrigin.setLive({ destination: `https://other.example/members/9001/update` });
    await expect(wrongOrigin.run.surface.click(target)).rejects.toThrow();
    expect(wrongOrigin.gate).not.toHaveBeenCalled();

    const wrongFrame = harness();
    wrongFrame.replaceFrame();
    await expect(wrongFrame.run.surface.click(target)).rejects.toThrow(/frame/i);
    expect(wrongFrame.gate).not.toHaveBeenCalled();
  });

  it('rechecks exact form facts after approval and aborts without dispatch', async () => {
    let h: ReturnType<typeof harness>;
    const gate = vi.fn(async () => { h.setLive({ facts: { ...request, email: 'changed@example.test' } }); return true; });
    h = harness(gate);
    await expect(h.run.surface.click(target)).rejects.toThrow(/invalidated/i);
    expect(h.run.beforeDispatch).not.toHaveBeenCalled();
    expect(h.run.dispatch).not.toHaveBeenCalled();

    const aborted = harness(vi.fn(async () => false));
    await expect(aborted.run.surface.click(target)).rejects.toThrow(/aborted/i);
    expect(aborted.run.beforeDispatch).not.toHaveBeenCalled();
    expect(aborted.run.dispatch).not.toHaveBeenCalled();
  });

  it('dispatches once and accepts one fresh exactly labeled contact row', async () => {
    const h = harness();
    await h.run.surface.click(target);
    expect(h.run.beforeDispatch).toHaveBeenCalledOnce();
    expect(h.run.dispatch).toHaveBeenCalledOnce();
    await expect(h.run.surface.validateMemberUpdateCompletion({ saved: 'Member saved' })).resolves.toBeUndefined();
  });

  it('compares rendered contact values after edge trimming while keeping native fields exact', async () => {
    const expected = {
      ...request,
      email: ' member@example.test ',
      phone: ' 5550001111 ',
      address: ' 1 Main Street ',
    };
    const accepted = harness(vi.fn(async () => true), [contactRow()], origin, undefined, expected);
    await accepted.run.surface.click(target);
    await expect(accepted.run.surface.validateMemberUpdateCompletion({ saved: 'Member saved' })).resolves.toBeUndefined();

    const changedNative = harness(vi.fn(async () => true), [contactRow()], origin, undefined, expected);
    changedNative.setLive({ facts: { ...expected, address: '1 Main Street' } });
    await expect(changedNative.run.surface.click(target)).rejects.toThrow(/member-update/i);
    expect(changedNative.gate).not.toHaveBeenCalled();
    expect(changedNative.run.beforeDispatch).not.toHaveBeenCalled();
    expect(changedNative.run.dispatch).not.toHaveBeenCalled();
  });

  it('uses the validated update origin for read-back when policy has multiple origins', async () => {
    const operationOrigin = 'https://member-system.example';
    const h = harness(vi.fn(async () => true), [contactRow()], operationOrigin);
    await h.run.surface.click(target);
    await h.run.surface.validateMemberUpdateCompletion({ saved: 'Member saved' });
    expect(h.currentUrl()).toBe(`${operationOrigin}/members/9001`);
  });

  it('rejects same-path completion read-back redirected to another allowed origin', async () => {
    const operationOrigin = 'https://member-system.example';
    const redirectOrigin = 'https://member-redirect.example';
    const h = harness(vi.fn(async () => true), [contactRow()], operationOrigin, redirectOrigin);
    await h.run.surface.click(target);
    await expect(h.run.surface.validateMemberUpdateCompletion({ saved: 'Member saved' })).rejects.toThrow(/member-update/i);
    expect(h.run.surface.mutationDispatched).toBe(true);
  });

  it.each([
    ['stale email', [contactRow({ email: 'old@example.test' })]],
    ['other member', [contactRow({ member: '9999' })]],
    ['wrong label', [contactRow({ emailLabel: 'Email:' })]],
    ['missing value', [Object.fromEntries(Object.entries(contactRow()).filter(([key]) => key !== 'phone'))]],
    ['missing row', []],
    ['ambiguous rows', [contactRow(), contactRow()]],
  ] as const)('rejects %s during fresh completion verification', async (_case, rows) => {
    const h = harness();
    await h.run.surface.click(target);
    h.setRows([...rows]);
    await expect(h.run.surface.validateMemberUpdateCompletion({ saved: 'Member saved' })).rejects.toThrow(/member-update/i);
  });

  it('requires a dispatched request, a real saved output, and a stable read-back frame', async () => {
    const undispatched = harness();
    await expect(undispatched.run.surface.validateMemberUpdateCompletion({ saved: 'Member saved' })).rejects.toThrow(/dispatched/i);

    const missingOutput = harness();
    await missingOutput.run.surface.click(target);
    await expect(missingOutput.run.surface.validateMemberUpdateCompletion({ saved: '' })).rejects.toThrow(/saved output/i);

    const changedFrame = harness();
    await changedFrame.run.surface.click(target);
    changedFrame.replaceFrameDuringRead();
    await expect(changedFrame.run.surface.validateMemberUpdateCompletion({ saved: 'Member saved' })).rejects.toThrow(/frame/i);
  });
});

describe('MERIDIAN guarded supervisor-hold path', () => {
  const request = requestHold();
  const contactRow = (overrides: Record<string, string> = {}) => ({
    memberLabel: 'Member No.:', member: request.member, nameLabel: 'Name:', name: 'Fixture Member',
    emailLabel: 'E-mail:', email: 'member@example.test', phoneLabel: 'Phone:', phone: '5550001111',
    addressLabel: 'Address:', address: '1 Main Street', ...overrides,
  });
  const eligibleRows = [
    { shareId: request.share, type: 'Regular Shares', balance: '8.00', status: 'OPEN' },
    { shareId: '9001-S0070-1', type: 'Share Draft (Checking)', balance: '2.00', status: 'OPEN' },
  ];
  const nativeFacts = (expected = request) => ({ member: expected.member, share: expected.share, reason: expected.reason, notes: expected.notes });
  const reviewFacts = (expected = request) => ({
    ...nativeFacts(expected),
    'review:Member:': `${expected.member} - Fixture Member`,
    'review:Share:': `${expected.share} - Regular Shares`,
    'review:Reason:': expected.reason,
    'review:Notes:': expected.notes,
  });

  function harness(options: {
    shares?: Array<Record<string, string>>;
    contacts?: Array<Record<string, string>>;
    expected?: typeof request;
    role?: 'TELLER' | 'SUPERVISOR';
    gate?: () => Promise<boolean>;
    allowedOrigins?: string[];
    redirectCompletion?: boolean;
    afterEligibilityRead?: (description: string) => void;
    freshUrl?: string;
    freshFrameUrls?: string[];
    freshIdentity?: { operator: string; branch: string; trusted: boolean };
    freshError?: Error;
    readOnlyUnavailable?: boolean;
  } = {}) {
    let shares = options.shares ?? eligibleRows;
    let contacts = options.contacts ?? [contactRow()];
    const expected = options.expected ?? request;
    const allowedOrigins = options.allowedOrigins ?? [origin];
    const operationOrigin = allowedOrigins.at(-1)!;
    let url = `${operationOrigin}/members`;
    let navigation = 0;
    let frameId = 'hold-workarea';
    let replaceFrameDuringRead = false;
    let redirectNextNavigationOrigin: string | undefined;
    const frame = () => ({ id: frameId, name: 'workarea', url, navigation });
    const gate = options.gate ?? vi.fn(async () => true);
    const start = vi.fn(async next => {
      url = redirectNextNavigationOrigin ? new URL(new URL(next).pathname, redirectNextNavigationOrigin).toString() : next;
      redirectNextNavigationOrigin = undefined;
      navigation++;
    });
    const navigate = vi.fn(async next => {
      url = redirectNextNavigationOrigin
        ? new URL(new URL(next).pathname, redirectNextNavigationOrigin).toString()
        : options.redirectCompletion ? `${allowedOrigins[0]}/members/${expected.member}` : next;
      redirectNextNavigationOrigin = undefined;
      navigation++;
    });
    const eligibilityTimeouts: Array<number | undefined> = [];
    const readOnlyPage = vi.fn(async (requestedUrl: string) => {
      if (options.freshError) throw options.freshError;
      return {
        url: options.freshUrl ?? requestedUrl,
        frameUrls: options.freshFrameUrls ?? [requestedUrl],
        identity: options.freshIdentity ?? { operator: 'SUPER1', branch: 'MAIN-001', trusted: true },
        tables: [contacts, shares],
      };
    });
    const run = guarded({
      start,
      currentUrl: () => url,
      currentFrame: frame,
      lastResolvedFrame: frame,
      frameUrls: () => [`${operationOrigin}/frameset`, url],
      navigate,
      readTable: async (descriptor, _columns, timeoutMs) => {
        if (replaceFrameDuringRead) frameId = 'replacement-workarea';
        eligibilityTimeouts.push(timeoutMs);
        options.afterEligibilityRead?.(descriptor.description);
        return descriptor.description.includes('contact') ? contacts : shares;
      },
      readOnlyPage: options.readOnlyUnavailable ? undefined : readOnlyPage,
    }, gate, {
      artifact: 'meridian-place-hold', role: options.role ?? 'SUPERVISOR',
      hold: { expected, memberTable: meridianTransferMemberTable, contactTable: meridianMemberContactTable },
    }, undefined, async expectedControl => { url = expectedControl.destination; navigation++; }, undefined,
    Policy.parse({ ...policy, allowedOrigins }));
    const memberUrl = `${operationOrigin}/members/${expected.member}`;
    const holdUrl = `${memberUrl}/hold`;
    const reviewUrl = `${holdUrl}/review`;
    const postUrl = `${holdUrl}/post`;
    const setLive = (next: Partial<LiveControl>) => run.change({ ...next, frame: next.frame ?? frame() });
    return {
      run, gate, start, navigate, startUrl: `${operationOrigin}/members`, memberUrl, holdUrl, reviewUrl, postUrl,
      currentUrl: () => url,
      eligibilityTimeouts,
      readOnlyPage,
      setLive,
      setShares(next: Array<Record<string, string>>) { shares = next; },
      setContacts(next: Array<Record<string, string>>) { contacts = next; },
      replaceFrame() { frameId = 'replacement-workarea'; },
      replaceFrameDuringRead() { replaceFrameDuringRead = true; },
      redirectNextNavigationTo(nextOrigin: string) { redirectNextNavigationOrigin = nextOrigin; },
    };
  }

  async function reviewedHold(options: Parameters<typeof harness>[0] = {}) {
    const h = harness(options);
    const expected = options.expected ?? request;
    await h.run.surface.start(h.startUrl);
    h.setLive({ url: h.startUrl, destination: h.memberUrl, method: 'GET', control: `${expected.member} - Fixture Member`, submit: false, facts: {} });
    await h.run.surface.click(target);
    h.setLive({ url: h.memberUrl, destination: h.holdUrl, method: 'GET', control: 'Place Hold', submit: false, facts: {} });
    await h.run.surface.click(target);
    h.setLive({ url: h.holdUrl, destination: h.reviewUrl, method: 'POST', control: 'Continue', submit: true, facts: nativeFacts(expected) });
    await h.run.surface.click(target);
    h.setLive({ url: h.reviewUrl, destination: h.postUrl, method: 'POST', control: 'Apply Hold', submit: true, facts: reviewFacts(expected) });
    h.run.dispatch.mockClear();
    return h;
  }

  it('requires exact supervisor facts, one eligible OPEN share, and one exact HOLD result', () => {
    expect(() => assertHoldFacts(request, { ...request }, 'SUPERVISOR')).not.toThrow();
    expect(() => assertHoldFacts(request, { ...request }, 'TELLER')).toThrow(/hold/i);
    for (const field of ['member', 'share', 'reason', 'notes'] as const) {
      expect(() => assertHoldFacts(request, { ...request, [field]: 'different' }, 'SUPERVISOR')).toThrow(/hold/i);
    }
    expect(() => assertHoldEligibility(request, request.member, eligibleRows.map(row => ({ share: row.shareId, type: row.type, status: row.status })))).not.toThrow();
    expect(() => assertHoldEligibility(request, '9999', eligibleRows.map(row => ({ share: row.shareId, type: row.type, status: row.status })))).toThrow(/hold/i);
    expect(() => assertHoldResult(request, { member: request.member, share: request.share, status: 'HOLD' }, { heldShare: request.share })).not.toThrow();
    expect(() => assertHoldResult(request, { member: request.member, share: '9001-S0001-2', status: 'HOLD' }, { heldShare: request.share })).toThrow(/hold/i);
    expect(() => assertHoldResult(request, { member: request.member, share: request.share, status: 'HOLD' }, {})).toThrow(/hold/i);
  });

  it.each([
    ['already held', [{ ...eligibleRows[0]!, status: 'HOLD' }, eligibleRows[1]!]],
    ['closed', [{ ...eligibleRows[0]!, status: 'CLOSED' }, eligibleRows[1]!]],
    ['missing', [eligibleRows[1]!]],
    ['duplicate', [eligibleRows[0]!, eligibleRows[0]!, eligibleRows[1]!]],
  ] as const)('rejects a selected share that is %s before entering the hold form', async (_case, shares) => {
    const h = harness({ shares: [...shares] });
    await h.run.surface.start(h.startUrl);
    h.setLive({ url: h.startUrl, destination: h.memberUrl, method: 'GET', control: 'Select', submit: false, facts: {} });
    await expect(h.run.surface.click(target)).rejects.toThrow(/hold/i);
    expect(h.run.beforeDispatch).not.toHaveBeenCalled();
    expect(h.run.surface.mutationDispatched).toBe(false);
  });

  it.each([
    ['wrong member', [contactRow({ member: '9999' })]],
    ['wrong member label', [contactRow({ memberLabel: 'Member:' })]],
    ['missing name', [contactRow({ name: '' })]],
    ['missing member row', []],
    ['ambiguous member rows', [contactRow(), contactRow()]],
  ] as const)('rejects %s before entering the hold form', async (_case, contacts) => {
    const h = harness({ contacts: [...contacts] });
    await h.run.surface.start(h.startUrl);
    h.setLive({ url: h.startUrl, destination: h.memberUrl, method: 'GET', control: 'Select', submit: false, facts: {} });
    await expect(h.run.surface.click(target)).rejects.toThrow(/hold/i);
    expect(h.run.beforeDispatch).not.toHaveBeenCalled();
    expect(h.run.surface.mutationDispatched).toBe(false);
  });

  it('shares one timeout budget across sequential hold eligibility reads', async () => {
    let now = 1_000;
    const h = harness({ afterEligibilityRead: description => {
      if (description.includes('contact')) now += 400;
    } });
    await h.run.surface.start(h.startUrl);
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    h.setLive({ url: h.startUrl, destination: h.memberUrl, method: 'GET', control: 'Select', submit: false, facts: {} });

    await h.run.surface.click(target, 1_000);
    expect(h.eligibilityTimeouts).toEqual([1_000, 600]);
  });

  it('runs the normal member to hold to review flow and dispatches one approved final POST', async () => {
    const h = await reviewedHold();
    await h.run.surface.click(target);
    expect(h.gate).toHaveBeenCalledOnce();
    expect(h.run.beforeDispatch).toHaveBeenCalledOnce();
    expect(h.run.dispatch).toHaveBeenCalledOnce();
    expect(h.run.surface.mutationDispatched).toBe(true);
    expect(h.readOnlyPage).toHaveBeenCalledOnce();
  });

  it.each(['HOLD', 'CLOSED'] as const)('rejects a selected share changed to %s during approval with zero intent', async status => {
    let h!: ReturnType<typeof harness>;
    h = await reviewedHold({ gate: vi.fn(async () => {
      h.setShares([{ ...eligibleRows[0]!, status }, eligibleRows[1]!]);
      return true;
    }) });

    await expect(h.run.surface.click(target)).rejects.toThrow(/hold/i);
    expect(h.readOnlyPage).toHaveBeenCalledOnce();
    expect(h.run.beforeDispatch).not.toHaveBeenCalled();
    expect(h.run.dispatch).not.toHaveBeenCalled();
    expect(h.run.surface.mutationDispatched).toBe(false);
  });

  it.each([
    ['changed type', [{ ...eligibleRows[0]!, type: 'Share Draft (Checking)' }, eligibleRows[1]!], undefined],
    ['ambiguous share', [eligibleRows[0]!, eligibleRows[0]!, eligibleRows[1]!], undefined],
    ['missing share', [eligibleRows[1]!], undefined],
    ['redirected member read', eligibleRows, `${origin}/members/9999`],
  ] as const)('rejects a fresh hold eligibility read with %s before intent', async (_case, shares, freshUrl) => {
    let h!: ReturnType<typeof harness>;
    h = await reviewedHold({ freshUrl, gate: vi.fn(async () => {
      h.setShares([...shares]);
      return true;
    }) });

    await expect(h.run.surface.click(target)).rejects.toThrow(/hold/i);
    expect(h.run.beforeDispatch).not.toHaveBeenCalled();
    expect(h.run.dispatch).not.toHaveBeenCalled();
  });

  it('fails closed when the fresh hold eligibility primitive is missing or times out', async () => {
    const missing = await reviewedHold({ readOnlyUnavailable: true });
    await expect(missing.run.surface.click(target)).rejects.toThrow(/UI read is unavailable/i);
    expect(missing.run.beforeDispatch).not.toHaveBeenCalled();

    const timedOut = await reviewedHold({ freshError: new Error('Action timeout expired') });
    await expect(timedOut.run.surface.click(target)).rejects.toThrow(/timeout/i);
    expect(timedOut.run.beforeDispatch).not.toHaveBeenCalled();
    expect(timedOut.run.dispatch).not.toHaveBeenCalled();
  });

  it('rejects changed fresh member identity and an untrusted session before intent', async () => {
    let changed!: ReturnType<typeof harness>;
    changed = await reviewedHold({ gate: vi.fn(async () => {
      changed.setContacts([contactRow({ name: 'Changed Member' })]);
      return true;
    }) });
    await expect(changed.run.surface.click(target)).rejects.toThrow(/hold/i);
    expect(changed.run.beforeDispatch).not.toHaveBeenCalled();

    const untrusted = await reviewedHold({ freshIdentity: { operator: 'SUPER1', branch: 'MAIN-001', trusted: false } });
    await expect(untrusted.run.surface.click(target)).rejects.toThrow(/hold/i);
    expect(untrusted.run.beforeDispatch).not.toHaveBeenCalled();
    expect(untrusted.run.dispatch).not.toHaveBeenCalled();
  });

  it.each(['start', 'navigate'] as const)('captures hold eligibility after direct member %s and completes the valid flow', async entry => {
    const h = harness();
    if (entry === 'start') await h.run.surface.start(h.memberUrl);
    else {
      await h.run.surface.start(h.startUrl);
      await h.run.surface.navigate(h.memberUrl);
    }
    h.setLive({ url: h.memberUrl, destination: h.holdUrl, method: 'GET', control: 'Place Hold', submit: false, facts: {} });
    await h.run.surface.click(target);
    h.setLive({ url: h.holdUrl, destination: h.reviewUrl, method: 'POST', control: 'Continue', submit: true, facts: nativeFacts() });
    await h.run.surface.click(target);
    h.setLive({ url: h.reviewUrl, destination: h.postUrl, method: 'POST', control: 'Apply Hold', submit: true, facts: reviewFacts() });
    await h.run.surface.click(target);
    h.setShares([{ ...eligibleRows[0]!, status: 'HOLD' }, eligibleRows[1]!]);
    await expect(h.run.surface.validateHoldCompletion({ heldShare: request.share })).resolves.toBeUndefined();
    expect(h.gate).toHaveBeenCalledOnce();
    expect(h.run.beforeDispatch).toHaveBeenCalledOnce();
    expect(h.run.surface.mutationDispatched).toBe(true);
  });

  it('refuses direct hold member navigation for a wrong member or resolved origin with zero approval or intent', async () => {
    const wrongStart = harness();
    await expect(wrongStart.run.surface.start(`${origin}/members/9999`)).rejects.toThrow(/member|bound/i);
    expect(wrongStart.start).not.toHaveBeenCalled();
    expect(wrongStart.gate).not.toHaveBeenCalled();
    expect(wrongStart.run.beforeDispatch).not.toHaveBeenCalled();

    const wrongMember = harness();
    await wrongMember.run.surface.start(wrongMember.startUrl);
    await expect(wrongMember.run.surface.navigate(`${origin}/members/9999`)).rejects.toThrow(/member|bound/i);
    expect(wrongMember.navigate).not.toHaveBeenCalled();
    expect(wrongMember.gate).not.toHaveBeenCalled();
    expect(wrongMember.run.beforeDispatch).not.toHaveBeenCalled();
    expect(wrongMember.run.surface.mutationDispatched).toBe(false);

    const otherOrigin = 'https://member-system.example';
    const wrongOrigin = harness({ allowedOrigins: [otherOrigin, origin] });
    await wrongOrigin.run.surface.start(wrongOrigin.startUrl);
    wrongOrigin.redirectNextNavigationTo(otherOrigin);
    await expect(wrongOrigin.run.surface.navigate(wrongOrigin.memberUrl)).rejects.toThrow(/frame|origin/i);
    expect(wrongOrigin.gate).not.toHaveBeenCalled();
    expect(wrongOrigin.run.beforeDispatch).not.toHaveBeenCalled();
    expect(wrongOrigin.run.surface.mutationDispatched).toBe(false);
  });

  it.each([
    ['link', false],
    ['GET form', true],
  ] as const)('rejects a wrong-member hold %s before native dispatch or observation', async (_kind, submit) => {
    const h = harness();
    await h.run.surface.start(h.startUrl);
    h.setLive({ url: h.startUrl, destination: `${origin}/members/9999`, method: 'GET', control: '9999 - Other Member', submit, facts: {} });
    await expect(h.run.surface.click(target)).rejects.toThrow(/member|bound/i);
    expect(h.run.dispatch).not.toHaveBeenCalled();
    expect(h.run.beforeDispatch).not.toHaveBeenCalled();
    expect(h.eligibilityTimeouts).toEqual([]);
  });

  it('rejects a cross-operation Continue before approval, intent, or dispatch', async () => {
    const h = harness();
    await h.run.surface.start(h.startUrl);
    h.setLive({ url: h.startUrl, destination: h.memberUrl, method: 'GET', control: 'Select', submit: false, facts: {} });
    await h.run.surface.click(target);
    h.setLive({ url: h.memberUrl, destination: h.holdUrl, method: 'GET', control: 'Place Hold', submit: false, facts: {} });
    await h.run.surface.click(target);
    h.run.dispatch.mockClear();
    h.setLive({
      url: h.holdUrl,
      destination: `${origin}/members/9001/transfer/review`,
      method: 'POST',
      control: 'Continue',
      submit: true,
      facts: { member: '9001', from: '9001-A', to: '9001-B', amount: '1.00', memo: 'unrelated' },
    });

    await expect(h.run.surface.click(target)).rejects.toThrow(/transition|operation|member|bound/i);
    expect(h.gate).not.toHaveBeenCalled();
    expect(h.run.beforeDispatch).not.toHaveBeenCalled();
    expect(h.run.dispatch).not.toHaveBeenCalled();
    expect(h.run.surface.mutationDispatched).toBe(false);
  });

  it.each([
    ['native member', 'member', '9999'],
    ['native share', 'share', '9001-S0070-1'],
    ['native reason', 'reason', 'LEGAL'],
    ['native notes', 'notes', 'changed'],
    ['visible member', 'review:Member:', '9001 - Another Member'],
    ['visible share', 'review:Share:', '9001-S0001-1 - Share Draft (Checking)'],
    ['visible reason', 'review:Reason:', 'Suspected fraud'],
    ['visible notes', 'review:Notes:', 'changed'],
  ] as const)('rejects changed %s before approval and mutation intent', async (_case, key, value) => {
    const h = await reviewedHold();
    h.setLive({ facts: { ...reviewFacts(), [key]: value } });
    await expect(h.run.surface.click(target)).rejects.toThrow(/hold/i);
    expect(h.gate).not.toHaveBeenCalled();
    expect(h.run.beforeDispatch).not.toHaveBeenCalled();
    expect(h.run.dispatch).not.toHaveBeenCalled();
  });

  it('compares rendered hold notes after edge trimming while keeping native notes exact', async () => {
    const expected = { ...request, notes: ' review ' };
    const accepted = await reviewedHold({ expected });
    accepted.setLive({ facts: { ...reviewFacts(expected), 'review:Notes:': 'review' } });
    await expect(accepted.run.surface.click(target)).resolves.toBeDefined();
    expect(accepted.run.beforeDispatch).toHaveBeenCalledOnce();
    expect(accepted.run.dispatch).toHaveBeenCalledOnce();

    const changedNative = await reviewedHold({ expected });
    changedNative.setLive({ facts: { ...reviewFacts(expected), notes: 'review', 'review:Notes:': 'review' } });
    await expect(changedNative.run.surface.click(target)).rejects.toThrow(/hold/i);
    expect(changedNative.gate).not.toHaveBeenCalled();
    expect(changedNative.run.beforeDispatch).not.toHaveBeenCalled();
    expect(changedNative.run.dispatch).not.toHaveBeenCalled();
  });

  it('rejects teller authority on the supported flow before final intent', async () => {
    const h = harness({ role: 'TELLER' });
    await h.run.surface.start(h.startUrl);
    h.setLive({ url: h.startUrl, destination: h.memberUrl, method: 'GET', control: 'Select', submit: false, facts: {} });
    await h.run.surface.click(target);
    h.setLive({ url: h.memberUrl, destination: h.holdUrl, method: 'GET', control: 'Place Hold', submit: false, facts: {} });
    await h.run.surface.click(target);
    h.setLive({ url: h.holdUrl, destination: h.reviewUrl, method: 'POST', control: 'Continue', submit: true, facts: nativeFacts() });
    await expect(h.run.surface.click(target)).rejects.toThrow(/hold/i);
    expect(h.gate).not.toHaveBeenCalled();
    expect(h.run.beforeDispatch).not.toHaveBeenCalled();
    expect(h.run.surface.mutationDispatched).toBe(false);
  });

  it('rejects wrong member, origin, frame, missing facts, abort, and changed approval state with zero intent', async () => {
    const wrongMember = await reviewedHold();
    wrongMember.setLive({ destination: `${origin}/members/9999/hold/post` });
    await expect(wrongMember.run.surface.click(target)).rejects.toThrow(/hold|member|bound/i);
    expect(wrongMember.run.beforeDispatch).not.toHaveBeenCalled();

    const wrongOrigin = await reviewedHold();
    wrongOrigin.setLive({ destination: 'https://other.example/members/9001/hold/post' });
    await expect(wrongOrigin.run.surface.click(target)).rejects.toThrow(/hold|origin|allow/i);
    expect(wrongOrigin.run.beforeDispatch).not.toHaveBeenCalled();

    const unrelated = await reviewedHold();
    unrelated.setLive({ destination: `${origin}/members/9001/update`, control: 'Save Changes' });
    await expect(unrelated.run.surface.click(target)).rejects.toThrow(/transition|operation|member|bound/i);
    expect(unrelated.gate).not.toHaveBeenCalled();
    expect(unrelated.run.beforeDispatch).not.toHaveBeenCalled();

    const wrongFrame = await reviewedHold();
    wrongFrame.replaceFrame();
    await expect(wrongFrame.run.surface.click(target)).rejects.toThrow(/frame/i);
    expect(wrongFrame.run.beforeDispatch).not.toHaveBeenCalled();

    const missing = await reviewedHold();
    const missingFacts = { ...reviewFacts() } as Record<string, string>;
    delete missingFacts['review:Reason:'];
    missing.setLive({ facts: missingFacts });
    await expect(missing.run.surface.click(target)).rejects.toThrow(/facts/i);
    expect(missing.run.beforeDispatch).not.toHaveBeenCalled();

    const aborted = await reviewedHold({ gate: vi.fn(async () => false) });
    await expect(aborted.run.surface.click(target)).rejects.toThrow(/aborted/i);
    expect(aborted.run.beforeDispatch).not.toHaveBeenCalled();
    expect(aborted.run.dispatch).not.toHaveBeenCalled();

    let changed: Awaited<ReturnType<typeof reviewedHold>>;
    const changingGate = vi.fn(async () => { changed.setLive({ facts: { ...reviewFacts(), notes: 'changed' } }); return true; });
    changed = await reviewedHold({ gate: changingGate });
    await expect(changed.run.surface.click(target)).rejects.toThrow(/invalidated/i);
    expect(changed.run.beforeDispatch).not.toHaveBeenCalled();
    expect(changed.run.dispatch).not.toHaveBeenCalled();

    let changedRole: Awaited<ReturnType<typeof reviewedHold>>;
    const roleChangingGate = vi.fn(async () => { changedRole.setLive({ role: 'TELLER' }); return true; });
    changedRole = await reviewedHold({ gate: roleChangingGate });
    await expect(changedRole.run.surface.click(target)).rejects.toThrow(/invalidated/i);
    expect(changedRole.run.beforeDispatch).not.toHaveBeenCalled();
    expect(changedRole.run.dispatch).not.toHaveBeenCalled();
  });

  it('accepts one fresh exact HOLD row from the bound operation origin', async () => {
    const boundOrigin = 'https://member-system.example';
    const h = await reviewedHold({ allowedOrigins: [origin, boundOrigin] });
    await h.run.surface.click(target);
    h.setShares([{ ...eligibleRows[0]!, status: 'HOLD' }, eligibleRows[1]!]);
    await expect(h.run.surface.validateHoldCompletion({ heldShare: request.share })).resolves.toBeUndefined();
    expect(h.navigate).toHaveBeenCalledWith(h.memberUrl);
    expect(h.currentUrl()).toBe(h.memberUrl);
  });

  it.each([
    ['stale status', [{ ...eligibleRows[0]!, status: 'OPEN' }, eligibleRows[1]!], [contactRow()], request.share],
    ['wrong selected share', [{ ...eligibleRows[1]!, status: 'HOLD' }], [contactRow()], request.share],
    ['duplicate selected share', [{ ...eligibleRows[0]!, status: 'HOLD' }, { ...eligibleRows[0]!, status: 'HOLD' }], [contactRow()], request.share],
    ['wrong member', [{ ...eligibleRows[0]!, status: 'HOLD' }], [contactRow({ member: '9999' })], request.share],
    ['missing member', [{ ...eligibleRows[0]!, status: 'HOLD' }], [], request.share],
    ['ambiguous member', [{ ...eligibleRows[0]!, status: 'HOLD' }], [contactRow(), contactRow()], request.share],
    ['wrong output', [{ ...eligibleRows[0]!, status: 'HOLD' }], [contactRow()], '9001-S0070-1'],
  ] as const)('rejects %s during fresh completion verification', async (_case, shares, contacts, heldShare) => {
    const h = await reviewedHold();
    await h.run.surface.click(target);
    h.setShares([...shares]);
    h.setContacts([...contacts]);
    await expect(h.run.surface.validateHoldCompletion({ heldShare })).rejects.toThrow(/hold/i);
  });

  it('requires dispatch, a stable frame, and the exact bound origin for completion', async () => {
    const undispatched = await reviewedHold();
    await expect(undispatched.run.surface.validateHoldCompletion({ heldShare: request.share })).rejects.toThrow(/dispatched/i);

    const changedFrame = await reviewedHold();
    await changedFrame.run.surface.click(target);
    changedFrame.setShares([{ ...eligibleRows[0]!, status: 'HOLD' }]);
    changedFrame.replaceFrameDuringRead();
    await expect(changedFrame.run.surface.validateHoldCompletion({ heldShare: request.share })).rejects.toThrow(/frame/i);

    const redirected = await reviewedHold({ allowedOrigins: [origin, 'https://member-system.example'], redirectCompletion: true });
    await redirected.run.surface.click(target);
    redirected.setShares([{ ...eligibleRows[0]!, status: 'HOLD' }]);
    await expect(redirected.run.surface.validateHoldCompletion({ heldShare: request.share })).rejects.toThrow(/origin|frame/i);
  });
});

it('awaits delayed discovery completion rejection and keeps the dispatched outcome unknown', async () => {
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
    validateCompletion: async () => { await Promise.resolve(); throw new Error('stale member state'); },
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

it.each([
  { capability: 'meridian-open-share', action: 'open share', params: requestOpenShare(), receiptPath: 'open-share/post', checkpoint: { kind: 'textVisible', text: 'Share opened' }, outputName: 'shareId', outputValue: '9001-S0001-NEW', sensitive: ['member', 'deposit'] },
  { capability: 'meridian-update-member', action: 'save member', params: requestMemberUpdate(), receiptPath: 'update', checkpoint: { kind: 'textVisible', text: 'Member saved' }, outputName: 'saved', outputValue: 'Member saved', sensitive: ['member', 'email', 'phone', 'address'] },
  { capability: 'meridian-place-hold', action: 'place hold', params: requestHold(), receiptPath: 'hold/post', checkpoint: { kind: 'urlMatches', pattern: '/members/9001/hold/post$' }, outputName: 'heldShare', outputValue: '9001-S0001-1', sensitive: ['member', 'share', 'notes'] },
] as const)('records the $capability endpoint before completion read-back and replays the generated checkpoint', async fixture => {
  const receiptUrl = `${origin}/members/9001/${fixture.receiptPath}`;
  const memberUrl = `${origin}/members/9001`;
  const params = fixture.params;
  const report = { strategyUsed: 0, kind: 'nameAttr', matches: 1 } as const;
  const calls = [
    { name: 'click', args: { nameAttr: 'submit', reason: fixture.action, risk: 'irreversible' } },
    { name: 'assert', args: { ...fixture.checkpoint, reason: 'verify result endpoint' } },
    { name: 'extract', args: { nameAttr: fixture.outputName, outputName: fixture.outputName, reason: 'read result' } },
    { name: 'done', args: { summary: 'complete' } },
  ];
  let discoveryUrl = `${origin}/signon`;
  const discoverySurface: Surface = {
    mutationDispatched: false,
    start: async url => { discoveryUrl = url; },
    observe: async () => ({ url: discoveryUrl, title: '', frames: [] }), currentUrl: () => discoveryUrl, frameUrls: () => [discoveryUrl],
    navigate: async url => { discoveryUrl = url; },
    click: vi.fn(async () => { discoverySurface.mutationDispatched = true; discoveryUrl = receiptUrl; return report; }),
    fill: async () => report, select: async () => report,
    readText: async () => ({ text: fixture.outputValue, report }), isTextVisible: async text => fixture.checkpoint.kind === 'textVisible' && text === fixture.checkpoint.text && discoveryUrl === receiptUrl,
    describeTarget: async descriptor => descriptor, screenshot: async () => {}, close: async () => {},
  };
  const create = vi.fn(async () => {
    const call = calls.shift()!;
    return { choices: [{ message: { role: 'assistant', content: '', tool_calls: [{ id: randomUUID(), type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] } }] };
  });
  const discoveryCompletion = vi.fn(async () => { await discoverySurface.navigate(memberUrl); });
  const discovery = await runDiscovery(fixture.action, `${origin}/signon`, params, [origin], {
    surface: discoverySurface, logger: new RunLogger('discovery', new Redactor(), temp(), true),
    openai: { chat: { completions: { create } } } as unknown as Parameters<typeof runDiscovery>[4]['openai'],
    model: 'fixture', maxSteps: 4, validateCompletion: discoveryCompletion,
  });
  expect(discovery).toMatchObject({ status: 'success', finalUrl: receiptUrl });
  expect(discovery.trace.at(-1)?.urlAfter).toBe(receiptUrl);
  expect(discovery.trace.some(step => step.action === 'navigate')).toBe(false);
  expect(discoveryUrl).toBe(memberUrl);
  expect(discoveryCompletion).toHaveBeenCalledOnce();

  const artifact = recordArtifact({
    name: fixture.capability, description: fixture.action, goal: fixture.action, entryUrl: `${origin}/signon`,
    params, sensitiveParams: [...fixture.sensitive], allowedOrigins: [origin], appId: 'meridian', appDetectors: [], model: 'fixture', discoveryRunId: 'fixture',
  }, discovery);
  artifact.status = 'approved';
  expect(artifact.successCondition).toEqual({ kind: 'urlMatches', pattern: `/members/{{member}}/${fixture.receiptPath}$` });

  let replayUrl = `${origin}/signon`;
  const replaySurface: Surface = {
    mutationDispatched: false,
    start: async url => { replayUrl = url; },
    observe: async () => ({ url: replayUrl, title: '', frames: [] }), currentUrl: () => replayUrl, frameUrls: () => [replayUrl],
    navigate: async url => { replayUrl = url; },
    click: vi.fn(async () => { replaySurface.mutationDispatched = true; replayUrl = receiptUrl; return report; }),
    fill: async () => report, select: async () => report,
    readText: async () => ({ text: fixture.outputValue, report }), isTextVisible: async text => fixture.checkpoint.kind === 'textVisible' && text === fixture.checkpoint.text && replayUrl === receiptUrl,
    describeTarget: async descriptor => descriptor, screenshot: async () => {}, close: async () => {},
  };
  const replayCompletion = vi.fn(async () => { await replaySurface.navigate(memberUrl); });
  const replay = await runReplay(artifact, params, {
    surface: replaySurface, logger: new RunLogger('replay', new Redactor(), temp(), true), policy, validateCompletion: replayCompletion,
  });
  expect(replay).toMatchObject({ status: 'success', outputs: { [fixture.outputName]: fixture.outputValue } });
  expect(replayCompletion).toHaveBeenCalledOnce();
  expect(replaySurface.click).toHaveBeenCalledOnce();
  expect(replayUrl).toBe(memberUrl);
});

it.each([
  { capability: 'meridian-open-share', params: requestOpenShare(), path: 'open-share/post', checkpoint: { kind: 'textVisible', text: 'Share opened' }, outputName: 'shareId', outputValue: '9001-S0001-NEW' },
  { capability: 'meridian-update-member', params: requestMemberUpdate(), path: 'update', checkpoint: { kind: 'textVisible', text: 'Member saved' }, outputName: 'saved', outputValue: 'Member saved' },
  { capability: 'meridian-place-hold', params: requestHold(), path: 'hold/post', checkpoint: { kind: 'urlMatches', pattern: '/members/9001/hold/post$' }, outputName: 'heldShare', outputValue: '9001-S0001-1' },
] as const)('awaits replay $capability completion and keeps delayed rejection unknown after one dispatch', async fixture => {
  const artifact = CapabilityArtifact.parse({
    schemaVersion: 2,
    id: fixture.capability, name: fixture.capability, description: fixture.capability, version: '1.0.0', status: 'approved',
    app: { appId: 'meridian', entryUrl: `${origin}/signon`, allowedOrigins: [origin] },
    parameters: meridianContracts[fixture.capability].parameters,
    outputs: [{ name: fixture.outputName, type: 'string', description: 'Result', sensitive: true }],
    steps: [
      { id: 'post', intent: 'post change', action: 'click', target, risk: 'irreversible' },
      { id: 'checkpoint', intent: 'verify result', action: 'assert', assert: fixture.checkpoint, risk: 'read' },
      { id: 'result', intent: 'read result', action: 'extract', target, extract: { output: fixture.outputName }, risk: 'read' },
    ],
    successCondition: fixture.checkpoint, detectors: [],
    provenance: { discoveredAt: '', model: '', discoveryRunId: '', goal: '' },
  });
  const report = { strategyUsed: 0, kind: 'nameAttr', matches: 1 } as const;
  const surface: Surface = {
    mutationDispatched: false,
    start: async () => {}, observe: async () => ({ url: `${origin}/members/9001/${fixture.path}`, title: '', frames: [] }),
    currentUrl: () => `${origin}/members/9001/${fixture.path}`, frameUrls: () => [`${origin}/members/9001/${fixture.path}`],
    navigate: async () => {}, click: vi.fn(async () => { surface.mutationDispatched = true; return report; }),
    fill: async () => report, select: async () => report, readText: async () => ({ text: fixture.outputValue, report }),
    isTextVisible: async text => fixture.checkpoint.kind === 'textVisible' && text === fixture.checkpoint.text, describeTarget: async descriptor => descriptor,
    screenshot: async () => {}, close: async () => {},
  };
  const validateCompletion = vi.fn(async () => { await Promise.resolve(); throw new Error('Open-share resulting state is not OPEN'); });
  const escalate = vi.fn(async () => 'retry' as const);
  const result = await runReplay(artifact, fixture.params, { surface, logger: new RunLogger('replay', new Redactor(), temp(), true), policy, validateCompletion, escalate });
  expect(result).toMatchObject({ status: 'failure', failure: { code: 'POST_OUTCOME_UNKNOWN' } });
  expect(validateCompletion).toHaveBeenCalledOnce();
  expect(surface.click).toHaveBeenCalledOnce();
  expect(escalate).not.toHaveBeenCalled();
});

it.each([
  ['meridian-open-share', requestOpenShare()],
  ['meridian-update-member', requestMemberUpdate()],
  ['meridian-place-hold', requestHold()],
] as const)('fails canonical %s replay preflight when completion validation is absent', async (capability, params) => {
  const artifact = CapabilityArtifact.parse({
    schemaVersion: 2,
    id: capability, name: capability, description: capability, version: '1.0.0', status: 'approved',
    app: { appId: 'meridian', entryUrl: `${origin}/signon`, allowedOrigins: [origin] },
    parameters: meridianContracts[capability].parameters,
    outputs: [{ name: capability === 'meridian-open-share' ? 'shareId' : capability === 'meridian-update-member' ? 'saved' : 'heldShare', type: 'string', description: 'Result' }],
    steps: [{ id: 'checkpoint', intent: 'fixture', action: 'assert', assert: { kind: 'urlMatches', pattern: '.*' }, risk: 'read' }],
    successCondition: { kind: 'urlMatches', pattern: '.*' }, detectors: [],
    provenance: { discoveredAt: '', model: '', discoveryRunId: '', goal: '' },
  });
  const run = guarded();
  const start = vi.spyOn(run.surface, 'start');
  const result = await runReplay(artifact, params, { surface: run.surface, logger: new RunLogger('replay', new Redactor(), temp(), true), policy });
  expect(result).toMatchObject({ status: 'failure', failure: { stepId: '(pre-flight)' } });
  expect(start).not.toHaveBeenCalled();
  expect(run.dispatch).not.toHaveBeenCalled();
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

it('reads fresh hold eligibility in the same browser context without invalidating the original review control', async () => {
  const app = express(); let posted = 0; let redirectFresh = false; let reloadFresh = false; let websocketFresh = false; let subresourceFresh = false;
  let websocketUpgrades = 0; let websocketMessages = 0; let forbiddenMemberGets = 0; let wrongMemberGets = 0; let operationGets = 0;
  let releaseReviewWebSocket: (() => void) | undefined;
  const upgradeSockets = new Set<Duplex>();
  const identity = '<p>OPR SUPER1 | BR MAIN-001 | SID fixture-session</p>';
  const contact = '<table><tbody><tr><td>Member No.:</td><td>9001</td><td>Name:</td><td>Fixture Member</td></tr><tr><td>E-mail:</td><td>member@example.test</td><td>Phone:</td><td>5550001111</td></tr><tr><td>Address:</td><td>1 Main Street</td></tr></tbody></table>';
  const shares = '<table><tbody><tr><th>Share</th><th>Type</th><th>Balance</th><th>Status</th></tr><tr><td>9001-S0001-1</td><td>Regular Shares</td><td>$8.00</td><td>OPEN</td></tr></tbody></table>';
  const member = `${identity}<table><tbody><tr></tr><tr></tr><tr><td>${contact}${shares}<a href="/members/9001/hold">Place Hold</a></td></tr></tbody></table>`;
  const hold = `${identity}<form method="post" action="/members/9001/hold/review"><input type="hidden" name="_token" value="TOKEN"><select name="share"><option selected value="9001-S0001-1">share</option></select><select name="reason"><option selected value="FRAUD">reason</option></select><textarea name="notes">fixture</textarea><input type="submit" value="Continue"></form>`;
  const review = `${identity}<form method="post" action="/members/9001/hold/post"><input type="hidden" name="_token" value="TOKEN"><input type="hidden" name="share" value="9001-S0001-1"><input type="hidden" name="reason" value="FRAUD"><input type="hidden" name="notes" value="fixture"><table><tr><td class="lbl">Member:</td><td>9001 - Fixture Member</td></tr><tr><td class="lbl">Share:</td><td>9001-S0001-1 - Regular Shares</td></tr><tr><td class="lbl">Reason:</td><td>FRAUD</td></tr><tr><td class="lbl">Notes:</td><td>fixture</td></tr></table><input type="submit" value="Apply Hold"></form>`;
  app.use(express.urlencoded({ extended: false }));
  app.get('/menu', (_req, res) => res.send(`<p>Signed on as J. SUPERVISOR (SUPERVISOR)</p>${identity}`));
  app.get('/members/9001', (_req, res) => {
    if (releaseReviewWebSocket) {
      const release = releaseReviewWebSocket;
      releaseReviewWebSocket = undefined;
      release();
      setTimeout(() => res.send(member), 250);
      return;
    }
    if (reloadFresh) return res.send(`<meta http-equiv="refresh" content="0.01;url=/members/9001">${identity}`);
    if (websocketFresh) return setTimeout(() => res.send(`${member}<script>
      const wsUrl = location.origin.replace(/^http/, 'ws') + '/write-channel';
      const openSocket = Socket => { const socket = new Socket(wsUrl); socket.onopen = () => socket.send('unauthorized mutation'); };
      openSocket(WebSocket);
      const worker = new Worker(URL.createObjectURL(new Blob([\`const socket = new WebSocket('${'${wsUrl}'}'); socket.onopen = () => socket.send('worker mutation');\`], { type: 'text/javascript' })));
      const popup = window.open('about:blank'); if (popup) openSocket(popup.WebSocket);
    </script>`), 100);
    if (subresourceFresh) return res.send(`${member}<link rel="preload" as="image" href="/members/9999"><img src="/members/9001/transfer">`);
    if (redirectFresh) return res.redirect('/members/9999');
    return res.send(member);
  });
  app.get('/arm-review-websocket', (_req, res) => { releaseReviewWebSocket = () => res.send('armed'); });
  app.get('/members/9999', (_req, res) => { wrongMemberGets++; res.send(member); });
  app.get('/members/8888', (_req, res) => { forbiddenMemberGets++; res.send(member); });
  app.get('/members/9001/transfer', (_req, res) => { operationGets++; res.send('not an image'); });
  app.get('/members/9001/hold', (_req, res) => res.send(hold));
  app.post('/members/9001/hold/review', (_req, res) => res.send(review));
  app.post('/members/9001/hold/post', (_req, res) => { posted++; res.send('held'); });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  server.on('upgrade', (request, socket) => {
    websocketUpgrades++;
    upgradeSockets.add(socket);
    socket.once('close', () => upgradeSockets.delete(socket));
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') return socket.destroy();
    const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('data', () => { websocketMessages++; });
  });
  const localOrigin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = new BrowserSurface({ allowedOrigins: [localOrigin], profile });
  const button = (name: string) => ({ description: name, strategies: [{ kind: 'role' as const, role: 'button', name }] });
  try {
    await browser.start(`${localOrigin}/menu`);
    await browser.page.evaluate(url => {
      const socket = new WebSocket(url);
      socket.onopen = () => socket.send('main-page mutation');
    }, localOrigin.replace(/^http/, 'ws') + '/write-channel');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(websocketUpgrades).toBe(0);
    expect(websocketMessages).toBe(0);
    await browser.navigate(`${localOrigin}/members/9001`);
    const enter = await browser.prepareClick({ description: 'Place Hold', strategies: [{ kind: 'role', role: 'link', name: 'Place Hold' }] });
    await enter.dispatch(await enter.inspect());
    const proceed = await browser.prepareClick(button('Continue'));
    await proceed.dispatch(await proceed.inspect());
    const prepared = await browser.prepareClick(button('Apply Hold'));
    const before = await prepared.inspect();
    await browser.page.evaluate(url => {
      void fetch('/arm-review-websocket').then(() => setTimeout(() => {
        const socket = new WebSocket(url);
        socket.onopen = () => socket.send('original review mutation');
      }, 0));
    }, localOrigin.replace(/^http/, 'ws') + '/write-channel');
    for (let attempt = 0; attempt < 50 && !releaseReviewWebSocket; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(releaseReviewWebSocket).toBeTypeOf('function');
    const snapshot = await browser.readOnlyPage(`${localOrigin}/members/9001`, [meridianMemberContactTable, meridianTransferMemberTable], 3000);
    expect(snapshot).toMatchObject({
      url: `${localOrigin}/members/9001`,
      identity: { operator: 'SUPER1', branch: 'MAIN-001', trusted: true },
      tables: [[expect.objectContaining({ member: '9001', name: 'Fixture Member' })], [expect.objectContaining({ shareId: '9001-S0001-1', status: 'OPEN' })]],
    });
    expect(browser.currentUrl()).toBe(`${localOrigin}/members/9001/hold/review`);
    expect(browser.page.context().pages()).toHaveLength(1);
    expect(await prepared.inspect()).toEqual(before);
    await prepared.dispatch(before, 3000);
    expect(posted).toBe(1);
    redirectFresh = true;
    await expect(browser.readOnlyPage(`${localOrigin}/members/9001`, [meridianMemberContactTable], 3000)).rejects.toThrow(/navigation|redirected/i);
    expect(browser.page.context().pages()).toHaveLength(1);
    redirectFresh = false;
    wrongMemberGets = 0;
    reloadFresh = true;
    await expect(browser.readOnlyPage(`${localOrigin}/members/9001`, [meridianMemberContactTable], 500)).rejects.toThrow(/changed/i);
    expect(browser.page.context().pages()).toHaveLength(1);
    reloadFresh = false;

    websocketFresh = true;
    await expect(browser.readOnlyPage(`${localOrigin}/members/9001`, [meridianMemberContactTable], 3000)).resolves.toMatchObject({
      tables: [[expect.objectContaining({ member: '9001', name: 'Fixture Member' })]],
    });
    expect(websocketUpgrades).toBe(0);
    expect(websocketMessages).toBe(0);
    expect(browser.page.context().pages()).toHaveLength(1);
    websocketFresh = false;

    subresourceFresh = true;
    await expect(browser.readOnlyPage(`${localOrigin}/members/9001`, [meridianMemberContactTable], 3000)).rejects.toThrow(/subresource/i);
    subresourceFresh = false;
    expect(wrongMemberGets).toBe(0);
    expect(operationGets).toBe(0);
    expect(browser.page.context().pages()).toHaveLength(1);

    const context = browser.page.context();
    const originalUrl = browser.currentUrl();
    const nativeNewPage = context.newPage.bind(context);
    let priorPopup: Page | undefined;
    const pendingPopup = vi.spyOn(context, 'newPage').mockImplementationOnce(async () => {
      const popup = browser.page.waitForEvent('popup');
      const auxiliary = nativeNewPage();
      await browser.page.evaluate(() => { window.open('/members/9999'); });
      priorPopup = await popup;
      return auxiliary;
    });
    try {
      await expect(browser.readOnlyPage(`${localOrigin}/members/9001`, [meridianMemberContactTable], 3000)).rejects.toThrow(/popup/i);
    } finally { pendingPopup.mockRestore(); }
    expect(wrongMemberGets).toBe(0);
    expect(context.pages().map(page => page.url())).toEqual([originalUrl]);
    expect(browser.currentUrl()).toBe(originalUrl);

    let cleanupPopup: Page | undefined;
    const popupDuringClose = vi.spyOn(context, 'newPage').mockImplementationOnce(async () => {
      if (!priorPopup?.isClosed()) throw new Error('Prior popup cleanup did not finish');
      // A delayed event from a closed popup must not steal the auxiliary
      // page's close hook. Bind it to newPage's result, not the next event.
      (context as unknown as { emit(event: string, page: Page): boolean }).emit('page', priorPopup);
      const opened = await nativeNewPage();
      const nativeClose = opened.close.bind(opened);
      vi.spyOn(opened, 'close').mockImplementationOnce(async () => {
        const popup = browser.page.waitForEvent('popup');
        await browser.page.evaluate(() => { window.open('/members/9999'); });
        cleanupPopup = await popup;
        await nativeClose();
      });
      return opened;
    });
    try {
      await expect(browser.readOnlyPage(`${localOrigin}/members/9001`, [meridianMemberContactTable], 3000)).rejects.toThrow(/popup/i);
    } finally { popupDuringClose.mockRestore(); }
    expect(cleanupPopup?.isClosed()).toBe(true);
    expect(wrongMemberGets).toBe(0);
    expect(context.pages().map(page => page.url())).toEqual([originalUrl]);

    const guardedLatePopup = context.waitForEvent('page');
    await browser.page.evaluate(() => { window.open('about:blank'); });
    const latePopup = await guardedLatePopup;
    await expect(latePopup.goto(`${localOrigin}/members/9999`, { waitUntil: 'load', timeout: 1000 })).rejects.toThrow();
    expect(wrongMemberGets).toBe(0);
    await latePopup.close();

    const creationFailure = vi.spyOn(context, 'newPage').mockRejectedValueOnce(new Error('fixture auxiliary creation failure'));
    try {
      await expect(browser.readOnlyPage(`${localOrigin}/members/9001`, [meridianMemberContactTable], 3000)).rejects.toThrow(/creation failure/i);
    } finally { creationFailure.mockRestore(); }
    const closedPage = await nativeNewPage();
    await closedPage.close();
    const delayedClosedPage = vi.spyOn(context, 'newPage').mockImplementationOnce(async () => {
      (context as unknown as { emit(event: string, page: Page): boolean }).emit('page', closedPage);
      return nativeNewPage();
    });
    try {
      await expect(browser.readOnlyPage(`${localOrigin}/members/9001`, [meridianMemberContactTable], 3000)).resolves.toMatchObject({
        tables: [[expect.objectContaining({ member: '9001', name: 'Fixture Member' })]],
      });
    } finally { delayedClosedPage.mockRestore(); }
    expect(context.pages().map(page => page.url())).toEqual([originalUrl]);
    expect(browser.currentUrl()).toBe(originalUrl);

    let auxiliary: Page | undefined;
    let closeSpy: ReturnType<typeof vi.spyOn> | undefined;
    const sabotageClose = (opened: Page) => {
      if (opened === browser.page) return;
      auxiliary = opened;
      closeSpy = vi.spyOn(opened, 'close').mockRejectedValue(new Error('fixture close failure'));
    };
    browser.page.context().on('page', sabotageClose);
    await expect(browser.readOnlyPage(`${localOrigin}/members/9001`, [meridianMemberContactTable], 3000)).rejects.toThrow(/cleanup/i);
    browser.page.context().off('page', sabotageClose);
    expect(auxiliary?.isClosed()).toBe(false);
    closeSpy?.mockRestore();
    if (!auxiliary) throw new Error('Fixture auxiliary page was not captured');
    await expect(auxiliary.goto(`${localOrigin}/members/8888`, { waitUntil: 'load', timeout: 1000 })).rejects.toThrow();
    expect(forbiddenMemberGets).toBe(0);
    await browser.page.context().unroute('**/*');
    await expect(auxiliary.goto(`${localOrigin}/members/8888`, { waitUntil: 'load', timeout: 1000 })).rejects.toThrow();
    expect(forbiddenMemberGets).toBe(0);
    // Browser shutdown below disposes the intentionally failed page close.
  } finally {
    for (const socket of upgradeSockets) socket.destroy();
    await browser.close();
    server.close();
    server.closeAllConnections();
  }
}, 30000);

it('extracts one canonical transfer row from a vertical receipt and persists only its table structure', async () => {
  const request = { member: '9001', sourceShare: '9001-A', destinationShare: '9001-B', amount: '1.00', memo: 'fixture' };
  const fields = [
    ['Member:', request.member], ['From:', request.sourceShare], ['To:', request.destinationShare],
    ['Amount:', '$1.00'], ['Memo:', request.memo], ['Confirmation:', 'CONF-123'],
  ].map(([label, value]) => `<tr><td>${label}</td><td>${value}</td></tr>`).join('');
  const app = express();
  app.get('/receipt', (_req, res) => res.send(`<table id="transaction" data-token="PRIVATE TABLE TOKEN"><thead><tr><th colspan="2">PRIVATE RECEIPT HEADER</th></tr></thead><tbody>${fields}</tbody></table>`));
  app.get('/custom-receipt', (_req, res) => res.send(`<token-private-9001><table><tbody>${fields}</tbody></table></token-private-9001>`));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const localOrigin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = new BrowserSurface({
    allowedOrigins: [localOrigin],
    profile: { ...profile, entryUrl: `${localOrigin}/receipt`, routes: ['^/(custom-)?receipt$'], maskSelectors: ['body'] },
  });
  try {
    await browser.start(`${localOrigin}/receipt`);
    const columns = [
      { name: 'member', selector: 'tr:nth-of-type(1) > td:nth-of-type(2)', type: 'string' as const },
      { name: 'sourceShare', selector: 'tr:nth-of-type(2) > td:nth-of-type(2)', type: 'string' as const },
      { name: 'destinationShare', selector: 'tr:nth-of-type(3) > td:nth-of-type(2)', type: 'string' as const },
      { name: 'amount', selector: 'tr:nth-of-type(4) > td:nth-of-type(2)', type: 'money' as const },
      { name: 'memo', selector: 'tr:nth-of-type(5) > td:nth-of-type(2)', type: 'string' as const },
      { name: 'confirmation', selector: 'tr:nth-of-type(6) > td:nth-of-type(2)', type: 'string' as const },
    ];
    const transaction = await browser.readTable(
      { description: 'posted transaction', strategies: [{ kind: 'css', selector: '#transaction' }] },
      columns,
      1000,
      'tbody',
    );
    const outputs: Record<string, OutputValue> = { confirmation: 'CONF-123', transaction };
    expect(transaction).toEqual([{ ...request, confirmation: 'CONF-123' }]);
    expect(() => assertTransferOutputs(request, outputs)).not.toThrow();
    expect(() => assertTransferOutputs(request, { ...outputs, transaction: [{ ...transaction[0]!, amount: '2.00' }] })).toThrow(/validation/);

    const logger = new RunLogger('replay', new Redactor(), temp(), true);
    const screenshot = await logger.screenshot(browser, 'receipt');
    const metadata = readFileSync(screenshot.replace(/\.png$/, '.json'), 'utf8');
    expect(metadata).not.toMatch(/PRIVATE RECEIPT HEADER|PRIVATE TABLE TOKEN|transaction|9001|CONF-123|fixture/);
    expect(JSON.parse(metadata).frames[0].tables).toEqual([{
      selector: 'body > table:nth-of-type(1)', rows: 7,
      rowCells: [['th'], ...Array.from({ length: 6 }, () => ['td', 'td'])],
    }]);

    await browser.navigate(`${localOrigin}/custom-receipt`);
    expect((await browser.observe()).frames[0]!.tables![0]!.selector).toContain('token-private-9001');
    const rejected = await logger.screenshot(browser, 'custom-ancestor');
    const rejectedMetadata = readFileSync(rejected.replace(/\.png$/, '.json'), 'utf8');
    expect(rejectedMetadata).not.toContain('token-private-9001');
    expect(JSON.parse(rejectedMetadata).frames[0].tables).toEqual([]);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
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

it('requires one complete rendered hold or open-share review table before approval', async () => {
  const app = express();
  const identity = '<p>Signed on as J. SUPERVISOR (SUPERVISOR)</p><p>OPR SUPER1 | BR MAIN-001 | SID fixture-session</p>';
  app.get('/menu', (_req, res) => res.send(identity));
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  const localOrigin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = new BrowserSurface({ allowedOrigins: [localOrigin], profile });
  const rows = (values: readonly string[], labels: readonly string[]) => `<table>${labels.map((label, index) => `<tr><td class="lbl">${label}</td><td>${values[index]}</td></tr>`).join('')}</table>`;
  const fixtures = [
    {
      control: 'Apply Hold',
      action: '/members/9001/hold/post',
      fields: '<input type="hidden" name="_token" value="TOKEN"><input type="hidden" name="share" value="9001-S0001-1"><input type="hidden" name="reason" value="FRAUD"><input type="hidden" name="notes" value="fixture">',
      labels: ['Member:', 'Share:', 'Reason:', 'Notes:'],
      active: ['9001 - Fixture Member', '9001-S0001-1 - Regular Shares', 'FRAUD', 'fixture'],
      stale: ['9001 - Stale Member', '9001-S0070-1 - Share Draft (Checking)', 'LEGAL', 'stale'],
      expected: { 'review:Member:': '9001 - Fixture Member', 'review:Share:': '9001-S0001-1 - Regular Shares', 'review:Reason:': 'FRAUD', 'review:Notes:': 'fixture' },
    },
    {
      control: 'Open Share',
      action: '/members/9001/open-share/post',
      fields: '<input type="hidden" name="_token" value="TOKEN"><input type="hidden" name="type" value="S0001"><input type="hidden" name="deposit" value="5.00">',
      labels: ['Member:', 'Share Type:', 'Initial Deposit:'],
      active: ['9001 - Fixture Member', 'S0001 - Regular Shares', '$5.00'],
      stale: ['9001 - Stale Member', 'S0070 - Share Draft (Checking)', '$9.00'],
      expected: { 'review:Member:': '9001 - Fixture Member', 'review:Share Type:': 'S0001 - Regular Shares', 'review:Initial Deposit:': '$5.00' },
    },
  ] as const;
  try {
    await browser.start(`${localOrigin}/menu`);
    for (const fixture of fixtures) {
      const form = (reviewTables: string) => `${identity}<form method="post" action="${fixture.action}">${fixture.fields}${reviewTables}<input type="submit" value="${fixture.control}"></form>`;
      await browser.page.setContent(form(rows(fixture.active, fixture.labels)));
      const target = { description: fixture.control, strategies: [{ kind: 'role' as const, role: 'button', name: fixture.control }] };
      const prepared = await browser.prepareClick(target);
      await expect(prepared.inspect()).resolves.toMatchObject({ facts: fixture.expected });

      await browser.page.setContent(form(`${rows(fixture.stale, fixture.labels)}${rows(fixture.active, fixture.labels)}`));
      const gate = vi.fn(async () => false);
      const beforeDispatch = vi.fn();
      const guardedSurface = new GuardedSurface(browser, Policy.parse({ ...policy, allowedOrigins: [localOrigin] }), gate, undefined, {
        profile, session: new ControlSession(), deadline: Date.now() + 10_000,
        runId: randomUUID(), artifact: 'hold', version: '1.0.0',
        operator: 'super1', branch: 'MAIN-001', role: 'SUPERVISOR', beforeDispatch,
      });
      await expect(guardedSurface.click(target)).rejects.toThrow(/ambiguous/i);
      expect(gate).not.toHaveBeenCalled();
      expect(beforeDispatch).not.toHaveBeenCalled();
      expect(guardedSurface.mutationDispatched).toBe(false);
    }
  } finally {
    await browser.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
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

it('bounds discovery table metadata sent to the model', async () => {
  const requests: string[] = [];
  const rowCells = Array.from({ length: 200 }, () => ['td' as const, 'td' as const, 'td' as const]);
  const stub = guarded({
    observe: async () => ({ url: `${origin}/menu`, title: 'Menu', frames: [{
      frame: '', snapshot: 'Accounts', fields: [], tables: [{
        selector: '#accounts', headers: ['Account', 'Status'], headerCells: ['th', 'th'], rows: rowCells.length, rowCells,
      }],
    }] }),
  });
  const client = { chat: { completions: { create: async (request: unknown) => {
    requests.push(JSON.stringify(request));
    return { choices: [{ message: { role: 'assistant', tool_calls: [{ id: randomUUID(), type: 'function', function: { name: 'done', arguments: JSON.stringify({ summary: 'done' }) } }] } }] };
  } } } } as unknown as Parameters<typeof runDiscovery>[4]['openai'];
  const result = await runDiscovery('read accounts', `${origin}/menu`, {}, [origin], {
    surface: stub.surface, logger: new RunLogger('discovery', new Redactor(), temp(), true), openai: client, model: 'fixture', maxSteps: 1,
  });
  expect(result.status).toBe('success');
  const request = JSON.parse(requests[0]!);
  const observation = request.messages[1].content as string;
  expect(observation).toContain('"selector":"#accounts"');
  expect(observation).toContain('"headers":["Account","Status"]');
  expect(observation).toContain('"headerCells":["th","th"]');
  expect(observation).toContain('"rows":200');
  expect(observation).not.toContain('rowCells');
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
