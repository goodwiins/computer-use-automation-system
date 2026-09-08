import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { completedActionReady, hasCurrentPublicIntervention, pending, segment, useRuns, type OperationContract, type Run } from './session';
import { EvidenceViewer } from './evidence';
import { RecordedTimeline } from './timeline';
import type { RecordedStructure } from '../../evidence/safe-event';
import { MERIDIAN_CAPABILITIES } from '../capability-labels.js';
import { capabilityLabel, displayValue, fieldLabel, isReadCapability, runPresentation } from './presentation';
import { ApiRequestError } from './transport';
import { ApprovalPanel } from './review';
const AVAILABILITY_STATES = new Set(['available', 'not_recorded', 'restricted', 'temporarily_unavailable']);
type InvocationAttempt = { capabilityId: string; body: string; role?: string; fingerprint: string; key: string; endpoint: 'invoke' | 'discover' };
type AttemptResult = { kind: 'accepted'; runId: string } | { kind: 'blocked' } | { kind: 'rejected' | 'uncertain'; message: string };
async function submitRetainedAttempt(
  retained: InvocationAttempt,
  lookupOnly: boolean,
  controls: Pick<ReturnType<typeof useRuns>, 'request' | 'beginAction' | 'markActionUncertain' | 'bindAction' | 'clearAction' | 'watch'>,
): Promise<AttemptResult> {
  if (!lookupOnly && !controls.beginAction({ kind: 'direct', key: retained.key, body: retained.body, capabilityId: retained.capabilityId }))
    return { kind: 'blocked' };
  try {
    const response = await controls.request(`/capabilities/${segment(retained.capabilityId)}/${retained.endpoint}`, {
      method: 'POST',
      body: lookupOnly ? JSON.stringify({ ...JSON.parse(retained.body), lookupOnly: true }) : retained.body,
      headers: { 'Idempotency-Key': retained.key },
    });
    const accepted: { runId: string } = await response.json();
    segment(accepted.runId);
    controls.bindAction(retained.key, accepted.runId, retained.capabilityId);
    controls.watch(accepted.runId);
    return { kind: 'accepted', runId: accepted.runId };
  } catch (error) {
    if (!lookupOnly && error instanceof ApiRequestError && error.invocationRejected) {
      controls.clearAction(retained.key);
      return { kind: 'rejected', message: `${error.message} This request was not accepted. Review the request before submitting again.` };
    }
    controls.markActionUncertain(retained.key);
    const message = error instanceof Error ? error.message : lookupOnly ? 'Lookup interrupted.' : 'Request interrupted.';
    return {
      kind: 'uncertain',
      message: lookupOnly
        ? message.includes('No accepted request found')
          ? 'No accepted request was found by this lookup. Acceptance of the original request remains unconfirmed. This lookup did not start an operation; refresh history before making a new request.'
          : `${message} Acceptance remains unconfirmed. Refresh history before taking further action.`
        : `${message} Acceptance is unconfirmed. Refresh history before taking further action.`,
    };
  }
}
export function OperatorSessionControls() {
  const { session } = useRuns();
  const [role, setRole] = useState<'TELLER' | 'SUPERVISOR'>('TELLER');
  return session.principal === 'operator' ? (
    <div className="direct-role-control">
      <label id="role-label" htmlFor="operator">Direct request role</label>
      <select name="operator" id="operator" value={role} onChange={event => setRole(event.target.value as 'TELLER' | 'SUPERVISOR')} aria-describedby="direct-role-note">
        <option value="TELLER">TELLER</option>
        <option value="SUPERVISOR">SUPERVISOR</option>
      </select>
      <p id="direct-role-note" className="muted">This role applies only to this direct request. Chat execution remains Teller; target session and branch are not verified here.</p>
      <p className="direct-role-summary" aria-live="polite"><strong>Direct request role:</strong> {role}</p>
    </div>
  ) : null;
}
export function CapabilityCatalog() {
  const {
    session,
    request,
    runs,
    watch,
    loading,
    error: historyError,
    actionHold,
    beginAction,
    markActionUncertain,
    bindAction,
    clearAction,
    abandonAction,
  } = useRuns();
  const [selected, setSelected] = useState(session.capabilities[0]?.id ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [acceptedId, setAcceptedId] = useState('');
  const [recoveryAvailable, setRecoveryAvailable] = useState(false);
  const unknownCapabilities = new Set(runs.filter(run => run.state === 'POST_OUTCOME_UNKNOWN').map(run => run.capability));
  const availability = session.availability;
  const meridianSession = session.readinessRequired !== false;
  const availabilityComplete = Array.isArray(availability)
    && MERIDIAN_CAPABILITIES.every(([id]) => availability.some(item => item.id === id && AVAILABILITY_STATES.has(item.state)));
  const metadataUnavailable = meridianSession && !availabilityComplete;
  const meridianAvailability = meridianSession
    ? MERIDIAN_CAPABILITIES.map(([id, label]) => availability?.find(item => item.id === id) ?? ({ id, label, state: undefined, reason: '' }))
    : [];
  const acceptedRun = runs.find((run) => run.runId === acceptedId);
  const active = useRef(false);
  const attempt = useRef<InvocationAttempt | undefined>(undefined);
  const visibleCapabilities = session.capabilities.filter(c => !availabilityComplete || availability.some(item => item.id === c.id));
  const capability = visibleCapabilities.find((c) => c.id === selected) ?? visibleCapabilities[0];
  const selectedStatus = capability ? availability?.find(item => item.id === capability.id) : undefined;
  const selectedUnavailable = metadataUnavailable || (meridianSession && selectedStatus?.state !== 'available');
  const recoveryPending = recoveryAvailable && Boolean(attempt.current);
  const ordinarySubmitBlocked = active.current || Boolean(acceptedId) || loading || Boolean(historyError)
    || recoveryPending || Boolean(actionHold);
  const acceptedCapabilityReady = Boolean(acceptedRun && attempt.current
    && acceptedRun.capability === attempt.current.capabilityId
    && completedActionReady(session, acceptedRun));
  async function submitAttempt(retained: InvocationAttempt, lookupOnly = false) {
    if (active.current || acceptedId || loading || historyError) return;
    active.current = true;
    setBusy(true);
    setRecoveryAvailable(false);
    setError('');
    try {
      const result = await submitRetainedAttempt(retained, lookupOnly, {
        request, beginAction, markActionUncertain, bindAction, clearAction, watch,
      });
      if (result.kind === 'accepted') setAcceptedId(result.runId);
      if (result.kind === 'rejected') {
        attempt.current = undefined;
        setRecoveryAvailable(false);
        setError(result.message);
      }
      if (result.kind === 'uncertain') {
        setRecoveryAvailable(true);
        setError(result.message);
      }
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  async function invoke(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!capability || ordinarySubmitBlocked || selectedUnavailable) return;
    const status = availability?.find(item => item.id === capability.id);
    if (meridianSession && (!status || status.state !== 'available')) {
      setError(status?.reason || 'Availability unavailable');
      return;
    }
    if (unknownCapabilities.has(capability.id)) {
      setError('This capability has an unknown posting outcome. Choose a separate read-only inquiry; do not retry it.');
      return;
    }
    const form = event.currentTarget;
    const data = new FormData(form);
    const args = Object.fromEntries(
      capability.parameters
        .filter((p) => p.required || data.get(p.name) !== '')
        .map((p) => [
          p.name,
          p.type === 'number' ? Number(data.get(p.name)) : String(data.get(p.name) ?? ''),
        ]),
    );
    const body = JSON.stringify({
      args,
      ...(session.principal === 'operator' ? { operator: data.get('operator') } : {}),
    });
    const fingerprint = capability.id + body;
    if (attempt.current?.fingerprint !== fingerprint) {
      attempt.current = {
        capabilityId: capability.id,
        body,
        role: session.principal === 'operator' ? String(data.get('operator') ?? '') : undefined,
        fingerprint,
        key: crypto.randomUUID(),
        endpoint: 'invoke',
      };
    }
    const nextAttempt = attempt.current;
    if (!nextAttempt) return;
    await submitAttempt(nextAttempt);
  }
  async function recover() {
    const retained = attempt.current;
    if (!recoveryAvailable || !retained) return;
    await submitAttempt(retained, true);
  }
  function startSeparateRequest() {
    if (busy || loading || historyError) return;
    setRecoveryAvailable(false);
    if (attempt.current) abandonAction(attempt.current.key);
    attempt.current = undefined;
    setError('');
  }
  return (
    <section aria-labelledby="catalog-heading">
      <h2 id="catalog-heading">Capability catalog</h2>
      <ul className="catalog">
        {meridianAvailability.map(({ id, label, state, reason }) => (
          <li key={id}>
            <span>{label}</span>
            <small>
              {metadataUnavailable ? 'Availability unavailable' : state === 'available'
                ? `Approved · available · ${session.capabilities.find((c) => c.id === id)?.version ?? 'recorded'}`
                : `${state === undefined ? 'Availability unavailable' : state} · ${reason}`}
            </small>
          </li>
        ))}
      </ul>
      <details>
        <summary>Invoke an approved capability directly</summary>
        {!capability ? (
          <p className="empty">No approved capabilities are available to this principal.</p>
        ) : (
          <form id="invoke" onSubmit={invoke} autoComplete="off">
            <fieldset disabled={busy || Boolean(acceptedId) || loading || Boolean(historyError) || metadataUnavailable}>
              <label htmlFor="capability">Capability</label>
              <select
                id="capability"
                value={selected}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setError('');
                }}
              >
                {visibleCapabilities.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.id} · {c.version}
                  </option>
                ))}
              </select>
              <p>{capability.description}</p>
              <div id="fields" key={selected}>
                {capability.parameters.map((p) => (
                  <label key={p.name}>
                    {p.name} — {p.description}
                    {p.enum ? (
                      <select name={p.name} required={p.required} disabled={selectedUnavailable}>
                        {p.enum.map((value) => (
                          <option key={value}>{value}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        name={p.name}
                        required={p.required}
                        type={p.type === 'number' ? 'number' : 'text'}
                        step={p.type === 'number' ? 'any' : undefined}
                        inputMode={p.format ? 'decimal' : undefined}
                        autoComplete="off"
                        disabled={selectedUnavailable}
                      />
                    )}
                  </label>
                ))}
              </div>
              <OperatorSessionControls />
              <button disabled={selectedUnavailable || ordinarySubmitBlocked}>{busy ? 'Submitting…' : 'Invoke capability'}</button>
            </fieldset>
          </form>
        )}
        {error && <p role="alert">{error}</p>}
        {recoveryAvailable && attempt.current && (
          <p>
            Acceptance is unconfirmed. The original request may still run or may have completed. Looking it up does not cancel it.
            <button
              type="button"
              disabled={busy || Boolean(acceptedId) || loading || Boolean(historyError)}
              onClick={() => void recover()}
            >
              Look up original request
            </button>
            <button
              type="button"
              disabled={busy || loading || Boolean(historyError)}
              onClick={startSeparateRequest}
            >
              Start a separate request
            </button>
          </p>
        )}
        {acceptedId && <p role="status">Accepted run: {acceptedId}. {acceptedRun ? 'Follow its authoritative state in run history.' : 'Waiting for authenticated run history; do not resubmit.'}</p>}
        {acceptedRun && !pending(acceptedRun) && (acceptedRun.state === 'POST_OUTCOME_UNKNOWN' || acceptedCapabilityReady) && (
          <button onClick={() => {
            if (acceptedRun.state !== 'POST_OUTCOME_UNKNOWN' && !acceptedCapabilityReady) return;
            if (attempt.current) clearAction(attempt.current.key);
            setAcceptedId('');
            attempt.current = undefined;
          }}>{acceptedRun.state === 'POST_OUTCOME_UNKNOWN' ? 'Choose a separate inquiry' : 'Start another invocation'}</button>
        )}
      </details>
    </section>
  );
}

const guidedOperationLabels = new Map([
  ['meridian-funds-transfer', 'Funds Transfer'],
  ['meridian-open-share', 'Open New Share'],
  ['meridian-update-member', 'Update Member Information'],
  ['meridian-place-hold', 'Place Account Hold'],
]);
const guidedFieldLabels = new Map([
  ['member', 'Member number'], ['sourceShare', 'From share'], ['destinationShare', 'To share'],
  ['amount', 'Amount'], ['memo', 'Memo'], ['shareType', 'Share type'], ['deposit', 'Initial deposit'],
  ['email', 'Email'], ['phone', 'Phone'], ['address', 'Mailing address'], ['share', 'Share'],
  ['reason', 'Reason code'], ['notes', 'Notes'],
]);
const enumLabels = new Map([
  ['S0001', 'Regular Shares'], ['S0070', 'Share Draft (Checking)'], ['MMKT', 'Money Market'], ['CERT', 'Certificate'],
  ['FRAUD', 'Fraud'], ['LEGAL', 'Legal'], ['DECEASED', 'Deceased'],
]);
type OperationRole = 'TELLER' | 'SUPERVISOR';
type GuidedPreview = { args: Record<string, string | number>; body: string; mode?: 'invoke' | 'discover'; role?: OperationRole };

export function GuidedOperations() {
  const controls = useRuns();
  const { session, runs, loading, error: historyError, actionHold } = controls;
  const prefix = useId().replace(/:/g, '');
  const contracts = session.operationContracts;
  const [selected, setSelected] = useState(contracts[0]?.id ?? '');
  const [preview, setPreview] = useState<GuidedPreview | undefined>(undefined);
  const [targetRole, setTargetRole] = useState<OperationRole>('TELLER');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [acceptedId, setAcceptedId] = useState('');
  const [trackedRunIds, setTrackedRunIds] = useState<string[]>([]);
  const [recoveryAvailable, setRecoveryAvailable] = useState(false);
  const active = useRef(false);
  const attempt = useRef<InvocationAttempt | undefined>(undefined);
  const contract = contracts.find(item => item.id === selected) ?? contracts[0];
  const status = contract ? session.availability?.find(item => item.id === contract.id) : undefined;
  const approved = contract ? session.capabilities.some(item => item.id === contract.id) : false;
  const unknown = contract ? runs.some(run => run.capability === contract.id && run.state === 'POST_OUTCOME_UNKNOWN') : false;
  const mode: 'invoke' | 'discover' | undefined = !contract || unknown ? undefined
    : status?.state === 'available' && approved ? 'invoke'
      : status?.state === 'not_recorded' && contract.discovery && session.principal === 'operator' ? 'discover'
        : undefined;
  const acceptedRun = runs.find(run => run.runId === acceptedId);
  const effectiveRole: OperationRole = contract?.id === 'meridian-place-hold' ? 'SUPERVISOR' : targetRole;
  useEffect(() => {
    const observed = runs.filter(run => guidedOperationLabels.has(run.capability) && pending(run)).map(run => run.runId);
    if (!observed.length) return;
    setTrackedRunIds(current => {
      const next = [...new Set([...current, ...observed])];
      return next.length === current.length ? current : next;
    });
  }, [runs]);
  const shownRunIds = [...new Set([
    ...trackedRunIds,
    ...runs.filter(run => guidedOperationLabels.has(run.capability) && run.state === 'POST_OUTCOME_UNKNOWN').map(run => run.runId),
    ...(acceptedId ? [acceptedId] : []),
  ])];
  const finishedDiscovery = acceptedRun?.kind === 'discovery' && !pending(acceptedRun)
    && acceptedRun.state !== 'POST_OUTCOME_UNKNOWN';
  const finishedInvocation = acceptedRun && completedActionReady(session, acceptedRun);
  const canRelease = acceptedRun?.state === 'POST_OUTCOME_UNKNOWN' || finishedDiscovery || finishedInvocation;
  const blocked = busy || loading || Boolean(historyError) || Boolean(actionHold);

  function readinessMessage(current?: OperationContract): string {
    if (!current) return 'Guided operation metadata is unavailable. Reconnect or refresh before preparing a request.';
    if (unknown) return 'This operation has an unknown posting outcome. Use a separate read-only inquiry; do not retry it.';
    if (!status) return 'Operation readiness is unavailable. Refresh before starting anything.';
    if (status.state === 'available' && !approved) return 'This operation is not authorized for the current session.';
    if (status.state === 'available') return 'An approved recording is available. Starting creates a run; final Save or Post still requires exact inline approval.';
    if (status.state === 'not_recorded' && !current.discovery) return 'No approved recording exists, and supervised discovery is not supported for this operation.';
    if (status.state === 'not_recorded' && session.principal !== 'operator') return 'Only an authenticated operator can start supervised discovery.';
    if (status.state === 'not_recorded') return 'No approved recording exists. An operator may explicitly start supervised discovery for a private draft.';
    return `${status.state}. ${status.reason || 'This operation cannot start now.'}`;
  }

  function resetPrepared() {
    if (recoveryAvailable || acceptedId) return;
    setPreview(undefined);
    attempt.current = undefined;
    setError('');
  }

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!contract || recoveryAvailable || acceptedId) return;
    const data = new FormData(event.currentTarget);
    const args = Object.fromEntries(contract.parameters.map(parameter => [
      parameter.name,
      parameter.type === 'number' ? Number(data.get(parameter.name)) : String(data.get(parameter.name) ?? ''),
    ]));
    const body = JSON.stringify({
      args,
      ...(session.principal === 'operator' ? { operator: effectiveRole } : {}),
    });
    const fingerprint = `${contract.id}:${mode ?? 'blocked'}:${body}`;
    if (mode && attempt.current?.fingerprint !== fingerprint) {
      attempt.current = {
        capabilityId: contract.id,
        body,
        role: session.principal === 'operator' ? effectiveRole : undefined,
        fingerprint,
        key: crypto.randomUUID(),
        endpoint: mode,
      };
    }
    if (!mode) attempt.current = undefined;
    setPreview({ args, body, mode, ...(session.principal === 'operator' ? { role: effectiveRole } : {}) });
    setError('');
  }

  async function start(lookupOnly = false) {
    const retained = attempt.current;
    if (!retained || active.current || acceptedId || loading || historyError) return;
    if (!lookupOnly && (retained.endpoint !== mode || actionHold)) {
      setError(actionHold ? 'Another operation request is unresolved. Resolve it before starting this request.' : 'Readiness changed. Review this request again before starting.');
      return;
    }
    active.current = true;
    setBusy(true);
    setRecoveryAvailable(false);
    setError('');
    try {
      const result = await submitRetainedAttempt(retained, lookupOnly, controls);
      if (result.kind === 'accepted') setAcceptedId(result.runId);
      if (result.kind === 'rejected') {
        attempt.current = undefined;
        setPreview(undefined);
        setError(result.message);
      }
      if (result.kind === 'uncertain') {
        setRecoveryAvailable(true);
        setError(result.message);
      }
    } finally {
      active.current = false;
      setBusy(false);
    }
  }

  function abandonUnconfirmed() {
    const retained = attempt.current;
    if (!retained || busy) return;
    controls.abandonAction(retained.key);
    attempt.current = undefined;
    setRecoveryAvailable(false);
    setPreview(undefined);
    setError('The original request may still run or may have completed. This local action did not cancel it.');
  }

  function releaseFinished() {
    if (!canRelease || !acceptedRun) return;
    if (attempt.current) controls.clearAction(attempt.current.key);
    attempt.current = undefined;
    setTrackedRunIds(current => current.filter(runId => runId !== acceptedId));
    setAcceptedId('');
    setPreview(undefined);
    setError(acceptedRun.state === 'POST_OUTCOME_UNKNOWN'
      ? 'The original run remains quarantined. No retry or cancellation was sent; use a separate read-only inquiry.'
      : acceptedRun.kind === 'discovery'
        ? 'Discovery finished. Its private draft is not an approved callable capability.'
        : 'The authoritative run is complete.');
  }

  return (
    <section className="guided-operations" aria-labelledby={`${prefix}-heading`}>
      <div className="section-title">
        <h3 id={`${prefix}-heading`}>Operations</h3>
        <span className="badge">Guided request</span>
      </div>
      {!contract ? <p className="warning">{readinessMessage()}</p> : <>
        <form onSubmit={review} autoComplete="off" onChange={resetPrepared}>
          <fieldset disabled={busy || Boolean(acceptedId) || recoveryAvailable}>
            <label htmlFor={`${prefix}-operation`}>Operation</label>
            <select id={`${prefix}-operation`} value={contract.id} onChange={event => {
              setSelected(event.target.value);
              setTargetRole(event.target.value === 'meridian-place-hold' ? 'SUPERVISOR' : 'TELLER');
              setPreview(undefined);
              attempt.current = undefined;
              setError('');
            }}>
              {contracts.map(item => <option key={item.id} value={item.id}>{guidedOperationLabels.get(item.id) ?? item.id}</option>)}
            </select>
            {session.principal === 'operator' && <div className="guided-field">
              <label htmlFor={`${prefix}-target-role`}>Target role</label>
              <select
                id={`${prefix}-target-role`}
                value={effectiveRole}
                disabled={contract.id === 'meridian-place-hold'}
                onChange={event => setTargetRole(event.target.value as OperationRole)}
              >
                <option value="TELLER">TELLER</option>
                <option value="SUPERVISOR">SUPERVISOR</option>
              </select>
              {contract.id === 'meridian-place-hold' && <span className="muted">Account holds require SUPERVISOR.</span>}
            </div>}
            <div className="guided-fields" key={contract.id}>
              {contract.parameters.map(parameter => {
                const id = `${prefix}-${parameter.name}`;
                const label = guidedFieldLabels.get(parameter.name) ?? fieldLabel(parameter.name);
                return <div className="guided-field" key={parameter.name}>
                  <label htmlFor={id}>{label}</label>
                  {parameter.enum ? <select id={id} name={parameter.name} required={parameter.required}>
                    <option value="">Choose {label.toLowerCase()}</option>
                    {parameter.enum.map(value => <option key={value} value={value}>{enumLabels.get(value) ? `${enumLabels.get(value)} (${value})` : value}</option>)}
                  </select> : <input
                    id={id}
                    name={parameter.name}
                    required={parameter.required}
                    type="text"
                    inputMode={parameter.format === 'positiveMoney' ? 'decimal' : undefined}
                    pattern={parameter.pattern ?? (parameter.format === 'positiveMoney' ? '^(?:0|[1-9][0-9]*)(?:\\.[0-9]{1,2})?$' : undefined)}
                    autoComplete="off"
                  />}
                </div>;
              })}
            </div>
            <button disabled={Boolean(preview) || recoveryAvailable}>Preview request</button>
          </fieldset>
        </form>
        <p className={mode ? 'muted' : 'warning'}>{readinessMessage(contract)}</p>
        {preview && <div className="operation-preview">
          <p className="eyebrow">Request preparation · This preview does not submit a transaction.</p>
          <h4>Request preview</h4>
          <dl className="review-facts">{contract.parameters.map(parameter => <div key={parameter.name}>
            <dt>{guidedFieldLabels.get(parameter.name) ?? fieldLabel(parameter.name)}</dt>
            <dd>{displayValue(parameter.name, preview.args[parameter.name])}</dd>
          </div>)}</dl>
          {session.principal === 'operator' && <p className="review-operator">
            Requested target role: {preview.role}. {contract.id === 'meridian-place-hold'
              ? session.supervisorVerified ? 'Supervisor context was verified at sign-on; native action facts still control final approval.'
                : 'This operator credential does not by itself verify the target role; native action facts must do so before final approval.'
              : 'Native action facts must verify the actual target session before final approval.'}
          </p>}
          <div className="actions">
            <button type="button" className="secondary" disabled={blocked} onClick={() => {
              if (recoveryAvailable || acceptedId) return;
              setPreview(undefined);
              attempt.current = undefined;
              setError('');
            }}>Edit request</button>
            {preview.mode && <button type="button" disabled={blocked} onClick={() => void start()}>
              {preview.mode === 'discover' ? 'Start supervised discovery' : 'Start operation'}
            </button>}
          </div>
        </div>}
        {error && <p role="alert">{error}</p>}
        {recoveryAvailable && attempt.current && <p>
          Acceptance is unconfirmed. Looking up the original request uses the same endpoint, facts, and key; it does not retry the operation.
          <button type="button" disabled={busy} onClick={() => void start(true)}>Look up original request</button>
          <button type="button" disabled={busy} onClick={abandonUnconfirmed}>Start a separate request</button>
        </p>}
        {acceptedId && <p role="status">Accepted run: {acceptedId}. Follow the authoritative state below; this preparation is not final Save or Post approval.</p>}
        {shownRunIds.map(runId => {
          const run = runs.find(candidate => candidate.runId === runId);
          const recoveredTerminal = runId !== acceptedId && run && !pending(run) && run.state !== 'POST_OUTCOME_UNKNOWN';
          return <div className="guided-run" key={runId}>
            <CapabilityRunCard runId={runId} inlineApproval />
            {recoveredTerminal && <button type="button" onClick={() => setTrackedRunIds(current => current.filter(id => id !== runId))}>Dismiss result</button>}
          </div>;
        })}
        {canRelease && <button type="button" onClick={releaseFinished}>{acceptedRun?.state === 'POST_OUTCOME_UNKNOWN'
          ? 'Choose a separate inquiry' : acceptedRun?.kind === 'discovery' ? 'Finish discovery' : 'Dismiss result'}</button>}
      </>}
    </section>
  );
}

function WithheldFields({ fields }: { fields: NonNullable<RecordedStructure['outputs']> }) {
  return <ul>{fields.map(field => <li key={field.name}>
    {field.name}: {field.type} — value withheld
    {field.columns && (field.columns.length ? <ul>{field.columns.map(column => <li key={column.name}>{column.name}: {column.type} — value withheld</li>)}</ul> : <p>No table columns were recorded.</p>)}
  </li>)}</ul>;
}

export function ResultCard({ run }: { run: Run }) {
  const { watched, error } = useRuns();
  const identity = !error && watched.has(run.runId) && !run.sensitiveValuesUnavailable ? run.memberIdentity : undefined;
  const presentation = runPresentation(run);
  if (run.state === 'POST_OUTCOME_UNKNOWN')
    return (
      <div className="warning">
        <strong>{presentation.label}</strong>
        <p>Posting outcome is unknown. Investigate with a separate read-only inquiry; do not retry.</p>
      </div>
    );
  const result = run.result;
  if (!result)
    return <p>{pending(run) || run.state === 'interrupted' ? presentation.description : 'No result was recorded.'}</p>;
  if (result.status === 'business_outcome')
    return (
      <div>
        <strong>{presentation.label}</strong>
        <p>{presentation.description}</p>
      </div>
    );
  if (result.status === 'failure')
    return (
      <div role="status">
        <strong>{presentation.label}</strong>
        <p>{presentation.description}</p>
      </div>
    );
  if (run.sensitiveValuesUnavailable && !result.outputs) return <div>
    {run.capability === 'meridian-member-record' && <p>Member identity unavailable.</p>}
    <p>Recorded output structure; values withheld.</p>
    {run.structure?.outputs ? <WithheldFields fields={run.structure.outputs} /> : <p>Output structure was not recorded or is unavailable.</p>}
  </div>;
  return (
    <div className="result">
      {run.capability === 'meridian-member-record' && <p aria-label="Member identity">
        {identity?.status === 'verified' && identity.memberNumber === run.inputs?.member
          ? <><strong>{identity.name}</strong> · Member {identity.memberNumber}</>
          : identity?.status === 'pending' ? 'Verifying member identity…' : 'Member identity unavailable.'}
      </p>}
      {Object.entries(result.outputs ?? {}).map(([name, value]) => (
        <div key={name}>
          <h4>{fieldLabel(name)}</h4>
          {Array.isArray(value) ? (
            <div className="table-scroll" role="region" aria-label={`${name} result table`} tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    {Object.keys(value[0] ?? {}).map((column) => (
                      <th scope="col" key={column}>
                        {fieldLabel(column)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {value.map((row, index) => (
                    <tr key={index}>
                      {Object.keys(value[0] ?? {}).map((column) => (
                        <td key={column}>{displayValue(column, row[column])}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!value.length && <p>No rows.</p>}
            </div>
          ) : (
            <p className="output">{displayValue(name, value)}</p>
          )}
        </div>
      ))}
    </div>
  );
}
export function EscalationCard({ run }: { run: Run }) {
  return <ReviewRequestButton run={run} />;
}
function ReviewRequestButton({ run }: { run: Run }) {
  const { openReview, session } = useRuns();
  if (!run.intervention || run.state !== 'awaiting-human') return null;
  if (session.principal === 'operator' && !hasCurrentPublicIntervention(run)) return null;
  return <button type="button" className="secondary review-request" onClick={() => openReview(run.runId)}>Review request</button>;
}
export function RunDetail({ run }: { run: Run }) {
  const [open, setOpen] = useState(false);
  return (
    <details onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Run details and evidence</summary>
      {open && (
        <>
          {run.inputs ? <pre>{JSON.stringify({ inputs: run.inputs }, null, 2)}</pre> : <div>
            <p>Recorded input structure; values withheld.</p>
            {run.structure?.inputs ? run.structure.inputs.length ? <WithheldFields fields={run.structure.inputs} /> : <p>No public inputs were recorded for this run.</p> : <p>Input structure was not recorded or is unavailable.</p>}
          </div>}
          <pre aria-label="Raw run details">{JSON.stringify({ runId: run.runId, capability: run.capability, version: run.version, state: run.state, step: run.step, finishedAt: run.finishedAt, result: run.result }, null, 2)}</pre>
          <RecordedTimeline key={run.runId} run={run} />
          <EvidenceViewer run={run} />
        </>
      )}
    </details>
  );
}
export function CapabilityRunCard({ runId, detail = false, inlineApproval = false }: { runId: string; detail?: boolean; inlineApproval?: boolean }) {
  const { session, runs, error, refresh } = useRuns();
  const run = runs.find((r) => r.runId === runId);
  if (!run)
    return (
      <article data-run-id={runId}>
        <h3>Accepted run</h3>
        <p>{runId}</p>
        <p>Fetching authoritative run state…</p>
        {error && <p role="alert">{error}</p>}
        <button onClick={() => void refresh()}>Refresh run state</button>
      </article>
    );
  return (
    <article data-run-id={run.runId}>
      <div className="run-title">
        <h3>{capabilityLabel(run.capability)}</h3>
        <span className="badge" role="status" aria-live="polite" aria-atomic="true">
          <span className="sr-only">{run.capability}, run {run.runId}, state {run.state}: </span>
          {runPresentation(run).label}
        </span>
      </div>
      <p className="muted">
        {run.kind}
        {run.version ? ` · v${run.version}` : ''} · {run.runId}
      </p>
      {run.step && <p>Current step: {run.step}</p>}
      {run.state === 'success' && run.finishedAt && isReadCapability(run.capability) && !run.sensitiveValuesUnavailable && (
        <p>Read completed at {new Date(run.finishedAt).toLocaleString()}</p>
      )}
      {Number.isFinite(run.elapsedMs) && run.elapsedMs! >= 0 && (
        <p>
          Elapsed: {run.elapsedMs! < 1000 ? `${run.elapsedMs} ms` : `${(run.elapsedMs! / 1000).toFixed(1)} s`}
        </p>
      )}
      {run.sensitiveValuesUnavailable && <p>Historical sensitive values are unavailable.</p>}
      <ResultCard run={run} />
      {error && (
        <p role="status" className="warning">
          Run updates disconnected; last confirmed state shown.
        </p>
      )}
      {inlineApproval && session.principal === 'operator' && run.state === 'awaiting-human'
        && run.intervention && 'id' in run.intervention && run.intervention.request.kind === 'risk_approval'
        && <ApprovalPanel run={run} intervention={run.intervention} inline />}
      <ReviewRequestButton run={run} />
      {detail && (
        <>
          <RunDetail run={run} />
        </>
      )}
    </article>
  );
}
export function RunHistory() {
  const { session, runs, loading, error, refresh } = useRuns();
  const operator = session.principal === 'operator';
  const [filter, setFilter] = useState<'needs-review' | 'all'>(operator ? 'needs-review' : 'all');
  const needsReview = runs.filter(hasCurrentPublicIntervention);
  const visibleRuns = operator && filter === 'needs-review' ? needsReview : runs;
  const tabRefs = useRef<Partial<Record<'needs-review' | 'all', HTMLButtonElement>>>({});
  useEffect(() => {
    if (!operator) setFilter('all');
  }, [operator]);
  function moveFilter(current: 'needs-review' | 'all') {
    const next = current === 'needs-review' ? 'all' : 'needs-review';
    setFilter(next);
    tabRefs.current[next]?.focus();
  }
  function onFilterKeyDown(event: KeyboardEvent<HTMLButtonElement>, current: 'needs-review' | 'all') {
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      moveFilter(current);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveFilter(current);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const next = event.key === 'Home' ? 'needs-review' : 'all';
      setFilter(next);
      tabRefs.current[next]?.focus();
    }
  }
  return (
    <section className="wide" aria-labelledby="history-heading">
      <div className="section-title">
        <div>
          <h2 id="history-heading">{operator ? 'Operator Activity' : 'Run history'}</h2>
          <p>{operator ? 'Review requests first, then browse recent authenticated runs.' : 'Recent authoritative discovery and replay records.'}</p>
          <p>History returns up to 100 recent records, prioritizing pending reviews. Up to 32 followed runs, including the current action and open review, remain visible; older records are retained.</p>
        </div>
        <button id="refresh" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      {operator ? (
        <>
          <p className="operator-support">Cross-person supervisor assignment or handoff is unavailable without an explicit assignment grant and verified target context.</p>
          <div className="activity-filter" role="tablist" aria-label="Activity filter">
            <button
              type="button"
              role="tab"
              id="activity-filter-needs-review"
              aria-controls="runs"
              aria-selected={filter === 'needs-review'}
              ref={element => { if (element) tabRefs.current['needs-review'] = element; }}
              onClick={() => setFilter('needs-review')}
              onKeyDown={event => onFilterKeyDown(event, 'needs-review')}
            >
              Needs review ({needsReview.length})
            </button>
            <button
              type="button"
              role="tab"
              id="activity-filter-all"
              aria-controls="runs"
              aria-selected={filter === 'all'}
              ref={element => { if (element) tabRefs.current.all = element; }}
              onClick={() => setFilter('all')}
              onKeyDown={event => onFilterKeyDown(event, 'all')}
            >
              All runs ({runs.length})
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="caller-support">If this request needs an operator, it will remain waiting here.</p>
          <p className="caller-support">Operator takeover or cross-person handoff is not available from caller access.</p>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">Loading authenticated history…</p>}
      {!loading && !visibleRuns.length && (
        <p className="empty">{operator && filter === 'needs-review' ? 'No requests currently need review.' : 'No visible runs. Send a request to start an available capability.'}</p>
      )}
      <div id="runs" role={operator ? 'tabpanel' : undefined} aria-labelledby={operator ? `activity-filter-${filter}` : undefined}>
        {[...visibleRuns].reverse().map((run) => (
          <CapabilityRunCard key={run.runId} runId={run.runId} detail />
        ))}
      </div>
    </section>
  );
}
