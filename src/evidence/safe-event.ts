import { z } from 'zod';
import { meridianContracts, meridianTransferMemberTable } from '../runtime/contracts.js';

const withheldField = z.object({ name: z.string(), type: z.enum(['string', 'number']), value: z.literal('withheld') }).strict();
const withheldOutput = z.object({ name: z.string(), type: z.enum(['string', 'number', 'table']), value: z.literal('withheld'), columns: z.array(withheldField).max(10).optional() }).strict();
const tableFields: Record<string, readonly string[]> = {
  members: ['memberNumber', 'name'],
  shares: meridianTransferMemberTable.columns.map(column => column.name),
  transaction: ['member', 'sourceShare', 'destinationShare', 'amount', 'memo', 'confirmation'],
};
const structure = z.object({
  capability: z.string(),
  inputs: z.array(withheldField).max(10).nullable(),
  outputs: z.array(withheldOutput).max(10).nullable(),
}).strict().superRefine((value, ctx) => {
  const reject = () => ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid recorded structure' });
  if (!Object.hasOwn(meridianContracts, value.capability)) return reject();
  const contract = meridianContracts[value.capability as keyof typeof meridianContracts];
  const exact = (actual: readonly string[], expected: readonly string[]) => actual.length === expected.length && new Set(actual).size === actual.length && actual.every(name => expected.includes(name));
  if (value.inputs && (!exact(value.inputs.map(field => field.name), contract.parameters.map(field => field.name)) || value.inputs.some(field => field.type !== 'string'))) reject();
  if (value.outputs) {
    if (!exact(value.outputs.map(field => field.name), contract.outputs)) reject();
    for (const output of value.outputs) {
      const columns = Object.hasOwn(tableFields, output.name) ? tableFields[output.name] : undefined;
      if (columns ? output.type !== 'table' || !output.columns || new Set(output.columns.map(column => column.name)).size !== output.columns.length || output.columns.some(column => !columns.includes(column.name))
        : !['string', 'number'].includes(output.type) || output.columns !== undefined) reject();
    }
  }
});
export type RecordedStructure = z.infer<typeof structure>;

/** Fixed contract keys and observed primitive types only; never copy values or dynamic labels. */
export function recordedStructure(capability: string, params: Record<string, string | number>, result?: unknown): RecordedStructure | undefined {
  if (!Object.hasOwn(meridianContracts, capability)) return undefined;
  const contract = meridianContracts[capability as keyof typeof meridianContracts];
  const publicNames = Object.keys(params).filter(name => !['operator', 'password', 'branch'].includes(name));
  const inputs = publicNames.length === contract.parameters.length && contract.parameters.every(field => Object.hasOwn(params, field.name) && typeof params[field.name] === 'string')
    ? contract.parameters.map(field => ({ name: field.name, type: 'string' as const, value: 'withheld' as const })) : null;
  let outputs: RecordedStructure['outputs'] = null;
  if (result && typeof result === 'object' && 'status' in result && result.status === 'success' && 'outputs' in result && result.outputs && typeof result.outputs === 'object' && !Array.isArray(result.outputs)) {
    const values = result.outputs as Record<string, unknown>;
    const fields = Object.keys(values);
    if (fields.length === contract.outputs.length && contract.outputs.every(name => Object.hasOwn(values, name))) {
      const candidate: NonNullable<RecordedStructure['outputs']> = [];
      for (const name of contract.outputs) {
        const value = values[name];
        if (Object.hasOwn(tableFields, name)) {
          const primitive = (cell: unknown) => typeof cell === 'string' || typeof cell === 'number' && Number.isFinite(cell);
          if (!Array.isArray(value) || value.some(row => !row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(key => !tableFields[name]!.includes(key) || !primitive(row[key])))) break;
          const observed = new Set(value.flatMap(row => Object.keys(row)));
          if (value.some(row => Object.keys(row).length !== observed.size || [...observed].some(key => !Object.hasOwn(row, key) || typeof row[key] !== typeof value[0][key]))) break;
          candidate.push({ name, type: 'table', value: 'withheld', columns: tableFields[name]!.filter(key => observed.has(key)).map(name => ({ name, type: typeof value[0][name] as 'string' | 'number', value: 'withheld' })) });
        } else {
          if (typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) break;
          candidate.push({ name, type: typeof value as 'string' | 'number', value: 'withheld' });
        }
      }
      if (candidate.length === contract.outputs.length) outputs = candidate;
    }
  }
  const parsed = structure.safeParse({ capability, inputs, outputs });
  return parsed.success ? parsed.data : undefined;
}

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
  'VALIDATION_REJECTED', 'NO_SUCH_MEMBER', 'INSUFFICIENT_FUNDS',
  'RECOVERY_FAILED', 'RECOVERY_CHECKPOINT_REQUIRED', 'DISCOVERY_CONDITION_CHECK_FAILED',
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
  z.object({ status: z.literal('stopped') }),
  z.object({ status: z.literal('escalated') }),
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
  const metadata = result && typeof result === 'object' && 'structure' in result ? structure.safeParse(result.structure) : undefined;
  const recorded = metadata?.success ? { structure: { ...metadata.data, outputs: parsed.data.status === 'success' ? metadata.data.outputs : null } } : {};
  if (parsed.data.status === 'business_outcome') return { ...parsed.data, ...recorded, sensitiveValuesUnavailable: true };
  if (parsed.data.status === 'failure') return { status: parsed.data.status, ...recorded, sensitiveValuesUnavailable: true, failure: { code: parsed.data.failure?.code ?? 'RUN_FAILED' } };
  return { status: parsed.data.status, ...recorded, sensitiveValuesUnavailable: true };
}
