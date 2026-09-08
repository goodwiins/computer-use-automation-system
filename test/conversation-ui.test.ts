// The backend tsconfig intentionally excludes the UI TSX tree; this test is
// compiled by the UI tsconfig and exercised by Vitest instead.
// @ts-nocheck
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { UIMessage } from 'ai';
import {
  CONVERSATION_TITLE,
  conversationActionsDisabled,
  createConversationController,
  conversationStatusText,
  isSavedConversationMessage,
  trackConversationWriteFailure,
  type ConversationRequest,
} from '../src/server/ui/conversations.js';
import { chatRequest } from '../src/server/ui/transport.js';

const subjectId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const conversationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const otherConversationId = 'abababab-abab-4bab-8bab-abababababab';
const thirdConversationId = 'cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd';
const runId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function response(body: unknown, status = 200): Response {
  return new Response(body === undefined ? undefined : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestRecorder(
  handler: (path: string, options?: RequestInit) => Response | Promise<Response>,
) {
  const calls: { path: string; options?: RequestInit }[] = [];
  const request: ConversationRequest = async (path, options) => {
    calls.push({ path, options });
    return handler(path, options);
  };
  return { calls, request };
}

const metadata = {
  id: conversationId,
  archived: false,
  revision: 0,
  createdAt: '2026-09-07T00:00:00.000Z',
  updatedAt: '2026-09-07T00:00:00.000Z',
};

describe('safe conversation UI adapter', () => {
  it('uses fixed metadata and a UUID conversation id separate from the local thread id', async () => {
    const { calls, request } = requestRecorder((_path, options) => {
      const body = JSON.parse(String(options?.body));
      return response({ ...metadata, id: body.id }, 201);
    });
    const controller = createConversationController({ subjectId, request });

    const initialized = await controller.adapter.initialize('__LOCALID_printable-chat-id');

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toBe('/conversations');
    const createBody = JSON.parse(String(calls[0]?.options?.body));
    expect(initialized).toEqual({ remoteId: createBody.id, externalId: undefined });
    expect(Object.keys(createBody)).toEqual(['id']);
    expect(createBody.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(createBody.id).not.toBe('__LOCALID_printable-chat-id');
    expect(String(calls[0]?.options?.body)).not.toContain('__LOCALID_printable-chat-id');
    expect(controller.toMetadata(metadata)).toMatchObject({
      remoteId: conversationId,
      title: CONVERSATION_TITLE,
      status: 'regular',
    });
  });

  it('loads inert fixed messages and safe run data without live run or chat requests', async () => {
    const { calls, request } = requestRecorder((path) => {
      if (path.includes('/events')) {
        return response({
          events: [
            {
              id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
              sequence: 1,
              kind: 'message_omitted',
              role: 'user',
              content: 'Message text was not saved.',
              createdAt: metadata.createdAt,
            },
            {
              id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
              sequence: 2,
              kind: 'run_linked',
              role: 'assistant',
              runId,
              content: 'Linked run.',
              run: {
                runId,
                capability: 'meridian-member-inquiry',
                version: '1.0.0',
                state: 'success',
                result: { status: 'success', sensitiveValuesUnavailable: true },
              },
              createdAt: metadata.updatedAt,
            },
          ],
        });
      }
      throw new Error(`unexpected request ${path}`);
    });
    const controller = createConversationController({ subjectId, request });
    const repository = await controller.historyFor(conversationId).withFormat!({
      format: 'ai-sdk/v6',
      encode: item => ({ ...item.message, canary: 'must-not-be-sent' }),
      decode: stored => ({ parentId: stored.parent_id, message: stored.content as UIMessage }),
      getId: message => message.id,
    }).load();

    expect(repository.messages).toHaveLength(2);
    expect(repository.messages[0]?.message).toMatchObject({
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      role: 'user',
      parts: [{ type: 'text', text: 'Message text was not saved.' }],
    });
    expect(repository.messages[1]?.message).toMatchObject({
      id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Linked run.' },
        { type: 'data-saved-run', data: { runId, capability: 'meridian-member-inquiry', version: '1.0.0', state: 'success' } },
      ],
    });
    expect(isSavedConversationMessage(repository.messages[1]?.message)).toBe(true);
    expect(calls.map(call => call.path)).toEqual([
      `/conversations/${conversationId}/events?after=0&limit=100`,
    ]);
    expect(calls.some(call => call.path.includes('/runs/') || call.path.includes('/api/chat') || call.path.includes('/invoke'))).toBe(false);
    expect(JSON.stringify(repository)).not.toContain('must-not-be-sent');
  });

  it('writes only strict B1 event bodies and freezes message attempts across retries', async () => {
    const eventId = randomUUID();
    let attempt = 0;
    const { calls, request } = requestRecorder((path, options) => {
      if (path === `/conversations/${conversationId}/events`) {
        attempt += 1;
        if (attempt === 1) return response({ error: 'temporary failure' }, 503);
        return response({
          id: eventId,
          sequence: 1,
          kind: 'message_omitted',
          role: 'user',
          createdAt: metadata.createdAt,
        }, 201);
      }
      throw new Error(`unexpected request ${path}`);
    });
    const controller = createConversationController({ subjectId, request });
    const message = {
      id: 'printable-message-id',
      role: 'user',
      parts: [{ type: 'text', text: 'PRIVATE raw message name balance credential approval evidence URL' }],
      metadata: { custom: { meridianSaved: false } },
    } as UIMessage;
    const formatted = controller.historyFor(conversationId).withFormat!({
      format: 'ai-sdk/v6',
      encode: () => ({ raw: 'PRIVATE encoded message' }),
      decode: stored => ({ parentId: stored.parent_id, message: stored.content as UIMessage }),
      getId: item => item.id,
    });

    await expect(formatted.append({ parentId: null, message })).rejects.toThrow();
    expect(controller.getState(conversationId)).toMatchObject({ status: 'unavailable', revision: 0 });
    await expect(formatted.append({ parentId: null, message })).resolves.toBeUndefined();

    expect(calls).toHaveLength(2);
    const firstBody = JSON.parse(String(calls[0]?.options?.body));
    const secondBody = JSON.parse(String(calls[1]?.options?.body));
    expect(firstBody).toEqual(secondBody);
    expect(Object.keys(firstBody).sort()).toEqual(['expectedRevision', 'id', 'kind', 'role']);
    expect(firstBody).toMatchObject({ kind: 'message_omitted', role: 'user', expectedRevision: 0 });
    expect(firstBody.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(String(calls[0]?.options?.body)).not.toContain('PRIVATE');
  });

  it('stops on a revision conflict and reconciles metadata without retargeting the frozen write', async () => {
    const reconcile = { ...metadata, revision: 4, archived: true };
    const { calls, request } = requestRecorder((path) => {
      if (path === `/conversations/${conversationId}/events`) return response({ error: 'conflict' }, 409);
      if (path === `/conversations/${conversationId}`) return response(reconcile);
      throw new Error(`unexpected request ${path}`);
    });
    const controller = createConversationController({ subjectId, request });
    const formatted = controller.historyFor(conversationId).withFormat!({
      format: 'ai-sdk/v6',
      encode: () => ({ raw: 'not used' }),
      decode: stored => ({ parentId: stored.parent_id, message: stored.content as UIMessage }),
      getId: item => item.id,
    });
    const message = { id: 'conflict-message', role: 'assistant', parts: [{ type: 'text', text: 'safe' }] } as UIMessage;

    await expect(formatted.append({ parentId: null, message })).rejects.toThrow();
    expect(controller.getState(conversationId)).toMatchObject({ status: 'conflict', revision: 4, archived: true });
    expect(calls.map(call => call.path)).toEqual([
      `/conversations/${conversationId}/events`,
      `/conversations/${conversationId}`,
    ]);
    await expect(formatted.append({ parentId: null, message })).rejects.toThrow(/conflict|saving/i);
    expect(calls).toHaveLength(2);
  });

  it('does not enable saved navigation or history for legacy sessions', async () => {
    const request = vi.fn<ConversationRequest>();
    const controller = createConversationController({ request });
    await expect(controller.adapter.list()).resolves.toEqual({ threads: [] });
    expect(controller.historyFor('__LOCALID_legacy')).toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });

  it('maps regular and archived cursors and follows every event page', async () => {
    const firstEvent = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const secondEvent = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const afterConversation = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const { calls, request } = requestRecorder((path) => {
      if (path === '/conversations?archived=false&limit=50') {
        return response({ conversations: [metadata], nextCursor: afterConversation });
      }
      if (path === `/conversations?archived=true&limit=50`) {
        return response({ conversations: [] });
      }
      if (path === `/conversations?archived=false&limit=50&after=${afterConversation}`) {
        return response({ conversations: [] });
      }
      if (path === `/conversations?archived=true&limit=50&after=${afterConversation}`) {
        return response({ conversations: [] });
      }
      if (path === `/conversations/${conversationId}/events?after=0&limit=100`) {
        return response({ events: [{ id: firstEvent, sequence: 1, kind: 'message_omitted', role: 'user', createdAt: metadata.createdAt }], nextCursor: 1 });
      }
      if (path === `/conversations/${conversationId}/events?after=1&limit=100`) {
        return response({ events: [{ id: secondEvent, sequence: 2, kind: 'message_omitted', role: 'assistant', createdAt: metadata.updatedAt }] });
      }
      throw new Error(`unexpected request ${path}`);
    });
    const controller = createConversationController({ subjectId, request });

    const firstPage = await controller.adapter.list();
    expect(firstPage.nextCursor).toBeDefined();
    expect(firstPage.nextCursor).not.toBe(afterConversation);
    await expect(controller.adapter.list({ after: firstPage.nextCursor })).resolves.toEqual({ threads: [] });
    const repository = await controller.historyFor(conversationId).withFormat!({
      format: 'ai-sdk/v6',
      encode: () => ({ raw: 'not used' }),
      decode: stored => ({ parentId: stored.parent_id, message: stored.content as UIMessage }),
      getId: message => message.id,
    }).load();

    expect(repository.messages).toHaveLength(2);
    expect(calls.map(call => call.path)).toEqual([
      '/conversations?archived=false&limit=50',
      '/conversations?archived=true&limit=50',
      `/conversations?archived=false&limit=50&after=${afterConversation}`,
      `/conversations/${conversationId}/events?after=0&limit=100`,
      `/conversations/${conversationId}/events?after=1&limit=100`,
    ]);
  });

  it('writes an independent authorized run link after the omission without encoding message content', async () => {
    let sequence = 0;
    const { calls, request } = requestRecorder((path, options) => {
      if (path !== `/conversations/${conversationId}/events`) throw new Error(`unexpected request ${path}`);
      sequence += 1;
      const body = JSON.parse(String(options?.body));
      return response({
        id: body.id,
        sequence,
        kind: body.kind,
        role: body.role,
        ...(body.runId ? { runId: body.runId } : {}),
        createdAt: metadata.updatedAt,
      }, 201);
    });
    const controller = createConversationController({ subjectId, request });
    const history = controller.historyFor(conversationId).withFormat!({
      format: 'ai-sdk/v6',
      encode: () => ({ raw: 'PRIVATE encoded canary' }),
      decode: stored => ({ parentId: stored.parent_id, message: stored.content as UIMessage }),
      getId: message => message.id,
    });
    const message = { id: 'authoritative-user-id', role: 'user', parts: [{ type: 'text', text: 'PRIVATE body canary' }] } as UIMessage;

    await history.append({ parentId: null, message });
    await controller.linkRun(message.id, runId);

    expect(calls).toHaveLength(2);
    const omission = JSON.parse(String(calls[0]?.options?.body));
    const linked = JSON.parse(String(calls[1]?.options?.body));
    expect(Object.keys(omission).sort()).toEqual(['expectedRevision', 'id', 'kind', 'role']);
    expect(Object.keys(linked).sort()).toEqual(['expectedRevision', 'id', 'kind', 'role', 'runId']);
    expect(linked).toMatchObject({ kind: 'run_linked', role: 'assistant', runId, expectedRevision: 1 });
    expect(linked.id).not.toBe(omission.id);
    expect(String(calls[1]?.options?.body)).not.toContain('PRIVATE');
  });

  it('keeps a pinned write on its original conversation and makes disposed epochs inert', async () => {
    let release!: () => void;
    let reached!: () => void;
    const reachedPromise = new Promise<void>(resolve => { reached = resolve; });
    const releasePromise = new Promise<void>(resolve => { release = resolve; });
    let eventCalls = 0;
    const { calls, request } = requestRecorder(async (path, options) => {
      if (path === `/conversations/${conversationId}/events`) {
        eventCalls += 1;
        reached();
        await releasePromise;
        const body = JSON.parse(String(options?.body));
        return response({ id: body.id, sequence: 1, kind: body.kind, role: body.role, createdAt: metadata.createdAt }, 201);
      }
      if (path === `/conversations/${'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'}/events`) {
        const body = JSON.parse(String(options?.body));
        return response({ id: body.id, sequence: 1, kind: body.kind, role: body.role, createdAt: metadata.createdAt }, 201);
      }
      throw new Error(`unexpected request ${path}`);
    });
    const controller = createConversationController({ subjectId, request });
    const historyA = controller.historyFor(conversationId).withFormat!({
      format: 'ai-sdk/v6',
      encode: () => ({ raw: 'not used' }),
      decode: stored => ({ parentId: stored.parent_id, message: stored.content as UIMessage }),
      getId: message => message.id,
    });
    const historyB = controller.historyFor('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').withFormat!({
      format: 'ai-sdk/v6',
      encode: () => ({ raw: 'not used' }),
      decode: stored => ({ parentId: stored.parent_id, message: stored.content as UIMessage }),
      getId: message => message.id,
    });
    const writeA = historyA.append({ parentId: null, message: { id: 'pinned-a', role: 'user', parts: [{ type: 'text', text: 'safe' }] } as UIMessage });
    await reachedPromise;
    release();
    await writeA;
    expect(calls[0]?.path).toBe(`/conversations/${conversationId}/events`);
    expect(eventCalls).toBe(1);

    controller.dispose();
    await expect(historyB.append({ parentId: null, message: { id: 'disposed-b', role: 'user', parts: [{ type: 'text', text: 'safe' }] } as UIMessage })).rejects.toThrow();
    expect(calls).toHaveLength(1);
  });

  it('filters inert saved placeholders before constructing model context', () => {
    const saved = {
      id: 'saved-event-id',
      role: 'assistant',
      parts: [
        { type: 'text', text: 'Message text was not saved.' },
        { type: 'data-saved-run', data: { runId, capability: 'meridian-member-inquiry', version: '1.0.0', state: 'success' } },
      ],
      metadata: { custom: { meridianSaved: true } },
    } as UIMessage;
    const current = { id: 'fresh-user-id', role: 'user', parts: [{ type: 'text', text: 'What is safe to ask?' }] } as UIMessage;

    const prepared = chatRequest([saved, current], 'printable-thread-id');

    expect(prepared.headers['Idempotency-Key']).toBe(current.id);
    expect(prepared.body.messages).toEqual([current]);
    expect(JSON.stringify(prepared.body)).not.toContain('Message text was not saved.');
    expect(JSON.stringify(prepared.body)).not.toContain('data-saved-run');
    expect(JSON.stringify(prepared.body)).not.toContain(runId);
  });

  it('exposes truthful subject, unavailable, conflict, and legacy status text', () => {
    expect(conversationStatusText('saved', true)).toBe('Conversations ready.');
    expect(conversationStatusText('saving', true)).toBe('Saving conversation…');
    expect(conversationStatusText('unavailable', true)).toBe('Conversations unavailable; this chat is not saved.');
    expect(conversationStatusText('conflict', true)).toBe('Conversation changed elsewhere; saving stopped until it is refreshed.');
    expect(conversationStatusText('unsaved', false)).toBe('Conversations are not saved for this legacy session.');
  });

  it('scopes the formatted history cache to its remote conversation', async () => {
    const events = (id: string) => ({
      events: [{ id, sequence: 1, kind: 'message_omitted', role: 'user', createdAt: metadata.createdAt }],
    });
    const { calls, request } = requestRecorder((path) => {
      if (path === `/conversations/${conversationId}/events?after=0&limit=100`) return response(events('dddddddd-dddd-4ddd-8ddd-dddddddddddd'));
      if (path === `/conversations/${otherConversationId}/events?after=0&limit=100`) return response(events('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'));
      if (path === `/conversations/${otherConversationId}/events`) return response({
        id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', sequence: 2, kind: 'message_omitted', role: 'assistant', createdAt: metadata.updatedAt,
      }, 201);
      throw new Error(`unexpected request ${path}`);
    });
    const controller = createConversationController({ subjectId, request });
    const format = {
      format: 'ai-sdk/v6',
      encode: () => ({ raw: 'not used' }),
      decode: stored => ({ parentId: stored.parent_id, message: stored.content as UIMessage }),
      getId: message => message.id,
    };
    const historyA = controller.historyFor(conversationId).withFormat!(format);
    const historyB = controller.historyFor(otherConversationId).withFormat!(format);

    expect(historyB).not.toBe(historyA);
    await historyA.load();
    await historyB.load();
    await historyB.append({ parentId: null, message: { id: 'history-b', role: 'assistant', parts: [{ type: 'text', text: 'safe' }] } as UIMessage });

    expect(calls.map(call => call.path)).toEqual([
      `/conversations/${conversationId}/events?after=0&limit=100`,
      `/conversations/${otherConversationId}/events?after=0&limit=100`,
      `/conversations/${otherConversationId}/events`,
    ]);
  });

  it('freezes each queued body at its first network attempt so concurrent appends use revisions 0 then 1', async () => {
    const bodies: Record<string, unknown>[] = [];
    const { request } = requestRecorder((path, options) => {
      if (path !== `/conversations/${conversationId}/events`) throw new Error(`unexpected request ${path}`);
      const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (body.expectedRevision !== bodies.length - 1) return response({ error: 'conflict' }, 409);
      return response({
        id: body.id,
        sequence: bodies.length,
        kind: body.kind,
        role: body.role,
        createdAt: metadata.updatedAt,
      }, 201);
    });
    const controller = createConversationController({ subjectId, request });
    const history = controller.historyFor(conversationId);

    const first = history.append({ parentId: null, message: { id: 'concurrent-a', role: 'user', parts: [{ type: 'text', text: 'a' }] } as UIMessage });
    const second = history.append({ parentId: null, message: { id: 'concurrent-b', role: 'user', parts: [{ type: 'text', text: 'b' }] } as UIMessage });
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);

    expect(bodies.map(body => body.expectedRevision)).toEqual([0, 1]);
    expect(bodies[0]?.id).not.toBe(bodies[1]?.id);
  });

  it('preserves independent regular and archived cursors inside the SDK cursor', async () => {
    const regularCursor = 'f1111111-1111-4111-8111-111111111111';
    const archivedCursor = 'e2222222-2222-4222-8222-222222222222';
    const archivedSecond = { ...metadata, id: thirdConversationId, archived: true };
    const { calls, request } = requestRecorder((path) => {
      if (path === '/conversations?archived=false&limit=50') return response({ conversations: [metadata], nextCursor: regularCursor });
      if (path === '/conversations?archived=true&limit=50') return response({ conversations: [{ ...metadata, id: otherConversationId, archived: true }], nextCursor: archivedCursor });
      if (path === `/conversations?archived=false&limit=50&after=${regularCursor}`) return response({ conversations: [] });
      if (path === `/conversations?archived=true&limit=50&after=${archivedCursor}`) return response({ conversations: [archivedSecond] });
      throw new Error(`unexpected request ${path}`);
    });
    const controller = createConversationController({ subjectId, request });

    const first = await controller.adapter.list();
    expect(first.threads.map(thread => thread.remoteId)).toEqual([conversationId, otherConversationId]);
    expect(first.nextCursor).toBeDefined();
    expect(first.nextCursor).not.toBe(regularCursor);
    expect(first.nextCursor).not.toBe(archivedCursor);

    const second = await controller.adapter.list({ after: first.nextCursor });
    expect(second.threads.map(thread => thread.remoteId)).toEqual([thirdConversationId]);
    expect(calls.map(call => call.path)).toEqual([
      '/conversations?archived=false&limit=50',
      '/conversations?archived=true&limit=50',
      `/conversations?archived=false&limit=50&after=${regularCursor}`,
      `/conversations?archived=true&limit=50&after=${archivedCursor}`,
    ]);
  });

  it('keys run links by the requested earlier user message', async () => {
    let sequence = 0;
    const { calls, request } = requestRecorder((path, options) => {
      if (path !== `/conversations/${conversationId}/events`) throw new Error(`unexpected request ${path}`);
      const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
      sequence += 1;
      return response({ id: body.id, sequence, kind: body.kind, role: body.role, ...(body.runId ? { runId: body.runId } : {}), createdAt: metadata.updatedAt }, 201);
    });
    const controller = createConversationController({ subjectId, request });
    const history = controller.historyFor(conversationId);
    const userA = { id: 'requested-user-a', role: 'user', parts: [{ type: 'text', text: 'a' }] } as UIMessage;
    const userB = { id: 'requested-user-b', role: 'user', parts: [{ type: 'text', text: 'b' }] } as UIMessage;

    await history.append({ parentId: null, message: userA });
    await history.append({ parentId: null, message: userB });
    await controller.linkRun(userB.id, runId);
    await controller.linkRun(userA.id, runId);

    expect(calls).toHaveLength(4);
    const links = calls.slice(2).map(call => JSON.parse(String(call.options?.body)) as Record<string, unknown>);
    expect(links).toHaveLength(2);
    expect(links[0]?.runId).toBe(runId);
    expect(links[1]?.runId).toBe(runId);
    expect(links[0]?.id).not.toBe(links[1]?.id);
  });

  it('scopes identical message attempts by remote conversation', async () => {
    const calls: { path: string; body: Record<string, unknown> }[] = [];
    const { request } = requestRecorder((path, options) => {
      if (!path.endsWith('/events')) throw new Error(`unexpected request ${path}`);
      const body = JSON.parse(String(options?.body)) as Record<string, unknown>;
      calls.push({ path, body });
      return response({ id: body.id, sequence: 1, kind: body.kind, role: body.role, createdAt: metadata.updatedAt }, 201);
    });
    const controller = createConversationController({ subjectId, request });
    const message = { id: 'reused-message-id', role: 'user', parts: [{ type: 'text', text: 'safe' }] } as UIMessage;

    await controller.historyFor(conversationId).append({ parentId: null, message });
    await controller.historyFor(otherConversationId).append({ parentId: null, message });

    expect(calls).toHaveLength(2);
    expect(calls.map(call => call.path)).toEqual([
      `/conversations/${conversationId}/events`,
      `/conversations/${otherConversationId}/events`,
    ]);
    expect(calls[0]?.body.id).not.toBe(calls[1]?.body.id);
  });

  it('does not commit deferred response JSON after the conversation epoch is disposed', async () => {
    let resolveJson!: (value: unknown) => void;
    let jsonStarted = false;
    const json = new Promise<unknown>(resolve => { resolveJson = resolve; });
    const { calls, request } = requestRecorder(() => ({
      ok: true,
      status: 200,
      json: () => {
        jsonStarted = true;
        return json;
      },
    } as Response));
    const controller = createConversationController({ subjectId, request });
    const pending = controller.adapter.initialize('__LOCALID_epoch');
    expect(calls).toHaveLength(1);
    await vi.waitFor(() => expect(jsonStarted).toBe(true));
    const createdId = JSON.parse(String(calls[0]?.options?.body)).id as string;

    controller.dispose();
    resolveJson({ ...metadata, id: createdId });

    await expect(pending).rejects.toThrow(/session changed|epoch/i);
    expect(controller.getState(createdId)).toMatchObject({ status: 'unsaved', revision: 0 });
  });

  it('disables conversation actions only while the item is running', () => {
    expect(conversationActionsDisabled({ isRunning: false })).toBe(false);
    expect(conversationActionsDisabled({ isRunning: true })).toBe(true);
  });

  it('keeps subject/global status truthful for storage failures, delete, and selected-thread races', async () => {
    const unavailable = createConversationController({
      subjectId,
      request: requestRecorder(() => response({ error: 'offline' }, 503)).request,
    });
    await expect(unavailable.adapter.list()).rejects.toThrow();
    expect(unavailable.getState()).toMatchObject({ status: 'unavailable' });
    expect(conversationStatusText(unavailable.getState().status, true)).toContain('unavailable');

    const failedAppend = createConversationController({
      subjectId,
      request: requestRecorder(path => {
        if (path.endsWith('/events')) return response({ error: 'failed' }, 500);
        throw new Error(`unexpected request ${path}`);
      }).request,
    });
    await expect(failedAppend.historyFor(conversationId).append({
      parentId: null,
      message: { id: 'failed-append', role: 'user', parts: [{ type: 'text', text: 'safe' }] } as UIMessage,
    })).rejects.toThrow();
    expect(failedAppend.getState()).toMatchObject({ status: 'unsaved' });
    expect(conversationStatusText(failedAppend.getState().status, true)).not.toContain('ready');

    const deleteRecorder = requestRecorder((path, options) => {
      if (path === '/conversations') {
        const id = JSON.parse(String(options?.body)).id;
        return response({ ...metadata, id }, 201);
      }
      if (path === `/conversations/${conversationId}` && options?.method === 'DELETE') return response(undefined, 204);
      throw new Error(`unexpected request ${path}`);
    });
    const deleted = createConversationController({ subjectId, request: deleteRecorder.request });
    await deleted.adapter.initialize('__LOCALID_delete');
    await deleted.adapter.delete(conversationId);
    expect(deleted.getState()).toMatchObject({ status: 'saved', revision: 0 });
    expect(conversationStatusText(deleted.getState().status, true)).toBe('Conversations ready.');

    const raceRecorder = requestRecorder((path) => {
      if (path === `/conversations/${otherConversationId}`) return response({ ...metadata, id: otherConversationId });
      if (path === `/conversations/${conversationId}/events`) return response({ error: 'failed' }, 500);
      throw new Error(`unexpected request ${path}`);
    });
    const race = createConversationController({ subjectId, request: raceRecorder.request });
    await race.adapter.fetch(otherConversationId);
    race.select(otherConversationId);
    await expect(race.historyFor(conversationId).append({
      parentId: null,
      message: { id: 'stale-a', role: 'user', parts: [{ type: 'text', text: 'safe' }] } as UIMessage,
    })).rejects.toThrow();
    expect(race.getState()).toMatchObject({ status: 'saved' });
  });

  it('catches completion run-link failures for visible persistence status', async () => {
    const failed = vi.fn();
    trackConversationWriteFailure(Promise.reject(new Error('storage unavailable')), failed);
    await vi.waitFor(() => expect(failed).toHaveBeenCalledTimes(1));
  });

  it.each([
    ['empty page cursor', { events: [], nextCursor: 0 }],
    ['cursor skips returned events', { events: [{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', sequence: 1, kind: 'message_omitted', role: 'user' }], nextCursor: 3 }],
  ])('rejects a non-progressing or non-exact event cursor: %s', async (_label, page) => {
    let calls = 0;
    const { request } = requestRecorder((path) => {
      if (!path.includes('/events')) throw new Error(`unexpected request ${path}`);
      calls += 1;
      if (calls === 1) return response(page);
      throw new Error('cursor looped or skipped');
    });
    const controller = createConversationController({ subjectId, request });

    await expect(controller.historyFor(conversationId).load()).rejects.toThrow(/cursor/i);
    expect(calls).toBe(1);
  });

  it('rejects linkRun after disposal without repopulating pending state', async () => {
    const { request, calls } = requestRecorder(() => response(undefined, 204));
    const controller = createConversationController({ subjectId, request });
    controller.dispose();

    await expect(controller.linkRun('late-user', runId)).rejects.toThrow(/session changed|epoch/i);
    expect(calls).toHaveLength(0);
  });
});
