import { randomUUID } from 'node:crypto';
import { ControlSession, type InterventionRequest } from '../escalation/session.js';
import { Redactor } from '../safety/redact.js';
import { RequestError } from './journal.js';

export interface ActionContext {
  runId: string; artifact: string; version: string; stepId: string;
  destination: string; method: string; operator: string; branch: string; role: string;
  visibleFacts?: Record<string, string>; businessValues?: string[];
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

/** A copy for human review; native facts remain private and unchanged for dispatch checks. */
export function publicIntervention(pending: PendingIntervention, secrets = new Redactor()): PendingIntervention {
  const { visibleFacts, businessValues, ...action } = pending.action ?? {};
  const redactor = secrets.forVisibleValues(businessValues ?? []);
  const safeUrl = (value: string) => {
    try {
      const url = new URL(value);
      url.username = ''; url.password = '';
      const safe = (text: string) => redactor.redactUrlComponent(text);
      const safeQuery = (query: string) => new URLSearchParams(Array.from(new URLSearchParams(query), ([key, value]) =>
        [redactor.redactString(key), /token|password|secret|cookie|authorization/i.test(key) ? '•••redacted•••' : redactor.redactString(value)])).toString();
      if (url.search) url.search = safeQuery(url.search);
      const hashQuery = url.hash.indexOf('?');
      const hash = hashQuery >= 0 ? `${safe(url.hash.slice(0, hashQuery))}?${safeQuery(url.hash.slice(hashQuery + 1))}`
        : /^[^=&/?#]+=[\s\S]*$/.test(url.hash.slice(1)) ? `#${safeQuery(url.hash.slice(1))}` : safe(url.hash);
      return `${redactor.redactString(url.origin)}${safe(url.pathname)}${url.search}${hash}`;
    } catch { return '(unavailable)'; }
  };
  return {
    ...pending,
    request: { ...redactor.redact(pending.request), url: safeUrl(pending.request.url) },
    ...(pending.action ? { action: { ...redactor.redact(action) as ActionContext,
      destination: safeUrl(pending.action.destination),
      facts: Object.fromEntries(Object.entries(visibleFacts ?? {})
        .filter(([key]) => !/token|password|secret|cookie|authorization|body/i.test(key))
        .map(([key, value]) => [redactor.redactString(key), redactor.redactString(value)])),
    } } : {}),
  };
}
