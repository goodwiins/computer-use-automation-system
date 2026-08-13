// The replay result contract. The central distinction — the one the brief
// calls "the most common design mistake" — is that a business outcome
// ("no such member") is a first-class *answer*, not a failure. Callers
// branch on `status`; only `failure` means the capability itself broke.

export interface StepFailure {
  stepId: string;
  intent: string;
  expected: string;
  observed: string;
  screenshot?: string;
}

export type ReplayResult =
  | {
      status: 'success';
      outputs: Record<string, string>;
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
