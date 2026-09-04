import { classify, type AppProfile } from '../runtime/profile.js';
import type { ActionContext } from '../runtime/approval.js';
import type { ControlSession } from '../escalation/session.js';
// Policy enforcement as a Surface decorator. Every actor — the LLM during
// discovery, the deterministic replayer, a future caller — goes through the
// same gate, so no code path can act outside the allowlist.

import type { RiskClass, TargetDescriptor, TableColumn } from '../artifact/schema.js';
import { checkAction, originAllowed, type Policy, type PolicyVerdict } from '../safety/policy.js';
import type { Observation, ResolutionReport, Surface } from './types.js';

export class PolicyViolationError extends Error {
  constructor(public readonly verdict: Exclude<PolicyVerdict, { verdict: 'allow' }>, action: string) {
    super(`Policy ${verdict.verdict === 'deny' ? 'denied' : 'requires human for'} "${action}": ${verdict.reason}`);
  }
}

/** Called when an action needs a human (confirm/escalate). Return true to proceed. */
export type HumanGate = (action: string, risk: RiskClass, reason: string, context?: ActionContext) => Promise<boolean>;

export class GuardedSurface implements Surface {
  mutationDispatched = false;
  effectiveRisk: RiskClass = 'read';
  private stepId = '(start)';
  private started = false;
  private signOnSubmitted = false;
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
    },
  ) {}

  private assertAutomation() {
    if (this.runtime?.session.currentOwner === 'human') throw new Error('Human owns this session');
    if (this.runtime && Date.now() >= this.runtime.deadline) throw new Error('Run deadline expired');
    if (this.runtime && this.signOnSubmitted && new URL(this.inner.currentUrl()).pathname === '/signon') throw new Error('Session ended; start a new invocation');
  }


  private async gate(action: string, risk: RiskClass, url = this.inner.currentUrl()): Promise<void> {
    this.assertAutomation();
    const v = checkAction(this.policy, action, url, risk);
    this.onDecision?.({ action, url, risk, verdict: v.verdict, reason: 'reason' in v ? v.reason : undefined });
    if (v.verdict === 'allow') return;
    if (v.verdict === 'needs_human') {
      const approved = await this.humanGate(action, risk, v.reason);
      if (approved) return;
      throw new PolicyViolationError({ verdict: 'deny', reason: `Human declined: ${v.reason}` }, action);
    }
    throw new PolicyViolationError(v, action);
  }

  // Reads are ungated observations; actions are gated.
  async start(entryUrl: string): Promise<void> {
    if (this.runtime && this.started) throw new Error('A run can start only once');
    this.started = true;
    this.assertRoute(entryUrl);
    await this.gate('navigate', 'read', entryUrl);
    await this.inner.start(entryUrl);
    this.assertStillInBounds('start'); // a redirect could land outside the allowlist
  }
  observe(): Promise<Observation> { return this.inner.observe(); }
  currentUrl(): string { return this.inner.currentUrl(); }
  frameUrls(): string[] { return this.inner.frameUrls(); }
  isTextVisible(text: string, frame?: string) { return this.inner.isTextVisible(text, frame); }
  describeTarget(hint: TargetDescriptor) { return this.inner.describeTarget(hint); }
  // Forward the masking options: the logger hands sensitive values down for
  // the shot, and dropping them here would render them in the clear in every
  // evidence PNG (the logger always sees the *guarded* surface, never the raw one).
  screenshot(path: string, opts?: { maskValues?: string[] }) { return this.inner.screenshot(path, opts); }
  close() { return this.inner.close(); }
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
    this.assertRoute(url);
    await this.gate('navigate', 'read', url);
    await this.inner.navigate(url);
    this.assertStillInBounds('navigate');
  }
  private assertRoute(url: string) {
    if (!this.runtime) return;
    const parsed = new URL(url, this.policy.allowedOrigins[0]);
    if (this.signOnSubmitted && parsed.pathname === '/signon') throw new Error('Mid-flow sign-on is not permitted');
    if (!this.runtime.profile.routes?.some(p => new RegExp(p).test(parsed.pathname)) || /\/(post|review)$/.test(parsed.pathname)) {
      throw new Error('Navigation route is not permitted');
    }
  }
  async click(t: TargetDescriptor, timeoutMs?: number, risk: RiskClass = 'read'): Promise<ResolutionReport> {
    this.assertAutomation();
    if (this.runtime) {
      this.assertStillInBounds('click');
      if (!this.inner.prepareClick) throw new Error('Profile requires live control inspection');
      const prepared = await this.inner.prepareClick(t, timeoutMs);
      const live = await prepared.inspect();
      const signOn = new URL(live.destination).pathname === '/signon';
      if (signOn && this.signOnSubmitted) throw new Error('Mid-flow sign-on is not permitted');
      const rule = classify(this.runtime.profile, live, this.policy.allowedOrigins);
      this.effectiveRisk = rule?.mutation ? 'irreversible' : risk;
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
        if (!await this.humanGate('click', 'irreversible', 'Review and approve the live transaction', context)) throw new Error('Submission aborted');
        this.assertAutomation();
        const refreshed = await prepared.inspect();
        if (JSON.stringify(refreshed) !== JSON.stringify(live)) throw new Error('Approval invalidated by changed page state');
        this.runtime.beforeDispatch(context);
        this.mutationDispatched = true;
      } else {
        await this.gate('click', risk, live.destination);
      }
      if (signOn && live.submit) this.signOnSubmitted = true;
      const report = await prepared.dispatch(live);
      this.assertStillInBounds('click');
      return report;
    }
    await this.gate('click', risk);
    this.effectiveRisk = risk;
    const report = await this.inner.click(t, timeoutMs);
    this.assertStillInBounds('click');
    return report;
  }
  async fill(t: TargetDescriptor, value: string, timeoutMs?: number, risk: RiskClass = 'reversible_write'): Promise<ResolutionReport> {
    await this.gate('fill', risk);
    const report = await this.inner.fill(t, value, timeoutMs);
    this.assertStillInBounds('fill'); // change handlers can navigate in legacy apps
    return report;
  }
  async select(t: TargetDescriptor, value: string, timeoutMs?: number, risk: RiskClass = 'reversible_write', selectBy?: 'label' | 'value'): Promise<ResolutionReport> {
    await this.gate('select', risk);
    const report = await this.inner.select(t, value, timeoutMs, risk, selectBy);
    this.assertStillInBounds('select'); // onchange submits are a legacy staple
    return report;
  }
  async readTable(t: TargetDescriptor, columns: TableColumn[], timeoutMs?: number, rowSelector?: string) {
    await this.gate('extract', 'read');
    if (!this.inner.readTable) throw new Error('Table extraction unavailable');
    return this.inner.readTable(t, columns, timeoutMs, rowSelector);
  }
  async readText(t: TargetDescriptor, timeoutMs?: number) {
    await this.gate('extract', 'read');
    return this.inner.readText(t, timeoutMs);
  }
}
