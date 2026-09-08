import { expect, it } from 'vitest';
import type { UIMessageChunk } from 'ai';
import { ApiRequestError, allActionToolsRejected, observeGuardedChatStream, type ChatLifecycle } from '../src/server/ui/transport.js';

const rejected = { kind: 'error', status: 400, error: 'Invalid arguments', acceptance: 'rejected' };
const input = (id: string): UIMessageChunk => ({ type: 'tool-input-available', toolCallId: id, toolName: 'read-member', input: {} });
const start = (id: string): UIMessageChunk => ({ type: 'tool-input-start', toolCallId: id, toolName: 'read-member' });
const output = (id: string, value: unknown = rejected): UIMessageChunk => ({ type: 'tool-output-available', toolCallId: id, output: value });
const finish: UIMessageChunk = { type: 'finish', finishReason: 'tool-calls' };

async function releases(chunks: UIMessageChunk[]) {
  const lifecycle: ChatLifecycle = { key: 'current', intent: 'action', sawTool: false, sawStatusTool: false,
    sawOtherTool: false, finishSeen: false, postFinishFailure: false, failed: false, settled: false, toolNames: new Map() };
  let released = false;
  const observed = observeGuardedChatStream(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  } }), lifecycle, new Map([[lifecycle.key, lifecycle]]), {
    complete: current => { released = allActionToolsRejected(current); },
    uncertain: () => { released = false; },
  });
  const reader = observed.getReader();
  while (!(await reader.read()).done) { /* Consume through clean EOF, not merely the finish chunk. */ }
  return released;
}

it('releases only after every action output confirms rejection and the stream reaches clean EOF', async () => {
  expect(await releases([input('a'), output('a'), finish])).toBe(true);
  expect(await releases([start('a'), { type: 'tool-input-delta', toolCallId: 'a', inputTextDelta: '{}' }, input('a'), output('a'), finish])).toBe(true);
  expect(await releases([input('a'), output('a'), input('b'), output('b'), finish])).toBe(true);
});

it.each([
  ['missing output', [input('a'), finish]],
  ['mixed accepted run', [input('a'), output('a'), input('b'), output('b', { kind: 'run', runId: 'accepted-run' }), finish]],
  ['unconfirmed error', [input('a'), output('a', { kind: 'error', status: 400, error: 'No rejection proof' }), finish]],
  ['duplicate output', [input('a'), output('a'), output('a'), finish]],
  ['orphan output', [output('a'), finish]],
  ['output preceding its input', [output('a'), input('a'), finish]],
  ['reopened input', [input('a'), output('a'), input('a'), finish]],
  ['duplicate input', [input('a'), input('a'), output('a'), finish]],
  ['unfinished input', [start('a'), output('a'), finish]],
  ['duplicate input start', [start('a'), start('a'), input('a'), output('a'), finish]],
  ['changed tool name', [start('a'), { ...input('a'), toolName: 'other-action' } as UIMessageChunk, output('a'), finish]],
  ['late input delta', [input('a'), output('a'), { type: 'tool-input-delta', toolCallId: 'a', inputTextDelta: '{}' }, finish]],
  ['truncated stream', [input('a'), output('a')]],
  ['late error', [input('a'), output('a'), finish, { type: 'error', errorText: 'Lost response' }]],
  ['error finish', [input('a'), output('a'), { type: 'finish', finishReason: 'error' }]],
] as Array<[string, UIMessageChunk[]]>)('retains uncertainty for %s', async (_name, chunks) => {
  expect(await releases(chunks)).toBe(false);
});

it('preserves HTTP status without treating unmarked or contradictory failures as non-acceptance', () => {
  for (const status of [400, 403, 404, 409, 429]) {
    expect(new ApiRequestError(status, rejected).invocationRejected).toBe(true);
    expect(new ApiRequestError(status, { error: 'Unknown acceptance' }).invocationRejected).toBe(false);
  }
  expect(new ApiRequestError(500, rejected).invocationRejected).toBe(false);
  expect(new ApiRequestError(400, { ...rejected, runId: 'already-accepted' }).invocationRejected).toBe(false);
  expect(new ApiRequestError(400, { ...rejected, acceptance: true }).invocationRejected).toBe(false);
  expect(new ApiRequestError(400, '<html>proxy error</html>').invocationRejected).toBe(false);
});
