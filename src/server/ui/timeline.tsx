import { useEffect, useId, useState } from 'react';
import { pending, segment, useRuns, type Run } from './session';

const PAGE_SIZE = 50;
const POLL_MS = 1_000;
const actions = ['navigate', 'click', 'fill', 'select', 'extract', 'assert'] as const;
const risks = ['read', 'reversible_write', 'irreversible'] as const;
const statuses = ['success', 'failure', 'business_outcome', 'stopped', 'escalated'] as const;
const codes = [
  'POST_OUTCOME_UNKNOWN',
  'RUN_FAILED',
  'DISCOVERY_FAILED',
  'RUN_ABORTED',
  'RUNTIME_CLEANUP_FAILED',
  'PERMISSION_DENIED',
  'SESSION_EXPIRED',
  'APPLICATION_ERROR',
  'VALIDATION_REJECTED',
  'NO_SUCH_MEMBER',
  'INSUFFICIENT_FUNDS',
  'RECOVERY_FAILED',
  'RECOVERY_CHECKPOINT_REQUIRED',
  'DISCOVERY_CONDITION_CHECK_FAILED',
] as const;

type Field =
  | 'action'
  | 'attempt'
  | 'turn'
  | 'ms'
  | 'isRetry'
  | 'approved'
  | 'mutation'
  | 'risk'
  | 'requestedRisk'
  | 'effectiveRisk'
  | 'verdict'
  | 'method'
  | 'status'
  | 'classification'
  | 'kind'
  | 'decision'
  | 'code';

const events: Record<string, { label: string; fields: readonly Field[] }> = {
  'action.start': { label: 'Action started', fields: ['action', 'attempt', 'requestedRisk'] },
  'action.end': { label: 'Action completed', fields: ['action', 'attempt', 'effectiveRisk', 'status', 'ms'] },
  'risk.classified': {
    label: 'Risk classified',
    fields: ['attempt', 'requestedRisk', 'effectiveRisk', 'mutation', 'method'],
  },
  'approval.result': { label: 'Approval result recorded', fields: ['attempt', 'approved', 'effectiveRisk'] },
  'mutation.intent': { label: 'Mutation intent recorded', fields: ['attempt', 'effectiveRisk'] },
  'policy.decision': { label: 'Policy decision recorded', fields: ['action', 'risk', 'verdict'] },
  'step.start': { label: 'Step started', fields: ['action', 'risk'] },
  'step.ok': { label: 'Step completed', fields: ['action', 'ms', 'isRetry'] },
  'step.resolution': { label: 'Step target resolved', fields: [] },
  'step.extracted': { label: 'Step output extracted', fields: [] },
  'replay.start': { label: 'Replay started', fields: [] },
  'replay.success': { label: 'Replay completed successfully', fields: [] },
  'replay.failure': { label: 'Replay failed', fields: ['code'] },
  'replay.business_outcome': { label: 'Replay reached a business outcome', fields: ['code'] },
  'discovery.start': { label: 'Discovery started', fields: [] },
  'discovery.observe': { label: 'Discovery observation recorded', fields: ['turn'] },
  'discovery.decision': { label: 'Discovery decision recorded', fields: ['turn'] },
  'discovery.finish': { label: 'Discovery finished', fields: ['status', 'code'] },
  'discovery.action_error': { label: 'Discovery action failed', fields: ['turn'] },
  'discovery.escalate': { label: 'Discovery escalation requested', fields: [] },
  'llm.start': { label: 'Model turn started', fields: ['turn'] },
  'llm.end': { label: 'Model turn completed', fields: ['turn', 'status', 'ms'] },
  'detector.hit': { label: 'Safety condition observed', fields: ['classification', 'code'] },
  'detector.recovering': { label: 'Safety recovery started', fields: ['action'] },
  'escalation.raised': { label: 'Escalation raised', fields: [] },
  'escalation.decision': { label: 'Escalation decision recorded', fields: ['decision'] },
  'intervention.pending': { label: 'Operator intervention pending', fields: ['kind'] },
  'intervention.decided': { label: 'Operator intervention decided', fields: ['decision'] },
  'handoff.to_human': { label: 'Control handed to an operator', fields: [] },
  'handoff.to_automation': { label: 'Control returned to automation', fields: ['decision'] },
  'control.transfer': { label: 'Control ownership changed', fields: [] },
  'dialog.unexpected': { label: 'Unexpected dialog observed', fields: [] },
  'evidence.warning': { label: 'Evidence warning recorded', fields: ['code'] },
  'human.action': { label: 'Operator action recorded', fields: ['action'] },
  'human.action.capped': { label: 'Operator action limit reached', fields: [] },
};

type TimelineEntry = {
  label: string;
  details: string[];
  sequence?: number;
  timestamp?: string;
  fileOrder: number;
};

type TimelineResult = {
  entries: TimelineEntry[];
  malformed: number;
  unrecognized: number;
  duplicates: number;
  omittedMetadata: number;
  legacy: number;
  sequenceIssues: number;
};

const title = (value: string) => value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
const oneOf = (value: unknown, allowed: readonly string[]) =>
  typeof value === 'string' && allowed.includes(value) ? title(value) : undefined;

function fieldValue(field: Field, value: unknown): string | undefined {
  if (field === 'attempt' || field === 'turn')
    return Number.isSafeInteger(value) && Number(value) > 0
      ? `${field === 'attempt' ? 'Attempt' : 'Discovery turn'} ${value}`
      : undefined;
  if (field === 'ms')
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? `Duration ${value < 1_000 ? `${Math.round(value)} ms` : `${(value / 1_000).toFixed(1)} s`}`
      : undefined;
  if (field === 'isRetry') return typeof value === 'boolean' ? `Recorded retry: ${value ? 'yes' : 'no'}` : undefined;
  if (field === 'approved') return typeof value === 'boolean' ? `Approved: ${value ? 'yes' : 'no'}` : undefined;
  if (field === 'mutation') return typeof value === 'boolean' ? `Mutation classified: ${value ? 'yes' : 'no'}` : undefined;
  if (field === 'action') {
    const parsed = oneOf(value, actions);
    return parsed && `Action: ${parsed}`;
  }
  if (field === 'risk' || field === 'requestedRisk' || field === 'effectiveRisk') {
    const parsed = oneOf(value, risks);
    const label = field === 'risk' ? 'Risk' : field === 'requestedRisk' ? 'Requested risk' : 'Effective risk';
    return parsed && `${label}: ${parsed}`;
  }
  if (field === 'status') {
    const parsed = oneOf(value, statuses);
    return parsed && `Status: ${parsed}`;
  }
  if (field === 'verdict') {
    const parsed = oneOf(value, ['allow', 'deny', 'needs_human']);
    return parsed && `Verdict: ${parsed}`;
  }
  if (field === 'method') {
    return typeof value === 'string' && ['GET', 'POST'].includes(value) ? `Method: ${value}` : undefined;
  }
  if (field === 'classification') {
    const parsed = oneOf(value, ['business_outcome', 'recoverable', 'fatal']);
    return parsed && `Classification: ${parsed}`;
  }
  if (field === 'kind') {
    const parsed = oneOf(value, ['discovery', 'replay', 'risk_approval', 'replay_stuck', 'discovery_stuck']);
    return parsed && `Kind: ${parsed}`;
  }
  if (field === 'decision') {
    const parsed = oneOf(value, ['approve', 'retry', 'skip', 'abort']);
    return parsed && `Decision: ${parsed}`;
  }
  return typeof value === 'string' && codes.includes(value as (typeof codes)[number])
    ? `Code: ${value}`
    : undefined;
}

function parseTimeline(text: string): TimelineResult {
  const result: TimelineResult = {
    entries: [],
    malformed: 0,
    unrecognized: 0,
    duplicates: 0,
    omittedMetadata: 0,
    legacy: 0,
    sequenceIssues: 0,
  };
  const seen = new Set<number>();
  let previousSequence = -1;
  for (const [index, line] of text.split('\n').entries()) {
    if (!line.trim()) continue;
    let raw: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid event');
      raw = parsed as Record<string, unknown>;
    } catch {
      result.malformed++;
      continue;
    }
    const spec =
      typeof raw.event === 'string' && Object.hasOwn(events, raw.event) ? events[raw.event] : undefined;
    if (!spec) {
      result.unrecognized++;
      continue;
    }
    const sequence = Number.isSafeInteger(raw.seq) && Number(raw.seq) >= 0 ? Number(raw.seq) : undefined;
    if (sequence !== undefined && seen.has(sequence)) {
      result.duplicates++;
      continue;
    }
    if (sequence !== undefined) {
      if (sequence !== previousSequence + 1) result.sequenceIssues++;
      previousSequence = sequence;
      seen.add(sequence);
    }
    const parsedDate = typeof raw.ts === 'string' ? new Date(raw.ts) : undefined;
    const timestamp = parsedDate && Number.isFinite(parsedDate.getTime()) ? parsedDate.toISOString() : undefined;
    const allowed = new Set<string>(['event', 'seq', 'ts', ...spec.fields]);
    let omitted = Object.keys(raw).some((key) => !allowed.has(key));
    if ('seq' in raw && sequence === undefined) omitted = true;
    if ('ts' in raw && timestamp === undefined) omitted = true;
    const details = spec.fields.flatMap((field) => {
      if (!(field in raw)) return [];
      const value = fieldValue(field, raw[field]);
      if (!value) {
        omitted = true;
        return [];
      }
      return [value];
    });
    if (omitted) result.omittedMetadata++;
    if (sequence === undefined || timestamp === undefined) result.legacy++;
    result.entries.push({ label: spec.label, details, sequence, timestamp, fileOrder: index + 1 });
  }
  return result;
}

export function RecordedTimeline({ run }: { run: Run }) {
  const { request } = useRuns();
  const heading = useId();
  const [result, setResult] = useState<TimelineResult>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const available = run.evidence.includes('log.jsonl');
  const active = pending(run);

  useEffect(() => setVisible(PAGE_SIZE), [run.runId]);
  useEffect(() => {
    if (!available) {
      setResult(undefined);
      setError('');
      setLoading(false);
      return;
    }
    let current = true;
    let timer: number | undefined;
    const abort = new AbortController();
    const load = async () => {
      setLoading(true);
      try {
        const response = await request(`/runs/${segment(run.runId)}/evidence/log.jsonl`, {
          signal: abort.signal,
        });
        const next = parseTimeline(await response.text());
        if (current) {
          setResult(next);
          setError('');
        }
      } catch {
        if (current && !abort.signal.aborted)
          setError('Timeline refresh failed. Last recorded entries remain shown when available.');
      } finally {
        if (current) {
          setLoading(false);
          if (active) timer = window.setTimeout(() => void load(), POLL_MS);
        }
      }
    };
    void load();
    return () => {
      current = false;
      abort.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [active, available, refresh, request, run.runId]);

  if (!available)
    return (
      <section className="timeline" aria-labelledby={heading}>
        <h4 id={heading}>Recorded timeline</h4>
        <p>No recorded timeline is available for this run.</p>
      </section>
    );

  const entries = result?.entries ?? [];
  const first = Math.max(0, entries.length - visible);
  const shown = entries.slice(first);
  const issues = result
    ? [
        result.malformed && `${result.malformed} malformed log ${result.malformed === 1 ? 'line was' : 'lines were'} omitted.`,
        result.unrecognized && `${result.unrecognized} unrecognized log ${result.unrecognized === 1 ? 'line was' : 'lines were'} omitted.`,
        result.duplicates && `${result.duplicates} duplicate sequence ${result.duplicates === 1 ? 'entry was' : 'entries were'} omitted.`,
        result.omittedMetadata && `${result.omittedMetadata} ${result.omittedMetadata === 1 ? 'entry contains' : 'entries contain'} unsupported or invalid metadata; those fields are not displayed.`,
        result.legacy && `${result.legacy} ${result.legacy === 1 ? 'entry lacks' : 'entries lack'} a valid sequence or timestamp; file order is shown.`,
        result.sequenceIssues && `${result.sequenceIssues} sequence ${result.sequenceIssues === 1 ? 'gap or ordering issue was' : 'gaps or ordering issues were'} observed.`,
      ].filter(Boolean)
    : [];

  return (
    <section className="timeline" aria-labelledby={heading} aria-busy={loading}>
      <div className="section-title">
        <h4 id={heading}>Recorded timeline</h4>
        <button type="button" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>
          {loading ? 'Refreshing timeline…' : 'Refresh timeline'}
        </button>
      </div>
      {loading && !result && <p role="status">Loading authenticated timeline…</p>}
      {error && <p role="alert" className="warning">{error}</p>}
      {result && !entries.length && (
        <p>{issues.length ? 'No recognized timeline events could be displayed.' : 'The recorded log is empty.'}</p>
      )}
      {entries.length > 0 && (
        <>
          <p className="muted">
            {first
              ? `Showing the newest ${shown.length} of ${entries.length} recognized recorded events.`
              : `Showing all ${entries.length} recognized recorded events.`}
          </p>
          <ol aria-label="Recorded step timeline" start={first + 1}>
            {shown.map((entry) => (
              <li key={`${entry.sequence ?? 'legacy'}-${entry.fileOrder}`}>
                <strong>{entry.label}</strong>
                <span className="timeline-order">
                  {entry.timestamp ? <time dateTime={entry.timestamp}>{entry.timestamp}</time> : 'Timestamp unavailable'}
                  {' · '}
                  {entry.sequence === undefined ? `File order ${entry.fileOrder}` : `Sequence ${entry.sequence}`}
                </span>
                {entry.details.length > 0 && <span>{entry.details.join(' · ')}</span>}
              </li>
            ))}
          </ol>
          {first > 0 && (
            <button type="button" onClick={() => setVisible((value) => value + PAGE_SIZE)}>
              Show {Math.min(PAGE_SIZE, first)} older {Math.min(PAGE_SIZE, first) === 1 ? 'event' : 'events'}
            </button>
          )}
        </>
      )}
      {issues.length > 0 && <p role="status">Timeline may be incomplete. {issues.join(' ')}</p>}
    </section>
  );
}
