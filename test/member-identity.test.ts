import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/runtime/journal.js';
import { InvocationService } from '../src/server/service.js';
import * as runtime from '../src/runtime/run.js';
import { loadProfile } from '../src/runtime/profile.js';
import { Policy } from '../src/safety/policy.js';
import { Redactor } from '../src/safety/redact.js';
import type { ReplayResult } from '../src/replay/outcomes.js';

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
afterEach(async () => {
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
  async function start(principal: 'caller' | 'operator' = 'caller', role: 'TELLER' | 'SUPERVISOR' = 'TELLER') {
    const accepted = service.invoke(principal, balance, { member }, 'balance-request', role);
    releases[0]!(shares);
    await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(2));
    const lookup = [...journal.records.values()].find(r => r.capability === inquiry)!;
    return { ...accepted, lookup };
  }
  async function settle(runId: string) {
    await vi.waitFor(() => expect(service.get('operator', runId).memberIdentity?.status).not.toBe('pending'));
    return service.get('operator', runId);
  }
  return { service, journal, create, replay, releases, start, settle };
}

it('serializes the exact-member read under the same caller and role, with no replay on status or key reuse', async () => {
  const f = fixture();
  const accepted = f.service.invoke('operator', balance, { member }, 'balance-request', 'SUPERVISOR');
  expect(f.replay).toHaveBeenCalledTimes(1);
  expect(() => f.service.invoke('caller', inquiry, { searchMode: 'number', searchValue: member }, 'other')).toThrow('One run is active');
  f.releases[0]!(shares);
  await vi.waitFor(() => expect(f.replay).toHaveBeenCalledTimes(2));
  const lookup = [...f.journal.records.values()][1]!;
  expect(lookup.caller).toBe('operator');
  expect(f.create.mock.calls[1]![0]).toMatchObject({ artifact: inquiry,
    params: { searchMode: 'number', searchValue: member }, operator: { operator: 'SUPERVISOR', role: 'SUPERVISOR' } });
  expect(f.journal.findRequest('operator', `member-identity:${accepted.runId}`)?.runId).toBe(lookup.runId);
  expect(f.service.get('operator', accepted.runId).memberIdentity).toEqual({ status: 'pending', inquiryRunId: lookup.runId });
  expect(() => f.service.get('caller', accepted.runId)).toThrow('another principal');
  f.releases[1]!(identity());
  const run = await f.settle(accepted.runId);
  expect(run.memberIdentity).toEqual({ status: 'verified', inquiryRunId: lookup.runId, memberNumber: member, name });
  expect(run.result).toEqual(publicShares);
  expect(f.service.invoke('operator', balance, { member }, 'balance-request', 'SUPERVISOR')).toEqual({ ...accepted, reused: true });
  for (let i = 0; i < 3; i++) f.service.history('operator');
  expect(f.replay).toHaveBeenCalledTimes(2);
  const saved = readdirSync(f.journal.dir).filter(file => file.endsWith('.json')).map(file => readFileSync(join(f.journal.dir, file), 'utf8')).join('');
  for (const sensitive of [member, name, '1200.10', 'fixture-password']) expect(saved).not.toContain(sensitive);
  f.service.live.clear();
  expect(f.service.get('operator', accepted.runId)).toMatchObject({ sensitiveValuesUnavailable: true, memberIdentity: { status: 'unavailable' } });
  expect(f.service.invoke('operator', balance, { member }, 'balance-request', 'SUPERVISOR').reused).toBe(true);
  expect(f.replay).toHaveBeenCalledTimes(2);
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
  f.releases[1]!(result);
  if (change === 'withheld') f.service.live.delete(lookup.runId);
  const run = await f.settle(runId);
  expect(run.memberIdentity).toEqual({ status: 'unavailable', inquiryRunId: lookup.runId });
  expect(run.result).toEqual(publicShares);
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
  const { runId } = f.service.invoke('caller', balance, { member }, 'balance-request');
  const close = reason === 'shutdown' ? f.service.close() : undefined;
  f.releases[0]!(reason === 'failed balance' ? failure : shares);
  await close;
  expect((await f.settle(runId)).memberIdentity).toEqual({ status: 'unavailable', inquiryRunId: undefined });
  if (reason === 'lookup setup failure') {
    expect(f.service.get('caller', runId)).toMatchObject({ state: 'success', result: publicShares });
    expect([...f.journal.records.values()].find(r => r.capability === inquiry)?.state).toBe('failure');
  }
  expect(f.replay).toHaveBeenCalledTimes(1);
});
