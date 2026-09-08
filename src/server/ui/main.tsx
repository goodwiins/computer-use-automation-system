'use client';

import './csp';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { authenticatedFetch, CapabilityAuthorityError, hasCurrentPublicIntervention, RunProvider, useRuns, validateCapabilityAuthority, type Session } from './session';
import { Chat } from './chat';
import { signOn } from './sign-on';
import { CapabilityCatalog, RunHistory } from './dashboard';
import { ReviewDialog } from './review';

const preview = typeof document !== 'undefined' && document.documentElement.dataset.uiPreview === 'true';

export default function App() {
  const [session, setSession] = useState<Session>();
  const [status, setStatus] = useState(preview ? 'UI-only preview. Live execution, chat, approvals, and evidence access are unavailable.' : 'Connect with a caller or operator credential.');
  const [connecting, setConnecting] = useState(false);
  const [localLogin, setLocalLogin] = useState<{ teller: string; supervisor: string }>();
  const [loginRole, setLoginRole] = useState('teller');
  const loginAttempt = useRef(0);
  const loginAbort = useRef<AbortController | undefined>(undefined);
  const loginForm = useRef<HTMLFormElement>(null);
  const disconnect = useCallback(() => {
    loginAttempt.current++;
    loginAbort.current?.abort();
    loginForm.current?.reset();
    setSession(undefined);
    setStatus('Disconnected. Authentication and chat cleared.');
    setConnecting(false);
  }, []);
  useEffect(() => {
    window.addEventListener('pagehide', disconnect);
    return () => window.removeEventListener('pagehide', disconnect);
  }, [disconnect]);
  useEffect(() => {
    if (preview) return;
    const controller = new AbortController();
    void fetch('/session/options', { signal: controller.signal })
      .then(response => response.ok ? response.json() : undefined)
      .then(data => {
        if (typeof data?.localTellerLogin?.teller === 'string' && typeof data.localTellerLogin.supervisor === 'string') {
          setLocalLogin(data.localTellerLogin);
          setStatus('Choose Teller or sign in with your supervisor operator and password.');
        }
      }).catch(() => {}); // Keep credential login available when local login cannot be discovered.
    return () => controller.abort();
  }, []);
  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (preview || connecting) return;
    const form = event.currentTarget;
    let token = String(new FormData(form).get('credential') ?? '');
    const supervisor = { operator: String(new FormData(form).get('operator') ?? ''), password: String(new FormData(form).get('password') ?? '') };
    form.reset();
    setSession(undefined);
    setConnecting(true);
    const attempt = ++loginAttempt.current;
    loginAbort.current?.abort();
    const controller = new AbortController();
    loginAbort.current = controller;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]);
    setStatus('Connecting…');
    try {
      let supervisorStatus: string | undefined;
      if (localLogin && loginRole === 'operator') {
        setStatus('Signing in as supervisor…');
        const login = fetch('/session/supervisor', { signal, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(supervisor) });
        supervisor.password = '';
        const response = await login;
        if (!response.ok) {
          const failure = await response.json().catch(() => ({}));
          throw new Error(typeof failure.error === 'string' ? failure.error : 'Supervisor sign-in failed.');
        }
        const signedIn = await response.json();
        if (typeof signedIn.token !== 'string' || signedIn.role !== 'SUPERVISOR' || typeof signedIn.operator !== 'string' || typeof signedIn.branch !== 'string') throw new Error('Supervisor access was not confirmed.');
        token = signedIn.token;
        supervisorStatus = `Signed in as ${signedIn.operator} · SUPERVISOR · Branch ${signedIn.branch}.`;
      }
      if (localLogin && loginRole === 'teller') {
        const response = await fetch('/session/teller', { signal, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (!response.ok) throw new Error('Local teller connection failed. Try connecting again.');
        token = (await response.json()).token;
      }
      const response = await authenticatedFetch(token, '/capabilities', { signal });
      if (!response.ok) throw new Error('Credential rejected. Connect with an authorized credential.');
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw new CapabilityAuthorityError();
      }
      if (attempt !== loginAttempt.current) return;
      const authority = validateCapabilityAuthority(data);
      if (localLogin && authority.principal !== (loginRole === 'teller' ? 'caller' : 'operator')) {
        throw new Error('Operator dashboard requires an operator API credential. This credential does not verify target SUPERVISOR access.');
      }
      if (data === null || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error('Invalid capability catalog. Reconnect with an authorized credential.');
      }
      const metadata = data as { capabilities?: unknown; availability?: unknown };
      if (!Array.isArray(metadata.capabilities)) {
        throw new Error('Invalid capability catalog. Reconnect with an authorized credential.');
      }
      let connectedStatus = `Connected as ${authority.principal}. Credentials remain in page memory.`;
      if (authority.principal === 'caller' && metadata.capabilities.some(capability => capability?.id === 'meridian-sign-on')) {
        setStatus('Signing in to Meridian…');
        connectedStatus = await signOn(token, signal);
      }
      if (attempt !== loginAttempt.current) return;
      setSession({
        token,
        ...authority,
        capabilities: metadata.capabilities as Session['capabilities'],
        availability: Array.isArray(metadata.availability) ? metadata.availability as Session['availability'] : undefined,
      });
      setStatus(supervisorStatus ?? connectedStatus);
    } catch (e) {
      if (attempt === loginAttempt.current) setStatus(signal.aborted ? 'Sign-on timed out. Access has not been confirmed.' : e instanceof Error ? e.message : 'Connection failed.');
    } finally {
      if (attempt === loginAttempt.current) setConnecting(false);
    }
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <header className="brand">
          <span className="brand-mark" aria-hidden="true">M</span>
          <div><h1>Meridian</h1><p>Banking assistant</p></div>
        </header>
        {preview && <p role="note"><strong>UI-only preview · Backend not connected</strong></p>}
        <p className="sidebar-title">Your workspace</p>
        <section aria-label="Session" className="session">
          {session && <button type="button" className="disconnect-button" onClick={disconnect}>Disconnect</button>}
          <form hidden={Boolean(session)} ref={loginForm} id="login" onSubmit={connect} autoComplete="off">
            {localLogin && <>
              <label htmlFor="login-role">Role</label>
              <select id="login-role" value={loginRole} disabled={connecting} onChange={event => {
                const role = event.target.value;
                disconnect();
                setLoginRole(role);
              }}>
                <option value="teller">{localLogin.teller} · Teller</option>
                <option value="operator">{localLogin.supervisor} · Supervisor</option>
              </select>
            </>}
            {localLogin && loginRole === 'operator' && <>
              <label htmlFor="supervisor-operator">Operator</label>
              <input id="supervisor-operator" name="operator" defaultValue={localLogin.supervisor} required maxLength={128} disabled={connecting} autoComplete="off" spellCheck={false} />
              <label htmlFor="supervisor-password">Password</label>
              <input id="supervisor-password" name="password" type="password" required maxLength={512} disabled={connecting} autoComplete="off" />
            </>}
            {!localLogin && <label htmlFor="credential">API credential</label>}
            <div className="login-row">
              {!localLogin && <input id="credential" name="credential" type="password" disabled={preview} required autoComplete="off" spellCheck={false} />}
              <button disabled={preview || connecting}>{connecting ? 'Connecting…' : 'Connect'}</button>
              {connecting && (
                <button type="button" onClick={disconnect}>
                  Cancel
                </button>
              )}
            </div>
          </form>
          <p id="status" role="status">
            {status}
          </p>
          {session && <AuthoritySummary session={session} />}
        </section>
        <p className="sidebar-footer">Meridian Core<br /><span>Private local workspace</span></p>
      </aside>
      <main className="main-pane">
        {session ? (
          <RunProvider key={loginAttempt.current} session={session} disconnect={disconnect}>
            <Workspace />
          </RunProvider>
        ) : <div className="connection-welcome"><span className="welcome-mark" aria-hidden="true">M</span><h2>Welcome to Meridian</h2><p>Connect to your workspace to start a conversation.</p></div>}
      </main>
    </div>
  );
}

function Workspace() {
  const [activityOpen, setActivityOpen] = useState(false);
  const { runs, session } = useRuns();
  const awaitingReview = session.principal === 'operator' ? runs.filter(hasCurrentPublicIntervention).length : 0;
  return <div id="workspace" data-activity-open={activityOpen}>
    <div className="workspace-header">
      <span>Assistant</span>
      <button className="secondary" aria-expanded={activityOpen} aria-controls="activity-panel" onClick={() => setActivityOpen(!activityOpen)}>
        Activity{awaitingReview > 0 && <span className="review-count">{awaitingReview} awaiting review</span>}
      </button>
    </div>
    <Chat />
    <aside id="activity-panel" className="activity-panel" aria-label="Activity" hidden={!activityOpen}>
      {session.principal === 'operator' ? <>
        <RunHistory />
        <CapabilityCatalog />
      </> : <>
        <CapabilityCatalog />
        <RunHistory />
      </>}
    </aside>
    <ReviewDialog />
  </div>;
}

function AuthoritySummary({ session }: { session: Session }) {
  return (
    <section className="authority-summary" aria-label="Access summary">
      <h2>Access summary</h2>
      <p><strong>Dashboard access:</strong> {session.principal === 'operator' ? 'Operator' : 'Caller'}</p>
      <p><strong>Chat execution:</strong> Teller</p>
      <p><strong>Target session:</strong> Not verified</p>
      <p><strong>Branch:</strong> Not verified</p>
    </section>
  );
}
