import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { InvocationService, Principal } from '../service.js';

export type Capability = ReturnType<InvocationService['catalog']>[number];
export type Run = ReturnType<InvocationService['get']>;
export type Session = { token: string; principal: Principal; capabilities: Capability[] };
export const pending = (run: Run) =>
  ['accepted', 'reserved', 'running', 'dispatching', 'recovering', 'awaiting-human'].includes(run.state);
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
  loading: boolean;
  error: string;
  request: (path: string, options?: RequestInit) => Promise<Response>;
  refresh: () => Promise<void>;
  watch: (id: string) => void;
} | null>(null);
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const abort = useRef(new AbortController());
  const busy = useRef(false);
  const queued = useRef(false);
  const watched = useRef(new Set<string>());
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
    try {
      const history: Run[] = await (await request('/runs')).json();
      const missing = [...watched.current].filter((id) => !history.some((run) => run.runId === id));
      const extra: Run[] = await Promise.all(
        missing.map(async (id) => (await request(`/runs/${segment(id)}`)).json()),
      );
      if (!abort.current.signal.aborted) {
        setRuns([...history, ...extra]);
        setError('');
      }
    } catch (e) {
      if (!abort.current.signal.aborted)
        setError(
          `Disconnected from run updates. Displayed data may be stale. ${e instanceof Error ? e.message : 'Refresh to reconnect.'}`,
        );
    } finally {
      busy.current = false;
      if (!abort.current.signal.aborted) {
        setLoading(false);
        if (queued.current) {
          queued.current = false;
          void refresh();
        }
      }
    }
  }, [request]);
  const watch = useCallback(
    (id: string) => {
      watched.current.add(id);
      void refresh();
    },
    [refresh],
  );
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
    const timer = setTimeout(() => {
      void refresh();
    }, 1500);
    return () => clearTimeout(timer);
  }, [runs, error, loading, refresh]);
  return (
    <Context.Provider value={{ session, runs, loading, error, request, refresh, watch }}>
      {children}
    </Context.Provider>
  );
}
