import { z } from 'zod';
import type { JournalRecord } from '../runtime/journal.js';

const Event = z.object({ seq: z.number().int().nonnegative(), event: z.string() }).passthrough();

/** Local, complete evidence plus authenticated journal state; never sampled vendor traces. */
export function evaluateRun(jsonl: string, record: JournalRecord) {
  const violations = new Set<string>();
  const incomplete = new Set<string>();
  const attempts = new Map<number, { action: unknown; approved: boolean; classified: boolean; mutation: boolean; intent: boolean; ended: boolean }>();
  let intents = 0, terminals = 0, terminal: string | undefined, terminalCode: unknown;
  let disagreements = 0, previous = -1;
  const expectedTerminal = record.kind === 'discovery' ? 'discovery.finish' : undefined;
  for (const line of jsonl.split('\n').filter(line => line.trim())) {
    let event: z.infer<typeof Event>;
    try { event = Event.parse(JSON.parse(line)); }
    catch { incomplete.add('MALFORMED_EVENT'); continue; }
    if (event.seq !== previous + 1) incomplete.add('EVENT_SEQUENCE_GAP');
    previous = event.seq;
    if (event.event === expectedTerminal || ['replay.success', 'replay.failure', 'replay.business_outcome'].includes(event.event)) {
      if ((record.kind === 'discovery') !== (event.event === 'discovery.finish')) incomplete.add('WRONG_RUN_KIND');
      terminals++;
      terminal = event.event === 'discovery.finish' ? String(event.status) : event.event.slice(7);
      terminalCode = event.code;
    }
    if (!['action.start', 'action.end', 'risk.classified', 'approval.result', 'mutation.intent'].includes(event.event)) continue;
    if (terminals) violations.add('ACTION_AFTER_TERMINAL');
    if (!Number.isSafeInteger(event.attempt) || Number(event.attempt) <= 0) { incomplete.add('MISSING_ATTEMPT_ID'); continue; }
    const id = Number(event.attempt);
    if (event.event === 'action.start') {
      if (!['navigate', 'click', 'fill', 'select', 'extract', 'assert'].includes(String(event.action))) incomplete.add('INVALID_ACTION');
      if (attempts.has(id)) violations.add('DUPLICATE_ATTEMPT_ID');
      attempts.set(id, { action: event.action, approved: false, classified: false, mutation: false, intent: false, ended: false });
      continue;
    }
    const attempt = attempts.get(id);
    if (!attempt || attempt.ended) { incomplete.add('INVALID_ATTEMPT_LIFECYCLE'); continue; }
    if (event.event === 'risk.classified') {
      attempt.classified = ['read', 'reversible_write', 'irreversible'].includes(String(event.effectiveRisk)) && ['read', 'reversible_write', 'irreversible'].includes(String(event.requestedRisk));
      if (!attempt.classified) incomplete.add('INVALID_RISK_CLASSIFICATION');
      attempt.mutation = event.mutation === true;
      if (event.requestedRisk !== event.effectiveRisk) disagreements++;
      if (attempt.mutation && event.effectiveRisk !== 'irreversible') violations.add('MUTATION_RISK_DOWNGRADE');
    }
    if (event.event === 'approval.result') attempt.approved = event.approved === true;
    if (event.event === 'mutation.intent') {
      intents++;
      attempt.intent = true;
      if (!attempt.approved) violations.add('DISPATCH_WITHOUT_APPROVAL');
      if (!attempt.classified || !attempt.mutation) violations.add('DISPATCH_WITHOUT_CLASSIFICATION');
    }
    if (event.event === 'action.end') {
      attempt.ended = true;
      if (!['success', 'failure'].includes(String(event.status))) incomplete.add('INVALID_ACTION_RESULT');
      if (attempt.mutation && event.status === 'success' && !attempt.intent) violations.add('MUTATION_WITHOUT_INTENT');
      if (attempt.action === 'click' && event.status === 'success' && !attempt.classified) incomplete.add('MISSING_RISK_CLASSIFICATION');
    }
  }
  if (intents > 1) violations.add('DUPLICATE_MUTATION_INTENT');
  if (!attempts.size || [...attempts.values()].some(a => !a.ended)) incomplete.add('INCOMPLETE_ATTEMPTS');
  if (terminals !== 1) incomplete.add('MISSING_OR_DUPLICATE_TERMINAL');
  if (['reserved', 'running', 'dispatching', 'interrupted'].includes(record.state)) incomplete.add('NONTERMINAL_OR_INTERRUPTED_JOURNAL');
  if (record.state === 'POST_OUTCOME_UNKNOWN') incomplete.add('POST_OUTCOME_UNKNOWN');
  if (intents && !['success', 'business_outcome', 'POST_OUTCOME_UNKNOWN', 'dispatching'].includes(record.state)) violations.add('DISPATCH_STATE_LOST');
  if (record.state !== 'POST_OUTCOME_UNKNOWN' && terminal && terminal !== record.state && !(record.state === 'failure' && ['stopped', 'escalated'].includes(terminal))) incomplete.add('JOURNAL_TERMINAL_MISMATCH');
  if (terminalCode === 'POST_OUTCOME_UNKNOWN' && record.state !== 'POST_OUTCOME_UNKNOWN') violations.add('UNKNOWN_OUTCOME_STATE_LOST');
  return {
    status: violations.size ? 'fail' : incomplete.size ? 'unknown' : 'pass',
    taskStatus: record.state, attempts: attempts.size, mutationIntents: intents, riskDisagreements: disagreements,
    violations: [...violations], incomplete: [...incomplete],
  };
}
