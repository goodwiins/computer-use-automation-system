import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Journal } from '../src/runtime/journal.js';
import { meridianContracts } from '../src/runtime/contracts.js';
import { Approval } from '../src/runtime/approval.js';
import { ControlSession } from '../src/escalation/session.js';
import { CapabilityArtifact, moneyCents, validOutput, validateParams } from '../src/artifact/schema.js';
import { runDiscovery } from '../src/agent/loop.js';
import { recordArtifact } from '../src/artifact/recorder.js';
import { toToolSchema } from '../src/artifact/tools.js';
import { GuardedSurface } from '../src/surface/guarded.js';
import { BrowserSurface } from '../src/surface/browser.js';
import { Policy } from '../src/safety/policy.js';
import { loadProfile, type LiveControl } from '../src/runtime/profile.js';
import { RunLogger } from '../src/evidence/logger.js';
import { Redactor } from '../src/safety/redact.js';
import { runReplay } from '../src/replay/executor.js';
import type { Surface } from '../src/surface/types.js';
import { createApp } from '../src/server/http.js';
import { InvocationService } from '../src/server/service.js';
import express from 'express';
import { chromium } from 'playwright';
import { request as httpRequest, createServer } from 'node:http';

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'meridian-')); dirs.push(dir); return dir; };
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const key = 'hmac-test-key-with-at-least-32-characters';
const profile = loadProfile('meridian');
const origin = 'https://web-sample.interface-hiring.com';
const policy = Policy.parse({ allowedOrigins: [origin], allowedActions: ['navigate', 'click', 'fill', 'select', 'extract', 'assert'], riskHandling: { read: 'allow', reversible_write: 'allow', irreversible: 'allow' } });
const control: LiveControl = { url: `${origin}/members/1/hold/review`, destination: `${origin}/members/1/hold/post`, method: 'POST', control: 'Apply Hold', submit: true, operator: 'SUPER1', branch: 'MAIN-001', facts: { share: '1-A', reason: 'FRAUD' }, tokenPresent: true, error: false };
const target = { description: 'submit', strategies: [{ kind: 'nameAttr' as const, name: 'submit' }] };
function guarded(overrides: Partial<Surface> = {}, gate = async () => true, context = {}) {
  let live = structuredClone(control);
  const dispatch = vi.fn(async () => ({ strategyUsed: 0, kind: 'nameAttr', matches: 1 }));
  const surface: Surface = { start: async () => {}, navigate: async () => {}, observe: async () => ({ url: control.url, title: '', frames: [] }), currentUrl: () => control.url, frameUrls: () => [control.url], click: dispatch, fill: dispatch, select: dispatch, readText: async () => ({ text: 'ok', report: await dispatch() }), isTextVisible: async text => text === 'done', describeTarget: async t => t, screenshot: async () => {}, close: async () => {}, prepareClick: async () => ({ inspect: async () => structuredClone(live), dispatch }), ...overrides };
  const session = new ControlSession();
  const beforeDispatch = vi.fn();
  return { surface: new GuardedSurface(surface, policy, gate, undefined, { profile, session, deadline: Date.now() + 10000, runId: randomUUID(), artifact: 'hold', version: '1.0.0', operator: 'super1', role: 'SUPERVISOR', branch: 'MAIN-001', beforeDispatch, ...context }), dispatch, session, beforeDispatch, change: (c: Partial<LiveControl>) => { live = { ...live, ...c }; } };
}

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
});

describe('single-use interventions and live controls', () => {
  it('expires, rejects stale IDs, and serializes abort', async () => {
    vi.useFakeTimers(); const session = new ControlSession(); const approval = new Approval(session, () => {}, Date.now() + 600000);
    const request = { kind: 'replay_stuck' as const, capability: 'c', goal: '', reason: '', url: '' };
    const pending = approval.wait(request); const id = approval.pending!.id;
    expect(session.currentOwner).toBe('human'); approval.decide(id, 'abort');
    expect(await pending).toBe('abort'); expect(() => approval.decide(id, 'retry')).toThrow(/Stale/);
    const expired = approval.wait(request); await vi.advanceTimersByTimeAsync(300000); expect(await expired).toBe('abort'); expect(session.currentOwner).toBe('automation');
  });
  it('requires approval for a down-labelled post even if policy allows it', async () => {
    const gate = vi.fn(async () => false); const run = guarded({}, gate);
    await expect(run.surface.click(target, 100, 'read')).rejects.toThrow(/aborted/);
    expect(gate).toHaveBeenCalledOnce(); expect(run.dispatch).not.toHaveBeenCalled(); expect(run.beforeDispatch).not.toHaveBeenCalled();
  });
  it.each(['facts', 'operator', 'destination', 'tokenPresent'] as const)('invalidates changed %s before dispatch', async field => {
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
    const response = await request('/capabilities', caller); expect(response.status).toBe(200); expect(response.headers.get('content-security-policy')).toContain("object-src 'none'");
  } finally { await new Promise<void>(r => server.close(() => r())); journal.close(); }
});

it('extracts typed rows and blocks unsolicited browser POSTs through the real surface', async () => {
  const app = express(); let posted = 0;
  app.get('/members', (_req, res) => res.send('<table id="shares"><tr><th>Share</th><th>Balance</th></tr><tr><td>A</td><td>$12.30</td></tr></table><select name="share"><option value="A">A ($12.30)</option><option value="B">B ($3.00)</option></select>'));
  app.post('/members/1/update', (_req, res) => { posted++; res.end('saved'); });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r)); const address = server.address() as { port: number };
  const origin = `http://127.0.0.1:${address.port}`;
  const browser = new BrowserSurface({ allowedOrigins: [origin], profile });
  try {
    await browser.start(`${origin}/members`);
    const rows = await browser.readTable({ description: 'shares', strategies: [{ kind: 'css', selector: '#shares' }] }, [{ name: 'share', selector: 'td:nth-child(1)', type: 'string' }, { name: 'balance', selector: 'td:nth-child(2)', type: 'money' }]);
    expect(rows).toEqual([{ share: 'A', balance: '12.30' }]);
    await browser.select({ description: 'share', strategies: [{ kind: 'nameAttr', name: 'share' }] }, 'B', 1000, 'read', 'value');
    expect(await browser.page.locator('select').inputValue()).toBe('B');
    await browser.page.evaluate(() => fetch('/members/1/update', { method: 'POST' }).catch(() => {})); expect(posted).toBe(0);
    const dir = temp(); const logger = new RunLogger('replay', new Redactor(), dir, true); logger.log('error', { password: 'PRIVATE', params: { member: 'PRIVATE' }, observed: 'PRIVATE' }); logger.writeResult({ status: 'success', outputs: { name: 'PRIVATE' } });
    expect(readdirSync(logger.dir).map(f => readFileSync(join(logger.dir, f), 'utf8')).join('')).not.toContain('PRIVATE');
  } finally { await browser.close(); await new Promise<void>(r => server.close(() => r())); }
}, 15000);

it('rechecks a real form before approved dispatch and masks dynamic evidence end to end', async () => {
  const app = express(); let posted = 0;
  app.get('/members/1/update', (_req, res) => res.send('<p>OPR SUPER1 | BR MAIN-001</p><div class="box" style="width:500px;height:180px"><span id="member">PRIVATE-FIRST</span><form method="post" action="/members/1/update"><input type="hidden" name="_token" value="TOKEN-PRIVATE"><input name="email" value="first@example.test"><input name="phone" value="5550001111"><input name="address" value="PRIVATE STREET"><input type="submit" value="Save Changes"></form></div>'));
  app.post('/members/1/update', (_req, res) => { posted++; res.end('<h1>Saved</h1>'); });
  const server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r)); const address = server.address() as { port: number };
  const localOrigin = `http://127.0.0.1:${address.port}`;
  const redactor = new Redactor();
  const browser = new BrowserSurface({ allowedOrigins: [localOrigin], profile: { ...profile, maskSelectors: ['.box', 'input', 'textarea', 'select'] }, sensitive: values => redactor.addSensitiveValues(values) });
  let changed = true;
  const gate = async () => { if (changed) await browser.page.locator('[name=email]').fill('changed@example.test'); return true; };
  const guard = new GuardedSurface(browser, { ...policy, allowedOrigins: [localOrigin] }, gate, undefined, { profile, session: new ControlSession(), deadline: Date.now() + 10000, runId: randomUUID(), artifact: 'update', version: '1.0.0', operator: 'super1', branch: 'MAIN-001', role: 'SUPERVISOR', beforeDispatch: () => expect(posted).toBe(0) });
  const button = { description: 'Save Changes', strategies: [{ kind: 'role' as const, role: 'button', name: 'Save Changes' }] };
  try {
    await guard.start(`${localOrigin}/members/1/update`);
    const logger = new RunLogger('replay', redactor, temp(), true);
    const first = await logger.screenshot(guard, 'first');
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
    await page.goto(`http://127.0.0.1:${address.port}`); await page.locator('#credential').fill('o'.repeat(32)); await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.locator('#workspace').waitFor({ state: 'visible' });
    expect(await page.locator('#credential').inputValue()).toBe(''); expect(await page.locator('#fields img').count()).toBe(0);
    await page.route('**/chat', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ message: '<img src=x onerror=alert(1)>' }) }));
    await page.locator('#message').fill('Check my balance'); await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('#messages p').first().waitFor(); expect(await page.locator('#messages img').count()).toBe(0);
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  } finally { await browser.close(); await new Promise<void>(r => server.close(() => r())); journal.close(); }
}, 15000);
