import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AssistantRuntimeProvider,
  AuiConfig,
  Tools,
  defineToolkit,
  ThreadPrimitive,
  MessagePrimitive,
  MessagePartPrimitive,
  ComposerPrimitive,
  AuiIf,
} from '@assistant-ui/react';
import { AssistantChatTransport, useChatRuntime } from '@assistant-ui/ai-sdk';
import type { UIMessage, UIMessageChunk } from 'ai';
import { ChatRequestError, chatRequest } from './transport';
import { pending, useRuns } from './session';
import { CapabilityRunCard } from './dashboard';

type ChatLifecycle = {
  key: string;
  guardKey?: string;
  intent: 'action' | 'status';
  sawTool: boolean;
  sawStatusTool: boolean;
  sawOtherTool: boolean;
  finished: boolean;
  failed: boolean;
  settled: boolean;
  toolNames: Map<string, string>;
};
type ChatLifecycleCallbacks = {
  complete: (lifecycle: ChatLifecycle) => void;
  uncertain: (key: string) => void;
};
type ChatRunBinding = { runId: string; capability: string; state: string };
const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
class GuardedAssistantChatTransport extends AssistantChatTransport<UIMessage> {
  private readonly initOptions: ConstructorParameters<typeof AssistantChatTransport<UIMessage>>[0];
  constructor(
    options: ConstructorParameters<typeof AssistantChatTransport<UIMessage>>[0],
    private readonly lifecycles: Map<string, ChatLifecycle>,
    private readonly callbacks: ChatLifecycleCallbacks,
  ) {
    super(options);
    this.initOptions = options;
  }

  override __internal_clone(): AssistantChatTransport<UIMessage> {
    return new GuardedAssistantChatTransport(this.initOptions, this.lifecycles, this.callbacks);
  }

  override async sendMessages(options: Parameters<AssistantChatTransport<UIMessage>['sendMessages']>[0]) {
    const key = [...options.messages].reverse().find(message => message.role === 'user')?.id;
    try {
      const stream = await super.sendMessages(options);
      const lifecycle = key ? this.lifecycles.get(key) : undefined;
      if (!lifecycle) return stream;
      const reader = stream.getReader();
      const callbacks = this.callbacks;
      const lifecycles = this.lifecycles;
      const settle = () => {
        if (lifecycle.settled) return;
        lifecycle.settled = true;
        lifecycles.delete(lifecycle.key);
        if (lifecycle.intent !== 'action') return;
        if (lifecycle.finished && !lifecycle.failed) callbacks.complete(lifecycle);
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
            if (chunk.type === 'tool-input-start' || chunk.type === 'tool-input-available') {
              lifecycle.sawTool = true;
              lifecycle.toolNames.set(chunk.toolCallId, chunk.toolName);
              if (chunk.toolName === 'run_status') lifecycle.sawStatusTool = true;
              else lifecycle.sawOtherTool = true;
            } else if (chunk.type === 'tool-output-available') {
              lifecycle.sawTool = true;
              if (lifecycle.toolNames.get(chunk.toolCallId) === 'run_status') lifecycle.sawStatusTool = true;
              else lifecycle.sawOtherTool = true;
            } else if (chunk.type === 'tool-input-error' || chunk.type === 'tool-output-error'
              || chunk.type === 'tool-output-denied' || chunk.type === 'error' || chunk.type === 'abort') {
              lifecycle.sawTool = true;
              lifecycle.failed = true;
            } else if (chunk.type === 'finish') {
              lifecycle.finished = true;
              settle();
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
    } catch (error) {
      const lifecycle = key ? this.lifecycles.get(key) : undefined;
      if (lifecycle?.intent === 'action') this.callbacks.uncertain(lifecycle.key);
      else if (lifecycle) this.lifecycles.delete(lifecycle.key);
      throw error;
    }
  }
}

function RunTool({ result, status }: { result?: unknown; status?: { type: string } }) {
  const { watch } = useRuns();
  const output = result && typeof result === 'object' ? (result as Record<string, unknown>) : undefined;
  const runId = output?.kind === 'run' && typeof output.runId === 'string' ? output.runId : undefined;
  useEffect(() => {
    if (runId) watch(runId);
  }, [runId, watch]);
  if (runId) return <>
    {output?.reused === true && <p role="status">Using a previously accepted run. No new operation was started.</p>}
    <CapabilityRunCard runId={runId} />
  </>;
  if (output?.kind === 'error')
    return (
      <p role="alert">{typeof output.error === 'string' ? output.error : 'Capability request failed.'}</p>
    );
  if (status?.type === 'incomplete')
    return (
      <p role="alert">
        Response stopped before run acceptance was confirmed. Refresh run history before submitting again.
      </p>
    );
  return <p role="status">Waiting for the server to accept the request…</p>;
}
function Message() {
  return (
    <MessagePrimitive.Root className="message">
      <MessagePrimitive.If user>
        <p className="sr-only message-user-label">YOU</p>
      </MessagePrimitive.If>
      <MessagePrimitive.If assistant>
        <p className="message-author">MERIDIAN</p>
      </MessagePrimitive.If>
      <div className="message-body"><MessagePrimitive.Parts
        components={{
          Text: () => (
            <p className="message-text">
              <MessagePartPrimitive.Text />
            </p>
          ),
          Image: () => null,
          File: () => null,
          Source: () => null,
          Reasoning: () => null,
          tools: { Fallback: RunTool },
        }}
      /></div>
    </MessagePrimitive.Root>
  );
}
export function Chat() {
  const {
    session,
    runs,
    refresh,
    request,
    actionHold,
    beginAction,
    markActionUncertain,
    bindAction,
    clearAction,
    abandonAction,
    watch,
  } = useRuns();
  const [error, setError] = useState('');
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupRunId, setLookupRunId] = useState('');
  const actionHoldRef = useRef(actionHold);
  const lifecycleRef = useRef(new Map<string, ChatLifecycle>());
  actionHoldRef.current = actionHold;
  const lookupRun = useCallback(async (key: string): Promise<ChatRunBinding> => {
    const response = await request('/api/chat/request', {
      cache: 'no-store',
      headers: { 'Idempotency-Key': key },
    });
    const result = await response.json() as { kind?: unknown; runId?: unknown; capability?: unknown; state?: unknown };
    if (result.kind !== 'run'
      || typeof result.runId !== 'string' || !runIdPattern.test(result.runId)
      || typeof result.capability !== 'string' || !result.capability.length
      || typeof result.state !== 'string' || !result.state.length) {
      throw new Error('Lookup returned an invalid run binding.');
    }
    return { runId: result.runId, capability: result.capability, state: result.state };
  }, [request]);
  const boundRun = actionHold?.kind === 'chat' && actionHold.state === 'bound' && actionHold.runId
    ? runs.find(candidate => candidate.runId === actionHold.runId)
    : undefined;
  useEffect(() => {
    if (actionHold?.kind !== 'chat' || actionHold.state !== 'bound' || !actionHold.runId) return;
    const run = runs.find((candidate) => candidate.runId === actionHold.runId);
    const availability = run && session.availability;
    const availabilityReady = availability !== undefined
      && availability.some(item => item.id === run?.capability && item.state === 'available');
    if (run && !pending(run) && availabilityReady) clearAction(actionHold.key);
  }, [actionHold, runs, session.availability, clearAction]);
  const transport = useMemo(
    () =>
      new GuardedAssistantChatTransport({
        api: '/api/chat',
        prepareSendMessagesRequest: ({ messages, id }) => {
          const hold = actionHoldRef.current;
          const prepared = chatRequest(messages, id, hold ? 'status' : 'auto');
          const key = String(prepared.headers['Idempotency-Key']);
          if (hold) {
            lifecycleRef.current.set(key, { key, guardKey: hold.key, intent: 'status', sawTool: false, sawStatusTool: false, sawOtherTool: false, finished: false, failed: false, settled: false, toolNames: new Map() });
          } else if (!beginAction({ kind: 'chat', key, body: JSON.stringify(prepared.body) })) {
            throw new ChatRequestError('An operation request is still unresolved. Ask about its status before sending another action. No request was sent.');
          } else {
            lifecycleRef.current.set(key, { key, intent: 'action', sawTool: false, sawStatusTool: false, sawOtherTool: false, finished: false, failed: false, settled: false, toolNames: new Map() });
          }
          setError('');
          return prepared;
        },
        fetch: (input, init) => request(String(input), init),
      }, lifecycleRef.current, {
        complete: current => {
          lifecycleRef.current.delete(current.key);
          if (current.intent !== 'action') {
            return;
          } else if (current.failed) {
            markActionUncertain(current.key);
          } else if (current.sawTool) {
            void lookupRun(current.key).then(binding => {
              if (actionHoldRef.current?.key !== current.key) return;
              setLookupRunId(binding.runId);
              bindAction(current.key, binding.runId);
              watch(binding.runId);
            }).catch(() => markActionUncertain(current.key));
          } else {
            clearAction(current.key);
          }
        },
        uncertain: key => {
          lifecycleRef.current.delete(key);
          markActionUncertain(key);
        },
      }),
    [request, beginAction, markActionUncertain, bindAction, clearAction, watch, lookupRun],
  );
  const runtime = useChatRuntime({
    transport,
    generateId: () => crypto.randomUUID(),
    onError: (error) => {
      setError(
        error instanceof ChatRequestError
          ? error.message
          : 'Response interrupted. A run may already have started. Refresh run history before making another request.',
      );
      void refresh();
    },
    onFinish: () => { void refresh(); },
  });
  const toolkit = useMemo(
    () =>
      defineToolkit(
        Object.fromEntries(
          [...session.capabilities.map((c) => c.id), 'run_status'].map((id) => [
            id,
            { type: 'backend' as const, render: RunTool },
          ]),
        ),
      ),
    [session.capabilities],
  );
  const config = AuiConfig({ tools: Tools({ toolkit }) });
  async function lookupOriginal() {
    const hold = actionHoldRef.current;
    if (!hold || hold.kind !== 'chat' || hold.state !== 'uncertain' || lookupBusy) return;
    setLookupBusy(true);
    setError('');
    try {
      const binding = await lookupRun(hold.key);
      if (actionHoldRef.current?.key !== hold.key) return;
      setLookupRunId(binding.runId);
      bindAction(hold.key, binding.runId);
      watch(binding.runId);
    } catch (e) {
      setError(`${e instanceof Error ? e.message : 'Lookup interrupted.'} Acceptance remains unconfirmed. Refresh history before taking further action.`);
    } finally {
      setLookupBusy(false);
    }
  }
  function abandonChat() {
    const hold = actionHoldRef.current;
    if (!hold || hold.kind !== 'chat' || hold.state !== 'uncertain' || lookupBusy) return;
    abandonAction(hold.key);
    setError('The original request may still run or may have completed; this local action does not cancel it. Start a new request only after reviewing its status.');
  }
  function abandonUnknownChat() {
    const hold = actionHoldRef.current;
    if (!hold || hold.kind !== 'chat' || hold.state !== 'bound' || !hold.runId || boundRun?.state !== 'POST_OUTCOME_UNKNOWN') return;
    abandonAction(hold.key);
    setError('The original request remains quarantined with an unknown posting outcome. This local action did not retry or cancel it; use a separate read-only inquiry.');
  }
  return (
    <section aria-labelledby="chat-heading" className="chat">
      <h2 id="chat-heading" className="sr-only">Assistant</h2>
      <AssistantRuntimeProvider runtime={runtime} config={config}>
        <ThreadPrimitive.Root className="thread-root">
          <ThreadPrimitive.Viewport id="messages" className="messages">
            <div className="conversation">
              <ThreadPrimitive.Empty>
                <div className="chat-welcome">
                  <span className="welcome-mark" aria-hidden="true">M</span>
                  <h3>How can I help you today?</h3>
                  <p>Ask a question, find a member, or check on an operation.</p>
                </div>
              </ThreadPrimitive.Empty>
              <ThreadPrimitive.Messages components={{ Message }} />
              <AuiIf condition={s => s.thread.isRunning}><p className="thinking" role="status">Working…</p></AuiIf>
            </div>
            <ThreadPrimitive.ViewportFooter className="composer-footer">
              <ThreadPrimitive.ScrollToBottom className="scroll-bottom secondary" aria-label="Scroll to bottom">↓</ThreadPrimitive.ScrollToBottom>
              {actionHold?.kind === 'direct' && <p role="status">A direct request is unresolved. Chat messages are status-only until it is looked up or locally abandoned.</p>}
              {actionHold?.kind === 'chat' && actionHold.state === 'uncertain' && <p role="alert">
                Acceptance is unconfirmed. The original request may still run or may have completed. Looking it up does not cancel it.
                <button type="button" disabled={lookupBusy} onClick={() => void lookupOriginal()}>Look up original request</button>
                <button type="button" disabled={lookupBusy} onClick={abandonChat}>Start a separate request</button>
              </p>}
              {boundRun?.state === 'POST_OUTCOME_UNKNOWN' && <p role="alert">
                The original request has an unknown posting outcome and remains quarantined. This local action only releases this session for a separate read-only inquiry; it does not retry or cancel the original request.
                <AuiIf condition={s => !s.thread.isRunning}>
                  <button type="button" disabled={lookupBusy} onClick={abandonUnknownChat}>Start a separate inquiry</button>
                </AuiIf>
              </p>}
              {lookupRunId && <div className="chat-recovery"><p role="status">The original request was bound to run {lookupRunId}. Follow its authoritative state below.</p><CapabilityRunCard runId={lookupRunId} /></div>}
              {error && <p role="alert">{error}</p>}
              <ComposerPrimitive.Root className="composer">
                <label htmlFor="message" className="sr-only">Your request</label>
                <ComposerPrimitive.Input
                  id="message"
                  placeholder="Message the assistant…"
                  maxLength={4000}
                />
                <div className="actions">
                  <AuiIf condition={(s) => !s.thread.isRunning}>
                    <ComposerPrimitive.Send aria-label="Send" className="send-button"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg></ComposerPrimitive.Send>
                  </AuiIf>
                  <AuiIf condition={(s) => s.thread.isRunning}>
                    <ComposerPrimitive.Cancel aria-label="Stop response" className="send-button stop-button"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1" /></svg><span>Stop response</span></ComposerPrimitive.Cancel>
                  </AuiIf>
                </div>
              </ComposerPrimitive.Root>
              <p className="composer-note">Transactions require operator approval.</p>
              <p className="composer-note">Stopping the response does not cancel a run or undo a transaction.</p>
            </ThreadPrimitive.ViewportFooter>
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </section>
  );
}
