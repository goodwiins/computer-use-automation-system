import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import * as discovery from '../src/agent/loop.js';
import * as client from '../src/agent/client.js';
import * as runtime from '../src/runtime/run.js';
import { Journal } from '../src/runtime/journal.js';
import { loadProfile, profilePolicy } from '../src/runtime/profile.js';
import { Redactor } from '../src/safety/redact.js';
import { RunLogger } from '../src/evidence/logger.js';
import { InvocationService } from '../src/server/service.js';
import { createApp } from '../src/server/http.js';
import { meridianContracts } from '../src/runtime/contracts.js';
import type { ActionContext } from '../src/runtime/approval.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
const id = 'meridian-place-hold';
const args = { member: '9001', share: '9001-S0001-1', reason: 'FRAUD', notes: 'fixture hold notes' };
const context = { operator: 'FIXTURE-SUPER', password: 'fixture-private-password', branch: 'MAIN-001', role: 'SUPERVISOR' as const };
const origin = 'https://web-sample.interface-hiring.com';
const stopped = (): discovery.DiscoveryResult => ({ status: 'stopped', trace: [], outputs: {}, finalUrl: `${origin}/menu` });
function successful(input = args): discovery.DiscoveryResult {
  const trace: discovery.TraceEntry[] = Object.entries({ operator: '{{operator}}', password: '{{password}}', branch: '{{branch}}', ...input }).map(([name, value]) => ({
    action: name === 'branch' || name === 'reason' ? 'select' : 'fill', reason: `Set ${name}`, value,
    descriptor: { description: name, strategies: [{ kind: 'nameAttr', name }] }, urlAfter: `${origin}/hold`,
  }));
  trace.push(
    { action: 'click', reason: 'Apply reviewed hold', risk: 'irreversible', descriptor: { description: 'Apply Hold', strategies: [{ kind: 'nameAttr', name: 'submit' }] }, urlAfter: `${origin}/hold/complete` },
    { action: 'assert', reason: 'Verify hold', assert: { kind: 'textVisible', text: 'HOLD APPLIED' }, urlAfter: `${origin}/hold/complete` },
    { action: 'extract', reason: 'Read held share', outputName: 'heldShare', descriptor: { description: 'Held share', strategies: [{ kind: 'nameAttr', name: 'heldShare' }] }, urlAfter: `${origin}/hold/complete` },
  );
  return { status: 'success', trace, outputs: { heldShare: args.share }, summary: 'private model summary', finalUrl: `${origin}/hold/complete` };
}
function fixture(profileName = 'meridian') {
  for (const role of ['TELLER', 'SUPERVISOR']) {
    vi.stubEnv(`MERIDIAN_${role}_OPERATOR`, context.operator);
    vi.stubEnv(`MERIDIAN_${role}_PASSWORD`, context.password);
  }
  vi.stubEnv('MERIDIAN_BRANCH', context.branch);
  const dir = mkdtempSync(join(tmpdir(), 'server-discovery-'));
  const artifactDir = join(dir, 'artifacts'); mkdirSync(artifactDir);
  const journal = new Journal(join(dir, 'journal'), 'discovery-test-key-with-at-least-32-characters');
  const profile = loadProfile(profileName);
  const service = new InvocationService(journal, profilePolicy(profile), profile, join(dir, 'evidence'), [id], artifactDir);
  cleanup.push(() => { journal.close(); rmSync(dir, { recursive: true, force: true }); });
  cleanup.push(() => service.close());
  const llm = vi.spyOn(client, 'makeLLMClient').mockReturnValue({ openai: {} as ReturnType<typeof client.makeLLMClient>['openai'], model: 'offline-test' });
  const run = vi.spyOn(discovery, 'runDiscovery').mockResolvedValue(stopped());
  let options!: Parameters<typeof runtime.createRuntime>[0];
  let active!: ReturnType<typeof runtime.createRuntime>;
  const close = vi.fn(async () => { options.onClose?.(); });
  const construct = vi.spyOn(runtime, 'createRuntime').mockImplementation(input => {
    options = input;
    const redactor = new Redactor(); redactor.addSensitiveValues(input.sensitive.map(name => input.params[name]!));
    const promptRedactor = new Redactor(); promptRedactor.addSensitiveValues([context.password]);
    active = {
      surface: { currentUrl: () => `${origin}/hold/review`, currentStep: 'post', mutationDispatched: false },
      browser: { page: {} }, logger: new RunLogger('discovery', redactor, input.evidenceDir, true, input.runId),
      redactor, promptRedactor, session: input.session, cleanupFailed: false, close, validateCompletion: vi.fn(),
    } as unknown as ReturnType<typeof runtime.createRuntime>;
    return active;
  });
  const start = (key = 'hold-key', input = args) => service.discover('operator', id, input, key, 'SUPERVISOR');
  const settle = async (runId: string) => { await vi.waitFor(() => expect(service.live.get(runId)?.finished).toBeDefined()); return service.get('operator', runId); };
  return { dir, artifactDir, journal, service, llm, run, construct, close, start, settle, options: () => options, active: () => active };
}

it('rejects caller discovery, noncanonical goals, non-MERIDIAN profiles, server parameters and implicit hold roles before runtime or model access', async () => {
  const f = fixture();
  await expect(f.service.discover('caller', id, args, 'caller', 'SUPERVISOR')).rejects.toMatchObject({ status: 403 });
  for (const capability of ['meridian-open-share', 'meridian-sign-on', '../../evil']) await expect(f.service.discover('operator', capability, args, 'bad-id')).rejects.toMatchObject({ status: 404 });
  await expect(f.service.discover('operator', id, args, 'no-role')).rejects.toMatchObject({ status: 403 });
  for (const name of ['operator', 'password', 'branch', 'goal', 'entryUrl']) await expect(f.start(name, { ...args, [name]: 'untrusted' })).rejects.toMatchObject({ status: 400 });
  await expect(f.start('invalid', { ...args, reason: 'UNREVIEWED' })).rejects.toMatchObject({ status: 400 });
  expect(f.construct).not.toHaveBeenCalled(); expect(f.llm).not.toHaveBeenCalled(); expect(f.journal.list()).toEqual([]);
  const generic = fixture('cu-nexus');
  await expect(generic.start()).rejects.toMatchObject({ status: 404 });
});

it('binds fixed goals and server references, saves only a private validated draft, and recovers across credential drift without runtime/model work', async () => {
  const f = fixture(); f.run.mockResolvedValue(successful());
  const accepted = await f.start(); const run = await f.settle(accepted.runId);
  expect(run).toMatchObject({ kind: 'discovery', state: 'success', result: { outputs: { heldShare: args.share } } });
  expect(f.run.mock.calls[0]![0]).toContain('explicit fill operator');
  expect(f.run.mock.calls[0]![0]).not.toContain(args.notes);
  expect(f.run.mock.calls[0]![2]).toEqual({ ...args, operator: '{{operator}}', password: '{{password}}', branch: '{{branch}}' });
  expect(f.run.mock.calls[0]![4]).toMatchObject({ boundParams: { operator: context.operator, password: context.password, branch: context.branch }, detectors: f.service.profile.detectors, validateCompletion: f.active().validateCompletion });
  expect(f.options().params).toEqual({ ...args, operator: context.operator, password: context.password, branch: context.branch });
  const path = join(f.artifactDir, 'drafts', `${accepted.runId}.json`);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(join(f.artifactDir, 'drafts')).mode & 0o777).toBe(0o700);
  const raw = readFileSync(path, 'utf8'); const artifact = JSON.parse(raw);
  expect(artifact.status).toBe('draft');
  for (const value of [args.member, args.share, args.notes, context.password, context.operator, context.branch, 'private model summary']) expect(raw).not.toContain(value);
  expect(artifact.parameters.find((p: { name: string }) => p.name === 'password')).toMatchObject({ sensitive: true, source: 'server' });
  expect(f.service.catalog('operator')).toEqual([]); expect(readdirSync(f.artifactDir)).toEqual(['drafts']);
  expect(run.evidence).not.toContain(`${accepted.runId}.json`);
  expect(await f.start()).toEqual({ runId: accepted.runId, reused: true });
  vi.stubEnv('MERIDIAN_SUPERVISOR_PASSWORD', '');
  expect(await f.service.discover('operator', id, args, 'hold-key', 'SUPERVISOR', true)).toEqual({ runId: accepted.runId, reused: true });
  await expect(f.service.discover('operator', id, { ...args, notes: 'changed' }, 'hold-key', 'SUPERVISOR', true)).rejects.toMatchObject({ status: 409 });
  await expect(f.service.discover('operator', id, args, 'missing', 'SUPERVISOR', true)).rejects.toMatchObject({ status: 404 });
  expect(f.construct).toHaveBeenCalledOnce(); expect(f.llm).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalled();
});

it('records valid notes matching trusted capability metadata without quarantining the verified post', async () => {
  const f = fixture(); const input = { ...args, notes: 'hold' };
  f.run.mockImplementation(async () => {
    await f.options().beforeDispatch!({} as ActionContext);
    return successful(input);
  });
  const accepted = await f.start('common-note', input);
  expect(await f.settle(accepted.runId)).toMatchObject({ state: 'success', result: { outputs: { heldShare: input.share } } });
  const artifact = JSON.parse(readFileSync(join(f.artifactDir, 'drafts', `${accepted.runId}.json`), 'utf8'));
  expect(artifact).toMatchObject({ id, name: id, status: 'draft' });
  expect(artifact.steps.find((step: { target?: { description: string } }) => step.target?.description === 'notes').value).toBe('{{notes}}');
  expect(f.journal.hasUnknown(id)).toBe(false);
});

it('keeps owner/key identity shared across discovery and replay including both lookup directions and legacy replay records', async () => {
  const f = fixture(); const accepted = await f.start(); await f.settle(accepted.runId);
  for (const lookupOnly of [false, true]) await expect(f.service.invoke('operator', id, args, 'hold-key', 'SUPERVISOR', lookupOnly)).rejects.toMatchObject({ status: 409 });
  const replay = f.journal.reserve('operator', 'replay-key', id, '1.0.0', {}, 'replay'); f.journal.update(replay.runId, 'failure');
  for (const lookupOnly of [false, true]) await expect(f.service.discover('operator', id, args, 'replay-key', 'SUPERVISOR', lookupOnly)).rejects.toMatchObject({ status: 409 });
  const other = { role: 'operator' as const, subjectId: randomUUID() };
  await expect(f.service.discover(other, id, args, 'hold-key', 'SUPERVISOR', true)).rejects.toMatchObject({ status: 404 });
  expect(f.construct).toHaveBeenCalledOnce();
});

it('refuses fresh discovery for unknown outcomes and approved recordings while keeping historical unknown lookups immutable', async () => {
  const f = fixture();
  f.run.mockImplementation(async () => { await f.options().beforeDispatch!({} as ActionContext); return stopped(); });
  const accepted = await f.start(); expect((await f.settle(accepted.runId)).state).toBe('POST_OUTCOME_UNKNOWN');
  expect((await f.service.availability('operator')).find(item => item.id === id))
    .toMatchObject({ state: 'temporarily_unavailable', reason: 'Outcome requires read-only investigation' });
  expect((await f.service.availability('caller')).find(item => item.id === id))
    .toMatchObject({ state: 'temporarily_unavailable', reason: 'Outcome requires read-only investigation' });
  expect(existsSync(join(f.artifactDir, 'drafts'))).toBe(false);
  await expect(f.start('new')).rejects.toMatchObject({ status: 409 });
  expect(await f.service.discover('operator', id, args, 'hold-key', 'SUPERVISOR', true)).toEqual({ runId: accepted.runId, reused: true });
  expect(f.journal.get(accepted.runId)?.state).toBe('POST_OUTCOME_UNKNOWN');
  expect(f.construct).toHaveBeenCalledOnce();
  const g = fixture(); g.llm.mockClear(); g.service.artifacts.set(id, {} as never);
  await expect(g.start()).rejects.toMatchObject({ status: 409 }); expect(g.llm).not.toHaveBeenCalled();
});

it('shares the replay busy slot and exposes exact native facts for one current approval only', async () => {
  const f = fixture(); let gateResult: boolean | undefined;
  let native!: ActionContext;
  f.run.mockImplementation(async () => {
    native = { runId: f.options().runId!, artifact: id, version: '1.0.0', stepId: 'post', destination: `${origin}/hold/post`, method: 'POST', operator: context.operator, role: context.role, branch: context.branch, facts: { hidden: 'private native field' }, visibleFacts: { share: args.share, reason: args.reason }, businessValues: [args.share], tokenPresent: true, control: 'Apply Hold' };
    gateResult = await f.options().gate('click', 'irreversible', 'Native hold approval', native); return stopped();
  });
  const accepted = await f.start(); const run = await f.service.get('operator', accepted.runId);
  expect(run.state).toBe('awaiting-human');
  expect((await f.service.availability('operator')).find(item => item.id === 'meridian-funds-transfer')).toMatchObject({ state: 'temporarily_unavailable', reason: 'Another operation is active' });
  expect(run.intervention).toMatchObject({ action: { runId: accepted.runId, artifact: id, version: '1.0.0', facts: { share: args.share, reason: args.reason } } });
  expect(JSON.stringify(run)).not.toContain('private native field');
  expect(f.service.live.get(accepted.runId)!.approval.pending!.action).toBe(native);
  await expect(f.start('busy')).rejects.toMatchObject({ status: 429 });
  // A valid approved replay also uses the same active slot.
  f.service.artifacts.set('meridian-sign-on', JSON.parse(readFileSync('artifacts/meridian-sign-on.v1.0.0.json', 'utf8')));
  await expect(f.service.invoke('operator', 'meridian-sign-on', {}, 'replay-busy')).rejects.toMatchObject({ status: 429 });
  const approvalId = f.service.live.get(accepted.runId)!.approval.pending!.id;
  await expect(f.service.decide('caller', accepted.runId, approvalId, 'approve')).rejects.toMatchObject({ status: 403 });
  await expect(f.service.decide('operator', accepted.runId, randomUUID(), 'approve')).rejects.toMatchObject({ status: 409 });
  await f.service.decide('operator', accepted.runId, approvalId, 'approve'); await f.settle(accepted.runId);
  expect(gateResult).toBe(true);
  await expect(f.service.decide('operator', accepted.runId, approvalId, 'approve')).rejects.toMatchObject({ status: 409 });
});

it.each(['stopped', 'escalated', 'business_outcome', 'throw', 'intent-write-fails'] as const)('quarantines %s after dispatch intent even before a mutation dispatch flag', async mode => {
  const f = fixture(); const update = f.journal.update.bind(f.journal);
  if (mode === 'intent-write-fails') vi.spyOn(f.journal, 'update').mockImplementation((runId, state) => { if (state === 'dispatching') throw new Error('durability failed'); return update(runId, state); });
  f.run.mockImplementation(async () => {
    await f.options().beforeDispatch!({} as ActionContext);
    if (mode === 'throw') throw new Error('private failure');
    return { ...stopped(), status: mode === 'intent-write-fails' ? 'stopped' : mode, outcomeCode: 'INSUFFICIENT_FUNDS', detail: context.password };
  });
  const accepted = await f.start(); const result = await f.settle(accepted.runId);
  expect(result).toMatchObject({ state: 'POST_OUTCOME_UNKNOWN', result: { failure: { code: 'POST_OUTCOME_UNKNOWN' } } });
  expect(existsSync(join(f.artifactDir, 'drafts'))).toBe(false); expect(f.close).toHaveBeenCalled();
});

it.each(['privacy', 'write', 'contract'] as const)('quarantines %s recording failures without creating an executable artifact', async mode => {
  const f = fixture();
  f.run.mockImplementation(async () => {
    await f.options().beforeDispatch!({} as ActionContext);
    const result = successful();
    if (mode === 'privacy') {
      f.active().redactor.addSensitiveValues(['Unrelated\nPrivate Member']);
      result.trace[0]!.reason = 'Unrelated\nPrivate Member';
    }
    if (mode === 'contract') result.trace = result.trace.filter(step => step.action !== 'assert');
    if (mode === 'write') writeFileSync(join(f.artifactDir, 'drafts'), 'block directory');
    return result;
  });
  const accepted = await f.start(); const result = await f.settle(accepted.runId);
  expect(result.state).toBe('POST_OUTCOME_UNKNOWN'); expect(f.service.catalog('operator')).toEqual([]);
  expect(existsSync(join(f.artifactDir, 'drafts', `${accepted.runId}.json`))).toBe(false);
  expect(JSON.stringify(result)).not.toContain('Unrelated Private Member');
});

it('cancels live approval and drains discovery on shutdown; failed cleanup fences new admission', async () => {
  const f = fixture(); let gateResult: boolean | undefined;
  f.run.mockImplementation(async () => { gateResult = await f.options().gate('click', 'irreversible', 'review'); return stopped(); });
  const accepted = await f.start(); await f.service.close();
  expect(gateResult).toBe(false); expect((await f.service.get('operator', accepted.runId)).state).toBe('failure');
  await expect(f.start('closing')).rejects.toMatchObject({ status: 503 });
  const g = fixture(); g.close.mockRejectedValue(new Error('cleanup failed'));
  const other = await g.start(); await g.settle(other.runId);
  expect(g.service.cleanupFailedState).toBe(true);
  await expect(g.start('fenced')).rejects.toMatchObject({ status: 503 });
  expect(await g.start()).toEqual({ runId: other.runId, reused: true });
});

it('returns only known pre-dispatch business codes and safe text, and releases failed runtime setup', async () => {
  const f = fixture(); f.run.mockResolvedValue({ ...stopped(), status: 'business_outcome', outcomeCode: 'NO_SUCH_MEMBER', detail: context.password });
  const accepted = await f.start(); const run = await f.settle(accepted.runId);
  expect(run).toMatchObject({ state: 'business_outcome', result: { outcomeCode: 'NO_SUCH_MEMBER' } });
  expect(JSON.stringify(run)).not.toContain(context.password);
  f.construct.mockImplementation(() => { throw new Error('setup failed'); });
  await expect(f.start('setup1')).rejects.toThrow('setup failed');
  await expect(f.start('setup2')).rejects.toThrow('setup failed');
  expect(f.journal.list().map(record => record.state)).toEqual(['business_outcome', 'failure', 'failure']);
});

it('authenticates strict discovery HTTP admission and exposes canonical form metadata separately from approved tools', async () => {
  const f = fixture();
  const server = createServer().listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('missing address');
  server.on('request', createApp(f.service, { callerToken: 'c'.repeat(32), operatorToken: 'o'.repeat(32), port: address.port }));
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { Authorization: `Bearer ${'o'.repeat(32)}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'http-key' };
  const post = (body: unknown, custom = headers) => fetch(`${base}/capabilities/${id}/discover`, { method: 'POST', headers: custom, body: JSON.stringify(body) });
  expect((await post({ args, operator: 'SUPERVISOR' }, { ...headers, Authorization: `Bearer ${'c'.repeat(32)}` })).status).toBe(403);
  for (const extra of [{ goal: 'arbitrary goal' }, { entryUrl: origin }, { lookupOnly: false }, { profile: 'other' }]) expect((await post({ args, operator: 'SUPERVISOR', ...extra })).status).toBe(400);
  const response = await post({ args, operator: 'SUPERVISOR' }); expect(response.status).toBe(202);
  const accepted = await response.json() as { runId: string }; await f.settle(accepted.runId);
  const recovered = await post({ args, operator: 'SUPERVISOR', lookupOnly: true }); expect(recovered.status).toBe(202); expect(await recovered.json()).toEqual({ ...accepted, reused: true });
  const metadata = await (await fetch(`${base}/capabilities`, { headers })).json() as { capabilities: unknown[]; operationContracts: Array<{ id: string; parameters: unknown[]; discovery: boolean }> };
  expect(metadata.capabilities).toEqual([]);
  expect(metadata.operationContracts).toHaveLength(4);
  expect(metadata.operationContracts.find(value => value.id === id)).toEqual({ id, parameters: meridianContracts[id].parameters, discovery: true });
  expect(metadata.operationContracts.find(value => value.id === 'meridian-open-share')!.discovery).toBe(false);
  expect(JSON.stringify(metadata)).not.toContain(context.password);
});

it('forwards the runtime transfer completion validator to discovery', async () => {
  const f = fixture();
  let forwarded: unknown;
  const input = { member: '9001', sourceShare: '9001-S001', destinationShare: '9001-S002', amount: '25.00', memo: 'fixture transfer' };
  f.run.mockImplementation(async (_goal, _url, _params, _origins, options) => {
    forwarded = options!.validateCompletion;
    Object.assign(f.active().surface, { mutationDispatched: true });
    return stopped();
  });
  const accepted = await f.service.discover('operator', 'meridian-funds-transfer', input, 'transfer-dispatch');
  expect((await f.settle(accepted.runId)).state).toBe('POST_OUTCOME_UNKNOWN');
  expect(f.run).toHaveBeenCalledOnce();
  expect(forwarded).toBe(f.active().validateCompletion);
});
