import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Journal, journalDigest, type RunJournal } from '../src/runtime/journal.js';
import { PostgresJournal } from '../src/runtime/postgres-journal.js';
import { createPostgresFixture } from './fixtures/postgres.js';
import { InvocationService } from '../src/server/service.js';
import { loadProfile, profilePolicy } from '../src/runtime/profile.js';

const key = 'bounded-read-batch-fixture-key-0123456789abcdef';
describe.each(['filesystem', 'postgres'] as const)('%s bounded journal reads', backend => {
  it('resolves direct and alias keys in one owner-scoped batch and reads unknown states once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'journal-batch-'));
    const database = backend === 'postgres' ? await createPostgresFixture() : undefined;
    let journal: RunJournal | undefined;
    try {
      if (database) {
        await PostgresJournal.migrate(database.pool);
        const snapshot = { records: [], aliases: [] };
        const importId = randomUUID(), digest = journalDigest(key, snapshot);
        await PostgresJournal.importSnapshot(database.pool, key, snapshot, importId, digest);
        journal = await PostgresJournal.open(database.pool, key, importId, digest);
      } else journal = new Journal(join(dir, 'journal'), key);
      const first = await journal.reserve('caller', 'first', 'read-only', '1.0.0', {});
      await journal.update(first.runId, 'success');
      await journal.bindReference('caller', 'alias', first.runId);
      const foreign = await journal.reserve('operator', 'foreign', 'other-read', '1.0.0', {});
      await journal.update(foreign.runId, 'success');
      const unknown = await journal.reserve('operator', 'unknown', 'write', '1.0.0', {});
      await journal.update(unknown.runId, 'dispatching');
      await journal.update(unknown.runId, 'failure');
      const privateRun = await journal.reserve('caller', 'private', 'meridian-member-inquiry', '1.0.0', {}, 'replay', { invocationScope: 'member-identity' });
      await journal.update(privateRun.runId, 'success');
      const priorKeys = Array.from({ length: 19 }, (_, index) => `prior-${index}`);
      for (const priorKey of priorKeys) await journal.bindReference('caller', priorKey, first.runId);
      const transaction = database ? vi.spyOn(journal as unknown as {
        transaction(work: unknown): Promise<unknown>;
      }, 'transaction') : undefined;
      const records = await journal.findRequests('caller', ['first', 'alias', 'foreign', 'missing', 'first']);
      expect([...records.keys()]).toEqual(['first', 'alias']);
      expect(records.get('first')?.runId).toBe(first.runId);
      expect(records.get('alias')?.runId).toBe(first.runId);
      if (transaction) expect(transaction).toHaveBeenCalledOnce();
      transaction?.mockClear();
      const profile = loadProfile('meridian');
      const service = new InvocationService(journal, profilePolicy(profile), profile, dir, ['meridian-member-record']);
      const contexts = await service.requestContexts('caller', ['first', 'alias', 'foreign', 'missing', 'private']);
      expect([...contexts.keys()]).toEqual(['first', 'alias', 'private']);
      expect(contexts.get('first')).toEqual({ runId: first.runId, capability: 'read-only', state: 'success' });
      expect(contexts.get('private')).toEqual({ accepted: true });
      if (transaction) expect(transaction).toHaveBeenCalledOnce();
      transaction?.mockClear();
      expect((await service.requestContexts('caller', priorKeys)).size).toBe(19);
      if (transaction) expect(transaction).toHaveBeenCalledOnce();
      transaction?.mockClear();
      expect(service.catalog('operator').length).toBeGreaterThan(0);
      expect(await service.availability('operator')).toHaveLength(7);
      if (transaction) expect(transaction).toHaveBeenCalledOnce();
      transaction?.mockClear();
      expect(await journal.unknownCapabilities(['write', 'read-only', 'write'])).toEqual(new Set(['write']));
      if (transaction) expect(transaction).toHaveBeenCalledOnce();
      await expect(async () => journal!.findRequests('caller', Array(101).fill('first'))).rejects.toMatchObject({ status: 400 });
      await expect(async () => journal!.findRequests('caller', ['bad key'])).rejects.toMatchObject({ status: 400 });
      await expect(async () => journal!.unknownCapabilities(Array(101).fill('write'))).rejects.toMatchObject({ status: 400 });
      transaction?.mockRestore();
      const original = journal.findRequests.bind(journal);
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      const read = vi.spyOn(journal, 'findRequests').mockImplementation(async (owner, keys) => {
        await held;
        return original(owner, keys);
      });
      const firstRead = service.requestContexts('caller', ['first']);
      await expect(service.requestContexts('caller', ['first'])).rejects.toMatchObject({ status: 429 });
      const others = ['a', 'b', 'c'].map(subject => service.requestContexts({ subjectId: subject, role: 'caller' }, []));
      await expect(service.requestContexts({ subjectId: 'd', role: 'caller' }, [])).rejects.toMatchObject({ status: 429 });
      expect(read).toHaveBeenCalledTimes(4);
      release();
      await Promise.all([firstRead, ...others]);
      read.mockRestore();
      expect((await service.requestContexts('caller', ['first'])).size).toBe(1);
    } finally {
      await Promise.resolve().then(() => journal?.close()).catch(() => {});
      await database?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
