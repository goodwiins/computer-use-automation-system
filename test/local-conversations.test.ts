import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { MockLanguageModelV3 } from 'ai/test';
import { simulateReadableStream } from 'ai';
import { expect, it, vi } from 'vitest';
import { ConversationStore } from '../src/server/conversations.js';
import { createApp, resolveServerStorageConfiguration } from '../src/server/http.js';
import type { InvocationService } from '../src/server/service.js';
import { createPostgresFixture } from './fixtures/postgres.js';

const subjects = { caller: '11111111-1111-4111-8111-111111111111', operator: '22222222-2222-4222-8222-222222222222' };
const key = randomBytes(32).toString('hex');

it('encrypts local text, preserves retry/quota/ownership rules, and fails closed on missing or wrong keys', async () => {
  const database = await createPostgresFixture();
  try {
    const store = new ConversationStore(database.pool, key);
    await store.migrate();
    const id = randomUUID();
    await store.create(subjects.caller, id);
    const pending = { id: randomUUID(), kind: 'message_saved' as const, role: 'user' as const, text: 'Synthetic local transcript <script>literal</script> 🦊', expectedRevision: 0 };
    const saved = await store.append(subjects.caller, id, pending);
    expect(await store.append(subjects.caller, id, pending)).toEqual(saved);
    await expect(store.append(subjects.caller, id, { ...pending, text: 'changed' })).rejects.toMatchObject({ status: 409 });
    await expect(store.events(subjects.operator, id)).rejects.toMatchObject({ status: 404 });
    const stored = await database.pool.query('SELECT text_ciphertext FROM meridian_conversation_events WHERE id=$1', [pending.id]);
    expect(stored.rows[0].text_ciphertext.includes(Buffer.from(pending.text))).toBe(false);
    // Public IDs may coincide across owners without sharing encrypted text or retries.
    await store.create(subjects.operator, id);
    const operatorPending = { ...pending, text: 'Separate operator transcript' };
    const operatorSaved = await store.append(subjects.operator, id, operatorPending);
    expect(await store.append(subjects.operator, id, operatorPending)).toEqual(operatorSaved);
    const reopened = new ConversationStore(database.openPool(), key);
    await reopened.migrate();
    expect((await reopened.events(subjects.caller, id)).events).toEqual([saved]);
    expect((await reopened.events(subjects.operator, id)).events).toEqual([operatorSaved]);
    await expect(new ConversationStore(database.pool).events(subjects.caller, id)).rejects.toMatchObject({ status: 503 });
    await expect(new ConversationStore(database.pool, 'f'.repeat(64)).events(subjects.caller, id)).rejects.toMatchObject({ status: 503 });
    await expect(store.append(subjects.caller, id, { ...pending, id: randomUUID(), text: 'x'.repeat(4001), expectedRevision: 1 })).rejects.toMatchObject({ status: 400 });
    await database.pool.query('UPDATE meridian_conversation_events SET role=$1 WHERE id=$2 AND owner_id=$3', ['assistant', pending.id, subjects.caller]);
    await expect(store.events(subjects.caller, id)).rejects.toMatchObject({ status: 503 });
    await store.delete(subjects.caller, id, 1);
    expect((await store.events(subjects.operator, id)).events).toEqual([operatorSaved]);
    await store.delete(subjects.operator, id, 1);
    expect((await database.pool.query('SELECT * FROM meridian_conversation_events')).rows).toEqual([]);
    await expect(store.create(subjects.caller, id)).rejects.toMatchObject({ status: 409 });
    expect(resolveServerStorageConfiguration({ LOCAL_TELLER_LOGIN: '1', LOCAL_CONVERSATION_SUBJECTS: JSON.stringify(subjects), DATABASE_URL: database.connectionString, CONVERSATION_TEXT_KEY: key })).toMatchObject({ enableConversations: true, mode: 'filesystem' });
    expect(() => resolveServerStorageConfiguration({ CONVERSATION_TEXT_KEY: key })).toThrow();
  } finally { await database.close(); }
});

it('saves both chat messages in PostgreSQL and restores them after page reload and server restart without invoking a run', async () => {
  const database = await createPostgresFixture();
  let server: Server | undefined;
  let browser: Browser | undefined;
  const invoke = vi.fn();
  let streams = 0;
  const reply = 'Synthetic saved reply <img src=x onerror=alert(1)>';
  const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
  const model = new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: 'tool-call', toolCallId: 'route', toolName: 'route_request', input: '{"intent":"conversation"}' }],
      finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage, warnings: [],
    }),
    doStream: async () => {
      streams++;
      return { stream: simulateReadableStream({ chunks: [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'text' },
        { type: 'text-delta', id: 'text', delta: reply },
        { type: 'text-end', id: 'text' },
        { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
      ] }) as ReadableStream<never> };
    },
  });
  const service = { profile: { appId: 'fixture' }, catalog: () => [], history: async () => [], availability: async () => [], requestContexts: async () => new Map(), invoke } as unknown as InvocationService;
  const start = async (port = 0) => {
    const store = new ConversationStore(database.openPool(), key);
    await store.migrate();
    server = createServer();
    server.listen(port, '127.0.0.1');
    await new Promise<void>(resolve => server!.once('listening', resolve));
    const actualPort = (server.address() as { port: number }).port;
    server.on('request', createApp(service, {
      callerToken: 'c'.repeat(32), operatorToken: 'o'.repeat(32), port: actualPort,
      conversations: store, localConversationSubjects: subjects,
      localTellerLogin: { teller: 'TELLER1', supervisor: 'SUPER1' }, chatModel: model,
    }));
    return actualPort;
  };
  try {
    const port = await start();
    const origin = `http://127.0.0.1:${port}`;
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin);
    await page.getByLabel('Role', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByRole('textbox', { name: 'Your request', exact: true }).fill('Synthetic persistence hello');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await vi.waitFor(async () => {
      expect((await database.pool.query("SELECT count(*)::int AS count FROM meridian_conversation_events WHERE kind='message_saved'")).rows[0].count).toBe(2);
    }, { timeout: 15000 });
    const conversation = (await database.pool.query('SELECT id FROM meridian_conversations')).rows[0].id;
    const oldToken = await page.evaluate(async () => (await (await fetch('/session/teller', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).token as string);
    const legacy = await fetch(`${origin}/conversations`, { headers: { Authorization: `Bearer ${'c'.repeat(32)}` } });
    expect(legacy.status).toBe(403);
    for (const restart of [false, true]) {
      if (restart) {
        server!.closeAllConnections();
        await new Promise<void>(resolve => server!.close(() => resolve()));
        await start(port);
        expect((await fetch(`${origin}/conversations`, { headers: { Authorization: `Bearer ${oldToken}` } })).status).toBe(401);
      }
      await page.reload();
      await page.getByLabel('Role', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Connect', exact: true }).click();
      await page.getByRole('button', { name: 'Open Saved conversation', exact: true }).click();
      await page.getByText('Synthetic persistence hello', { exact: true }).waitFor();
      await page.getByText(reply, { exact: true }).waitFor();
      expect(await page.locator('.message img').count()).toBe(0);
      expect(streams).toBe(1);
      expect(invoke).not.toHaveBeenCalled();
      expect((await new ConversationStore(database.pool, key).events(subjects.caller, conversation)).events).toHaveLength(2);
    }
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual([0, 0]);
  } finally {
    await browser?.close();
    server?.closeAllConnections();
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
    await database.close();
  }
}, 60000);

it('keeps local teller and supervisor conversations separate without changing operator visibility of teller runs', async () => {
  const database = await createPostgresFixture();
  const server = createServer();
  const callerRun = randomUUID();
  const loginRun = randomUUID();
  vi.stubEnv('MERIDIAN_SUPERVISOR_OPERATOR', 'SUPER1');
  vi.stubEnv('MERIDIAN_SUPERVISOR_PASSWORD', 'synthetic-supervisor-password');
  vi.stubEnv('MERIDIAN_BRANCH', 'MAIN-001');
  const get = vi.fn(async (principal, runId) => {
    expect(principal).toBe('operator');
    return runId === loginRun
      ? { runId, state: 'success', result: { status: 'success', outputs: { operator: 'SUPER1', role: 'SUPERVISOR', branch: 'MAIN-001' } } }
      : { runId, state: 'success', capability: 'meridian-member-inquiry', version: '1.0.0' };
  });
  try {
    const store = new ConversationStore(database.pool, key);
    await store.migrate();
    server.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;
    server.on('request', createApp({ get, invoke: async () => ({ runId: loginRun }), catalog: () => [] } as unknown as InvocationService, {
      callerToken: 'c'.repeat(32), operatorToken: 'o'.repeat(32), port, conversations: store,
      localTellerLogin: { teller: 'TELLER1', supervisor: 'SUPER1' }, localConversationSubjects: subjects,
    }));
    const request = (path: string, body?: unknown, token?: string) => fetch(`${origin}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const teller = await (await request('/session/teller', {})).json() as { token: string };
    const supervisor = await (await request('/session/supervisor', { operator: 'SUPER1', password: 'synthetic-supervisor-password' })).json() as { token: string };
    const id = randomUUID();
    expect((await request('/conversations', { id }, supervisor.token)).status).toBe(201);
    expect((await request(`/conversations/${id}`, undefined, teller.token)).status).toBe(404);
    expect((await request(`/conversations/${id}/events`, { id: randomUUID(), kind: 'run_linked', role: 'assistant', runId: callerRun, expectedRevision: 0 }, supervisor.token)).status).toBe(201);
    const events = await (await request(`/conversations/${id}/events`, undefined, supervisor.token)).json() as { events: unknown[] };
    expect(events.events).toHaveLength(1);
    expect(get).toHaveBeenCalledWith('operator', callerRun);
    expect((await request(`/conversations/${id}/events`, undefined, 'o'.repeat(32))).status).toBe(403);
  } finally {
    vi.unstubAllEnvs();
    server.closeAllConnections();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await database.close();
  }
});

it('binds text keys before writes, verifies legacy ciphertext, and retains the binding across deletion', async () => {
  const database = await createPostgresFixture();
  try {
    const store = new ConversationStore(database.pool, key);
    expect(store.textEnabled).toBe(false);
    await store.migrate();
    const id = randomUUID();
    await store.create(subjects.caller, id);
    const pending = { id: randomUUID(), kind: 'message_saved' as const, role: 'user' as const, text: 'Legacy encrypted text', expectedRevision: 0 };
    const unverified = new ConversationStore(database.pool, key);
    await expect(unverified.append(subjects.caller, id, pending)).rejects.toMatchObject({ status: 503 });
    await store.append(subjects.caller, id, pending);
    for (const legacy of [false, true]) {
      if (legacy) await database.pool.query('DROP TABLE meridian_conversation_text_key');
      const wrong = new ConversationStore(database.openPool(), 'f'.repeat(64));
      expect(wrong.textEnabled).toBe(false);
      await expect(wrong.migrate()).rejects.toMatchObject({ status: 503 });
      expect(wrong.textEnabled).toBe(false);
      await expect(wrong.append(subjects.caller, id, { ...pending, id: randomUUID(), expectedRevision: 1 })).rejects.toMatchObject({ status: 503 });
      const corrected = new ConversationStore(database.openPool(), key);
      await corrected.migrate();
      expect(corrected.textEnabled).toBe(true);
      expect((await corrected.events(subjects.caller, id)).events[0]?.text).toBe(pending.text);
    }
    await store.delete(subjects.caller, id, 1);
    await expect(new ConversationStore(database.pool, 'f'.repeat(64)).migrate()).rejects.toMatchObject({ status: 503 });
    const omitted = new ConversationStore(database.pool);
    await omitted.migrate();
    expect(omitted.textEnabled).toBe(false);
    const empty = randomUUID();
    await omitted.create(subjects.caller, empty);
    await omitted.append(subjects.caller, empty, { id: randomUUID(), kind: 'message_omitted', role: 'user', expectedRevision: 0 });
  } finally { await database.close(); }
});

it('serializes competing key initialization so only the bound key can write', async () => {
  const database = await createPostgresFixture();
  try {
    const stores = [new ConversationStore(database.pool, key), new ConversationStore(database.openPool(), 'f'.repeat(64))];
    const results = await Promise.allSettled(stores.map(store => store.migrate()));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(stores.filter(store => store.textEnabled)).toHaveLength(1);
    const id = randomUUID();
    await stores[0]!.create(subjects.caller, id);
    const pending = { id: randomUUID(), kind: 'message_saved' as const, role: 'user' as const, text: 'Only the winner writes', expectedRevision: 0 };
    await expect(stores.find(store => !store.textEnabled)!.append(subjects.caller, id, pending)).rejects.toMatchObject({ status: 503 });
    await stores.find(store => store.textEnabled)!.append(subjects.caller, id, pending);
  } finally { await database.close(); }
});

it('leaves text writes disabled when legacy ciphertext validation fails partway through migration', async () => {
  const database = await createPostgresFixture();
  try {
    const original = new ConversationStore(database.pool, key);
    await original.migrate();
    const id = randomUUID();
    for (const owner of Object.values(subjects)) {
      await original.create(owner, id);
      await original.append(owner, id, { id: randomUUID(), kind: 'message_saved', role: 'user', text: 'Owner-bound text', expectedRevision: 0 });
    }
    await database.pool.query('DROP TABLE meridian_conversation_text_key');
    await database.pool.query("UPDATE meridian_conversation_events SET role = 'assistant' WHERE owner_id = $1", [subjects.operator]);
    const upgrade = new ConversationStore(database.openPool(), key);
    await expect(upgrade.migrate()).rejects.toMatchObject({ status: 503 });
    expect(upgrade.textEnabled).toBe(false);
    await expect(upgrade.append(subjects.caller, id, { id: randomUUID(), kind: 'message_saved', role: 'user', text: 'Must not write', expectedRevision: 1 })).rejects.toMatchObject({ status: 503 });
    expect((await database.pool.query("SELECT to_regclass('meridian_conversation_text_key') AS binding")).rows[0].binding).toBeNull();
    await database.pool.query("UPDATE meridian_conversation_events SET role = 'user' WHERE owner_id = $1", [subjects.operator]);
    await Promise.all([upgrade.migrate(), new ConversationStore(database.openPool(), key).migrate()]);
    expect(upgrade.textEnabled).toBe(true);
    expect((await upgrade.events(subjects.operator, id)).events[0]?.text).toBe('Owner-bound text');
  } finally { await database.close(); }
});
