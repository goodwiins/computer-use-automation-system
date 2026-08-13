// Control-transfer model. At any moment exactly one party owns the live
// session: automation or a human operator. Transitions are explicit and
// logged — "who is in control" is never ambiguous.
//
//   automation --escalate--> human --resume/abort--> automation
//
// The seam this creates: automation must be able to pause (stop issuing
// actions), cede (human drives the SAME browser session), and resume
// (automation re-verifies state before continuing).

export type ControlOwner = 'automation' | 'human';

export interface InterventionRequest {
  kind: 'discovery_stuck' | 'replay_stuck' | 'risk_approval';
  capability: string;
  goal: string;
  stepId?: string;
  reason: string;
  url: string;
  screenshot?: string;
}

/**
 * What the human decided after (optionally) operating the session:
 *  - retry: automation should re-attempt the step it was stuck on
 *  - skip:  the human performed the step manually; continue after it
 *  - abort: stop the run
 */
export type InterventionDecision = 'retry' | 'skip' | 'abort';

export class ControlSession {
  private owner: ControlOwner = 'automation';
  private readonly transitions: Array<{ ts: string; from: ControlOwner; to: ControlOwner; reason: string }> = [];

  constructor(private readonly onTransition?: (t: { from: ControlOwner; to: ControlOwner; reason: string }) => void) {}

  get currentOwner(): ControlOwner {
    return this.owner;
  }

  transfer(to: ControlOwner, reason: string): void {
    if (to === this.owner) throw new Error(`Session already controlled by ${to}`);
    const t = { ts: new Date().toISOString(), from: this.owner, to, reason };
    this.transitions.push(t);
    this.owner = to;
    this.onTransition?.(t);
  }

  history() {
    return [...this.transitions];
  }
}
