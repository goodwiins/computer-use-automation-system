// The backend tsconfig intentionally excludes the UI TSX tree; this test is
// exercised by Vitest after the separately checked production UI build.
// @ts-nocheck
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { MockLanguageModelV3 } from 'ai/test';
import { simulateReadableStream, type UIMessage } from 'ai';
import { chromium, type Browser, type Page } from 'playwright';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Journal } from '../src/runtime/journal.js';
import { loadProfile, profilePolicy } from '../src/runtime/profile.js';
import type { SubjectCredential } from '../src/server/auth.js';
import { ConversationStore } from '../src/server/conversations.js';
import { createApp } from '../src/server/http.js';
import { InvocationService } from '../src/server/service.js';
import { createConversationController } from '../src/server/ui/conversations.js';
import { createPostgresFixture } from './fixtures/postgres.js';

const ownerId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const ownerToken = 'owner-operator-token-000000000000001';
const otherToken = 'other-caller-token-0000000000000002';
const callerToken = 'c'.repeat(32);
const operatorToken = 'o'.repeat(32);
const credentials: SubjectCredential[] = [
  { subjectId: ownerId, role: 'operator', token: ownerToken },
  { subjectId: otherId, role: 'caller', token: otherToken },
];

type RecordedRequest = {
  index: number;
  path: string;
  method?: string;
  authorization?: string;
  key?: string;
  body?: unknown;
  rawBody?: string;
};

type AcceptanceFixture = {
  browser?: Browser;
  chatResponseWrites: string[];
  chatStreamStarted: Promise<void>;
  database: Awaited<ReturnType<typeof createPostgresFixture>>;
  errors: string[];
  journal: Journal;
  modelPrompts: unknown[];
  origin: string;
  page?: Page;
  requests: RecordedRequest[];
  service: InvocationService;
  store: ConversationStore;
  connect(token: string): Promise<void>;
  dropNextEventResponse(): void;
  releaseChatStream(): void;
  useStatusRun(runId: string): void;
};

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

function jsonKeys(value: unknown): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value).sort();
}

function authenticatedRequest(origin: string, token: string) {
  return async (path: string, options: RequestInit = {}) => {
    const headers = new Headers(options.headers);
    headers.set('Authorization', `Bearer ${token}`);
    return fetch(new URL(path, origin), { ...options, headers });
  };
}

async function serializedConversationRows(fixture: AcceptanceFixture): Promise<string> {
  const [conversations, events] = await Promise.all([
    fixture.database.pool.query<{ serialized: string }>(
      "SELECT coalesce(string_agg(row_to_json(c)::text, ''), '') AS serialized FROM meridian_conversations c",
    ),
    fixture.database.pool.query<{ serialized: string }>(
      "SELECT coalesce(string_agg(row_to_json(e)::text, ''), '') AS serialized FROM meridian_conversation_events e",
    ),
  ]);
  return `${conversations.rows[0]?.serialized ?? ''}${events.rows[0]?.serialized ?? ''}`;
}

async function fixture(options: {
  browser?: boolean;
  conversations?: boolean;
  holdChatStream?: boolean;
  subjectMode?: boolean;
} = {}): Promise<AcceptanceFixture> {
  const database = await createPostgresFixture();
  const store = new ConversationStore(database.pool);
  await store.migrate();
  const evidenceDir = mkdtempSync(join(tmpdir(), 'conversation-ui-acceptance-'));
  const journal = new Journal(join(evidenceDir, 'journal'), 'h'.repeat(64));
  const profile = loadProfile('meridian');
  const service = new InvocationService(
    journal,
    profilePolicy(profile),
    profile,
    evidenceDir,
    ['meridian-member-inquiry'],
  );
  const requests: RecordedRequest[] = [];
  const errors: string[] = [];
  const chatResponseWrites: string[] = [];
  const modelPrompts: unknown[] = [];
  let modelStatusRunId: string | undefined;
  let markChatStreamStarted!: () => void;
  let releaseChatStream!: () => void;
  const chatStreamStarted = new Promise<void>(resolve => { markChatStreamStarted = resolve; });
  const chatStreamReleased = new Promise<void>(resolve => { releaseChatStream = resolve; });
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 1, text: 1, reasoning: 0 },
  };
  const model = new MockLanguageModelV3({
    doGenerate: async modelOptions => {
      modelPrompts.push(modelOptions.prompt);
      return {
        content: [{
          type: 'tool-call' as const,
          toolCallId: 'route',
          toolName: 'route_request',
          input: JSON.stringify({ intent: modelStatusRunId ? 'status' : 'invoke' }),
        }],
        finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
        usage,
        warnings: [],
      };
    },
    doStream: async modelOptions => {
      modelPrompts.push(modelOptions.prompt);
      markChatStreamStarted();
      if (options.holdChatStream) await chatStreamReleased;
      if (modelStatusRunId) {
        return {
          stream: simulateReadableStream({ chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'live-tool-text' },
            { type: 'text-delta', id: 'live-tool-text', delta: 'LIVE_ASSISTANT_TEXT_CANARY' },
            { type: 'text-end', id: 'live-tool-text' },
            { type: 'tool-call', toolCallId: `status-${modelPrompts.length}`, toolName: 'run_status', input: JSON.stringify({ runId: modelStatusRunId }) },
            { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage },
          ] }) as ReadableStream<never>,
        };
      }
      return {
        stream: simulateReadableStream({ chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'text' },
          { type: 'text-delta', id: 'text', delta: 'Live assistant response was not persisted.' },
          { type: 'text-end', id: 'text' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage },
        ] }) as ReadableStream<never>,
      };
    },
  });

  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolveListening, rejectListening) => {
    server.once('listening', resolveListening);
    server.once('error', rejectListening);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Acceptance server did not bind');
  const port = address.port;
  const app = createApp(service, {
    callerToken,
    operatorToken,
    subjectTokens: options.subjectMode === false ? undefined : credentials,
    conversations: options.conversations === false ? undefined : store,
    port,
    chatModel: model,
    uiDir: resolve('out'),
  });
  let dropEventResponse = false;
  server.on('request', (req, res) => {
    const record: RecordedRequest = {
      index: requests.length,
      path: req.url ?? '',
      method: req.method,
      authorization: req.headers.authorization,
      key: req.headers['idempotency-key'] as string | undefined,
    };
    requests.push(record);
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      record.rawBody = body;
      if (!body) return;
      try { record.body = JSON.parse(body); }
      catch { record.body = body; }
    });
    if (dropEventResponse && req.method === 'POST' && /^\/conversations\/[0-9a-f-]+\/events$/.test(req.url ?? '')) {
      res.end = ((..._args: unknown[]) => {
        dropEventResponse = false;
        res.destroy();
        return res;
      }) as typeof res.end;
    }
    if (req.url === '/api/chat') {
      const originalWrite = res.write.bind(res);
      res.write = ((chunk: unknown, ...args: unknown[]) => {
        chatResponseWrites.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
        return (originalWrite as (...writeArgs: unknown[]) => boolean)(chunk, ...args);
      }) as typeof res.write;
    }
    app(req, res);
  });
  const origin = `http://127.0.0.1:${port}`;
  let browser: Browser | undefined;
  let page: Page | undefined;
  if (options.browser) {
    browser = await chromium.launch();
    page = await browser.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && !message.text().includes('Failed to load resource')) errors.push(message.text());
    });
    await page.route('**/*', route =>
      new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort(),
    );
    await page.goto(origin);
  }
  cleanup.push(async () => {
    releaseChatStream();
    await browser?.close();
    await new Promise<void>(resolveClose => {
      if (!server.listening) return resolveClose();
      server.close(() => resolveClose());
      server.closeAllConnections();
    });
    await service.close().catch(() => {});
    journal.close();
    await database.close();
    rmSync(evidenceDir, { recursive: true, force: true });
  });
  return {
    browser,
    chatResponseWrites,
    chatStreamStarted,
    database,
    errors,
    journal,
    modelPrompts,
    origin,
    page,
    requests,
    service,
    store,
    async connect(token: string) {
      if (!page) throw new Error('Browser fixture was not requested');
      await page.locator('#credential').fill(token);
      await page.getByRole('button', { name: 'Connect', exact: true }).click();
      await page.locator('#workspace').waitFor();
      await page.getByRole('navigation', { name: 'Saved conversations' }).waitFor();
    },
    dropNextEventResponse() { dropEventResponse = true; },
    releaseChatStream,
    useStatusRun(runId: string) { modelStatusRunId = runId; },
  };
}

const privateCanaries = [
  'PRIVATE_INPUT_CANARY',
  'PRIVATE_MEMBER_CANARY',
  'PRIVATE_NAME_CANARY',
  'PRIVATE_BALANCE_CANARY',
  'PRIVATE_CONTACT_CANARY',
  'PRIVATE_CREDENTIAL_CANARY',
  'PRIVATE_APPROVAL_CANARY',
  'PRIVATE_EVIDENCE_URL_CANARY',
  'PRIVATE_TOOL_STATE_CANARY',
] as const;

function expectNoPrivateCanaries(value: unknown): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  for (const canary of privateCanaries) expect(serialized).not.toContain(canary);
}

function seedPrivateRun(fixture: AcceptanceFixture): string {
  const record = fixture.journal.reserve(
    `subject:${ownerId}`,
    'private-saved-run',
    'meridian-member-inquiry',
    '1.0.0',
    {
      searchValue: 'PRIVATE_INPUT_CANARY',
      balance: 'PRIVATE_BALANCE_CANARY',
      contact: 'PRIVATE_CONTACT_CANARY',
      credential: 'PRIVATE_CREDENTIAL_CANARY',
      evidenceUrl: 'PRIVATE_EVIDENCE_URL_CANARY',
    },
  );
  fixture.journal.update(record.runId, 'success');
  fixture.service.live.set(record.runId, {
    state: 'success',
    inputs: {
      searchValue: 'PRIVATE_INPUT_CANARY',
      balance: 'PRIVATE_BALANCE_CANARY',
      contact: 'PRIVATE_CONTACT_CANARY',
      credential: 'PRIVATE_CREDENTIAL_CANARY',
      evidenceUrl: 'PRIVATE_EVIDENCE_URL_CANARY',
    },
    started: 1,
    finished: 2,
    result: {
      status: 'success',
      outputs: {
        members: [{
          memberNumber: 'PRIVATE_MEMBER_CANARY',
          name: 'PRIVATE_NAME_CANARY',
          balance: 'PRIVATE_BALANCE_CANARY',
          contact: 'PRIVATE_CONTACT_CANARY',
        }],
        credential: 'PRIVATE_CREDENTIAL_CANARY',
        toolState: 'PRIVATE_TOOL_STATE_CANARY',
      },
      evidenceDir: 'PRIVATE_EVIDENCE_URL_CANARY',
    },
    memberIdentity: {
      status: 'verified',
      inquiryRunId: record.runId,
      memberNumber: 'PRIVATE_MEMBER_CANARY',
      name: 'PRIVATE_NAME_CANARY',
    },
    step: 'PRIVATE_TOOL_STATE_CANARY',
    approval: {
      pending: {
        id: '50000000-0000-4000-8000-000000000001',
        expiresAt: Date.now() + 60_000,
        request: {
          kind: 'risk_approval',
          goal: 'PRIVATE_APPROVAL_CANARY',
          reason: 'PRIVATE_APPROVAL_CANARY',
          url: 'PRIVATE_EVIDENCE_URL_CANARY',
        },
      },
      cancel() {},
    },
  } as never);
  return record.runId;
}

const liveToolCanaries = [
  'LIVE_INPUT_CANARY',
  'LIVE_MEMBER_CANARY',
  'LIVE_NAME_CANARY',
  'LIVE_BALANCE_CANARY',
  'LIVE_CONTACT_CANARY',
  'LIVE_CREDENTIAL_CANARY',
  'LIVE_APPROVAL_CANARY',
  'LIVE_EVIDENCE_URL_CANARY',
  'LIVE_TOOL_STATE_CANARY',
] as const;

function seedLiveToolRun(fixture: AcceptanceFixture): string {
  const record = fixture.journal.reserve(
    `subject:${ownerId}`,
    'live-tool-status-run',
    'meridian-member-record',
    '1.0.0',
    { searchValue: 'LIVE_INPUT_CANARY' },
  );
  fixture.journal.update(record.runId, 'success');
  fixture.service.live.set(record.runId, {
    state: 'success',
    inputs: {
      searchValue: 'LIVE_INPUT_CANARY',
      credential: 'LIVE_CREDENTIAL_CANARY',
    },
    started: 1,
    finished: 2,
    result: {
      status: 'success',
      outputs: {
        input: 'LIVE_INPUT_CANARY',
        memberNumber: 'LIVE_MEMBER_CANARY',
        name: 'LIVE_NAME_CANARY',
        balance: 'LIVE_BALANCE_CANARY',
        contact: 'LIVE_CONTACT_CANARY',
        credential: 'LIVE_CREDENTIAL_CANARY',
        approval: 'LIVE_APPROVAL_CANARY',
        evidenceUrl: 'LIVE_EVIDENCE_URL_CANARY',
        toolState: 'LIVE_TOOL_STATE_CANARY',
      },
    },
    memberIdentity: {
      status: 'verified',
      inquiryRunId: record.runId,
      memberNumber: 'LIVE_MEMBER_CANARY',
      name: 'LIVE_NAME_CANARY',
    },
    step: 'LIVE_TOOL_STATE_CANARY',
    approval: {
      pending: {
        id: '50000000-0000-4000-8000-000000000002',
        expiresAt: Date.now() + 60_000,
        request: {
          kind: 'risk_approval',
          goal: 'LIVE_APPROVAL_CANARY',
          reason: 'LIVE_APPROVAL_CANARY',
          url: 'LIVE_EVIDENCE_URL_CANARY',
        },
      },
      cancel() {},
    },
  } as never);
  return record.runId;
}

describe.sequential('safe conversation real persistence acceptance', () => {
  it('retries the byte-identical event after a committed response is lost and reconciles a real conflict', async () => {
    const current = await fixture();
    const controller = createConversationController({
      subjectId: ownerId,
      request: authenticatedRequest(current.origin, ownerToken),
    });
    const initialized = await controller.adapter.initialize('local-thread-id');
    const history = controller.historyFor(initialized.remoteId);
    const message = { id: 'chat-message-one', role: 'user', parts: [{ type: 'text', text: 'RAW_TEXT_CANARY' }] } as UIMessage;

    current.dropNextEventResponse();
    await expect(history.append({ parentId: null, message } as never)).rejects.toThrow();
    await history.append({ parentId: null, message } as never);

    const eventPosts = current.requests.filter(request =>
      request.method === 'POST' && request.path === `/conversations/${initialized.remoteId}/events`,
    );
    expect(eventPosts).toHaveLength(2);
    expect(eventPosts[1]?.rawBody).toBe(eventPosts[0]?.rawBody);
    expect(eventPosts[1]?.body).toEqual(eventPosts[0]?.body);
    expect(jsonKeys(eventPosts[0]?.body)).toEqual(['expectedRevision', 'id', 'kind', 'role']);
    expect(eventPosts[0]?.body).toMatchObject({ kind: 'message_omitted', role: 'user', expectedRevision: 0 });
    expect(JSON.stringify(eventPosts)).not.toContain('RAW_TEXT_CANARY');
    expect((await current.store.events(ownerId, initialized.remoteId)).events).toHaveLength(1);

    await current.store.append(ownerId, initialized.remoteId, {
      id: randomUUID(), kind: 'message_omitted', role: 'assistant', expectedRevision: 1,
    });
    await expect(history.append({
      parentId: 'chat-message-one',
      message: { id: 'chat-message-two', role: 'assistant', parts: [{ type: 'text', text: 'SECOND_RAW_CANARY' }] },
    } as never)).rejects.toThrow('revision conflict');
    expect(controller.getState(initialized.remoteId)).toMatchObject({ status: 'conflict', revision: 2 });
    expect(current.requests.filter(request =>
      request.method === 'GET' && request.path === `/conversations/${initialized.remoteId}`,
    )).toHaveLength(1);
    expect(JSON.stringify(await serializedConversationRows(current))).not.toMatch(/RAW_TEXT_CANARY|SECOND_RAW_CANARY/);
    controller.dispose();
  });

  it('restores only inert safe metadata and excludes it from the next real model request', async () => {
    const current = await fixture({ browser: true });
    const page = current.page!;
    const conversationId = '10000000-0000-4000-8000-000000000001';
    const runId = seedPrivateRun(current);
    const liveRunId = seedLiveToolRun(current);
    current.useStatusRun(liveRunId);
    await current.store.create(ownerId, conversationId);
    await current.store.append(ownerId, conversationId, {
      id: '20000000-0000-4000-8000-000000000001',
      kind: 'message_omitted', role: 'user', expectedRevision: 0,
    });
    await current.store.append(ownerId, conversationId, {
      id: '20000000-0000-4000-8000-000000000002',
      kind: 'run_linked', role: 'assistant', runId, expectedRevision: 1,
    });

    await current.connect(ownerToken);
    await vi.waitFor(() => {
      expect(current.requests.filter(request => request.path.startsWith('/conversations?'))).toHaveLength(2);
      expect(current.requests.some(request => request.method === 'GET' && request.path === '/runs')).toBe(true);
      expect(current.requests.some(request => request.method === 'GET' && request.path === '/capabilities')).toBe(true);
    });
    const checkpoint = current.requests.length;
    await page.getByRole('button', { name: 'Open Saved conversation', exact: true }).click();
    await page.getByText('Message text was not saved.', { exact: true }).waitFor();
    await page.getByText('Linked run.', { exact: true }).waitFor();
    await page.locator('[data-saved-run-card]').waitFor();
    const restoredHtml = await page.locator('#messages').innerText();
    expect(restoredHtml).toContain('Historical sensitive values are unavailable.');
    expectNoPrivateCanaries(restoredHtml);
    const restoreRequests = current.requests.slice(checkpoint);
    expect(restoreRequests.some(request => {
      const path = new URL(request.path, current.origin).pathname;
      return path === '/api/chat'
        || path === '/chat'
        || path === '/runs'
        || /^\/runs\/[^/]+(?:\/decision|\/evidence\/[^/]+)?$/.test(path)
        || /^\/capabilities\/[^/]+\/invoke$/.test(path);
    })).toBe(false);

    const liveCanary = 'CURRENT_TEXT_NAME_BALANCE_CONTACT_CREDENTIAL_APPROVAL_EVIDENCE_CANARY';
    await page.getByRole('textbox', { name: 'Your request', exact: true }).fill(liveCanary);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator(`#messages [data-run-id="${liveRunId}"]`).waitFor();
    await vi.waitFor(() => expect(current.requests.filter(request =>
      request.method === 'POST' && request.path === `/conversations/${conversationId}/events`,
    ).length).toBeGreaterThanOrEqual(2));

    const firstChat = current.requests.find(request => request.method === 'POST' && request.path === '/api/chat');
    const serializedFirstChat = JSON.stringify(firstChat?.body);
    expect(serializedFirstChat).toContain(liveCanary);
    expect(serializedFirstChat).not.toContain('Message text was not saved.');
    expect(serializedFirstChat).not.toContain('Linked run.');
    expect(serializedFirstChat).not.toContain(runId);
    expect((firstChat?.body as { id?: string } | undefined)?.id).not.toBe(conversationId);
    expectNoPrivateCanaries(serializedFirstChat);

    const promptsAfterLiveTool = current.modelPrompts.length;
    await page.getByRole('textbox', { name: 'Your request', exact: true }).fill('LIVE_TOOL_FOLLOWUP_CANARY');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await vi.waitFor(() => expect(current.requests.filter(request => request.method === 'POST' && request.path === '/api/chat')).toHaveLength(2));
    const secondChat = current.requests.filter(request => request.method === 'POST' && request.path === '/api/chat')[1];
    const serializedSecondChat = JSON.stringify(secondChat?.body);
    const serializedLiveResponse = current.chatResponseWrites.join('');
    for (const canary of liveToolCanaries) expect(serializedLiveResponse).toContain(canary);
    expect(serializedSecondChat).toContain('LIVE_ASSISTANT_TEXT_CANARY');
    for (const canary of liveToolCanaries) expect(serializedSecondChat).not.toContain(canary);
    expectNoPrivateCanaries(serializedSecondChat);
    await vi.waitFor(() => expect(current.modelPrompts.length).toBeGreaterThan(promptsAfterLiveTool));
    const serializedPrompts = JSON.stringify(current.modelPrompts);
    expect(serializedPrompts).toContain(liveCanary);
    expect(serializedPrompts).toContain('LIVE_TOOL_FOLLOWUP_CANARY');
    // Historical assistant text is display-only; the server never replays it into model prompts.
    expect(serializedPrompts).not.toContain('LIVE_ASSISTANT_TEXT_CANARY');
    expect(serializedPrompts).not.toMatch(/Message text was not saved\.|Linked run\./);
    for (const canary of liveToolCanaries) expect(serializedPrompts).not.toContain(canary);
    expectNoPrivateCanaries(current.modelPrompts);

    const browserEventPosts = current.requests.filter(request =>
      request.method === 'POST' && request.path === `/conversations/${conversationId}/events`,
    );
    for (const request of browserEventPosts) {
      expect(jsonKeys(request.body)).toEqual(['expectedRevision', 'id', 'kind', 'role']);
      expect(request.body).toMatchObject({ kind: 'message_omitted' });
    }
    expect(JSON.stringify(browserEventPosts)).not.toMatch(/CURRENT_TEXT_NAME_BALANCE_CONTACT_CREDENTIAL_APPROVAL_EVIDENCE_CANARY|LIVE_TOOL_FOLLOWUP_CANARY/);
    for (const canary of liveToolCanaries) expect(JSON.stringify(browserEventPosts)).not.toContain(canary);
    const rows = await serializedConversationRows(current);
    expect(rows).not.toMatch(/CURRENT_TEXT_NAME_BALANCE_CONTACT_CREDENTIAL_APPROVAL_EVIDENCE_CANARY|LIVE_TOOL_FOLLOWUP_CANARY/);
    for (const canary of liveToolCanaries) expect(rows).not.toContain(canary);
    expectNoPrivateCanaries(rows);
    expect(current.errors).toEqual([]);
  }, 30_000);

  it('paginates both lists and rolls failed archive and delete mutations back before successful restore and delete', async () => {
    const current = await fixture({ browser: true });
    const page = current.page!;
    seedPrivateRun(current);
    const journalBefore = current.journal.list();
    const regularIds = Array.from({ length: 51 }, (_, index) =>
      `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    );
    for (const id of regularIds) await current.store.create(ownerId, id);
    const initiallyArchivedId = '90000000-0000-4000-8000-000000000001';
    await current.store.create(ownerId, initiallyArchivedId);
    await current.store.archive(ownerId, initiallyArchivedId, true, 0);

    await current.connect(ownerToken);
    const regularRows = page.locator('.conversation-row:not(.conversation-row-archived)');
    await vi.waitFor(async () => expect(await regularRows.count()).toBe(50));
    expect(await page.getByRole('button', { name: 'Restore conversation' }).count()).toBe(1);
    await page.getByRole('button', { name: 'Load more', exact: true }).click();
    await vi.waitFor(async () => expect(await regularRows.count()).toBe(51));
    expect(current.requests.some(request => request.path ===
      `/conversations?archived=false&limit=50&after=${regularIds[49]}`)).toBe(true);

    await current.store.append(ownerId, regularIds[0]!, {
      id: randomUUID(), kind: 'message_omitted', role: 'assistant', expectedRevision: 0,
    });
    await regularRows.first().getByRole('button', { name: 'Archive conversation' }).click();
    await page.getByText('Conversation changed elsewhere; saving stopped until it is refreshed.', { exact: true }).waitFor();
    await vi.waitFor(async () => expect(await regularRows.count()).toBe(51));
    const failedArchive = current.requests.find(request =>
      request.method === 'PATCH' && request.path === `/conversations/${regularIds[0]}`,
    );
    expect(failedArchive?.body).toEqual({ archived: true, expectedRevision: 0 });
    expect((await current.store.get(ownerId, regularIds[0]!)).archived).toBe(false);

    await current.store.append(ownerId, regularIds[1]!, {
      id: randomUUID(), kind: 'message_omitted', role: 'assistant', expectedRevision: 0,
    });
    await regularRows.nth(1).getByRole('button', { name: 'Delete conversation' }).click();
    await vi.waitFor(async () => expect(await regularRows.count()).toBe(51));
    const failedDelete = current.requests.find(request =>
      request.method === 'DELETE' && request.path === `/conversations/${regularIds[1]}`,
    );
    expect(failedDelete?.body).toEqual({ expectedRevision: 0 });
    expect((await current.store.get(ownerId, regularIds[1]!)).revision).toBe(1);

    await regularRows.nth(2).getByRole('button', { name: 'Archive conversation' }).click();
    await vi.waitFor(async () => expect((await current.store.get(ownerId, regularIds[2]!)).archived).toBe(true));
    await vi.waitFor(async () => expect(await regularRows.count()).toBe(50));
    const successfulArchive = current.requests.find(request =>
      request.method === 'PATCH' && request.path === `/conversations/${regularIds[2]}`,
    );
    expect(successfulArchive?.body).toEqual({ archived: true, expectedRevision: 0 });
    expect(await page.getByRole('button', { name: 'Restore conversation' }).count()).toBe(2);

    await page.getByRole('button', { name: 'Restore conversation' }).first().click();
    await vi.waitFor(async () => expect((await current.store.get(ownerId, regularIds[2]!)).archived).toBe(false));
    const restore = current.requests.find(request =>
      request.method === 'PATCH'
      && request.path === `/conversations/${regularIds[2]}`
      && (request.body as { archived?: boolean } | undefined)?.archived === false,
    );
    expect(restore?.body).toEqual({ archived: false, expectedRevision: 1 });

    await vi.waitFor(async () => expect(await regularRows.count()).toBe(51));
    const deletesBefore = current.requests.filter(request => request.method === 'DELETE').length;
    await regularRows.nth(3).getByRole('button', { name: 'Delete conversation' }).click();
    await vi.waitFor(async () => expect(await regularRows.count()).toBe(50));
    const successfulDelete = current.requests.filter(request => request.method === 'DELETE')[deletesBefore];
    const deletedId = successfulDelete?.path.match(/^\/conversations\/([0-9a-f-]+)$/)?.[1];
    expect(deletedId).toBeTruthy();
    await vi.waitFor(async () => {
      await expect(current.store.get(ownerId, deletedId!)).rejects.toMatchObject({ status: 404 });
    });
    await expect(current.store.create(ownerId, deletedId!)).rejects.toMatchObject({ status: 409 });
    expect(successfulDelete?.body).toEqual({ expectedRevision: 0 });
    expect(current.journal.list()).toEqual(journalBefore);
    // The error class name is minified by the production build; match the message, not the constructor.
    expect(current.errors.map(error => error.split('\n')[0])).toEqual([
      expect.stringMatching(/^\[assistant-ui\] thread list archive failed: \w+: Conversation revision conflict$/),
      expect.stringMatching(/^\[assistant-ui\] thread list delete failed: \w+: Conversation revision conflict$/),
    ]);
  }, 45_000);

  it('moves away from a selected idle conversation after archive and delete while keeping the composer usable', async () => {
    const current = await fixture({ browser: true });
    const page = current.page!;
    const firstId = '15000000-0000-4000-8000-000000000001';
    const secondId = '15000000-0000-4000-8000-000000000002';
    for (const id of [firstId, secondId]) {
      await current.store.create(ownerId, id);
      await current.store.append(ownerId, id, {
        id: randomUUID(), kind: 'message_omitted', role: 'user', expectedRevision: 0,
      });
    }
    await current.connect(ownerToken);
    const open = page.getByRole('button', { name: 'Open Saved conversation', exact: true });
    await vi.waitFor(async () => expect(await open.count()).toBe(2));

    await open.first().click();
    await vi.waitFor(() => expect(current.requests.some(request => request.path === `/conversations/${firstId}/events?after=0&limit=100`)).toBe(true));
    await open.first().locator('..').getByRole('button', { name: 'Archive conversation' }).click();
    await vi.waitFor(async () => expect((await current.store.get(ownerId, firstId)).archived).toBe(true));
    await vi.waitFor(async () => expect(await open.count()).toBe(1));
    expect(await page.getByRole('textbox', { name: 'Your request', exact: true }).isEnabled()).toBe(true);

    await open.first().click();
    await vi.waitFor(() => expect(current.requests.some(request => request.path === `/conversations/${secondId}/events?after=0&limit=100`)).toBe(true));
    await open.first().locator('..').getByRole('button', { name: 'Delete conversation' }).click();
    await vi.waitFor(async () => {
      await expect(current.store.get(ownerId, secondId)).rejects.toMatchObject({ status: 404 });
    });
    await vi.waitFor(async () => expect(await open.count()).toBe(0));
    const composer = page.getByRole('textbox', { name: 'Your request', exact: true });
    expect(await composer.isEnabled()).toBe(true);

    await composer.fill('POST_MUTATION_NEW_THREAD_CANARY');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByText('Live assistant response was not persisted.', { exact: true }).waitFor();
    const create = current.requests.find(request => request.method === 'POST' && request.path === '/conversations');
    const newId = (create?.body as { id?: string } | undefined)?.id;
    expect(newId).toMatch(/^[0-9a-f-]{36}$/);
    expect(newId).not.toBe(firstId);
    expect(newId).not.toBe(secondId);
    await vi.waitFor(async () => expect((await current.store.events(ownerId, newId!)).events).toHaveLength(2));
    expect((await current.store.events(ownerId, firstId)).events).toHaveLength(1);
  }, 30_000);

  it('initializes and saves both messages from a fresh browser conversation', async () => {
    const current = await fixture({ browser: true });
    const page = current.page!;
    await current.connect(ownerToken);
    expect(current.requests.some(request => request.method === 'POST' && request.path === '/conversations')).toBe(false);
    const originalCreate = current.store.create.bind(current.store);
    let createReached!: () => void;
    let releaseCreate!: () => void;
    const createStarted = new Promise<void>(resolve => { createReached = resolve; });
    const createReleased = new Promise<void>(resolve => { releaseCreate = resolve; });
    cleanup.push(async () => { releaseCreate(); });
    vi.spyOn(current.store, 'create').mockImplementation(async (...args) => {
      createReached();
      await createReleased;
      return originalCreate(...args);
    });
    await page.getByRole('textbox', { name: 'Your request', exact: true }).fill('FRESH_THREAD_RAW_CANARY');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await createStarted;
    await vi.waitFor(() => {
      const paths = current.requests.map(request => `${request.method} ${request.path}`);
      if (!paths.includes('POST /api/chat')) throw new Error(`requests before delayed create resolved: ${JSON.stringify(paths)}`);
    }, { timeout: 5_000 });
    const createBeforeRelease = current.requests.find(request => request.method === 'POST' && request.path === '/conversations');
    const chatBeforeRelease = current.requests.find(request => request.method === 'POST' && request.path === '/api/chat');
    expect(createBeforeRelease).toBeDefined();
    expect(chatBeforeRelease).toBeDefined();
    expect(chatBeforeRelease!.index).toBeGreaterThan(createBeforeRelease!.index);
    releaseCreate();
    await current.chatStreamStarted;
    await page.getByText('Live assistant response was not persisted.', { exact: true }).waitFor();
    await vi.waitFor(() => expect(current.requests.some(request =>
      request.method === 'POST' && request.path === '/conversations',
    )).toBe(true));
    const created = current.requests.find(request => request.method === 'POST' && request.path === '/conversations');
    const conversationId = (created?.body as { id?: string } | undefined)?.id;
    expect(jsonKeys(created?.body)).toEqual(['id']);
    expect(conversationId).toMatch(/^[0-9a-f-]{36}$/);
    const chat = current.requests.find(request => request.method === 'POST' && request.path === '/api/chat');
    expect((chat?.body as { id?: string } | undefined)?.id).not.toBe(conversationId);
    expect(chat?.key).toBe((chat?.body as { messages?: Array<{ id?: string }> } | undefined)?.messages?.at(-1)?.id);
    await vi.waitFor(() => expect(current.requests.filter(request =>
      request.method === 'POST' && request.path === `/conversations/${conversationId}/events`,
    )).toHaveLength(2));
    const events = await current.store.events(ownerId, conversationId!);
    expect(events.events.map(event => event.role)).toEqual(['user', 'assistant']);
    expect(JSON.stringify(events)).not.toContain('FRESH_THREAD_RAW_CANARY');
    expect(await page.getByText('Saved conversation', { exact: true }).count()).toBeGreaterThanOrEqual(1);
    expect(current.errors).toEqual([]);
  }, 30_000);

  it('tracks the actual selected retained thread when reporting a later persistence failure', async () => {
    const current = await fixture({ browser: true });
    const page = current.page!;
    const firstId = '25000000-0000-4000-8000-000000000001';
    const secondId = '25000000-0000-4000-8000-000000000002';
    await current.store.create(ownerId, firstId);
    await current.store.create(ownerId, secondId);
    await current.connect(ownerToken);
    const open = page.getByRole('button', { name: 'Open Saved conversation', exact: true });
    await vi.waitFor(async () => expect(await open.count()).toBe(2));
    await open.first().click();
    await open.nth(1).click();
    await open.first().click();
    vi.spyOn(current.store, 'append').mockRejectedValue(new Error('synthetic persistence failure'));

    await page.getByRole('textbox', { name: 'Your request', exact: true }).fill('SELECTED_STATUS_CANARY');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.getByText('Conversations not saved; this chat remains usable.', { exact: true }).waitFor();
  }, 30_000);

  it('does not surface a retained conversation failure after switching to a new local thread', async () => {
    const current = await fixture({ browser: true });
    const page = current.page!;
    const conversationId = '27500000-0000-4000-8000-000000000001';
    await current.store.create(ownerId, conversationId);
    await current.connect(ownerToken);
    await page.getByRole('button', { name: 'Open Saved conversation', exact: true }).click();

    let reached!: () => void;
    let release!: () => void;
    let failed!: () => void;
    const appendReached = new Promise<void>(resolve => { reached = resolve; });
    const appendReleased = new Promise<void>(resolve => { release = resolve; });
    const failureObserved = new Promise<void>(resolve => { failed = resolve; });
    cleanup.push(async () => { release(); });
    vi.spyOn(current.store, 'append').mockImplementation(async () => {
      reached();
      await appendReleased;
      failed();
      throw new Error('synthetic retained persistence failure');
    });

    await page.getByRole('textbox', { name: 'Your request', exact: true }).fill('RETAINED_NEW_THREAD_CANARY');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await appendReached;
    const createsBeforeNew = current.requests.filter(request => request.method === 'POST' && request.path === '/conversations').length;
    await page.getByRole('button', { name: 'New conversation', exact: true }).click();
    release();
    await failureObserved;
    await page.getByText('Conversations ready.', { exact: true }).waitFor();
    expect(current.requests.filter(request => request.method === 'POST' && request.path === '/conversations')).toHaveLength(createsBeforeNew);
    expect((await current.store.events(ownerId, conversationId)).events).toEqual([]);
  }, 30_000);

  it('keeps a delayed browser save pinned to its original conversation after a thread switch', async () => {
    const current = await fixture({ browser: true, holdChatStream: true });
    const page = current.page!;
    const firstId = '30000000-0000-4000-8000-000000000001';
    const secondId = '30000000-0000-4000-8000-000000000002';
    await current.store.create(ownerId, firstId);
    await current.store.create(ownerId, secondId);
    await current.connect(ownerToken);
    const open = page.getByRole('button', { name: 'Open Saved conversation', exact: true });
    await vi.waitFor(async () => expect(await open.count()).toBe(2));
    await open.first().click();
    await vi.waitFor(() => expect(current.requests.some(request => request.path === `/conversations/${firstId}/events?after=0&limit=100`)).toBe(true));

    const originalAppend = current.store.append.bind(current.store);
    let reached!: () => void;
    let release!: () => void;
    const appendReached = new Promise<void>(resolve => { reached = resolve; });
    const appendReleased = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    cleanup.push(async () => { release(); });
    vi.spyOn(current.store, 'append').mockImplementation(async (...args) => {
      if (!held && args[1] === firstId) {
        held = true;
        reached();
        await appendReleased;
      }
      return originalAppend(...args);
    });

    await page.getByRole('textbox', { name: 'Your request', exact: true }).fill('PINNED_THREAD_RAW_CANARY');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await current.chatStreamStarted;
    await vi.waitFor(async () => {
      expect(await page.getByRole('button', { name: 'Archive conversation' }).first().isDisabled()).toBe(true);
      expect(await page.getByRole('button', { name: 'Delete conversation' }).first().isDisabled()).toBe(true);
    });
    current.releaseChatStream();
    await appendReached;
    await open.nth(1).click();
    await vi.waitFor(() => expect(current.requests.some(request => request.path === `/conversations/${secondId}/events?after=0&limit=100`)).toBe(true));
    release();
    await vi.waitFor(async () => expect((await current.store.events(ownerId, firstId)).events.length).toBeGreaterThanOrEqual(1));
    await vi.waitFor(async () => expect((await current.store.events(ownerId, firstId)).events.length).toBe(2));
    expect((await current.store.events(ownerId, secondId)).events).toEqual([]);
    const eventPosts = current.requests.filter(request => request.method === 'POST' && request.path.endsWith('/events'));
    expect(eventPosts.every(request => request.path === `/conversations/${firstId}/events`)).toBe(true);
    expect(JSON.stringify(eventPosts)).not.toContain('PINNED_THREAD_RAW_CANARY');
    expect(current.errors).toEqual([]);
  }, 30_000);

  it('does not move an already-dispatched save into a replacement authenticated session', async () => {
    const current = await fixture({ browser: true });
    const page = current.page!;
    const conversationId = '40000000-0000-4000-8000-000000000001';
    await current.store.create(ownerId, conversationId);
    await current.connect(ownerToken);
    await page.getByRole('button', { name: 'Open Saved conversation', exact: true }).click();

    const originalAppend = current.store.append.bind(current.store);
    let reached!: () => void;
    let release!: () => void;
    const appendReached = new Promise<void>(resolve => { reached = resolve; });
    const appendReleased = new Promise<void>(resolve => { release = resolve; });
    let held = false;
    cleanup.push(async () => { release(); });
    vi.spyOn(current.store, 'append').mockImplementation(async (...args) => {
      if (!held && args[0] === ownerId && args[1] === conversationId) {
        held = true;
        reached();
        await appendReleased;
      }
      return originalAppend(...args);
    });

    await page.getByRole('textbox', { name: 'Your request', exact: true }).fill('OLD_SESSION_RAW_CANARY');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await appendReached;
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await page.locator('#workspace').waitFor({ state: 'detached' });
    await page.locator('#credential').fill(otherToken);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.locator('#workspace').waitFor();
    release();

    await vi.waitFor(async () => expect((await current.store.events(ownerId, conversationId)).events.length).toBeGreaterThanOrEqual(1));
    expect((await current.store.list(otherId)).conversations).toEqual([]);
    const eventPosts = current.requests.filter(request => request.method === 'POST' && request.path.endsWith('/events'));
    expect(eventPosts.every(request => request.authorization === `Bearer ${ownerToken}`)).toBe(true);
    expect(eventPosts.some(request => request.authorization === `Bearer ${otherToken}`)).toBe(false);
    expect(await page.locator('#messages').innerText()).not.toContain('OLD_SESSION_RAW_CANARY');
  }, 30_000);

  it('keeps chat usable while subject storage is unavailable and never presents legacy navigation as saved', async () => {
    const subject = await fixture({ browser: true, conversations: false });
    const subjectPage = subject.page!;
    await subject.connect(ownerToken);
    await subjectPage.getByText('Conversations unavailable; this chat is not saved.', { exact: true }).waitFor({ timeout: 5_000 });
    await subjectPage.getByRole('textbox', { name: 'Your request', exact: true }).fill('UNSAVED_SUBJECT_CHAT');
    await subjectPage.getByRole('button', { name: 'Send', exact: true }).click();
    await subjectPage.getByText('Live assistant response was not persisted.', { exact: true }).waitFor({ timeout: 5_000 });
    expect(subject.requests.some(request => request.method === 'POST' && request.path === '/api/chat')).toBe(true);
    expect(await subjectPage.locator('.conversation-row').count()).toBe(0);
    expect(subject.errors.some(error => error.includes('Thread title generation failed') || error.includes('Invalid conversation id'))).toBe(false);

    const legacy = await fixture({ browser: true, subjectMode: false });
    const legacyPage = legacy.page!;
    await legacyPage.locator('#credential').fill(callerToken);
    await legacyPage.getByRole('button', { name: 'Connect', exact: true }).click();
    await legacyPage.locator('#workspace').waitFor();
    await legacyPage.getByText('Conversations are not saved for this legacy session.', { exact: true }).waitFor({ timeout: 5_000 });
    expect(await legacyPage.getByRole('navigation', { name: 'Saved conversations' }).count()).toBe(0);
    expect(legacy.requests.some(request => request.path.startsWith('/conversations'))).toBe(false);
  }, 30_000);
});
