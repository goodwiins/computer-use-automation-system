import { createServer } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/http.js';
import type { InvocationService } from '../src/server/service.js';

const cleanups: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubEnv('MERIDIAN_SUPERVISOR_OPERATOR', 'SUPER1');
  vi.stubEnv('MERIDIAN_SUPERVISOR_PASSWORD', 'offline-supervisor-password');
  vi.stubEnv('MERIDIAN_BRANCH', 'MAIN');
});
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); vi.unstubAllEnvs(); });
async function fixture(enabled = true) {
  const state = { run: { runId: 'sign-on', capability: 'meridian-sign-on', state: 'running', result: undefined as any } };
  const service = { invoke: vi.fn(() => ({ runId: 'sign-on' })), get: vi.fn(() => state.run), catalog: () => [] };
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  server.on('request', createApp(service as unknown as InvocationService, { port, callerToken: 'c'.repeat(32), operatorToken: 'o'.repeat(32),
    localTellerLogin: enabled ? { teller: 'TELLER1', supervisor: 'SUPER1' } : undefined }));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const login = (body: unknown = { operator: 'SUPER1', password: 'offline-supervisor-password' }, requestOrigin: string | undefined = origin) =>
    fetch(origin + '/session/supervisor', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(requestOrigin ? { Origin: requestOrigin } : {}) }, body: JSON.stringify(body) });
  return { login, origin, state, service };
}
it('keeps supervisor password login local-only and rejects wrong credentials before invoking a browser', async () => {
  const disabled = await fixture(false);
  expect((await disabled.login()).status).toBe(404);
  const { login, service } = await fixture();
  expect((await login(undefined, '')).status).toBe(403);
  expect((await login(undefined, 'http://foreign.invalid')).status).toBe(403);
  const denied = await login({ operator: 'SUPER1', password: 'wrong' });
  expect(denied.status).toBe(401);
  expect(await denied.text()).not.toContain('token');
  expect((await login()).status).toBe(429);
  expect(service.invoke).not.toHaveBeenCalled();
});
it('issues a separate dashboard credential only after the target confirms supervisor identity, role, and branch', async () => {
  const { login, state, service, origin } = await fixture();
  const pending = login();
  await vi.waitFor(() => expect(service.invoke).toHaveBeenCalledTimes(1));
  expect((await login()).status).toBe(429);
  expect(service.invoke.mock.calls[0]).toEqual(['operator', 'meridian-sign-on', {}, expect.any(String), 'SUPERVISOR']);
  state.run.state = 'success';
  state.run.result = { status: 'success', outputs: { operator: 'SUPER1', role: 'SUPERVISOR', branch: 'MAIN' } };
  const response = await pending;
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ operator: 'SUPER1', role: 'SUPERVISOR', branch: 'MAIN', token: expect.any(String) });
  expect(body.token).not.toBe('o'.repeat(32));
  expect(JSON.stringify(body)).not.toContain('offline-supervisor-password');
  const authenticated = await fetch(origin + '/capabilities', { headers: { Authorization: `Bearer ${body.token}` } });
  expect(authenticated.status).toBe(200);
  expect((await authenticated.json()).principal).toBe('operator');
});
it.each(['failure', 'wrong-role', 'wrong-operator', 'wrong-branch'])('does not grant dashboard access for target %s', async outcome => {
  const { login, state } = await fixture();
  state.run.state = outcome === 'failure' ? 'failure' : 'success';
  state.run.result = { status: 'success', outputs: {
    operator: outcome === 'wrong-operator' ? 'ANOTHER' : 'SUPER1',
    role: outcome === 'wrong-role' ? 'TELLER' : 'SUPERVISOR', branch: outcome === 'wrong-branch' ? 'OTHER' : 'MAIN',
  } };
  const response = await login();
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain('token');
});
