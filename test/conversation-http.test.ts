import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Journal, RequestError } from '../src/runtime/journal.js';
import { loadProfile, profilePolicy } from '../src/runtime/profile.js';
import type { SubjectCredential } from '../src/server/auth.js';
import { ConversationStore } from '../src/server/conversations.js';
import { createApp } from '../src/server/http.js';
import { InvocationService } from '../src/server/service.js';
import { createPostgresFixture } from './fixtures/postgres.js';

const ownerId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const ownerToken = 'owner-operator-token-000000000000001';
const otherToken = 'other-caller-token-0000000000000002';
const credentials: SubjectCredential[] = [
  { subjectId: ownerId, role: 'operator', token: ownerToken },
  { subjectId: otherId, role: 'caller', token: otherToken },
];

describe.sequential('conversation HTTP API', () => {
  let database: Awaited<ReturnType<typeof createPostgresFixture>>;
  let store: ConversationStore;
  let evidenceDir: string;
  let journal: Journal;
  let service: InvocationService;
  const servers: Server[] = [];

  const newService = (dir = evidenceDir) => {
    const profile = loadProfile('meridian');
    journal = new Journal(join(dir, 'journal'), 'h'.repeat(64));
    service = new InvocationService(journal, profilePolicy(profile), profile, dir, ['meridian-member-inquiry']);
    return service;
  };

  const listen = async (conversations: ConversationStore | null | undefined = store, subjectTokens: SubjectCredential[] | null | undefined = credentials) => {
    const app = createApp(service, {
      callerToken: 'c'.repeat(32), operatorToken: 'o'.repeat(32), subjectTokens: subjectTokens ?? undefined,
      conversations: conversations ?? undefined, port: 4180,
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    servers.push(server);
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('HTTP test server did not bind');
    return `http://127.0.0.1:${address.port}`;
  };

  const request = async (origin: string, path: string, options: {
    token?: string; method?: string; body?: unknown;
  } = {}) => new Promise<{ status: number; body: any; headers: Record<string, string | string[] | undefined> }>((resolve, reject) => {
    const url = new URL(path, origin);
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const request = httpRequest({
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
        const result = { status: response.statusCode!, body } as {
          status: number; body: any; headers: Record<string, string | string[] | undefined>;
        };
        Object.defineProperty(result, 'headers', { value: response.headers, enumerable: false });
        resolve(result);
      });
    });
    request.on('error', reject);
    request.end(payload);
  });

  const quotaSnapshot = async (owner: string) => {
    const result = await database.pool.query<{ conversation_count: string; event_count: string; rate_tokens: number; rate_refilled_at: Date }>(
      `SELECT conversation_count, event_count, rate_tokens, rate_refilled_at
       FROM meridian_conversation_subject_quotas WHERE owner_id = $1`, [owner],
    );
    const row = result.rows[0];
    if (!row) throw new Error('quota row missing');
    return {
      conversationCount: Number(row.conversation_count), eventCount: Number(row.event_count),
      rateTokens: row.rate_tokens, rateRefilledAt: row.rate_refilled_at,
    };
  };

  const setRate = async (owner: string, tokens: number) => {
    await database.pool.query(
      `UPDATE meridian_conversation_subject_quotas
       SET rate_tokens = $2, rate_refilled_at = clock_timestamp() WHERE owner_id = $1`,
      [owner, tokens],
    );
  };

  const seedConversations = async (owner: string, count: number, prefix: string) => {
    await database.pool.query(`
      INSERT INTO meridian_conversations (id, owner_id)
      SELECT ($3 || lpad(value::text, 12, '0'))::uuid, $1
      FROM generate_series(1, $2::int) AS values(value)
    `, [owner, count, prefix]);
  };

  const seedEvents = async (owner: string, conversationId: string, count: number, prefix: string) => {
    await database.pool.query(`
      INSERT INTO meridian_conversation_events (id, conversation_id, sequence, kind, role)
      SELECT ($3 || lpad(value::text, 12, '0'))::uuid, $1, value, 'message_omitted', 'user'
      FROM generate_series(1, $2::int) AS values(value)
    `, [conversationId, count, prefix]);
    await database.pool.query('UPDATE meridian_conversations SET revision = $2 WHERE id = $1', [conversationId, count]);
  };

  beforeEach(async () => {
    database = await createPostgresFixture();
    store = new ConversationStore(database.pool);
    await store.migrate();
    evidenceDir = mkdtempSync(join(tmpdir(), 'conversation-http-'));
    newService();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await service.close().catch(() => {});
    journal.close();
    await database.close();
    rmSync(evidenceDir, { recursive: true, force: true });
  });

  it('creates, pages, archives, appends, reloads, and deletes owner-scoped conversations without changing run state', async () => {
    const unknown = journal.reserve(`subject:${ownerId}`, 'unknown-key', 'meridian-open-share', '1.0.0', {});
    journal.update(unknown.runId, 'dispatching');
    journal.close();
    newService();
    expect(journal.records.get(unknown.runId)?.state).toBe('POST_OUTCOME_UNKNOWN');

    const origin = await listen();
    const ids = [
      '10000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000002',
      '10000000-0000-4000-8000-000000000003',
    ];
    for (const id of ids) expect((await request(origin, '/conversations', { method: 'POST', body: { id } })).status).toBe(201);
    const retry = await request(origin, '/conversations', { method: 'POST', body: { id: ids[0] } });
    expect(retry).toMatchObject({ status: 201, body: { id: ids[0], archived: false, revision: 0 } });

    const page1 = await request(origin, '/conversations?limit=2');
    expect(page1.body.conversations.map((item: { id: string }) => item.id)).toEqual(ids.slice(0, 2));
    expect(page1.body.nextCursor).toBe(ids[1]);
    const page2 = await request(origin, `/conversations?limit=2&after=${ids[1]}`);
    expect(page2.body.conversations.map((item: { id: string }) => item.id)).toEqual([ids[2]]);
    expect(await request(origin, `/conversations/${ids[0]}`)).toMatchObject({ status: 200, body: { id: ids[0] } });

    const firstEventId = randomUUID();
    const firstEvent = await request(origin, `/conversations/${ids[0]}/events`, {
      method: 'POST', body: { id: firstEventId, kind: 'message_omitted', role: 'user', expectedRevision: 0 },
    });
    expect(firstEvent).toMatchObject({
      status: 201,
      body: { id: firstEventId, sequence: 1, kind: 'message_omitted', role: 'user', content: 'Message text was not saved.' },
    });
    expect((await request(origin, `/conversations/${ids[0]}`, {
      method: 'PATCH', body: { archived: true, expectedRevision: 0 },
    })).status).toBe(409);
    expect(await request(origin, `/conversations/${ids[0]}`, {
      method: 'PATCH', body: { archived: true, expectedRevision: 1 },
    })).toMatchObject({ status: 200, body: { archived: true, revision: 2 } });
    expect((await request(origin, `/conversations/${ids[0]}/events`, {
      method: 'POST', body: { id: randomUUID(), kind: 'message_omitted', role: 'assistant', expectedRevision: 2 },
    })).status).toBe(409);
    expect(await request(origin, `/conversations/${ids[0]}`, {
      method: 'PATCH', body: { archived: false, expectedRevision: 2 },
    })).toMatchObject({ status: 200, body: { archived: false, revision: 3 } });
    const secondEventId = randomUUID();
    expect((await request(origin, `/conversations/${ids[0]}/events`, {
      method: 'POST', body: { id: secondEventId, kind: 'message_omitted', role: 'assistant', expectedRevision: 3 },
    })).status).toBe(201);
    const eventPage1 = await request(origin, `/conversations/${ids[0]}/events?limit=1`);
    expect(eventPage1.body.events).toMatchObject([{ id: firstEventId, sequence: 1 }]);
    expect(eventPage1.body.nextCursor).toBe(1);
    const eventPage2 = await request(origin, `/conversations/${ids[0]}/events?limit=1&after=1`);
    expect(eventPage2.body.events).toMatchObject([{ id: secondEventId, sequence: 4 }]);

    const beforeCount = journal.records.size;
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
    await service.close();
    journal.close();
    await database.closePool(database.pool);
    database.pool = database.openPool();
    store = new ConversationStore(database.pool);
    newService();
    const reloadedOrigin = await listen();
    expect(await request(reloadedOrigin, `/conversations/${ids[0]}/events`)).toMatchObject({
      status: 200, body: { events: [{ id: firstEventId }, { id: secondEventId }] },
    });
    expect(journal.records.size).toBe(beforeCount);
    expect(journal.records.get(unknown.runId)?.state).toBe('POST_OUTCOME_UNKNOWN');

    expect(await request(reloadedOrigin, `/conversations/${ids[0]}`, {
      method: 'DELETE', body: { expectedRevision: 4 },
    })).toEqual({ status: 204, body: undefined });
    expect((await request(reloadedOrigin, `/conversations/${ids[0]}`)).status).toBe(404);
    expect(journal.findRequest(`subject:${ownerId}`, 'unknown-key')?.runId).toBe(unknown.runId);
    expect(journal.records.get(unknown.runId)?.state).toBe('POST_OUTCOME_UNKNOWN');
  });

  it('returns only fixed templates and re-sanitized own-run projections', async () => {
    const live = journal.reserve(`subject:${ownerId}`, 'live', 'meridian-member-inquiry', '1.0.0', {});
    journal.update(live.runId, 'success');
    service.live.set(live.runId, {
      state: 'success', inputs: { searchValue: 'PRIVATE_INPUT_CANARY' }, started: 1, finished: 2,
      result: { status: 'success', outputs: { members: [{ memberNumber: 'PRIVATE_MEMBER_CANARY', name: 'PRIVATE_NAME_CANARY' }] } },
      memberIdentity: { status: 'verified', inquiryRunId: live.runId, memberNumber: 'PRIVATE_MEMBER_CANARY', name: 'PRIVATE_NAME_CANARY' },
      approval: { pending: undefined, cancel() {} },
    } as never);

    const saved = journal.reserve(`subject:${ownerId}`, 'saved', 'meridian-member-inquiry', '1.0.0', {});
    journal.update(saved.runId, 'success');
    const resultDir = join(evidenceDir, saved.runId);
    mkdirSync(resultDir);
    writeFileSync(join(resultDir, 'result.json'), JSON.stringify({
      status: 'success',
      outputs: { members: [{ memberNumber: 'PRIVATE_SAVED_CANARY', name: 'PRIVATE_SAVED_NAME' }] },
      structure: {
        capability: 'meridian-member-inquiry',
        inputs: [
          { name: 'searchMode', type: 'string', value: 'withheld' },
          { name: 'searchValue', type: 'string', value: 'withheld' },
        ],
        outputs: [{
          name: 'members', type: 'table', value: 'withheld', columns: [
            { name: 'memberNumber', type: 'string', value: 'withheld' },
            { name: 'name', type: 'string', value: 'withheld' },
          ],
        }],
      },
    }));

    const conversationId = randomUUID();
    const origin = await listen();
    await request(origin, '/conversations', { method: 'POST', body: { id: conversationId } });
    for (const [expectedRevision, runId] of [live.runId, saved.runId].entries()) {
      expect((await request(origin, `/conversations/${conversationId}/events`, {
        method: 'POST', body: { id: randomUUID(), kind: 'run_linked', role: 'assistant', runId, expectedRevision },
      })).status).toBe(201);
    }
    const beforeCount = journal.records.size;
    const history = await request(origin, `/conversations/${conversationId}/events`);
    expect(history.status).toBe(200);
    expect(history.body.events.map((event: { content: string }) => event.content)).toEqual(['Linked run.', 'Linked run.']);
    expect(history.body.events[0].run).toEqual({
      runId: live.runId, capability: 'meridian-member-inquiry', version: '1.0.0', state: 'success',
      result: { status: 'success', sensitiveValuesUnavailable: true },
    });
    expect(history.body.events[1].run.result.structure).toMatchObject({ capability: 'meridian-member-inquiry' });
    expect(JSON.stringify(history.body.events)).not.toContain('PRIVATE_MEMBER_CANARY');
    expect(JSON.stringify(history.body.events)).not.toContain('PRIVATE_SAVED_CANARY');
    expect(JSON.stringify(history.body.events)).not.toContain('PRIVATE_INPUT_CANARY');
    expect(JSON.stringify(history.body.events)).not.toContain('memberIdentity');
    expect(JSON.stringify(history.body.events)).not.toContain('evidence');
    expect(journal.records.size).toBe(beforeCount);
  });

  it('batches duplicate linked-run event pages while preserving sequence and pagination', async () => {
    const runs = [];
    for (const key of ['page-first', 'page-second', 'page-third']) {
      const run = journal.reserve(`subject:${ownerId}`, key, 'meridian-open-share', '1.0.0', {});
      journal.update(run.runId, 'success');
      runs.push(run);
    }
    const conversationId = randomUUID();
    await store.create(ownerId, conversationId);
    const linkedRunIds: string[] = [];
    for (let index = 0; index < 106; index += 1) {
      const runId = (index < 100 ? runs[0] : runs[(index - 100) % runs.length])!.runId;
      linkedRunIds.push(runId);
    }
    const eventValues = linkedRunIds.flatMap((runId, index) => [
      `40000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      conversationId, index + 1, 'run_linked', 'assistant', runId,
    ]);
    const eventPlaceholders = linkedRunIds.map((_, index) => {
      const offset = index * 6;
      return `($${offset + 1}::uuid, $${offset + 2}::uuid, $${offset + 3}::bigint, $${offset + 4}, $${offset + 5}, $${offset + 6}::uuid)`;
    }).join(', ');
    await database.pool.query(
      `INSERT INTO meridian_conversation_events (id, conversation_id, sequence, kind, role, run_id) VALUES ${eventPlaceholders}`,
      eventValues,
    );
    await database.pool.query('UPDATE meridian_conversations SET revision = 106 WHERE id = $1', [conversationId]);
    await store.migrate();
    const before = [...journal.records.values()];
    const getMany = vi.spyOn(journal, 'getMany');
    const get = vi.spyOn(journal, 'get');
    const origin = await listen();

    const first = await request(origin, `/conversations/${conversationId}/events?limit=100`);
    expect(first.status).toBe(200);
    expect(first.body.events.map((event: { sequence: number }) => event.sequence)).toEqual(
      Array.from({ length: 100 }, (_, index) => index + 1),
    );
    expect(first.body.events.map((event: { runId: string }) => event.runId)).toEqual(linkedRunIds.slice(0, 100));
    expect(first.body.events.map((event: { run: { runId: string } }) => event.run.runId)).toEqual(linkedRunIds.slice(0, 100));
    expect(first.body.nextCursor).toBe(100);
    expect(getMany).toHaveBeenCalledTimes(1);
    expect(getMany).toHaveBeenLastCalledWith([runs[0]!.runId]);
    expect(get).not.toHaveBeenCalled();

    const second = await request(origin, `/conversations/${conversationId}/events?limit=100&after=100`);
    expect(second.status).toBe(200);
    expect(second.body.events.map((event: { sequence: number }) => event.sequence)).toEqual([101, 102, 103, 104, 105, 106]);
    expect(second.body.events.map((event: { runId: string }) => event.runId)).toEqual(linkedRunIds.slice(100));
    expect(second.body.events.map((event: { run: { runId: string } }) => event.run.runId)).toEqual(linkedRunIds.slice(100));
    expect(second.body).not.toHaveProperty('nextCursor');
    expect(getMany).toHaveBeenCalledTimes(2);
    expect(getMany).toHaveBeenLastCalledWith(runs.map(run => run.runId));
    expect(get).not.toHaveBeenCalled();
    expect([...journal.records.values()]).toEqual(before);
  });

  it('fails closed for foreign, caller-private, and missing run links without raw disclosure', async () => {
    const foreign = journal.reserve(`subject:${otherId}`, 'foreign-page-run', 'meridian-open-share', '1.0.0', {});
    journal.update(foreign.runId, 'success');
    const privateRun = journal.reserve(`subject:${otherId}`, 'private-page-run', 'meridian-member-inquiry', '1.0.0', {},
      'replay', { invocationScope: 'member-identity' });
    journal.update(privateRun.runId, 'success');
    service.live.set(privateRun.runId, {
      state: 'success', inputs: { searchValue: 'PRIVATE_INPUT_CANARY' }, started: 1, finished: 2,
      result: { status: 'success', outputs: { members: [{ memberNumber: 'PRIVATE_MEMBER_CANARY', name: 'PRIVATE_NAME_CANARY' }] } },
      memberIdentity: { status: 'verified', inquiryRunId: privateRun.runId, memberNumber: 'PRIVATE_MEMBER_CANARY', name: 'PRIVATE_NAME_CANARY' },
      approval: { pending: undefined, cancel() {} },
    } as never);
    const missing = randomUUID();
    const cases = [
      { owner: ownerId, token: ownerToken, runId: foreign.runId },
      { owner: otherId, token: otherToken, runId: privateRun.runId },
      { owner: ownerId, token: ownerToken, runId: missing },
    ].map((item, index) => ({
      ...item, conversationId: `50000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    }));
    for (const [index, item] of cases.entries()) {
      await store.create(item.owner, item.conversationId);
      await store.append(item.owner, item.conversationId, {
        id: `51000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        kind: 'run_linked', role: 'assistant', runId: item.runId, expectedRevision: 0,
      });
    }
    const before = [...journal.records.values()];
    const getMany = vi.spyOn(journal, 'getMany');
    const get = vi.spyOn(journal, 'get');
    const origin = await listen();

    const responses = [];
    for (const item of cases) responses.push(await request(
      origin, `/conversations/${item.conversationId}/events`, { token: item.token },
    ));

    expect(responses).toEqual(Array.from({ length: 3 }, () => ({ status: 404, body: { error: 'Unknown run' } })));
    expect(JSON.stringify(responses)).not.toMatch(/PRIVATE_(?:INPUT|MEMBER|NAME)_CANARY/);
    expect(getMany).toHaveBeenCalledTimes(3);
    expect(get).not.toHaveBeenCalled();
    expect([...journal.records.values()]).toEqual(before);
  });

  it('rejects overlapping linked-run pages per subject without queuing or poisoning the journal', async () => {
    const ownerRun = journal.reserve(`subject:${ownerId}`, 'backpressure-owner', 'meridian-open-share', '1.0.0', {});
    journal.update(ownerRun.runId, 'success');
    const otherRun = journal.reserve(`subject:${otherId}`, 'backpressure-other', 'meridian-open-share', '1.0.0', {});
    journal.update(otherRun.runId, 'success');
    const ownerConversations = [randomUUID(), randomUUID()];
    const otherConversation = randomUUID();
    for (const [index, conversationId] of [...ownerConversations, otherConversation].entries()) {
      const owner = index < ownerConversations.length ? ownerId : otherId;
      const runId = index < ownerConversations.length ? ownerRun.runId : otherRun.runId;
      await store.create(owner, conversationId);
      await store.append(owner, conversationId, {
        id: randomUUID(), kind: 'run_linked', role: 'assistant', runId, expectedRevision: 0,
      });
    }
    const originalGetMany = journal.getMany.bind(journal);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    let hold = true;
    const getMany = vi.spyOn(journal, 'getMany').mockImplementation((async (runIds: readonly string[]) => {
      const result = originalGetMany(runIds);
      if (hold) {
        hold = false;
        enter();
        await blocked;
      }
      return result;
    }) as unknown as typeof journal.getMany);
    const origin = await listen();

    const first = request(origin, `/conversations/${ownerConversations[0]}/events`);
    await entered;
    expect(await request(origin, `/conversations/${ownerConversations[1]}/events`)).toEqual({
      status: 429, body: { error: 'Linked-run projection is busy' },
    });
    expect((await request(origin, `/conversations/${otherConversation}/events`, { token: otherToken })).status).toBe(200);
    release();
    expect((await first).status).toBe(200);
    expect((await request(origin, `/conversations/${ownerConversations[1]}/events`)).status).toBe(200);

    expect(getMany).toHaveBeenCalledTimes(3);
    expect(journal.get(ownerRun.runId)?.state).toBe('success');
    expect(journal.list()).toHaveLength(2);
  });

  it('rejects foreign runs, legacy principals, malformed inputs, and unexpected database errors without disclosure', async () => {
    const ownerRun = journal.reserve(`subject:${ownerId}`, 'owner-run', 'meridian-member-inquiry', '1.0.0', {});
    const otherRun = journal.reserve(`subject:${otherId}`, 'other-run', 'meridian-member-inquiry', '1.0.0', {});
    const conversationId = randomUUID();
    const origin = await listen();
    expect((await request(origin, '/conversations', { method: 'POST', body: { id: conversationId } })).status).toBe(201);
    expect((await request(origin, `/conversations/${conversationId}`, { token: otherToken })).status).toBe(404);
    expect((await request(origin, '/conversations', { token: otherToken })).body.conversations).toEqual([]);
    expect((await request(origin, `/conversations/${conversationId}/events`, {
      method: 'POST', body: { id: randomUUID(), kind: 'run_linked', role: 'assistant', runId: otherRun.runId, expectedRevision: 0 },
    })).status).toBe(404);
    expect((await request(origin, `/conversations/${conversationId}/events`, {
      method: 'POST', body: { id: randomUUID(), kind: 'run_linked', role: 'assistant', runId: ownerRun.runId, expectedRevision: 0 },
    })).status).toBe(201);

    for (const [path, method, body] of [
      ['/conversations', 'POST', { id: randomUUID(), owner: ownerId }],
      ['/conversations', 'POST', { id: 'not-a-uuid' }],
      [`/conversations/${conversationId}`, 'PATCH', { archived: true, expectedRevision: 1, owner: ownerId }],
      [`/conversations/${conversationId}`, 'DELETE', { expectedRevision: -1 }],
      [`/conversations/${conversationId}/events`, 'POST', { id: randomUUID(), kind: 'message_omitted', role: 'user', expectedRevision: 1, content: 'PRIVATE RAW TEXT' }],
    ] as const) expect((await request(origin, path, { method, body })).status).toBe(400);
    for (const path of ['/conversations?archived=no', '/conversations?limit=0', '/conversations?extra=true', `/conversations/${conversationId}/events?after=-1`])
      expect((await request(origin, path)).status).toBe(400);
    expect((await request(origin, '/conversations', { token: 'wrong-token-that-is-long-enough-0000' })).status).toBe(401);

    const noStoreOrigin = await listen(null);
    expect((await request(noStoreOrigin, '/conversations')).status).toBe(503);
    const legacyOrigin = await listen(store, null);
    expect((await request(legacyOrigin, '/conversations', { token: 'c'.repeat(32) })).status).toBe(403);

    vi.spyOn(store, 'list').mockRejectedValueOnce(new Error('PRIVATE DATABASE ERROR CANARY'));
    const failure = await request(origin, '/conversations');
    expect(failure).toEqual({ status: 500, body: { error: 'Request failed; inspect safe run evidence or server configuration' } });
    expect(JSON.stringify(failure)).not.toContain('PRIVATE DATABASE ERROR CANARY');
  });

  it('returns fixed HTTP capacity responses before rate checks and bypasses capacity for exact retries', async () => {
    const origin = await listen();
    const firstId = '60000000-0000-4000-8000-000000000001';
    expect((await request(origin, '/conversations', { method: 'POST', body: { id: firstId } })).status).toBe(201);
    await seedConversations(ownerId, 127, '60010000-0000-4000-8000-');
    await store.migrate();
    await setRate(ownerId, 0);

    const blocked = await request(origin, '/conversations', {
      method: 'POST', body: { id: '60000000-0000-4000-8000-000000000002' },
    });
    expect(blocked).toMatchObject({ status: 507, body: { error: 'Conversation quota exceeded' } });
    expect(blocked.headers['retry-after']).toBeUndefined();
    expect(JSON.stringify(blocked)).not.toMatch(/60010000|conversation_count|rate_tokens|SELECT/);

    const retried = await request(origin, '/conversations', { method: 'POST', body: { id: firstId } });
    expect(retried).toMatchObject({ status: 201, body: { id: firstId, revision: 0 } });
    expect(retried.headers['retry-after']).toBeUndefined();
    await expect(quotaSnapshot(ownerId)).resolves.toMatchObject({ conversationCount: 128, eventCount: 0, rateTokens: 0 });
  });

  it('returns fixed HTTP responses at per-conversation and subject event capacity', async () => {
    const origin = await listen();
    const perConversation = '61000000-0000-4000-8000-000000000001';
    expect((await request(origin, '/conversations', { method: 'POST', body: { id: perConversation } })).status).toBe(201);
    await seedEvents(ownerId, perConversation, 512, '61010000-0000-4000-9000-');
    await store.migrate();
    await setRate(ownerId, 0);
    const perConversationBlocked = await request(origin, `/conversations/${perConversation}/events`, {
      method: 'POST', body: { id: '61020000-0000-4000-9000-000000000001', kind: 'message_omitted', role: 'user', expectedRevision: 512 },
    });
    expect(perConversationBlocked).toMatchObject({ status: 507, body: { error: 'Conversation quota exceeded' } });
    expect(perConversationBlocked.headers['retry-after']).toBeUndefined();
    expect(JSON.stringify(perConversationBlocked)).not.toMatch(/512|event_count|rate_tokens|SELECT/);
    const perConversationRetry = await request(origin, `/conversations/${perConversation}/events`, {
      method: 'POST', body: { id: '61010000-0000-4000-9000-000000000001', kind: 'message_omitted', role: 'user', expectedRevision: 0 },
    });
    expect(perConversationRetry).toMatchObject({ status: 201, body: { sequence: 1, content: 'Message text was not saved.' } });

    const subjectCapacity = '62000000-0000-4000-8000-000000000001';
    await setRate(ownerId, 20);
    expect((await request(origin, '/conversations', { method: 'POST', body: { id: subjectCapacity } })).status).toBe(201);
    await seedConversations(ownerId, 8, '62010000-0000-4000-8000-');
    await seedEvents(ownerId, subjectCapacity, 1, '62020000-0000-4000-9000-');
    for (let index = 0; index < 7; index += 1) {
      const id = `62010000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
      await seedEvents(ownerId, id, 512, `${(0x63 + index).toString(16).padStart(8, '0')}-0000-4000-9000-`);
    }
    await seedEvents(ownerId, '62010000-0000-4000-8000-000000000008', 511, '6a000000-0000-4000-9000-');
    await store.migrate();
    await setRate(ownerId, 0);
    const subjectBlocked = await request(origin, `/conversations/${subjectCapacity}/events`, {
      method: 'POST', body: { id: '62030000-0000-4000-9000-000000000001', kind: 'message_omitted', role: 'assistant', expectedRevision: 1 },
    });
    expect(subjectBlocked).toMatchObject({ status: 507, body: { error: 'Conversation quota exceeded' } });
    expect(subjectBlocked.headers['retry-after']).toBeUndefined();
    expect(JSON.stringify(subjectBlocked)).not.toMatch(/4096|event_count|rate_tokens|SELECT/);
    const subjectRetry = await request(origin, `/conversations/${subjectCapacity}/events`, {
      method: 'POST', body: { id: '62020000-0000-4000-9000-000000000001', kind: 'message_omitted', role: 'user', expectedRevision: 0 },
    });
    expect(subjectRetry).toMatchObject({ status: 201, body: { sequence: 1, content: 'Message text was not saved.' } });
  });

  it('exhausts the real HTTP write bucket and exact retries do not consume another mutation', async () => {
    const origin = await listen();
    const conversationId = '63000000-0000-4000-8000-000000000001';
    const created = await request(origin, '/conversations', { method: 'POST', body: { id: conversationId } });
    expect(created.status).toBe(201);
    const events = [] as Array<{ id: string; kind: 'message_omitted'; role: 'user'; expectedRevision: number }>;
    for (let expectedRevision = 0; expectedRevision < 19; expectedRevision += 1) {
      const body = { id: `63010000-0000-4000-9000-${String(expectedRevision + 1).padStart(12, '0')}`, kind: 'message_omitted' as const, role: 'user' as const, expectedRevision };
      const response = await request(origin, `/conversations/${conversationId}/events`, { method: 'POST', body });
      expect(response.status).toBe(201);
      events.push(body);
    }
    const blocked = await request(origin, '/conversations', {
      method: 'POST', body: { id: '63000000-0000-4000-8000-000000000002' },
    });
    expect(blocked).toMatchObject({ status: 429, body: { error: 'Conversation write rate limit exceeded' } });
    expect(blocked.headers['retry-after']).toBe('1');
    expect(JSON.stringify(blocked)).not.toMatch(/63000000|rate_tokens|SELECT|owner/);

    const beforeCreateRetry = await quotaSnapshot(ownerId);
    const createRetry = await request(origin, '/conversations', { method: 'POST', body: { id: conversationId } });
    expect(createRetry).toMatchObject({ status: 201, body: { id: conversationId } });
    expect(createRetry.headers['retry-after']).toBeUndefined();
    const beforeEventRetry = await quotaSnapshot(ownerId);
    const eventRetry = await request(origin, `/conversations/${conversationId}/events`, { method: 'POST', body: events.at(-1) });
    expect(eventRetry).toMatchObject({ status: 201, body: { id: events.at(-1)!.id, sequence: 19 } });
    expect(eventRetry.headers['retry-after']).toBeUndefined();
    expect(await quotaSnapshot(ownerId)).toEqual(beforeEventRetry);
    expect(await quotaSnapshot(ownerId)).toEqual(beforeCreateRetry);
  });

  it('rolls back conflicting HTTP writes without leaking quota or rate state', async () => {
    const origin = await listen();
    const first = '64000000-0000-4000-8000-000000000001';
    const second = '64000000-0000-4000-8000-000000000002';
    await expect(request(origin, '/conversations', { method: 'POST', body: { id: first } })).resolves.toMatchObject({ status: 201 });
    await expect(request(origin, '/conversations', { method: 'POST', body: { id: second } })).resolves.toMatchObject({ status: 201 });
    const conflictId = '64010000-0000-4000-9000-000000000001';
    const original = { id: conflictId, kind: 'message_omitted' as const, role: 'user' as const, expectedRevision: 0 };
    await expect(request(origin, `/conversations/${first}/events`, { method: 'POST', body: original })).resolves.toMatchObject({ status: 201 });
    const before = await quotaSnapshot(ownerId);
    const conflict = await request(origin, `/conversations/${second}/events`, { method: 'POST', body: original });
    expect(conflict).toEqual(expect.objectContaining({ status: 409, body: { error: 'Conversation event conflicts with an existing event' } }));
    expect(conflict.headers['retry-after']).toBeUndefined();
    expect(await quotaSnapshot(ownerId)).toEqual(before);
    const valid = await request(origin, `/conversations/${second}/events`, {
      method: 'POST', body: { id: '64010000-0000-4000-9000-000000000002', kind: 'message_omitted', role: 'user', expectedRevision: 0 },
    });
    expect(valid).toMatchObject({ status: 201, body: { sequence: 1 } });
    expect((await quotaSnapshot(ownerId)).eventCount).toBe(before.eventCount + 1);
  });

  it('emits only the allowlisted server-authored retry header', async () => {
    const origin = await listen();
    vi.spyOn(store, 'list').mockRejectedValueOnce(new RequestError(429, 'Synthetic rate failure', {
      'Retry-After': '1', 'X-Private-Canary': 'do-not-emit', 'Content-Type': 'text/plain',
    }));
    const response = await request(origin, '/conversations');
    expect(response).toMatchObject({ status: 429, body: { error: 'Synthetic rate failure' } });
    expect(response.headers['retry-after']).toBe('1');
    expect(response.headers['x-private-canary']).toBeUndefined();
    expect(response.headers['content-type']).toMatch(/^application\/json/);
  });
});
