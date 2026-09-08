import type { UIMessage, UIMessageChunk } from 'ai';

export function confirmsInvocationRejection(value: unknown, status?: number): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  const code = status ?? body.status;
  return body.acceptance === 'rejected' && typeof body.error === 'string'
    && !('runId' in body) && typeof code === 'number' && [400, 403, 404, 409, 429].includes(code);
}

export class ApiRequestError extends Error {
  readonly invocationRejected: boolean;
  constructor(readonly status: number, body: unknown) {
    const data = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    super(typeof data.error === 'string' ? data.error : `Request failed (${status})`);
    this.invocationRejected = confirmsInvocationRejection(body, status);
  }
}

export type ChatLifecycle = {
  key: string;
  conversationId?: string;
  guardKey?: string;
  intent: 'action' | 'status';
  sawTool: boolean;
  sawStatusTool: boolean;
  sawOtherTool: boolean;
  finishReason?: string;
  finishSeen: boolean;
  postFinishFailure: boolean;
  failed: boolean;
  settled: boolean;
  toolNames: Map<string, string>;
  actionOutputs?: Map<string, boolean>;
  rejectionProtocolInvalid?: boolean;
};
export function allActionToolsRejected(lifecycle: ChatLifecycle): boolean {
  if (!lifecycle.finishSeen || lifecycle.failed || lifecycle.postFinishFailure || lifecycle.rejectionProtocolInvalid
    || !['stop', 'tool-calls'].includes(lifecycle.finishReason ?? '')) return false;
  const calls = [...lifecycle.toolNames].filter(([, name]) => name !== 'run_status');
  return calls.length > 0 && calls.length === lifecycle.actionOutputs?.size
    && calls.every(([id]) => lifecycle.actionOutputs?.get(id) === true);
}
export type ChatLifecycleCallbacks = {
  complete: (lifecycle: ChatLifecycle) => void;
  uncertain: (key: string) => void;
};

function parsedFinishReason(chunk: Extract<UIMessageChunk, { type: 'finish' }>): string | undefined {
  const raw: unknown = chunk.finishReason;
  if (typeof raw === 'string') return raw;
  if (raw !== null && typeof raw === 'object' && 'unified' in raw && typeof raw.unified === 'string') return raw.unified;
  return undefined;
}

export function observeGuardedChatStream(
  stream: ReadableStream<UIMessageChunk>,
  lifecycle: ChatLifecycle,
  lifecycles: Map<string, ChatLifecycle>,
  callbacks: ChatLifecycleCallbacks,
): ReadableStream<UIMessageChunk> {
  const reader = stream.getReader();
  const toolPhases = new Map<string, { name: string; phase: 'started' | 'available' | 'output' }>();
  const settle = () => {
    if (lifecycle.settled) return;
    lifecycle.settled = true;
    lifecycles.delete(lifecycle.key);
    if (lifecycle.intent !== 'action') return;
    if (lifecycle.finishSeen && !lifecycle.failed && !lifecycle.postFinishFailure) callbacks.complete(lifecycle);
    else callbacks.uncertain(lifecycle.key);
  };
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      try {
        const next = await reader.read();
        if (next.done) {
          settle();
          controller.close();
          return;
        }
        const chunk = next.value;
        if (lifecycle.finishSeen) lifecycle.postFinishFailure = true;
        if (chunk.type === 'tool-input-start' || chunk.type === 'tool-input-available') {
          const previous = toolPhases.get(chunk.toolCallId);
          if (previous && (chunk.type === 'tool-input-start' || previous.phase !== 'started' || previous.name !== chunk.toolName)) {
            lifecycle.rejectionProtocolInvalid = true;
          }
          toolPhases.set(chunk.toolCallId, { name: chunk.toolName, phase: chunk.type === 'tool-input-start' ? 'started' : 'available' });
          lifecycle.sawTool = true;
          lifecycle.toolNames.set(chunk.toolCallId, chunk.toolName);
          if (chunk.toolName === 'run_status') lifecycle.sawStatusTool = true;
          else lifecycle.sawOtherTool = true;
        } else if (chunk.type === 'tool-input-delta') {
          if (toolPhases.get(chunk.toolCallId)?.phase !== 'started') lifecycle.rejectionProtocolInvalid = true;
        } else if (chunk.type === 'tool-output-available') {
          const previous = toolPhases.get(chunk.toolCallId);
          if (previous?.phase !== 'available') lifecycle.rejectionProtocolInvalid = true;
          if (previous) toolPhases.set(chunk.toolCallId, { ...previous, phase: 'output' });
          lifecycle.sawTool = true;
          if (lifecycle.toolNames.get(chunk.toolCallId) === 'run_status') lifecycle.sawStatusTool = true;
          else {
            lifecycle.sawOtherTool = true;
            lifecycle.actionOutputs ??= new Map();
            const output = chunk.output as { kind?: unknown } | null;
            lifecycle.actionOutputs.set(chunk.toolCallId, !lifecycle.actionOutputs.has(chunk.toolCallId)
              && output?.kind === 'error' && confirmsInvocationRejection(output));
          }
        } else if (chunk.type === 'tool-input-error' || chunk.type === 'tool-output-error'
          || chunk.type === 'tool-output-denied' || chunk.type === 'error' || chunk.type === 'abort') {
          lifecycle.sawTool = true;
          lifecycle.failed = true;
        } else if (chunk.type === 'finish') {
          if (lifecycle.finishSeen) lifecycle.failed = true;
          else {
            lifecycle.finishSeen = true;
            lifecycle.finishReason = parsedFinishReason(chunk);
          }
        }
        controller.enqueue(chunk);
      } catch (error) {
        if (lifecycle.intent === 'action' && !lifecycle.settled) {
          lifecycle.settled = true;
          lifecycles.delete(lifecycle.key);
          callbacks.uncertain(lifecycle.key);
        } else if (!lifecycle.settled) {
          lifecycle.settled = true;
          lifecycles.delete(lifecycle.key);
        }
        controller.error(error);
      }
    },
    cancel(reason) {
      if (lifecycle.intent === 'action' && !lifecycle.settled) {
        lifecycle.settled = true;
        lifecycles.delete(lifecycle.key);
        callbacks.uncertain(lifecycle.key);
      } else if (!lifecycle.settled) {
        lifecycle.settled = true;
        lifecycles.delete(lifecycle.key);
      }
      return reader.cancel(reason);
    },
  });
}

export class ChatRequestError extends Error {}

function isSavedConversationMessage(message: UIMessage): boolean {
  const metadata = message.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return false;
  const custom = (metadata as Record<string, unknown>).custom;
  return custom !== null && typeof custom === 'object' && !Array.isArray(custom)
    && (custom as Record<string, unknown>).meridianSaved === true;
}

// Keep user IDs: the server reconstructs prior run context from caller-scoped journal keys.
// Client tool payloads are display-only. The latest stable ID is also its request key.
export function chatRequest(messages: UIMessage[], id: string, intent: 'invoke' | 'status' | 'auto' = 'invoke') {
  const modelMessages = messages.filter(message => !isSavedConversationMessage(message));
  const latestUser = [...modelMessages].reverse().find((message) => message.role === 'user');
  const text = (message: UIMessage) =>
    message.parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
  if (!latestUser || !text(latestUser).length)
    throw new ChatRequestError('Enter a text request. No request was sent.');
  if (latestUser.parts.some((part) => part.type !== 'text') || text(latestUser).length > 4000)
    throw new ChatRequestError(
      'Your request must contain only text and at most 4000 characters. Review your operation facts before shortening it. No request was sent.',
    );
  if (id.length > 200 || !/^[\x21-\x7e]{1,200}$/.test(latestUser.id))
    throw new ChatRequestError(
      'Invalid conversation or request identity. Reconnect before sending. No request was sent.',
    );

  let current:
    | { id: string; role: 'user' | 'assistant'; parts: { type: 'text'; text: string }[] }
    | undefined;
  const history = modelMessages.flatMap((message) => {
    if (message.role !== 'user' && message.role !== 'assistant') return [];
    if (!message.id.length || message.id.length > 200) return [];
    let content = text(message);
    if (message.role === 'assistant') content = content.slice(0, 4000).replace(/[\uD800-\uDBFF]$/, '');
    if (!content.length || content.length > 4000) return [];
    const entry = { id: message.id, role: message.role, parts: [{ type: 'text' as const, text: content }] };
    if (message === latestUser) current = entry;
    return [entry];
  });
  const body = { id, intent, messages: history, trigger: 'submit-message' as const };
  const bytes = () => new TextEncoder().encode(JSON.stringify(body)).byteLength;
  while (history.length > 20 || bytes() > 32 * 1024) {
    const oldest = history.findIndex((message) => message !== current);
    if (oldest < 0)
      throw new ChatRequestError(
        'Your request exceeds the transport limit. Review your operation facts before shortening it. No request was sent.',
      );
    history.splice(oldest, 1);
  }
  return { headers: { 'Idempotency-Key': latestUser.id }, body };
}
