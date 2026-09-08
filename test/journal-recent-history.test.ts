import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { Journal, journalDigest, type JournalRecord, type RunJournal } from '../src/runtime/journal.js';
import { PostgresJournal } from '../src/runtime/postgres-journal.js';
import { createPostgresFixture } from './fixtures/postgres.js';
import { InvocationService } from '../src/server/service.js';
import { loadProfile, profilePolicy } from '../src/runtime/profile.js';

const key = 'recent-history-test-key-with-at-least-32-characters';
const a = { role: 'caller' as const, subjectId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' };
const b = { role: 'caller' as const, subjectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };

describe.each(['filesystem', 'postgres'] as const)('%s owner-scoped recent history', backend => {
  it('bounds visible history before projection, preserves old actionable private runs, and isolates legacy operators', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'recent-history-'));
    const source = new Journal(join(dir, 'journal'), key);
    const records: JournalRecord[] = [];
    const add = (caller: string, privateRun = false, legacyScope = false) => {
      const reserved = source.reserve(caller, `key-${records.length}`, privateRun ? 'meridian-member-inquiry' : 'read-only', '1.0.0', {}, 'replay',
        privateRun && !legacyScope ? { invocationScope: 'member-identity' } : {});
      source.update(reserved.runId, 'success');
      const record = source.get(reserved.runId)!;
      if (legacyScope) delete record.invocationScope;
      record.createdAt = new Date(Date.UTC(2026, 0, 1) + records.length * 1000).toISOString();
      records.push(record);
      return record;
    };
    const actionable = add(`subject:${a.subjectId}`, true);
    const own = Array.from({ length: 105 }, () => add(`subject:${a.subjectId}`));
    // Equal timestamps use UUID ordering, not insertion order or database plan.
    own[103]!.createdAt = own[104]!.createdAt;
    own.splice(103, 2, ...own.slice(103).sort((left, right) => left.runId < right.runId ? -1 : 1));
    // Newer private and foreign rows must not consume the caller's limit.
    for (let i = 0; i < 105; i++) add(`subject:${a.subjectId}`, true);
    add(`subject:${a.subjectId}`, true, true);
    const foreign = Array.from({ length: 105 }, () => add(`subject:${b.subjectId}`));
    const legacy = [add('caller'), add('operator'), add('another-legacy-owner')];
    const database = backend === 'postgres' ? await createPostgresFixture() : undefined;
    let journal: RunJournal = source;
    try {
      if (database) {
        await PostgresJournal.migrate(database.pool);
        const snapshot = { records, aliases: [] };
        const importId = randomUUID(), digest = journalDigest(key, snapshot);
        await PostgresJournal.importSnapshot(database.pool, key, snapshot, importId, digest);
        journal = await PostgresJournal.open(database.pool, key, importId, digest);
      }
      const profile = loadProfile('meridian');
      const service = new InvocationService(journal, profilePolicy(profile), profile, dir, []);
      const unbounded = vi.spyOn(journal, 'list');
      const history = await service.history(a);
      expect(history.map(run => run.runId)).toEqual(own.slice(5).map(run => run.runId));
      expect(unbounded).not.toHaveBeenCalled();
      expect((await service.history(b)).map(run => run.runId)).toEqual(foreign.slice(5).map(run => run.runId));
      expect((await service.history('operator')).map(run => run.runId)).toEqual(legacy.map(run => run.runId));
      expect((await service.history('caller')).map(run => run.runId)).toEqual([legacy[0]!.runId]);
      expect((await service.get(a, own[0]!.runId)).runId).toBe(own[0]!.runId);
      expect((await journal.list())).toHaveLength(records.length);

      service.live.set(actionable.runId, {
        state: 'awaiting-human', inputs: {}, started: 1,
        approval: { pending: { id: randomUUID(), expiresAt: Date.now() + 60_000,
          request: { kind: 'risk_approval' } } } as never,
      });
      const operatorHistory = await service.history({ ...a, role: 'operator' });
      expect(operatorHistory).toHaveLength(100);
      expect(operatorHistory[0]).toMatchObject({ runId: actionable.runId, intervention: { request: { goal: 'Complete the linked identity check.' } } });
      expect(operatorHistory.slice(1).map(run => run.runId)).toEqual(own.slice(6).map(run => run.runId));
      expect((await service.history(a)).map(run => run.runId)).toEqual(own.slice(5).map(run => run.runId));

      if (database) {
        const client = await database.pool.connect();
        const query = vi.spyOn(client, 'query');
        client.release();
        await service.history(a);
        const index = query.mock.calls.findIndex(([sql]) => typeof sql === 'string' && /FROM meridian_runs/.test(sql));
        expect(index).toBeGreaterThanOrEqual(0);
        const sql = String(query.mock.calls[index]![0]);
        expect(sql).toMatch(/WHERE[\s\S]*caller\s*=\s*\$1/);
        expect(sql).toMatch(/LIMIT\s+(?:100|\$\d+)/);
        const result = await query.mock.results[index]!.value;
        expect(result.rows).toHaveLength(100);
        expect(result.rows.every((row: { caller: string }) => row.caller === `subject:${a.subjectId}`)).toBe(true);
        query.mockRestore();
      }
    } finally {
      vi.restoreAllMocks();
      await Promise.resolve(journal.close()).catch(() => {});
      if (journal !== source) source.close();
      await database?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
