import { useEffect, useMemo, useState } from 'react';
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
import { ChatRequestError, chatRequest } from './transport';
import { useRuns } from './session';
import { CapabilityRunCard } from './dashboard';

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
  const { session, refresh, request } = useRuns();
  const [error, setError] = useState('');
  const transport = useMemo(
    () =>
      new AssistantChatTransport({
        api: '/api/chat',
        prepareSendMessagesRequest: ({ messages, id }) => {
          const prepared = chatRequest(messages, id, 'auto');
          setError('');
          return prepared;
        },
        fetch: (input, init) => request(String(input), init),
      }),
    [request],
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
                    <ComposerPrimitive.Cancel aria-label="Stop response" className="send-button"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1" /></svg></ComposerPrimitive.Cancel>
                  </AuiIf>
                </div>
              </ComposerPrimitive.Root>
              <p className="composer-note">Transactions require operator approval.</p>
              <p className="sr-only">Stopping the response does not cancel a run or undo a transaction.</p>
            </ThreadPrimitive.ViewportFooter>
          </ThreadPrimitive.Viewport>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </section>
  );
}
