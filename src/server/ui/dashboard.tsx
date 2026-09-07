import { useEffect, useRef, useState, type FormEvent } from 'react';
import { pending, segment, useRuns, type Run } from './session';
import { EvidenceViewer } from './evidence';
import { RecordedTimeline } from './timeline';
import type { RecordedStructure } from '../../evidence/safe-event';

const requested = [
  ['meridian-sign-on', 'Sign on'],
  ['meridian-member-inquiry', 'Member inquiry'],
  ['meridian-member-record', 'Member record'],
  ['meridian-funds-transfer', 'Funds transfer'],
  ['meridian-open-share', 'Open share'],
  ['meridian-update-member', 'Update contact'],
  ['meridian-place-hold', 'Supervisor hold'],
];
export function OperatorSessionControls() {
  const { session } = useRuns();
  return session.principal === 'operator' ? (
    <label id="role-label">
      Execution role
      <select name="operator" id="operator">
        <option>TELLER</option>
        <option>SUPERVISOR</option>
      </select>
    </label>
  ) : null;
}
export function CapabilityCatalog() {
  const { session, request, runs, watch, loading, error: historyError } = useRuns();
  const [selected, setSelected] = useState(session.capabilities[0]?.id ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [acceptedId, setAcceptedId] = useState('');
  const unknownCapabilities = new Set(runs.filter(run => run.state === 'POST_OUTCOME_UNKNOWN').map(run => run.capability));
  const acceptedRun = runs.find((run) => run.runId === acceptedId);
  const active = useRef(false);
  const attempt = useRef<{ fingerprint: string; key: string } | undefined>(undefined);
  const capability = session.capabilities.find((c) => c.id === selected);
  async function invoke(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!capability || active.current || acceptedId || loading || historyError) return;
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
    if (attempt.current?.fingerprint !== fingerprint)
      attempt.current = { fingerprint, key: crypto.randomUUID() };
    active.current = true;
    setBusy(true);
    setError('');
    try {
      const response = await request(`/capabilities/${segment(capability.id)}/invoke`, {
        method: 'POST',
        body,
        headers: { 'Idempotency-Key': attempt.current.key },
      });
      const accepted: { runId: string } = await response.json();
      segment(accepted.runId);
      setAcceptedId(accepted.runId);
      watch(accepted.runId);
    } catch (e) {
      setError(
        `${e instanceof Error ? e.message : 'Request interrupted.'} If the outcome is uncertain, refresh history. Resubmitting unchanged inputs uses the same request key.`,
      );
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="catalog-heading">
      <h2 id="catalog-heading">Capability catalog</h2>
      <ul className="catalog">
        {requested.map(([id, label]) => (
          <li key={id}>
            <span>{label}</span>
            <small>
              {session.capabilities.some((c) => c.id === id)
                ? `Approved · available · ${session.capabilities.find((c) => c.id === id)!.version}`
                : 'Missing or not authorized'}
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
            <fieldset disabled={busy || Boolean(acceptedId) || loading || Boolean(historyError)}>
              <label htmlFor="capability">Capability</label>
              <select
                id="capability"
                value={selected}
                onChange={(e) => {
                  setSelected(e.target.value);
                  setError('');
                }}
              >
                {session.capabilities.map((c) => (
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
                      <select name={p.name} required={p.required}>
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
                      />
                    )}
                  </label>
                ))}
              </div>
              <OperatorSessionControls />
              <button>{busy ? 'Submitting…' : 'Invoke capability'}</button>
            </fieldset>
          </form>
        )}
        {error && <p role="alert">{error}</p>}
        {acceptedId && <p role="status">Accepted run: {acceptedId}. {acceptedRun ? 'Follow its authoritative state in run history.' : 'Waiting for authenticated run history; do not resubmit.'}</p>}
        {acceptedRun && !pending(acceptedRun) && (
          <button onClick={() => {
            setAcceptedId('');
            attempt.current = undefined;
          }}>{acceptedRun.state === 'POST_OUTCOME_UNKNOWN' ? 'Choose a separate inquiry' : 'Start another invocation'}</button>
        )}
      </details>
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
  if (run.state === 'POST_OUTCOME_UNKNOWN')
    return (
      <div className="warning">
        <strong>POST_OUTCOME_UNKNOWN</strong>
        <p>Posting may have occurred. Investigate with a separate read-only inquiry; do not retry.</p>
      </div>
    );
  const result = run.result;
  if (!result)
    return (
      <p>
        {pending(run)
          ? 'Run is still in progress. Tool completion is not run completion.'
          : 'No result was recorded.'}
      </p>
    );
  if (result.status === 'business_outcome')
    return (
      <div>
        <strong>Business outcome: {result.outcomeCode}</strong>
        <p>{result.detail}</p>
      </div>
    );
  if (result.status === 'failure')
    return (
      <div role="status">
        <strong>{result.failure?.code ?? 'RUN_FAILED'}</strong>
        <p>{result.failure?.detail ?? 'Run stopped. Inspect recorded evidence.'}</p>
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
          <h4>{name}</h4>
          {Array.isArray(value) ? (
            <div className="table-scroll" role="region" aria-label={`${name} result table`} tabIndex={0}>
              <table>
                <thead>
                  <tr>
                    {Object.keys(value[0] ?? {}).map((column) => (
                      <th scope="col" key={column}>
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {value.map((row, index) => (
                    <tr key={index}>
                      {Object.keys(value[0] ?? {}).map((column) => (
                        <td key={column}>{String(row[column] ?? '')}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!value.length && <p>No rows.</p>}
            </div>
          ) : (
            <p className="output">{String(value)}</p>
          )}
        </div>
      ))}
    </div>
  );
}
export function EscalationCard({ run }: { run: Run }) {
  const { session } = useRuns();
  if (!run.intervention || run.state !== 'awaiting-human') return null;
  if (session.principal !== 'operator' || !('id' in run.intervention))
    return <p className="warning">Waiting for an operator.</p>;
  return <ApprovalPanel key={run.intervention.id} run={run} />;
}
export function ApprovalPanel({ run }: { run: Run }) {
  const { request, refresh, error: connectionError } = useRuns();
  const [now, setNow] = useState(Date.now());
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const locked = useRef(false);
  const uncertain = useRef(false);
  const probing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    if (!uncertain.current || probing.current) return;
    probing.current = true;
    // A failed POST is not retry permission. Probe the current intervention after a fresh history update.
    void request(`/runs/${segment(run.runId)}`).then((response) => response.json()).then((current: Run) => {
      if (mounted.current && current.runId === run.runId && current.state === 'awaiting-human'
        && current.intervention && 'id' in current.intervention
        && run.intervention && 'id' in run.intervention
        && current.intervention.id === run.intervention.id && Date.now() < current.intervention.expiresAt) {
        uncertain.current = false;
        locked.current = false;
        setSent(false);
        setError('The server confirms this intervention is still pending. You may choose a decision again.');
      }
    }).catch(() => { /* Keep locked until a later authoritative refresh succeeds. */ })
      .finally(() => { probing.current = false; });
  }, [run, request]);
  useEffect(() => {
    mounted.current = true;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, []);
  const intervention = run.intervention;
  if (!intervention || !('id' in intervention)) return null;
  const expired = now >= intervention.expiresAt;
  const approval = intervention.request.kind === 'risk_approval';
  async function decide(decision: 'approve' | 'retry' | 'abort') {
    if (
      connectionError ||
      locked.current ||
      !intervention ||
      !('id' in intervention) ||
      Date.now() >= intervention.expiresAt
    )
      return;
    locked.current = true;
    setSent(true);
    try {
      await request(`/runs/${segment(run.runId)}/decision`, {
        method: 'POST',
        body: JSON.stringify({ approvalId: intervention.id, decision }),
      });
    } catch (e) {
      uncertain.current = true;
      setError(
        `${e instanceof Error ? e.message : 'Decision response unavailable.'} Refresh to inspect authoritative state.`,
      );
    } finally {
      await refresh();
    }
  }
  return (
    <div className="approval">
      <h4>{approval ? 'Operator approval required' : 'Operator repair required'}</h4>
      <p>{intervention.request.reason}</p>
      <p>
        {expired ? 'Intervention expired.' : `Expires ${new Date(intervention.expiresAt).toLocaleString()}`}
      </p>
      <pre>{JSON.stringify(intervention.action ?? intervention.request, null, 2)}</pre>
      {!approval && <p>Repair the active browser session, then request one bounded retry.</p>}
      <div className="actions">
        <button
          disabled={Boolean(connectionError) || expired || sent || (approval && !intervention.action)}
          onClick={() => void decide(approval ? 'approve' : 'retry')}
        >
          {approval ? 'Approve submission' : 'Retry after repair'}
        </button>
        <button
          className="abort"
          disabled={Boolean(connectionError) || expired || sent}
          onClick={() => void decide('abort')}
        >
          Abort
        </button>
      </div>
      {sent && <p>Decision submitted. Waiting for authoritative run updates.</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
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
          <RecordedTimeline key={run.runId} run={run} />
          <EvidenceViewer run={run} />
        </>
      )}
    </details>
  );
}
export function CapabilityRunCard({ runId, detail = false }: { runId: string; detail?: boolean }) {
  const { runs, error, refresh } = useRuns();
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
        <h3>{run.capability}</h3>
        <span className="badge" role="status" aria-live="polite" aria-atomic="true">
          <span className="sr-only">{run.capability}, run {run.runId}: </span>
          {run.state}
          {run.result?.status === 'business_outcome' && <span className="sr-only">: {run.result.outcomeCode}</span>}
        </span>
      </div>
      <p className="muted">
        {run.kind}
        {run.version ? ` · v${run.version}` : ''} · {run.runId}
      </p>
      {run.step && <p>Current step: {run.step}</p>}
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
      {detail && (
        <>
          <EscalationCard run={run} />
          <RunDetail run={run} />
        </>
      )}
    </article>
  );
}
export function RunHistory() {
  const { runs, loading, error, refresh } = useRuns();
  return (
    <section className="wide" aria-labelledby="history-heading">
      <div className="section-title">
        <div>
          <h2 id="history-heading">Run history</h2>
          <p>Authoritative discovery and replay records.</p>
        </div>
        <button id="refresh" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {loading && <p role="status">Loading authenticated history…</p>}
      {!loading && !runs.length && (
        <p className="empty">No visible runs. Send a request to start an available capability.</p>
      )}
      <div id="runs">
        {[...runs].reverse().map((run) => (
          <CapabilityRunCard key={run.runId} runId={run.runId} detail />
        ))}
      </div>
    </section>
  );
}
