import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CapabilityArtifact, validateParams, normalizeParams } from '../artifact/schema.js';
import { makeLLMClient } from '../agent/client.js';
import { runDiscovery } from '../agent/loop.js';
import { recordArtifact } from '../artifact/recorder.js';
import { toToolSchema } from '../artifact/tools.js';
import { OperatorConsole } from '../escalation/operator.js';
import { ControlSession } from '../escalation/session.js';
import { postIntentUnknown, type ReplayResult } from '../replay/outcomes.js';
import { applyMeridianContract, meridianContracts, assertTransferOutputs, transferFactsFromParams } from '../runtime/contracts.js';
import { Approval, publicIntervention } from '../runtime/approval.js';
import { RequestError, type JournalRecord, type RunJournal } from '../runtime/journal.js';
import { type AppProfile } from '../runtime/profile.js';
import { closeRuntime, createRuntime, executeReplay, operatorContext } from '../runtime/run.js';
import { Redactor } from '../safety/redact.js';
import type { Policy } from '../safety/policy.js';
import { safeResult as persistedResult, type RecordedStructure } from '../evidence/safe-event.js';
import { canAccessRun, principalKey, principalRole, type Principal } from './auth.js';
import { MERIDIAN_CAPABILITIES, type MeridianCapabilityId } from './capability-labels.js';

const discoveryGoals = {
  'meridian-funds-transfer': 'Transfer amount from sourceShare to destinationShare for member with memo. Verify the native review facts before final posting and extract the verified confirmation and transaction.',
  'meridian-update-member': 'Update member contact details to email, phone and address. Verify the native review facts before saving and extract the verified saved result.',
  'meridian-place-hold': 'As SUPERVISOR, place a hold on share for member using reason and notes. Verify the native review facts before applying the hold and extract the verified heldShare.',
} as const;
const operationIds = ['meridian-funds-transfer', 'meridian-open-share', 'meridian-update-member', 'meridian-place-hold'] as const;

export type { Principal } from './auth.js';
export type CapabilityAvailability = {
  id: MeridianCapabilityId;
  label: string;
  state: 'available' | 'not_recorded' | 'restricted' | 'temporarily_unavailable';
  reason: string;
};
export type MemberIdentity =
  | { status: 'pending' | 'unavailable'; inquiryRunId?: string }
  | { status: 'verified'; inquiryRunId?: string; memberNumber: string; name: string };
export type RequestContext = { accepted: true } | { runId: string; capability: string; state: string };
export class InvocationRejected extends RequestError {
  readonly acceptance = 'rejected' as const;
}
export class InvocationService {
  readonly artifacts = new Map<string, CapabilityArtifact>();
  readonly live = new Map<string, { state: string; inputs: Record<string, string | number>; memberIdentity?: MemberIdentity; step?: string; started: number; finished?: number; result?: ReplayResult; approval: Approval; redactor?: Redactor; close?: () => Promise<void> }>();
  private active?: string;
  private closing = false;
  private admission: Promise<void> = Promise.resolve();
  private readonly completions = new Set<Promise<void>>();
  private readonly completionByRun = new Map<string, Promise<void>>();
  private readonly identityCompletions = new Set<Promise<void>>();
  private cleanupFailed = false;
  private readonly readProjections = {
    chat: new Set<string>(), availability: new Set<string>(), history: new Set<string>(),
  };
  constructor(readonly journal: RunJournal, readonly policy: Policy, readonly profile: AppProfile,
    readonly evidenceDir: string, private readonly allowlist: string[], private readonly artifactDir = 'artifacts') {
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
    return [...this.artifacts.values()].filter(a => principalRole(principal) === 'operator' || this.allowlist.includes(a.id))
      .map(a => ({ id: a.id, version: a.version, description: a.description, parameters: a.parameters.filter(p => p.source !== 'server'), outputs: a.outputs, tools: toToolSchema(a) }));
  }
  operationContracts() {
    return this.profile.appId === 'meridian' ? operationIds.map(id => ({ id, parameters: meridianContracts[id].parameters,
      discovery: Object.hasOwn(discoveryGoals, id) })) : [];
  }
  private isPrivateRecord(record: Pick<JournalRecord, 'capability' | 'invocationScope'>): boolean {
    return record.invocationScope === 'member-identity'
      || (record.invocationScope === undefined && this.profile.appId === 'meridian' && record.capability === 'meridian-member-inquiry');
  }
  private projectMemberIdentity(principal: Principal, identity: MemberIdentity | undefined): MemberIdentity {
    const current = identity ?? { status: 'unavailable' as const };
    if (principalRole(principal) === 'operator') return current;
    if (current.status === 'verified') return { status: current.status, memberNumber: current.memberNumber, name: current.name };
    return { status: current.status };
  }
  private async persistState(runId: string, state: 'success' | 'business_outcome' | 'failure' | 'POST_OUTCOME_UNKNOWN') {
    try { await this.journal.update(runId, state); } catch { /* Preserve the original run outcome and let the journal fail closed. */ }
  }
  async availability(principal: Principal): Promise<CapabilityAvailability[]> {
    if (this.profile.appId !== 'meridian') return [];
    return this.withReadProjection(principal, async () => {
      const candidates = MERIDIAN_CAPABILITIES.filter(([id]) => this.artifacts.has(id)
        && (principalRole(principal) === 'operator' || this.allowlist.includes(id))).map(([id]) => id);
      let unknown: Set<string> | undefined;
      if (!this.closing && !this.cleanupFailed && !this.active && candidates.length) {
        try { unknown = await this.journal.unknownCapabilities(candidates); } catch { /* Project storage failure below. */ }
      }
      return MERIDIAN_CAPABILITIES.map(([id, label]) => {
        const authorized = principalRole(principal) === 'operator' || this.allowlist.includes(id);
        if (!authorized) return { id, label, state: 'restricted' as const, reason: 'Not authorized for this caller' };
        const artifact = this.artifacts.get(id);
        if (!artifact) return { id, label, state: 'not_recorded' as const, reason: 'No approved recording' };
        if (this.closing) return { id, label, state: 'temporarily_unavailable' as const, reason: 'Server is shutting down' };
        if (this.cleanupFailed) return { id, label, state: 'temporarily_unavailable' as const, reason: 'Runtime cleanup failed; operator recovery is required' };
        if (this.active) return { id, label, state: 'temporarily_unavailable' as const, reason: 'Another operation is active' };
        if (!unknown) {
          return { id, label, state: 'temporarily_unavailable' as const, reason: 'Run journal is unavailable' };
        }
        if (unknown.has(id)) return { id, label, state: 'temporarily_unavailable' as const, reason: 'Outcome requires read-only investigation' };
        return { id, label, state: 'available' as const, reason: 'Approved recording is ready' };
      });
    }, 'availability');
  }
  private async withReadProjection<T>(principal: Principal, work: () => Promise<T>, kind: 'chat' | 'availability' | 'history' = 'chat'): Promise<T> {
    const owner = principalKey(principal);
    const pending = this.readProjections[kind];
    if (pending.has(owner) || pending.size >= 4) throw new RequestError(429, 'Run projection is busy');
    pending.add(owner);
    try { return await work(); }
    finally { pending.delete(owner); }
  }
  async requestContexts(principal: Principal, keys: readonly string[]) {
    return this.withReadProjection(principal, async () => {
      const records = await this.journal.findRequests(principalKey(principal), keys);
      const contexts = new Map<string, RequestContext>();
      for (const [key, record] of records) {
        if (record.caller !== principalKey(principal)) continue;
        if (this.isPrivateRecord(record)) {
          contexts.set(key, { accepted: true });
          continue;
        }
        const run = this.projectRun(principal, record);
        contexts.set(key, { runId: run.runId, capability: run.capability, state: run.state });
      }
      return contexts;
    });
  }
  private async withAdmission<T>(work: () => Promise<T>): Promise<T> {
    const prior = this.admission;
    let release!: () => void;
    this.admission = new Promise<void>(resolve => { release = resolve; });
    await prior;
    try { return await work(); }
    finally { release(); }
  }
  private async lookupInvocation(owner: string, key: string, request: unknown, privateInvocation: boolean) {
    try {
      return await this.journal.lookup(owner, key, request);
    } catch (error) {
      if (!privateInvocation && error instanceof RequestError && error.status === 409) {
        const existing = await this.journal.findRequest(owner, key);
        if (existing && this.isPrivateRecord(existing)) throw new RequestError(404, 'No accepted request found');
      }
      throw error;
    }
  }
  private async withInvocationAdmission<T>(principal: Principal, key: string, lookupOnly: boolean, work: (admission: { attempted: boolean }) => Promise<T>) {
    return this.withAdmission(async () => {
      const admission = { attempted: false };
      try { return await work(admission); }
      catch (error) {
        if (!lookupOnly && !admission.attempted && error instanceof RequestError
          && [400, 403, 404, 409, 429].includes(error.status)) {
          let confirmedMissing = false;
          try { confirmedMissing = !await this.journal.findRequest(principalKey(principal), key); }
          catch { /* A failed journal check cannot prove non-acceptance. */ }
          if (confirmedMissing) throw new InvocationRejected(error.status, error.message);
        }
        throw error;
      }
    });
  }
  async invoke(principal: Principal, id: string, args: Record<string, string | number>, key: string, role: 'TELLER' | 'SUPERVISOR' = 'TELLER', lookupOnly = false) {
    return this.withInvocationAdmission(principal, key, lookupOnly, admission => this.invokeRun(principal, id, args, key, role, false, lookupOnly, admission));
  }
  private async invokeInternal(principal: Principal, id: string, args: Record<string, string | number>, key: string, role: 'TELLER' | 'SUPERVISOR') {
    return this.withAdmission(() => this.invokeRun(principal, id, args, key, role, true));
  }
  private async invokeRun(principal: Principal, id: string, args: Record<string, string | number>, key: string,
    role: 'TELLER' | 'SUPERVISOR', privateInvocation: boolean, lookupOnly = false, admission?: { attempted: boolean }) {
    if (principalRole(principal) !== 'operator' && (role !== 'TELLER' || !this.allowlist.includes(id))) throw new RequestError(403, 'Capability or operator context is not authorized');
    const owner = principalKey(principal);
    const recoveryRequest = { capability: id, args, role };
    if (lookupOnly && !privateInvocation) {
      const recovery = await this.journal.recover(owner, key, recoveryRequest);
      const existing = recovery.existing;
      if (!existing || this.isPrivateRecord(existing)) throw new RequestError(404, 'No accepted request found');
      if (existing.kind !== 'replay' || existing.capability !== id) throw new RequestError(409, 'Idempotency key already identifies another request');
      if (existing.recoveryRequest !== undefined) {
        if (!recovery.direct || !recovery.matches) throw new RequestError(409, 'Idempotency key already identifies another request');
        return { runId: existing.runId, reused: true as const };
      }
      // Legacy records without a recovery digest retain the current-artifact exact lookup below.
    }
    const artifact = this.artifacts.get(id);
    if (!artifact) {
      const prior = await this.journal.findRequest(owner, key);
      if (prior && prior.kind !== 'replay') throw new RequestError(409, 'Idempotency key already identifies another request');
      throw new RequestError(404, 'Unknown approved capability');
    }
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
    const { existing, identity } = await this.lookupInvocation(owner, key, request, privateInvocation);
    if (existing) {
      if (!privateInvocation && this.isPrivateRecord(existing)) throw new RequestError(404, 'No accepted request found');
      if (privateInvocation && existing.invocationScope !== 'member-identity') throw new RequestError(409, 'Member identity inquiry is unavailable');
      if (existing.kind !== 'replay' || existing.identity !== identity) throw new RequestError(409, 'Idempotency key already identifies another request');
      return { runId: existing.runId, reused: true as const };
    }
    if (lookupOnly) throw new RequestError(404, 'No accepted request found');
    if (this.closing) throw new RequestError(503, 'Server is shutting down');
    if (this.cleanupFailed) throw new RequestError(503, 'Runtime cleanup failed; operator recovery is required');
    // ponytail: capability-wide unknown block; narrower scope needs an explicit reconciliation contract.
    // Terminal same-key lookups above remain readable across all entry points.
    if (await this.journal.hasUnknown(id))
      throw new RequestError(409, 'This capability has an unknown posting outcome. Use a separate read-only inquiry; do not retry it.');
    if (this.active) throw new RequestError(429, 'One run is active; retry with the same idempotency key');
    if (admission) admission.attempted = true;
    const record = await this.journal.reserve(owner, key, id, artifact.version, request, 'replay', {
      invocationScope: privateInvocation ? 'member-identity' : 'public',
      ...(privateInvocation ? {} : { recoveryRequest }),
    });
    if (!privateInvocation && this.isPrivateRecord(record)) throw new RequestError(404, 'No accepted request found');
    if (privateInvocation && record.invocationScope !== 'member-identity') throw new RequestError(409, 'Member identity inquiry is unavailable');
    this.active = record.runId;
    const session = new ControlSession();
    const approval = new Approval(session, () => {
      const live = this.live.get(record.runId);
      if (live) live.state = approval.pending ? 'awaiting-human' : 'running';
    }, Date.now() + 600_000);
    const state = { state: 'running', inputs: normalized, started: Date.now(), approval } as NonNullable<ReturnType<typeof this.live.get>>;
    this.live.set(record.runId, state);
    const finish = () => { state.finished = Date.now(); this.active = undefined; };
    let intentRequested = false;
    try {
      const runtime = createRuntime({ kind: 'replay', artifact: id, version: artifact.version, policy: this.policy,
        profile: this.profile, params, sensitive: artifact.parameters.filter(p => p.sensitive).map(p => p.name), operator: context,
        headful: true, runId: record.runId, evidenceDir: this.evidenceDir, session,
        gate: async (action, risk, reason, actionContext) => {
          const pending = approval.wait({ kind: 'risk_approval', capability: id, goal: artifact.description, reason, url: runtime.surface.currentUrl() }, actionContext);
          const approvalId = approval.pending?.id;
          runtime.logger.log('intervention.pending', { kind: 'risk_approval', approvalId, expiresAt: approval.pending?.expiresAt });
          const decision = await pending;
          runtime.logger.log('intervention.decided', { approvalId, decision });
          return decision === 'approve';
        },
        beforeDispatch: async () => { intentRequested = true; await this.journal.update(record.runId, 'dispatching'); },
        assertDispatchAllowed: () => this.journal.assertHealthy(), onClose: () => approval.cancel(),
        onEvent: (event) => {
          if (event === 'step.start') state.step = runtime.surface.currentStep;
          if (event === 'action.start') state.step = runtime.surface.currentStep;
          if (event === 'detector.recovering') state.state = 'recovering';
          if (event === 'step.ok') state.state = 'running';
        },
      });
      state.redactor = runtime.promptRedactor;
      state.close = async () => { await closeRuntime(runtime); if (runtime.cleanupFailed) this.cleanupFailed = true; };
      await this.journal.update(record.runId, 'running');
      const completion = executeReplay(artifact, params, runtime, this.policy, async req => {
        const detach = await new OperatorConsole(runtime.browser.page, runtime.logger, session).recordHumanActions();
        try {
          const decision = await approval.wait(req);
          return decision === 'retry' ? 'retry' : 'abort';
        } finally { await detach(); }
      }).then(async result => {
        const secrets = new Redactor();
        if (context) secrets.addSensitiveValues([context.password]);
        const uncertain = runtime.surface.mutationDispatched || intentRequested;
        const outcome = uncertain ? postIntentUnknown(result) : result;
        state.result = secrets.redact(outcome);
        if (outcome !== result) {
          try { runtime.logger.writeResult(outcome); } catch { /* preserve the caller-visible quarantine state */ }
        }
        state.state = outcome.status === 'failure' && uncertain ? 'POST_OUTCOME_UNKNOWN' : outcome.status;
        await this.persistState(record.runId, state.state as 'success' | 'business_outcome' | 'failure' | 'POST_OUTCOME_UNKNOWN');
      }).catch(async () => {
        state.state = runtime.surface.mutationDispatched || intentRequested ? 'POST_OUTCOME_UNKNOWN' : 'failure';
        await this.persistState(record.runId, state.state as 'failure' | 'POST_OUTCOME_UNKNOWN');
      }).finally(() => { if (runtime.cleanupFailed) this.cleanupFailed = true; finish(); });
      this.trackCompletion(record.runId, completion);
      if (this.profile.appId === 'meridian' && id === 'meridian-member-record') {
        state.memberIdentity = { status: 'pending' };
        // Only this fresh balance request can start its linked approved read. Status and key reuse cannot.
        const identityCompletion = completion.then(async () => {
          let inquiryRunId: string | undefined;
          try {
            const member = state.inputs.member;
            if (this.closing || state.state !== 'success' || typeof member !== 'string' || !member.trim()) return;
            const inquiry = await this.invokeInternal(principal, 'meridian-member-inquiry',
              { searchMode: 'number', searchValue: member }, `member-identity:${record.runId}`, role);
            inquiryRunId = inquiry.runId;
            state.memberIdentity = { status: 'pending', inquiryRunId };
            await this.completionByRun.get(inquiryRunId);
            const lookup = this.live.get(inquiryRunId);
            const rows = lookup?.result?.status === 'success' ? lookup.result.outputs.members : undefined;
            const row = Array.isArray(rows) && rows.length === 1 ? rows[0] : undefined;
            const inquiryRecord = await this.journal.get(inquiryRunId);
            if (inquiryRecord?.invocationScope === 'member-identity' && !inquiry.reused && inquiryRecord.caller === record.caller
              && lookup?.state === 'success' && lookup.inputs.searchMode === 'number' && lookup.inputs.searchValue === member
              && row && typeof row === 'object' && row.memberNumber === member && typeof row.name === 'string' && row.name.trim()) {
              state.memberIdentity = { status: 'verified', inquiryRunId, memberNumber: member, name: row.name };
            }
          } catch { /* Preserve the successful balance even if its identity read is unavailable. */ }
          finally {
            if (state.memberIdentity?.status === 'pending') state.memberIdentity = { status: 'unavailable', inquiryRunId };
          }
        });
        this.identityCompletions.add(identityCompletion);
        void identityCompletion.then(() => this.identityCompletions.delete(identityCompletion), () => this.identityCompletions.delete(identityCompletion));
      }
    } catch (error) {
      approval.cancel();
      state.state = intentRequested ? 'POST_OUTCOME_UNKNOWN' : 'failure';
      await this.persistState(record.runId, state.state as 'failure' | 'POST_OUTCOME_UNKNOWN');
      if (state.close) await state.close();
      finish();
      throw error;
    }
    return { runId: record.runId };
  }
  private trackCompletion(runId: string, completion: Promise<void>) {
    this.completions.add(completion);
    this.completionByRun.set(runId, completion);
    const forget = () => {
      this.completions.delete(completion);
      if (this.completionByRun.get(runId) === completion) this.completionByRun.delete(runId);
    };
    void completion.then(forget, forget);
  }
  async discover(principal: Principal, id: string, args: Record<string, string | number>, key: string,
    role: 'TELLER' | 'SUPERVISOR' = 'TELLER', lookupOnly = false) {
    return this.withInvocationAdmission(principal, key, lookupOnly, async admission => {
      if (principalRole(principal) !== 'operator') throw new RequestError(403, 'Only operators can start discovery');
      if (this.profile.appId !== 'meridian' || !Object.hasOwn(discoveryGoals, id)) throw new RequestError(404, 'Unknown discovery capability');
      if (id === 'meridian-place-hold' && role !== 'SUPERVISOR') throw new RequestError(403, 'Hold discovery requires SUPERVISOR');
      const capability = id as keyof typeof discoveryGoals;
      const contract = meridianContracts[capability];
      if (!validateParams(contract, args).ok) throw new RequestError(400, 'Parameters do not match the capability contract');
      const normalized = normalizeParams(contract, args);
      const owner = principalKey(principal);
      const recoveryRequest = { mode: 'discovery', capability: id, args: normalized, role };
      const recovery = await this.journal.recover(owner, key, recoveryRequest);
      if (recovery.existing && (recovery.existing.kind !== 'discovery' || recovery.existing.capability !== id
        || recovery.existing.caller !== owner || !recovery.direct || !recovery.matches)) throw new RequestError(409, 'Idempotency key already identifies another request');
      if (lookupOnly) {
        if (!recovery.existing) throw new RequestError(404, 'No accepted request found');
        return { runId: recovery.existing.runId, reused: true as const };
      }
      const context = operatorContext(role);
      const goal = discoveryGoals[capability];
      const version = '1.0.0';
      const request = { mode: 'discovery', capability: id, version, goalRevision: 1, args: normalized,
        context: { operator: context.operator, branch: context.branch, role } };
      const { existing, identity } = await this.journal.lookup(owner, key, request);
      if (existing) {
        if (existing.kind !== 'discovery' || existing.identity !== identity) throw new RequestError(409, 'Idempotency key already identifies another request');
        return { runId: existing.runId, reused: true as const };
      }
      if (this.closing) throw new RequestError(503, 'Server is shutting down');
      if (this.cleanupFailed) throw new RequestError(503, 'Runtime cleanup failed; operator recovery is required');
      if (await this.journal.hasUnknown(id)) throw new RequestError(409, 'This capability has an unknown posting outcome. Use a separate read-only inquiry; do not retry it.');
      if (this.active) throw new RequestError(429, 'One run is active; retry with the same idempotency key');
      if (this.artifacts.has(id)) throw new RequestError(409, 'An approved recording already exists');
      if (!this.profile.entryUrl) throw new RequestError(503, 'Discovery entry is not configured');
      const { openai, model } = makeLLMClient();
      admission.attempted = true;
      const record = await this.journal.reserve(owner, key, id, version, request, 'discovery', { invocationScope: 'public', recoveryRequest });
      this.active = record.runId;
      const session = new ControlSession();
      const approval = new Approval(session, () => {
        const live = this.live.get(record.runId);
        if (live) live.state = approval.pending ? 'awaiting-human' : 'running';
      }, Date.now() + 600_000);
      const state = { state: 'running', inputs: normalized, started: Date.now(), approval } as NonNullable<ReturnType<typeof this.live.get>>;
      this.live.set(record.runId, state);
      let runtime: ReturnType<typeof createRuntime> | undefined;
      let intentRequested = false;
      const serverParams = ['operator', 'password', 'branch'];
      const params = { ...normalized, operator: '{{operator}}', password: '{{password}}', branch: '{{branch}}' };
      const sensitive = [...contract.parameters.filter(p => p.sensitive).map(p => p.name), 'password'];
      const finish = () => { state.finished = Date.now(); this.active = undefined; };
      try {
        runtime = createRuntime({ kind: 'discovery', artifact: id, version, policy: this.policy, profile: this.profile,
          params: { ...normalized, operator: context.operator, password: context.password, branch: context.branch }, sensitive, operator: context,
          headful: true, runId: record.runId, evidenceDir: this.evidenceDir, session,
          gate: async (_action, _risk, reason, actionContext) => {
            const pending = approval.wait({ kind: 'risk_approval', capability: id, goal, reason, url: runtime!.surface.currentUrl() }, actionContext);
            const approvalId = approval.pending?.id;
            runtime!.logger.log('intervention.pending', { kind: 'risk_approval', approvalId, expiresAt: approval.pending?.expiresAt });
            const decision = await pending;
            runtime!.logger.log('intervention.decided', { approvalId, decision });
            return decision === 'approve';
          },
          beforeDispatch: async () => { intentRequested = true; await this.journal.update(record.runId, 'dispatching'); },
          assertDispatchAllowed: () => this.journal.assertHealthy(), onClose: () => approval.cancel(),
          onEvent: event => {
            if (event === 'action.start' || event === 'step.start') state.step = runtime!.surface.currentStep;
            if (event === 'detector.recovering') state.state = 'recovering';
            if (event === 'step.ok') state.state = 'running';
          },
        });
        const running = runtime;
        state.redactor = running.promptRedactor;
        state.close = async () => { await closeRuntime(running); if (running.cleanupFailed) this.cleanupFailed = true; };
        await this.journal.update(record.runId, 'running');
        const recordingGoal = `${goal}\nRecord explicit fill operator, fill password, and select branch actions using server references before Sign On, even if the selected branch already matches. Add assertions and extract these required outputs: ${contract.outputs.join(', ')}. Table outputs must use named columns. ${id === 'meridian-funds-transfer' ? 'The transaction output must declare exactly one row with canonical columns member, sourceShare, destinationShare, amount, memo, confirmation; use type money only for amount and type string for the other columns, and mark every output and column sensitive. Observe each column selector and header handling from this recording; do not invent them.' : ''} Never choose the first of ambiguous matches.`;
        const expectedTransfer = id === 'meridian-funds-transfer' ? transferFactsFromParams(normalized) : undefined;
        const completion = (async () => {
          const metadata = { runId: record.runId, evidenceDir: running.logger.dir, recoveries: [] as string[] };
          const failure = (): ReplayResult => ({ ...metadata, status: 'failure', escalated: false,
            failure: { code: 'DISCOVERY_FAILED', stepId: '(discovery)', intent: goal, expected: 'Verified recording', observed: 'Discovery recording failed' } });
          let outcome: ReplayResult;
          try {
            const result = await runDiscovery(recordingGoal, this.profile.entryUrl!, params, this.policy.allowedOrigins, {
              surface: running.surface, logger: running.logger, openai, model, maxSteps: this.policy.maxSteps,
              timeoutMs: this.policy.maxDiscoveryMs, detectors: this.profile.detectors,
              boundParams: { operator: context.operator, password: context.password, branch: context.branch },
              sanitizeObservation: text => running.promptRedactor.redactString(text),
              validateCompletion: expectedTransfer ? outputs => assertTransferOutputs(expectedTransfer, outputs) : running.validateCompletion,
              escalate: async req => {
                const detach = await new OperatorConsole(running.browser.page, running.logger, session).recordHumanActions();
                try { return await approval.wait(req) === 'retry' ? 'retry' : 'abort'; }
                finally { await detach(); }
              },
            });
            if (result.status === 'success') {
              const candidate = recordArtifact({ name: id, description: goal, goal, entryUrl: this.profile.entryUrl!, params,
                sensitiveParams: sensitive, serverParams, allowedOrigins: this.policy.allowedOrigins, appId: this.profile.appId,
                appDetectors: this.profile.detectors, model, discoveryRunId: record.runId }, result);
              const artifact = CapabilityArtifact.parse(applyMeridianContract(candidate));
              if (artifact.status !== 'draft' || artifact.id !== id || artifact.name !== id || artifact.version !== version
                || artifact.app.appId !== this.profile.appId || artifact.provenance.discoveryRunId !== record.runId
                || artifact.provenance.model !== model) throw new Error('Unexpected discovery metadata');
              // Recorder/server metadata and validated contract names are structure, not observed PII.
              // Scan every recorded text surface; native unrelated PII remains in the mask set.
              const privacy = new Redactor();
              privacy.addSensitiveValues([...running.redactor.maskValues(), ...Object.values(normalized), context.operator, context.password, context.branch]);
              const assertionText = (assertion: CapabilityArtifact['successCondition'] | undefined) => assertion?.kind === 'urlMatches'
                ? [assertion.pattern] : assertion ? [assertion.text, assertion.frame] : [];
              const recordedText = [
                ...assertionText(artifact.successCondition),
                ...artifact.outputs.flatMap(output => output.columns?.map(column => column.selector) ?? []),
                ...artifact.steps.flatMap(step => [step.intent, step.url, step.value, ...assertionText(step.assert),
                  step.target?.description, step.target?.frame, ...Object.values(step.target?.snapshot ?? {}),
                  ...(step.target?.strategies.flatMap(({ kind: _kind, ...strategy }) => Object.values(strategy)) ?? []),
                  step.extract?.pattern, step.extract?.rowSelector, ...(step.extract?.columns?.map(column => column.selector) ?? []),
                ]),
              ];
              const names = new Set(artifact.parameters.map(parameter => parameter.name));
              for (const text of recordedText) if (typeof text === 'string') {
                const literal = text.replace(/\{\{(\w+)\}\}/g, (token, name: string) => {
                  if (!names.has(name)) throw new Error('Undeclared recording parameter');
                  return '';
                });
                if (privacy.redactString(literal) !== literal) throw new Error('Recording privacy validation failed');
              }
              const drafts = join(this.artifactDir, 'drafts');
              mkdirSync(drafts, { recursive: true, mode: 0o700 });
              writeFileSync(join(drafts, `${record.runId}.json`), JSON.stringify(artifact, null, 2), { flag: 'wx', mode: 0o600 });
              const secrets = new Redactor();
              secrets.addSensitiveValues([context.password]);
              outcome = { ...metadata, status: 'success', outputs: secrets.redact(result.outputs) };
            } else {
              const safe = persistedResult(result);
              outcome = safe.status === 'business_outcome' ? { ...metadata, status: 'business_outcome', outcomeCode: safe.outcomeCode, detail: 'Operation ended without posting.' } : failure();
            }
          } catch { outcome = failure(); }
          if (intentRequested || running.surface.mutationDispatched) outcome = postIntentUnknown(outcome);
          state.result = outcome;
          state.state = outcome.status === 'failure' && outcome.failure.code === 'POST_OUTCOME_UNKNOWN' ? 'POST_OUTCOME_UNKNOWN' : outcome.status;
          try { running.logger.writeResult(outcome); } catch { /* Preserve the journal outcome. */ }
          await this.persistState(record.runId, state.state as 'success' | 'business_outcome' | 'failure' | 'POST_OUTCOME_UNKNOWN');
        })().finally(async () => { approval.cancel(); await state.close!(); finish(); });
        this.trackCompletion(record.runId, completion);
      } catch (error) {
        approval.cancel();
        state.state = intentRequested || runtime?.surface.mutationDispatched ? 'POST_OUTCOME_UNKNOWN' : 'failure';
        await this.persistState(record.runId, state.state as 'failure' | 'POST_OUTCOME_UNKNOWN');
        if (state.close) await state.close();
        finish();
        throw error;
      }
      return { runId: record.runId };
    });
  }
  async get(principal: Principal, runId: string) {
    const record = await this.journal.get(runId);
    if (!record) throw new RequestError(404, 'Unknown run');
    try { return this.projectRun(principal, record); }
    catch (error) {
      if (error instanceof RequestError && error.status === 403) throw new RequestError(404, 'Unknown run');
      throw error;
    }
  }
  async getOwnedMany(principal: Principal, runIds: readonly string[]) {
    const records = await this.journal.getMany(runIds);
    const owner = principalKey(principal);
    return new Map([...new Set(runIds)].map(runId => {
      const record = records.get(runId);
      if (!record || record.caller !== owner) throw new RequestError(404, 'Unknown run');
      try { return [runId, this.projectRun(principal, record)] as const; }
      catch (error) {
        if (error instanceof RequestError && (error.status === 403 || error.status === 404)) {
          throw new RequestError(404, 'Unknown run');
        }
        throw error;
      }
    }));
  }
  private projectRun(principal: Principal, record: JournalRecord) {
    const runId = record.runId;
    if (!canAccessRun(principal, record.caller)) throw new RequestError(403, 'Run belongs to another principal');
    const privateRun = this.isPrivateRecord(record);
    if (privateRun && principalRole(principal) !== 'operator') throw new RequestError(404, 'Unknown run');
    const live = this.live.get(runId);
    const dir = join(this.evidenceDir, runId);
    const evidence = privateRun ? [] : existsSync(dir) ? readdirSync(dir).filter(f => /^[a-zA-Z0-9._-]+\.(png|json|jsonl)$/.test(f)) : [];
    let historyResult;
    let structure: RecordedStructure | undefined;
    if (!privateRun && !live && existsSync(join(dir, 'result.json'))) {
      try {
        const saved = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
        historyResult = this.profile.appId === 'meridian' ? persistedResult(saved) : saved;
        if (this.profile.appId === 'meridian' && historyResult.structure?.capability === record.capability) structure = historyResult.structure;
        if (this.profile.appId === 'meridian') historyResult = { ...historyResult, structure };
      } catch { historyResult = undefined; }
    }
    const result = live?.result;
    const privateResult = result ? persistedResult(result) : historyResult;
    const withoutPrivateStructure = (value: typeof privateResult) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
      const { structure: _structure, ...rest } = value as Record<string, unknown>;
      return rest;
    };
    const unknownResult = { status: 'failure' as const, failure: {
      stepId: '(post-dispatch)', code: 'POST_OUTCOME_UNKNOWN',
      detail: 'Posting may have occurred. Investigate with a separate read-only inquiry; do not retry.',
    } };
    const safeResult = record.state === 'POST_OUTCOME_UNKNOWN' ? unknownResult
      : privateRun ? withoutPrivateStructure(privateResult)
      : result ? result.status === 'success' ? { status: result.status, outputs: result.outputs } : result.status === 'business_outcome' ? { status: result.status, outcomeCode: result.outcomeCode, detail: result.detail } : { status: 'failure', failure: { stepId: result.failure.stepId, code: result.failure.code ?? 'RUN_FAILED', detail: result.failure.code === 'POST_OUTCOME_UNKNOWN' ? 'Posting may have occurred. Investigate with a separate read-only inquiry; do not retry.' : 'Run stopped. Inspect the current step and safe evidence.' } } : historyResult;
    const intervention = privateRun
      ? principalRole(principal) === 'operator' && live?.approval.pending ? {
          id: live.approval.pending.id,
          expiresAt: live.approval.pending.expiresAt,
          request: {
            kind: live.approval.pending.request.kind,
            capability: record.capability,
            goal: 'Complete the linked identity check.',
            reason: 'Linked identity check needs operator attention.',
            url: '(unavailable)',
          },
        } : undefined
      : principalRole(principal) === 'operator' ? (live?.approval.pending ? publicIntervention(live.approval.pending, live.redactor) : undefined) : live?.approval.pending ? { kind: live.approval.pending.request.kind, awaitingOperator: true } : undefined;
    return { runId, kind: record.kind, inputs: privateRun ? undefined : live?.inputs, capability: record.capability, version: record.version, createdAt: record.createdAt,
      state: ['reserved', 'running', 'dispatching'].includes(record.state) ? live?.state ?? record.state : record.state, step: privateRun ? undefined : live?.step, elapsedMs: live ? (live.finished ?? Date.now()) - live.started : undefined,
      finishedAt: live?.finished ? new Date(live.finished).toISOString() : undefined,
      intervention,
      result: safeResult, structure: privateRun ? undefined : structure, sensitiveValuesUnavailable: !live || privateRun, evidence,
      memberIdentity: record.capability === 'meridian-member-record' ? this.projectMemberIdentity(principal, live?.memberIdentity) : undefined };
  }
  async history(principal: Principal) {
    return this.withReadProjection(principal, async () => {
      const operator = principalRole(principal) === 'operator';
      const actionableRunIds: string[] = [];
      if (operator) for (const [id, live] of this.live) if (live.approval.pending) actionableRunIds.push(id);
      const records = await this.journal.recent(principalKey(principal), {
        legacyOperator: principal === 'operator',
        legacyPrivateCapability: this.profile.appId === 'meridian' ? 'meridian-member-inquiry' : undefined,
        actionableRunIds,
      });
      const projected = records.map(record => this.projectRun(principal, record));
      return projected.filter((run, index) => !this.isPrivateRecord(records[index]!) || Boolean(run.intervention));
    }, 'history');
  }
  async decide(principal: Principal, runId: string, id: string, decision: 'approve' | 'retry' | 'abort') {
    if (principalRole(principal) !== 'operator') throw new RequestError(403, 'Only operators can decide interventions');
    await this.get(principal, runId);
    const record = await this.journal.get(runId);
    if (typeof principal !== 'string' && record?.caller === principalKey(principal) && decision === 'approve')
      throw new RequestError(403, 'A run cannot be approved by the principal that requested it');
    if (record && this.isPrivateRecord(record) && decision === 'approve') throw new RequestError(409, 'Private identity inquiry approval is unavailable');
    const live = this.live.get(runId);
    if (!live) throw new RequestError(409, 'Run has no live intervention');
    live.approval.decide(id, decision);
  }
  get cleanupFailedState() { return this.cleanupFailed; }
  async close() {
    this.closing = true;
    // Cancel approvals before waiting for the admission tail so a setup that
    // is currently awaiting a human decision can finish and close its runtime.
    for (const live of this.live.values()) live.approval.cancel();
    await this.admission;
    await Promise.all([...this.live.values()].map(live => live.close?.()));
    await Promise.all([...this.completions]);
    await Promise.resolve();
    await Promise.all([...this.identityCompletions]);
  }
}
