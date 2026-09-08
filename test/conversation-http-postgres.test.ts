import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { journalDigest, type JournalSnapshot } from '../src/runtime/journal.js';
import { PostgresJournal } from '../src/runtime/postgres-journal.js';
import { loadProfile, profilePolicy } from '../src/runtime/profile.js';
import type { SubjectCredential } from '../src/server/auth.js';
import { ConversationStore } from '../src/server/conversations.js';
import { createApp } from '../src/server/http.js';
import { InvocationService } from '../src/server/service.js';
import { createPostgresFixture } from './fixtures/postgres.js';

const key = 'conversation-postgres-key-0123456789abcdef0123456789abcdef';
const ownerId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const ownerToken = 'owner-operator-token-000000000000001';
const otherToken = 'other-caller-token-0000000000000002';
const credentials: SubjectCredential[] = [
  { subjectId: ownerId, role: 'operator', token: ownerToken },
  { subjectId: otherId, role: 'caller', token: otherToken },
];

describe.sequential('conversation HTTP API with PostgreSQL journal', () => {
  let database: Awaited<ReturnType<typeof createPostgresFixture>>;
  let store: ConversationStore;
  let journal: PostgresJournal;
  let service: InvocationService;
  let evidenceDir: string;
  let server: Server;
  let origin: string;

  const request = async (path: string, options: { token?: string; method?: string; body?: unknown } = {}) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const url = new URL(path, origin);
      const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
      const pending = httpRequest({
        hostname: url.hostname, port: url.port, path: `${url.pathname}${url.search}`,
        method: options.method ?? 'GET',
        headers: {
          Host: '127.0.0.1:4180', Authorization: `Bearer ${options.token ?? ownerToken}`,
          ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }),
        },
      }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown;
          try { body = JSON.parse(text); } catch { body = undefined; }
          resolve({ status: response.statusCode!, body });
        });
      });
      pending.on('error', reject);
      pending.end(payload);
    });

  beforeEach(async () => {
    database = await createPostgresFixture();
    store = new ConversationStore(database.pool);
    await store.migrate();
    await PostgresJournal.migrate(database.pool);
    const snapshot: JournalSnapshot = { records: [], aliases: [] };
    const importId = randomUUID();
    const digest = journalDigest(key, snapshot);
    await PostgresJournal.importSnapshot(database.pool, key, snapshot, importId, digest);
    journal = await PostgresJournal.open(database.pool, key, importId, digest);
    evidenceDir = mkdtempSync(join(tmpdir(), 'conversation-http-pg-'));
    const profile = loadProfile('meridian');
    service = new InvocationService(journal, profilePolicy(profile), profile, evidenceDir, ['meridian-open-share']);
    const app = createApp(service, {
      callerToken: '', operatorToken: '', subjectTokens: credentials, conversations: store, port: 4180,
    });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP test server did not bind');
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await service?.close().catch(() => {});
    await journal?.close().catch(() => {});
    await database?.close();
    if (evidenceDir) rmSync(evidenceDir, { recursive: true, force: true });
  });

  it('uses one bounded journal transaction for a 100-event page with duplicate run links', async () => {
    const runs = [];
    for (const requestKey of ['pg-page-first', 'pg-page-second', 'pg-page-third']) {
      const run = await journal.reserve(`subject:${ownerId}`, requestKey, 'meridian-open-share', '1.0.0', {});
      await journal.update(run.runId, 'success');
      runs.push(run);
    }
    service.live.set(runs[0]!.runId, {
      state: 'success', inputs: { member: 'PRIVATE_INPUT_CANARY' }, started: 1, finished: 2,
      result: { status: 'success', outputs: { member: 'PRIVATE_OUTPUT_CANARY' } },
      approval: { pending: undefined, cancel() {} },
    } as never);
    const conversationId = randomUUID();
    await store.create(ownerId, conversationId);
    const linked: string[] = [];
    for (let index = 0; index < 106; index += 1) {
      const runId = (index < 100 ? runs[0] : runs[(index - 100) % runs.length])!.runId;
      linked.push(runId);
      await store.append(ownerId, conversationId, {
        id: randomUUID(), kind: 'run_linked', role: 'assistant', runId, expectedRevision: index,
      });
    }
    const getMany = vi.spyOn(journal, 'getMany');
    const get = vi.spyOn(journal, 'get');
    const transaction = vi.spyOn(journal as unknown as {
      transaction<T>(work: (client: unknown) => Promise<T>): Promise<T>;
    }, 'transaction');

    const first = await request(`/conversations/${conversationId}/events?limit=100`);

    expect(first.status).toBe(200);
    expect(first.body.events.map((event: { sequence: number }) => event.sequence)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    );
    expect(first.body.events.map((event: { runId: string }) => event.runId)).toEqual(linked.slice(0, 100));
    expect(first.body.events.map((event: { run: { runId: string } }) => event.run.runId)).toEqual(linked.slice(0, 100));
    expect(first.body.nextCursor).toBe(100);
    expect(JSON.stringify(first.body)).not.toMatch(/PRIVATE_(?:INPUT|OUTPUT)_CANARY/);
    expect(getMany).toHaveBeenCalledOnce();
    expect(getMany).toHaveBeenCalledWith([runs[0]!.runId]);
    expect(get).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledOnce();

    transaction.mockClear();
    const second = await request(`/conversations/${conversationId}/events?after=100&limit=100`);
    expect(second.status).toBe(200);
    expect(second.body.events.map((event: { sequence: number }) => event.sequence)).toEqual([101, 102, 103, 104, 105, 106]);
    expect(second.body.events.map((event: { runId: string }) => event.runId)).toEqual(linked.slice(100));
    expect(second.body.events.map((event: { run: { runId: string } }) => event.run.runId)).toEqual(linked.slice(100));
    expect(second.body).not.toHaveProperty('nextCursor');
    expect(getMany).toHaveBeenCalledTimes(2);
    expect(getMany).toHaveBeenLastCalledWith(runs.map(run => run.runId));
    expect(transaction).toHaveBeenCalledOnce();
    expect((await database.pool.query<{ count: string }>('SELECT count(*) FROM meridian_runs')).rows[0]?.count).toBe('3');
    expect((await store.get(ownerId, conversationId)).revision).toBe(106);
  });

  it('scopes non-queueing backpressure and keeps foreign, private, and missing links opaque', async () => {
    const ownerRun = await journal.reserve(`subject:${ownerId}`, 'pg-pressure-owner', 'meridian-open-share', '1.0.0', {});
    await journal.update(ownerRun.runId, 'success');
    const otherRun = await journal.reserve(`subject:${otherId}`, 'pg-pressure-other', 'meridian-open-share', '1.0.0', {});
    await journal.update(otherRun.runId, 'success');
    const privateRun = await journal.reserve(`subject:${otherId}`, 'pg-pressure-private', 'meridian-member-inquiry', '1.0.0', {},
      'replay', { invocationScope: 'member-identity' });
    await journal.update(privateRun.runId, 'success');
    service.live.set(privateRun.runId, {
      state: 'success', inputs: { searchValue: 'PRIVATE_PG_INPUT_CANARY' }, started: 1, finished: 2,
      result: { status: 'success', outputs: { members: [{ memberNumber: 'PRIVATE_PG_MEMBER_CANARY' }] } },
      approval: { pending: undefined, cancel() {} },
    } as never);
    const missing = randomUUID();
    const ownerConversations = [randomUUID(), randomUUID()];
    const otherPublic = randomUUID();
    const opaqueCases = [
      { owner: ownerId, token: ownerToken, conversationId: randomUUID(), runId: otherRun.runId },
      { owner: otherId, token: otherToken, conversationId: randomUUID(), runId: privateRun.runId },
      { owner: ownerId, token: ownerToken, conversationId: randomUUID(), runId: missing },
    ];
    for (const [owner, conversationId, runId] of [
      [ownerId, ownerConversations[0]!, ownerRun.runId],
      [ownerId, ownerConversations[1]!, ownerRun.runId],
      [otherId, otherPublic, otherRun.runId],
      ...opaqueCases.map(item => [item.owner, item.conversationId, item.runId]),
    ] as const) {
      await store.create(owner, conversationId);
      await store.append(owner, conversationId, {
        id: randomUUID(), kind: 'run_linked', role: 'assistant', runId, expectedRevision: 0,
      });
    }
    const rejectedAppendConversation = randomUUID();
    await store.create(ownerId, rejectedAppendConversation);
    const originalGetMany = journal.getMany.bind(journal);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let hold = true;
    vi.spyOn(journal, 'getMany').mockImplementation(async runIds => {
      const result = await originalGetMany(runIds);
      if (hold) {
        hold = false;
        enter();
        await blocked;
      }
      return result;
    });

    const first = request(`/conversations/${ownerConversations[0]}/events`);
    await entered;
    expect(await request(`/conversations/${ownerConversations[1]}/events`)).toEqual({
      status: 429, body: { error: 'Linked-run projection is busy' },
    });
    expect(await request(`/conversations/${rejectedAppendConversation}/events`, {
      method: 'POST', body: {
        id: randomUUID(), kind: 'run_linked', role: 'assistant', runId: ownerRun.runId, expectedRevision: 0,
      },
    })).toEqual({ status: 429, body: { error: 'Linked-run projection is busy' } });
    expect((await store.events(ownerId, rejectedAppendConversation)).events).toEqual([]);
    expect((await request(`/conversations/${otherPublic}/events`, { token: otherToken })).status).toBe(200);
    release();
    expect((await first).status).toBe(200);
    expect((await request(`/conversations/${ownerConversations[1]}/events`)).status).toBe(200);

    const opaque = [];
    for (const item of opaqueCases) opaque.push(await request(
      `/conversations/${item.conversationId}/events`, { token: item.token },
    ));
    expect(opaque).toEqual(Array.from({ length: 3 }, () => ({ status: 404, body: { error: 'Unknown run' } })));
    expect(JSON.stringify(opaque)).not.toMatch(/PRIVATE_PG_(?:INPUT|MEMBER)_CANARY/);
    expect(await request(`/conversations/${rejectedAppendConversation}/events`, {
      method: 'POST', body: {
        id: randomUUID(), kind: 'run_linked', role: 'assistant', runId: otherRun.runId, expectedRevision: 0,
      },
    })).toEqual({ status: 404, body: { error: 'Unknown run' } });
    expect(await request(`/conversations/${rejectedAppendConversation}/events`, {
      method: 'POST', body: { id: randomUUID(), kind: 'run_linked', role: 'assistant', expectedRevision: 0 },
    })).toEqual({ status: 400, body: { error: 'Conversation request does not match the contract' } });
    expect((await store.events(ownerId, rejectedAppendConversation)).events).toEqual([]);
    expect((await journal.get(ownerRun.runId))?.state).toBe('success');
    expect(await journal.list()).toHaveLength(3);
    const stored = await database.pool.query('SELECT kind, role, run_id FROM meridian_conversation_events ORDER BY sequence');
    expect(JSON.stringify(stored.rows)).not.toContain('PRIVATE_PG');
  });
});
