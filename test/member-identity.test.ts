import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { request as httpRequest, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/runtime/journal.js';
import { InvocationService } from '../src/server/service.js';
import { createApp } from '../src/server/http.js';
import * as runtime from '../src/runtime/run.js';
import { RunLogger } from '../src/evidence/logger.js';
import { loadProfile } from '../src/runtime/profile.js';
import { Policy } from '../src/safety/policy.js';
import { Redactor } from '../src/safety/redact.js';
import { recordedStructure } from '../src/evidence/safe-event.js';
import type { ReplayResult } from '../src/replay/outcomes.js';
import { principalKey, type Principal } from '../src/server/auth.js';

const balance = 'meridian-member-record', inquiry = 'meridian-member-inquiry';
const member = '9001', name = 'Verified Fixture Member';
const context = { runId: 'fixture', evidenceDir: 'unused', recoveries: [] };
const shares: ReplayResult = { ...context, status: 'success', outputs: { shares: [{ balance: '1200.10' }] } };
const identity = (rows = [{ memberNumber: member, name }]): ReplayResult =>
  ({ ...context, status: 'success', outputs: { members: rows } });
const failure: ReplayResult = { ...context, status: 'failure', escalated: false,
  failure: { stepId: 'lookup', code: 'RUN_FAILED', intent: 'lookup', expected: 'member', observed: 'unavailable' } };
const publicShares = { status: 'success', outputs: shares.outputs };
const cleanup: (() => Promise<void>)[] = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});
function fixture(allowlist = [balance, inquiry]) {
  for (const role of ['TELLER', 'SUPERVISOR']) {
    vi.stubEnv(`MERIDIAN_${role}_OPERATOR`, role);
    vi.stubEnv(`MERIDIAN_${role}_PASSWORD`, 'fixture-password');
  }
  vi.stubEnv('MERIDIAN_BRANCH', 'MAIN-001');
  const dir = mkdtempSync(join(tmpdir(), 'member-identity-'));
  const journal = new Journal(join(dir, 'journal'), 'member-identity-fixture-hmac-key-32-characters');
  const policy = Policy.parse({ allowedOrigins: ['https://web-sample.interface-hiring.com'],
    allowedActions: ['navigate', 'click', 'fill', 'select', 'extract', 'assert'],
    riskHandling: { read: 'allow', reversible_write: 'allow', irreversible: 'escalate' } });
  const service = new InvocationService(journal, policy, loadProfile('meridian'), dir, allowlist);
  const releases: ((result: ReplayResult) => void)[] = [];
  const create = vi.spyOn(runtime, 'createRuntime').mockImplementation(() => ({
    surface: { mutationDispatched: false }, promptRedactor: new Redactor(), close: async () => {},
  }) as unknown as ReturnType<typeof runtime.createRuntime>);
  const replay = vi.spyOn(runtime, 'executeReplay').mockImplementation(() => new Promise(resolve => { releases.push(resolve); }));
  cleanup.push(async () => {
    releases.forEach(resolve => resolve(failure));
    await service.close(); journal.close(); rmSync(dir, { recursive: true, force: true });
  });
  async function start(principal: Principal = 'caller', role: 'TELLER' | 'SUPERVISOR' = 'TELLER') {
    const accepted = await service.invoke(principal, balance, { member }, 'balance-request', role);
    releases[0]!(shares);
    await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(2));
    const lookup = [...journal.records.values()].find(r => r.capability === inquiry)!;
    return { ...accepted, lookup };
  }
  async function settle(runId: string) {
    await vi.waitFor(async () => expect((await service.get('operator', runId)).memberIdentity?.status).not.toBe('pending'));
    return service.get('operator', runId);
  }
  return { service, journal, dir, create, replay, releases, start, settle };
}

it('lookup-only recovery does not reserve or start a missing balance request', async () => {
  const f = fixture();
  const before = f.journal.records.size;
  await expect(f.service.invoke('caller', balance, { member }, 'missing-request', 'TELLER', true)).rejects.toThrow(/No accepted request/);
  expect(f.journal.records.size).toBe(before);
  expect(f.create).not.toHaveBeenCalled();
  expect(f.replay).not.toHaveBeenCalled();
});

it('serializes the exact-member read under the same caller and role, with no replay on status or key reuse', async () => {
  const f = fixture();
  const accepted = await f.service.invoke('operator', balance, { member }, 'balance-request', 'SUPERVISOR');
  expect(f.replay).toHaveBeenCalledTimes(1);
  await expect(f.service.invoke('caller', inquiry, { searchMode: 'number', searchValue: member }, 'other')).rejects.toThrow('One run is active');
  f.releases[0]!(shares);
  await vi.waitFor(() => expect(f.replay).toHaveBeenCalledTimes(2));
  const lookup = [...f.journal.records.values()][1]!;
  expect(lookup.caller).toBe('operator');
  expect(f.create.mock.calls[1]![0]).toMatchObject({ artifact: inquiry,
    params: { searchMode: 'number', searchValue: member }, operator: { operator: 'SUPERVISOR', role: 'SUPERVISOR' } });
  expect(f.journal.findRequest('operator', `member-identity:${accepted.runId}`)?.runId).toBe(lookup.runId);
  expect((await f.service.get('operator', accepted.runId)).memberIdentity).toEqual({ status: 'pending', inquiryRunId: lookup.runId });
  expect((await f.service.history('operator')).map(run => run.runId)).toEqual([accepted.runId]);
  expect(await f.service.get('operator', lookup.runId)).toMatchObject({ inputs: undefined, result: undefined });
  await expect(f.service.get('caller', accepted.runId)).rejects.toThrow('another principal');
  f.releases[1]!(identity());
  const run = await f.settle(accepted.runId);
  expect(run.memberIdentity).toEqual({ status: 'verified', inquiryRunId: lookup.runId, memberNumber: member, name });
  expect(run.result).toEqual(publicShares);
  const privateLookup = await f.service.get('operator', lookup.runId);
  expect(privateLookup).toMatchObject({ inputs: undefined, result: { status: 'success' } });
  expect(privateLookup.result).not.toHaveProperty('outputs');
  expect(JSON.stringify(privateLookup)).not.toContain(name);
  expect(await f.service.invoke('operator', balance, { member }, 'balance-request', 'SUPERVISOR')).toEqual({ ...accepted, reused: true });
  for (let i = 0; i < 3; i++) await f.service.history('operator');
  expect(f.replay).toHaveBeenCalledTimes(2);
  const saved = readdirSync(f.journal.dir).filter(file => file.endsWith('.json')).map(file => readFileSync(join(f.journal.dir, file), 'utf8')).join('');
  for (const sensitive of [member, name, '1200.10', 'fixture-password']) expect(saved).not.toContain(sensitive);
  f.service.live.clear();
  expect(await f.service.get('operator', accepted.runId)).toMatchObject({ sensitiveValuesUnavailable: true, memberIdentity: { status: 'unavailable' } });
  expect(await f.service.get('operator', lookup.runId)).toMatchObject({ inputs: undefined, result: undefined });
  expect((await f.service.history('operator')).map(run => run.runId)).toEqual([accepted.runId]);
  expect((await f.service.invoke('operator', balance, { member }, 'balance-request', 'SUPERVISOR')).reused).toBe(true);
  expect(f.replay).toHaveBeenCalledTimes(2);
});

it('keeps a subject owner on the linked member-identity inquiry', async () => {
  const f = fixture();
  const principal = { subjectId: '11111111-1111-4111-8111-111111111111', role: 'operator' } as const;
  const { runId } = await f.service.invoke(principal, balance, { member }, 'subject-balance', 'SUPERVISOR');
  f.releases[0]!(shares);
  await vi.waitFor(() => expect(f.replay).toHaveBeenCalledTimes(2));
  const lookup = [...f.journal.records.values()].find(r => r.capability === inquiry)!;
  expect(f.journal.records.get(runId)?.caller).toBe(principalKey(principal));
  expect(lookup.caller).toBe(principalKey(principal));
  expect(f.journal.findRequest(principalKey(principal), `member-identity:${runId}`)?.runId).toBe(lookup.runId);
  await expect(f.service.get({ ...principal, subjectId: '22222222-2222-4222-8222-222222222222' }, lookup.runId)).rejects.toThrow('another principal');
  f.releases[1]!(identity());
  await vi.waitFor(async () => expect((await f.service.get(principal, runId)).memberIdentity?.status).toBe('verified'));
  const child = await f.service.get(principal, lookup.runId);
  expect(child).toMatchObject({ inputs: undefined, result: { status: 'success' } });
  expect(child.result).not.toHaveProperty('outputs');
});

it('keeps an explicitly requested name inquiry public', async () => {
  const f = fixture();
  const accepted = await f.service.invoke('caller', inquiry, { searchMode: 'name', searchValue: name }, 'member-identity:client-controlled');
  f.releases[0]!(identity());
  await vi.waitFor(async () => expect((await f.service.get('caller', accepted.runId)).state).toBe('success'));
  expect(await f.service.get('caller', accepted.runId)).toMatchObject({
    inputs: { searchMode: 'name', searchValue: name }, result: { status: 'success', outputs: { members: [{ memberNumber: member, name }] } },
  });
  expect((await f.service.get('caller', accepted.runId)).sensitiveValuesUnavailable).toBe(false);
  expect((await f.service.history('caller')).map(run => run.runId)).toEqual([accepted.runId]);
});

it('projects a real private child intervention and permits only exact abort or retry decisions', async () => {
  const f = fixture();
  const principal = { subjectId: '11111111-1111-4111-8111-111111111111', role: 'operator' } as const;
  const otherPrincipal = { subjectId: '22222222-2222-4222-8222-222222222222', role: 'operator' } as const;
  const operatorToken = 'o'.repeat(32);
  const otherToken = 'x'.repeat(32);
  const privateGoal = 'PRIVATE child goal canary';
  const privateReason = 'PRIVATE child reason canary';
  const privateUrl = 'https://private.example.test/?token=PRIVATE_CHILD_TOKEN';
  const page = {
    isClosed: () => false,
    exposeBinding: async () => {},
    frames: () => [],
    on: () => page,
    off: () => page,
    bringToFront: async () => {},
  } as unknown as ReturnType<typeof runtime.createRuntime>['browser']['page'];
  f.create.mockImplementation(options => {
    const logger = new RunLogger(options.kind, new Redactor(), options.evidenceDir ?? f.dir, true, options.runId, options.onEvent);
    return {
      surface: { mutationDispatched: false }, browser: { page }, logger,
      promptRedactor: new Redactor(), close: async () => {},
    } as unknown as ReturnType<typeof runtime.createRuntime>;
  });
  let replayCount = 0;
  f.replay.mockImplementation(async (_artifact, _params, _run, _policy, escalate) => {
    replayCount++;
    if (replayCount % 2 === 1) return shares;
    const decision = await escalate!({ kind: 'replay_stuck', capability: inquiry, goal: privateGoal, reason: privateReason, url: privateUrl });
    return decision === 'retry' ? identity() : failure;
  });

  const app = createApp(f.service, {
    callerToken: '', operatorToken: '', port: 4180,
    subjectTokens: [
      { ...principal, token: operatorToken },
      { ...otherPrincipal, token: otherToken },
    ],
  });
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP test server');
  const decideHttp = (token: string, runId: string, approvalId: string, decision: string) => new Promise<{ status: number; text: string; json?: unknown }>((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1', port: address.port, path: `/runs/${runId}/decision`, method: 'POST',
      headers: {
        Host: '127.0.0.1:4180', Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown;
        try { json = JSON.parse(text); } catch { /* preserve non-JSON response text */ }
        resolve({ status: response.statusCode!, text, json });
      });
    });
    request.on('error', reject);
    request.end(JSON.stringify({ approvalId, decision }));
  });

  const accepted = await f.service.invoke(principal, balance, { member }, 'private-http-parent', 'SUPERVISOR');
  await vi.waitFor(async () => {
    const child = (await f.journal.list()).find(record => record.capability === inquiry);
    expect(child).toBeDefined();
    expect(f.service.live.get(child!.runId)?.approval.pending).toBeDefined();
  });
  const child = (await f.journal.list()).find(record => record.capability === inquiry)!;
  const pendingId = f.service.live.get(child.runId)!.approval.pending!.id;
  const operatorView = await f.service.get(principal, child.runId);
  expect((await f.service.history(principal)).map(run => run.runId)).toEqual([accepted.runId, child.runId]);
  expect(operatorView).toMatchObject({ inputs: undefined, result: undefined });
  expect(operatorView.intervention).toMatchObject({
    id: pendingId, expiresAt: expect.any(Number),
    request: {
      kind: 'replay_stuck', capability: inquiry,
      goal: 'Complete the linked identity check.',
      reason: 'Linked identity check needs operator attention.', url: '(unavailable)',
    },
  });
  expect(operatorView.intervention).not.toHaveProperty('request.action');
  expect(JSON.stringify([operatorView, await f.service.get({ ...principal, role: 'caller' }, child.runId)])).not.toMatch(/PRIVATE child|PRIVATE_CHILD/);
  expect((await f.service.get({ ...principal, role: 'caller' }, child.runId)).intervention).toEqual({ kind: 'replay_stuck', awaitingOperator: true });

  expect(await decideHttp(operatorToken, accepted.runId, pendingId, 'abort')).toMatchObject({ status: 409 });
  expect(await decideHttp(operatorToken, child.runId, randomUUID(), 'abort')).toMatchObject({ status: 409 });
  expect(await decideHttp(otherToken, child.runId, pendingId, 'abort')).toMatchObject({ status: 403 });
  const approve = await decideHttp(operatorToken, child.runId, pendingId, 'approve');
  expect(approve).toMatchObject({ status: 409, json: { error: 'Private identity inquiry approval is unavailable' } });
  expect(approve.text).not.toMatch(/PRIVATE child|PRIVATE_CHILD/);
  expect(f.service.live.get(child.runId)!.approval.pending?.id).toBe(pendingId);

  expect(await decideHttp(operatorToken, child.runId, pendingId, 'abort')).toMatchObject({ status: 200, json: { accepted: true } });
  await vi.waitFor(async () => expect((await f.service.get(principal, child.runId)).state).toBe('failure'));
  await expect(f.service.decide(principal, child.runId, pendingId, 'abort')).rejects.toThrow(/Stale or duplicate decision/);
  expect((await f.service.history(principal)).map(run => run.runId)).not.toContain(child.runId);

  const retried = await f.service.invoke(principal, balance, { member }, 'private-http-retry', 'SUPERVISOR');
  await vi.waitFor(async () => {
    const childRun = (await f.journal.list()).filter(record => record.capability === inquiry).at(-1)!;
    expect(f.service.live.get(childRun.runId)?.approval.pending).toBeDefined();
  });
  const retriedChild = (await f.journal.list()).filter(record => record.capability === inquiry).at(-1)!;
  const retriedId = f.service.live.get(retriedChild.runId)!.approval.pending!.id;
  await f.service.decide(principal, retriedChild.runId, retriedId, 'retry');
  await vi.waitFor(async () => expect((await f.service.get(principal, retriedChild.runId)).state).toBe('success'));
  await vi.waitFor(async () => expect((await f.service.get(principal, retried.runId)).memberIdentity?.status).toBe('verified'));

  const expiring = await f.service.invoke(principal, balance, { member }, 'private-http-expiry', 'SUPERVISOR');
  await vi.waitFor(async () => {
    const childRun = (await f.journal.list()).filter(record => record.capability === inquiry).at(-1)!;
    expect(f.service.live.get(childRun.runId)?.approval.pending).toBeDefined();
  });
  const expiringChild = (await f.journal.list()).filter(record => record.capability === inquiry).at(-1)!;
  const expiringId = f.service.live.get(expiringChild.runId)!.approval.pending!.id;
  f.service.live.get(expiringChild.runId)!.approval.pending!.expiresAt = Date.now() - 1;
  await expect(f.service.decide(principal, expiringChild.runId, expiringId, 'retry')).rejects.toThrow(/expired/);
  await vi.waitFor(async () => expect((await f.service.get(principal, expiringChild.runId)).state).toBe('failure'));
  await vi.waitFor(async () => expect((await f.service.get(principal, expiring.runId)).memberIdentity?.status).toBe('unavailable'));
});

it('withholds restored internal inquiry values on a fresh service', async () => {
  const f = fixture();
  const { runId, lookup } = await f.start();
  f.releases[1]!(identity());
  await f.settle(runId);
  const rawName = 'SYNTHETIC_RESTORED_MEMBER';
  const rawResult = { status: 'success', outputs: { members: [{ memberNumber: '9002', name: rawName }] },
    structure: recordedStructure(inquiry, { searchMode: 'number', searchValue: member }, identity()) };
  mkdirSync(join(f.dir, lookup.runId), { recursive: true });
  writeFileSync(join(f.dir, lookup.runId, 'result.json'), JSON.stringify(rawResult));
  await f.service.close();
  f.journal.close();
  const restoredJournal = new Journal(join(f.dir, 'journal'), 'member-identity-fixture-hmac-key-32-characters');
  const restored = new InvocationService(restoredJournal, f.service.policy, f.service.profile, f.dir, [balance, inquiry]);
  try {
    const run = await restored.get('caller', lookup.runId);
    expect(run).toMatchObject({ inputs: undefined, result: { status: 'success', sensitiveValuesUnavailable: true, structure: { capability: inquiry } } });
    expect(JSON.stringify(run)).not.toContain(member);
    expect(JSON.stringify(run)).not.toContain(rawName);
    expect(JSON.stringify(run)).not.toContain('9002');
    expect((await restored.history('caller')).find(item => item.runId === lookup.runId)).toMatchObject({ inputs: undefined });
  } finally {
    await restored.close();
    restoredJournal.close();
  }
});

it.each([
  ['different member', identity([{ memberNumber: 'wrong-member', name }]), ''],
  ['duplicate rows', identity([{ memberNumber: member, name }, { memberNumber: member, name }]), ''],
  ['conflicting rows', identity([{ memberNumber: member, name }, { memberNumber: member, name: 'Other' }]), ''],
  ['ambiguous results', identity([{ memberNumber: member, name }, { memberNumber: 'other', name }]), ''],
  ['empty rows', identity([]), ''],
  ['blank name', identity([{ memberNumber: member, name: '  ' }]), ''],
  ['failed inquiry', failure, ''],
  ['withheld outputs', identity(undefined), 'withheld'],
  ['name-mode inquiry', identity(), 'name'],
  ['different search input', identity(), 'member'],
  ['different caller', identity(), 'caller'],
] as const)('keeps the balance but rejects identity from %s', async (_label, result, change) => {
  const f = fixture();
  const { runId, lookup } = await f.start();
  const live = f.service.live.get(lookup.runId)!;
  if (change === 'name') live.inputs.searchMode = 'name';
  if (change === 'member') live.inputs.searchValue = 'another-member';
  if (change === 'caller') f.journal.records.set(lookup.runId, { ...lookup, caller: 'operator' });
  const authorizedViews = change === 'caller' ? (['operator'] as const) : (['caller', 'operator'] as const);
  for (const principal of authorizedViews) {
    expect((await f.service.history(principal)).map(run => run.runId)).not.toContain(lookup.runId);
    expect(await f.service.get(principal, lookup.runId)).toMatchObject({ inputs: undefined, result: undefined });
  }
  f.releases[1]!(result);
  if (change === 'withheld') f.service.live.delete(lookup.runId);
  const run = await f.settle(runId);
  expect(run.memberIdentity).toEqual({ status: 'unavailable', inquiryRunId: lookup.runId });
  expect(run.result).toEqual(publicShares);
  for (const principal of authorizedViews) {
    const child = await f.service.get(principal, lookup.runId);
    expect((await f.service.history(principal)).map(item => item.runId)).not.toContain(lookup.runId);
    expect(child.inputs).toBeUndefined();
    expect(child.result ? 'outputs' in child.result : false).toBe(false);
    expect(JSON.stringify(child)).not.toContain(name);
  }
});

it.each(['unauthorized', 'missing', 'failed balance', 'shutdown', 'unknown', 'lookup setup failure'] as const)('does not execute a lookup when %s', async reason => {
  const f = fixture(reason === 'unauthorized' ? [balance] : undefined);
  if (reason === 'missing') f.service.artifacts.delete(inquiry);
  if (reason === 'lookup setup failure') f.create.mockImplementationOnce(f.create.getMockImplementation()!)
    .mockImplementationOnce(() => { throw new Error('Injected inquiry setup failure'); });
  if (reason === 'unknown') {
    const prior = f.journal.reserve('caller', 'unknown', inquiry, '1.0.0', {});
    f.journal.update(prior.runId, 'POST_OUTCOME_UNKNOWN');
  }
  const { runId } = await f.service.invoke('caller', balance, { member }, 'balance-request');
  const close = reason === 'shutdown' ? f.service.close() : undefined;
  f.releases[0]!(reason === 'failed balance' ? failure : shares);
  await close;
  expect((await f.settle(runId)).memberIdentity).toEqual({ status: 'unavailable', inquiryRunId: undefined });
  if (reason === 'lookup setup failure') {
    expect(await f.service.get('caller', runId)).toMatchObject({ state: 'success', result: publicShares });
    const lookup = [...f.journal.records.values()].find(r => r.capability === inquiry)!;
    expect(lookup.state).toBe('failure');
    expect((await f.service.history('caller')).map(run => run.runId)).toEqual([runId]);
    expect(await f.service.get('caller', lookup.runId)).toMatchObject({ state: 'failure', inputs: undefined, result: undefined });
  }
  expect(f.replay).toHaveBeenCalledTimes(1);
});
