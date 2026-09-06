import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { afterEach, expect, it, vi } from 'vitest';
import { recordedStructure, safeResult } from '../src/evidence/safe-event.js';
import { RunLogger } from '../src/evidence/logger.js';
import { Redactor } from '../src/safety/redact.js';
import { Journal } from '../src/runtime/journal.js';
import { loadProfile, profilePolicy } from '../src/runtime/profile.js';
import * as runtime from '../src/runtime/run.js';
import { InvocationService } from '../src/server/service.js';
import { createApp } from '../src/server/http.js';

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'recorded-structure-')); dirs.push(dir); return dir; };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const capability = 'meridian-member-record';
const params = { member: 'PRIVATE-MEMBER', operator: 'PRIVATE-OPERATOR', password: 'PRIVATE-SECRET', branch: 'PRIVATE-BRANCH' };
const outputs = { shares: [{ shareId: 'PRIVATE-SHARE', type: 'PRIVATE-TYPE', balance: '9999.12', status: 'PRIVATE-STATUS' }] };
const result = { status: 'success', outputs };

it('records only known observed structure and rejects unknown, mixed, or injected metadata', () => {
  const metadata = recordedStructure(capability, params, result)!;
  expect(metadata.inputs).toEqual([{ name: 'member', type: 'string', value: 'withheld' }]);
  expect(metadata.outputs?.[0]?.columns).toContainEqual({ name: 'balance', type: 'string', value: 'withheld' });
  const serialized = JSON.stringify(safeResult({ ...result, structure: metadata }));
  for (const value of [...Object.values(params), ...Object.values(outputs.shares[0]!)]) expect(serialized).not.toContain(value);
  const malformed = [
    { ...metadata, extra: 'PRIVATE' },
    { ...metadata, inputs: [{ name: 'PRIVATE-FIELD', type: 'string', value: 'withheld' }] },
    { ...metadata, inputs: [{ name: 'member', type: 'PRIVATE-TYPE', value: 'withheld' }] },
    { ...metadata, inputs: [{ name: 'member', type: 'string', value: 'PRIVATE-VALUE' }] },
    { ...metadata, outputs: [{ name: 'shares', type: 'table', value: 'withheld', columns: [{ name: 'PRIVATE-COLUMN', type: 'string', value: 'withheld' }] }] },
    { ...metadata, outputs: [{ name: 'shares', type: 'table', value: 'withheld', columns: [], raw: 'PRIVATE' }] },
    { ...metadata, outputs: [] },
  ];
  for (const structure of malformed) expect(safeResult({ ...result, structure })).not.toHaveProperty('structure');
  const unconfigured = new RunLogger('discovery', new Redactor(), temp(), true);
  unconfigured.writeResult({ ...result, structure: metadata });
  expect(JSON.parse(readFileSync(join(unconfigured.dir, 'result.json'), 'utf8'))).not.toHaveProperty('structure');
  for (const value of [
    { ...outputs, 'PRIVATE-KEY': 'PRIVATE' },
    { shares: [{ ...outputs.shares[0], 'PRIVATE-COLUMN': 'PRIVATE' }] },
    { shares: [outputs.shares[0], { ...outputs.shares[0], balance: 1 }] },
    { shares: [outputs.shares[0], { shareId: 'PRIVATE' }] },
    { shares: [{ balance: Number.NaN }] },
    {},
  ]) expect(recordedStructure(capability, params, { status: 'success', outputs: value })?.outputs).toBeNull();
  expect(recordedStructure(capability, { ...params, 'PRIVATE-INPUT': 'PRIVATE' }, result)?.inputs).toBeNull();
  expect(recordedStructure(capability, params, { status: 'success', outputs: { shares: [] } })?.outputs).toEqual([{ name: 'shares', type: 'table', value: 'withheld', columns: [] }]);
  expect(recordedStructure('meridian-open-share', { member: 'PRIVATE', shareType: 'PRIVATE', deposit: 'PRIVATE' }, { status: 'success', outputs: { shareId: 7 } })?.outputs).toEqual([{ name: 'shareId', type: 'number', value: 'withheld' }]);
  for (const status of ['failure', 'business_outcome']) {
    expect(recordedStructure(capability, params, { ...result, status })?.outputs).toBeNull();
    expect(safeResult({ status, failure: { code: 'RUN_FAILED' }, outcomeCode: 'NO_SUCH_MEMBER', structure: metadata })).toMatchObject({ structure: { outputs: null } });
  }
});

it('preserves legacy non-MERIDIAN result behavior', async () => {
  const dir = temp();
  const journal = new Journal(join(dir, 'journal'), 'legacy-journal-key-at-least-32-characters');
  const record = journal.reserve('caller', 'legacy', 'legacy', '1.0.0', {});
  const logger = new RunLogger('replay', new Redactor(), dir, false, record.runId);
  const completed = { status: 'success', outputs: { legacy: 'legacy public value' } };
  logger.writeResult(completed); journal.update(record.runId, 'success');
  const profile = loadProfile('cu-nexus');
  const service = new InvocationService(journal, profilePolicy(profile), profile, dir, [], temp());
  try {
    expect(JSON.parse(readFileSync(join(logger.dir, 'result.json'), 'utf8'))).toEqual(completed);
    expect(service.get('caller', record.runId).result).toEqual(completed);
    expect(recordedStructure('legacy', {}, result)).toBeUndefined();
  } finally { await service.close(); journal.close(); }
});

it('restores recorded discovery/replay structure through the real service and browser without inventing old fields', async () => {
  // Offline execution fixture: no target browser or model is started; only the local UI browser runs.
  const dir = temp(), profile = loadProfile('meridian'), policy = profilePolicy(profile);
  const key = 'journal-test-key-at-least-32-characters';
  vi.stubEnv('MERIDIAN_TELLER_OPERATOR', 'PRIVATE-OPERATOR');
  vi.stubEnv('MERIDIAN_TELLER_PASSWORD', 'PRIVATE-SECRET');
  vi.stubEnv('MERIDIAN_BRANCH', 'PRIVATE-BRANCH');
  let journal = new Journal(join(dir, 'journal'), key);
  let service = new InvocationService(journal, policy, profile, dir, [capability]);
  vi.spyOn(runtime, 'executeReplay').mockImplementation(async (_artifact, _params, run) => {
    const completed = { status: 'success' as const, outputs, runId: run.logger.runId, evidenceDir: run.logger.dir, recoveries: [] };
    run.logger.writeResult(completed);
    await run.close();
    return completed;
  });
  let server: ReturnType<typeof createServer> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const replay = service.invoke('caller', capability, { member: '12345' }, 'replay');
    await vi.waitFor(() => expect(service.get('caller', replay.runId).state).toBe('success'));
    expect(service.get('caller', replay.runId).inputs).toEqual({ member: '12345' });
    await service.close();
    const discovery = journal.reserve('operator', 'discovery', capability, '1.0.0', { private: 'PRIVATE' }, 'discovery');
    const run = runtime.createRuntime({ kind: 'discovery', artifact: capability, version: '1.0.0', policy, profile, params, sensitive: ['member'], operator: { operator: params.operator, password: params.password, branch: params.branch, role: 'TELLER' }, gate: async () => false, runId: discovery.runId, evidenceDir: dir });
    try { run.logger.writeResult(result); } finally { await run.close(); }
    journal.update(discovery.runId, 'success');
    const old = journal.reserve('operator', 'old', capability, '1.0.0', {}, 'discovery');
    new RunLogger('discovery', new Redactor(), dir, true, old.runId).writeResult(result);
    journal.update(old.runId, 'success');
    journal.close();
    journal = new Journal(join(dir, 'journal'), key);
    service = new InvocationService(journal, policy, profile, dir, [capability]);
    for (const id of [discovery.runId, replay.runId]) {
      const view = service.get('operator', id);
      expect(view.inputs).toBeUndefined();
      expect(view.structure?.inputs).toEqual([{ name: 'member', type: 'string', value: 'withheld' }]);
      expect(view.structure?.outputs?.[0]?.columns).toHaveLength(4);
      const source = readFileSync(join(dir, id, 'result.json'), 'utf8');
      expect(source).not.toContain('PRIVATE'); expect(source).not.toContain('12345'); expect(source).not.toContain('9999.12');
    }
    expect(service.get('operator', old.runId).structure).toBeUndefined();
    // A changed current catalog must not manufacture fields for old evidence.
    service.artifacts.clear();
    const callerToken = 'c'.repeat(32), operatorToken = 'o'.repeat(32);
    server = createServer(); server.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server!.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    server.on('request', createApp(service, { callerToken, operatorToken, port }));
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
    await page.goto(`http://127.0.0.1:${port}`);
    await page.getByLabel('API credential').fill(operatorToken);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByText('Recorded output structure; values withheld.', { exact: true }).first().waitFor();
    const replayCard = page.locator(`[data-run-id="${replay.runId}"]`);
    await replayCard.getByText('Run details and evidence', { exact: true }).click();
    await replayCard.getByText('member: string — value withheld', { exact: true }).waitFor();
    expect(await replayCard.innerText()).toContain('member: string — value withheld');
    expect(await replayCard.innerText()).toContain('balance: string — value withheld');
    const discoveryCard = page.locator(`[data-run-id="${discovery.runId}"]`);
    expect(await discoveryCard.innerText()).toContain('discovery · v1.0.0');
    expect(await discoveryCard.innerText()).toContain('balance: string — value withheld');
    const oldCard = page.locator(`[data-run-id="${old.runId}"]`);
    await oldCard.getByText('Run details and evidence', { exact: true }).click();
    await oldCard.getByText('Input structure was not recorded or is unavailable.', { exact: true }).waitFor();
    expect(await oldCard.innerText()).toContain('Input structure was not recorded or is unavailable.');
    expect(await oldCard.innerText()).toContain('Output structure was not recorded or is unavailable.');
    expect(await page.locator('body').innerText()).not.toContain('PRIVATE');
    // Historical JSON is revalidated, including unexpected dynamic values and keys.
    const path = join(dir, replay.runId, 'result.json');
    const saved = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...saved, outputs: { private: 'PRIVATE' }, structure: { ...saved.structure, inputs: [{ name: 'PRIVATE-KEY', type: 'string', value: 'withheld' }] } }));
    const invalid = service.get('operator', replay.runId);
    expect(invalid.structure).toBeUndefined(); expect(JSON.stringify(invalid.result)).not.toContain('PRIVATE');
    writeFileSync(path, JSON.stringify({ ...saved, structure: recordedStructure('meridian-sign-on', {}, { status: 'success', outputs: { operator: 'PRIVATE', branch: 'PRIVATE', role: 'PRIVATE' } }) }));
    const mismatched = service.get('operator', replay.runId);
    expect(mismatched.structure).toBeUndefined(); expect(mismatched.result.structure).toBeUndefined();
    writeFileSync(path, '{');
    expect(service.get('operator', replay.runId)).toMatchObject({ state: 'success', structure: undefined, result: undefined });
  } finally {
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    await service.close(); journal.close();
  }
});
