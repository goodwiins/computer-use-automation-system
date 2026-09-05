import type { CapabilityArtifact } from '../artifact/schema.js';
import { ControlSession, type InterventionDecision, type InterventionRequest } from '../escalation/session.js';
import { RunLogger } from '../evidence/logger.js';
import { runReplay } from '../replay/executor.js';
import type { Policy } from '../safety/policy.js';
import { Redactor } from '../safety/redact.js';
import { BrowserSurface } from '../surface/browser.js';
import { GuardedSurface, type HumanGate } from '../surface/guarded.js';
import { holdFactsFromParams, memberUpdateFactsFromParams, meridianMemberContactTable, meridianTransferMemberTable, openShareFactsFromParams, transferFactsFromParams } from './contracts.js';
import type { ActionContext } from './approval.js';
import type { AppProfile, FaultScenario } from './profile.js';

export interface OperatorContext { operator: string; password: string; branch: string; role: 'TELLER' | 'SUPERVISOR' }
export function operatorContext(role: 'TELLER' | 'SUPERVISOR'): OperatorContext {
  const prefix = `MERIDIAN_${role}`;
  const operator = process.env[`${prefix}_OPERATOR`];
  const password = process.env[`${prefix}_PASSWORD`];
  const branch = process.env.MERIDIAN_BRANCH;
  if (!operator || !password || !branch) throw new Error(`${prefix}_OPERATOR, ${prefix}_PASSWORD and MERIDIAN_BRANCH are required`);
  return { operator, password, branch, role };
}

export function createRuntime(options: {
  kind: 'replay' | 'discovery'; artifact: string; version: string; policy: Policy;
  fault?: FaultScenario; profile?: AppProfile; params: Record<string, string | number>; sensitive: string[];
  operator?: OperatorContext; headful?: boolean; runId?: string; evidenceDir?: string;
  session?: ControlSession; gate: HumanGate; beforeDispatch?: (context: ActionContext) => void;
  onEvent?: (event: string, data: Record<string, unknown>) => void; onClose?: () => void;
}) {
  const strict = options.profile?.appId === 'meridian';
  const transfer = strict ? transferFactsFromParams(options.params) : undefined;
  const openShare = strict && options.artifact === 'meridian-open-share' ? openShareFactsFromParams(options.params) : undefined;
  const memberUpdate = strict && options.artifact === 'meridian-update-member' ? memberUpdateFactsFromParams(options.params) : undefined;
  const hold = strict && options.artifact === 'meridian-place-hold' ? holdFactsFromParams(options.params) : undefined;
  if (strict && options.artifact === 'meridian-funds-transfer' && !transfer) throw new Error('Canonical funds transfer requires a complete transfer request');
  if (strict && options.artifact === 'meridian-open-share' && !openShare) throw new Error('Canonical open share requires a complete request');
  if (strict && options.artifact === 'meridian-update-member' && !memberUpdate) throw new Error('Canonical member update requires a complete request');
  if (strict && options.artifact === 'meridian-place-hold' && !hold) throw new Error('Canonical hold requires a complete request');
  const redactor = new Redactor();
  const promptRedactor = new Redactor();
  if (options.operator) promptRedactor.addSensitiveValues([options.operator.password]);
  redactor.addSensitiveValues(options.sensitive.flatMap(k => options.params[k] !== undefined ? [options.params[k]!] : []));
  if (options.operator) redactor.addSensitiveValues([options.operator.password]);
  const logger = new RunLogger(options.kind, redactor, options.evidenceDir, strict, options.runId, options.onEvent);
  const session = options.session ?? new ControlSession(t => logger.log('control.transfer', t));
  const deadline = Date.now() + 600_000;
  const browser = new BrowserSurface({ headful: options.headful, fault: options.fault, allowedOrigins: options.policy.allowedOrigins, onClose: options.onClose,
    ...(strict ? { profile: options.profile, sensitive: (values: string[], secrets: string[] = []) => { redactor.addSensitiveValues(values); promptRedactor.addSensitiveValues(secrets); } } : {}) });
  const surface = new GuardedSurface(browser, options.policy, options.gate, e => logger.log('policy.decision', e),
    strict ? { profile: options.profile!, session, deadline, runId: logger.runId, artifact: options.artifact, version: options.version,
      operator: options.operator!.operator, role: options.operator!.role, branch: options.operator!.branch,
      transfer: transfer ? { expected: transfer, memberTable: meridianTransferMemberTable } : undefined,
      openShare: openShare ? { expected: openShare, memberTable: meridianTransferMemberTable } : undefined,
      memberUpdate: memberUpdate ? { expected: memberUpdate, contactTable: meridianMemberContactTable } : undefined,
      hold: hold ? { expected: hold, memberTable: meridianTransferMemberTable, contactTable: meridianMemberContactTable } : undefined,
      beforeDispatch: context => { if (!options.beforeDispatch) throw new Error('Durable dispatch journal required'); options.beforeDispatch(context); },
    } : undefined, (event, data) => logger.log(event, data));
  let timer: ReturnType<typeof setTimeout>;
  const runtime = { surface, browser, logger, session, redactor, promptRedactor, deadline,
    validateCompletion: openShare ? surface.validateOpenShareCompletion.bind(surface)
      : memberUpdate ? surface.validateMemberUpdateCompletion.bind(surface)
        : hold ? surface.validateHoldCompletion.bind(surface) : undefined,
    close: async () => { clearTimeout(timer); try { options.onClose?.(); } finally { await surface.close(); } } };
  timer = setTimeout(() => { void closeRuntime(runtime); }, 600_000);
  timer.unref();
  return runtime;
}

export async function executeReplay(artifact: CapabilityArtifact, params: Record<string, string | number>,
  runtime: ReturnType<typeof createRuntime>, policy: Policy,
  escalate?: (request: InterventionRequest) => Promise<InterventionDecision>) {
  try { return await runReplay(artifact, params, { surface: runtime.surface, logger: runtime.logger, policy, escalate, validateCompletion: runtime.validateCompletion }); }
  finally { await closeRuntime(runtime); }
}

export async function closeRuntime(runtime: ReturnType<typeof createRuntime>) {
  try { await runtime.close(); }
  catch {
    // Cleanup and its diagnostics must not replace a verified result or the original error.
    try { runtime.logger.log('evidence.warning', { code: 'RUNTIME_CLEANUP_FAILED' }); } catch { /* evidence unavailable */ }
  }
}
