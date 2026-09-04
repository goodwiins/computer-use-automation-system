// The discovery loop: observe → decide (LLM) → act, until the goal is met or
// a stopping condition fires. Produces the action trace the recorder turns
// into a capability artifact. This is the only place the model exists; replay
// never sees it.

import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { extractText, Assertion, RiskClass, TableColumn, type TargetDescriptor, type OutputValue } from '../artifact/schema.js';
import type { InterventionDecision, InterventionRequest } from '../escalation/session.js';
import type { RunLogger } from '../evidence/logger.js';
import type { Surface } from '../surface/types.js';
import { RunAbortedError } from '../surface/guarded.js';
import { DISCOVERY_TOOLS, hintToDescriptor, systemPrompt, type TargetHint } from './tools.js';

export interface TraceEntry {
  action: 'navigate' | 'click' | 'fill' | 'select' | 'extract' | 'assert';
  assert?: Assertion;
  columns?: TableColumn[];
  rowSelector?: string;
  pattern?: string;
  selectBy?: 'label' | 'value';
  reason: string;
  descriptor?: TargetDescriptor; // robust, derived from the live element
  url?: string;
  value?: string;
  outputName?: string;
  extractedText?: string;
  urlAfter: string;
  /** Model-classified risk for click steps (submits/mutates state?). Defaults to 'read'. */
  risk?: 'read' | 'reversible_write' | 'irreversible';
}

export interface DiscoveryResult {
  status: 'success' | 'escalated' | 'stopped';
  trace: TraceEntry[];
  outputs: Record<string, OutputValue>;
  summary?: string;
  finalUrl: string;
  stopReason?: string;
}

export interface DiscoveryDeps {
  surface: Surface; // policy-guarded
  logger: RunLogger;
  openai: OpenAI;
  model: string;
  maxSteps: number;
  timeoutMs?: number; // wall-clock bound; default 10 min
  boundParams?: Record<string, string>;
  sanitizeObservation?: (text: string) => string;
  escalate?: (req: InterventionRequest) => Promise<InterventionDecision>;
}

const MAX_SNAPSHOT_CHARS = 4000;
const MAX_CONSECUTIVE_FAILURES = 3;

export async function runDiscovery(
  goal: string,
  entryUrl: string,
  params: Record<string, string | number>,
  origins: string[],
  deps: DiscoveryDeps,
): Promise<DiscoveryResult> {
  const { surface, logger, openai, model } = deps;
  const trace: TraceEntry[] = [];
  const outputs: Record<string, OutputValue> = {};
  const bindValue = (value: string) => {
    const reference = /^\{\{(\w+)\}\}$/.exec(value);
    return reference && deps.boundParams?.[reference[1]!] !== undefined ? deps.boundParams[reference[1]!]! : value;
  };

  logger.log('discovery.start', { goal, entryUrl, model, params });
  await surface.start(entryUrl);

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt(goal, params, origins) },
  ];

  let repaired = false;
  let consecutiveFailures = 0;
  const deadline = Date.now() + (deps.timeoutMs ?? 10 * 60_000);

  for (let turn = 1; turn <= deps.maxSteps; turn++) {
    if (Date.now() > deadline) return finish('stopped', `timeout: discovery exceeded ${deps.timeoutMs ?? 600_000}ms`);
    const obs = await surface.observe();
    const shot = await logger.screenshot(surface, `turn${turn}`);
    const obsText =
      `URL: ${obs.url}\nTITLE: ${obs.title}\n` +
      obs.frames
        .map(
          (f) =>
            `--- frame "${f.frame}"${f.frame ? '' : ' (main page; omit frame argument)'} ---\n${f.snapshot.slice(0, MAX_SNAPSHOT_CHARS)}` +
            (f.fields.length
              ? `\nform fields in this frame (use nameAttr to target them): ${f.fields.map((x) => `${x.name} (${x.type})`).join(', ')}`
              : '') + (f.tables?.length ? `\nObserved leaf-table structure (selectors are derived from the live DOM): ${JSON.stringify(f.tables)}` : ''),
        )
        .join('\n');
    messages.push({ role: 'user', content: deps.sanitizeObservation?.(obsText) ?? obsText });
    logger.log('discovery.observe', { turn, url: obs.url, screenshot: shot });

    const started = performance.now();
    logger.log('llm.start', { turn });
    const completion = await openai.chat.completions.create({
      model,
      messages,
      tools: DISCOVERY_TOOLS,
      tool_choice: 'required',
    }, { timeout: Math.max(1, deadline - Date.now()), maxRetries: 0 }).then(result => {
      logger.log('llm.end', { turn, status: 'success', ms: performance.now() - started });
      return result;
    }, error => {
      logger.log('llm.end', { turn, status: 'failure', ms: performance.now() - started });
      throw error;
    });
    const msg = completion.choices[0]?.message;
    const call = msg?.tool_calls?.[0];
    if (!msg || !call) {
      return finish('stopped', 'model returned no tool call');
    }
    messages.push({ role: 'assistant', content: msg.content ?? '', tool_calls: [call] });
    const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown> & TargetHint;
    const reason = String(args.reason ?? '');
    logger.log('discovery.decision', { turn, tool: call.function.name, args });

    const respond = (content: string) =>
      messages.push({ role: 'tool', tool_call_id: call.id, content: deps.sanitizeObservation?.(content) ?? content });

    try {
      surface.setStep?.(`s${trace.length + 1}`);
      switch (call.function.name) {
        case 'assert': {
          const assertion = Assertion.parse(args);
          const ok = assertion.kind === 'urlMatches' ? new RegExp(assertion.pattern).test(surface.currentUrl()) : await surface.isTextVisible(assertion.text, assertion.frame);
          if (!ok) throw new Error('Checkpoint failed');
          trace.push({ action: 'assert', reason, assert: assertion, urlAfter: surface.currentUrl() });
          respond('Checkpoint verified.');
          break;
        }
        case 'done': {
          if (repaired) return finish('escalated', 'Human repair requires a fresh complete recording');
          return finish('success', undefined, String(args.summary ?? ''));
        }
        case 'escalate': {
          logger.log('discovery.escalate', { reason });
          if (deps.escalate) {
            const decision = await deps.escalate({
              kind: 'discovery_stuck',
              capability: '(discovery)',
              goal,
              reason,
              url: surface.currentUrl(),
              screenshot: shot,
            });
            if (decision !== 'abort') {
              repaired = true;
              respond('A human operator intervened on the live session. Re-observe and continue.');
              continue;
            }
          }
          return finish('escalated', reason);
        }
        case 'navigate': {
          const url = String(args.url);
          await surface.navigate(url);
          trace.push({ action: 'navigate', reason, url, urlAfter: surface.currentUrl() });
          respond(`Navigated to ${surface.currentUrl()}`);
          break;
        }
        case 'click':
        case 'fill':
        case 'select':
        case 'extract': {
          const hint = hintToDescriptor(args, reason);
          // Derive the robust descriptor BEFORE acting — the click may navigate away.
          const descriptor = await surface.describeTarget(hint);
          const entry: TraceEntry = { action: call.function.name, reason, descriptor, urlAfter: '' };
          if (call.function.name === 'click') {
            if (deps.boundParams && new URL(surface.currentUrl()).pathname === '/signon') {
              const missing = Object.keys(deps.boundParams).filter(name => !trace.some(step => ['fill', 'select'].includes(step.action) && step.value === `{{${name}}}`));
              if (missing.length) throw new Error(`Record the explicit server-reference fill/select actions before Sign On, even for correct defaults: ${missing.join(', ')}`);
            }
            const risk = RiskClass.parse(args.risk ?? 'read');
            entry.risk = risk;
            await surface.click(descriptor, undefined, risk);
            entry.risk = surface.effectiveRisk ?? risk;
            respond(`Clicked "${descriptor.description}". Now at ${surface.currentUrl()}`);
          } else if (call.function.name === 'fill') {
            entry.value = String(args.value);
            await surface.fill(descriptor, bindValue(entry.value));
            respond(`Filled.`);
          } else if (call.function.name === 'select') {
            entry.value = String(args.value);
            entry.selectBy = args.selectBy === 'value' ? 'value' : 'label';
            await surface.select(descriptor, bindValue(entry.value), undefined, undefined, entry.selectBy);
            respond(`Selected "${entry.value}".`);
          } else {
            if (args.columns) {
              entry.rowSelector = typeof args.rowSelector === 'string' ? args.rowSelector : undefined;
              entry.columns = TableColumn.array().min(1).parse(args.columns);
              if (!surface.readTable) throw new Error('Table extraction unavailable');
              entry.outputName = String(args.outputName);
              outputs[entry.outputName] = await surface.readTable(descriptor, entry.columns, undefined, entry.rowSelector);
              respond(`Extracted ${entry.outputName}: ${JSON.stringify(outputs[entry.outputName])}`);
              entry.urlAfter = surface.currentUrl();
              trace.push(entry);
              break;
            }
            const { text } = await surface.readText(descriptor);
            entry.outputName = String(args.outputName);
            entry.pattern = typeof args.pattern === 'string' ? args.pattern : undefined;
            entry.extractedText = extractText(text, entry.pattern);
            outputs[entry.outputName] = entry.extractedText;
            respond(`Extracted ${entry.outputName} = "${entry.extractedText}"`);
          }
          entry.urlAfter = surface.currentUrl();
          trace.push(entry);
          break;
        }
        default:
          respond(`Unknown tool ${call.function.name}`);
      }
      consecutiveFailures = 0;
    } catch (err) {
      if (surface.mutationDispatched) return finish('stopped', 'POST_OUTCOME_UNKNOWN');
      if (err instanceof RunAbortedError) return finish('stopped', 'RUN_ABORTED');
      consecutiveFailures++;
      const message = err instanceof Error ? err.message : String(err);
      logger.log('discovery.action_error', { turn, error: message, consecutiveFailures });
      respond(
        `ERROR: ${deps.sanitizeObservation?.(message) ?? message}. Re-observe and try a DIFFERENT targeting strategy — ` +
          `nameAttr for form fields, exact visible text for links/buttons, css as last resort.`,
      );
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        if (deps.escalate) {
          logger.log('discovery.escalate', { reason: message, trigger: 'consecutive_failures' });
          const decision = await deps.escalate({
            kind: 'discovery_stuck',
            capability: '(discovery)',
            goal,
            reason: message,
            url: surface.currentUrl(),
            screenshot: shot,
          });
          if (decision !== 'abort') {
              repaired = true;
            consecutiveFailures = 0;
            respond('A human operator intervened on the live session. Re-observe and continue.');
            continue;
          }
        }
        return finish('stopped', `stuck: ${consecutiveFailures} consecutive action failures (last: ${message})`);
      }
    }
  }
  return finish('stopped', `max steps (${deps.maxSteps}) reached`);

  function finish(status: DiscoveryResult['status'], stopReason?: string, summary?: string): DiscoveryResult {
    const result: DiscoveryResult = {
      status,
      trace,
      outputs,
      summary,
      finalUrl: surface.currentUrl(),
      stopReason,
    };
    logger.log('discovery.finish', { status, stopReason, outputs, steps: trace.length });
    return result;
  }
}
