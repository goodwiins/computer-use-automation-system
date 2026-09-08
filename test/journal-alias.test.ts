import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync, statSync, fsyncSync, fstatSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal, readJournalSnapshot } from '../src/runtime/journal.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, fsyncSync: vi.fn(actual.fsyncSync) };
});
const actualFsync = vi.mocked(fsyncSync).getMockImplementation()!;

it('persists caller-scoped aliases without changing terminal evidence and rejects changed requests after restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-alias-'));
  const key = 'h'.repeat(64), request = { amount: '1.00' };
  let journal = new Journal(dir, key);
  try {
    const original = journal.reserve('caller', 'A', 'write', '1.0.0', request);
    journal.update(original.runId, 'success');
    const path = join(dir, `${original.runId}.json`);
    const before = readFileSync(path, 'utf8');
    journal.bindReference('caller', 'B', original.runId);
    expect(() => journal.bindReference('caller', 'B', original.runId)).not.toThrow();
    expect(journal.findRequest('operator', 'B')).toBeUndefined();
    expect(() => journal.bindReference('operator', 'forged', original.runId)).toThrow('another principal');
    expect(journal.lookup('caller', 'B', request).existing?.runId).toBe(original.runId);
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(journal.records.size).toBe(1);
    const aliasPath = join(dir, 'aliases', readdirSync(join(dir, 'aliases'))[0]!);
    expect(statSync(aliasPath).mode & 0o777).toBe(0o600);
    journal.close();
    journal = new Journal(dir, key);
    expect(journal.lookup('caller', 'B', request).existing?.runId).toBe(original.runId);
    expect(() => journal.lookup('caller', 'B', { amount: '2.00' })).toThrow('another request');
    expect(readFileSync(path, 'utf8')).toBe(before);
    const envelope = JSON.parse(readFileSync(aliasPath, 'utf8'));
    envelope.record.request = 'f'.repeat(64);
    journal.close();
    writeFileSync(aliasPath, JSON.stringify(envelope));
    expect(() => new Journal(dir, key)).toThrow('Journal authentication failed');
    // Failed startup must release its lock for inspection/recovery.
    expect(readdirSync(dir)).not.toContain('server.lock');
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('batches filesystem aliases with the same owner, bounds, and quarantine contract', () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-alias-batch-'));
  const journal = new Journal(dir, 'h'.repeat(64));
  try {
    const run = journal.reserve('caller', 'direct', 'write', '1.0.0', {});
    journal.update(run.runId, 'dispatching');
    journal.update(run.runId, 'failure');
    journal.bindReference('caller', 'alias', run.runId);
    const before = readJournalSnapshot(dir, 'h'.repeat(64));
    expect([...journal.findRequests('caller', ['alias', 'direct', 'missing', 'alias']).keys()]).toEqual(['alias', 'direct']);
    expect(journal.findRequests('operator', ['alias', 'direct'])).toEqual(new Map());
    expect(journal.unknownCapabilities(['read', 'write', 'write'])).toEqual(new Set(['write']));
    expect(() => journal.findRequests('caller', Array(101).fill('direct'))).toThrow();
    expect(() => journal.findRequests('caller', ['invalid key'])).toThrow();
    expect(() => journal.unknownCapabilities(Array(101).fill('write'))).toThrow();
    expect(readJournalSnapshot(dir, 'h'.repeat(64))).toEqual(before);
    journal.close();
    expect(() => journal.findRequests('caller', ['alias'])).toThrow('Journal is closed');
    expect(() => journal.unknownCapabilities(['write'])).toThrow('Journal is closed');
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('does not claim a binding when persistence fails before the alias is written', () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-alias-failure-'));
  const journal = new Journal(dir, 'h'.repeat(64));
  try {
    const original = journal.reserve('caller', 'A', 'write', '1.0.0', {});
    journal.update(original.runId, 'success');
    const path = join(dir, `${original.runId}.json`), before = readFileSync(path, 'utf8');
    writeFileSync(join(dir, 'aliases'), 'blocked');
    expect(() => journal.bindReference('caller', 'B', original.runId)).toThrow();
    expect(journal.findRequest('caller', 'B')).toBeUndefined();
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(journal.records.size).toBe(1);
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('rejects bindReference through the initial health gate after close', () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-alias-closed-'));
  const journal = new Journal(dir, 'h'.repeat(64));
  try {
    journal.close();
    expect(() => journal.bindReference('caller', 'closed-alias', randomUUID())).toThrow('Journal is closed');
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('quarantines a business outcome after durable dispatch intent but preserves one before intent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-business-outcome-'));
  const journal = new Journal(dir, 'h'.repeat(64));
  try {
    const before = journal.reserve('caller', 'before-business', 'write', '1.0.0', {});
    journal.update(before.runId, 'business_outcome');
    expect(journal.get(before.runId)?.state).toBe('business_outcome');

    const after = journal.reserve('caller', 'after-business', 'write', '1.0.0', {});
    journal.update(after.runId, 'dispatching');
    journal.update(after.runId, 'business_outcome');
    expect(journal.get(after.runId)?.state).toBe('POST_OUTCOME_UNKNOWN');
    expect(journal.hasUnknown('write')).toBe(true);
    expect(() => journal.reserve('caller', 'fresh-business', 'write', '1.0.0', {})).toThrow(/unknown posting outcome/);
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('reads one bounded, deduplicated run batch without changing journal state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-batch-'));
  const journal = new Journal(dir, 'h'.repeat(64));
  try {
    const first = journal.reserve('caller', 'batch-first', 'read', '1.0.0', {});
    journal.update(first.runId, 'success');
    const second = journal.reserve('caller', 'batch-second', 'read', '1.0.0', {});
    journal.update(second.runId, 'failure');
    const missing = randomUUID();
    const before = [...journal.records.values()];

    expect([...journal.getMany([second.runId, first.runId, second.runId, missing])]).toEqual([
      [second.runId, { ...second, state: 'failure' }],
      [first.runId, { ...first, state: 'success' }],
    ]);
    expect([...journal.records.values()]).toEqual(before);
    expect(() => journal.getMany(Array.from({ length: 101 }, () => first.runId))).toThrow('batch');
    expect(() => journal.getMany(['AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'])).toThrow('run');
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('ignores an orphan alias publication temp during an authenticated snapshot read', () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-alias-snapshot-temp-'));
  const key = 'h'.repeat(64);
  const journal = new Journal(dir, key);
  try {
    const original = journal.reserve('caller', 'A', 'write', '1.0.0', {});
    journal.update(original.runId, 'success');
    journal.bindReference('caller', 'B', original.runId);
    const aliasPath = join(dir, 'aliases', readdirSync(join(dir, 'aliases'))[0]!);
    const tempPath = `${aliasPath}.${randomUUID()}.tmp`;
    writeFileSync(tempPath, readFileSync(aliasPath, 'utf8'));
    journal.close();

    expect(readJournalSnapshot(dir, key).aliases).toHaveLength(1);
    writeFileSync(join(dir, 'aliases', 'unrelated.tmp'), 'garbage');
    expect(() => readJournalSnapshot(dir, key)).toThrow(/Invalid journal snapshot entry/);
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('fails closed after alias rename when directory fsync fails, then recovers the binding on restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'journal-alias-publish-'));
  const key = 'h'.repeat(64), request = { amount: '1.00' };
  let journal = new Journal(dir, key);
  try {
    const original = journal.reserve('caller', 'A', 'write', '1.0.0', request);
    journal.update(original.runId, 'success');
    const path = join(dir, `${original.runId}.json`), before = readFileSync(path, 'utf8');
    const aliasesDir = join(dir, 'aliases');
    let armed = true;
    vi.mocked(fsyncSync).mockImplementation(fd => {
      if (armed && fstatSync(fd).isDirectory() && existsSync(aliasesDir)
        && readdirSync(aliasesDir).some(file => file.endsWith('.json'))) {
        armed = false;
        throw new Error('after-rename directory fsync failed');
      }
      actualFsync(fd);
    });
    expect(() => journal.bindReference('caller', 'B', original.runId)).toThrow('after-rename');
    expect(readdirSync(aliasesDir).filter(file => file.endsWith('.json'))).toHaveLength(1);
    expect(() => journal.findRequest('caller', 'B')).toThrow('restart required');
    expect(() => journal.reserve('caller', 'B', 'write', '1.0.0', { amount: '2.00' })).toThrow('restart required');
    expect(journal.records.size).toBe(1);
    expect(readFileSync(path, 'utf8')).toBe(before);
    journal.close();
    journal = new Journal(dir, key);
    expect(journal.lookup('caller', 'B', request).existing?.runId).toBe(original.runId);
    expect(() => journal.lookup('caller', 'B', { amount: '2.00' })).toThrow('another request');
    expect(readFileSync(path, 'utf8')).toBe(before);
  } finally {
    vi.mocked(fsyncSync).mockImplementation(actualFsync);
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
