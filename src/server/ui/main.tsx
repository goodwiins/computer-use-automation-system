import './csp';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { authenticatedFetch, RunProvider, type Session } from './session';
import { Chat } from './chat';
import { CapabilityCatalog, RunHistory } from './dashboard';
import './style.css';

const preview = document.documentElement.dataset.uiPreview === 'true';

function App() {
  const [session, setSession] = useState<Session>();
  const [status, setStatus] = useState(preview ? 'UI-only preview. Live execution, chat, approvals, and evidence access are unavailable.' : 'Connect with a caller or operator credential.');
  const [connecting, setConnecting] = useState(false);
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
  async function connect(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (preview) return;
    const form = event.currentTarget;
    const token = String(new FormData(form).get('credential') ?? '');
    form.reset();
    setSession(undefined);
    setConnecting(true);
    const attempt = ++loginAttempt.current;
    try {
      const response = await authenticatedFetch(token, '/capabilities');
      if (!response.ok) throw new Error('Credential rejected. Connect with an authorized credential.');
      const data = await response.json();
      if (attempt !== loginAttempt.current) return;
      setSession({ token, principal: data.principal, capabilities: data.capabilities });
      setStatus(`Connected as ${data.principal}. Credentials remain in page memory.`);
    } catch (e) {
      if (attempt === loginAttempt.current) setStatus(e instanceof Error ? e.message : 'Connection failed.');
    } finally {
      if (attempt === loginAttempt.current) setConnecting(false);
    }
  }
  return (
    <>
      <header>
        <p className="eyebrow">MERIDIAN / CAPABILITY CONSOLE</p>
        <h1>Run with a clear record.</h1>
        {preview && <p role="note"><strong>UI-only preview · Backend not connected</strong></p>}
        <p>Request a capability, follow its progress, and review the evidence.</p>
      </header>
      <main>
        <section aria-label="Session" className="session">
          <form ref={loginForm} id="login" onSubmit={connect} autoComplete="off">
            <label htmlFor="credential">API credential</label>
            <div className="login-row">
              <input
                id="credential"
                name="credential"
                type="password"
                disabled={preview}
                required
                autoComplete="off"
                spellCheck={false}
              />
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
        {session && (
          <RunProvider key={loginAttempt.current} session={session} disconnect={disconnect}>
            <div id="workspace">
              <Chat />
              <CapabilityCatalog />
              <RunHistory />
            </div>
          </RunProvider>
        )}
      </main>
    </>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
