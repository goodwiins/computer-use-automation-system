import { request as httpRequest, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReplayResult } from '../src/replay/outcomes.js';
import { createApp } from '../src/server/http.js';
import { InvocationService } from '../src/server/service.js';
import { PostgresJournal } from '../src/runtime/postgres-journal.js';
import { journalDigest, type JournalRecord, type JournalSnapshot } from '../src/runtime/journal.js';
import { loadProfile, profilePolicy } from '../src/runtime/profile.js';
import * as runtime from '../src/runtime/run.js';
import { Redactor } from '../src/safety/redact.js';
import { createPostgresFixture } from './fixtures/postgres.js';

const key = 'subject-http-test-key-0123456789abcdef0123456789abcdef';
const artifactId = 'hand-lookup-member-balance';
const caller = { subjectId: '11111111-1111-4111-8111-111111111111', role: 'caller' } as const;
const other = { subjectId: '22222222-2222-4222-8222-222222222222', role: 'caller' } as const;
const operator = { subjectId: '33333333-3333-4333-8333-333333333333', role: 'operator' } as const;
const callerToken = 'c'.repeat(32);
const otherToken = 'b'.repeat(32);
const operatorToken = 'o'.repeat(32);
const credentials = [
  { ...caller, token: callerToken },
  { ...other, token: otherToken },
  { ...operator, token: operatorToken },
];

const servers: Server[] = [];
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0).reverse()) await close();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function openFixture() {
  const database = await createPostgresFixture();
  await PostgresJournal.migrate(database.pool);
  const snapshot: JournalSnapshot = { records: [], aliases: [] };
  const importId = randomUUID();
  const digest = journalDigest(key, snapshot);
  await PostgresJournal.importSnapshot(database.pool, key, snapshot, importId, digest);
  const journal = await PostgresJournal.open(database.pool, key, importId, digest);
  const dir = mkdtempSync(join(tmpdir(), 'subject-http-'));
  const artifactDir = join(dir, 'artifacts');
  mkdirSync(artifactDir);
  writeFileSync(join(artifactDir, 'lookup.json'), readFileSync('test/fixtures/hand-lookup.json'));
  const profile = loadProfile('cu-nexus');
  const service = new InvocationService(journal, profilePolicy(profile), profile, dir, [artifactId], artifactDir);
  cleanups.push(async () => {
    await service.close();
    await journal.close();
    await database.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { database, journal, service, dir };
}

async function start(service: InvocationService) {
  const app = createApp(service, {
    callerToken: '', operatorToken: '', subjectTokens: credentials, port: 4180,
  });
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected TCP test server');
  return (token: string, requestKey?: string) => new Promise<{ status: number; headers: Headers; text: string; json?: unknown }>((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1', port: address.port, path: '/api/chat/request', method: 'GET',
      headers: {
        Host: '127.0.0.1:4180', Authorization: `Bearer ${token}`,
        ...(requestKey === undefined ? {} : { 'Idempotency-Key': requestKey }),
      },
    }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown;
        try { json = JSON.parse(text); } catch { /* preserve non-JSON response text */ }
        resolve({ status: response.statusCode!, headers: new Headers(response.headers as Record<string, string>), text, json });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

function successResult(runId: string, evidenceDir: string): ReplayResult {
  return { status: 'success', outputs: { savingsBalance: 'safe' }, runId, evidenceDir, recoveries: [] };
}

describe.sequential('subject HTTP recovery with PostgreSQL authority', () => {
  it('looks up direct, aliased, UNKNOWN, and subject-owned operator requests without execution writes', async () => {
    const { journal, service } = await openFixture();
    const direct = await journal.reserve(`subject:${caller.subjectId}`, 'pg-direct', artifactId, '1.0.0', {});
    await journal.update(direct.runId, 'success');
    const unknown = await journal.reserve(`subject:${caller.subjectId}`, 'pg-unknown', artifactId, '1.0.0', {});
    await journal.update(unknown.runId, 'dispatching');
    await journal.update(unknown.runId, 'failure');
    await journal.bindReference(`subject:${caller.subjectId}`, 'pg-alias', direct.runId);
    const operatorSubject = await journal.reserve(`subject:${operator.subjectId}`, 'pg-operator-subject', 'subject-other', '1.0.0', {});
    await journal.update(operatorSubject.runId, 'success');
    const legacyOperator = await journal.reserve('operator', 'pg-legacy-operator', 'subject-other', '1.0.0', {});
    await journal.update(legacyOperator.runId, 'success');
    const foreign = await journal.reserve(`subject:${other.subjectId}`, 'pg-foreign', 'subject-other', '1.0.0', {});
    await journal.update(foreign.runId, 'success');
    const invoke = vi.spyOn(service, 'invoke');
    const bindReference = vi.spyOn(journal, 'bindReference');
    const request = await start(service);

    const directResponse = await request(callerToken, 'pg-direct');
    expect(directResponse.status).toBe(200);
    expect(directResponse.json).toEqual({ kind: 'run', runId: direct.runId, capability: artifactId, state: 'success' });
    expect(directResponse.headers.get('cache-control')).toContain('no-store');
    expect(await request(callerToken, 'pg-alias')).toMatchObject({
      status: 200,
      json: { kind: 'run', runId: direct.runId, capability: artifactId, state: 'success' },
    });
    expect(await request(callerToken, 'pg-unknown')).toMatchObject({
      status: 200,
      json: { kind: 'run', runId: unknown.runId, capability: artifactId, state: 'POST_OUTCOME_UNKNOWN' },
    });
    expect(await request(operatorToken, 'pg-operator-subject')).toMatchObject({
      status: 200,
      json: { kind: 'run', runId: operatorSubject.runId, capability: 'subject-other', state: 'success' },
    });
    const legacyResponse = await request(operatorToken, 'pg-legacy-operator');
    expect(legacyResponse.status).toBe(404);
    expect(legacyResponse.headers.get('cache-control')).toContain('no-store');
    const foreignResponse = await request(callerToken, 'pg-foreign');
    expect(foreignResponse.status).toBe(404);
    expect(foreignResponse.headers.get('cache-control')).toContain('no-store');
    const missingResponse = await request(callerToken, 'pg-missing');
    expect(missingResponse.status).toBe(404);
    expect(missingResponse.headers.get('cache-control')).toContain('no-store');
    expect((await request(callerToken)).status).toBe(400);

    const findRequest = vi.spyOn(journal, 'findRequest').mockRejectedValue(new Error('PRIVATE PG storage failure'));
    const unavailable = await request(callerToken, 'pg-direct');
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get('cache-control')).toContain('no-store');
    expect(unavailable.text).not.toContain('PRIVATE PG storage failure');
    expect(findRequest).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
    expect(bindReference).not.toHaveBeenCalled();
    expect(await journal.list()).toHaveLength(5);
  });

  it('serializes delayed concurrent same-key admission and starts one runtime', async () => {
    const { journal, service, dir } = await openFixture();
    const originalLookup = journal.lookup.bind(journal);
    let lookupStarted!: () => void;
    const lookupReady = new Promise<void>(resolve => { lookupStarted = resolve; });
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>(resolve => { releaseLookup = resolve; });
    vi.spyOn(journal, 'lookup').mockImplementation(async (...args) => {
      lookupStarted();
      await lookupGate;
      return originalLookup(...args);
    });
    const create = vi.spyOn(runtime, 'createRuntime').mockReturnValue({
      surface: { mutationDispatched: false }, promptRedactor: new Redactor(), close: async () => {},
    } as unknown as ReturnType<typeof runtime.createRuntime>);
    let releaseReplay!: (result: ReplayResult) => void;
    vi.spyOn(runtime, 'executeReplay').mockImplementation(() => new Promise(resolve => { releaseReplay = resolve; }));
    const args = { memberId: '123' };
    const first = service.invoke('caller', artifactId, args, 'pg-same-key');
    await lookupReady;
    const second = service.invoke('caller', artifactId, args, 'pg-same-key');
    expect(create).not.toHaveBeenCalled();
    releaseLookup();
    const accepted = await Promise.all([first, second]);
    expect(accepted[0]).not.toHaveProperty('reused');
    expect(accepted[1]).toEqual({ runId: accepted[0]!.runId, reused: true });
    expect(create).toHaveBeenCalledOnce();
    expect(await journal.list()).toHaveLength(1);
    releaseReplay(successResult(accepted[0]!.runId, dir));
    await service.close();
  });

  it('admits one different key while the active run is pending and leaves no orphan reservation', async () => {
    const { journal, service, dir } = await openFixture();
    const create = vi.spyOn(runtime, 'createRuntime').mockReturnValue({
      surface: { mutationDispatched: false }, promptRedactor: new Redactor(), close: async () => {},
    } as unknown as ReturnType<typeof runtime.createRuntime>);
    let releaseReplay!: (result: ReplayResult) => void;
    vi.spyOn(runtime, 'executeReplay').mockImplementation(() => new Promise(resolve => { releaseReplay = resolve; }));
    const first = await service.invoke('caller', artifactId, { memberId: '123' }, 'pg-first-key');
    const second = service.invoke('caller', artifactId, { memberId: '123' }, 'pg-second-key');
    await expect(second).rejects.toMatchObject({ status: 429 });
    expect(create).toHaveBeenCalledOnce();
    expect(await journal.list()).toHaveLength(1);
    expect((await journal.list())[0]!.runId).toBe(first.runId);
    releaseReplay(successResult(first.runId, dir));
    await service.close();
  });

  it('retains a cleanup-failed authority and blocks fresh admission while preserving same-key lookup', async () => {
    const { journal, service, dir } = await openFixture();
    const create = vi.spyOn(runtime, 'createRuntime').mockReturnValue({
      surface: { mutationDispatched: false }, promptRedactor: new Redactor(), close: async () => { throw new Error('PRIVATE cleanup failure'); },
    } as unknown as ReturnType<typeof runtime.createRuntime>);
    vi.spyOn(runtime, 'executeReplay').mockImplementation(async (_artifact, _params, candidate) => {
      await runtime.closeRuntime(candidate);
      return successResult(candidate.logger.runId, dir);
    });
    const accepted = await service.invoke('caller', artifactId, { memberId: '123' }, 'pg-cleanup-key');
    await vi.waitFor(() => expect(service.cleanupFailedState).toBe(true));
    expect(create).toHaveBeenCalledOnce();
    expect(await service.invoke('caller', artifactId, { memberId: '123' }, 'pg-cleanup-key'))
      .toEqual({ runId: accepted.runId, reused: true });
    await expect(service.invoke('caller', artifactId, { memberId: '123' }, 'pg-cleanup-new-key'))
      .rejects.toMatchObject({ status: 503 });
    expect(await journal.list()).toHaveLength(1);
    await service.close();
  });
});
