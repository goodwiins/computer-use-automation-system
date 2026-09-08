import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import * as runtime from '../src/runtime/run.js';
import * as discovery from '../src/agent/loop.js';
import * as client from '../src/agent/client.js';
import { Journal, RequestError } from '../src/runtime/journal.js';
import { loadProfile, profilePolicy } from '../src/runtime/profile.js';
import { Redactor } from '../src/safety/redact.js';
import { RunLogger } from '../src/evidence/logger.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/http.js';
import { InvocationService } from '../src/server/service.js';

const realNow = Date.now;
let clockOffset = 0;
const nextLogin = () => { clockOffset += 1100; };
const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  clockOffset = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + clockOffset);
  vi.stubEnv('MERIDIAN_SUPERVISOR_OPERATOR', 'SUPER1');
  vi.stubEnv('MERIDIAN_SUPERVISOR_PASSWORD', 'offline-supervisor-password');
  vi.stubEnv('MERIDIAN_BRANCH', 'MAIN');
});
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function fixture(enabled = true, actualService?: InvocationService) {
  const state = { run: { runId: 'sign-on', capability: 'meridian-sign-on', state: 'running', result: undefined as any } };
  const service = { invoke: vi.fn(() => ({ runId: 'sign-on' })), get: vi.fn(() => state.run), catalog: () => [], history: vi.fn(async () => [] as any[]), profile: { appId: 'meridian', entryUrl: 'https://offline.invalid' } };
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  server.on('request', createApp(actualService ?? service as unknown as InvocationService, { port, callerToken: 'c'.repeat(32), operatorToken: 'o'.repeat(32),
    localTellerLogin: enabled ? { teller: 'TELLER1', supervisor: 'SUPER1' } : undefined }));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const login = (body: unknown = { operator: 'SUPER1', password: 'offline-supervisor-password' }, requestOrigin: string | undefined = origin) =>
    fetch(origin + '/session/supervisor', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(requestOrigin ? { Origin: requestOrigin } : {}) }, body: JSON.stringify(body) });
  return { login, origin, state, service };
}
it('keeps supervisor password login local-only and rejects wrong credentials before invoking a browser', async () => {
  const disabled = await fixture(false);
  expect((await disabled.login()).status).toBe(404);
  const { login, service } = await fixture();
  expect((await login(undefined, '')).status).toBe(403);
  expect((await login(undefined, 'http://foreign.invalid')).status).toBe(403);
  const denied = await login({ operator: 'SUPER1', password: 'wrong' });
  expect(denied.status).toBe(401);
  expect(await denied.text()).not.toContain('token');
  expect((await login()).status).toBe(429);
  expect(service.invoke).not.toHaveBeenCalled();
});
it('issues a separate dashboard credential only after the target confirms supervisor identity, role, and branch', async () => {
  const { login, state, service, origin } = await fixture();
  const pending = login();
  await vi.waitFor(() => expect(service.invoke).toHaveBeenCalledTimes(1));
  expect((await login()).status).toBe(429);
  expect(service.invoke.mock.calls[0]).toEqual(['operator', 'meridian-sign-on', {}, expect.any(String), 'SUPERVISOR']);
  state.run.state = 'success';
  state.run.result = { status: 'success', outputs: { operator: 'SUPER1', role: 'SUPERVISOR', branch: 'MAIN' } };
  const response = await pending;
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ operator: 'SUPER1', role: 'SUPERVISOR', branch: 'MAIN', token: expect.any(String) });
  expect(body.token).not.toBe('o'.repeat(32));
  expect(JSON.stringify(body)).not.toContain('offline-supervisor-password');
  const authenticated = await fetch(origin + '/capabilities', { headers: { Authorization: `Bearer ${body.token}` } });
  expect(authenticated.status).toBe(200);
  expect((await authenticated.json()).principal).toBe('operator');
});
it.each(['failure', 'wrong-role', 'wrong-operator', 'wrong-branch'])('does not grant dashboard access for target %s', async outcome => {
  const { login, state } = await fixture();
  state.run.state = outcome === 'failure' ? 'failure' : 'success';
  state.run.result = { status: 'success', outputs: {
    operator: outcome === 'wrong-operator' ? 'ANOTHER' : 'SUPER1',
    role: outcome === 'wrong-role' ? 'TELLER' : 'SUPERVISOR', branch: outcome === 'wrong-branch' ? 'OTHER' : 'MAIN',
  } };
  const response = await login();
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain('token');
});

const successfulSignOn = { status: 'success', outputs: { operator: 'SUPER1', role: 'SUPERVISOR', branch: 'MAIN' } };
const pendingRun = () => ({ state: 'awaiting-human', intervention: { id: randomUUID(), expiresAt: Date.now() + 300_000 } });
async function verifiedFixture() {
  const f = await fixture();
  f.state.run.state = 'success'; f.state.run.result = successfulSignOn;
  const response = await f.login();
  expect(response.status).toBe(200);
  const verified = await response.json();
  f.service.history.mockResolvedValue([pendingRun()]);
  f.service.invoke.mockImplementation(() => { throw new RequestError(429, 'One run is active'); });
  nextLogin();
  return { ...f, verified };
}

it('reissues verified supervisor access only for current pending state without invoking sign-on', async () => {
  const f = await verifiedFixture();
  const response = await f.login({ operator: 'super1', password: 'offline-supervisor-password' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(f.verified);
  expect(f.service.history).toHaveBeenCalledWith('operator');
  expect(f.service.invoke).toHaveBeenCalledTimes(1);
});

it.each(['wrong-password', 'wrong-operator', 'password', 'operator', 'branch', 'entryUrl', 'appId', 'expired', 'terminal', 'failed', 'unknown', 'missing-id', 'no-pending', 'read-error', 'drift-during-read'])(
  'refuses cached supervisor access for %s', async mode => {
    const f = await verifiedFixture();
    const credentials = { operator: 'SUPER1', password: 'offline-supervisor-password' };
    if (mode === 'wrong-password') credentials.password = 'wrong';
    if (mode === 'wrong-operator') credentials.operator = 'OTHER';
    if (mode === 'password') { credentials.password = 'new-password'; vi.stubEnv('MERIDIAN_SUPERVISOR_PASSWORD', credentials.password); }
    if (mode === 'operator') { credentials.operator = 'NEW-SUPER'; vi.stubEnv('MERIDIAN_SUPERVISOR_OPERATOR', credentials.operator); }
    if (mode === 'branch') vi.stubEnv('MERIDIAN_BRANCH', 'OTHER');
    if (mode === 'entryUrl') f.service.profile.entryUrl = 'https://changed.invalid';
    if (mode === 'appId') f.service.profile.appId = 'other';
    if (mode === 'expired') f.service.history.mockResolvedValue([{ ...pendingRun(), intervention: { id: randomUUID(), expiresAt: Date.now() } }]);
    if (mode === 'terminal' || mode === 'failed' || mode === 'unknown') f.service.history.mockResolvedValue([{ ...pendingRun(), state: mode === 'terminal' ? 'success' : mode === 'failed' ? 'failure' : 'POST_OUTCOME_UNKNOWN' }]);
    if (mode === 'missing-id') f.service.history.mockResolvedValue([{ ...pendingRun(), intervention: { expiresAt: Date.now() + 300_000 } }]);
    if (mode === 'no-pending') f.service.history.mockResolvedValue([]);
    if (mode === 'read-error') f.service.history.mockRejectedValue(new Error('offline read failure'));
    if (mode === 'drift-during-read') f.service.history.mockImplementation(async () => { vi.stubEnv('MERIDIAN_BRANCH', 'OTHER'); return [pendingRun()]; });
    const response = await f.login(credentials);
    expect(response.status).not.toBe(200);
    expect(await response.text()).not.toContain('token');
    expect(f.service.invoke).toHaveBeenCalledTimes(mode.startsWith('wrong-') ? 1 : 2);
    // Rejected input keeps unchanged proof; failed target verification or context drift invalidates it.
    vi.stubEnv('MERIDIAN_SUPERVISOR_OPERATOR', 'SUPER1'); vi.stubEnv('MERIDIAN_SUPERVISOR_PASSWORD', 'offline-supervisor-password'); vi.stubEnv('MERIDIAN_BRANCH', 'MAIN');
    f.service.profile = { appId: 'meridian', entryUrl: 'https://offline.invalid' };
    f.service.history.mockResolvedValue([pendingRun()]); nextLogin();
    expect((await f.login()).status).toBe(mode.startsWith('wrong-') ? 200 : 429);
  });

it('uses fresh target sign-on without proof or pending state, and rejects context drift during verification', async () => {
  const f = await fixture();
  f.service.history.mockResolvedValue([pendingRun()]);
  f.state.run.state = 'success'; f.state.run.result = successfulSignOn;
  expect((await f.login()).status).toBe(200);
  expect(f.service.invoke).toHaveBeenCalledTimes(1);
  f.service.history.mockResolvedValue([]); nextLogin();
  expect((await f.login()).status).toBe(200);
  expect(f.service.invoke).toHaveBeenCalledTimes(2);
  f.state.run.state = 'running'; f.state.run.result = undefined; nextLogin();
  const response = f.login();
  await vi.waitFor(() => expect(f.service.invoke).toHaveBeenCalledTimes(3));
  vi.stubEnv('MERIDIAN_BRANCH', 'OTHER');
  f.state.run.state = 'success'; f.state.run.result = successfulSignOn;
  expect((await response).status).toBe(401);
  vi.stubEnv('MERIDIAN_BRANCH', 'MAIN'); nextLogin();
  f.service.history.mockResolvedValue([pendingRun()]);
  f.service.invoke.mockImplementation(() => { throw new RequestError(429, 'One run is active'); });
  expect((await f.login()).status).toBe(429);
});

async function realServiceFixture(allowlist: string[] = []) {
  vi.stubEnv('MERIDIAN_TELLER_OPERATOR', 'TELLER1'); vi.stubEnv('MERIDIAN_TELLER_PASSWORD', 'offline-teller-password');
  const dir = mkdtempSync(join(tmpdir(), 'supervisor-reconnect-'));
  const journal = new Journal(join(dir, 'journal'), 'offline-journal-key-at-least-32-characters');
  const profile = loadProfile('meridian');
  const service = new InvocationService(journal, profilePolicy(profile), profile, join(dir, 'evidence'), allowlist);
  cleanups.push(async () => { await service.close(); journal.close(); rmSync(dir, { recursive: true, force: true }); });
  let options!: Parameters<typeof runtime.createRuntime>[0];
  const construct = vi.spyOn(runtime, 'createRuntime').mockImplementation(input => {
    options = input;
    const redactor = new Redactor(); redactor.addSensitiveValues([input.operator!.password]);
    return { surface: { currentUrl: () => 'https://offline.invalid/update/review', mutationDispatched: false },
      browser: { page: {} }, logger: new RunLogger(input.kind, redactor, input.evidenceDir, true, input.runId),
      redactor, promptRedactor: redactor, session: input.session, cleanupFailed: false, close: async () => input.onClose?.(),
    } as unknown as ReturnType<typeof runtime.createRuntime>;
  });
  const replay = vi.spyOn(runtime, 'executeReplay').mockResolvedValue(successfulSignOn as any);
  const invoke = vi.spyOn(service, 'invoke');
  vi.spyOn(client, 'makeLLMClient').mockReturnValue({ openai: {} as any, model: 'offline-only' });
  const discover = vi.spyOn(discovery, 'runDiscovery').mockImplementation(async () => {
    await options.gate('click', 'irreversible', 'Review offline contact update', {
      runId: options.runId!, artifact: 'meridian-update-member', version: '1.0.0', stepId: 'save',
      destination: 'https://offline.invalid/update/post', method: 'POST', operator: 'TELLER1', role: 'TELLER', branch: 'MAIN',
      facts: {}, visibleFacts: { email: 'member@example.test' }, tokenPresent: true, control: 'Save',
    });
    return { status: 'stopped', trace: [], outputs: {}, finalUrl: 'https://offline.invalid/update' };
  });
  const startPending = async () => {
    const accepted = await service.discover('operator', 'meridian-update-member', { member: '9001', email: 'member@example.test', phone: '5550001111', address: '1 Main Street' }, randomUUID(), 'TELLER');
    await vi.waitFor(async () => expect((await service.get('operator', accepted.runId)).state).toBe('awaiting-human'));
    return service.get('operator', accepted.runId);
  };
  return { ...await fixture(true, service), service, construct, replay, invoke, discover, startPending };
}

it('reconnects to a real service pending teller-context intervention and can read and decide it without another runtime', async () => {
  const f = await realServiceFixture();
  const initial = await f.login(); expect(initial.status).toBe(200);
  const verified = await initial.json();
  expect(f.replay).toHaveBeenCalledTimes(1);
  const pending = await f.startPending(); nextLogin();
  const typo = await f.login({ operator: 'SUPER1', password: 'wrong-password' });
  expect(typo.status).toBe(401); expect(await typo.text()).not.toContain('token');
  expect(f.invoke).toHaveBeenCalledTimes(1); nextLogin();
  const response = await f.login();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(verified);
  expect(f.invoke).toHaveBeenCalledTimes(1); expect(f.construct).toHaveBeenCalledTimes(2); expect(f.discover).toHaveBeenCalledTimes(1);
  const headers = { Authorization: `Bearer ${verified.token}`, 'Content-Type': 'application/json' };
  const read = await fetch(`${f.origin}/runs/${pending.runId}`, { headers });
  expect((await read.json()).intervention).toEqual(pending.intervention);
  if (!pending.intervention || !('id' in pending.intervention)) throw new Error('Missing public intervention');
  const decision = await fetch(`${f.origin}/runs/${pending.runId}/decision`, { method: 'POST', headers,
    body: JSON.stringify({ approvalId: pending.intervention.id, decision: 'abort' }) });
  expect(decision.status).toBe(200);
  await vi.waitFor(() => expect(f.service.live.get(pending.runId)?.finished).toBeDefined());
  expect(f.construct).toHaveBeenCalledTimes(2);
});

it('reloads the browser, clears credentials, and restores the exact pending review through real supervisor login', async () => {
  const f = await realServiceFixture();
  const browser = await chromium.launch({ headless: true });
  cleanups.push(() => browser.close());
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(f.origin);
  const connect = async () => {
    await page.getByLabel('Role', { exact: true }).selectOption('operator');
    expect(await page.getByLabel('Operator', { exact: true }).inputValue()).toBe('');
    expect(await page.getByLabel('Password', { exact: true }).inputValue()).toBe('');
    await page.getByLabel('Operator', { exact: true }).fill('SUPER1');
    await page.getByLabel('Password', { exact: true }).fill('offline-supervisor-password');
    const loginResponse = page.waitForResponse(response => response.url().endsWith('/session/supervisor'));
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    const response = await loginResponse;
    expect(response.status()).toBe(200);
    await page.getByRole('button', { name: 'Disconnect', exact: true }).waitFor();
    return response.json();
  };
  const initial = await connect();
  const pending = await f.startPending();
  nextLogin();
  await page.reload();
  expect(await connect()).toEqual(initial);
  await page.getByRole('button', { name: /^Activity/ }).click();
  const card = page.locator(`#runs article[data-run-id="${pending.runId}"]`);
  await card.getByRole('button', { name: 'Review request', exact: true }).click();
  const review = page.getByRole('dialog', { name: 'Review request', exact: true });
  expect(await review.getAttribute('data-run-id')).toBe(pending.runId);
  const restored = await page.evaluate(async ({ runId, token }) => (await fetch(`/runs/${runId}`, { headers: { Authorization: `Bearer ${token}` } })).json(), { runId: pending.runId, token: initial.token });
  expect(restored.intervention).toEqual(pending.intervention);
  expect(await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }))).toEqual({ local: {}, session: {} });
  expect(f.invoke).toHaveBeenCalledTimes(1); expect(f.replay).toHaveBeenCalledTimes(1);
  expect(f.construct).toHaveBeenCalledTimes(2); expect(f.discover).toHaveBeenCalledTimes(1);
  expect(f.service.live.get(pending.runId)?.approval.pending?.id).toBe(restored.intervention.id);
  expect(errors).toEqual([]);
}, 20_000);


it('keeps reconnect single-flight while authoritative history is pending', async () => {
  const f = await verifiedFixture();
  let release!: (runs: any[]) => void;
  f.service.history.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const pending = f.login();
  await vi.waitFor(() => expect(f.service.history).toHaveBeenCalledTimes(1));
  nextLogin();
  expect((await f.login()).status).toBe(429);
  release([pendingRun()]);
  expect((await pending).status).toBe(200);
  expect(f.service.invoke).toHaveBeenCalledTimes(1);
});

it('requires fresh target verification in a new app instance while the old service is awaiting approval', async () => {
  const f = await realServiceFixture();
  const original = await (await f.login()).json();
  await f.startPending();
  const restarted = await fixture(true, f.service);
  const staleCredential = await fetch(restarted.origin + '/runs', { headers: { Authorization: `Bearer ${original.token}` } });
  expect(staleCredential.status).toBe(401);
  expect((await restarted.login()).status).toBe(429);
  expect(f.invoke).toHaveBeenCalledTimes(2);
  expect(f.construct).toHaveBeenCalledTimes(2);
});


it('binds local login tokens to branches for later runs without changing other sessions or the environment', async () => {
  const f = await realServiceFixture(['meridian-sign-on']);
  f.replay.mockImplementation(async (_artifact, params) => ({
    status: 'success', outputs: { operator: params.operator, branch: params.branch, role: 'TELLER' },
  }) as any);
  const tokens: string[] = [];
  for (const branch of ['WEST-014', 'EAST-022']) {
    const response = await fetch(f.origin + '/session/teller', { method: 'POST',
      headers: { Origin: f.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ branch }) });
    expect(response.status).toBe(200);
    tokens.push((await response.json()).token);
  }
  expect(tokens[0]).not.toBe(tokens[1]);
  for (const [token, branch] of [[tokens[0], 'WEST-014'], [tokens[1], 'EAST-022'], [tokens[0], 'WEST-014']] as const) {
    const response = await fetch(f.origin + '/capabilities/meridian-sign-on/invoke', { method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ args: {} }) });
    expect(response.status).toBe(202);
    const { runId } = await response.json();
    await vi.waitFor(() => expect(f.service.live.get(runId)?.finished).toBeDefined());
    expect(f.construct.mock.calls.at(-1)?.[0]).toMatchObject({ operator: { branch }, params: { branch } });
    expect(process.env.MERIDIAN_BRANCH).toBe('MAIN');
    expect(runtime.operatorBranch.getStore()).toBeUndefined();
  }
  const denied = await fetch(f.origin + '/session/teller', { method: 'POST',
    headers: { Origin: f.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ branch: 'UNKNOWN' }) });
  expect(denied.status).toBe(400);
  expect(await denied.text()).not.toContain('token');
});

it('verifies the selected supervisor branch and retains it for subsequent teller execution', async () => {
  const f = await realServiceFixture();
  f.replay.mockImplementation(async (_artifact, params) => ({
    status: 'success', outputs: { operator: params.operator, branch: params.branch,
      role: params.operator === 'SUPER1' ? 'SUPERVISOR' : 'TELLER' },
  }) as any);
  const response = await f.login({ operator: 'SUPER1', password: 'offline-supervisor-password', branch: 'WEST-014' });
  expect(response.status).toBe(200);
  const signedIn = await response.json();
  expect(signedIn.branch).toBe('WEST-014');
  expect(f.construct.mock.calls[0]?.[0].operator?.branch).toBe('WEST-014');
  const next = await fetch(f.origin + '/capabilities/meridian-sign-on/invoke', { method: 'POST',
    headers: { Authorization: `Bearer ${signedIn.token}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
    body: JSON.stringify({ args: {}, operator: 'TELLER' }) });
  expect(next.status).toBe(202);
  const { runId } = await next.json();
  await vi.waitFor(() => expect(f.service.live.get(runId)?.finished).toBeDefined());
  expect(f.construct.mock.calls.at(-1)?.[0].operator).toMatchObject({ role: 'TELLER', branch: 'WEST-014' });
  expect(process.env.MERIDIAN_BRANCH).toBe('MAIN');
});
