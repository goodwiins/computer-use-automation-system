import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { RunLogger } from '../src/evidence/logger.js';
import { safeEvent } from '../src/evidence/safe-event.js';
import { evaluateRun } from '../src/evidence/evaluate.js';
import { Journal, readJournalRecord, type JournalRecord } from '../src/runtime/journal.js';
import { Redactor } from '../src/safety/redact.js';

const dirs: string[] = [];
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'evidence-eval-')); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const key = 'test-journal-secret-at-least-32-characters';
const record: JournalRecord = { kind: 'replay', runId: randomUUID(), caller: 'test', capability: 'test', version: '1', request: '', identity: '', createdAt: '', state: 'success' };
const trajectory = [
  { event: 'action.start', attempt: 1, action: 'click', requestedRisk: 'read' },
  { event: 'risk.classified', attempt: 1, requestedRisk: 'read', effectiveRisk: 'irreversible', mutation: true },
  { event: 'approval.result', attempt: 1, approved: true },
  { event: 'mutation.intent', attempt: 1, effectiveRisk: 'irreversible' },
  { event: 'action.end', attempt: 1, status: 'success' },
  { event: 'replay.success' },
];
const encode = (events: Record<string, unknown>[]) => events.map((e, seq) => JSON.stringify({ seq, ...e })).join('\n');

it('preserves valid falsy metadata while dropping absent, invalid and private fields', () => {
  expect(safeEvent('action.end', {
    attempt: 1, ms: 0, isRetry: false, approved: false, mutation: false,
    status: 'success', code: undefined, action: 'PRIVATE', turn: null, url: 'PRIVATE',
  })).toEqual({ event: 'action.end', data: {
    attempt: 1, ms: 0, isRetry: false, approved: false, mutation: false, status: 'success',
  } });
  expect(safeEvent('replay.success', {})).toEqual({ event: 'replay.success', data: {} });
});

it('keeps sensitive data and arbitrary values out of observers, even in non-strict mode', async () => {
  for (const strict of [false, true]) {
    const received: unknown[] = [];
    const logger = new RunLogger('replay', new Redactor(), temp(), strict, undefined, (event, data) => {
      received.push({ event, data });
      expect(readFileSync(join(logger.dir, 'log.jsonl'), 'utf8')).not.toBe('');
      throw new Error('observer failed');
    });
    expect(() => logger.log('action.start', { attempt: 1, action: 'click', params: 'PRIVATE', url: '/members/PRIVATE', stepId: 'PRIVATE', risk: 'PRIVATE', code: 'PRIVATE', event: 'PRIVATE', seq: 99 })).not.toThrow();
    expect(JSON.stringify(received)).not.toContain('PRIVATE');
    const entry = JSON.parse(readFileSync(join(logger.dir, 'log.jsonl'), 'utf8'));
    expect(entry.seq).toBe(0); expect(entry.event).toBe('action.start');
    if (strict) expect(JSON.stringify(entry)).not.toContain('PRIVATE');
    const asyncLogger = new RunLogger('replay', new Redactor(), temp(), strict, undefined, async () => { throw new Error('async observer failed'); });
    asyncLogger.log('replay.start');
    await new Promise(resolve => setImmediate(resolve)); // unhandled rejections fail Vitest
  }
  expect(safeEvent('PRIVATE-EVENT', { action: 'click' })).toEqual({ event: 'evidence.omitted', data: {} });
});

it('preserves strict protocol metadata when sensitive values collide with its enums', () => {
  const redactor = new Redactor();
  redactor.addSensitiveValues(['transfer', 'irreversible', 'click', 'success', 'PRIVATE-PAGE-VALUE']);
  const observed: { event: string; data: Record<string, unknown> }[] = [];
  const logger = new RunLogger('replay', redactor, temp(), true, undefined,
    (event, data) => observed.push({ event, data }));
  logger.log('control.transfer', { from: 'PRIVATE-PAGE-VALUE', to: 'PRIVATE-PAGE-VALUE' });
  for (const { event, ...data } of trajectory) logger.log(event, { ...data, pageText: 'PRIVATE-PAGE-VALUE' });
  logger.log('PRIVATE-PAGE-VALUE', { action: 'click' });

  const entries = readFileSync(join(logger.dir, 'log.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  expect(entries.map(({ ts: _ts, seq: _seq, event, ...data }) => ({ event, data }))).toEqual(observed);
  expect(entries.map(entry => entry.event)).toEqual(['control.transfer', ...trajectory.map(entry => entry.event), 'evidence.omitted']);
  expect(JSON.stringify(entries)).not.toContain('PRIVATE-PAGE-VALUE');
  expect(evaluateRun(entries.map(entry => JSON.stringify(entry)).join('\n'), record).status).toBe('pass');

  const legacyRedactor = new Redactor(); legacyRedactor.addSensitiveValues(['PRIVATE-PAGE-VALUE']);
  const legacy = new RunLogger('replay', legacyRedactor, temp());
  legacy.log('page.PRIVATE-PAGE-VALUE', { text: 'PRIVATE-PAGE-VALUE' });
  expect(readFileSync(join(legacy.dir, 'log.jsonl'), 'utf8')).not.toContain('PRIVATE-PAGE-VALUE');
});

it('keeps only validated strict terminal metadata under sensitive-value collisions', () => {
  const write = (result: unknown, sensitive: string[]) => {
    const redactor = new Redactor(); redactor.addSensitiveValues(sensitive);
    const logger = new RunLogger('replay', redactor, temp(), true);
    logger.writeResult(result);
    return JSON.parse(readFileSync(join(logger.dir, 'result.json'), 'utf8'));
  };
  expect(write({ status: 'success', outputs: { private: 'PRIVATE' } }, ['success', 'PRIVATE']))
    .toEqual({ status: 'success', sensitiveValuesUnavailable: true });
  expect(write({ status: 'business_outcome', outcomeCode: 'INSUFFICIENT_FUNDS', detail: 'PRIVATE' }, ['business_outcome', 'INSUFFICIENT_FUNDS', 'PRIVATE']))
    .toEqual({ status: 'business_outcome', outcomeCode: 'INSUFFICIENT_FUNDS', sensitiveValuesUnavailable: true });
  expect(write({ status: 'failure', failure: { code: 'POST_OUTCOME_UNKNOWN', detail: 'PRIVATE' } }, ['failure', 'POST_OUTCOME_UNKNOWN', 'PRIVATE']))
    .toEqual({ status: 'failure', sensitiveValuesUnavailable: true, failure: { code: 'POST_OUTCOME_UNKNOWN' } });
  for (const code of ['PERMISSION_DENIED', 'SESSION_EXPIRED', 'APPLICATION_ERROR']) {
    expect(write({ status: 'failure', failure: { code, detail: 'PRIVATE' } }, [code, 'PRIVATE']))
      .toEqual({ status: 'failure', sensitiveValuesUnavailable: true, failure: { code } });
  }
  for (const status of ['stopped', 'escalated'] as const) {
    expect(write({ status, stopReason: 'PRIVATE', detail: 'PRIVATE', outputs: { private: 'PRIVATE' }, ignored: 'PRIVATE' }, [status, 'PRIVATE']))
      .toEqual({ status, sensitiveValuesUnavailable: true });
  }
  const fallback = { status: 'failure', sensitiveValuesUnavailable: true, failure: { code: 'RUN_FAILED' } };
  expect(write({ status: 'business_outcome', outcomeCode: 'PRIVATE-OUTCOME', detail: 'PRIVATE', ignored: 'PRIVATE' }, [])).toEqual(fallback);
  expect(write({ status: 'failure', failure: { code: 'PRIVATE-FAILURE', detail: 'PRIVATE' }, ignored: 'PRIVATE' }, [])).toEqual(fallback);
  expect(write({ status: 'PRIVATE-STATUS', outcomeCode: 'PRIVATE-OUTCOME', ignored: 'PRIVATE' }, [])).toEqual(fallback);
});

it('grades approvals and dispatch attempts from ordered runtime evidence', () => {
  expect(evaluateRun(encode(trajectory), record)).toMatchObject({ status: 'pass', mutationIntents: 1, riskDisagreements: 1 });
  expect(evaluateRun(encode(trajectory.filter(e => e.event !== 'approval.result')), record).violations).toContain('DISPATCH_WITHOUT_APPROVAL');
  const late = [...trajectory]; [late[2], late[3]] = [late[3]!, late[2]!];
  expect(evaluateRun(encode(late), record).violations).toContain('DISPATCH_WITHOUT_APPROVAL');
  const twice = [...trajectory.slice(0, -1), ...trajectory.slice(0, -1).map(e => ({ ...e, attempt: 2 })), trajectory.at(-1)!];
  expect(evaluateRun(encode(twice), record).violations).toContain('DUPLICATE_MUTATION_INTENT');
  const otherApproval = trajectory.map(e => e.event === 'approval.result' ? { ...e, attempt: 99 } : e);
  expect(evaluateRun(encode(otherApproval), record).status).toBe('fail');
});

it('never awards a pass for missing, sampled, malformed, or uncertain evidence', () => {
  for (const source of ['', '{', encode(trajectory.slice(0, -1)), encode(trajectory).split('\n').filter((_, i) => i !== 2).join('\n')]) {
    expect(evaluateRun(source, record).status).not.toBe('pass');
  }
  expect(evaluateRun(encode(trajectory), { ...record, state: 'POST_OUTCOME_UNKNOWN' })).toMatchObject({ status: 'unknown', incomplete: ['POST_OUTCOME_UNKNOWN'] });
  expect(evaluateRun(encode(trajectory), { ...record, state: 'failure' }).violations).toContain('DISPATCH_STATE_LOST');
  const read = [trajectory[0]!, { ...trajectory[1]!, effectiveRisk: 'read', mutation: false }, trajectory[4]!, trajectory[5]!];
  expect(evaluateRun(encode(read), record).status).toBe('pass');
});

it('rejects duplicate classifications and retains mutation evidence in either order', () => {
  const mutation = trajectory[1]!;
  const read = { ...mutation, effectiveRisk: 'read', mutation: false };
  for (const classifications of [[mutation, read], [read, mutation], [mutation, mutation], [read, read]]) {
    const result = evaluateRun(encode([trajectory[0]!, ...classifications, trajectory[4]!, trajectory[5]!]), record);
    expect(result.status).toBe('fail');
    expect(result.violations).toContain('DUPLICATE_RISK_CLASSIFICATION');
    if (classifications.includes(mutation)) expect(result.violations).toContain('MUTATION_WITHOUT_INTENT');
  }
});

it('requires explicit boolean mutation metadata, including legacy classifications', () => {
  for (const effectiveRisk of ['read', 'irreversible']) {
    for (const mutation of [undefined, null, 'false', 'true', 0, 1, {}, []]) {
      const classification = { ...trajectory[1]!, effectiveRisk, mutation };
      const result = evaluateRun(encode([trajectory[0]!, classification, trajectory[4]!, trajectory[5]!]), record);
      expect(result.status).toBe('unknown');
      expect(result.incomplete).toContain('INVALID_RISK_CLASSIFICATION');
    }
  }
});

it('rejects risk enum values that only become valid through string coercion', () => {
  for (const field of ['requestedRisk', 'effectiveRisk']) {
    const classification = { ...trajectory[1]!, effectiveRisk: 'read', mutation: false, [field]: ['read'] };
    expect(evaluateRun(encode([trajectory[0]!, classification, trajectory[4]!, trajectory[5]!]), record))
      .toMatchObject({ status: 'unknown', incomplete: expect.arrayContaining(['INVALID_RISK_CLASSIFICATION']) });
  }
});

it('rejects malformed actions instead of skipping successful-click classification', () => {
  for (const action of [['click'], [['click']], undefined, null, false, 1, {}, 'invalid']) {
    const result = evaluateRun(encode([{ ...trajectory[0]!, action }, trajectory[4]!, trajectory[5]!]), record);
    expect(result).toMatchObject({ status: 'unknown', incomplete: expect.arrayContaining(['INVALID_ACTION']) });
  }
});

it('rejects malformed action results instead of skipping successful-mutation intent', () => {
  for (const status of [['success'], [['success']], undefined, null, false, 1, {}, 'invalid']) {
    const result = evaluateRun(encode([trajectory[0]!, trajectory[1]!, { ...trajectory[4]!, status }, trajectory[5]!]), record);
    expect(result).toMatchObject({ status: 'unknown', incomplete: expect.arrayContaining(['INVALID_ACTION_RESULT']) });
  }
});

it('rejects malformed discovery terminal statuses without coercing them to journal state', () => {
  for (const status of [['success'], [['success']], undefined, null, false, 1, {}, '', 'invalid', 'failure']) {
    const events = [{ ...trajectory[0]!, action: 'navigate' }, trajectory[4]!, { event: 'discovery.finish', status }];
    const result = evaluateRun(encode(events), { ...record, kind: 'discovery', state: status === 'failure' ? 'failure' : 'success' });
    expect(result).toMatchObject({ status: 'unknown', incomplete: expect.arrayContaining(['INVALID_TERMINAL_STATUS']) });
  }
});

it('rejects malformed terminal codes instead of losing unknown-outcome metadata', () => {
  for (const kind of ['replay', 'discovery'] as const) {
    const failed = [trajectory[0]!, { ...trajectory[4]!, status: 'failure' }];
    const finish = { event: kind === 'replay' ? 'replay.failure' : 'discovery.finish', status: 'stopped' };
    const journal = { ...record, kind, state: 'failure' as const };
    for (const code of [['POST_OUTCOME_UNKNOWN'], [['POST_OUTCOME_UNKNOWN']], null, false, 1, {}]) {
      expect(evaluateRun(encode([...failed, { ...finish, code }]), journal))
        .toMatchObject({ status: 'unknown', incomplete: expect.arrayContaining(['INVALID_TERMINAL_CODE']) });
    }
    for (const code of [undefined, 'RUN_FAILED', 'CUSTOM_LEGACY_CODE']) {
      expect(evaluateRun(encode([...failed, { ...finish, code }]), journal).status).toBe('pass');
    }
    expect(evaluateRun(encode([...failed, { ...finish, code: 'POST_OUTCOME_UNKNOWN' }]), journal))
      .toMatchObject({ status: 'fail', violations: ['UNKNOWN_OUTCOME_STATE_LOST'] });
  }
});

it('accepts valid discovery terminal statuses through the strict logger', () => {
  for (const status of ['success', 'business_outcome', 'stopped', 'escalated'] as const) {
    const logger = new RunLogger('discovery', new Redactor(), temp(), true);
    logger.log('action.start', { attempt: 1, action: 'navigate' });
    logger.log('action.end', { attempt: 1, status: 'success' });
    logger.log('discovery.finish', { status });
    const state = status === 'stopped' || status === 'escalated' ? 'failure' : status;
    expect(evaluateRun(readFileSync(join(logger.dir, 'log.jsonl'), 'utf8'), { ...record, kind: 'discovery', state }).status).toBe('pass');
  }
});

it('keeps invalid first classifications incomplete after a valid duplicate', () => {
  for (const invalid of [
    { ...trajectory[1]!, mutation: undefined },
    { ...trajectory[1]!, effectiveRisk: 'invalid' },
  ]) {
    const result = evaluateRun(encode([trajectory[0]!, invalid, ...trajectory.slice(1)]), record);
    expect(result.status).toBe('fail');
    expect(result.violations).toContain('DUPLICATE_RISK_CLASSIFICATION');
    expect(result.violations).toContain('DISPATCH_WITHOUT_CLASSIFICATION');
    expect(result.incomplete).toContain('INVALID_RISK_CLASSIFICATION');
  }
});

it('accepts a failed click before classification without treating absent metadata as a read', () => {
  const failed = [trajectory[0]!, { ...trajectory[4]!, status: 'failure' }, { event: 'replay.failure' }];
  expect(evaluateRun(encode(failed), { ...record, state: 'failure' }).status).toBe('pass');
  const legacy = { ...trajectory[1]!, mutation: undefined };
  expect(evaluateRun(encode([failed[0]!, legacy, ...failed.slice(1)]), { ...record, state: 'failure' }))
    .toMatchObject({ status: 'unknown', incomplete: ['INVALID_RISK_CLASSIFICATION'] });
});

it('reads authenticated journal state without recovering it and prevents clearing dispatch uncertainty', () => {
  const dir = temp(); const journal = new Journal(dir, key);
  try {
    const run = journal.reserve('test', 'request', 'test', '1', {});
    journal.update(run.runId, 'dispatching');
    expect(readJournalRecord(dir, run.runId, key).state).toBe('dispatching');
    expect(() => readJournalRecord(dir, run.runId, 'wrong-key-with-at-least-32-characters')).toThrow(/authentication/);
    expect(() => journal.update(run.runId, 'running')).toThrow(/intent/);
    journal.update(run.runId, 'failure');
    expect(readJournalRecord(dir, run.runId, key).state).toBe('POST_OUTCOME_UNKNOWN');
    expect(() => journal.update(run.runId, 'success')).toThrow(/Terminal/);
    expect(journal.reserve('test', 'request', 'test', '1', {}).runId).toBe(run.runId);
  } finally { journal.close(); }
});


it('runs the CLI against authenticated evidence and rejects invalid input without echoing it', () => {
  const dir = temp(); const journal = new Journal(join(dir, 'journal'), key);
  const run = journal.reserve('test', 'request', 'test', '1', {});
  const logger = new RunLogger('replay', new Redactor(), dir, true, run.runId);
  try {
    for (const { event, ...data } of trajectory) logger.log(event, data);
    journal.update(run.runId, 'success');
    const args = ['--import', 'tsx', 'scripts/evaluate-run.ts', dir, run.runId];
    const env = { ...process.env, JOURNAL_HMAC_KEY: key };
    const output = execFileSync(process.execPath, args, { env, encoding: 'utf8' });
    expect(JSON.parse(output)).toMatchObject({ status: 'pass', mutationIntents: 1 });
    const invalid = spawnSync(process.execPath, [...args.slice(0, -1), '../PRIVATE'], { env, encoding: 'utf8' });
    expect(invalid.status).toBe(1); expect(invalid.stderr).not.toContain('PRIVATE');
  } finally { journal.close(); }
});
