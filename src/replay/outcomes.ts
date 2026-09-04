import type { OutputValue } from '../artifact/schema.js';

export class InsufficientFundsError extends Error {
  readonly outcomeCode = 'INSUFFICIENT_FUNDS';
  constructor() {
    super('Insufficient available balance in the source share.');
    this.name = 'InsufficientFundsError';
  }
}
// The replay result contract. The central distinction — the one the brief
// calls "the most common design mistake" — is that a business outcome
// ("no such member") is a first-class *answer*, not a failure. Callers
// branch on `status`; only `failure` means the capability itself broke.

export interface StepFailure {
  code?: string;
  stepId: string;
  intent: string;
  expected: string;
  observed: string;
  screenshot?: string;
}

export type ReplayResult =
  | {
      status: 'success';
      outputs: Record<string, OutputValue>;
      runId: string;
      evidenceDir: string;
      recoveries: string[]; // detector ids recovered from along the way
    }
  | {
      status: 'business_outcome';
      outcomeCode: string; // e.g. NO_SUCH_MEMBER, VALIDATION_REJECTED
      detail: string;
      runId: string;
      evidenceDir: string;
      recoveries: string[];
    }
  | {
      status: 'failure';
      failure: StepFailure;
      escalated: boolean; // was a human brought in (and it still couldn't finish)?
      runId: string;
      evidenceDir: string;
      recoveries: string[];
    };
