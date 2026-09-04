import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CapabilityArtifact, validateParams, normalizeParams } from '../artifact/schema.js';
import { toToolSchema } from '../artifact/tools.js';
import { OperatorConsole } from '../escalation/operator.js';
import { ControlSession } from '../escalation/session.js';
import type { ReplayResult } from '../replay/outcomes.js';
import { applyMeridianContract } from '../runtime/contracts.js';
import { Approval } from '../runtime/approval.js';
import { Journal, RequestError } from '../runtime/journal.js';
import { type AppProfile } from '../runtime/profile.js';
import { createRuntime, executeReplay, operatorContext } from '../runtime/run.js';
import { Redactor } from '../safety/redact.js';
import type { Policy } from '../safety/policy.js';

export type Principal = 'caller' | 'operator';
export class InvocationService {
  readonly artifacts = new Map<string, CapabilityArtifact>();
  readonly live = new Map<string, { state: string; inputs: Record<string, string | number>; step?: string; started: number; finished?: number; result?: ReplayResult; approval: Approval; close?: () => Promise<void> }>();
  private active?: string;
  private completion?: Promise<void>;
  constructor(readonly journal: Journal, readonly policy: Policy, readonly profile: AppProfile,
    readonly evidenceDir: string, private readonly allowlist: string[], artifactDir = 'artifacts') {
    for (const file of readdirSync(artifactDir).filter(f => f.endsWith('.json'))) {
      let artifact = CapabilityArtifact.parse(JSON.parse(readFileSync(join(artifactDir, file), 'utf8')));
      if (artifact.app.appId !== profile.appId || artifact.status !== 'approved') continue;
      if (profile.appId === 'meridian') artifact = applyMeridianContract(artifact);
      if (this.artifacts.has(artifact.id)) throw new Error('Configure one pinned version per capability');
      if (!/^[a-z][a-z0-9-]*$/.test(artifact.id)) throw new Error('Unsafe capability ID');
      this.artifacts.set(artifact.id, artifact);
    }
  }
  catalog(principal: Principal) {
    return [...this.artifacts.values()].filter(a => principal === 'operator' || this.allowlist.includes(a.id))
      .map(a => ({ id: a.id, version: a.version, description: a.description, parameters: a.parameters.filter(p => p.source !== 'server'), outputs: a.outputs, tools: toToolSchema(a) }));
  }
  invoke(principal: Principal, id: string, args: Record<string, string | number>, key: string, role: 'TELLER' | 'SUPERVISOR' = 'TELLER') {
    if (principal !== 'operator' && (role !== 'TELLER' || !this.allowlist.includes(id))) throw new RequestError(403, 'Capability or operator context is not authorized');
    const artifact = this.artifacts.get(id);
    if (!artifact) throw new RequestError(404, 'Unknown approved capability');
    const context = this.profile.appId === 'meridian' ? operatorContext(role) : undefined;
    const publicArtifact = { ...artifact, parameters: artifact.parameters.filter(p => p.source !== 'server') };
    const publicDefaults = Object.fromEntries(Object.entries(artifact.paramDefaults ?? {}).filter(([name]) => publicArtifact.parameters.some(p => p.name === name)));
    const check = validateParams(publicArtifact, { ...publicDefaults, ...args });
    if (!check.ok) throw new RequestError(400, check.error.replace(/got .*$/, 'invalid value'));
    const normalized = normalizeParams({ ...publicArtifact, paramDefaults: publicDefaults }, args);
    const params = { ...normalized };
    for (const parameter of artifact.parameters.filter(p => p.source === 'server')) {
      if (!context || !['operator', 'password', 'branch'].includes(parameter.name)) throw new RequestError(400, 'Unsupported server parameter');
      params[parameter.name] = context[parameter.name as 'operator' | 'password' | 'branch'];
    }
    // Secrets are excluded from identity. The configured operator/branch/role are included.
    const request = { mode: 'replay', capability: id, version: artifact.version, args: normalized, context: context ? { operator: context.operator, branch: context.branch, role } : null };
    const { existing } = this.journal.lookup(principal, key, request);
    if (existing) return { runId: existing.runId };
    if (this.active) throw new RequestError(429, 'One run is active; retry with the same idempotency key');
    const record = this.journal.reserve(principal, key, id, artifact.version, request);
    this.active = record.runId;
    const session = new ControlSession();
    const approval = new Approval(session, () => {
      const live = this.live.get(record.runId);
      if (live) live.state = approval.pending ? 'awaiting-human' : 'running';
    }, Date.now() + 600_000);
    const state = { state: 'running', inputs: normalized, started: Date.now(), approval } as NonNullable<ReturnType<typeof this.live.get>>;
    this.live.set(record.runId, state);
    const runtime = createRuntime({ kind: 'replay', artifact: id, version: artifact.version, policy: this.policy,
      profile: this.profile, params, sensitive: artifact.parameters.filter(p => p.sensitive).map(p => p.name), operator: context,
      headful: true, runId: record.runId, evidenceDir: this.evidenceDir, session,
      gate: async (action, risk, reason, actionContext) => {
        const pending = approval.wait({ kind: 'risk_approval', capability: id, goal: artifact.description, reason, url: runtime.surface.currentUrl() }, actionContext);
        runtime.logger.log('intervention.pending', { kind: 'risk_approval', approvalId: approval.pending?.id, expiresAt: approval.pending?.expiresAt });
        const decision = await pending;
        runtime.logger.log('intervention.decided', { decision });
        return decision === 'approve';
      },
      beforeDispatch: () => this.journal.update(record.runId, 'dispatching'), onClose: () => approval.cancel(),
      onEvent: (event) => {
        if (event === 'action.start') state.step = runtime.surface.currentStep;
        if (event === 'detector.recovering') state.state = 'recovering';
        if (event === 'step.ok') state.state = 'running';
      },
    });
    state.close = runtime.close;
    this.journal.update(record.runId, 'running');
    this.completion = executeReplay(artifact, params, runtime, this.policy, async req => {
      const detach = await new OperatorConsole(runtime.browser.page, runtime.logger, session).recordHumanActions();
      try {
        const decision = await approval.wait(req);
        return decision === 'retry' ? 'retry' : 'abort';
      } finally { await detach(); }
    }).then(result => {
      const secrets = new Redactor();
      if (context) secrets.addSensitiveValues([context.password]);
      state.result = secrets.redact(result);
      state.state = result.status === 'failure' && runtime.surface.mutationDispatched ? 'POST_OUTCOME_UNKNOWN' : result.status;
      this.journal.update(record.runId, state.state as 'success' | 'business_outcome' | 'failure' | 'POST_OUTCOME_UNKNOWN');
    }).catch(() => {
      state.state = runtime.surface.mutationDispatched ? 'POST_OUTCOME_UNKNOWN' : 'failure';
      this.journal.update(record.runId, state.state as 'failure' | 'POST_OUTCOME_UNKNOWN');
    }).finally(() => { state.finished = Date.now(); this.active = undefined; });
    return { runId: record.runId };
  }
  get(principal: Principal, runId: string) {
    const record = this.journal.records.get(runId);
    if (!record) throw new RequestError(404, 'Unknown run');
    if (principal !== 'operator' && record.caller !== principal) throw new RequestError(403, 'Run belongs to another principal');
    const live = this.live.get(runId);
    const dir = join(this.evidenceDir, runId);
    const evidence = existsSync(dir) ? readdirSync(dir).filter(f => /^[a-zA-Z0-9._-]+\.(png|json|jsonl)$/.test(f)) : [];
    const historyResult = !live && existsSync(join(dir, 'result.json')) ? JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) : undefined;
    const result = live?.result;
    const safeResult = result ? result.status === 'success' ? { status: result.status, outputs: result.outputs } : result.status === 'business_outcome' ? { status: result.status, outcomeCode: result.outcomeCode, detail: result.detail } : { status: 'failure', failure: { stepId: result.failure.stepId, code: result.failure.code ?? 'RUN_FAILED', detail: result.failure.code === 'POST_OUTCOME_UNKNOWN' ? 'Posting may have occurred. Investigate with a separate read-only inquiry; do not retry.' : 'Run stopped. Inspect the current step and safe evidence.' } } : historyResult;
    return { runId, kind: record.kind, inputs: live?.inputs, capability: record.capability, version: record.version, createdAt: record.createdAt,
      state: ['reserved', 'running', 'dispatching'].includes(record.state) ? live?.state ?? record.state : record.state, step: live?.step, elapsedMs: live ? (live.finished ?? Date.now()) - live.started : undefined,
      intervention: principal === 'operator' ? live?.approval.pending : live?.approval.pending ? { kind: live.approval.pending.request.kind, awaitingOperator: true } : undefined,
      result: safeResult, sensitiveValuesUnavailable: !live, evidence };
  }
  history(principal: Principal) { return [...this.journal.records.values()].filter(r => principal === 'operator' || r.caller === principal).map(r => this.get(principal, r.runId)); }
  decide(principal: Principal, runId: string, id: string, decision: 'approve' | 'retry' | 'abort') {
    if (principal !== 'operator') throw new RequestError(403, 'Only operators can decide interventions');
    this.get(principal, runId);
    const live = this.live.get(runId);
    if (!live) throw new RequestError(409, 'Run has no live intervention');
    live.approval.decide(id, decision);
  }
  async close() {
    for (const live of this.live.values()) { live.approval.cancel(); await live.close?.(); }
    await this.completion;
  }
}
