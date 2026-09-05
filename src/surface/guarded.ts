import { RISK_RANK, riskFloorFor } from '../artifact/recorder.js';
import { classify, type AppProfile, type FrameContext, type LiveControl } from '../runtime/profile.js';
import { assertTransferEligibility, assertTransferFacts, meridianContracts, type TransferFacts, type TransferShare } from '../runtime/contracts.js';
import type { ActionContext } from '../runtime/approval.js';
import type { ControlSession } from '../escalation/session.js';
// Policy enforcement as a Surface decorator. Every actor — the LLM during
// discovery, the deterministic replayer, a future caller — goes through the
// same gate, so no code path can act outside the allowlist.

import { moneyCents, RiskClass, type TargetDescriptor, type TableColumn } from '../artifact/schema.js';
import { checkAction, originAllowed, type Policy, type PolicyVerdict } from '../safety/policy.js';
import type { Observation, ResolutionReport, Surface } from './types.js';

const DEFAULT_TIMEOUT = 10_000;
const TRANSFER_ROUTE = /^\/members\/(\d+)\/transfer(?:\/(review|post))?$/;
const MEMBER_ROUTE = /^\/members\/(\d+)$/;
const MERIDIAN_MUTATION_ROUTES: Partial<Record<keyof typeof meridianContracts, RegExp>> = {
  'meridian-funds-transfer': /^\/members\/\d+\/transfer\/post$/,
  'meridian-open-share': /^\/members\/\d+\/open-share\/post$/,
  'meridian-update-member': /^\/members\/\d+\/update$/,
  'meridian-place-hold': /^\/members\/\d+\/hold\/post$/,
};
const REVIEW_FACTS = {
  member: 'review:Member:',
  sourceShare: 'review:From:',
  destinationShare: 'review:To:',
  amount: 'review:Amount:',
  memo: 'review:Memo:',
} as const;
const DISPLAY_MONEY = /^(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})*)\.\d{2}$/;
const DISPLAY_SHARE = /^([0-9]{1,12}-[A-Za-z0-9-]+) \(\$((?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})*)\.\d{2})\)$/;
const DISPLAY_MEMBER = /^([0-9]{1,12}) - (.+)$/;

function transferReviewFailed(): never {
  throw new Error('Transfer review facts are missing or ambiguous');
}

function parseDisplayMoney(value: string): string {
  const match = /^\$([\s\S]+)$/.exec(value.trim());
  if (!match || !DISPLAY_MONEY.test(match[1]!)) return transferReviewFailed();
  const canonical = match[1]!.replaceAll(',', '');
  try { moneyCents(canonical); } catch { return transferReviewFailed(); }
  return canonical;
}

function parseDisplayMember(value: string, expected: string): string {
  const match = DISPLAY_MEMBER.exec(value.trim());
  if (!match || match[1] !== expected || !match[2]!.trim()) return transferReviewFailed();
  return match[1]!;
}

function parseDisplayShare(value: string, expected: string): string {
  const match = DISPLAY_SHARE.exec(value.trim());
  if (!match || match[1] !== expected) return transferReviewFailed();
  try { moneyCents(match[2]!.replaceAll(',', '')); } catch { return transferReviewFailed(); }
  return match[1]!;
}

type TransferBinding = {
  expected: TransferFacts;
  memberTable: { target: TargetDescriptor; columns: TableColumn[]; rowSelector?: string };
};
type TransferStage = 'member' | 'transfer' | 'review';
type TransferEligibility = { member: string; shares: TransferShare[]; frame: FrameContext; stage: TransferStage };

export class PolicyViolationError extends Error {
  constructor(public readonly verdict: Exclude<PolicyVerdict, { verdict: 'allow' }>, action: string) {
    super(`Policy ${verdict.verdict === 'deny' ? 'denied' : 'requires human for'} "${action}": ${verdict.reason}`);
  }
}

export class RunAbortedError extends PolicyViolationError {
  constructor(action: string) { super({ verdict: 'deny', reason: 'Submission aborted by operator' }, action); }
}

/** Called when an action needs a human (confirm/escalate). Return true to proceed. */
export type HumanGate = (action: string, risk: RiskClass, reason: string, context?: ActionContext) => Promise<boolean>;

export class GuardedSurface implements Surface {
  mutationDispatched = false;
  effectiveRisk: RiskClass = 'read';
  private stepId = '(start)';
  private attempt = 0;
  private started = false;
  private signOnSubmitted = false;
  private transferEligibility?: TransferEligibility;
  get currentStep() { return this.stepId; }
  setStep(id: string) { this.stepId = id; }

  constructor(
    private readonly inner: Surface,
    private readonly policy: Policy,
    private readonly humanGate: HumanGate,
    private readonly onDecision?: (event: {
      action: string;
      url: string;
      risk: RiskClass;
      verdict: PolicyVerdict['verdict'];
      reason?: string;
    }) => void,
    private readonly runtime?: {
      profile: AppProfile; session: ControlSession; deadline: number;
      runId: string; artifact: string; version: string; operator: string; branch: string; role: string;
      beforeDispatch: (context: ActionContext) => void;
      transfer?: TransferBinding;
    },
    private readonly onAction?: (event: string, data: Record<string, unknown>) => void,
  ) {}

  private emit(event: string, data: Record<string, unknown> = {}) {
    this.onAction?.(event, { stepId: this.stepId, attempt: this.attempt, ...data });
  }

  private async action<T>(action: string, risk: RiskClass, execute: () => Promise<T>): Promise<T> {
    RiskClass.parse(risk);
    this.attempt++;
    this.effectiveRisk = risk;
    const started = performance.now();
    this.emit('action.start', { action, requestedRisk: risk });
    try {
      const result = await execute();
      this.emit('action.end', { action, effectiveRisk: this.effectiveRisk, status: 'success', ms: performance.now() - started });
      return result;
    } catch (error) {
      this.emit('action.end', { action, effectiveRisk: this.effectiveRisk, status: 'failure', ms: performance.now() - started });
      throw error;
    }
  }

  private assertAutomation() {
    if (this.runtime?.session.currentOwner === 'human') throw new Error('Human owns this session');
    if (this.runtime && Date.now() >= this.runtime.deadline) throw new Error('Run deadline expired');
    if (this.runtime && this.signOnSubmitted && new URL(this.inner.currentUrl()).pathname === '/signon') throw new Error('Session ended; start a new invocation');
  }

  private path(url: string): string {
    try { return new URL(url, this.policy.allowedOrigins[0]).pathname; } catch { return ''; }
  }

  private transferRoute(url: string) {
    return TRANSFER_ROUTE.exec(this.path(url));
  }

  private assertCapabilityOperation(destination: string): void {
    const artifact = this.runtime?.artifact;
    if (!artifact || this.runtime?.profile.appId !== 'meridian' || !Object.hasOwn(meridianContracts, artifact)) return;
    const allowed = MERIDIAN_MUTATION_ROUTES[artifact as keyof typeof meridianContracts];
    if (allowed?.test(this.path(destination))) return;
    if (artifact === 'meridian-funds-transfer') throw new Error('Funds-transfer run cannot dispatch another operation');
    throw new Error('Canonical MERIDIAN capability cannot dispatch this operation');
  }

  private transferStage(url: string): { member: string; stage: TransferStage } | undefined {
    const member = MEMBER_ROUTE.exec(this.path(url));
    if (member) return { member: member[1]!, stage: 'member' };
    const transfer = this.transferRoute(url);
    if (!transfer || transfer[2] === 'post') return undefined;
    return { member: transfer[1]!, stage: transfer[2] === 'review' ? 'review' : 'transfer' };
  }

  private sameFrame(left: FrameContext | undefined, right: FrameContext | undefined): boolean {
    return !!left && !!right && left.id === right.id && left.name === right.name;
  }

  private sameFrameRevision(left: FrameContext | undefined, right: FrameContext | undefined): boolean {
    return this.sameFrame(left, right) && left!.navigation === right!.navigation && left!.url === right!.url;
  }

  private currentTransferFrame(): FrameContext {
    const frame = this.inner.currentFrame?.();
    if (!frame) throw new Error('Transfer frame identity is unavailable');
    return frame;
  }

  private transferFrameFailed(): never {
    this.transferEligibility = undefined;
    throw new Error('Transfer frame is no longer bound to this run');
  }

  private requireTransferRoute(url: string): void {
    const route = this.transferStage(url);
    if (!route || this.runtime?.profile.appId !== 'meridian') return;
    const binding = this.runtime.transfer;
    if (!binding) throw new Error('Transfer parameters are not bound');
    if (route.member !== binding.expected.member) return this.transferFrameFailed();
    if (this.mutationDispatched) {
      this.transferEligibility = undefined;
      return;
    }
    const state = this.transferEligibility;
    if (!state || state.member !== binding.expected.member || state.stage !== route.stage) throw new Error('Transfer eligibility has not been verified for this run');
    const current = this.currentTransferFrame();
    if (!this.sameFrameRevision(current, state.frame) || this.path(current.url) !== this.path(url)) return this.transferFrameFailed();
  }

  private preserveTransferState(url: string): void {
    if (this.runtime?.profile.appId !== 'meridian' || !this.runtime.transfer) return;
    const route = this.transferStage(url);
    if (!route || route.member !== this.runtime.transfer.expected.member) {
      this.transferEligibility = undefined;
      return;
    }
    if (!this.transferEligibility && route.stage === 'member') return;
    this.requireTransferRoute(url);
  }

  private advanceTransferState(url: string, expectedFrame?: FrameContext): void {
    const binding = this.runtime?.transfer;
    const route = this.transferStage(url);
    if (!binding || !route || route.member !== binding.expected.member) return this.transferFrameFailed();
    const state = this.transferEligibility;
    if (!state) {
      if (route.stage === 'member') return;
      return this.transferFrameFailed();
    }
    if (expectedFrame && !this.sameFrameRevision(expectedFrame, state.frame)) return this.transferFrameFailed();
    const current = this.currentTransferFrame();
    if (this.path(current.url) !== this.path(url) || !this.sameFrame(current, state.frame)) return this.transferFrameFailed();
    const validTransition = state.stage === route.stage
      || (state.stage === 'member' && route.stage === 'transfer')
      || (state.stage === 'transfer' && route.stage === 'review');
    if (!validTransition || (state.stage !== route.stage && current.navigation === state.frame.navigation)) return this.transferFrameFailed();
    state.frame = current;
    state.stage = route.stage;
  }

  private async captureTransferEligibility(memberPath: string, timeoutMs: number): Promise<void> {
    const binding = this.runtime?.transfer;
    const member = MEMBER_ROUTE.exec(this.path(memberPath));
    if (!binding || !member || member[1] !== binding.expected.member) throw new Error('Transfer member selection is not eligible');
    if (!this.inner.readTable) throw new Error('Member eligibility table is unavailable');
    const before = this.currentTransferFrame();
    if (this.path(before.url) !== this.path(memberPath)) return this.transferFrameFailed();
    const target = { ...binding.memberTable.target, frame: before.name };
    // Eligibility is part of the member-selection click. Keep the extract
    // policy and bounds checks, but avoid readTable()'s public action wrapper:
    // nesting it here would reuse this.attempt and corrupt click evidence.
    this.preserveTransferState(this.inner.currentUrl());
    await this.gate('extract', 'read');
    this.assertStillInBounds('extract');
    const rows = await this.inner.readTable(target, binding.memberTable.columns, timeoutMs, binding.memberTable.rowSelector);
    this.assertStillInBounds('extract');
    this.preserveTransferState(this.inner.currentUrl());
    const resolved = this.inner.lastResolvedFrame?.();
    const after = this.currentTransferFrame();
    if (!resolved || !this.sameFrameRevision(before, resolved) || !this.sameFrameRevision(before, after) || this.path(resolved.url) !== this.path(memberPath)) return this.transferFrameFailed();
    const shares = rows.map(row => {
      if (typeof row.shareId !== 'string' || typeof row.status !== 'string' || typeof row.balance !== 'string') throw new Error('Member eligibility table is incomplete');
      return { share: row.shareId, status: row.status, balance: row.balance };
    });
    assertTransferEligibility(binding.expected, member[1]!, shares);
    this.transferEligibility = { member: member[1]!, shares, frame: resolved, stage: 'member' };
  }

  private assertTransferControl(live: LiveControl): void {
    const binding = this.runtime?.transfer;
    const route = this.transferStage(live.url);
    if (!binding || !route || route.member !== binding.expected.member || !live.frame) return this.transferFrameFailed();
    const current = this.currentTransferFrame();
    if (!this.sameFrameRevision(live.frame, current) || this.path(live.frame.url) !== this.path(live.url) || this.path(current.url) !== this.path(live.url)) return this.transferFrameFailed();
    const state = this.transferEligibility;
    if (!state) {
      const destination = this.transferStage(live.destination);
      if (route.stage === 'member' && (!destination || destination.stage === 'member')) return;
      return this.transferFrameFailed();
    }
    if (state.stage !== route.stage || !this.sameFrameRevision(state.frame, live.frame)) return this.transferFrameFailed();
  }

  private assertTransferReview(live: LiveControl): void {
    const binding = this.runtime?.transfer;
    const member = TRANSFER_ROUTE.exec(this.path(live.destination))?.[1];
    if (!binding || !member || member !== binding.expected.member || TRANSFER_ROUTE.exec(this.path(live.destination))?.[2] !== 'post' || this.transferStage(live.url)?.stage !== 'review') throw new Error('Transfer review is not bound to the requested member');
    this.assertTransferControl(live);
    const fact = (name: string) => {
      const value = live.facts[name];
      if (typeof value !== 'string') throw new Error('Transfer review facts are missing or ambiguous');
      return value;
    };
    assertTransferFacts(binding.expected, {
      member: fact('member'), sourceShare: fact('from'), destinationShare: fact('to'), amount: fact('amount'), memo: fact('memo'),
    });
    assertTransferFacts(binding.expected, {
      member: parseDisplayMember(fact(REVIEW_FACTS.member), binding.expected.member),
      sourceShare: parseDisplayShare(fact(REVIEW_FACTS.sourceShare), binding.expected.sourceShare),
      destinationShare: parseDisplayShare(fact(REVIEW_FACTS.destinationShare), binding.expected.destinationShare),
      amount: parseDisplayMoney(fact(REVIEW_FACTS.amount)),
      memo: fact(REVIEW_FACTS.memo),
    });
  }


  private async gate(action: string, risk: RiskClass, url = this.inner.currentUrl()): Promise<void> {
    this.assertAutomation();
    const v = checkAction(this.policy, action, url, risk);
    this.onDecision?.({ action, url, risk, verdict: v.verdict, reason: 'reason' in v ? v.reason : undefined });
    if (v.verdict === 'allow') return;
    if (v.verdict === 'needs_human') {
      const approved = await this.humanGate(action, risk, v.reason);
      this.emit('approval.result', { approved, effectiveRisk: risk });
      if (approved) return;
      throw new RunAbortedError(action);
    }
    throw new PolicyViolationError(v, action);
  }

  // Reads are ungated observations; actions are gated.
  async start(entryUrl: string): Promise<void> {
    return this.action('navigate', 'read', async () => {
      if (this.runtime && this.started) throw new Error('A run can start only once');
      this.started = true;
      this.assertRoute(entryUrl);
      this.requireTransferRoute(entryUrl);
      await this.gate('navigate', 'read', entryUrl);
      await this.inner.start(entryUrl);
      this.assertStillInBounds('start'); // a redirect could land outside the allowlist
      this.preserveTransferState(this.inner.currentUrl());
    });
  }
  observe(): Promise<Observation> { return this.inner.observe(); }
  currentUrl(): string { return this.inner.currentUrl(); }
  currentFrame(): FrameContext | undefined { return this.inner.currentFrame?.(); }
  lastResolvedFrame(): FrameContext | undefined { return this.inner.lastResolvedFrame?.(); }
  frameUrls(): string[] { return this.inner.frameUrls(); }
  isTextVisible(text: string, frame?: string) { return this.inner.isTextVisible(text, frame); }
  describeTarget(hint: TargetDescriptor, timeoutMs?: number) { return this.inner.describeTarget(hint, timeoutMs); }
  // Forward the masking options: the logger hands sensitive values down for
  // the shot, and dropping them here would render them in the clear in every
  // evidence PNG (the logger always sees the *guarded* surface, never the raw one).
  screenshot(path: string, opts?: { maskValues?: string[] }) { return this.inner.screenshot(path, opts); }
  close() { this.transferEligibility = undefined; return this.inner.close(); }
  drainDialogs() { return this.inner.drainDialogs?.() ?? []; }

  /** After an action that may navigate, verify we didn't land outside the allowlist. */
  private assertStillInBounds(action: string): void {
    // Check EVERY live frame, not just the reported working URL: in a frameset
    // app currentUrl() prefers a named child frame, which can go stale while
    // the top-level page navigates somewhere hostile.
    const urls = [this.inner.currentUrl(), ...this.inner.frameUrls()];
    for (const url of urls) {
      if (url.startsWith('about:')) continue; // blank/srcdoc frames inherit their parent
      if (!originAllowed(this.policy.allowedOrigins, url)) {
        throw new PolicyViolationError(
          { verdict: 'deny', reason: `navigation escaped the allowed origins during "${action}"` },
          action,
        );
      }
    }
  }

  async navigate(url: string): Promise<void> {
    return this.action('navigate', 'read', async () => {
      this.assertRoute(url);
      this.preserveTransferState(url);
      await this.gate('navigate', 'read', url);
      await this.inner.navigate(url);
      this.assertStillInBounds('navigate');
      if (this.runtime?.transfer && this.transferEligibility) this.advanceTransferState(this.inner.currentUrl());
      this.preserveTransferState(this.inner.currentUrl());
    });
  }
  private assertRoute(url: string) {
    if (!this.runtime) return;
    const parsed = new URL(url, this.policy.allowedOrigins[0]);
    if (this.signOnSubmitted && parsed.pathname === '/signon') throw new Error('Mid-flow sign-on is not permitted');
    if (!this.runtime.profile.routes?.some(p => new RegExp(p).test(parsed.pathname)) || /\/(post|review)$/.test(parsed.pathname)) {
      throw new Error('Navigation route is not permitted');
    }
  }
  click(t: TargetDescriptor, timeoutMs?: number, risk: RiskClass = 'read'): Promise<ResolutionReport> {
    return this.clickAction(t, timeoutMs, risk);
  }
  recoverClick(t: TargetDescriptor, timeoutMs?: number): Promise<ResolutionReport> {
    return this.clickAction(t, timeoutMs, 'reversible_write', true);
  }
  private async clickAction(t: TargetDescriptor, timeoutMs: number | undefined, risk: RiskClass, recovery = false): Promise<ResolutionReport> {
    if (recovery && this.mutationDispatched) throw new Error('POST_OUTCOME_UNKNOWN: recovery refused');
    return this.action('click', risk, async () => {
      this.assertAutomation();
      const budget = timeoutMs ?? DEFAULT_TIMEOUT;
      let deadline = Date.now() + budget;
      const remaining = () => {
        const value = deadline - Date.now();
        if (!Number.isFinite(value) || value <= 0) throw new Error('Click timeout expired');
        return Math.max(1, value);
      };
      const outsideBudget = async <T>(wait: () => Promise<T>) => {
        const started = Date.now();
        try { return await wait(); }
        finally { deadline += Date.now() - started; }
      };
      if (this.runtime) {
        this.assertStillInBounds('click');
        if (this.runtime.transfer) this.preserveTransferState(this.inner.currentUrl());
        if (!this.inner.prepareClick) throw new Error('Profile requires live control inspection');
        const prepared = await this.inner.prepareClick(t, remaining());
        remaining();
        const live = await prepared.inspect(remaining());
        remaining();
        const transferDestination = this.runtime.transfer ? this.transferStage(live.destination) : undefined;
        if (this.runtime.transfer && (this.transferStage(live.url) || (transferDestination && transferDestination.stage !== 'member'))) this.assertTransferControl(live);
        const signOn = new URL(live.destination).pathname === '/signon';
        if (signOn && this.signOnSubmitted) throw new Error('Mid-flow sign-on is not permitted');
        const rule = classify(this.runtime.profile, live, this.policy.allowedOrigins);
        const transferPost = TRANSFER_ROUTE.exec(this.path(live.destination))?.[2] === 'post';
        if (rule?.mutation) {
          this.assertCapabilityOperation(live.destination);
          if (this.runtime.transfer && !transferPost) throw new Error('Funds-transfer run cannot dispatch another operation');
        }
        if (transferPost) this.assertTransferReview(live);
        this.effectiveRisk = rule?.mutation ? 'irreversible' : risk;
        this.emit('risk.classified', { requestedRisk: risk, effectiveRisk: this.effectiveRisk, mutation: rule?.mutation ?? false, method: live.method });
        if (recovery && (rule?.mutation || checkAction(this.policy, 'click', live.destination, this.effectiveRisk).verdict !== 'allow')) throw new Error('Recovery requires an allowed nonmutation control');
        if (rule?.mutation) {
          if (this.mutationDispatched) throw new Error('POST_OUTCOME_UNKNOWN: repeat dispatch refused');
          if (live.error || live.conditions.length || !live.role || live.role !== this.runtime.role || live.operator !== this.runtime.operator.toUpperCase() || live.branch !== this.runtime.branch || (rule.role && rule.role !== live.role)) throw new Error('Target authority or review state invalid');
          const context: ActionContext = { runId: this.runtime.runId, artifact: this.runtime.artifact, version: this.runtime.version, stepId: this.stepId,
            destination: live.destination, method: live.method, operator: live.operator, branch: live.branch, role: live.role,
            facts: live.facts, tokenPresent: live.tokenPresent, control: live.control };
          // Profile mutation rules require approval even when policy/model says allow.
          const verdict = checkAction(this.policy, 'click', live.destination, 'irreversible');
          if (verdict.verdict === 'deny') throw new PolicyViolationError(verdict, 'click');
          this.onDecision?.({ action: 'click', url: live.destination, risk: 'irreversible', verdict: 'needs_human' });
          remaining();
          const approved = await outsideBudget(() => this.humanGate('click', 'irreversible', 'Review and approve the live transaction', context));
          this.emit('approval.result', { approved, effectiveRisk: 'irreversible' });
          if (!approved) throw new RunAbortedError('click');
          this.assertAutomation();
          if (this.runtime.transfer && this.transferStage(live.url)) this.assertTransferControl(live);
          const refreshed = await prepared.inspect(remaining());
          remaining();
          if (JSON.stringify(refreshed) !== JSON.stringify(live)) throw new Error('Approval invalidated by changed page state');
          if (transferPost) {
            this.assertTransferReview(refreshed);
          }
          this.assertAutomation();
          this.runtime.beforeDispatch(context);
          this.assertAutomation();
          this.mutationDispatched = true;
          // Intent is durable before dispatch starts; this is NOT proof a POST reached the server.
          this.emit('mutation.intent', { effectiveRisk: 'irreversible' });
        } else {
          await outsideBudget(() => this.gate('click', risk, live.destination));
        }
        this.assertAutomation();
        if (signOn && live.submit) this.signOnSubmitted = true;
        const report = await prepared.dispatch(live, remaining());
        this.assertStillInBounds('click');
        if (this.mutationDispatched) this.transferEligibility = undefined;
        else if (this.runtime.transfer && MEMBER_ROUTE.test(this.path(this.inner.currentUrl()))) await this.captureTransferEligibility(this.inner.currentUrl(), remaining());
        else if (this.runtime.transfer && this.transferStage(this.inner.currentUrl())) this.advanceTransferState(this.inner.currentUrl(), live.frame);
        this.preserveTransferState(this.inner.currentUrl());
        return report;
      }
      const live = await this.inner.describeTarget(t, remaining());
      remaining();
      const floor = riskFloorFor(live);
      this.effectiveRisk = floor && RISK_RANK[floor] > RISK_RANK[risk] ? floor : risk;
      this.emit('risk.classified', { requestedRisk: risk, effectiveRisk: this.effectiveRisk });
      if (recovery && (this.effectiveRisk === 'irreversible' || checkAction(this.policy, 'click', this.inner.currentUrl(), this.effectiveRisk).verdict !== 'allow')) throw new Error('Recovery requires an allowed nonmutation control');
      await outsideBudget(() => this.gate('click', this.effectiveRisk));
      const report = await this.inner.click(t, remaining());
      this.assertStillInBounds('click');
      this.preserveTransferState(this.inner.currentUrl());
      return report;
    });
  }
  async fill(t: TargetDescriptor, value: string, timeoutMs?: number, risk: RiskClass = 'reversible_write'): Promise<ResolutionReport> {
    return this.action('fill', risk, async () => {
      this.preserveTransferState(this.inner.currentUrl());
      await this.gate('fill', risk);
      const report = await this.inner.fill(t, value, timeoutMs);
      this.assertStillInBounds('fill'); // change handlers can navigate in legacy apps
      this.preserveTransferState(this.inner.currentUrl());
      return report;
    });
  }
  async select(t: TargetDescriptor, value: string, timeoutMs?: number, risk: RiskClass = 'reversible_write', selectBy?: 'label' | 'value'): Promise<ResolutionReport> {
    return this.action('select', risk, async () => {
      this.preserveTransferState(this.inner.currentUrl());
      await this.gate('select', risk);
      const report = await this.inner.select(t, value, timeoutMs, risk, selectBy);
      this.assertStillInBounds('select'); // onchange submits are a legacy staple
      this.preserveTransferState(this.inner.currentUrl());
      return report;
    });
  }
  async readTable(t: TargetDescriptor, columns: TableColumn[], timeoutMs?: number, rowSelector?: string) {
    return this.action('extract', 'read', async () => {
      this.preserveTransferState(this.inner.currentUrl());
      await this.gate('extract', 'read');
      if (!this.inner.readTable) throw new Error('Table extraction unavailable');
      const rows = await this.inner.readTable(t, columns, timeoutMs, rowSelector);
      this.preserveTransferState(this.inner.currentUrl());
      return rows;
    });
  }
  async readText(t: TargetDescriptor, timeoutMs?: number) {
    return this.action('extract', 'read', async () => {
      this.preserveTransferState(this.inner.currentUrl());
      await this.gate('extract', 'read');
      const result = await this.inner.readText(t, timeoutMs);
      this.preserveTransferState(this.inner.currentUrl());
      return result;
    });
  }
}
