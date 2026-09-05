import { RISK_RANK, riskFloorFor } from '../artifact/recorder.js';
import { classify, type AppProfile, type FaultScenario, type FrameContext, type LiveControl } from '../runtime/profile.js';
import { assertHoldEligibility, assertHoldFacts, assertHoldResult, assertMemberUpdateFacts, assertOpenShareFacts, assertOpenShareResult, assertTransferEligibility, assertTransferFacts, meridianContracts, type HoldFacts, type HoldShare, type MemberUpdateFacts, type OpenShareFacts, type TransferFacts, type TransferShare } from '../runtime/contracts.js';
import type { ActionContext } from '../runtime/approval.js';
import type { ControlSession } from '../escalation/session.js';
// Policy enforcement as a Surface decorator. Every actor — the LLM during
// discovery, the deterministic replayer, a future caller — goes through the
// same gate, so no code path can act outside the allowlist.

import { moneyCents, RiskClass, type Detector, type OutputValue, type TargetDescriptor, type TableColumn } from '../artifact/schema.js';
import { BUILTIN_DETECTORS } from '../replay/detectors.js';
import { checkAction, originAllowed, type Policy, type PolicyVerdict } from '../safety/policy.js';
import type { Observation, ReadOnlyPageSnapshot, ResolutionReport, Surface } from './types.js';

const DEFAULT_TIMEOUT = 10_000;
const TRANSFER_ROUTE = /^\/members\/(\d+)\/transfer(?:\/(review|post))?$/;
const OPEN_SHARE_ROUTE = /^\/members\/(\d+)\/open-share(?:\/(review|post))?$/;
const MEMBER_ROUTE = /^\/members\/(\d+)$/;
const MEMBER_SCOPE_ROUTE = /^\/members\/(\d+)(?:\/|$)/;
const UPDATE_ROUTE = /^\/members\/(\d+)\/update$/;
const HOLD_ROUTE = /^\/members\/(\d+)\/hold(?:\/(review|post))?$/;
const MERIDIAN_MUTATION_ROUTES: Partial<Record<keyof typeof meridianContracts, RegExp>> = {
  'meridian-funds-transfer': /^\/members\/\d+\/transfer\/post$/,
  'meridian-open-share': /^\/members\/\d+\/open-share\/post$/,
  'meridian-update-member': /^\/members\/\d+\/update$/,
  'meridian-place-hold': /^\/members\/\d+\/hold\/post$/,
};
const MERIDIAN_OPERATION_ROUTES: Partial<Record<keyof typeof meridianContracts, RegExp>> = {
  'meridian-funds-transfer': TRANSFER_ROUTE,
  'meridian-open-share': OPEN_SHARE_ROUTE,
  'meridian-update-member': UPDATE_ROUTE,
  'meridian-place-hold': HOLD_ROUTE,
};
const REVIEW_FACTS = {
  member: 'review:Member:',
  sourceShare: 'review:From:',
  destinationShare: 'review:To:',
  amount: 'review:Amount:',
  memo: 'review:Memo:',
} as const;
const OPEN_SHARE_REVIEW_FACTS = {
  member: 'review:Member:',
  shareType: 'review:Share Type:',
  deposit: 'review:Initial Deposit:',
} as const;
const HOLD_REVIEW_FACTS = {
  member: 'review:Member:',
  share: 'review:Share:',
  reason: 'review:Reason:',
  notes: 'review:Notes:',
} as const;
const OPEN_SHARE_TYPE_LABELS: Record<string, string> = {
  'Regular Shares': 'S0001',
  'Share Draft (Checking)': 'S0070',
  'Money Market': 'MMKT',
  'Certificate': 'CERT',
};
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

function parseDisplayType(value: string, expected: string): string {
  const match = /^([A-Za-z0-9]+) - (.+)$/.exec(value.trim());
  if (!match || match[1] !== expected || OPEN_SHARE_TYPE_LABELS[match[2]!] !== expected) return transferReviewFailed();
  return match[1]!;
}

function parseMemberTableShareType(value: string): string {
  if (!Object.hasOwn(OPEN_SHARE_TYPE_LABELS, value)) throw new Error('Open-share result type is unrecognized');
  return OPEN_SHARE_TYPE_LABELS[value]!;
}

type TransferBinding = {
  expected: TransferFacts;
  memberTable: { target: TargetDescriptor; columns: TableColumn[]; rowSelector?: string };
};
type TransferStage = 'member' | 'transfer' | 'review';
type TransferEligibility = { member: string; shares: TransferShare[]; frame: FrameContext; stage: TransferStage };
type OpenShareBinding = {
  expected: OpenShareFacts;
  memberTable: { target: TargetDescriptor; columns: TableColumn[]; rowSelector?: string };
  contactTable: { target: TargetDescriptor; columns: TableColumn[]; rowSelector?: string };
};
type OpenShareStage = 'member' | 'open-share' | 'review';
type OpenShareState = { member: string; priorShareIds: string[]; frame: FrameContext; stage: OpenShareStage };
type MemberUpdateBinding = {
  expected: MemberUpdateFacts;
  contactTable: { target: TargetDescriptor; columns: TableColumn[]; rowSelector?: string };
};
type HoldBinding = {
  expected: HoldFacts;
  memberTable: { target: TargetDescriptor; columns: TableColumn[]; rowSelector?: string };
  contactTable: { target: TargetDescriptor; columns: TableColumn[]; rowSelector?: string };
};
type HoldStage = 'member' | 'hold' | 'review';
type HoldState = { member: string; name: string; selected: HoldShare; frame: FrameContext; stage: HoldStage };
type RecoveryClickBoundary = { source: FrameContext; destination: string };

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
  private openShareState?: OpenShareState;
  private memberUpdateOrigin?: string;
  private holdState?: HoldState;
  private maintenanceAttempted = false;
  get strictOperationRecovery() {
    return this.runtime?.profile.appId === 'meridian';
  }
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
      fault?: FaultScenario;
      transfer?: TransferBinding;
      openShare?: OpenShareBinding;
      memberUpdate?: MemberUpdateBinding;
      hold?: HoldBinding;
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

  private origin(url: string): string {
    try { return new URL(url, this.policy.allowedOrigins[0]).origin; } catch { return ''; }
  }

  private transferRoute(url: string) {
    return TRANSFER_ROUTE.exec(this.path(url));
  }

  private openShareRoute(url: string) {
    return OPEN_SHARE_ROUTE.exec(this.path(url));
  }

  private assertCapabilityOperation(destination: string): void {
    const artifact = this.runtime?.artifact;
    if (!artifact || this.runtime?.profile.appId !== 'meridian' || !Object.hasOwn(meridianContracts, artifact)) return;
    const allowed = MERIDIAN_MUTATION_ROUTES[artifact as keyof typeof meridianContracts];
    if (allowed?.test(this.path(destination))) return;
    if (artifact === 'meridian-funds-transfer') throw new Error('Funds-transfer run cannot dispatch another operation');
    throw new Error('Canonical MERIDIAN capability cannot dispatch this operation');
  }

  private assertBoundOperationNavigation(url: string): void {
    const runtime = this.runtime;
    if (!runtime || runtime.profile.appId !== 'meridian'
      || !MERIDIAN_MUTATION_ROUTES[runtime.artifact as keyof typeof meridianContracts]) return;
    const expected = runtime?.artifact === 'meridian-funds-transfer' ? runtime.transfer?.expected.member
      : runtime?.artifact === 'meridian-open-share' ? runtime.openShare?.expected.member
        : runtime?.artifact === 'meridian-update-member' ? runtime.memberUpdate?.expected.member
          : runtime?.artifact === 'meridian-place-hold' ? runtime.hold?.expected.member : undefined;
    if (!expected) return;
    const path = this.path(url);
    const member = MEMBER_SCOPE_ROUTE.exec(path);
    if (member && member[1] !== expected) throw new Error('Canonical member selection is not bound to this run');
    if (path === '/' || path === '/signon' || path === '/menu' || path === '/members' || MEMBER_ROUTE.test(path)) return;
    const operation = MERIDIAN_OPERATION_ROUTES[runtime.artifact as keyof typeof meridianContracts]?.exec(path);
    if (operation?.[1] === expected) return;
    throw new Error('Canonical MERIDIAN capability cannot enter another operation');
  }

  private transferStage(url: string): { member: string; stage: TransferStage } | undefined {
    const member = MEMBER_ROUTE.exec(this.path(url));
    if (member) return { member: member[1]!, stage: 'member' };
    const transfer = this.transferRoute(url);
    if (!transfer || transfer[2] === 'post') return undefined;
    return { member: transfer[1]!, stage: transfer[2] === 'review' ? 'review' : 'transfer' };
  }

  private sameFrame(left: FrameContext | undefined, right: FrameContext | undefined): boolean {
    return !!left && !!right && left.id === right.id && left.name === right.name
      && !!this.origin(left.url) && this.origin(left.url) === this.origin(right.url);
  }

  private sameFrameRevision(left: FrameContext | undefined, right: FrameContext | undefined): boolean {
    return this.sameFrame(left, right) && left!.navigation === right!.navigation && left!.url === right!.url;
  }

  private assertMeridianMutationOrigin(live: LiveControl): void {
    if (this.runtime?.profile.appId !== 'meridian') return;
    const frameOrigin = live.frame ? this.origin(live.frame.url) : '';
    const sourceOrigin = this.origin(live.url);
    const destinationOrigin = this.origin(live.destination);
    if (!frameOrigin || !sourceOrigin || !destinationOrigin
      || frameOrigin !== sourceOrigin || frameOrigin !== destinationOrigin) {
      throw new Error('MERIDIAN mutation origin does not match its source frame');
    }
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

  private openShareFrameFailed(): never {
    this.openShareState = undefined;
    throw new Error('Open-share frame is no longer bound to this run');
  }

  private openShareTransitionFailed(): never {
    this.openShareState = undefined;
    throw new Error('Open-share control transition is not bound to this run');
  }

  private openShareStage(url: string): { member: string; stage: OpenShareStage } | undefined {
    const member = MEMBER_ROUTE.exec(this.path(url));
    if (member) return { member: member[1]!, stage: 'member' };
    const openShare = this.openShareRoute(url);
    if (!openShare || openShare[2] === 'post') return undefined;
    return { member: openShare[1]!, stage: openShare[2] === 'review' ? 'review' : 'open-share' };
  }

  private currentOpenShareFrame(): FrameContext {
    const frame = this.inner.currentFrame?.();
    if (!frame) throw new Error('Open-share frame identity is unavailable');
    return frame;
  }

  private preserveOpenShareState(url: string): void {
    const binding = this.runtime?.openShare;
    if (!binding || this.mutationDispatched) return;
    const route = this.openShareStage(url);
    if (!route || route.member !== binding.expected.member) {
      this.openShareState = undefined;
      return;
    }
    if (!this.openShareState && route.stage === 'member') return;
    const state = this.openShareState;
    if (!state || state.member !== binding.expected.member || state.stage !== route.stage) throw new Error('Open-share prior state has not been verified for this run');
    const current = this.currentOpenShareFrame();
    if (!this.sameFrameRevision(current, state.frame) || this.path(current.url) !== this.path(url)) return this.openShareFrameFailed();
  }

  private preserveOperationState(url: string): void {
    this.preserveTransferState(url);
    this.preserveOpenShareState(url);
    this.preserveHoldState(url);
  }

  private advanceOpenShareState(url: string, expectedFrame?: FrameContext): void {
    const binding = this.runtime?.openShare;
    const route = this.openShareStage(url);
    if (!binding || !route || route.member !== binding.expected.member) return this.openShareFrameFailed();
    const state = this.openShareState;
    if (!state) {
      if (route.stage === 'member') return;
      return this.openShareFrameFailed();
    }
    if (expectedFrame && !this.sameFrameRevision(expectedFrame, state.frame)) return this.openShareFrameFailed();
    const current = this.currentOpenShareFrame();
    if (this.path(current.url) !== this.path(url) || !this.sameFrame(current, state.frame)) return this.openShareFrameFailed();
    const validTransition = state.stage === route.stage
      || (state.stage === 'member' && route.stage === 'open-share')
      || (state.stage === 'open-share' && route.stage === 'review');
    if (!validTransition || (state.stage !== route.stage && current.navigation === state.frame.navigation)) return this.openShareFrameFailed();
    state.frame = current;
    state.stage = route.stage;
  }

  private async captureOpenShareState(memberUrl: string, timeoutMs: number): Promise<void> {
    const binding = this.runtime?.openShare;
    const member = MEMBER_ROUTE.exec(this.path(memberUrl));
    if (!binding || !member || member[1] !== binding.expected.member) throw new Error('Open-share member selection is not eligible');
    if (!this.inner.readTable) throw new Error('Member shares table is unavailable');
    const before = this.currentOpenShareFrame();
    if (this.origin(before.url) !== this.origin(memberUrl) || this.path(before.url) !== this.path(memberUrl)) return this.openShareFrameFailed();
    const target = { ...binding.memberTable.target, frame: before.name };
    await this.gate('extract', 'read');
    this.assertStillInBounds('extract');
    const rows = await this.inner.readTable(target, binding.memberTable.columns, timeoutMs, binding.memberTable.rowSelector);
    this.assertStillInBounds('extract');
    const resolved = this.inner.lastResolvedFrame?.();
    const after = this.currentOpenShareFrame();
    if (!resolved || !this.sameFrameRevision(before, resolved) || !this.sameFrameRevision(before, after)
      || this.origin(resolved.url) !== this.origin(memberUrl) || this.path(resolved.url) !== this.path(memberUrl)) return this.openShareFrameFailed();
    const priorShareIds = rows.map(row => typeof row.shareId === 'string' ? row.shareId : '');
    if (priorShareIds.some(id => !id.trim()) || new Set(priorShareIds).size !== priorShareIds.length) throw new Error('Member shares are missing or ambiguous');
    this.openShareState = { member: member[1]!, priorShareIds, frame: resolved, stage: 'member' };
  }

  private assertOpenShareControl(live: LiveControl): void {
    const binding = this.runtime?.openShare;
    const route = this.openShareStage(live.url);
    if (!binding || !route || route.member !== binding.expected.member || !live.frame) return this.openShareFrameFailed();
    const current = this.currentOpenShareFrame();
    if (!this.sameFrameRevision(live.frame, current) || this.path(live.frame.url) !== this.path(live.url) || this.path(current.url) !== this.path(live.url)) return this.openShareFrameFailed();
    const state = this.openShareState;
    if (!state) return this.openShareFrameFailed();
    if (state.stage !== route.stage || !this.sameFrameRevision(state.frame, live.frame)) return this.openShareFrameFailed();
    const destination = this.openShareStage(live.destination);
    const post = OPEN_SHARE_ROUTE.exec(this.path(live.destination));
    const sameOrigin = this.origin(live.destination) === this.origin(live.url);
    const validTransition = route.stage === 'member'
      ? destination?.member === binding.expected.member && destination.stage === 'open-share' && live.method === 'GET' && !live.submit
      : route.stage === 'open-share'
        ? destination?.member === binding.expected.member && destination.stage === 'review' && live.method === 'POST' && live.submit
        : post?.[1] === binding.expected.member && post[2] === 'post' && live.method === 'POST' && live.submit;
    if (!sameOrigin) {
      this.openShareState = undefined;
      throw new Error('Open-share control origin is not bound to this run');
    }
    if (!validTransition) return this.openShareTransitionFailed();
  }

  private assertOpenShareReview(live: LiveControl): void {
    const binding = this.runtime?.openShare;
    const route = OPEN_SHARE_ROUTE.exec(this.path(live.destination));
    if (!binding || !route || route[1] !== binding.expected.member || route[2] !== 'post' || this.openShareStage(live.url)?.stage !== 'review') throw new Error('Open-share review is not bound to the requested member');
    this.assertOpenShareControl(live);
    const fact = (name: string) => {
      const value = live.facts[name];
      if (typeof value !== 'string') throw new Error('Open-share review facts are missing or ambiguous');
      return value;
    };
    assertOpenShareFacts(binding.expected, { member: fact('member'), shareType: fact('type'), deposit: fact('deposit') });
    assertOpenShareFacts(binding.expected, {
      member: parseDisplayMember(fact(OPEN_SHARE_REVIEW_FACTS.member), binding.expected.member),
      shareType: parseDisplayType(fact(OPEN_SHARE_REVIEW_FACTS.shareType), binding.expected.shareType),
      deposit: parseDisplayMoney(fact(OPEN_SHARE_REVIEW_FACTS.deposit)),
    });
  }

  private assertMemberUpdateControl(live: LiveControl): void {
    const binding = this.runtime?.memberUpdate;
    const sourceUrl = new URL(live.url, this.policy.allowedOrigins[0]);
    const destinationUrl = new URL(live.destination, this.policy.allowedOrigins[0]);
    const source = UPDATE_ROUTE.exec(this.path(live.url));
    const destination = UPDATE_ROUTE.exec(this.path(live.destination));
    if (!binding || !source || !destination || source[1] !== binding.expected.member || destination[1] !== binding.expected.member
      || sourceUrl.origin !== destinationUrl.origin || !live.frame) {
      throw new Error('Member-update form is not bound to the requested member');
    }
    const current = this.inner.currentFrame?.();
    if (!this.sameFrameRevision(live.frame, current) || this.path(live.frame.url) !== this.path(live.url) || this.path(current!.url) !== this.path(live.url)) {
      throw new Error('Member-update frame is no longer bound to this run');
    }
    const fact = (name: keyof MemberUpdateFacts) => {
      const value = live.facts[name];
      if (typeof value !== 'string') throw new Error('Member-update form facts are missing or ambiguous');
      return value;
    };
    assertMemberUpdateFacts(binding.expected, {
      member: fact('member'), email: fact('email'), phone: fact('phone'), address: fact('address'),
    });
  }

  private holdStage(url: string): { member: string; stage: HoldStage } | undefined {
    const member = MEMBER_ROUTE.exec(this.path(url));
    if (member) return { member: member[1]!, stage: 'member' };
    const hold = HOLD_ROUTE.exec(this.path(url));
    if (!hold || hold[2] === 'post') return undefined;
    return { member: hold[1]!, stage: hold[2] === 'review' ? 'review' : 'hold' };
  }

  private holdFrameFailed(): never {
    this.holdState = undefined;
    throw new Error('Hold frame is no longer bound to this run');
  }

  private holdTransitionFailed(): never {
    this.holdState = undefined;
    throw new Error('Hold control transition is not bound to this run');
  }

  private currentHoldFrame(): FrameContext {
    const frame = this.inner.currentFrame?.();
    if (!frame) throw new Error('Hold frame identity is unavailable');
    return frame;
  }

  private preserveHoldState(url: string): void {
    const binding = this.runtime?.hold;
    if (!binding || this.mutationDispatched) return;
    const route = this.holdStage(url);
    if (!route || route.member !== binding.expected.member) {
      this.holdState = undefined;
      return;
    }
    if (!this.holdState && route.stage === 'member') return;
    const state = this.holdState;
    if (!state || state.member !== binding.expected.member || state.stage !== route.stage) throw new Error('Hold eligibility has not been verified for this run');
    const current = this.currentHoldFrame();
    if (!this.sameFrameRevision(current, state.frame) || this.path(current.url) !== this.path(url)) return this.holdFrameFailed();
  }

  private advanceHoldState(url: string, expectedFrame?: FrameContext): void {
    const binding = this.runtime?.hold;
    const route = this.holdStage(url);
    if (!binding || !route || route.member !== binding.expected.member) return this.holdFrameFailed();
    const state = this.holdState;
    if (!state) {
      if (route.stage === 'member') return;
      return this.holdFrameFailed();
    }
    if (expectedFrame && !this.sameFrameRevision(expectedFrame, state.frame)) return this.holdFrameFailed();
    const current = this.currentHoldFrame();
    if (this.path(current.url) !== this.path(url) || !this.sameFrame(current, state.frame)) return this.holdFrameFailed();
    const validTransition = state.stage === route.stage
      || (state.stage === 'member' && route.stage === 'hold')
      || (state.stage === 'hold' && route.stage === 'review');
    if (!validTransition || (state.stage !== route.stage && current.navigation === state.frame.navigation)) return this.holdFrameFailed();
    state.frame = current;
    state.stage = route.stage;
  }

  private async captureHoldState(memberUrl: string, timeoutMs: number): Promise<void> {
    const binding = this.runtime?.hold;
    const route = MEMBER_ROUTE.exec(this.path(memberUrl));
    if (!binding || !route || route[1] !== binding.expected.member || !this.inner.readTable) throw new Error('Hold member selection is not eligible');
    const deadline = Date.now() + timeoutMs;
    const remaining = () => {
      const value = deadline - Date.now();
      if (!Number.isFinite(value) || value <= 0) throw new Error('Hold eligibility timeout expired');
      return Math.max(1, value);
    };
    const before = this.currentHoldFrame();
    if (this.origin(before.url) !== this.origin(memberUrl) || this.path(before.url) !== this.path(memberUrl)) return this.holdFrameFailed();
    await this.gate('extract', 'read');
    this.assertStillInBounds('extract');
    const contact = await this.inner.readTable({ ...binding.contactTable.target, frame: before.name }, binding.contactTable.columns, remaining(), binding.contactTable.rowSelector);
    this.assertStillInBounds('extract');
    const contactFrame = this.inner.lastResolvedFrame?.();
    if (!contactFrame || !this.sameFrameRevision(before, contactFrame) || !this.sameFrameRevision(before, this.currentHoldFrame())
      || this.origin(contactFrame.url) !== this.origin(memberUrl) || this.path(contactFrame.url) !== this.path(memberUrl)) return this.holdFrameFailed();
    await this.gate('extract', 'read');
    this.assertStillInBounds('extract');
    const rows = await this.inner.readTable({ ...binding.memberTable.target, frame: before.name }, binding.memberTable.columns, remaining(), binding.memberTable.rowSelector);
    this.assertStillInBounds('extract');
    const shareFrame = this.inner.lastResolvedFrame?.();
    if (!shareFrame || !this.sameFrameRevision(before, shareFrame) || !this.sameFrameRevision(before, this.currentHoldFrame())
      || this.origin(shareFrame.url) !== this.origin(memberUrl) || this.path(shareFrame.url) !== this.path(memberUrl)) return this.holdFrameFailed();
    const observed = this.parseHoldEligibility(contact, rows);
    this.holdState = { ...observed, frame: shareFrame, stage: 'member' };
  }

  private parseHoldEligibility(contact: Array<Record<string, string>>, rows: Array<Record<string, string>>) {
    const binding = this.runtime?.hold;
    if (!binding || contact.length !== 1) throw new Error('Hold member identity is missing or ambiguous');
    const contactRow = contact[0]!;
    const exactContact = (name: string) => {
      const value = contactRow[name];
      if (typeof value !== 'string') throw new Error('Hold member identity is incomplete');
      return value;
    };
    if (exactContact('memberLabel') !== 'Member No.:' || exactContact('nameLabel') !== 'Name:' || !exactContact('name').trim()) {
      throw new Error('Hold member identity labels are missing or ambiguous');
    }
    const shares = rows.map(row => {
      if (typeof row.shareId !== 'string' || typeof row.type !== 'string' || typeof row.status !== 'string') throw new Error('Hold eligibility table is incomplete');
      return { share: row.shareId, type: row.type, status: row.status };
    });
    const member = exactContact('member');
    assertHoldEligibility(binding.expected, member, shares);
    return { member, name: exactContact('name'), selected: shares.find(row => row.share === binding.expected.share)! };
  }

  private async refreshHoldEligibility(live: LiveControl, timeoutMs: number): Promise<void> {
    const binding = this.runtime?.hold;
    const state = this.holdState;
    if (!binding || !state || !this.inner.readOnlyPage) throw new Error('Fresh hold eligibility UI read is unavailable');
    const memberUrl = new URL(`/members/${binding.expected.member}`, live.url).href;
    const snapshot: ReadOnlyPageSnapshot = await this.inner.readOnlyPage(memberUrl, [
      { target: binding.contactTable.target, columns: binding.contactTable.columns, rowSelector: binding.contactTable.rowSelector },
      { target: binding.memberTable.target, columns: binding.memberTable.columns, rowSelector: binding.memberTable.rowSelector },
    ], timeoutMs);
    const tables = this.assertFreshMemberSnapshot(snapshot, memberUrl, live, 2);
    const observed = this.parseHoldEligibility(tables[0]!, tables[1]!);
    if (observed.member !== state.member || observed.name !== state.name || observed.selected.type !== state.selected.type) {
      throw new Error('Fresh hold eligibility changed after approval');
    }
  }

  private assertFreshMemberSnapshot(snapshot: ReadOnlyPageSnapshot, memberUrl: string, live: LiveControl, tableCount: number) {
    if (this.origin(snapshot.url) !== this.origin(memberUrl) || this.path(snapshot.url) !== this.path(memberUrl)
      || snapshot.frameUrls.some(url => !url.startsWith('about:') && this.origin(url) !== this.origin(memberUrl))
      || !snapshot.identity.trusted || snapshot.identity.operator !== live.operator || snapshot.identity.branch !== live.branch
      || snapshot.tables.length !== tableCount) throw new Error('Fresh hold or transfer member eligibility UI read is not bound to the approved review');
    return snapshot.tables;
  }

  private assertHoldControl(live: LiveControl): void {
    const binding = this.runtime?.hold;
    const source = this.holdStage(live.url);
    const destination = this.holdStage(live.destination);
    if (!binding || !source || source.member !== binding.expected.member || !live.frame
      || new URL(live.url, this.policy.allowedOrigins[0]).origin !== new URL(live.destination, this.policy.allowedOrigins[0]).origin) return this.holdFrameFailed();
    if (destination && destination.member !== binding.expected.member) return this.holdFrameFailed();
    const current = this.currentHoldFrame();
    const state = this.holdState;
    if (!state || state.stage !== source.stage || !this.sameFrameRevision(state.frame, live.frame)
      || !this.sameFrameRevision(live.frame, current) || this.path(live.frame.url) !== this.path(live.url)) return this.holdFrameFailed();
    const post = HOLD_ROUTE.exec(this.path(live.destination));
    const validTransition = source.stage === 'member'
      ? destination?.stage === 'hold' && live.method === 'GET' && !live.submit
      : source.stage === 'hold'
        ? destination?.stage === 'review' && live.method === 'POST' && live.submit
        : post?.[1] === binding.expected.member && post[2] === 'post' && live.method === 'POST' && live.submit;
    if (!validTransition) return this.holdTransitionFailed();
  }

  private assertHoldNativeFacts(live: LiveControl): void {
    const binding = this.runtime?.hold;
    if (!binding || (this.runtime!.role !== 'TELLER' && this.runtime!.role !== 'SUPERVISOR')) throw new Error('Hold authority is invalid');
    const fact = (name: keyof HoldFacts) => {
      const value = live.facts[name];
      if (typeof value !== 'string') throw new Error('Hold form facts are missing or ambiguous');
      return value;
    };
    assertHoldFacts(binding.expected, { member: fact('member'), share: fact('share'), reason: fact('reason'), notes: fact('notes') }, this.runtime.role);
  }

  private assertHoldReview(live: LiveControl): void {
    const binding = this.runtime?.hold;
    const state = this.holdState;
    const destination = HOLD_ROUTE.exec(this.path(live.destination));
    if (!binding || !state || !destination || destination[1] !== binding.expected.member || destination[2] !== 'post'
      || this.holdStage(live.url)?.stage !== 'review') throw new Error('Hold review is not bound to the requested member');
    this.assertHoldControl(live);
    this.assertHoldNativeFacts(live);
    const fact = (name: string) => {
      const value = live.facts[name];
      if (typeof value !== 'string') throw new Error('Hold review facts are missing or ambiguous');
      return value;
    };
    if (fact(HOLD_REVIEW_FACTS.member) !== `${binding.expected.member} - ${state.name}`
      || fact(HOLD_REVIEW_FACTS.share) !== `${binding.expected.share} - ${state.selected.type}`
      || fact(HOLD_REVIEW_FACTS.reason) !== binding.expected.reason
      || fact(HOLD_REVIEW_FACTS.notes) !== binding.expected.notes.trim()) throw new Error('Hold review facts failed validation');
  }

  private requireTransferRoute(url: string): void {
    const route = this.transferStage(url);
    if (!route || this.runtime?.profile.appId !== 'meridian' || this.runtime.artifact !== 'meridian-funds-transfer') return;
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

  private async refreshTransferEligibility(live: LiveControl, timeoutMs: number): Promise<void> {
    const binding = this.runtime?.transfer;
    if (!binding || !this.transferEligibility || !this.inner.readOnlyPage) throw new Error('Fresh transfer eligibility UI read is unavailable');
    const memberUrl = new URL(`/members/${binding.expected.member}`, live.url).href;
    const snapshot = await this.inner.readOnlyPage(memberUrl, [
      { target: binding.memberTable.target, columns: binding.memberTable.columns, rowSelector: binding.memberTable.rowSelector },
    ], timeoutMs);
    const rows = this.assertFreshMemberSnapshot(snapshot, memberUrl, live, 1)[0]!;
    const shares = rows.map(row => {
      if (typeof row.shareId !== 'string' || typeof row.status !== 'string' || typeof row.balance !== 'string') {
        throw new Error('Fresh transfer eligibility table is incomplete');
      }
      return { share: row.shareId, status: row.status, balance: row.balance };
    });
    assertTransferEligibility(binding.expected, binding.expected.member, shares);
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
    assertTransferFacts({ ...binding.expected, memo: binding.expected.memo.trim() }, {
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
      this.assertBoundOperationNavigation(entryUrl);
      this.started = true;
      this.assertRoute(entryUrl);
      this.requireTransferRoute(entryUrl);
      await this.gate('navigate', 'read', entryUrl);
      await this.inner.start(entryUrl);
      this.assertStillInBounds('start'); // a redirect could land outside the allowlist
      if (!this.mutationDispatched && this.runtime?.openShare && MEMBER_ROUTE.test(this.path(entryUrl))) {
        await this.captureOpenShareState(entryUrl, DEFAULT_TIMEOUT);
      } else if (!this.mutationDispatched && this.runtime?.hold && MEMBER_ROUTE.test(this.path(entryUrl))) {
        await this.captureHoldState(entryUrl, DEFAULT_TIMEOUT);
      } else this.preserveOperationState(this.inner.currentUrl());
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
  close() { this.transferEligibility = undefined; this.openShareState = undefined; this.memberUpdateOrigin = undefined; this.holdState = undefined; return this.inner.close(); }
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
      this.assertBoundOperationNavigation(url);
      this.assertRoute(url);
      this.preserveOperationState(url);
      await this.gate('navigate', 'read', url);
      await this.inner.navigate(url);
      this.assertStillInBounds('navigate');
      if (!this.mutationDispatched && this.runtime?.transfer && this.transferEligibility) this.advanceTransferState(this.inner.currentUrl());
      if (!this.mutationDispatched && this.runtime?.openShare && MEMBER_ROUTE.test(this.path(url))) await this.captureOpenShareState(url, DEFAULT_TIMEOUT);
      else if (!this.mutationDispatched && this.runtime?.openShare && this.openShareState) this.advanceOpenShareState(this.inner.currentUrl());
      if (!this.mutationDispatched && this.runtime?.hold && MEMBER_ROUTE.test(this.path(url))) await this.captureHoldState(url, DEFAULT_TIMEOUT);
      else if (!this.mutationDispatched && this.runtime?.hold && this.holdState) this.advanceHoldState(this.inner.currentUrl());
      this.preserveOperationState(this.inner.currentUrl());
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
  private exactUrl(actual: string, expected: string): boolean {
    try {
      const parsed = new URL(actual);
      return parsed.search === '' && parsed.hash === '' && parsed.toString() === expected;
    } catch { return false; }
  }

  private assertRecoveryControl(live: LiveControl, boundary: RecoveryClickBoundary): void {
    if (!live.frame || !this.sameFrameRevision(live.frame, boundary.source)
      || live.url !== boundary.source.url || !this.exactUrl(live.destination, boundary.destination)
      || live.method !== 'GET' || live.submit) {
      throw new Error('Recovery control is outside the bound frame or destination');
    }
  }

  private async trustedDetectorVisible(detector: Detector, frame: FrameContext): Promise<boolean> {
    if (detector.match.kind === 'textVisible') return this.inner.isTextVisible(detector.match.text, frame.name);
    try { return new RegExp(detector.match.pattern).test(frame.url); } catch { return false; }
  }

  private async assertTrustedConditionsClear(frame: FrameContext): Promise<void> {
    const before = this.currentOpenShareFrame();
    if (!this.sameFrameRevision(frame, before)) return this.openShareFrameFailed();
    for (const detector of [...(this.runtime?.profile.detectors ?? []), ...BUILTIN_DETECTORS]) {
      if (await this.trustedDetectorVisible(detector, frame)) throw new Error('Runtime condition remains after recovery');
    }
    const after = this.currentOpenShareFrame();
    if (!this.sameFrameRevision(frame, after)) return this.openShareFrameFailed();
  }

  async recoverOperation(detectorId: string, timeoutMs?: number): Promise<void> {
    const runtime = this.runtime;
    const binding = runtime?.openShare;
    const state = this.openShareState;
    const detector = runtime?.profile.detectors.find(candidate => candidate.id === detectorId);
    if (runtime?.profile.appId !== 'meridian' || runtime.artifact !== 'meridian-open-share'
      || !binding || !state || detector?.recovery?.resume !== 'open-share-member-entry'
      || detector.recovery.action !== 'click' || !detector.recovery.target || this.mutationDispatched) {
      throw new Error('Operation recovery is not trusted for this run');
    }
    if (!/^[0-9]{1,12}$/.test(binding.expected.member)) throw new Error('Operation recovery member is invalid');
    if (this.maintenanceAttempted) throw new Error('Operation recovery was already attempted');
    this.maintenanceAttempted = true;
    this.assertAutomation();

    const budget = timeoutMs ?? DEFAULT_TIMEOUT;
    const deadline = Date.now() + budget;
    const remaining = () => {
      const value = deadline - Date.now();
      if (!Number.isFinite(value) || value <= 0) throw new Error('Recovery timeout expired');
      return Math.max(1, value);
    };
    const origin = this.origin(state.frame.url);
    const memberUrl = new URL(`/members/${binding.expected.member}`, origin).toString();
    const openUrl = new URL(`/members/${binding.expected.member}/open-share`, origin).toString();
    const fault = runtime.fault;
    let injectedOpenUrl: string | undefined;
    if (fault?.kind === 'maintenance' && fault.path === new URL(openUrl).pathname) {
      const injected = new URL(openUrl);
      injected.searchParams.set('inject', fault.kind);
      injectedOpenUrl = injected.toString();
    }
    const interrupted = this.currentOpenShareFrame();
    if (state.member !== binding.expected.member || state.stage !== 'open-share'
      || !this.sameFrameRevision(interrupted, state.frame)
      || (!this.exactUrl(interrupted.url, openUrl) && interrupted.url !== injectedOpenUrl)
      || !(await this.trustedDetectorVisible(detector, interrupted))) {
      return this.openShareFrameFailed();
    }

    await this.clickAction(detector.recovery.target, remaining(), 'reversible_write', true, {
      source: interrupted, destination: memberUrl,
    });
    this.assertAutomation();
    const memberFrame = this.currentOpenShareFrame();
    if (!this.sameFrame(interrupted, memberFrame) || memberFrame.navigation <= interrupted.navigation
      || !this.exactUrl(memberFrame.url, memberUrl)) return this.openShareFrameFailed();

    if (!this.inner.readTable) throw new Error('Member contact table is unavailable');
    const contactTarget = { ...binding.contactTable.target, frame: memberFrame.name };
    await this.gate('extract', 'read');
    const contacts = await this.inner.readTable(contactTarget, binding.contactTable.columns, remaining(), binding.contactTable.rowSelector);
    const resolvedContact = this.inner.lastResolvedFrame?.();
    this.assertAutomation();
    if (!resolvedContact || !this.sameFrameRevision(memberFrame, resolvedContact)
      || !this.sameFrameRevision(memberFrame, this.currentOpenShareFrame()) || contacts.length !== 1) return this.openShareFrameFailed();
    const contact = contacts[0]!;
    if (contact.memberLabel !== 'Member No.:' || contact.member !== binding.expected.member
      || contact.nameLabel !== 'Name:' || typeof contact.name !== 'string' || !contact.name.trim()) return this.openShareFrameFailed();
    const tableSelector = binding.contactTable.target.strategies.find(strategy => strategy.kind === 'css')?.selector;
    const checkpointCells = [
      { name: 'memberLabel', expected: 'Member No.:' },
      { name: 'member', expected: binding.expected.member },
    ];
    if (!tableSelector || !this.inner.isTargetVisible) return this.openShareFrameFailed();
    for (const checkpointCell of checkpointCells) {
      const cellSelector = binding.contactTable.columns.find(column => column.name === checkpointCell.name)?.selector;
      if (!cellSelector) return this.openShareFrameFailed();
      const checkpoint: TargetDescriptor = {
        description: `Member record ${checkpointCell.name} checkpoint`, frame: memberFrame.name,
        strategies: [{ kind: 'css', selector: `${tableSelector} ${cellSelector}` }],
      };
      const described = await this.inner.describeTarget(checkpoint, remaining());
      const resolvedDescription = this.inner.lastResolvedFrame?.();
      const read = await this.inner.readText(described, remaining());
      const resolvedRead = this.inner.lastResolvedFrame?.();
      const visible = await this.inner.isTargetVisible(described, remaining());
      const resolvedVisibility = this.inner.lastResolvedFrame?.();
      if (read.text.trim() !== checkpointCell.expected || !visible || !resolvedDescription || !resolvedRead || !resolvedVisibility
        || !this.sameFrameRevision(memberFrame, resolvedDescription)
        || !this.sameFrameRevision(memberFrame, resolvedRead)
        || !this.sameFrameRevision(memberFrame, resolvedVisibility)
        || !this.sameFrameRevision(memberFrame, this.currentOpenShareFrame())) return this.openShareFrameFailed();
    }

    await this.captureOpenShareState(memberUrl, remaining());
    this.assertAutomation();
    const refreshed = this.openShareState!;
    const refreshedFrame = { ...refreshed.frame };
    await this.assertTrustedConditionsClear(refreshed.frame);
    const resume: TargetDescriptor = {
      description: 'Open New Share', frame: refreshed.frame.name,
      strategies: [{ kind: 'role', role: 'link', name: 'Open New Share' }],
    };
    await this.clickAction(resume, remaining(), 'reversible_write', true, {
      source: refreshedFrame, destination: openUrl,
    });
    this.assertAutomation();
    const restored = this.openShareState;
    const finalFrame = this.currentOpenShareFrame();
    if (!restored || restored.stage !== 'open-share' || !this.sameFrame(restored.frame, refreshedFrame)
      || restored.frame.navigation <= refreshedFrame.navigation || !this.sameFrameRevision(restored.frame, finalFrame)
      || !this.exactUrl(finalFrame.url, openUrl)) return this.openShareFrameFailed();
    await this.assertTrustedConditionsClear(finalFrame);
  }

  private async clickAction(t: TargetDescriptor, timeoutMs: number | undefined, risk: RiskClass, recovery = false, recoveryBoundary?: RecoveryClickBoundary): Promise<ResolutionReport> {
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
        this.preserveOperationState(this.inner.currentUrl());
        if (!this.inner.prepareClick) throw new Error('Profile requires live control inspection');
        const prepared = await this.inner.prepareClick(t, remaining());
        remaining();
        const live = await prepared.inspect(remaining());
        remaining();
        this.assertBoundOperationNavigation(live.destination);
        if (recoveryBoundary) this.assertRecoveryControl(live, recoveryBoundary);
        const transferDestination = this.runtime.transfer ? this.transferStage(live.destination) : undefined;
        if (this.runtime.transfer && (this.transferStage(live.url) || (transferDestination && transferDestination.stage !== 'member'))) this.assertTransferControl(live);
        const openShareDestination = this.runtime.openShare ? this.openShareStage(live.destination) : undefined;
        if (!recoveryBoundary && this.runtime.openShare && (this.openShareStage(live.url) || (openShareDestination && openShareDestination.stage !== 'member'))) this.assertOpenShareControl(live);
        const holdDestination = this.runtime.hold ? this.holdStage(live.destination) : undefined;
        if (this.runtime.hold && (this.holdStage(live.url) || (holdDestination && holdDestination.stage !== 'member'))) this.assertHoldControl(live);
        const signOn = new URL(live.destination).pathname === '/signon';
        if (signOn && this.signOnSubmitted) throw new Error('Mid-flow sign-on is not permitted');
        const rule = classify(this.runtime.profile, live, this.policy.allowedOrigins);
        const transferPost = TRANSFER_ROUTE.exec(this.path(live.destination))?.[2] === 'post';
        const openSharePost = OPEN_SHARE_ROUTE.exec(this.path(live.destination))?.[2] === 'post';
        const memberUpdatePost = this.runtime.artifact === 'meridian-update-member' && rule?.mutation === true
          && UPDATE_ROUTE.test(this.path(live.destination));
        const holdPost = !!this.runtime.hold && HOLD_ROUTE.exec(this.path(live.destination))?.[2] === 'post';
        const holdReview = this.runtime.hold && this.holdStage(live.url)?.stage === 'hold' && holdDestination?.stage === 'review';
        if (rule?.mutation) {
          this.assertMeridianMutationOrigin(live);
          this.assertCapabilityOperation(live.destination);
          if (this.runtime.transfer && !transferPost) throw new Error('Funds-transfer run cannot dispatch another operation');
          if (this.runtime.artifact === 'meridian-place-hold' && !this.runtime.hold) throw new Error('Canonical hold request is not bound');
        }
        if (transferPost) this.assertTransferReview(live);
        if (openSharePost) this.assertOpenShareReview(live);
        if (memberUpdatePost) this.assertMemberUpdateControl(live);
        if (holdReview) this.assertHoldNativeFacts(live);
        if (holdPost) this.assertHoldReview(live);
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
          if (this.runtime.openShare && this.openShareStage(live.url)) this.assertOpenShareControl(live);
          if (memberUpdatePost) this.assertMemberUpdateControl(live);
          if (this.runtime.hold && this.holdStage(live.url)) this.assertHoldControl(live);
          const refreshed = await prepared.inspect(remaining());
          remaining();
          if (JSON.stringify(refreshed) !== JSON.stringify(live)) throw new Error('Approval invalidated by changed page state');
          if (transferPost) {
            this.assertTransferReview(refreshed);
          }
          if (openSharePost) this.assertOpenShareReview(refreshed);
          if (memberUpdatePost) this.assertMemberUpdateControl(refreshed);
          if (holdPost) this.assertHoldReview(refreshed);
          if (transferPost || holdPost) {
            // This same-session UI reread narrows the approval-wait race. The
            // target remains responsible for enforcing eligibility atomically.
            if (transferPost) await this.refreshTransferEligibility(refreshed, remaining());
            else await this.refreshHoldEligibility(refreshed, remaining());
            const afterEligibility = await prepared.inspect(remaining());
            if (JSON.stringify(afterEligibility) !== JSON.stringify(refreshed)) throw new Error('Approval invalidated by changed page state');
            if (transferPost) this.assertTransferReview(afterEligibility);
            else this.assertHoldReview(afterEligibility);
          }
          this.assertAutomation();
          this.runtime.beforeDispatch(context);
          this.assertAutomation();
          if (memberUpdatePost) this.memberUpdateOrigin = new URL(refreshed.destination).origin;
          this.mutationDispatched = true;
          // Intent is durable before dispatch starts; this is NOT proof a POST reached the server.
          this.emit('mutation.intent', { effectiveRisk: 'irreversible' });
        } else {
          await outsideBudget(() => this.gate('click', risk, live.destination));
        }
        this.assertAutomation();
        if (recoveryBoundary) {
          const refreshed = await prepared.inspect(remaining());
          if (JSON.stringify(refreshed) !== JSON.stringify(live)) throw new Error('Recovery invalidated by changed page state');
          this.assertRecoveryControl(refreshed, recoveryBoundary);
        }
        if (signOn && live.submit) this.signOnSubmitted = true;
        const report = await prepared.dispatch(live, remaining());
        this.assertStillInBounds('click');
        if (this.mutationDispatched) this.transferEligibility = undefined;
        else if (this.runtime.transfer && MEMBER_ROUTE.test(this.path(this.inner.currentUrl()))) await this.captureTransferEligibility(this.inner.currentUrl(), remaining());
        else if (this.runtime.transfer && this.transferStage(this.inner.currentUrl())) this.advanceTransferState(this.inner.currentUrl(), live.frame);
        if (!this.mutationDispatched && this.runtime.openShare && MEMBER_ROUTE.test(this.path(this.inner.currentUrl()))) await this.captureOpenShareState(this.inner.currentUrl(), remaining());
        else if (!this.mutationDispatched && this.runtime.openShare && this.openShareStage(this.inner.currentUrl())) this.advanceOpenShareState(this.inner.currentUrl(), live.frame);
        if (!this.mutationDispatched && this.runtime.hold && MEMBER_ROUTE.test(this.path(this.inner.currentUrl()))) await this.captureHoldState(this.inner.currentUrl(), remaining());
        else if (!this.mutationDispatched && this.runtime.hold && this.holdStage(this.inner.currentUrl())) this.advanceHoldState(this.inner.currentUrl(), live.frame);
        this.preserveOperationState(this.inner.currentUrl());
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
      this.preserveOperationState(this.inner.currentUrl());
      return report;
    });
  }
  async fill(t: TargetDescriptor, value: string, timeoutMs?: number, risk: RiskClass = 'reversible_write'): Promise<ResolutionReport> {
    return this.action('fill', risk, async () => {
      this.preserveOperationState(this.inner.currentUrl());
      await this.gate('fill', risk);
      const report = await this.inner.fill(t, value, timeoutMs);
      this.assertStillInBounds('fill'); // change handlers can navigate in legacy apps
      this.preserveOperationState(this.inner.currentUrl());
      return report;
    });
  }
  async select(t: TargetDescriptor, value: string, timeoutMs?: number, risk: RiskClass = 'reversible_write', selectBy?: 'label' | 'value'): Promise<ResolutionReport> {
    return this.action('select', risk, async () => {
      this.preserveOperationState(this.inner.currentUrl());
      await this.gate('select', risk);
      const report = await this.inner.select(t, value, timeoutMs, risk, selectBy);
      this.assertStillInBounds('select'); // onchange submits are a legacy staple
      this.preserveOperationState(this.inner.currentUrl());
      return report;
    });
  }
  async readTable(t: TargetDescriptor, columns: TableColumn[], timeoutMs?: number, rowSelector?: string) {
    return this.action('extract', 'read', async () => {
      this.preserveOperationState(this.inner.currentUrl());
      await this.gate('extract', 'read');
      if (!this.inner.readTable) throw new Error('Table extraction unavailable');
      const rows = await this.inner.readTable(t, columns, timeoutMs, rowSelector);
      this.preserveOperationState(this.inner.currentUrl());
      return rows;
    });
  }
  async validateOpenShareCompletion(outputs: Record<string, OutputValue>): Promise<void> {
    const binding = this.runtime?.openShare;
    const state = this.openShareState;
    if (!binding || !state || !this.mutationDispatched || state.member !== binding.expected.member) throw new Error('Open-share completion is not bound to a dispatched request');
    const memberUrl = new URL(`/members/${binding.expected.member}`, state.frame.url).toString();
    await this.navigate(memberUrl);
    const before = this.currentOpenShareFrame();
    if (this.origin(before.url) !== this.origin(memberUrl) || this.path(before.url) !== this.path(memberUrl)) return this.openShareFrameFailed();
    const rows = await this.readTable({ ...binding.memberTable.target, frame: before.name }, binding.memberTable.columns, undefined, binding.memberTable.rowSelector);
    const resolved = this.inner.lastResolvedFrame?.();
    const after = this.currentOpenShareFrame();
    if (!resolved || !this.sameFrameRevision(before, resolved) || !this.sameFrameRevision(before, after)) return this.openShareFrameFailed();
    const shares = rows.map(row => {
      if (typeof row.shareId !== 'string' || typeof row.type !== 'string' || typeof row.balance !== 'string' || !row.shareId.trim()) throw new Error('Open-share resulting state is incomplete');
      return { shareId: row.shareId, type: row.type, deposit: row.balance, status: row.status };
    });
    if (new Set(shares.map(row => row.shareId)).size !== shares.length) throw new Error('Open-share resulting state is ambiguous');
    if (state.priorShareIds.some(id => !shares.some(row => row.shareId === id))) throw new Error('Open-share resulting state changed concurrently');
    const added = shares.filter(row => !state.priorShareIds.includes(row.shareId));
    if (added.length !== 1) throw new Error('Open-share resulting state is missing or ambiguous');
    if (added[0]!.status !== 'OPEN') throw new Error('Open-share resulting state is not OPEN');
    assertOpenShareResult(binding.expected, state.priorShareIds, {
      member: state.member, shareId: added[0]!.shareId,
      shareType: parseMemberTableShareType(added[0]!.type), deposit: added[0]!.deposit,
    }, outputs);
  }
  async validateMemberUpdateCompletion(outputs: Record<string, OutputValue>): Promise<void> {
    const binding = this.runtime?.memberUpdate;
    if (!binding || !this.memberUpdateOrigin || !this.mutationDispatched) throw new Error('Member-update completion is not bound to a dispatched request');
    if (Object.keys(outputs).length !== 1 || typeof outputs.saved !== 'string' || !outputs.saved.trim()) throw new Error('Member-update saved output is missing');
    const memberUrl = new URL(`/members/${binding.expected.member}`, this.memberUpdateOrigin).toString();
    const memberOrigin = new URL(memberUrl).origin;
    const sameOrigin = (url: string) => { try { return new URL(url).origin === memberOrigin; } catch { return false; } };
    await this.navigate(memberUrl);
    const before = this.inner.currentFrame?.();
    if (!before || !sameOrigin(before.url) || this.path(before.url) !== this.path(memberUrl)) throw new Error('Member-update read-back frame is unavailable');
    const rows = await this.readTable({ ...binding.contactTable.target, frame: before.name }, binding.contactTable.columns, undefined, binding.contactTable.rowSelector);
    const resolved = this.inner.lastResolvedFrame?.();
    const after = this.inner.currentFrame?.();
    if (!resolved || !sameOrigin(resolved.url) || !this.sameFrameRevision(before, resolved) || !this.sameFrameRevision(before, after) || this.path(resolved.url) !== this.path(memberUrl)) {
      throw new Error('Member-update read-back frame changed');
    }
    if (rows.length !== 1) throw new Error('Member-update resulting state is missing or ambiguous');
    const row = rows[0]!;
    const exact = (name: string) => {
      const value = row[name];
      if (typeof value !== 'string') throw new Error('Member-update resulting state is incomplete');
      return value;
    };
    if (exact('memberLabel') !== 'Member No.:' || exact('nameLabel') !== 'Name:' || !exact('name').trim()
      || exact('emailLabel') !== 'E-mail:' || exact('phoneLabel') !== 'Phone:' || exact('addressLabel') !== 'Address:') {
      throw new Error('Member-update contact table labels are missing or ambiguous');
    }
    assertMemberUpdateFacts({
      ...binding.expected,
      email: binding.expected.email.trim(),
      phone: binding.expected.phone.trim(),
      address: binding.expected.address.trim(),
    }, {
      member: exact('member'), email: exact('email'), phone: exact('phone'), address: exact('address'),
    });
  }
  async validateHoldCompletion(outputs: Record<string, OutputValue>): Promise<void> {
    const binding = this.runtime?.hold;
    const state = this.holdState;
    if (!binding || !state || !this.mutationDispatched || state.member !== binding.expected.member) throw new Error('Hold completion is not bound to a dispatched request');
    const memberUrl = new URL(`/members/${binding.expected.member}`, state.frame.url).toString();
    const boundOrigin = new URL(state.frame.url).origin;
    await this.navigate(memberUrl);
    const before = this.currentHoldFrame();
    if (new URL(before.url).origin !== boundOrigin || this.path(before.url) !== this.path(memberUrl)) return this.holdFrameFailed();
    const contacts = await this.readTable({ ...binding.contactTable.target, frame: before.name }, binding.contactTable.columns, undefined, binding.contactTable.rowSelector);
    const contactFrame = this.inner.lastResolvedFrame?.();
    if (!contactFrame || !this.sameFrameRevision(before, contactFrame) || !this.sameFrameRevision(before, this.currentHoldFrame())) return this.holdFrameFailed();
    if (contacts.length !== 1) throw new Error('Hold resulting member identity is missing or ambiguous');
    const contact = contacts[0]!;
    if (contact.memberLabel !== 'Member No.:' || contact.nameLabel !== 'Name:' || typeof contact.member !== 'string' || typeof contact.name !== 'string' || !contact.name.trim()) {
      throw new Error('Hold resulting member identity is incomplete');
    }
    const rows = await this.readTable({ ...binding.memberTable.target, frame: before.name }, binding.memberTable.columns, undefined, binding.memberTable.rowSelector);
    const shareFrame = this.inner.lastResolvedFrame?.();
    if (!shareFrame || new URL(shareFrame.url).origin !== boundOrigin || !this.sameFrameRevision(before, shareFrame) || !this.sameFrameRevision(before, this.currentHoldFrame()) || this.path(shareFrame.url) !== this.path(memberUrl)) return this.holdFrameFailed();
    const matches = rows.filter(row => row.shareId === binding.expected.share);
    if (matches.length !== 1 || typeof matches[0]!.status !== 'string') throw new Error('Hold resulting share is missing or ambiguous');
    assertHoldResult(binding.expected, { member: contact.member, share: matches[0]!.shareId as string, status: matches[0]!.status }, outputs);
  }
  async readText(t: TargetDescriptor, timeoutMs?: number) {
    return this.action('extract', 'read', async () => {
      this.preserveOperationState(this.inner.currentUrl());
      await this.gate('extract', 'read');
      const result = await this.inner.readText(t, timeoutMs);
      this.preserveOperationState(this.inner.currentUrl());
      return result;
    });
  }
}
