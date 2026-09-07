import { copyFileSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { InvocationService } from '../src/server/service.js';
import { Journal } from '../src/runtime/journal.js';
import { loadProfile, profilePolicy } from '../src/runtime/profile.js';
import { formatMoney, runPresentation } from '../src/server/ui/presentation.js';
import { Approval } from '../src/runtime/approval.js';
import { ControlSession } from '../src/escalation/session.js';

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
});

it('formats exact decimal values without floating point rounding', () => {
  expect(formatMoney('1200.10')).toBe('$1,200.10');
  expect(formatMoney('90071992547409.91')).toBe('$90,071,992,547,409.91');
  expect(formatMoney('-1200.00')).toBe('-$1,200.00');
  expect(formatMoney('0')).toBe('$0');
  expect(formatMoney('not-money')).toBe('not-money');
});

it('checks caller access before artifact existence and quarantines unknown outcomes safely', () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-readiness-')); temporary.push(root);
  const artifacts = join(root, 'artifacts'); mkdirSync(artifacts);
  copyFileSync('artifacts/meridian-member-record.v1.0.0.json', join(artifacts, 'member-record.json'));
  const profile = loadProfile('meridian');
  const journal = new Journal(join(root, 'journal'), 'j'.repeat(32));
  const service = new InvocationService(journal, profilePolicy(profile), profile, root, ['meridian-member-record'], artifacts);
  expect(service.availability('caller')).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'meridian-funds-transfer', state: 'restricted' }),
    expect.objectContaining({ id: 'meridian-member-record', state: 'available' }),
  ]));
  expect(service.availability('operator')).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'meridian-funds-transfer', state: 'not_recorded', reason: 'No approved recording' }),
  ]));
  const foreign = journal.reserve('foreign-owner', 'foreign-key', 'meridian-member-record', '1.0.0', {});
  journal.update(foreign.runId, 'dispatching');
  journal.update(foreign.runId, 'failure');
  const quarantined = service.availability('caller').find(item => item.id === 'meridian-member-record');
  expect(quarantined).toMatchObject({ state: 'temporarily_unavailable' });
  expect(JSON.stringify(quarantined)).not.toContain('foreign-owner');
  expect(JSON.stringify(quarantined)).not.toContain(foreign.runId);
  journal.close();
});

it('uses investigation language for unknown and does not claim a generic failure was safe', () => {
  const unknown = runPresentation({ state: 'POST_OUTCOME_UNKNOWN', capability: 'meridian-funds-transfer' } as never);
  expect(unknown.label).toBe('Unable to verify outcome');
  expect(unknown.description).toContain('do not retry');
  const failure = runPresentation({ state: 'failure', capability: 'meridian-funds-transfer', result: { status: 'failure', failure: { code: 'RUN_FAILED' } } } as never);
  expect(failure.description).not.toMatch(/did not post|no posting/i);
});

it('uses readable explanations for known business outcomes while preserving raw codes for Details', () => {
  for (const [code, label] of [
    ['INSUFFICIENT_FUNDS', 'Insufficient funds'],
    ['VALIDATION_REJECTED', 'Validation rejected'],
    ['NO_SUCH_MEMBER', 'Member not found'],
  ]) {
    const presentation = runPresentation({ state: 'business_outcome', capability: 'meridian-member-inquiry', result: { status: 'business_outcome', outcomeCode: code, detail: 'safe detail' } });
    expect(presentation.label).toBe(label);
    expect(presentation.description).toContain('safe detail');
  }
  expect(runPresentation({ state: 'business_outcome', capability: 'meridian-member-inquiry', result: { status: 'business_outcome', outcomeCode: 'NEW_CODE', detail: 'safe detail' } }).label).toBe('Business outcome');
});

it('reports active and shutdown availability without changing the fixed public catalog', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-readiness-')); temporary.push(root);
  const artifacts = join(root, 'artifacts'); mkdirSync(artifacts);
  copyFileSync('artifacts/meridian-member-record.v1.0.0.json', join(artifacts, 'member-record.json'));
  const profile = loadProfile('meridian');
  const journal = new Journal(join(root, 'journal'), 'k'.repeat(32));
  const service = new InvocationService(journal, profilePolicy(profile), profile, root, ['meridian-member-record'], artifacts);
  (service as unknown as { active?: string }).active = 'active-run';
  expect(service.availability('caller').find(item => item.id === 'meridian-member-record')).toMatchObject({ state: 'temporarily_unavailable', reason: 'Another operation is active' });
  expect(service.availability('caller').map(item => item.id)).toHaveLength(7);
  expect(service.availability('caller').map(item => item.id)).not.toContain('hidden-capability');
  await service.close();
  expect(service.availability('caller').find(item => item.id === 'meridian-member-record')).toMatchObject({ state: 'temporarily_unavailable', reason: 'Server is shutting down' });
});

it('exposes finishedAt only for live completion, never historical journal records', () => {
  const root = mkdtempSync(join(tmpdir(), 'ui-readiness-')); temporary.push(root);
  const artifacts = join(root, 'artifacts'); mkdirSync(artifacts);
  copyFileSync('artifacts/meridian-member-record.v1.0.0.json', join(artifacts, 'member-record.json'));
  const profile = loadProfile('meridian');
  const journal = new Journal(join(root, 'journal'), 'h'.repeat(32));
  const service = new InvocationService(journal, profilePolicy(profile), profile, root, ['meridian-member-record'], artifacts);
  const record = journal.reserve('caller', 'history-key', 'meridian-member-record', '1.0.0', {});
  journal.update(record.runId, 'success');
  service.live.set(record.runId, { state: 'success', inputs: {}, started: 10, finished: 20, approval: new Approval(new ControlSession(), () => {}, Date.now() + 1000) });
  expect(service.get('caller', record.runId).finishedAt).toBe(new Date(20).toISOString());
  service.live.delete(record.runId);
  expect(service.get('caller', record.runId).finishedAt).toBeUndefined();
  journal.close();
});
