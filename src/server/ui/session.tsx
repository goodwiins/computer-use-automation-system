import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { InvocationService } from '../service.js';

export type Capability = ReturnType<InvocationService['catalog']>[number];
export type Availability = Awaited<ReturnType<InvocationService['availability']>>[number];
export type Run = Awaited<ReturnType<InvocationService['get']>>;
export type ProjectedRole = 'caller' | 'operator';
export type Session = {
  token: string;
  principal: ProjectedRole;
  subjectId?: string;
  capabilities: Capability[];
  availability?: Availability[];
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class CapabilityAuthorityError extends Error {
  constructor(message = 'Invalid capability authority metadata. Reconnect with an authorized credential.') {
    super(message);
    this.name = 'CapabilityAuthorityError';
  }
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

export function validateCapabilityAuthority(value: unknown): { principal: ProjectedRole; subjectId?: string } {
  if (!plainRecord(value) || (value.principal !== 'caller' && value.principal !== 'operator')) {
    throw new CapabilityAuthorityError();
  }
  if (!Object.prototype.hasOwnProperty.call(value, 'subjectId')) {
    return { principal: value.principal };
  }
  if (typeof value.subjectId !== 'string' || !uuidPattern.test(value.subjectId)) {
    throw new CapabilityAuthorityError();
  }
  return { principal: value.principal, subjectId: value.subjectId.toLowerCase() };
}

export function sameCapabilityAuthority(
  session: Pick<Session, 'principal' | 'subjectId'>,
  authority: Pick<Session, 'principal' | 'subjectId'>,
): boolean {
  return session.principal === authority.principal && session.subjectId === authority.subjectId;
}
export type ActionAttempt = {
  kind: 'chat' | 'direct';
  key: string;
  body?: string;
  capabilityId?: string;
};
export type ActionHold = ActionAttempt & {
  state: 'active' | 'uncertain' | 'bound';
  runId?: string;
  boundCapabilityId?: string;
};
export const pending = (run: Run) =>
  ['accepted', 'reserved', 'running', 'dispatching', 'recovering', 'awaiting-human'].includes(run.state)
  || run.memberIdentity?.status === 'pending';
export function hasCurrentPublicIntervention(run: Pick<Run, 'state' | 'intervention'>): boolean {
  const intervention: unknown = run.intervention;
  if (run.state !== 'awaiting-human' || !plainRecord(intervention)) return false;
  return typeof intervention.id === 'string' && intervention.id.trim().length > 0;
}
export const segment = (value: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value) || value.includes('..'))
    throw new Error('Invalid evidence or run identity');
  return encodeURIComponent(value);
};
export async function authenticatedFetch(token: string, path: string, options: RequestInit = {}) {
  const headers = new Headers(options.headers);
  headers.set('Authorization', `Bearer ${token}`);
  if (options.body) headers.set('Content-Type', 'application/json');
  return fetch(path, { ...options, headers });
}
const Context = createContext<{
  session: Session;
  runs: Run[];
  reviewRunId?: string;
  refreshVersion: number;
  watched: ReadonlySet<string>;
  loading: boolean;
  error: string;
  actionHold?: ActionHold;
  beginAction: (attempt: ActionAttempt) => boolean;
  markActionUncertain: (key: string) => void;
  bindAction: (key: string, runId: string, capabilityId?: string) => void;
  clearAction: (key: string) => void;
  abandonAction: (key: string) => void;
  request: (path: string, options?: RequestInit) => Promise<Response>;
  refresh: () => Promise<void>;
  watch: (id: string) => void;
  openReview: (runId: string) => void;
  closeReview: () => void;
  getReviewAttempt: (key: string) => ReviewAttempt;
  updateReviewAttempt: (key: string, patch: Partial<ReviewAttempt>) => void;
} | null>(null);
export type ReviewAttempt = {
  locked: boolean;
  uncertain: boolean;
  probing: boolean;
  sent: boolean;
  error?: string;
  probeVersion?: number;
  probeSettled?: boolean;
};
export function useRuns() {
  const value = useContext(Context);
  if (!value) throw new Error('Run cache requires a session');
  return value;
}
export function RunProvider({
  session,
  disconnect,
  children,
}: {
  session: Session;
  disconnect: () => void;
  children: ReactNode;
}) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [capabilities, setCapabilities] = useState(session.capabilities);
  const capabilitiesRef = useRef(session.capabilities);
  const [availability, setAvailability] = useState(session.availability);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [actionHold, setActionHold] = useState<ActionHold>();
  const actionHoldRef = useRef<ActionHold | undefined>(undefined);
  const abort = useRef(new AbortController());
  const busy = useRef(false);
  const queued = useRef(false);
  const watched = useRef(new Set<string>());
  const [reviewRunId, setReviewRunId] = useState<string>();
  const reviewAttempts = useRef(new Map<string, ReviewAttempt>());
  const [, rerenderReview] = useState(0);
  const updateAction = useCallback((key: string, update: (current: ActionHold) => ActionHold | undefined) => {
    const current = actionHoldRef.current;
    if (!current || current.key !== key) return;
    const next = update(current);
    actionHoldRef.current = next;
    setActionHold(next);
  }, []);
  const beginAction = useCallback((attempt: ActionAttempt) => {
    if (actionHoldRef.current) return false;
    const next: ActionHold = { ...attempt, state: 'active' };
    actionHoldRef.current = next;
    setActionHold(next);
    return true;
  }, []);
  const markActionUncertain = useCallback((key: string) => {
    updateAction(key, current => ({ ...current, state: 'uncertain' }));
  }, [updateAction]);
  const bindAction = useCallback((key: string, runId: string, capabilityId?: string) => {
    updateAction(key, current => ({ ...current, state: 'bound', runId, boundCapabilityId: capabilityId }));
  }, [updateAction]);
  const clearAction = useCallback((key: string) => {
    updateAction(key, () => undefined);
  }, [updateAction]);
  const abandonAction = useCallback((key: string) => {
    updateAction(key, () => undefined);
  }, [updateAction]);
  const request = useCallback(
    async (path: string, options: RequestInit = {}) => {
      const response = await authenticatedFetch(session.token, path, {
        ...options,
        signal: options.signal
          ? AbortSignal.any([options.signal, abort.current.signal])
          : abort.current.signal,
      });
      if (response.status === 401) {
        disconnect();
        throw new Error('Authentication expired. Connect again.');
      }
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(typeof data.error === 'string' ? data.error : `Request failed (${response.status})`);
      }
      return response;
    },
    [session.token, disconnect],
  );
  const refresh = useCallback(async () => {
    if (busy.current) {
      queued.current = true;
      return;
    }
    busy.current = true;
    let authorityFailure = false;
    try {
      const [historyResponse, capabilitiesResponse] = await Promise.all([request('/runs'), request('/capabilities')]);
      let rawMetadata: unknown;
      try {
        rawMetadata = await capabilitiesResponse.json();
      } catch {
        throw new CapabilityAuthorityError();
      }
      const authority = validateCapabilityAuthority(rawMetadata);
      if (!sameCapabilityAuthority(session, authority)) {
        throw new CapabilityAuthorityError('Capability authority changed. Reconnect before continuing.');
      }
      const metadata = rawMetadata as Record<string, unknown>;
      const history: Run[] = await historyResponse.json();
      const hasCapabilities = Array.isArray(metadata.capabilities);
      const nextCapabilities = hasCapabilities ? metadata.capabilities as Capability[] : capabilitiesRef.current;
      const nextAvailability = hasCapabilities && Array.isArray(metadata.availability)
        ? metadata.availability as Availability[]
        : undefined;
      const missing = [...watched.current].filter((id) => !history.some((run) => run.runId === id));
      const extra: Run[] = await Promise.all(
        missing.map(async (id) => (await request(`/runs/${segment(id)}`)).json()),
      );
      if (!abort.current.signal.aborted) {
        setRuns([...history, ...extra]);
        setRefreshVersion(version => version + 1);
        setCapabilities(nextCapabilities);
        capabilitiesRef.current = nextCapabilities;
        setAvailability(nextAvailability);
        setError('');
      }
    } catch (e) {
      if (e instanceof CapabilityAuthorityError) {
        if (abort.current.signal.aborted) return;
        authorityFailure = true;
        disconnect();
        return;
      }
      if (!abort.current.signal.aborted) {
        setAvailability(undefined);
        setError(
          `Disconnected from run updates. Displayed data may be stale. ${e instanceof Error ? e.message : 'Refresh to reconnect.'}`,
        );
      }
    } finally {
      busy.current = false;
      if (!authorityFailure && !abort.current.signal.aborted) {
        setLoading(false);
        if (queued.current) {
          queued.current = false;
          void refresh();
        }
      }
    }
  }, [disconnect, request, session]);
  const watch = useCallback(
    (id: string) => {
      watched.current.add(id);
      void refresh();
    },
    [refresh],
  );
  const openReview = useCallback((runId: string) => {
    setReviewRunId(runId);
    if (!runs.some(run => run.runId === runId)) {
      watched.current.add(runId);
      void refresh();
    }
  }, [refresh, runs]);
  const closeReview = useCallback(() => setReviewRunId(undefined), []);
  const getReviewAttempt = useCallback((key: string): ReviewAttempt => reviewAttempts.current.get(key) ?? {
    locked: false,
    uncertain: false,
    probing: false,
    sent: false,
  }, []);
  const updateReviewAttempt = useCallback((key: string, patch: Partial<ReviewAttempt>) => {
    const current = getReviewAttempt(key);
    reviewAttempts.current.set(key, { ...current, ...patch });
    rerenderReview(version => version + 1);
  }, [getReviewAttempt]);
  useEffect(() => {
    reviewAttempts.current.clear();
    setReviewRunId(undefined);
    watched.current.clear();
    actionHoldRef.current = undefined;
    setActionHold(undefined);
    setRuns([]);
  }, [session.principal, session.subjectId, session.token]);
  useEffect(() => {
    void refresh();
    const online = () => {
      void refresh();
    };
    const offline = () =>
      setError('Disconnected from run updates. Displayed data may be stale. Refresh to reconnect.');
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      abort.current.abort();
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, [refresh]);
  useEffect(() => {
    if (!error && !runs.some(pending) && !loading) return;
    const timer = setInterval(() => {
      void refresh();
    }, 1500);
    return () => clearInterval(timer);
  }, [runs, error, loading, refresh]);
  const currentSession = { ...session, capabilities, availability };
  return (
    <Context.Provider value={{ session: currentSession, runs, reviewRunId, refreshVersion, watched: watched.current, loading, error, actionHold,
      beginAction, markActionUncertain, bindAction, clearAction, abandonAction, request, refresh, watch, openReview, closeReview, getReviewAttempt, updateReviewAttempt }}>
      {children}
    </Context.Provider>
  );
}
