'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { UIMessage } from 'ai';
import { useChatRuntime, type UseChatRuntimeOptions } from '@assistant-ui/ai-sdk';
import type {
  AssistantRuntime,
  GenericThreadHistoryAdapter,
  MessageFormatAdapter,
  MessageFormatItem,
  RemoteThreadListAdapter,
  RemoteThreadListResponse,
  RemoteThreadMetadata,
  ThreadHistoryAdapter,
  ThreadMessage,
} from '@assistant-ui/core';
import { useRemoteThreadListRuntime } from '@assistant-ui/core/react';
import type { DataMessagePartProps } from '@assistant-ui/core/react';
import {
  AssistantRuntimeProvider,
  ThreadListPrimitive,
  ThreadListItemPrimitive,
} from '@assistant-ui/react';
import { useAui, useAuiState } from '@assistant-ui/store';
import type { Session } from './session';

export type ConversationRequest = (
  path: string,
  options?: RequestInit,
) => Promise<Response>;

export const CONVERSATION_TITLE = 'Saved conversation';
export const MESSAGE_OMITTED_TEXT = 'Message text was not saved.';
export const RUN_LINKED_TEXT = 'Linked run.';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const capabilityPattern = /^[a-z0-9][a-z0-9-]{0,127}$/;
const safeStatePattern = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const safeVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

type ConversationRecord = {
  id: string;
  archived: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
};

type ConversationEvent = {
  id: string;
  sequence: number;
  kind: 'message_omitted' | 'run_linked';
  role: 'user' | 'assistant';
  runId?: string;
  run?: SafeRun;
  createdAt?: string;
};

export type SafeRun = {
  runId: string;
  capability: string;
  version: string;
  state: string;
};

export type ConversationSaveStatus =
  | 'loading'
  | 'saving'
  | 'saved'
  | 'unavailable'
  | 'conflict'
  | 'unsaved';

export type ConversationState = {
  status: ConversationSaveStatus;
  revision: number;
  archived?: boolean;
  error?: string;
};

type RequestFailure = Error & { status?: number };

class ConversationRequestError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(status === 503 ? 'Conversation storage is unavailable.' : `Conversation request failed (${status}).`);
    this.name = 'ConversationRequestError';
    this.status = status;
  }
}

class ConversationEpochError extends Error {
  constructor() {
    super('Conversation session changed before the operation completed.');
    this.name = 'ConversationEpochError';
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function lowerUuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !uuidPattern.test(value) || value !== value.toLowerCase())
    throw new Error(`Invalid ${label}.`);
  return value;
}

function newUuid(): string {
  const cryptoObject = globalThis.crypto;
  if (typeof cryptoObject?.randomUUID === 'function') return cryptoObject.randomUUID().toLowerCase();
  if (typeof cryptoObject?.getRandomValues !== 'function') throw new Error('Conversation identifiers are unavailable.');
  const bytes = new Uint8Array(16);
  cryptoObject.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseConversation(value: unknown): ConversationRecord {
  if (!plainRecord(value)
    || typeof value.archived !== 'boolean'
    || typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 0
    || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string') {
    throw new Error('Conversation metadata was invalid.');
  }
  return {
    id: lowerUuid(value.id, 'conversation id'),
    archived: value.archived,
    revision: value.revision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function parseSafeRun(value: unknown): SafeRun | undefined {
  if (!plainRecord(value)) return undefined;
  try {
    const runId = lowerUuid(value.runId, 'run id');
    if (typeof value.capability !== 'string' || !capabilityPattern.test(value.capability)) return undefined;
    if (typeof value.version !== 'string' || !safeVersionPattern.test(value.version)) return undefined;
    if (typeof value.state !== 'string' || !safeStatePattern.test(value.state)) return undefined;
    return { runId, capability: value.capability, version: value.version, state: value.state };
  } catch {
    return undefined;
  }
}

function parseEvent(value: unknown): ConversationEvent {
  if (!plainRecord(value)
    || typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 1
    || (value.kind !== 'message_omitted' && value.kind !== 'run_linked')
    || (value.role !== 'user' && value.role !== 'assistant')) {
    throw new Error('Conversation event was invalid.');
  }
  const event: ConversationEvent = {
    id: lowerUuid(value.id, 'event id'),
    sequence: value.sequence,
    kind: value.kind,
    role: value.role,
  };
  if (value.kind === 'run_linked') {
    const runId = lowerUuid(value.runId, 'run id');
    const run = parseSafeRun(value.run);
    event.runId = runId;
    if (run?.runId === runId) event.run = run;
  }
  if (typeof value.createdAt === 'string') event.createdAt = value.createdAt;
  return event;
}

function toMetadata(record: ConversationRecord): RemoteThreadMetadata {
  return {
    remoteId: record.id,
    title: CONVERSATION_TITLE,
    status: record.archived ? 'archived' : 'regular',
    lastMessageAt: new Date(record.updatedAt),
  };
}

function savedMetadata(): Record<string, unknown> {
  return { custom: { meridianSaved: true } };
}

type ListCursorPart = string | null | undefined;
type ListCursor = { regular: ListCursorPart; archived: ListCursorPart };
const listCursorPrefix = 'meridian-list-v1:';

function encodeListCursor(cursor: ListCursor): string | undefined {
  if (typeof cursor.regular !== 'string' && typeof cursor.archived !== 'string') return undefined;
  return `${listCursorPrefix}${encodeURIComponent(JSON.stringify({
    regular: cursor.regular ?? null,
    archived: cursor.archived ?? null,
  }))}`;
}

function decodeListCursor(value: string | undefined): ListCursor {
  if (value === undefined) return { regular: undefined, archived: undefined };
  if (!value.startsWith(listCursorPrefix)) throw new Error('Conversation list cursor was invalid.');
  try {
    const parsed = JSON.parse(decodeURIComponent(value.slice(listCursorPrefix.length))) as unknown;
    if (!plainRecord(parsed) || !('regular' in parsed) || !('archived' in parsed)) throw new Error();
    const parsePart = (part: unknown, label: string): ListCursorPart => {
      if (part === null) return null;
      return lowerUuid(part, `${label} conversation cursor`);
    };
    return {
      regular: parsePart(parsed.regular, 'regular'),
      archived: parsePart(parsed.archived, 'archived'),
    };
  } catch {
    throw new Error('Conversation list cursor was invalid.');
  }
}

function endpointNextCursor(value: unknown, label: string): string | undefined {
  if (!plainRecord(value) || value.nextCursor === undefined) return undefined;
  return lowerUuid(value.nextCursor, `${label} conversation cursor`);
}

export function isSavedConversationMessage(value: unknown): boolean {
  if (!plainRecord(value) || !plainRecord(value.metadata) || !plainRecord(value.metadata.custom)) return false;
  return value.metadata.custom.meridianSaved === true;
}

function restoredMessage(event: ConversationEvent): UIMessage {
  const parts: unknown[] = [{ type: 'text', text: event.kind === 'message_omitted' ? MESSAGE_OMITTED_TEXT : RUN_LINKED_TEXT }];
  if (event.kind === 'run_linked' && event.run) {
    parts.push({ type: 'data-saved-run', data: event.run });
  }
  return {
    id: event.id,
    role: event.role,
    parts,
    metadata: savedMetadata(),
  } as UIMessage;
}

function safeMessageId(message: unknown): string {
  if (!plainRecord(message) || typeof message.id !== 'string' || message.id.length === 0 || message.id.length > 200)
    throw new Error('Conversation message identity was invalid.');
  return message.id;
}

function errorStatus(error: unknown): number | undefined {
  if ((typeof error !== 'object' && typeof error !== 'function') || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : undefined;
}

function statusError(status: ConversationSaveStatus): string | undefined {
  if (status === 'unavailable') return 'Conversation storage is unavailable; this chat is not saved.';
  if (status === 'conflict') return 'Conversation changed elsewhere; saving stopped until it is refreshed.';
  if (status === 'unsaved') return 'This chat remains usable, but its conversation changes are not saved.';
  return undefined;
}

export function conversationStatusText(status: ConversationSaveStatus, subject: boolean): string {
  if (!subject) return 'Conversations are not saved for this legacy session.';
  if (status === 'saving') return 'Saving conversation…';
  if (status === 'unavailable') return 'Conversations unavailable; this chat is not saved.';
  if (status === 'conflict') return 'Conversation changed elsewhere; saving stopped until it is refreshed.';
  if (status === 'unsaved') return 'Conversations not saved; this chat remains usable.';
  return 'Conversations ready.';
}

export function conversationActionsDisabled(item: { isRunning: boolean }): boolean {
  return item.isRunning;
}

export function trackConversationWriteFailure(
  promise: Promise<void>,
  onFailure: () => void,
): void {
  void promise.catch(onFailure);
}

export type ConversationController = {
  adapter: RemoteThreadListAdapter;
  toMetadata(record: ConversationRecord): RemoteThreadMetadata;
  historyFor(remoteId: string): ThreadHistoryAdapter;
  getState(remoteId?: string): ConversationState;
  select(remoteId?: string): void;
  subscribe(callback: () => void): () => void;
  linkRun(userMessageId: string, runId: string): Promise<void>;
  dispose(): void;
};

type EventBody = {
  id: string;
  kind: 'message_omitted' | 'run_linked';
  role: 'user' | 'assistant';
  runId?: string;
  expectedRevision: number;
};

type Attempt = {
  descriptor: Omit<EventBody, 'id' | 'expectedRevision'>;
  body?: Readonly<EventBody>;
  completed: boolean;
};

export function createConversationController(options: {
  subjectId?: string;
  request: ConversationRequest;
  getRunIdForUserMessage?: (userMessageId: string) => string | undefined;
}): ConversationController {
  const subjectId = options.subjectId && uuidPattern.test(options.subjectId) && options.subjectId === options.subjectId.toLowerCase()
    ? options.subjectId
    : undefined;
  const epochController = new AbortController();
  let epoch = 1;
  let disposed = false;
  const metadata = new Map<string, ConversationRecord>();
  const state = new Map<string, ConversationState>();
  const queues = new Map<string, Promise<void>>();
  const attempts = new Map<string, Attempt>();
  const stopped = new Set<string>();
  const historyAdapters = new Map<string, ThreadHistoryAdapter>();
  const genericAdapters = new Map<string, WeakMap<object, GenericThreadHistoryAdapter<UIMessage>>>();
  const messageConversations = new Map<string, string>();
  const userMessages = new Map<string, string>();
  const pendingRunLinks = new Map<string, string>();
  const listeners = new Set<() => void>();
  const localConversationIds = new Map<string, string>();
  let selectedRemoteId: string | undefined;
  let overallState: ConversationState = { status: subjectId ? 'saved' : 'unsaved', revision: 0 };

  const notify = () => {
    for (const listener of listeners) listener();
  };

  const isCurrent = (capturedEpoch: number) => !disposed && capturedEpoch === epoch && !epochController.signal.aborted;

  const currentState = (remoteId: string): ConversationState => {
    const record = metadata.get(remoteId);
    return state.get(remoteId) ?? {
      status: 'unsaved',
      revision: record?.revision ?? 0,
      ...(record ? { archived: record.archived } : {}),
    };
  };

  const setState = (remoteId: string, status: ConversationSaveStatus, extra: Partial<ConversationState> = {}) => {
    const record = metadata.get(remoteId);
    const next: ConversationState = {
      ...currentState(remoteId),
      status,
      revision: extra.revision ?? record?.revision ?? currentState(remoteId).revision,
      ...(record ? { archived: record.archived } : {}),
      ...extra,
    };
    const error = extra.error ?? statusError(status);
    if (error === undefined) delete next.error;
    else next.error = error;
    state.set(remoteId, next);
    if (selectedRemoteId === undefined || selectedRemoteId === remoteId) overallState = next;
    notify();
  };

  const selectConversation = (remoteId?: string) => {
    if (disposed) return;
    const nextRemoteId = remoteId && uuidPattern.test(remoteId) && remoteId === remoteId.toLowerCase()
      ? remoteId
      : undefined;
    selectedRemoteId = nextRemoteId;
    overallState = nextRemoteId
      ? currentState(nextRemoteId)
      : { status: subjectId ? 'saved' : 'unsaved', revision: 0 };
    notify();
  };

  const setOverallStatus = (status: ConversationSaveStatus) => {
    overallState = { ...overallState, status };
    const error = statusError(status);
    if (error === undefined) delete overallState.error;
    else overallState.error = error;
    notify();
  };

  const requestJson = async function requestJson<T>(path: string, requestOptions: RequestInit, capturedEpoch: number): Promise<T> {
    if (!isCurrent(capturedEpoch)) throw new ConversationEpochError();
    let response: Response;
    try {
      response = await options.request(path, {
        ...requestOptions,
        signal: AbortSignal.any([epochController.signal, requestOptions.signal ?? new AbortController().signal]),
      });
    } catch (error) {
      if (!isCurrent(capturedEpoch)) throw new ConversationEpochError();
      throw error;
    }
    if (!isCurrent(capturedEpoch)) throw new ConversationEpochError();
    if (!response.ok) throw new ConversationRequestError(response.status);
    if (response.status === 204) return undefined as T;
    try {
      const body = await response.json() as T;
      if (!isCurrent(capturedEpoch)) throw new ConversationEpochError();
      return body;
    } catch {
      if (!isCurrent(capturedEpoch)) throw new ConversationEpochError();
      throw new Error('Conversation response was invalid.');
    }
  };

  const remember = (record: ConversationRecord, preserveStatus = false) => {
    metadata.set(record.id, record);
    const existing = currentState(record.id);
    state.set(record.id, {
      ...existing,
      status: preserveStatus ? existing.status : 'saved',
      revision: record.revision,
      archived: record.archived,
      ...(preserveStatus && existing.error ? { error: existing.error } : {}),
    });
    if (selectedRemoteId === undefined || selectedRemoteId === record.id) overallState = state.get(record.id)!;
    notify();
  };

  const reconcile = async (remoteId: string, capturedEpoch: number) => {
    try {
      const raw = await requestJson<unknown>(`/conversations/${remoteId}`, { method: 'GET', cache: 'no-store' }, capturedEpoch);
      const record = parseConversation(raw);
      if (record.id !== remoteId || !isCurrent(capturedEpoch)) return;
      metadata.set(remoteId, record);
      const previous = currentState(remoteId);
      state.set(remoteId, { ...previous, status: 'conflict', revision: record.revision, archived: record.archived, error: statusError('conflict') });
      if (selectedRemoteId === undefined || selectedRemoteId === remoteId) overallState = state.get(remoteId)!;
      notify();
    } catch {
      // The conflict state remains visible even if safe metadata reconciliation is unavailable.
    }
  };

  const queueEvent = (
    remoteId: string,
    attemptKey: string,
    descriptor: Omit<EventBody, 'id' | 'expectedRevision'>,
  ): Promise<void> => {
    const capturedEpoch = epoch;
    if (!subjectId || !isCurrent(capturedEpoch)) return Promise.reject(new ConversationEpochError());
    if (stopped.has(remoteId)) return Promise.reject(new Error('Conversation saving stopped after a revision conflict.'));
    const attempt = attempts.get(attemptKey) ?? { descriptor, completed: false };
    attempts.set(attemptKey, attempt);
    if (attempt.completed) return Promise.resolve();
    const previous = queues.get(remoteId) ?? Promise.resolve();
    const task = previous.catch(() => undefined).then(async () => {
      if (!isCurrent(capturedEpoch)) throw new ConversationEpochError();
      if (stopped.has(remoteId)) throw new Error('Conversation saving stopped after a revision conflict.');
      if (attempt.completed) return;
      setState(remoteId, 'saving');
      try {
        if (!attempt.body) {
          attempt.body = Object.freeze({ id: newUuid(), ...attempt.descriptor, expectedRevision: currentState(remoteId).revision });
        }
        const body = attempt.body;
        const raw = await requestJson<unknown>(`/conversations/${remoteId}/events`, {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }, capturedEpoch);
        if (!isCurrent(capturedEpoch)) throw new ConversationEpochError();
        const event = parseEvent(raw);
        const previousRecord = metadata.get(remoteId);
        if (previousRecord) {
          metadata.set(remoteId, { ...previousRecord, revision: event.sequence, updatedAt: typeof event.createdAt === 'string' ? event.createdAt : previousRecord.updatedAt });
        }
        attempt.completed = true;
        setState(remoteId, 'saved', { revision: event.sequence });
      } catch (error) {
        if (!isCurrent(capturedEpoch)) throw new ConversationEpochError();
        const status = errorStatus(error);
        if (status === 409) {
          stopped.add(remoteId);
          setState(remoteId, 'conflict');
          await reconcile(remoteId, capturedEpoch);
          throw new Error('Conversation revision conflict; saving stopped.');
        }
        if (status === 503) {
          setState(remoteId, 'unavailable');
        } else {
          setState(remoteId, 'unsaved');
        }
        throw error;
      }
    });
    const retained = task.then(
      () => {
        if (queues.get(remoteId) === retained) queues.delete(remoteId);
      },
      () => {
        if (queues.get(remoteId) === retained) queues.delete(remoteId);
      },
    );
    queues.set(remoteId, retained);
    return task;
  };

  const queueRunLink = (remoteId: string, messageId: string, runId: string): Promise<void> => {
    return queueEvent(remoteId, `run:${remoteId}:${messageId}:${runId}`, { kind: 'run_linked', role: 'assistant', runId });
  };

  const appendMessage = (remoteId: string, message: UIMessage): Promise<void> => {
    if (isSavedConversationMessage(message)) return Promise.resolve();
    if (!subjectId || !isCurrent(epoch)) return Promise.reject(new ConversationEpochError());
    const role = message.role;
    if (role !== 'user' && role !== 'assistant') return Promise.reject(new Error('Only user and assistant messages can be saved.'));
    let messageId: string;
    try {
      messageId = safeMessageId(message);
    } catch (error) {
      return Promise.reject(error);
    }
    messageConversations.set(messageId, remoteId);
    if (role === 'user') userMessages.set(remoteId, messageId);
    const omission = queueEvent(remoteId, `message:${remoteId}:${messageId}`, { kind: 'message_omitted', role });
    let runId: string | undefined;
    let linkedMessageId = messageId;
    if (role === 'user') {
      runId = pendingRunLinks.get(messageId);
      pendingRunLinks.delete(messageId);
    } else {
      const latestUserId = userMessages.get(remoteId);
      linkedMessageId = latestUserId ?? messageId;
      runId = latestUserId ? options.getRunIdForUserMessage?.(latestUserId) : undefined;
    }
    if (runId && uuidPattern.test(runId) && runId === runId.toLowerCase()) {
      return omission.then(() => queueRunLink(remoteId, linkedMessageId, runId));
    }
    return omission;
  };

  const loadEvents = async (remoteId: string): Promise<Array<{ parentId: string | null; message: UIMessage }>> => {
    const capturedEpoch = epoch;
    if (!isCurrent(capturedEpoch)) throw new ConversationEpochError();
    setState(remoteId, 'loading');
    try {
      const loaded: Array<{ parentId: string | null; message: UIMessage }> = [];
      let after = 0;
      for (;;) {
        const pageAfter = after;
        const raw = await requestJson<unknown>(`/conversations/${remoteId}/events?after=${pageAfter}&limit=100`, { method: 'GET', cache: 'no-store' }, capturedEpoch);
        if (!isCurrent(capturedEpoch)) throw new ConversationEpochError();
        if (!plainRecord(raw) || !Array.isArray(raw.events)) throw new Error('Conversation events response was invalid.');
        let lastSequence = pageAfter;
        for (const rawEvent of raw.events) {
          const event = parseEvent(rawEvent);
          if (event.sequence <= lastSequence) throw new Error('Conversation event cursor was invalid.');
          loaded.push({ parentId: loaded.at(-1)?.message.id ?? null, message: restoredMessage(event) });
          lastSequence = event.sequence;
        }
        if (!Object.prototype.hasOwnProperty.call(raw, 'nextCursor')) break;
        if (typeof raw.nextCursor !== 'number') throw new Error('Conversation event cursor was invalid.');
        if (!Number.isSafeInteger(raw.nextCursor) || raw.nextCursor <= pageAfter || raw.events.length === 0 || raw.nextCursor !== lastSequence) {
          throw new Error('Conversation event cursor was invalid.');
        }
        after = raw.nextCursor;
      }
      if (!isCurrent(capturedEpoch)) throw new ConversationEpochError();
      setState(remoteId, 'saved');
      return loaded;
    } catch (error) {
      if (!isCurrent(capturedEpoch)) throw new ConversationEpochError();
      if (errorStatus(error) === 503) setState(remoteId, 'unavailable');
      else setState(remoteId, 'unsaved');
      throw error;
    }
  };

  const makeGenericHistory = function makeGenericHistory<TMessage, TStorageFormat extends Record<string, unknown>>(
    remoteId: string,
    _formatAdapter: MessageFormatAdapter<TMessage, TStorageFormat>,
  ): GenericThreadHistoryAdapter<TMessage> {
    return {
    load: async () => {
      const loaded = await loadEvents(remoteId);
      return {
        messages: loaded.map(item => ({ parentId: item.parentId, message: item.message as unknown as TMessage })),
      };
    },
    pin: () => {
      // The remote id and session epoch are captured in this adapter closure;
      // pin is intentionally not allowed to resolve the currently selected item.
    },
    append: item => appendMessage(remoteId, item.message as unknown as UIMessage),
    };
  };

  const makeHistory = (remoteId: string): ThreadHistoryAdapter => {
    const history: ThreadHistoryAdapter = {
      load: async () => {
        const loaded = await loadEvents(remoteId);
        return { messages: loaded.map(item => ({ parentId: item.parentId, message: item.message as unknown as ThreadMessage })) };
      },
      append: item => appendMessage(remoteId, item.message as unknown as UIMessage),
      withFormat: <TMessage, TStorageFormat extends Record<string, unknown>>(
        formatAdapter: MessageFormatAdapter<TMessage, TStorageFormat>,
      ) => {
        let scopedAdapters = genericAdapters.get(remoteId);
        if (!scopedAdapters) {
          scopedAdapters = new WeakMap<object, GenericThreadHistoryAdapter<UIMessage>>();
          genericAdapters.set(remoteId, scopedAdapters);
        }
        const existing = scopedAdapters.get(formatAdapter as object);
        if (existing) return existing as GenericThreadHistoryAdapter<TMessage>;
        const generic = makeGenericHistory(remoteId, formatAdapter);
        scopedAdapters.set(formatAdapter as object, generic as GenericThreadHistoryAdapter<UIMessage>);
        return generic;
      },
    };
    return history;
  };

  const list = async (params?: { after?: string }): Promise<RemoteThreadListResponse> => {
    if (!subjectId) return { threads: [] };
    const capturedEpoch = epoch;
    const cursor = decodeListCursor(params?.after);
    const regularSuffix = cursor.regular ? `&after=${cursor.regular}` : '';
    const archivedSuffix = cursor.archived ? `&after=${cursor.archived}` : '';
    try {
      const [regularRaw, archivedRaw] = await Promise.all([
        cursor.regular === null
          ? Promise.resolve<unknown>({ conversations: [] })
          : requestJson<unknown>(`/conversations?archived=false&limit=50${regularSuffix}`, { method: 'GET', cache: 'no-store' }, capturedEpoch),
        cursor.archived === null
          ? Promise.resolve<unknown>({ conversations: [] })
          : requestJson<unknown>(`/conversations?archived=true&limit=50${archivedSuffix}`, { method: 'GET', cache: 'no-store' }, capturedEpoch),
      ]);
      if (!isCurrent(capturedEpoch)) throw new ConversationEpochError();
      const records: ConversationRecord[] = [];
      for (const raw of [regularRaw, archivedRaw]) {
        if (!plainRecord(raw) || !Array.isArray(raw.conversations)) throw new Error('Conversation list response was invalid.');
        for (const item of raw.conversations) records.push(parseConversation(item));
      }
      const deduped = new Map(records.map(record => [record.id, record]));
      for (const record of deduped.values()) remember(record);
      const regularNext = cursor.regular === null ? undefined : endpointNextCursor(regularRaw, 'regular');
      const archivedNext = cursor.archived === null ? undefined : endpointNextCursor(archivedRaw, 'archived');
      const nextCursor = encodeListCursor({
        regular: regularNext ?? null,
        archived: archivedNext ?? null,
      });
      return { threads: [...deduped.values()].map(toMetadata), ...(nextCursor ? { nextCursor } : {}) };
    } catch (error) {
      if (!isCurrent(capturedEpoch)) throw new ConversationEpochError();
      if (errorStatus(error) === 503) {
        for (const record of metadata.values()) setState(record.id, 'unavailable');
        setOverallStatus('unavailable');
      } else setOverallStatus('unsaved');
      throw error;
    }
  };

  const mutateArchive = async (remoteId: string, archived: boolean) => {
    if (!subjectId) throw new Error('Saved conversations are unavailable for legacy sessions.');
    lowerUuid(remoteId, 'conversation id');
    const capturedEpoch = epoch;
    if (!isCurrent(capturedEpoch)) throw new ConversationEpochError();
    if (stopped.has(remoteId)) throw new Error('Conversation saving stopped after a revision conflict.');
    setState(remoteId, 'saving');
    try {
      const expectedRevision = currentState(remoteId).revision;
      const raw = await requestJson<unknown>(`/conversations/${remoteId}`, {
        method: 'PATCH', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ archived, expectedRevision }),
      }, capturedEpoch);
      if (!isCurrent(capturedEpoch)) throw new ConversationEpochError();
      const record = parseConversation(raw);
      metadata.set(remoteId, record);
      setState(remoteId, 'saved', { revision: record.revision, archived: record.archived });
    } catch (error) {
      if (!isCurrent(capturedEpoch)) throw new ConversationEpochError();
      if (errorStatus(error) === 409) {
        stopped.add(remoteId);
        setState(remoteId, 'conflict');
        await reconcile(remoteId, capturedEpoch);
      } else if (errorStatus(error) === 503) setState(remoteId, 'unavailable');
      else setState(remoteId, 'unsaved');
      throw error;
    }
  };

  const deleteConversation = async (remoteId: string) => {
    if (!subjectId) throw new Error('Saved conversations are unavailable for legacy sessions.');
    lowerUuid(remoteId, 'conversation id');
    const capturedEpoch = epoch;
    if (!isCurrent(capturedEpoch)) throw new ConversationEpochError();
    setState(remoteId, 'saving');
    try {
      const expectedRevision = currentState(remoteId).revision;
      await requestJson<undefined>(`/conversations/${remoteId}`, {
        method: 'DELETE', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision }),
      }, capturedEpoch);
      if (!isCurrent(capturedEpoch)) throw new ConversationEpochError();
      metadata.delete(remoteId);
      state.delete(remoteId);
      stopped.add(remoteId);
      if (selectedRemoteId === remoteId) selectConversation(undefined);
      else if (selectedRemoteId === undefined) setOverallStatus('saved');
      notify();
    } catch (error) {
      if (!isCurrent(capturedEpoch)) throw new ConversationEpochError();
      if (errorStatus(error) === 409) {
        stopped.add(remoteId);
        setState(remoteId, 'conflict');
        await reconcile(remoteId, capturedEpoch);
      } else if (errorStatus(error) === 503) setState(remoteId, 'unavailable');
      else setState(remoteId, 'unsaved');
      throw error;
    }
  };

  const initialize = async (threadId: string) => {
    if (!subjectId) return { remoteId: threadId, externalId: undefined };
    const capturedEpoch = epoch;
    if (!isCurrent(capturedEpoch)) throw new ConversationEpochError();
    const id = localConversationIds.get(threadId) ?? newUuid();
    localConversationIds.set(threadId, id);
    try {
      const raw = await requestJson<unknown>('/conversations', {
        method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id }),
      }, capturedEpoch);
      if (!isCurrent(capturedEpoch)) throw new ConversationEpochError();
      const record = parseConversation(raw);
      if (record.id !== id) throw new Error('Conversation creation returned a different id.');
      remember(record);
      return { remoteId: record.id, externalId: undefined };
    } catch (error) {
      if (!isCurrent(capturedEpoch)) throw new ConversationEpochError();
      if (errorStatus(error) === 503) setState(id, 'unavailable');
      else setState(id, 'unsaved');
      throw error;
    }
  };

  const fetchConversation = async (threadId: string) => {
    if (!subjectId) throw new Error('Saved conversations are unavailable for legacy sessions.');
    const remoteId = localConversationIds.get(threadId) ?? lowerUuid(threadId, 'conversation id');
    const capturedEpoch = epoch;
    const raw = await requestJson<unknown>(`/conversations/${remoteId}`, { method: 'GET', cache: 'no-store' }, capturedEpoch);
    if (!isCurrent(capturedEpoch)) throw new ConversationEpochError();
    const record = parseConversation(raw);
    remember(record);
    return toMetadata(record);
  };

  const unsupported = async (): Promise<void> => {
    throw new Error('Conversation titles and custom metadata are not supported.');
  };

  const adapter: RemoteThreadListAdapter = {
    list,
    rename: unsupported,
    updateCustom: unsupported,
    archive: remoteId => mutateArchive(remoteId, true),
    unarchive: remoteId => mutateArchive(remoteId, false),
    delete: deleteConversation,
    initialize,
    generateTitle: async () => {
      throw new Error('Conversation titles are fixed and cannot be generated.');
    },
    fetch: fetchConversation,
    unstable_useAdapters: () => {
      const aui = useAui();
      const remoteId = aui.threadListItem.source ? aui.threadListItem.getState().remoteId : undefined;
      useEffect(() => {
        selectConversation(remoteId);
      }, [remoteId]);
      const history = remoteId ? historyAdapters.get(remoteId) ?? (() => {
        const made = makeHistory(remoteId);
        historyAdapters.set(remoteId, made);
        return made;
      })() : undefined;
      return useMemo(() => history ? { history } : {}, [history]);
    },
  };

  const controller: ConversationController = {
    adapter,
    toMetadata,
    historyFor(remoteId) {
      if (!subjectId || !uuidPattern.test(remoteId) || remoteId !== remoteId.toLowerCase()) return undefined as unknown as ThreadHistoryAdapter;
      const existing = historyAdapters.get(remoteId);
      if (existing) return existing;
      const made = makeHistory(remoteId);
      historyAdapters.set(remoteId, made);
      return made;
    },
    select: selectConversation,
    getState(remoteId) {
      return remoteId ? currentState(remoteId) : overallState;
    },
    subscribe(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    linkRun(userMessageId, runId) {
      if (!isCurrent(epoch)) return Promise.reject(new ConversationEpochError());
      if (!subjectId) return Promise.reject(new Error('Saved conversations are unavailable for legacy sessions.'));
      try {
        lowerUuid(runId, 'run id');
      } catch (error) {
        return Promise.reject(error);
      }
      const conversationId = messageConversations.get(userMessageId);
      if (!conversationId) {
        pendingRunLinks.set(userMessageId, runId);
        return Promise.resolve();
      }
      return queueRunLink(conversationId, userMessageId, runId);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      epoch += 1;
      epochController.abort();
      metadata.clear();
      state.clear();
      queues.clear();
      attempts.clear();
      stopped.clear();
      historyAdapters.clear();
      genericAdapters.clear();
      messageConversations.clear();
      userMessages.clear();
      pendingRunLinks.clear();
      localConversationIds.clear();
      selectedRemoteId = undefined;
      overallState = { status: subjectId ? 'saved' : 'unsaved', revision: 0 };
      listeners.clear();
    },
  };
  return controller;
}

export type ConversationRuntimeOptions = {
  session: Pick<Session, 'principal' | 'subjectId' | 'token'>;
  request: ConversationRequest;
  chatOptions: UseChatRuntimeOptions<UIMessage>;
  getRunIdForUserMessage?: (userMessageId: string) => string | undefined;
};

export function useConversationRuntime({
  session,
  request,
  chatOptions,
  getRunIdForUserMessage,
}: ConversationRuntimeOptions): {
  runtime: AssistantRuntime;
  controller: ConversationController;
  linkRun: (userMessageId: string, runId: string) => Promise<void>;
} {
  const key = `${session.principal}:${session.subjectId ?? 'legacy'}:${session.token}`;
  const holderRef = useRef<{ key: string; controller: ConversationController } | undefined>(undefined);
  if (!holderRef.current || holderRef.current.key !== key) {
    holderRef.current?.controller.dispose();
    holderRef.current = {
      key,
      controller: createConversationController({ subjectId: session.subjectId, request, getRunIdForUserMessage }),
    };
  }
  const controller = holderRef.current.controller;
  const runtime = useRemoteThreadListRuntime({
    adapter: controller.adapter,
    runtimeHook: () => useChatRuntime(chatOptions),
    allowNesting: true,
  });
  useEffect(() => () => controller.dispose(), [controller]);
  const linkRun = useCallback((userMessageId: string, runId: string) => controller.linkRun(userMessageId, runId), [controller]);
  return { runtime, controller, linkRun };
}

function ConversationThreadItem({ archived }: { archived: boolean }) {
  const aui = useAui();
  const item = useAuiState(s => s.threadListItem);
  const disabled = conversationActionsDisabled(item);
  const title = item.title || CONVERSATION_TITLE;
  const stop = (event: React.MouseEvent) => event.stopPropagation();
  if (archived) {
    return (
      <ThreadListItemPrimitive.Root className="conversation-row conversation-row-archived">
        <span className="conversation-row-title" aria-label={`Archived ${title}`}>{title}</span>
        <button
          type="button"
          className="secondary conversation-action"
          aria-label="Restore conversation"
          onClick={event => { stop(event); aui.threadListItem.unarchive(); }}
        >Restore</button>
        <button
          type="button"
          className="secondary conversation-action"
          aria-label="Delete conversation"
          disabled={disabled}
          title={disabled ? 'Active conversations cannot be deleted.' : undefined}
          onClick={event => { stop(event); aui.threadListItem.delete(); }}
        >Delete</button>
      </ThreadListItemPrimitive.Root>
    );
  }
  return (
    <ThreadListItemPrimitive.Root className="conversation-row">
      <ThreadListItemPrimitive.Trigger aria-label={`Open ${title}`} className="conversation-row-trigger">
        <ThreadListItemPrimitive.Title fallback={CONVERSATION_TITLE} />
      </ThreadListItemPrimitive.Trigger>
      <button
        type="button"
        className="secondary conversation-action"
        aria-label="Archive conversation"
        disabled={disabled}
        title={disabled ? 'Active conversations cannot be archived.' : undefined}
        onClick={event => { stop(event); aui.threadListItem.archive(); }}
      >Archive</button>
      <button
        type="button"
        className="secondary conversation-action"
        aria-label="Delete conversation"
        disabled={disabled}
        title={disabled ? 'Active conversations cannot be deleted.' : undefined}
        onClick={event => { stop(event); aui.threadListItem.delete(); }}
      >Delete</button>
    </ThreadListItemPrimitive.Root>
  );
}

function RegularConversationThreadItem() {
  return <ConversationThreadItem archived={false} />;
}

function ArchivedConversationThreadItem() {
  return <ConversationThreadItem archived />;
}

export function ConversationNavigation() {
  return (
    <nav className="conversation-navigation" aria-label="Saved conversations">
      <ThreadListPrimitive.Root>
        <ThreadListPrimitive.New className="secondary conversation-new">New conversation</ThreadListPrimitive.New>
        <ThreadListPrimitive.Items components={{ ThreadListItem: RegularConversationThreadItem }} />
        <ThreadListPrimitive.Items archived components={{ ThreadListItem: ArchivedConversationThreadItem }} />
        <ThreadListPrimitive.LoadMore className="secondary conversation-load-more">Load more</ThreadListPrimitive.LoadMore>
      </ThreadListPrimitive.Root>
    </nav>
  );
}

export function ConversationStatus({ controller, subject }: { controller: ConversationController; subject: boolean }) {
  const snapshot = useSyncExternalStore(controller.subscribe, () => controller.getState(), () => controller.getState());
  return <p className="conversation-status" role="status" aria-live="polite">{conversationStatusText(snapshot.status, subject)}</p>;
}

export function SavedRunCard({ data }: DataMessagePartProps<SafeRun>) {
  const run = parseSafeRun(data);
  if (!run) return <p className="saved-run-card" role="status">Historical run details are unavailable.</p>;
  return (
    <aside className="saved-run-card" data-saved-run-card role="status">
      <strong>Saved run</strong>
      <span>{run.capability} · {run.version} · {run.state}</span>
      <span>Run {run.runId}</span>
      <small>Historical sensitive values are unavailable.</small>
    </aside>
  );
}
