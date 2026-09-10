import { expect, it } from 'vitest';
import type { UIMessageChunk } from 'ai';
import { ApiRequestError, allActionToolsRejected, observeGuardedChatStream, preparedWithoutInvocation, type ChatLifecycle } from '../src/server/ui/transport.js';

const rejected = { kind: 'error', status: 400, error: 'Invalid arguments', acceptance: 'rejected' };
const input = (id: string, toolName = 'read-member'): UIMessageChunk => ({ type: 'tool-input-available', toolCallId: id, toolName, input: {} });
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

async function settle(chunks: UIMessageChunk[]) {
  const lifecycle: ChatLifecycle = { key: 'current', intent: 'action', sawTool: false, sawStatusTool: false,
    sawOtherTool: false, finishSeen: false, postFinishFailure: false, failed: false, settled: false, toolNames: new Map() };
  const observed = observeGuardedChatStream(new ReadableStream({ start(controller) {
    for (const chunk of chunks) controller.enqueue(chunk);
    controller.close();
  } }), lifecycle, new Map([[lifecycle.key, lifecycle]]), { complete: () => {}, uncertain: () => {} });
  const reader = observed.getReader();
  while (!(await reader.read()).done) { /* drain */ }
  return lifecycle;
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
  expect(new ApiRequestError(400, '<html>proxy error</html>').invocationRejected).toBe(false);
});

const preparedOutput = { kind: 'prepared', confirmationId: 'c-1', capability: 'meridian-funds-transfer', args: { member: '102777' } };

it('recognizes a completed prepare-only turn as needing no run lookup', async () => {
  expect(preparedWithoutInvocation(await settle([input('a', 'prepare_funds_transfer'), output('a', preparedOutput), finish]))).toBe(true);
  expect(preparedWithoutInvocation(await settle([input('a', 'prepare_funds_transfer'), output('a', preparedOutput), input('b', 'prepare_funds_transfer'), output('b', preparedOutput), finish]))).toBe(true);
  expect(preparedWithoutInvocation(await settle([input('a', 'prepare_funds_transfer'), output('a', { kind: 'error', status: 400, error: 'Facts do not match the contract' }), finish]))).toBe(true);
  // A lost output never hides a reserved run: prepare validates without the journal.
  expect(preparedWithoutInvocation(await settle([input('a', 'prepare_funds_transfer'), finish]))).toBe(true);
});

it.each([
  ['capability invocation', [input('a', 'meridian-funds-transfer'), output('a', { kind: 'run', runId: 'r1' }), finish]],
  ['status tool mixed in', [input('a', 'prepare_funds_transfer'), output('a', preparedOutput), input('b', 'run_status'), output('b', { kind: 'run', runId: 'r1' }), finish]],
  ['no tool call', [{ type: 'finish', finishReason: 'stop' } as UIMessageChunk]],
  ['stop finish with prepare', [input('a', 'prepare_funds_transfer'), output('a', preparedOutput), { type: 'finish', finishReason: 'stop' } as UIMessageChunk]],
  ['failed stream', [input('a', 'prepare_funds_transfer'), output('a', preparedOutput), finish, { type: 'error', errorText: 'Lost' }]],
] as Array<[string, UIMessageChunk[]]>)('treats %s as not a prepare-only turn', async (_name, chunks) => {
  expect(preparedWithoutInvocation(await settle(chunks))).toBe(false);
});
