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
  if (runId) return <CapabilityRunCard runId={runId} />;
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
        <p className="eyebrow">YOU</p>
      </MessagePrimitive.If>
      <MessagePrimitive.If assistant>
        <p className="eyebrow">ASSISTANT</p>
      </MessagePrimitive.If>
      <MessagePrimitive.Parts
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
      />
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
        prepareSendMessagesRequest: ({ messages, id }) => chatRequest(messages, id),
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
    onFinish: () => {
      void refresh();
    },
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
    <section aria-labelledby="chat-heading">
      <h2 id="chat-heading">Assistant</h2>
      <p>Chat uses caller permissions. Transaction approval belongs to the operator.</p>
      <AssistantRuntimeProvider runtime={runtime} config={config}>
        <ThreadPrimitive.Root>
          <ThreadPrimitive.Viewport id="messages" className="messages">
            <ThreadPrimitive.Empty>
              <p className="empty">Describe the inquiry or operation and supply its exact inputs.</p>
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages components={{ Message }} />
          </ThreadPrimitive.Viewport>
          {error && <p role="alert">{error}</p>}
          <ComposerPrimitive.Root onSubmit={() => setError('')}>
            <label htmlFor="message">Your request</label>
            <ComposerPrimitive.Input
              id="message"
              placeholder="Ask for an available capability…"
              maxLength={4000}
            />
            <div className="actions">
              <AuiIf condition={(s) => !s.thread.isRunning}>
                <ComposerPrimitive.Send>Send</ComposerPrimitive.Send>
              </AuiIf>
              <AuiIf condition={(s) => s.thread.isRunning}>
                <ComposerPrimitive.Cancel>Stop response</ComposerPrimitive.Cancel>
              </AuiIf>
            </div>
          </ComposerPrimitive.Root>
          <p className="muted">Stopping the response does not cancel a run or undo a transaction.</p>
        </ThreadPrimitive.Root>
      </AssistantRuntimeProvider>
    </section>
  );
}
