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
import { AssistantChatTransport } from '@assistant-ui/ai-sdk';
import type { UIMessage } from 'ai';
import {
  ChatRequestError,
  allActionToolsRejected,
  chatRequest,
  observeGuardedChatStream,
  type ChatLifecycle,
  type ChatLifecycleCallbacks,
} from './transport';
import { completedActionReady, pending, useRuns } from './session';
import { CapabilityRunCard, GuidedOperations } from './dashboard';
import {
  ConversationNavigation,
  ConversationStatus,
  SavedRunCard,
  trackConversationWriteFailure,
  useConversationRuntime,
} from './conversations';

type ChatRunBinding = { runId: string; capability: string; state: string };
type AssistantTransportOptions = NonNullable<ConstructorParameters<typeof AssistantChatTransport<UIMessage>>[0]>;
type AssistantPrepare = NonNullable<AssistantTransportOptions['prepareSendMessagesRequest']>;
type GuardedTransportOptions = Omit<AssistantTransportOptions, 'prepareSendMessagesRequest'> & {
  prepareSendMessagesRequest?: (
    options: Parameters<AssistantPrepare>[0],
    localThreadId: string,
  ) => ReturnType<AssistantPrepare>;
};
const runIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const capabilityIdPattern = /^[a-z0-9][a-z0-9-]*$/;
const bindingKeys = ['kind', 'runId', 'capability', 'state'] as const;
const supportedRunStates = new Set([
  'accepted', 'reserved', 'running', 'dispatching', 'recovering', 'awaiting-human',
  'success', 'business_outcome', 'failure', 'interrupted', 'POST_OUTCOME_UNKNOWN',
]);
function parseChatRunBinding(value: unknown): ChatRunBinding {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new Error('Lookup returned an invalid run binding.');
  const result = value as Record<string, unknown>;
  const keys = Object.keys(result);
  if (keys.length !== bindingKeys.length || bindingKeys.some(key => !Object.prototype.hasOwnProperty.call(result, key)))
    throw new Error('Lookup returned an invalid run binding.');
  if (result.kind !== 'run'
    || typeof result.runId !== 'string' || !runIdPattern.test(result.runId)
    || typeof result.capability !== 'string' || !capabilityIdPattern.test(result.capability)
    || typeof result.state !== 'string' || !supportedRunStates.has(result.state)) {
    throw new Error('Lookup returned an invalid run binding.');
  }
  return { runId: result.runId, capability: result.capability, state: result.state };
}

export class GuardedAssistantChatTransport extends AssistantChatTransport<UIMessage> {
  private readonly initOptions: GuardedTransportOptions;
  private readonly localThreadIds: WeakMap<object, string>;
  constructor(
    options: GuardedTransportOptions,
    private readonly lifecycles: Map<string, ChatLifecycle>,
    private readonly callbacks: ChatLifecycleCallbacks,
  ) {
    const localThreadIds = new WeakMap<object, string>();
    const { prepareSendMessagesRequest: prepare, ...normalizedOptions } = options;
    super({
      ...normalizedOptions,
      ...(prepare ? {
        prepareSendMessagesRequest: requestOptions => prepare({
          ...requestOptions,
        }, localThreadIds.get(requestOptions.messages as object) ?? requestOptions.id),
      } : {}),
    });
    this.initOptions = options;
    this.localThreadIds = localThreadIds;
  }

  override __internal_clone(): AssistantChatTransport<UIMessage> {
    return new GuardedAssistantChatTransport(this.initOptions, this.lifecycles, this.callbacks);
  }

  override async sendMessages(options: Parameters<AssistantChatTransport<UIMessage>['sendMessages']>[0]) {
    const key = [...options.messages].reverse().find(message => message.role === 'user')?.id;
    try {
      this.localThreadIds.set(options.messages as object, options.chatId);
      const stream = await super.sendMessages(options);
      const lifecycle = key ? this.lifecycles.get(key) : undefined;
      if (!lifecycle) return stream;
      return observeGuardedChatStream(stream, lifecycle, this.lifecycles, this.callbacks);
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
    <CapabilityRunCard runId={runId} inlineApproval />
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
          data: { by_name: { 'saved-run': SavedRunCard } },
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
  const runLinksRef = useRef(new Map<string, string>());
  const conversationByRequestRef = useRef(new Map<string, string>());
  const chatThreadIdsRef = useRef(new Map<string, string>());
  const runLinksSessionKeyRef = useRef('');
  const linkRunRef = useRef<(userMessageId: string, runId: string, remoteId?: string) => Promise<void>>(() => Promise.resolve());
  const runLinksSessionKey = `${session.principal}:${session.subjectId ?? 'legacy'}:${session.token}`;
  if (runLinksSessionKeyRef.current !== runLinksSessionKey) {
    runLinksRef.current.clear();
    conversationByRequestRef.current.clear();
    chatThreadIdsRef.current.clear();
    runLinksSessionKeyRef.current = runLinksSessionKey;
  }
  actionHoldRef.current = actionHold;
  const lookupRun = useCallback(async (key: string): Promise<ChatRunBinding> => {
    const response = await request('/api/chat/request', {
      cache: 'no-store',
      headers: { 'Idempotency-Key': key },
    });
    return parseChatRunBinding(await response.json());
  }, [request]);
  const boundRun = actionHold?.kind === 'chat' && actionHold.state === 'bound' && actionHold.runId
    ? runs.find(candidate => candidate.runId === actionHold.runId)
    : undefined;
  useEffect(() => {
    if (actionHold?.kind !== 'chat' || actionHold.state !== 'bound' || !actionHold.runId) return;
    const run = runs.find((candidate) => candidate.runId === actionHold.runId);
    if (!run || !actionHold.boundCapabilityId || run.capability !== actionHold.boundCapabilityId) return;
    if (completedActionReady(session, run)) clearAction(actionHold.key);
  }, [actionHold, runs, session, clearAction]);
  const transport = useMemo(
    () =>
      new GuardedAssistantChatTransport({
        api: '/api/chat',
        prepareSendMessagesRequest: ({ messages, id }, localThreadId) => {
          const hold = actionHoldRef.current;
          const conversationId = runIdPattern.test(id) ? id.toLowerCase() : undefined;
          let chatId = localThreadId;
          if (runIdPattern.test(localThreadId)) {
            chatId = chatThreadIdsRef.current.get(localThreadId) ?? `__CHATID_${crypto.randomUUID()}`;
            chatThreadIdsRef.current.set(localThreadId, chatId);
          }
          const prepared = chatRequest(messages, chatId, hold ? 'status' : 'auto');
          const key = String(prepared.headers['Idempotency-Key']);
          if (conversationId) conversationByRequestRef.current.set(key, conversationId);
          if (hold) {
            lifecycleRef.current.set(key, { key, conversationId, guardKey: hold.key, intent: 'status', sawTool: false, sawStatusTool: false, sawOtherTool: false, finishSeen: false, postFinishFailure: false, failed: false, settled: false, toolNames: new Map() });
          } else if (!beginAction({ kind: 'chat', key, body: JSON.stringify(prepared.body) })) {
            throw new ChatRequestError('An operation request is still unresolved. Ask about its status before sending another action. No request was sent.');
          } else {
            lifecycleRef.current.set(key, { key, conversationId, intent: 'action', sawTool: false, sawStatusTool: false, sawOtherTool: false, finishSeen: false, postFinishFailure: false, failed: false, settled: false, toolNames: new Map() });
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
          } else if (current.failed
            || !current.finishSeen
            || (current.finishReason !== 'stop' && current.finishReason !== 'tool-calls')) {
            markActionUncertain(current.key);
          } else if (allActionToolsRejected(current)) {
            clearAction(current.key);
          } else if (current.finishReason === 'tool-calls' && current.sawOtherTool) {
            void lookupRun(current.key).then(binding => {
              if (actionHoldRef.current?.key !== current.key) return;
              setLookupRunId(binding.runId);
              if (current.conversationId) {
                runLinksRef.current.set(`${current.conversationId}:${current.key}`, binding.runId);
                trackConversationWriteFailure(linkRunRef.current(current.key, binding.runId, current.conversationId), () => { void refresh(); });
              }
              bindAction(current.key, binding.runId, binding.capability);
              watch(binding.runId);
            }).catch(() => markActionUncertain(current.key));
          } else if (current.finishReason === 'stop' && !current.sawTool) {
            clearAction(current.key);
          } else if (current.finishReason === 'tool-calls' && current.sawStatusTool && !current.sawOtherTool) {
            clearAction(current.key);
          } else {
            markActionUncertain(current.key);
          }
        },
        uncertain: key => {
          lifecycleRef.current.delete(key);
          markActionUncertain(key);
        },
      }),
    [request, beginAction, markActionUncertain, bindAction, clearAction, watch, lookupRun, refresh],
  );
  const { runtime, controller, linkRun } = useConversationRuntime({
    session,
    request,
    getRunIdForUserMessage: (userMessageId, remoteId) => runLinksRef.current.get(`${remoteId}:${userMessageId}`),
    chatOptions: {
      transport,
      generateId: () => crypto.randomUUID(),
      adapters: undefined,
      onError: (error) => {
        setError(
          error instanceof ChatRequestError
            ? error.message
            : 'Response interrupted. A run may already have started. Refresh run history before making another request.',
        );
        void refresh();
      },
      onFinish: () => { void refresh(); },
    },
  });
  linkRunRef.current = linkRun;
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
      const conversationId = conversationByRequestRef.current.get(hold.key);
      if (conversationId) {
        runLinksRef.current.set(`${conversationId}:${hold.key}`, binding.runId);
        void linkRun(hold.key, binding.runId, conversationId).catch(() => {});
      }
      bindAction(hold.key, binding.runId, binding.capability);
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
        {session.subjectId ? <ConversationNavigation controller={controller} /> : null}
        <ConversationStatus controller={controller} subject={Boolean(session.subjectId)} />
        <ThreadPrimitive.Root className="thread-root">
          <ThreadPrimitive.Viewport id="messages" className="messages">
            <div className="conversation">
              {session.readinessRequired !== false && <GuidedOperations />}
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
              {actionHold?.kind === 'chat' && <p role="status">Chat messages are status-only while this action request is being confirmed and until its run is ready.</p>}
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
              {lookupRunId && <div className="chat-recovery"><p role="status">The original request was bound to run {lookupRunId}. Follow its authoritative state below.</p><CapabilityRunCard runId={lookupRunId} inlineApproval /></div>}
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
