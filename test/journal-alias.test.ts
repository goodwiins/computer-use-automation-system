import { expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync, statSync, fsyncSync, fstatSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/runtime/journal.js';

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
