// Deterministic replay: run a capability artifact with concrete params, no
// LLM anywhere in the decision loop. Same inputs, same steps, same outputs.
//
// Error model per step:
//   1. Check detectors (known runtime conditions) — classify hits as
//      business_outcome / recoverable (bounded recovery) / fatal.
//   2. Execute the step with tiered locator resolution and bounded waiting.
//   3. On step failure, re-check detectors (the failure is often *explained*
//      by a condition that appeared mid-flight, e.g. session expiry).
//   4. Otherwise: hard failure with expected-vs-observed evidence — or, in
//      attended mode, escalate to a human on the live session.

import {
  extractText,
  resolveTarget,
  resolveTemplate,
  resolveTemplateForRegex,
  validateParams,
  validOutput,
  type OutputValue,
  type Assertion,
  type CapabilityArtifact,
  type Step,
} from '../artifact/schema.js';
import type { InterventionDecision, InterventionRequest } from '../escalation/session.js';
import type { RunLogger } from '../evidence/logger.js';
import { originAllowed, type Policy } from '../safety/policy.js';
import { PolicyViolationError, RunAbortedError } from '../surface/guarded.js';
import type { Surface } from '../surface/types.js';
import { checkDetectors, matchDetector } from './detectors.js';
import { InsufficientFundsError, type ReplayResult, type StepFailure } from './outcomes.js';
import { assertMeridianScalarWriteOutputs, assertTransferOutputs, transferFactsFromParams } from '../runtime/contracts.js';

export interface ReplayDeps {
  surface: Surface; // must already be policy-guarded
  logger: RunLogger;
  policy: Policy;
  /** Present only in attended mode: hands the live session to a human. */
  escalate?: (req: InterventionRequest) => Promise<InterventionDecision>;
  validateCompletion?: (outputs: Record<string, OutputValue>) => void | Promise<void>;
}

export async function runReplay(
  artifact: CapabilityArtifact,
  params: Record<string, string | number>,
  deps: ReplayDeps,
): Promise<ReplayResult> {
  const { surface, logger } = deps;
  const recoveries: string[] = [];
  let strictRecoveryAttempted = false;
  let strictRecoveryCount = 0;
  const outputs: Record<string, OutputValue> = {};
  const base = { runId: logger.runId, evidenceDir: logger.dir, recoveries };

  // Per-tenant defaults (from an overlay) fill in under the caller's params.
  params = { ...artifact.paramDefaults, ...params };
  const transfer = artifact.app.appId === 'meridian' ? transferFactsFromParams(params) : undefined;
  const requiresFreshCompletion = artifact.app.appId === 'meridian' && ['meridian-open-share', 'meridian-update-member', 'meridian-place-hold'].includes(artifact.id);
  const paramCheck = validateParams(artifact, params);
  if (!paramCheck.ok) {
    return fail({ stepId: '(pre-flight)', intent: 'validate parameters', expected: 'params matching the artifact contract', observed: paramCheck.error });
  }
  try {
    assertMeridianScalarWriteOutputs(artifact);
  } catch (err) {
    return fail({
      stepId: '(pre-flight)',
      intent: 'validate scalar write outputs',
      expected: 'one declared string output produced by one scalar extraction',
      observed: err instanceof Error ? err.message : String(err),
    });
  }
  const originsOk = artifact.app.allowedOrigins.every((o) => deps.policy.allowedOrigins.includes(o));
  if (!originsOk) {
    return fail({
      stepId: '(pre-flight)',
      intent: 'authorize the artifact\'s declared origins',
      expected: 'artifact.app.allowedOrigins is a subset of policy.allowedOrigins',
      observed: `artifact origins [${artifact.app.allowedOrigins.join(', ')}] not all within policy origins [${deps.policy.allowedOrigins.join(', ')}]`,
    });
  }
  if (artifact.status === 'draft' && deps.policy.requireApprovedForUnattended && !deps.escalate) {
    return fail({ stepId: '(pre-flight)', intent: 'authorize unattended replay', expected: 'artifact status "approved"', observed: 'status "draft" — run attended (--attended) or approve the artifact' });
  }
  if (requiresFreshCompletion && !deps.validateCompletion) {
    return fail({ stepId: '(pre-flight)', intent: 'bind completion validation', expected: 'a fresh member-record read-back validator', observed: 'completion validator is unavailable' });
  }

  logger.log('replay.start', { capability: artifact.id, version: artifact.version, params });
  try {
    await surface.start(resolveTemplate(artifact.app.entryUrl, params));
  } catch (err) {
    if (err instanceof RunAbortedError) return aborted('(pre-flight)');
    return fail({
      stepId: '(pre-flight)',
      intent: 'open the capability entry URL',
      expected: `a live session at ${artifact.app.entryUrl}`,
      observed: err instanceof Error ? err.message : String(err),
    });
  }

  function fail(failure: StepFailure, escalated = false): ReplayResult {
    if (surface.mutationDispatched) failure = { ...failure, code: 'POST_OUTCOME_UNKNOWN', observed: 'Dispatch began but completion was not verified. Do not repeat this operation.' };
    logger.log('replay.failure', { ...failure, escalated });
    const result: ReplayResult = { status: 'failure', failure, escalated, ...base };
    logger.writeResult(result);
    return result;
  }

  function aborted(stepId: string): ReplayResult {
    return fail({ code: 'RUN_ABORTED', stepId, intent: 'authorize action', expected: 'operator approval', observed: 'Run aborted by operator' });
  }

  // Returns null to continue, or a terminal result.
  async function handleConditions(stepId: string, allowStrictRecovery = true): Promise<ReplayResult | null> {
    if (surface.mutationDispatched) return null;
    for (let round = 0; round < 2; round++) {
      try {
        const d = await checkDetectors(surface, artifact);
        if (!d) return null;
        logger.log('detector.hit', { stepId, detector: d.id, classification: d.classification });
        if (d.classification === 'business_outcome') {
          const shot = await logger.screenshot(surface, `outcome-${d.id}`);
          logger.log('replay.business_outcome', { code: d.outcomeCode, screenshot: shot });
          const result: ReplayResult = {
            status: 'business_outcome',
            outcomeCode: d.outcomeCode ?? d.id,
            detail: d.description,
            ...base,
          };
          logger.writeResult(result);
          return result;
        }
        const strictMeridian = artifact.app.appId === 'meridian';
        const strictRecovery = strictMeridian && artifact.schemaVersion === 2
          && d.classification === 'recoverable';
        if (strictMeridian && artifact.schemaVersion !== 2 && d.classification === 'recoverable') {
          return fail({ code: 'RECOVERY_FAILED', stepId, intent: 'recover from runtime condition', expected: 'a schema-version-2 guarded operation recovery', observed: 'Legacy MERIDIAN recovery is not permitted' });
        }
        if (strictRecovery && !allowStrictRecovery) {
          return fail({ code: 'RECOVERY_FAILED', stepId, intent: 'recover from runtime condition', expected: 'maintenance only at a successful action boundary', observed: 'The condition appeared after an uncertain action failure' });
        }
        if (strictRecovery && strictRecoveryAttempted) {
          return fail({ code: 'RECOVERY_FAILED', stepId, intent: 'recover from runtime condition', expected: 'one bounded operation recovery', observed: 'The runtime condition appeared again after recovery' });
        }
        if (strictRecovery) {
          strictRecoveryAttempted = true;
          recoveries.push(`${stepId}:${d.id}`);
          logger.log('detector.recovering', { detector: d.id, action: 'click' });
          try {
            if (!surface.recoverOperation) throw new Error('Guarded operation recovery is unavailable');
            surface.setStep?.(stepId);
            await surface.recoverOperation(d.id);
            strictRecoveryCount++;
            continue;
          } catch (err) {
            if (surface.mutationDispatched) return fail({ code: 'POST_OUTCOME_UNKNOWN', stepId, intent: 'recover from runtime condition', expected: 'known dispatch outcome', observed: 'Dispatch began before recovery failed' });
            if (err instanceof RunAbortedError) return aborted(stepId);
            return fail({ code: 'RECOVERY_FAILED', stepId, intent: 'recover from runtime condition', expected: 'an allowed bound operation recovery', observed: 'Guarded recovery could not complete' });
          }
        }
        if (d.classification === 'recoverable' && d.recovery && !recoveries.includes(`${stepId}:${d.id}`)) {
          recoveries.push(`${stepId}:${d.id}`);
          logger.log('detector.recovering', { detector: d.id, action: d.recovery.action });
          if (d.recovery.action === 'click' && d.recovery.target) {
            // Recovery actions come from config, not the reviewed step list —
            // pass an explicit risk so they go through the policy gate like
            // any other state-touching click instead of riding a silent default.
            surface.setStep?.(stepId);
            if (artifact.app.appId === 'meridian') {
              try {
                if (!surface.recoverClick) throw new Error('Guarded recovery is unavailable');
                await surface.recoverClick(d.recovery.target);
              } catch (err) {
                if (err instanceof RunAbortedError) return aborted(stepId);
                return fail({ code: 'RECOVERY_FAILED', stepId, intent: 'recover from runtime condition', expected: 'an allowed nonmutation recovery', observed: 'Guarded recovery could not complete' });
              }
            } else await surface.click(d.recovery.target, undefined, 'reversible_write');
          }
          // Recovery is bounded to one attempt: re-check only THIS detector's
          // own match, not the whole list. Still present -> fatal, not a loop.
          if (await matchDetector(surface, d)) {
            const shot = await logger.screenshot(surface, `fatal-${d.id}`);
            return await failOrEscalate({
              stepId,
              intent: 'recover from runtime condition',
              expected: `detector "${d.id}" cleared after recovery`,
              observed: `${d.id}: ${d.description} still present after recovery action`,
              screenshot: shot,
            });
          }
          continue; // recovery cleared it: re-check the full list for another condition
        }
        if (artifact.schemaVersion === 2 && d.classification === 'fatal') return fail({ code: d.outcomeCode ?? d.id.toUpperCase(), stepId, intent: 'check runtime conditions', expected: 'valid authorized session', observed: d.description });
        // Fatal, or a recoverable that already failed recovery once.
        const shot = await logger.screenshot(surface, `fatal-${d.id}`);
        return await failOrEscalate(
          { stepId, intent: 'pass runtime-condition checks', expected: 'no fatal condition', observed: `${d.id}: ${d.description}`, screenshot: shot },
        );
      } catch (err) {
        if (err instanceof RunAbortedError) return aborted(stepId);
        const message = err instanceof Error ? err.message : String(err);
        return await failOrEscalate({
          stepId,
          intent: 'recover from runtime condition',
          expected: 'detector checks and recovery actions to run without error',
          observed: message,
        });
      }
    }
    return null;
  }

  // Hard failure path — in attended mode, hand the live session to a human first.
  async function failOrEscalate(failure: StepFailure): Promise<ReplayResult> {
    if (surface.mutationDispatched || !deps.escalate) return fail(failure);
    logger.log('escalation.raised', { stepId: failure.stepId, reason: failure.observed });
    const decision = await deps.escalate({
      kind: 'replay_stuck',
      capability: `${artifact.id}@${artifact.version}`,
      goal: artifact.description,
      stepId: failure.stepId,
      reason: `${failure.intent}: expected ${failure.expected}, observed ${failure.observed}`,
      screenshot: failure.screenshot,
      url: surface.currentUrl(),
    });
    logger.log('escalation.decision', { decision });
    if (decision === 'abort') return fail(failure, true);
    if (decision === 'retry') {
      // Terminal-phase failures ("(success-condition)", "(outputs)") have no
      // artifact step to re-run — the caller re-verifies after the sentinel.
      const step = stepsById.get(failure.stepId);
      if (!step) return CONTINUE_SENTINEL;
      const retry = await runStep(step, true);
      if (retry) return retry;
      return CONTINUE_SENTINEL;
    }
    return artifact.schemaVersion === 2 ? fail({ ...failure, observed: 'Unchecked skip is not permitted' }, true) : CONTINUE_SENTINEL;
  }

  // Sentinel letting failOrEscalate signal "carry on with the next step".
  const CONTINUE_SENTINEL = Symbol('continue') as unknown as ReplayResult;
  const stepsById = new Map(artifact.steps.map((s) => [s.id, s]));

  // Native dialogs the surface dismissed, with the step they fired on.
  const dialogsSeen: Array<{ stepId: string; type: string; message: string }> = [];
  function noteDialogs(stepId: string) {
    const dialogs = surface.drainDialogs?.() ?? [];
    if (!dialogs.length) return;
    logger.log('dialog.unexpected', { stepId, dialogs, dismissed: true });
    dialogsSeen.push(...dialogs.map((d) => ({ stepId, ...d })));
  }

  async function verifyAssertion(a: Assertion, timeoutMs = 5000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    do {
      const ok =
        a.kind === 'urlMatches'
          ? new RegExp(resolveTemplateForRegex(a.pattern, params)).test(surface.currentUrl())
          : await surface.isTextVisible(resolveTemplate(a.text, params), a.frame);
      if (ok) return true;
      await new Promise((r) => setTimeout(r, 250));
    } while (Date.now() < deadline);
    return false;
  }

  // Returns null on success, a terminal result otherwise.
  async function runStep(step: Step, isRetry = false): Promise<ReplayResult | null> {
    const started = Date.now();
    surface.setStep?.(step.id);
    // Recorded descriptors are parameterized (e.g. a link named "{{memberId}}");
    // bind them to this invocation's params before resolving.
    const target = step.target && resolveTarget(step.target, params);
    try {
      switch (step.action) {
        case 'navigate':
          await surface.navigate(resolveTemplate(step.url!, params));
          break;
        case 'click': {
          const report = await surface.click(target!, step.timeoutMs, step.risk);
          logger.log('step.resolution', { stepId: step.id, resolution: report });
          break;
        }
        case 'fill': {
          const report = await surface.fill(target!, resolveTemplate(step.value!, params), step.timeoutMs, step.risk);
          logger.log('step.resolution', { stepId: step.id, resolution: report });
          break;
        }
        case 'select': {
          const report = await surface.select(target!, resolveTemplate(step.value!, params), step.timeoutMs, step.risk, step.selectBy);
          logger.log('step.resolution', { stepId: step.id, resolution: report });
          break;
        }
        case 'extract': {
          if (step.extract?.columns) {
            if (!surface.readTable) throw new Error('Table extraction unavailable');
            outputs[step.extract.output] = await surface.readTable(target!, step.extract.columns, step.timeoutMs, step.extract.rowSelector);
            logger.log('step.extracted', { stepId: step.id, output: step.extract.output });
            break;
          }
          const { text, report } = await surface.readText(target!, step.timeoutMs);
          const pattern = step.extract!.pattern === undefined ? undefined : resolveTemplateForRegex(step.extract!.pattern, params);
          const value = extractText(text, pattern);
          const output = artifact.outputs.find(o => o.name === step.extract!.output);
          if (output?.type === 'number') {
            if (!value.trim()) throw new Error('Numeric extraction requires nonempty text');
            const number = Number(value);
            if (!Number.isFinite(number)) throw new Error('Numeric extraction requires a finite number');
            outputs[step.extract!.output] = number;
          } else {
            outputs[step.extract!.output] = value;
          }
          logger.log('step.extracted', { stepId: step.id, output: step.extract!.output, value, resolution: report });
          break;
        }
        case 'assert': {
          if (!(await verifyAssertion(step.assert!, step.timeoutMs))) {
            throw new CheckpointError(step.assert!);
          }
          break;
        }
      }
      noteDialogs(step.id);
      logger.log('step.ok', { stepId: step.id, action: step.action, ms: Date.now() - started, isRetry });
      return null;
    } catch (err) {
      if (surface.mutationDispatched) return fail({ stepId: step.id, intent: step.intent, expected: 'verified posting completion', observed: 'POST_OUTCOME_UNKNOWN' });
      if (err instanceof InsufficientFundsError) {
        const result: ReplayResult = {
          status: 'business_outcome', outcomeCode: err.outcomeCode, detail: err.message, ...base,
        };
        logger.log('replay.business_outcome', { stepId: step.id, code: err.outcomeCode });
        logger.writeResult(result);
        return result;
      }
      if (err instanceof RunAbortedError) return aborted(step.id);
      noteDialogs(step.id);
      // The dialog that explains this failure often fired on an EARLIER step
      // that "succeeded" (the click happened; the navigation it should have
      // caused was cancelled). Name the most recent one.
      const dialog = dialogsSeen.at(-1);
      // A step failure is often *explained* by a runtime condition that
      // appeared mid-flight — check before declaring the step itself broken.
      const recoveriesBefore = recoveries.length;
      const strictRecoveriesBefore = strictRecoveryCount;
      const conditionResult = await handleConditions(step.id, false);
      if (conditionResult === CONTINUE_SENTINEL) return null;
      if (conditionResult) return conditionResult;
      // A recovery ran and cleared the condition that (most likely) broke this
      // step — re-run it once. Bounded: the retry's own failure is terminal.
      // Never auto-retry an irreversible step: its first attempt may have landed.
      if (recoveries.length > recoveriesBefore && strictRecoveryCount === strictRecoveriesBefore
        && !isRetry && (surface.effectiveRisk ?? step.risk) !== 'irreversible') return runStep(step, true);

      const shot = await logger.screenshot(surface, `failed-${step.id}`);
      const failure: StepFailure = {
        stepId: step.id,
        intent: step.intent,
        expected: describeExpectation(step),
        observed:
          (dialog ? `unexpected ${dialog.type} dialog "${dialog.message}" was dismissed at ${dialog.stepId}; then ` : '') +
          (err instanceof Error ? err.message : String(err)),
        screenshot: shot,
      };
      if (isRetry || err instanceof PolicyViolationError) return fail(failure, isRetry);
      const r = await failOrEscalate(failure);
      return r === CONTINUE_SENTINEL ? null : r;
    }
  }

  for (const step of artifact.steps) {
    surface.setStep?.(step.id);
    logger.log('step.start', { stepId: step.id, action: step.action, intent: step.intent, risk: step.risk });
    const conditionResult = await handleConditions(step.id);
    if (conditionResult === CONTINUE_SENTINEL) continue; // escalation path already executed/skipped this step
    if (conditionResult) return conditionResult;
    const result = await runStep(step);
    if (result) return result;
  }

  // Final checkpoint: never assume the flow worked — verify it. Route through
  // failOrEscalate so attended mode gets a chance to fix the end state before
  // this replay is declared broken (unattended behavior is unchanged, since
  // failOrEscalate falls back to a hard fail when no escalate handler exists).
  if (!(await verifyAssertion(artifact.successCondition))) {
    const shot = await logger.screenshot(surface, 'success-condition-failed');
    const r = await failOrEscalate({
      stepId: '(success-condition)',
      intent: 'verify the capability reached its declared end state',
      expected: JSON.stringify(artifact.successCondition),
      observed: `url=${surface.currentUrl()}`,
      screenshot: shot,
    });
    if (r !== CONTINUE_SENTINEL) return r;
    // Human intervened: re-verify once, don't loop.
    if (!(await verifyAssertion(artifact.successCondition))) {
      return fail({
        stepId: '(success-condition)',
        intent: 'verify the capability reached its declared end state',
        expected: JSON.stringify(artifact.successCondition),
        observed: `url=${surface.currentUrl()} (still failing after intervention)`,
      });
    }
  }

  // Type-check declared outputs were all produced.
  for (const o of artifact.outputs) {
    if (!Object.hasOwn(outputs, o.name)) {
      const r = await failOrEscalate({
        stepId: '(outputs)',
        intent: 'produce declared outputs',
        expected: `output "${o.name}"`,
        observed: `only [${Object.keys(outputs).join(', ')}]`,
      });
      if (r !== CONTINUE_SENTINEL) return r;
      // A human cannot type an output into the caller's result — re-run the
      // extract step that declares this output, then require it to exist.
      const extractStep = artifact.steps.find((s) => s.extract?.output === o.name);
      if (extractStep) {
        const rerun = await runStep(extractStep, true);
        if (rerun) return rerun; // terminal outcome from the re-run wins
      }
      if (!Object.hasOwn(outputs, o.name)) {
        return fail({
          stepId: '(outputs)',
          intent: 'produce declared outputs',
          expected: `output "${o.name}"`,
          observed: `only [${Object.keys(outputs).join(', ')}] (still missing after intervention)`,
        });
      }
    }
  }

  for (const output of artifact.outputs) {
    if (artifact.schemaVersion === 2 && !validOutput(output, outputs[output.name])) return fail({ stepId: '(outputs)', intent: 'validate output types', expected: output.type, observed: 'Output does not satisfy its declared contract' });
  }
  if (transfer) {
    try { assertTransferOutputs(transfer, outputs); }
    catch { return fail({ stepId: '(outputs)', intent: 'verify transfer completion details', expected: 'current transfer details matching the request', observed: 'Output does not satisfy its declared contract' }); }
  }
  if (requiresFreshCompletion) {
    if (!deps.validateCompletion) return fail({ stepId: '(outputs)', intent: 'verify completion details', expected: 'a fresh member-record read-back validator', observed: 'completion validator became unavailable' });
    try { await deps.validateCompletion(outputs); }
    catch { return fail({ stepId: '(outputs)', intent: 'verify completion details', expected: 'fresh member state matching the request', observed: 'Output does not match fresh member state' }); }
  }
  const shot = await logger.screenshot(surface, 'success');
  logger.log('replay.success', { outputs, screenshot: shot });
  const result: ReplayResult = { status: 'success', outputs, ...base };
  logger.writeResult(result);
  return result;
}

class CheckpointError extends Error {
  constructor(assertion: Assertion) {
    super(`Checkpoint not satisfied: ${JSON.stringify(assertion)}`);
  }
}

function describeExpectation(step: Step): string {
  switch (step.action) {
    case 'navigate': return `navigation to ${step.url}`;
    case 'assert': return `checkpoint ${JSON.stringify(step.assert)}`;
    case 'extract': return `readable text at "${step.target?.description}"`;
    default: return `actionable "${step.target?.description}"`;
  }
}
