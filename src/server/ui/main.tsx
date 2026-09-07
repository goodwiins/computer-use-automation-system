'use client';

import './csp';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { authenticatedFetch, RunProvider, useRuns, type Session } from './session';
import { Chat } from './chat';
import { CapabilityCatalog, RunHistory } from './dashboard';

const preview = typeof document !== 'undefined' && document.documentElement.dataset.uiPreview === 'true';

export default function App() {
  const [session, setSession] = useState<Session>();
  const [status, setStatus] = useState(preview ? 'UI-only preview. Live execution, chat, approvals, and evidence access are unavailable.' : 'Connect with a caller or operator credential.');
  const [connecting, setConnecting] = useState(false);
  const [localLogin, setLocalLogin] = useState<{ teller: string; supervisor: string }>();
  const [loginRole, setLoginRole] = useState('teller');
  const loginAttempt = useRef(0);
  const loginForm = useRef<HTMLFormElement>(null);
  const disconnect = useCallback(() => {
    loginAttempt.current++;
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
          setStatus('Choose a teller to connect. Supervisor access requires an operator API credential.');
        }
      }).catch(() => {}); // Keep credential login available when local login cannot be discovered.
    return () => controller.abort();
  }, []);
  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (preview) return;
    const form = event.currentTarget;
    let token = String(new FormData(form).get('credential') ?? '');
    form.reset();
    setSession(undefined);
    setConnecting(true);
    const attempt = ++loginAttempt.current;
    try {
      if (localLogin && loginRole === 'teller') {
        const response = await fetch('/session/teller', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        if (!response.ok) throw new Error('Local teller connection failed. Try connecting again.');
        token = (await response.json()).token;
      }
      const response = await authenticatedFetch(token, '/capabilities');
      if (!response.ok) throw new Error('Credential rejected. Connect with an authorized credential.');
      const data = await response.json();
      if (attempt !== loginAttempt.current) return;
      if (localLogin && data.principal !== (loginRole === 'teller' ? 'caller' : 'operator')) throw new Error('Supervisor access requires an operator API credential.');
      setSession({ token, principal: data.principal, capabilities: data.capabilities, availability: Array.isArray(data.availability) ? data.availability : undefined });
      setStatus(`Connected as ${data.principal}. Credentials remain in page memory.`);
    } catch (e) {
      if (attempt === loginAttempt.current) setStatus(e instanceof Error ? e.message : 'Connection failed.');
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
          <form ref={loginForm} id="login" onSubmit={connect} autoComplete="off">
            {localLogin && <>
              <label htmlFor="login-role">Operator</label>
              <select id="login-role" value={loginRole} disabled={connecting} onChange={event => {
                const role = event.target.value;
                disconnect();
                setLoginRole(role);
              }}>
                <option value="teller">{localLogin.teller} · Teller</option>
                <option value="operator">{localLogin.supervisor} · Supervisor</option>
              </select>
            </>}
            {(!localLogin || loginRole === 'operator') && <label htmlFor="credential">{localLogin ? 'Operator API credential' : 'API credential'}</label>}
            <div className="login-row">
              {(!localLogin || loginRole === 'operator') && <input
                id="credential"
                name="credential"
                type="password"
                disabled={preview}
                required
                autoComplete="off"
                spellCheck={false}
              />}
              <button disabled={preview || connecting}>{connecting ? 'Connecting…' : 'Connect'}</button>
              {session && (
                <button type="button" onClick={disconnect}>
                  Disconnect
                </button>
              )}
            </div>
          </form>
          <p id="status" role="status">
            {status}
          </p>
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
  const { runs } = useRuns();
  const awaitingReview = runs.filter(run => run.intervention).length;
  return <div id="workspace" data-activity-open={activityOpen}>
    <div className="workspace-header">
      <span>Assistant</span>
      <button className="secondary" aria-expanded={activityOpen} aria-controls="activity-panel" onClick={() => setActivityOpen(!activityOpen)}>
        Activity{awaitingReview > 0 && <span className="review-count">{awaitingReview} awaiting review</span>}
      </button>
    </div>
    <Chat />
    <aside id="activity-panel" className="activity-panel" aria-label="Activity" hidden={!activityOpen}>
      <CapabilityCatalog />
      <RunHistory />
    </aside>
  </div>;
}
