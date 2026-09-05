import { z } from 'zod';

// No page text, identifiers, URLs, messages, arguments, errors or attachments.
// Unknown event names/field values are dropped, even if a key looks harmless.
const names = new Set([
  'action.start', 'action.end', 'risk.classified', 'approval.result', 'mutation.intent',
  'policy.decision', 'step.start', 'step.ok', 'step.resolution', 'step.extracted',
  'replay.start', 'replay.success', 'replay.failure', 'replay.business_outcome',
  'discovery.start', 'discovery.observe', 'discovery.decision', 'discovery.finish',
  'discovery.action_error', 'discovery.escalate', 'llm.start', 'llm.end',
  'detector.hit', 'detector.recovering', 'escalation.raised', 'escalation.decision',
  'intervention.pending', 'intervention.decided', 'handoff.to_human', 'handoff.to_automation',
  'control.transfer', 'dialog.unexpected', 'evidence.warning', 'human.action', 'human.action.capped',
]);
const risk = z.enum(['read', 'reversible_write', 'irreversible']);
const failureCode = z.enum([
  'POST_OUTCOME_UNKNOWN', 'RUN_FAILED', 'DISCOVERY_FAILED', 'RUN_ABORTED', 'RUNTIME_CLEANUP_FAILED',
  'PERMISSION_DENIED', 'SESSION_EXPIRED', 'APPLICATION_ERROR',
]);
const businessOutcomeCode = z.enum(['INSUFFICIENT_FUNDS', 'VALIDATION_REJECTED', 'NO_SUCH_MEMBER']);
const fields = {
  attempt: z.number().int().positive(), turn: z.number().int().positive(),
  ms: z.number().finite().nonnegative(), isRetry: z.boolean(), approved: z.boolean(), mutation: z.boolean(),
  action: z.enum(['navigate', 'click', 'fill', 'select', 'extract', 'assert']),
  risk, requestedRisk: risk, effectiveRisk: risk,
  verdict: z.enum(['allow', 'deny', 'needs_human']), method: z.enum(['GET', 'POST']),
  status: z.enum(['success', 'failure', 'business_outcome', 'stopped', 'escalated']),
  classification: z.enum(['business_outcome', 'recoverable', 'fatal']),
  kind: z.enum(['discovery', 'replay', 'risk_approval', 'replay_stuck', 'discovery_stuck']),
  decision: z.enum(['approve', 'retry', 'skip', 'abort']),
  code: failureCode,
} satisfies Record<string, z.ZodTypeAny>;

const strictResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('success') }),
  z.object({ status: z.literal('business_outcome'), outcomeCode: businessOutcomeCode }),
  z.object({ status: z.literal('failure'), failure: z.object({ code: failureCode.optional() }).optional() }),
]);

export function safeEvent(event: string, data: Record<string, unknown>) {
  if (!names.has(event)) return { event: 'evidence.omitted', data: {} as Record<string, unknown> };
  const safe: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(fields)) {
    const parsed = schema.safeParse(data[key]);
    if (parsed.success) safe[key] = parsed.data;
  }
  return { event, data: safe };
}

export function safeResult(result: unknown) {
  const parsed = strictResult.safeParse(result);
  if (!parsed.success) return { status: 'failure', sensitiveValuesUnavailable: true, failure: { code: 'RUN_FAILED' } } as const;
  if (parsed.data.status === 'success') return { status: parsed.data.status, sensitiveValuesUnavailable: true };
  if (parsed.data.status === 'business_outcome') return { ...parsed.data, sensitiveValuesUnavailable: true };
  return { status: parsed.data.status, sensitiveValuesUnavailable: true, failure: { code: parsed.data.failure?.code ?? 'RUN_FAILED' } };
}
