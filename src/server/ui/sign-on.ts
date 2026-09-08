import { authenticatedFetch, pending, segment, type Run } from './session';

export async function signOn(token: string, signal: AbortSignal) {
  const request = async (path: string, options: RequestInit = {}) => {
    const response = await authenticatedFetch(token, path, { ...options, signal });
    if (!response.ok) throw new Error(`Sign-on could not be confirmed (${response.status}). Connect again to check your access.`);
    return response.json();
  };
  const accepted = await request('/capabilities/meridian-sign-on/invoke', {
    method: 'POST', headers: { 'Idempotency-Key': crypto.randomUUID() },
    body: JSON.stringify({ args: {}, operator: 'TELLER' }),
  });
  if (typeof accepted.runId !== 'string') throw new Error('Sign-on returned no run. Access has not been confirmed.');
  const path = `/runs/${segment(accepted.runId)}`;
  for (;;) {
    const run: Run = await request(path);
    if (run.runId !== accepted.runId || run.capability !== 'meridian-sign-on') throw new Error('Sign-on returned an unexpected run.');
    if (run.state === 'success' && run.result?.status === 'success') {
      const outputs = run.result.outputs;
      if (!outputs || typeof outputs.operator !== 'string' || !outputs.operator.trim()
        || typeof outputs.branch !== 'string' || !outputs.branch.trim() || outputs.role !== 'TELLER') {
        throw new Error('Sign-on did not confirm the requested operator role and branch.');
      }
      return `Signed in as ${outputs.operator} · ${outputs.role} · Branch ${outputs.branch}.`;
    }
    if (run.intervention || !pending(run)) throw new Error('Sign-on did not complete. Access has not been confirmed.');
    await new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 1000);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
}
