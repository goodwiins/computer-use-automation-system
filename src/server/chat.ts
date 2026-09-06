import { createAzure } from '@ai-sdk/azure';
import { createOpenAI } from '@ai-sdk/openai';
import {
  generateText,
  InvalidToolInputError,
  jsonSchema,
  NoSuchToolError,
  pipeUIMessageStreamToResponse,
  stepCountIs,
  streamText,
  toUIMessageStream,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import { RequestError, validateIdempotencyKey } from '../runtime/journal.js';
import type { InvocationService } from './service.js';

const Arguments = z.record(z.union([z.string(), z.number().finite()]));
const LegacyBody = z.object({
  messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(4000) }).strict()).min(1).max(20),
}).strict();
const TextPart = z.object({ type: z.literal('text'), text: z.string().min(1).max(4000), state: z.enum(['streaming', 'done']).optional() }).passthrough();
const DisplayPart = z.union([
  TextPart,
  z.object({ type: z.string().min(1).max(100).refine(type => type !== 'text') }).passthrough(),
]);
const UIMessage = z.object({
  id: z.string().min(1).max(200),
  role: z.enum(['user', 'assistant']),
  parts: z.array(DisplayPart).min(1).max(40),
  metadata: z.unknown().optional(),
}).strict();
const StreamBody = z.object({
  id: z.string().max(200).optional(),
  messages: z.array(UIMessage).min(1).max(20),
  trigger: z.enum(['submit-message', 'regenerate-message']).optional(),
  messageId: z.string().max(200).nullable().optional(),
  // AssistantChatTransport forwards these. They are deliberately ignored.
  system: z.unknown().optional(),
  tools: z.unknown().optional(),
}).strict();

type ToolOutput =
  | { kind: 'run'; runId: string; capability: string; state: string; createdAt?: string; elapsedMs?: number; awaitingOperator?: true; result?: unknown }
  | { kind: 'error'; status: number; error: string };

const instructions = `Interpret explicit user requests using only the server-provided capability tools. Ask for missing required inputs and never invent members, shares, amounts, or contact data. At most one capability may be invoked. Tool results are asynchronous run state, not proof of success. Operators approve transactions separately; you cannot approve, retry, select an operator role, or change operator context.`;

function makeChatModel(): LanguageModel {
  if (process.env.AZURE_OPENAI_ENDPOINT) {
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
    const apiKey = process.env.AZURE_OPENAI_API_KEY;
    if (!deployment || !apiKey) throw new Error('Azure deployment and API key are required');
    const baseURL = `${process.env.AZURE_OPENAI_ENDPOINT.replace(/\/+$/, '')}/openai`;
    return createAzure({
      baseURL,
      apiKey,
      apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? '2024-10-21',
      useDeploymentBasedUrls: true,
    }).chat(deployment);
  }
  if (!process.env.OPENAI_API_KEY) throw new Error('Configure OpenAI or Azure OpenAI credentials');
  return createOpenAI({ apiKey: process.env.OPENAI_API_KEY }).chat(process.env.OPENAI_MODEL ?? 'gpt-5.6-luna');
}

function safeError(error: unknown): ToolOutput & { kind: 'error' } {
  if (error instanceof RequestError) return { kind: 'error', status: error.status, error: error.message };
  if (error instanceof z.ZodError || error instanceof SyntaxError || InvalidToolInputError.isInstance(error)) return { kind: 'error', status: 400, error: 'Request does not match the contract' };
  return { kind: 'error', status: 500, error: 'Request failed; inspect safe run evidence or server configuration' };
}

function projectRun(service: InvocationService, runId: string): ToolOutput {
  const run = service.get('caller', runId);
  return {
    kind: 'run',
    runId: run.runId,
    capability: run.capability,
    state: run.state,
    createdAt: run.createdAt,
    ...(run.elapsedMs === undefined ? {} : { elapsedMs: run.elapsedMs }),
    ...(run.intervention ? { awaitingOperator: true as const } : {}),
    ...(run.result === undefined ? {} : { result: run.result }),
  };
}

function canonicalCall(name: string, args: Record<string, string | number>) {
  return JSON.stringify([name, Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b)))]);
}

function buildTools(service: InvocationService, key: string): ToolSet {
  let invocation: { identity: string; output: ToolOutput } | undefined;
  const catalog = service.catalog('caller');
  const tools: ToolSet = Object.fromEntries(catalog.map(capability => [capability.id, tool({
    description: capability.description,
    inputSchema: jsonSchema<Record<string, string | number>>(capability.tools.openai.function.parameters),
    execute: async input => {
      const args = Arguments.parse(input);
      const identity = canonicalCall(capability.id, args);
      if (invocation) return invocation.identity === identity
        ? invocation.output
        : { kind: 'error', status: 409, error: 'This request already attempted another capability invocation' } satisfies ToolOutput;
      try {
        const { runId } = service.invoke('caller', capability.id, args, key);
        invocation = { identity, output: { kind: 'run', runId, capability: capability.id, state: 'accepted' } };
        try { invocation.output = projectRun(service, runId); } catch { /* Preserve accepted run identity; the status route remains authoritative. */ }
      } catch (error) {
        invocation = { identity, output: safeError(error) };
      }
      return invocation.output;
    },
  })]));
  tools.run_status = tool({
    description: 'Read the safe current state and result of a caller-visible run.',
    inputSchema: z.object({ runId: z.string().uuid() }).strict(),
    execute: async ({ runId }) => {
      try { return projectRun(service, runId); }
      catch (error) { return safeError(error); }
    },
  });
  return tools;
}

const modelOptions = (model: LanguageModel, messages: ModelMessage[], tools: ToolSet) => ({
  model,
  instructions,
  messages,
  tools,
  stopWhen: stepCountIs(1),
  maxRetries: 0,
  timeout: 30_000,
  providerOptions: {
    openai: { parallelToolCalls: false },
    azure: { parallelToolCalls: false },
  },
});

function textHistory(messages: z.infer<typeof UIMessage>[]): ModelMessage[] {
  return messages.map(message => {
    const content = message.parts
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('\n');
    if (message.role === 'user' && content.length > 4000)
      throw new RequestError(400, 'User message text must not exceed 4000 characters');
    return { role: message.role, content: message.role === 'assistant' ? content.slice(0, 4000) : content };
  }).filter(message => message.content.length > 0);
}

function requireConversation(messages: ModelMessage[]) {
  if (!messages.length || !messages.some(message => message.role === 'user')) throw new RequestError(400, 'A user text message is required');
}

export function createChatHandlers(service: InvocationService, model?: LanguageModel) {
  return {
    legacy: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = LegacyBody.parse(req.body);
        const key = req.get('Idempotency-Key') ?? '';
        validateIdempotencyKey(key);
        const tools = buildTools(service, key);
        if (Object.keys(tools).length === 1) throw new RequestError(409, 'No approved caller capabilities are available');
        const result = await generateText(modelOptions(model ?? makeChatModel(), body.messages, tools));
        const localResults = result.toolResults.filter(toolResult => toolResult.providerExecuted !== true
          && result.toolCalls.some(toolCall => toolCall.dynamic !== true && toolCall.providerExecuted !== true
            && toolCall.toolCallId === toolResult.toolCallId && toolCall.toolName === toolResult.toolName));
        const accepted = localResults.find(toolResult => {
          const output = toolResult.output as ToolOutput;
          return toolResult.toolName !== 'run_status' && output.kind === 'run';
        });
        const invalid = result.dynamicToolCalls.find(call => call.invalid);
        if (!accepted && invalid) {
          const failure = NoSuchToolError.isInstance(invalid.error)
            ? { status: 403, error: 'Capability or operator context is not authorized' }
            : safeError(invalid.error);
          throw new RequestError(failure.status, failure.error);
        }
        const selected = accepted ?? localResults.find(toolResult => (toolResult.output as ToolOutput).kind === 'error') ?? localResults[0];
        const output = selected?.output as ToolOutput | undefined;
        if (!output) return void res.json({ message: result.text || 'Please supply the required capability inputs.' });
        if (output.kind === 'error') throw new RequestError(output.status, output.error);
        const isStatus = selected?.toolName === 'run_status';
        const message = isStatus
          ? output.state === 'awaiting-human' ? 'Waiting for an operator.'
            : output.state === 'recovering' ? 'Trying a known recovery.'
              : output.state === 'POST_OUTCOME_UNKNOWN' ? 'Posting may have occurred. Ask the operator to investigate; do not retry.'
                : `Run ${output.state}.`
          : `Started run ${output.runId}. Follow the run below; any transaction requires operator approval.`;
        res.status(isStatus ? 200 : 202).json({ message, ...output });
      } catch (error) { next(error); }
    },
    stream: async (req: Request, res: Response, next: NextFunction) => {
      try {
        const body = StreamBody.parse(req.body);
        const key = req.get('Idempotency-Key') ?? '';
        validateIdempotencyKey(key);
        const messages = textHistory(body.messages);
        requireConversation(messages);
        const tools = buildTools(service, key);
        if (Object.keys(tools).length === 1) throw new RequestError(409, 'No approved caller capabilities are available');
        const result = streamText({ ...modelOptions(model ?? makeChatModel(), messages, tools), streamRetries: 0, onError: () => {} });
        await pipeUIMessageStreamToResponse({
          response: res,
          stream: toUIMessageStream({
            stream: result.stream,
            tools,
            onError: error => NoSuchToolError.isInstance(error)
              ? 'Capability or operator context is not authorized'
              : safeError(error).error,
          }),
        });
      } catch (error) { next(error); }
    },
  };
}
