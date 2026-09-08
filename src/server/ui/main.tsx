'use client';

import './csp';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import { authenticatedFetch, CapabilityAuthorityError, hasCurrentPublicIntervention, RunProvider, useRuns, validateCapabilityAuthority, validateOperationContracts, validateReadinessMetadata, type Session } from './session';
import { Chat } from './chat';
import { signOn } from './sign-on';
import { CapabilityCatalog, RunHistory } from './dashboard';
import { ReviewDialog } from './review';

const preview = typeof document !== 'undefined' && document.documentElement.dataset.uiPreview === 'true';

export default function App() {
  const [session, setSession] = useState<Session>();
  const [status, setStatus] = useState(preview ? 'UI-only preview. Live execution, chat, approvals, and evidence access are unavailable.' : 'Connect with a caller or operator credential.');
  const [connecting, setConnecting] = useState(false);
  const [localLogin, setLocalLogin] = useState<{ teller: true; supervisor: true }>();
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
        if (data?.localTellerLogin?.teller === true && data.localTellerLogin.supervisor === true) {
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
      const metadata = data as { conversationText?: unknown; capabilities?: unknown; availability?: unknown; operationContracts?: unknown };
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
        conversationText: metadata.conversationText === true,
        readinessRequired: validateReadinessMetadata(data),
        supervisorVerified: Boolean(supervisorStatus),
        capabilities: metadata.capabilities as Session['capabilities'],
        availability: Array.isArray(metadata.availability) ? metadata.availability as Session['availability'] : undefined,
        operationContracts: validateOperationContracts(metadata.operationContracts),
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
                <option value="teller">Teller · Caller dashboard</option>
                <option value="operator">Supervisor · Operator dashboard</option>
              </select>
            </>}
            {localLogin && loginRole === 'operator' && <>
              <label htmlFor="supervisor-operator">Operator</label>
              <input id="supervisor-operator" name="operator" required maxLength={128} disabled={connecting} autoComplete="off" spellCheck={false} />
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
  const [narrowActivity, setNarrowActivity] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia('(max-width: 1023px)').matches);
  const activityTriggerRef = useRef<HTMLButtonElement>(null);
  const activityBackRef = useRef<HTMLButtonElement>(null);
  const messageScrollTopRef = useRef(0);
  const shouldRestoreConversationFocusRef = useRef(false);
  const chatWasHiddenRef = useRef(false);
  const focusBackAfterResizeRef = useRef(false);
  const chatHidden = activityOpen && narrowActivity;
  const { runs, session } = useRuns();
  const awaitingReview = session.principal === 'operator' ? runs.filter(hasCurrentPublicIntervention).length : 0;
  const openActivity = () => {
    messageScrollTopRef.current =
      document.querySelector<HTMLElement>('.messages')?.scrollTop ?? 0;
    setActivityOpen(true);
  };
  const closeActivity = () => {
    shouldRestoreConversationFocusRef.current = chatHidden;
    setActivityOpen(false);
  };
  useLayoutEffect(() => {
    const breakpoint = window.matchMedia('(max-width: 1023px)');
    const changeLayout = () => {
      const active = document.activeElement;
      const chat = document.querySelector<HTMLElement>('.chat');
      if (activityOpen && breakpoint.matches && chat?.getClientRects().length) {
        // React hides chat after this snapshot, so a recent wide-layout scroll is retained.
        messageScrollTopRef.current = document.querySelector<HTMLElement>('.messages')?.scrollTop ?? 0;
        focusBackAfterResizeRef.current = active === activityTriggerRef.current || !!(active && chat.contains(active));
      } else if (activityOpen && !breakpoint.matches && active === activityBackRef.current) {
        activityTriggerRef.current?.focus();
      }
      setNarrowActivity(breakpoint.matches);
    };
    breakpoint.addEventListener('change', changeLayout);
    return () => breakpoint.removeEventListener('change', changeLayout);
  }, [activityOpen]);
  useLayoutEffect(() => {
    if (chatHidden && !chatWasHiddenRef.current) {
      const active = document.activeElement;
      if (focusBackAfterResizeRef.current || active === activityTriggerRef.current || document.querySelector('.chat')?.contains(active)) {
        activityBackRef.current?.focus();
      }
      focusBackAfterResizeRef.current = false;
    }
    if (!chatHidden && chatWasHiddenRef.current) {
      const messages = document.querySelector<HTMLElement>('.messages');
      if (messages) messages.scrollTop = messageScrollTopRef.current;
    }
    if (!activityOpen && shouldRestoreConversationFocusRef.current) {
      activityTriggerRef.current?.focus();
      shouldRestoreConversationFocusRef.current = false;
    }
    chatWasHiddenRef.current = chatHidden;
  }, [activityOpen, chatHidden]);
  return <div id="workspace" data-activity-open={activityOpen} data-chat-hidden={chatHidden}>
    <div className="workspace-header">
      <span>Assistant</span>
      <button
        ref={activityTriggerRef}
        className="secondary"
        aria-expanded={activityOpen}
        aria-controls="activity-panel"
        onClick={activityOpen ? closeActivity : openActivity}
      >
        Activity{awaitingReview > 0 && <span className="review-count">{awaitingReview} awaiting review</span>}
      </button>
    </div>
    <Chat />
    <aside id="activity-panel" className="activity-panel" aria-label="Activity" hidden={!activityOpen}>
      <button
        ref={activityBackRef}
        className="secondary activity-back"
        type="button"
        onClick={closeActivity}
      >
        Back to conversation
      </button>
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
