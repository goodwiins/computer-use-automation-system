import { request as httpRequest, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { simulateReadableStream } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  callerPrincipal,
  canAccessRun,
  createAuthenticator,
  parseSubjectCredentials,
  principalKey,
  principalRole,
  type SubjectCredential,
  type SubjectPrincipal,
} from '../src/server/auth.js';
import { createApp } from '../src/server/http.js';
import { InvocationService } from '../src/server/service.js';
import { Journal } from '../src/runtime/journal.js';
import { loadProfile, profilePolicy } from '../src/runtime/profile.js';
import * as runtime from '../src/runtime/run.js';
import { Redactor } from '../src/safety/redact.js';
import { Approval } from '../src/runtime/approval.js';
import { ControlSession } from '../src/escalation/session.js';

const a = { subjectId: '11111111-1111-4111-8111-111111111111', role: 'caller' } as const;
const b = { subjectId: '22222222-2222-4222-8222-222222222222', role: 'caller' } as const;
const operator = { subjectId: '33333333-3333-4333-8333-333333333333', role: 'operator' } as const;
const aToken = 'a'.repeat(32), bToken = 'b'.repeat(32), operatorToken = 'o'.repeat(32);
const legacyCallerToken = 'c'.repeat(32), legacyOperatorToken = 'p'.repeat(32);
const credentials: SubjectCredential[] = [
  { ...a, token: aToken }, { ...b, token: bToken }, { ...operator, token: operatorToken },
];
const servers: Server[] = [];
const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

function makeService(withArtifact = false, allowlist = withArtifact ? ['hand-lookup-member-balance'] : []) {
  const dir = mkdtempSync(join(tmpdir(), 'subject-auth-'));
  const artifactDir = join(dir, 'artifacts');
  mkdirSync(artifactDir);
  if (withArtifact) writeFileSync(join(artifactDir, 'lookup.json'), readFileSync('test/fixtures/hand-lookup.json'));
  const journal = new Journal(join(dir, 'journal'), 'h'.repeat(64));
  const profile = loadProfile('cu-nexus');
  const service = new InvocationService(journal, profilePolicy(profile), profile, dir, allowlist, artifactDir);
  cleanup.push(async () => {
    await service.close();
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, journal, service };
}

async function start(service: InvocationService, model?: MockLanguageModelV3, localTellerLogin?: { teller: string; supervisor: string }) {
  const app = createApp(service, {
    callerToken: '', operatorToken: '', subjectTokens: credentials, localTellerLogin, port: 4180, chatModel: model,
  });
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP test server');
  return (path: string, token: string, options: { method?: string; body?: unknown; key?: string } = {}) =>
    new Promise<{ status: number; headers: Headers; text: string; json: any }>((resolve, reject) => {
      const req = httpRequest({
        hostname: '127.0.0.1', port: address.port, path, method: options.method ?? 'GET',
        headers: {
          Host: '127.0.0.1:4180', Authorization: `Bearer ${token}`,
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(options.key === undefined ? {} : { 'Idempotency-Key': options.key }),
        },
      }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown;
          try { json = JSON.parse(text); } catch { json = undefined; }
          resolve({ status: response.statusCode!, headers: new Headers(response.headers as Record<string, string>), text, json });
        });
      });
      req.on('error', reject);
      req.end(options.body === undefined ? undefined : JSON.stringify(options.body));
    });
}

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};
const finish = (reason: 'stop' | 'tool-calls') => ({ unified: reason, raw: reason });
function modelFor(toolName?: string, input: Record<string, unknown> = {}) {
  const content = toolName
    ? [{ type: 'tool-call' as const, toolCallId: 'call-1', toolName, input: JSON.stringify(input) }]
    : [{ type: 'text' as const, text: 'No operation.' }];
  return new MockLanguageModelV3({
    doGenerate: async () => ({ content, finishReason: finish(toolName ? 'tool-calls' : 'stop'), usage, warnings: [] }),
    doStream: async () => ({
      stream: simulateReadableStream({ chunks: [
        { type: 'stream-start', warnings: [] },
        ...(toolName ? [{ type: 'tool-call', toolCallId: 'call-1', toolName, input: JSON.stringify(input) }] : []),
        { type: 'finish', finishReason: finish(toolName ? 'tool-calls' : 'stop'), usage },
      ] }) as ReadableStream<never>,
    }),
  });
}

describe('subject authentication', () => {
  it('normalizes strict subject credentials and rejects malformed or duplicate configuration generically', () => {
    expect(parseSubjectCredentials(undefined)).toBeUndefined();
    expect(parseSubjectCredentials(JSON.stringify([{
      subjectId: a.subjectId.toUpperCase(), role: 'caller', token: aToken,
    }]))).toEqual([{ ...a, token: aToken }]);

    const invalid = [
      '', '[]', '{}', JSON.stringify([{ ...a, token: 'short' }]),
      JSON.stringify([{ ...a, token: aToken, extra: true }]),
      JSON.stringify([{ ...a, token: aToken }, { ...a, token: bToken }]),
      JSON.stringify([{ ...a, token: aToken }, { ...b, token: aToken }]),
      JSON.stringify([{ ...a, token: `${'x'.repeat(31)}\n` }]),
    ];
    for (const value of invalid) {
      expect(() => parseSubjectCredentials(value)).toThrow('Invalid subject credential configuration');
      try { parseSubjectCredentials(value); } catch (error) {
        expect(String(error)).not.toMatch(new RegExp(`${aToken}|${bToken}`));
      }
    }
  });

  it('authenticates rotated subject tokens without legacy fallback and preserves legacy mode otherwise', () => {
    const current = createAuthenticator({ callerToken: '', operatorToken: '', subjectTokens: credentials });
    expect(current(aToken)).toEqual(a);
    expect(current(legacyCallerToken)).toBeUndefined();

    const rotated = createAuthenticator({ callerToken: '', operatorToken: '', subjectTokens: [
      { ...a, token: 'r'.repeat(32) },
    ] });
    expect(rotated('r'.repeat(32))).toEqual(a);
    expect(rotated(aToken)).toBeUndefined();

    const legacy = createAuthenticator({ callerToken: legacyCallerToken, operatorToken: legacyOperatorToken });
    expect(legacy(legacyCallerToken)).toBe('caller');
    expect(legacy(legacyOperatorToken)).toBe('operator');
    expect(() => createAuthenticator({ callerToken: 'short', operatorToken: legacyOperatorToken })).toThrow('Configure two distinct API credentials');
  });

  it('separates authority from exact subject ownership', () => {
    expect(principalRole(a)).toBe('caller');
    expect(principalRole(operator)).toBe('operator');
    expect(principalKey(a)).toBe(`subject:${a.subjectId}`);
    expect(principalKey('operator')).toBe('operator');
    expect(canAccessRun(a, principalKey(a))).toBe(true);
    expect(canAccessRun({ ...a, role: 'operator' }, principalKey(a))).toBe(true);
    expect(canAccessRun(operator, principalKey(a))).toBe(false);
    expect(canAccessRun('operator', principalKey(a))).toBe(false);
    expect(canAccessRun('operator', 'caller')).toBe(true);
    expect(callerPrincipal({ ...a, role: 'operator' })).toEqual(a);
    expect(callerPrincipal('operator')).toBe('caller');
  });
});

it('applies exact subject ownership to run history, detail, approval projection, decisions, and legacy data', async () => {
  const { journal, service } = makeService();
  const own = journal.reserve(principalKey(a), 'same-key', 'lookup', '1.0.0', {});
  const foreign = journal.reserve(principalKey(b), 'same-key', 'lookup', '1.0.0', {});
  const legacy = journal.reserve('caller', 'legacy-key', 'lookup', '1.0.0', {});
  expect((await service.get(a, own.runId)).runId).toBe(own.runId);
  await expect(service.get(b, own.runId)).rejects.toThrow('another principal');
  expect((await service.history(a)).map(run => run.runId)).toEqual([own.runId]);
  expect((await service.history(b)).map(run => run.runId)).toEqual([foreign.runId]);
  await expect(service.get('operator', own.runId)).rejects.toThrow('another principal');
  expect((await service.get('operator', legacy.runId)).runId).toBe(legacy.runId);

  const session = new ControlSession();
  const approval = new Approval(session, () => {}, Date.now() + 60_000);
  const pending = approval.wait({ kind: 'replay_stuck', capability: 'lookup', goal: 'read', reason: 'stuck', url: 'https://example.test' });
  service.live.set(own.runId, { state: 'awaiting-human', inputs: {}, started: Date.now(), approval });
  expect((await service.get(a, own.runId)).intervention).toEqual({ kind: 'replay_stuck', awaitingOperator: true });
  const ownOperator: SubjectPrincipal = { ...a, role: 'operator' };
  expect((await service.get(ownOperator, own.runId)).intervention).toMatchObject({ id: approval.pending!.id });
  await expect(service.decide(a, own.runId, approval.pending!.id, 'abort')).rejects.toThrow('Only operators');
  await expect(service.decide({ ...b, role: 'operator' }, own.runId, approval.pending!.id, 'abort')).rejects.toThrow('another principal');
  await service.decide(ownOperator, own.runId, approval.pending!.id, 'abort');
  expect(await pending).toBe('abort');
});

it('authenticates subject HTTP requests and enforces ownership for history, detail, evidence, and direct invocation', async () => {
  vi.spyOn(runtime, 'createRuntime').mockReturnValue({
    surface: { mutationDispatched: false }, promptRedactor: new Redactor(),
  } as ReturnType<typeof runtime.createRuntime>);
  vi.spyOn(runtime, 'executeReplay').mockResolvedValue({
    status: 'success', outputs: { savingsBalance: 'safe' }, runId: 'fixture', evidenceDir: 'fixture', recoveries: [],
  });
  vi.spyOn(runtime, 'closeRuntime').mockResolvedValue();
  const { dir, journal, service } = makeService(true);
  const own = journal.reserve(principalKey(a), 'seed-a', 'lookup', '1.0.0', {});
  const foreign = journal.reserve(principalKey(b), 'seed-b', 'lookup', '1.0.0', {});
  const evidenceDir = join(dir, own.runId);
  mkdirSync(evidenceDir);
  writeFileSync(join(evidenceDir, 'safe.json'), '{"safe":true}');
  const request = await start(service);

  expect(await request('/capabilities', aToken)).toMatchObject({
    status: 200, json: { principal: 'caller', subjectId: a.subjectId },
  });
  expect((await request('/runs', aToken)).json.map((run: { runId: string }) => run.runId)).toEqual([own.runId]);
  expect((await request(`/runs/${own.runId}`, aToken)).status).toBe(200);
  expect((await request(`/runs/${foreign.runId}`, aToken)).status).toBe(403);
  expect((await request(`/runs/${own.runId}/evidence/safe.json`, aToken)).text).toBe('{"safe":true}');
  expect((await request(`/runs/${own.runId}/evidence/safe.json`, bToken)).status).toBe(403);
  expect((await request('/capabilities', legacyCallerToken)).status).toBe(401);

  for (const [token, owner] of [[aToken, principalKey(a)], [bToken, principalKey(b)]] as const) {
    const response = await request('/capabilities/hand-lookup-member-balance/invoke', token, {
      method: 'POST', key: 'same-direct-key', body: { args: { memberId: '123' } },
    });
    expect(response.status).toBe(202);
    await vi.waitFor(() => expect(journal.records.get(response.json.runId)?.state).toBe('success'));
    expect(journal.records.get(response.json.runId)?.caller).toBe(owner);
  }
});

it('disables local teller login when subject credentials are configured', async () => {
  const { service } = makeService();
  const request = await start(service, undefined, { teller: 'TELLER1', supervisor: 'SUPER1' });
  expect(await request('/session/options', aToken)).toMatchObject({ status: 200, json: { localTellerLogin: null } });
  expect(await request('/session/teller', aToken, { method: 'POST', body: {} })).toMatchObject({
    status: 404, json: { error: 'Local teller login is disabled' },
  });
  expect((await request('/capabilities', aToken)).status).toBe(200);
});

it.each(['/chat', '/api/chat'])('keeps operator subject ownership with caller-only authority in %s', async route => {
  vi.spyOn(runtime, 'createRuntime').mockReturnValue({
    surface: { mutationDispatched: false }, promptRedactor: new Redactor(),
  } as ReturnType<typeof runtime.createRuntime>);
  vi.spyOn(runtime, 'executeReplay').mockResolvedValue({
    status: 'success', outputs: { savingsBalance: 'safe' }, runId: 'fixture', evidenceDir: 'fixture', recoveries: [],
  });
  vi.spyOn(runtime, 'closeRuntime').mockResolvedValue();
  const { journal, service } = makeService(true);
  const model = modelFor('hand-lookup-member-balance', { memberId: '123' });
  const request = await start(service, model);
  const body = route === '/chat'
    ? { messages: [{ role: 'user', content: 'Look up member 123' }] }
    : { messages: [{ id: 'request', role: 'user', parts: [{ type: 'text', text: 'Look up member 123' }] }] };
  const response = await request(route, operatorToken, { method: 'POST', key: `key-${route}`, body });
  expect(response.status).toBe(route === '/chat' ? 202 : 200);
  await vi.waitFor(() => expect([...journal.records.values()].at(-1)?.state).toBe('success'));
  expect([...journal.records.values()].at(-1)?.caller).toBe(principalKey(operator));
});

it.each(['/chat', '/api/chat'])('demotes operator subjects to caller capability authority in %s', async route => {
  const { journal, service } = makeService(true, []);
  expect(service.catalog(operator).map(capability => capability.id)).toContain('hand-lookup-member-balance');
  const request = await start(service, modelFor('hand-lookup-member-balance', { memberId: '123' }));
  const body = route === '/chat'
    ? { messages: [{ role: 'user', content: 'Look up member 123' }] }
    : { messages: [{ id: 'request', role: 'user', parts: [{ type: 'text', text: 'Look up member 123' }] }] };
  const response = await request(route, operatorToken, { method: 'POST', key: `demote-${route}`, body });
  expect(response).toMatchObject({ status: 409, json: { error: 'No approved caller capabilities are available' } });
  expect(journal.records.size).toBe(0);
});

it('binds subject-owned status aliases and reconstructs only that subject old-message history', async () => {
  const { journal, service } = makeService(true);
  const own = journal.reserve(principalKey(operator), 'original', 'hand-lookup-member-balance', '1.0.0', {});
  journal.update(own.runId, 'success');
  const statusModel = modelFor('run_status', { runId: own.runId });
  const statusRequest = await start(service, statusModel);
  const status = await statusRequest('/chat', operatorToken, {
    method: 'POST', key: 'status-alias', body: { intent: 'status', messages: [{ role: 'user', content: 'Status?' }] },
  });
  expect(status.status).toBe(200);
  expect(journal.findRequest(principalKey(operator), 'status-alias')?.runId).toBe(own.runId);
  expect(journal.findRequest('caller', 'status-alias')).toBeUndefined();

  let ownPrompt = '', foreignPrompt = '';
  const historyModel = modelFor();
  historyModel.doStream = vi.fn(async options => {
    if (!ownPrompt) ownPrompt = JSON.stringify(options.prompt); else foreignPrompt = JSON.stringify(options.prompt);
    return { stream: simulateReadableStream({ chunks: [
      { type: 'stream-start', warnings: [] }, { type: 'finish', finishReason: finish('stop'), usage },
    ] }) as ReadableStream<never> };
  });
  const historyRequest = await start(service, historyModel);
  const body = { intent: 'status', messages: [
    { id: 'status-alias', role: 'user', parts: [{ type: 'text', text: 'PRIVATE_OLD_REQUEST' }] },
    { id: 'latest', role: 'user', parts: [{ type: 'text', text: 'Did it finish?' }] },
  ] };
  expect((await historyRequest('/api/chat', operatorToken, { method: 'POST', key: 'latest-own', body })).status).toBe(200);
  expect((await historyRequest('/api/chat', bToken, { method: 'POST', key: 'latest-foreign', body })).status).toBe(200);
  expect(ownPrompt).toContain(own.runId);
  expect(ownPrompt).not.toContain('PRIVATE_OLD_REQUEST');
  expect(foreignPrompt).not.toContain(own.runId);
  expect(foreignPrompt).not.toContain('PRIVATE_OLD_REQUEST');
});

it('recovers an accepted chat request by its original subject key without executing work', async () => {
  const { journal, service } = makeService();
  const own = journal.reserve(principalKey(a), 'recover-direct', 'lookup', '1.0.0', {});
  journal.update(own.runId, 'success');
  const unknown = journal.reserve(principalKey(a), 'recover-unknown', 'lookup', '1.0.0', {});
  journal.update(unknown.runId, 'dispatching');
  journal.update(unknown.runId, 'failure');
  const alias = journal.bindReference(principalKey(a), 'recover-alias', own.runId);
  expect(alias).toBeUndefined();
  const operatorSubjectRun = journal.reserve(principalKey(operator), 'recover-operator-subject', 'lookup', '1.0.0', {});
  journal.update(operatorSubjectRun.runId, 'success');
  const legacyOperatorRun = journal.reserve('operator', 'recover-legacy-operator', 'lookup', '1.0.0', {});
  journal.update(legacyOperatorRun.runId, 'success');
  const foreign = journal.reserve(principalKey(b), 'recover-foreign', 'lookup', '1.0.0', {});
  journal.update(foreign.runId, 'success');

  const invoke = vi.spyOn(service, 'invoke');
  const bindReference = vi.spyOn(journal, 'bindReference');
  const request = await start(service);

  const direct = await request('/api/chat/request', aToken, { key: 'recover-direct' });
  expect(direct.status).toBe(200);
  expect(direct.json).toEqual({ kind: 'run', runId: own.runId, capability: 'lookup', state: 'success' });
  expect(direct.headers.get('cache-control')).toContain('no-store');

  const statusAlias = await request('/api/chat/request', aToken, { key: 'recover-alias' });
  expect(statusAlias).toMatchObject({
    status: 200,
    json: { kind: 'run', runId: own.runId, capability: 'lookup', state: 'success' },
  });
  const unknownResponse = await request('/api/chat/request', aToken, { key: 'recover-unknown' });
  expect(unknownResponse).toMatchObject({
    status: 200,
    json: { kind: 'run', runId: unknown.runId, capability: 'lookup', state: 'POST_OUTCOME_UNKNOWN' },
  });

  // Operator authority is demoted to the caller role while retaining its subject identity.
  expect(await request('/api/chat/request', operatorToken, { key: 'recover-operator-subject' })).toMatchObject({
    status: 200,
    json: { kind: 'run', runId: operatorSubjectRun.runId },
  });
  expect((await request('/api/chat/request', operatorToken, { key: 'recover-legacy-operator' })).status).toBe(404);
  expect((await request('/api/chat/request', aToken, { key: 'recover-foreign' })).status).toBe(404);
  expect((await request('/api/chat/request', aToken, { key: 'recover-missing' })).status).toBe(404);
  expect((await request('/api/chat/request', aToken)).status).toBe(400);

  const findRequest = vi.spyOn(journal, 'findRequest').mockImplementation(() => { throw new Error('PRIVATE storage failure'); });
  const unavailable = await request('/api/chat/request', aToken, { key: 'recover-direct' });
  expect(unavailable.status).toBe(503);
  expect(unavailable.text).not.toContain('PRIVATE storage failure');
  expect(invoke).not.toHaveBeenCalled();
  expect(bindReference).not.toHaveBeenCalled();
  expect(findRequest).toHaveBeenCalledOnce();
});

it('keeps lookupOnly subject recovery exact across UNKNOWN, changed facts, and foreign subjects', async () => {
  const { journal, service } = makeService(true);
  const request = {
    mode: 'replay', capability: 'hand-lookup-member-balance', version: '1.0.0',
    args: { memberId: '123' }, context: null,
  };
  const accepted = journal.reserve(principalKey(a), 'lookup-only-subject', 'hand-lookup-member-balance', '1.0.0', request);
  journal.update(accepted.runId, 'dispatching');
  journal.update(accepted.runId, 'failure');
  const before = journal.records.size;
  const create = vi.spyOn(runtime, 'createRuntime');

  expect(await service.invoke(a, 'hand-lookup-member-balance', { memberId: '123' }, 'lookup-only-subject', 'TELLER', true))
    .toEqual({ runId: accepted.runId, reused: true });
  await expect(service.invoke(a, 'hand-lookup-member-balance', { memberId: '124' }, 'lookup-only-subject', 'TELLER', true))
    .rejects.toThrow(/another request/);
  await expect(service.invoke(b, 'hand-lookup-member-balance', { memberId: '123' }, 'lookup-only-subject', 'TELLER', true))
    .rejects.toThrow(/No accepted request/);
  await expect(service.invoke(a, 'hand-lookup-member-balance', { memberId: '123' }, 'missing-lookup-only', 'TELLER', true))
    .rejects.toThrow(/No accepted request/);
  expect(journal.records.size).toBe(before);
  expect(create).not.toHaveBeenCalled();
});
