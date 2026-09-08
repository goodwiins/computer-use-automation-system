import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { Journal, RequestError } from '../src/runtime/journal.js';
import { loadProfile, profilePolicy } from '../src/runtime/profile.js';
import { InvocationService } from '../src/server/service.js';

const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'invocation-rejection-'));
  const artifacts = join(dir, 'artifacts');
  mkdirSync(artifacts);
  const artifact = JSON.parse(readFileSync('test/fixtures/hand-lookup.json', 'utf8'));
  writeFileSync(join(artifacts, 'lookup.json'), JSON.stringify(artifact));
  const journal = new Journal(join(dir, 'journal'), 'r'.repeat(64));
  const profile = loadProfile('cu-nexus');
  const service = new InvocationService(journal, profilePolicy(profile), profile, dir, [artifact.id], artifacts);
  cleanup.push(() => { journal.close(); rmSync(dir, { recursive: true, force: true }); });
  return { journal, service, artifact };
}

it('confirms invalid arguments were rejected only when the original request key has no accepted record', async () => {
  const { journal, service, artifact } = fixture();
  await expect(service.invoke('caller', artifact.id, {}, 'invalid')).rejects.toMatchObject({ status: 400, acceptance: 'rejected' });
  expect(journal.list()).toEqual([]);
  const previous = journal.reserve('caller', 'existing', artifact.id, artifact.version, {});
  journal.update(previous.runId, 'success');
  const error = await service.invoke('caller', artifact.id, {}, 'existing').catch(error => error);
  expect(error).toMatchObject({ status: 400 });
  expect(error.acceptance).toBeUndefined();
  expect(journal.findRequest('caller', 'existing')?.runId).toBe(previous.runId);
});

it('confirms new unauthorized requests without clearing an original lookup hold', async () => {
  const { service, journal } = fixture();
  await expect(service.invoke('caller', 'restricted', {}, 'new')).rejects.toMatchObject({ status: 403, acceptance: 'rejected' });
  const error = await service.invoke('caller', 'restricted', {}, 'lookup', 'TELLER', true).catch(error => error);
  expect(error).toMatchObject({ status: 403 });
  expect(error.acceptance).toBeUndefined();
  expect(journal.list()).toEqual([]);
});

it('does not claim non-acceptance when the journal cannot confirm the original key', async () => {
  const { service, journal, artifact } = fixture();
  vi.spyOn(journal, 'findRequest').mockImplementation(() => { throw new Error('journal unavailable'); });
  const error = await service.invoke('caller', artifact.id, {}, 'invalid').catch(error => error);
  expect(error).toMatchObject({ status: 400 });
  expect(error.acceptance).toBeUndefined();
});

it('never classifies a reservation-stage rejection by status alone', async () => {
  const { service, journal, artifact } = fixture();
  const reserve = journal.reserve.bind(journal);
  vi.spyOn(journal, 'reserve').mockImplementation((...args) => {
    reserve(...args);
    throw new RequestError(400, 'failure after reservation');
  });
  const error = await service.invoke('caller', artifact.id, { memberId: '123' }, 'accepted').catch(error => error);
  expect(error).toMatchObject({ status: 400 });
  expect(error.acceptance).toBeUndefined();
  expect(journal.findRequest('caller', 'accepted')).toBeDefined();
});
