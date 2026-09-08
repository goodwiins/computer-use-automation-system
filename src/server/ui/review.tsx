import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { fieldLabel, displayValue } from './presentation';
import { pending, segment, useRuns, type Run, type ReviewAttempt } from './session';

type PublicIntervention = Extract<NonNullable<Run['intervention']>, { id: string }>;
type PublicAction = NonNullable<PublicIntervention['action']>;

function interventionOf(run?: Run): PublicIntervention | undefined {
  const intervention = run?.intervention;
  return intervention && 'id' in intervention ? intervention : undefined;
}

function confirmLabel(capability?: string): string {
  switch (capability) {
    case 'meridian-funds-transfer': return 'Confirm transfer';
    case 'meridian-open-share': return 'Confirm open share';
    case 'meridian-update-member': return 'Confirm contact update';
    case 'meridian-place-hold': return 'Confirm hold';
    default: return 'Confirm request';
  }
}

function hasActionContext(action: PublicAction | undefined, run: Run, intervention: PublicIntervention): action is PublicAction {
  if (!action || typeof action !== 'object') return false;
  return action.runId === run.runId
    && action.artifact === run.capability
    && action.version === run.version
    && [action.stepId, action.destination, action.method, action.operator, action.branch, action.role, action.control]
      .every(value => typeof value === 'string' && value.trim().length > 0)
    && typeof action.facts === 'object' && action.facts !== null
    && !Array.isArray(action.facts)
    && Object.keys(action.facts).length > 0
    && action.artifact === intervention.request.capability;
}

function ReviewFacts({ action }: { action: PublicAction }) {
  const facts = Object.entries(action.facts ?? {});
  return facts.length ? (
    <dl className="review-facts">
      {facts.map(([name, value]) => (
        <div key={name}>
          <dt>{fieldLabel(name)}</dt>
          <dd>{displayValue(name, value)}</dd>
        </div>
      ))}
    </dl>
  ) : <p className="muted">No public action facts are available.</p>;
}

function ReviewDetails({ run, intervention }: { run: Run; intervention: PublicIntervention }) {
  const action = intervention.action;
  return (
    <details className="review-details">
      <summary>Details</summary>
      <dl>
        <div><dt>Run</dt><dd>{run.runId}</dd></div>
        <div><dt>Capability</dt><dd>{intervention.request.capability}</dd></div>
        {action && <>
          <div><dt>Artifact</dt><dd>{action.artifact}</dd></div>
          <div><dt>Version</dt><dd>{action.version}</dd></div>
          <div><dt>Step</dt><dd>{action.stepId}</dd></div>
          <div><dt>Method</dt><dd>{action.method}</dd></div>
          <div><dt>Destination</dt><dd>{action.destination}</dd></div>
          <div><dt>Control</dt><dd>{action.control}</dd></div>
        </>}
      </dl>
    </details>
  );
}

export function ApprovalPanel({ run, intervention }: { run: Run; intervention: PublicIntervention }) {
  const { request, refresh, refreshVersion, error: connectionError, getReviewAttempt, updateReviewAttempt } = useRuns();
  const [now, setNow] = useState(Date.now());
  const key = `${run.runId}:${intervention.id}`;
  const attempt: ReviewAttempt = getReviewAttempt(key);
  const approval = intervention.request.kind === 'risk_approval';
  const expired = now >= intervention.expiresAt;
  const action = intervention.action;
  const submitted = useRef<HTMLParagraphElement>(null);
  const actionContextValid = hasActionContext(action, run, intervention);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useLayoutEffect(() => {
    if (attempt.sent) submitted.current?.focus();
  }, [attempt.sent]);
  useEffect(() => {
    if (!attempt.uncertain) return;
    if (!attempt.probing && attempt.probeSettled && attempt.probeVersion === refreshVersion) return;
    if (attempt.probing && !attempt.probeSettled) return;
    if (attempt.probing && attempt.probeSettled && attempt.probeVersion === refreshVersion) return;
    if (attempt.probing && attempt.probeSettled && attempt.probeVersion !== refreshVersion) {
      updateReviewAttempt(key, { probing: false });
      return;
    }
    const originalRunId = run.runId;
    const originalInterventionId = intervention.id;
    updateReviewAttempt(key, { probing: true, probeSettled: false, probeVersion: refreshVersion });
    void request(`/runs/${segment(originalRunId)}`).then(response => response.json()).then((current: Run) => {
      const currentIntervention = interventionOf(current);
      if (current.runId === originalRunId && current.state === 'awaiting-human'
        && currentIntervention?.id === originalInterventionId && Date.now() < currentIntervention.expiresAt) {
        updateReviewAttempt(key, {
          uncertain: false,
          locked: false,
          sent: false,
          error: 'The server confirms this intervention is still pending. You may choose a decision again.',
        });
      }
    }).catch(() => { /* Keep the exact intervention locked until the next explicit refresh. */ })
      .finally(() => updateReviewAttempt(key, { probeSettled: true }));
  }, [attempt.uncertain, attempt.probing, attempt.probeVersion, intervention.id, key, refreshVersion, request, run.runId, updateReviewAttempt]);
  async function decide(decision: 'approve' | 'retry' | 'abort') {
    const originalRunId = run.runId;
    const originalInterventionId = intervention.id;
    const current = getReviewAttempt(key);
    if (connectionError || current.locked || (decision === 'approve' && !actionContextValid)) return;
    updateReviewAttempt(key, { locked: true, sent: true, error: undefined });
    try {
      await request(`/runs/${segment(originalRunId)}/decision`, {
        method: 'POST',
        body: JSON.stringify({ approvalId: originalInterventionId, decision }),
      });
    } catch (e) {
      updateReviewAttempt(key, {
        uncertain: true,
        probing: false,
        probeSettled: true,
        probeVersion: refreshVersion,
        error: `${e instanceof Error ? e.message : 'Decision response unavailable.'} Refresh to inspect authoritative state.`,
      });
    } finally {
      await refresh();
    }
  }
  return (
    <section className="approval" aria-label={approval ? 'Operator approval' : 'Operator repair'}>
      <h3>{approval ? 'Operator approval required' : 'Operator repair required'}</h3>
      <p>{intervention.request.reason}</p>
      <p>{expired ? 'Intervention expired.' : `Expires ${new Date(intervention.expiresAt).toLocaleString()}`}</p>
      {approval && action ? (
        <>
          <h4>Review the exact request</h4>
          <ReviewFacts action={action} />
          {actionContextValid ? (
            <p className="review-operator">Target session: Verified for this run · Branch: {action.branch} · Operator {action.operator} · Role {action.role}</p>
          ) : (
            <p className="review-operator">Target session: Not verified · Branch: Not verified</p>
          )}
        </>
      ) : approval ? <p className="warning">Confirmation is unavailable until the server provides the exact action context.</p>
        : <>
          <p>Repair the active browser session, then request one bounded retry.</p>
          <dl className="review-facts">
            <div><dt>Step</dt><dd>{run.step}</dd></div>
            <div><dt>Page</dt><dd>{intervention.request.url}</dd></div>
          </dl>
        </>}
      <ReviewDetails run={run} intervention={intervention} />
      <div className="actions">
        <button
          disabled={Boolean(connectionError) || attempt.sent || attempt.locked || (approval && !actionContextValid)}
          onClick={() => void decide(approval ? 'approve' : 'retry')}
        >
          {approval ? confirmLabel(intervention.request.capability) : 'Retry after repair'}
        </button>
        <button
          className="abort"
          disabled={Boolean(connectionError) || attempt.sent || attempt.locked}
          onClick={() => void decide('abort')}
        >
          {approval ? 'Refuse request' : 'Stop request'}
        </button>
      </div>
      {attempt.sent && <p ref={submitted} role="status" tabIndex={-1}>Decision submitted. Waiting for authoritative run updates.</p>}
      {attempt.error && <p role="alert">{attempt.error}</p>}
    </section>
  );
}

export function ReviewDialog() {
  const { session, runs, reviewRunId, closeReview } = useRuns();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const run = runs.find(candidate => candidate.runId === reviewRunId);
  const intervention = interventionOf(run);
  const reviewIdentity = reviewRunId && intervention ? `${reviewRunId}:${intervention.id}` : reviewRunId;
  useLayoutEffect(() => {
    if (reviewIdentity && dialog.current?.open) heading.current?.focus();
  }, [reviewIdentity]);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (!reviewRunId) {
      if (element.open) element.close();
      return;
    }
    if (!element.open) element.showModal();
    heading.current?.focus();
  }, [reviewRunId]);
  return (
    <dialog
      ref={dialog}
      className="review-dialog"
      aria-labelledby="review-dialog-heading"
      data-run-id={reviewRunId}
      onCancel={event => { event.preventDefault(); closeReview(); }}
      onClose={() => { if (reviewRunId) closeReview(); }}
    >
      <div className="review-dialog-header">
        <h2 id="review-dialog-heading" ref={heading} tabIndex={-1}>Review request</h2>
        <button type="button" className="secondary" onClick={closeReview}>Close</button>
      </div>
      {!run ? <p role="status">This run is unavailable from the current authenticated session.</p>
        : session.principal !== 'operator' || run.state !== 'awaiting-human' || !intervention ? (
          <p className="waiting-review" role="status">
            {pending(run) ? 'Waiting for an operator to review this request.' : 'This request is no longer pending.'}
          </p>
        ) : (
          <ApprovalPanel run={run} intervention={intervention} />
        )}
    </dialog>
  );
}
