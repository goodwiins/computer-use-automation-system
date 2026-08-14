// Policy enforcement as a Surface decorator. Every actor — the LLM during
// discovery, the deterministic replayer, a future caller — goes through the
// same gate, so no code path can act outside the allowlist.

import type { RiskClass, TargetDescriptor } from '../artifact/schema.js';
import { checkAction, originAllowed, type Policy, type PolicyVerdict } from '../safety/policy.js';
import type { Observation, ResolutionReport, Surface } from './types.js';

export class PolicyViolationError extends Error {
  constructor(public readonly verdict: Exclude<PolicyVerdict, { verdict: 'allow' }>, action: string) {
    super(`Policy ${verdict.verdict === 'deny' ? 'denied' : 'requires human for'} "${action}": ${verdict.reason}`);
  }
}

/** Called when an action needs a human (confirm/escalate). Return true to proceed. */
export type HumanGate = (action: string, risk: RiskClass, reason: string) => Promise<boolean>;

export class GuardedSurface implements Surface {
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
  ) {}

  private async gate(action: string, risk: RiskClass, url = this.inner.currentUrl()): Promise<void> {
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
    await this.gate('navigate', 'read', entryUrl);
    await this.inner.start(entryUrl);
    this.assertStillInBounds('start'); // a redirect could land outside the allowlist
  }
  observe(): Promise<Observation> { return this.inner.observe(); }
  currentUrl(): string { return this.inner.currentUrl(); }
  isTextVisible(text: string, frame?: string) { return this.inner.isTextVisible(text, frame); }
  describeTarget(hint: TargetDescriptor) { return this.inner.describeTarget(hint); }
  screenshot(path: string) { return this.inner.screenshot(path); }
  close() { return this.inner.close(); }

  /** After an action that may navigate, verify we didn't land outside the allowlist. */
  private assertStillInBounds(action: string): void {
    const url = this.inner.currentUrl();
    if (!originAllowed(this.policy.allowedOrigins, url)) {
      throw new PolicyViolationError(
        { verdict: 'deny', reason: `navigation escaped the allowed origins during "${action}"` },
        action,
      );
    }
  }

  async navigate(url: string): Promise<void> {
    await this.gate('navigate', 'read', url);
    await this.inner.navigate(url);
    this.assertStillInBounds('navigate');
  }
  async click(t: TargetDescriptor, timeoutMs?: number, risk: RiskClass = 'read'): Promise<ResolutionReport> {
    await this.gate('click', risk);
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
  async select(t: TargetDescriptor, value: string, timeoutMs?: number, risk: RiskClass = 'reversible_write'): Promise<ResolutionReport> {
    await this.gate('select', risk);
    const report = await this.inner.select(t, value, timeoutMs);
    this.assertStillInBounds('select'); // onchange submits are a legacy staple
    return report;
  }
  async readText(t: TargetDescriptor, timeoutMs?: number) {
    await this.gate('extract', 'read');
    return this.inner.readText(t, timeoutMs);
  }
}
