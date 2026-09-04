import { randomUUID } from 'node:crypto';
import { ControlSession, type InterventionRequest } from '../escalation/session.js';
import { RequestError } from './journal.js';

export interface ActionContext {
  runId: string; artifact: string; version: string; stepId: string;
  destination: string; method: string; operator: string; branch: string; role: string;
  facts: Record<string, string>; tokenPresent: boolean; control: string;
}
export interface PendingIntervention {
  id: string; expiresAt: number; request: InterventionRequest; action?: ActionContext;
}
export class Approval {
  pending?: PendingIntervention;
  private resolve?: (decision: 'approve' | 'retry' | 'abort') => void;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private session: ControlSession, private changed: () => void, private deadline: number) {}
  wait(request: InterventionRequest, action?: ActionContext): Promise<'approve' | 'retry' | 'abort'> {
    if (this.pending) throw new RequestError(409, 'An intervention is already pending');
    if (Date.now() >= this.deadline) return Promise.resolve('abort');
    this.pending = { id: randomUUID(), expiresAt: Math.min(this.deadline, Date.now() + 300_000), request, action };
    this.session.transfer('human', request.kind);
    const promise = new Promise<'approve' | 'retry' | 'abort'>(resolve => { this.resolve = resolve; });
    this.timer = setTimeout(() => this.cancel(), this.pending.expiresAt - Date.now());
    this.changed(); return promise;
  }
  decide(id: string, decision: 'approve' | 'retry' | 'abort') {
    const pending = this.pending;
    if (!pending || id !== pending.id) throw new RequestError(409, 'Stale or duplicate decision');
    if (Date.now() >= pending.expiresAt) { this.cancel(); throw new RequestError(409, 'Intervention expired'); }
    if (decision !== 'abort' && decision !== (pending.request.kind === 'risk_approval' ? 'approve' : 'retry')) throw new RequestError(409, 'Decision does not match intervention');
    this.finish(decision);
  }
  cancel() { if (this.pending) this.finish('abort'); }
  private finish(decision: 'approve' | 'retry' | 'abort') {
    clearTimeout(this.timer);
    const resolve = this.resolve;
    this.pending = undefined; this.resolve = undefined;
    this.session.transfer('automation', decision); this.changed(); resolve?.(decision);
  }
}
