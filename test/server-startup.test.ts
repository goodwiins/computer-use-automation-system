import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, connect, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Pool } from 'pg';
import { Journal } from '../src/runtime/journal.js';
import { InvocationService } from '../src/server/service.js';
import { serve } from '../src/server/http.js';
import { createPostgresFixture } from './fixtures/postgres.js';

const { build } = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock('vite', () => ({ build }));
afterEach(() => { vi.unstubAllEnvs(); build.mockReset(); process.exitCode = undefined; });

const subjects = JSON.stringify([{
  subjectId: '11111111-1111-4111-8111-111111111111',
  role: 'caller', token: 'startup-subject-token-0000000000001',
}]);

async function freePort() {
  const probe = createServer();
  await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>(done => probe.close(() => done()));
  return port;
}

function successfulBuild() {
  build.mockImplementation(async ({ build: { outDir } }) => {
    mkdirSync(join(outDir, 'assets'));
    writeFileSync(join(outDir, 'index.html'), 'dashboard');
  });
}

const rejection = (promise: Promise<unknown>): Promise<Error> =>
  promise.then(() => { throw new Error('Expected operation to reject'); }, error => error as Error);

it('rejects a second server before it can rebuild live assets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'server-build-lock-'));
  vi.stubEnv('EVIDENCE_DIR', dir);
  vi.stubEnv('JOURNAL_HMAC_KEY', 'h'.repeat(64));
  const journal = new Journal(join(dir, 'journal'), 'h'.repeat(64));
  const asset = join(dir, 'live-index.html');
  writeFileSync(asset, 'live dashboard');
  build.mockImplementation(() => { writeFileSync(asset, 'replaced'); throw new Error('unexpected build'); });
  try {
    await expect(serve('cu-nexus')).rejects.toThrow('Journal already in use');
    expect(build).not.toHaveBeenCalled();
    expect(readFileSync(asset, 'utf8')).toBe('live dashboard');
  } finally { journal.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('releases its acquired journal lock when the dashboard build fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'server-build-failure-'));
  vi.stubEnv('EVIDENCE_DIR', dir);
  vi.stubEnv('JOURNAL_HMAC_KEY', 'h'.repeat(64));
  build.mockRejectedValue(new Error('offline build failure'));
  try {
    await expect(serve('cu-nexus')).rejects.toThrow('offline build failure');
    expect(build).toHaveBeenCalledOnce();
    expect(existsSync(build.mock.calls[0]![0].build.outDir)).toBe(false);
    const replacement = new Journal(join(dir, 'journal'), 'h'.repeat(64));
    replacement.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('serves isolated builds for different journals and cleans up only its own assets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'server-isolated-'));
  vi.stubEnv('JOURNAL_HMAC_KEY', 'h'.repeat(64));
  vi.stubEnv('CALLER_API_TOKEN', 'c'.repeat(32));
  vi.stubEnv('OPERATOR_API_TOKEN', 'o'.repeat(32));
  const servers: Awaited<ReturnType<typeof serve>>[] = [];
  const outputs: string[] = [];
  build.mockImplementation(async ({ build: { outDir } }) => {
    outputs.push(outDir);
    mkdirSync(join(outDir, 'assets'));
    writeFileSync(join(outDir, 'index.html'), `dashboard ${outputs.length}`);
    writeFileSync(join(outDir, 'assets', 'app.js'), `asset ${outputs.length}`);
  });
  try {
    for (let index = 0; index < 2; index++) {
      const probe = createServer();
      await new Promise<void>(done => probe.listen(0, '127.0.0.1', done));
      const port = (probe.address() as AddressInfo).port;
      await new Promise<void>(done => probe.close(() => done()));
      vi.stubEnv('PORT', String(port));
      vi.stubEnv('EVIDENCE_DIR', join(dir, String(index)));
      const server = await serve('cu-nexus');
      if (!server.listening) await new Promise<void>(done => server.once('listening', done));
      servers.push(server);
    }
    expect(outputs[0]).not.toBe(outputs[1]);
    for (const [index, server] of servers.entries()) {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      expect(await (await fetch(origin)).text()).toBe(`dashboard ${index + 1}`);
      expect(await (await fetch(`${origin}/assets/app.js`)).text()).toBe(`asset ${index + 1}`);
    }
    await new Promise<void>(done => servers[0]!.close(() => done()));
    await vi.waitFor(() => expect(existsSync(outputs[0]!)).toBe(false));
    expect(readFileSync(join(outputs[1]!, 'assets/app.js'), 'utf8')).toBe('asset 2');
    const origin = `http://127.0.0.1:${(servers[1]!.address() as AddressInfo).port}`;
    expect(await (await fetch(origin)).text()).toBe('dashboard 2');
    const socket = connect((servers[1]!.address() as AddressInfo).port, '127.0.0.1');
    socket.on('error', error => { expect((error as NodeJS.ErrnoException).code).toBe('ECONNRESET'); });
    await new Promise<void>(done => socket.once('connect', done));
    socket.write('GET / HTTP/1.1\r\n'); // Deliberately incomplete request cannot drain normally.
    const closed = new Promise<void>(done => socket.once('close', done));
    const closeRuntime = vi.spyOn(InvocationService.prototype, 'close');
    try {
      const shutdown = process.listeners('SIGTERM').at(-1)!;
      shutdown('SIGTERM');
      shutdown('SIGTERM');
      expect(closeRuntime).toHaveBeenCalledOnce();
      await closed;
      await vi.waitFor(() => expect(existsSync(outputs[1]!)).toBe(false));
    } finally { closeRuntime.mockRestore(); socket.destroy(); }
  } finally {
    for (const server of servers) if (server.listening) await new Promise<void>(done => server.close(() => done()));
    await vi.waitFor(() => outputs.forEach(path => expect(existsSync(path)).toBe(false)));
    rmSync(dir, { recursive: true, force: true });
  }
});

it('migrates PostgreSQL before listening and ends the pool during shutdown', async () => {
  const database = await createPostgresFixture();
  const dir = mkdtempSync(join(tmpdir(), 'server-postgres-'));
  const end = vi.spyOn(Pool.prototype, 'end');
  vi.stubEnv('DATABASE_URL', database.connectionString);
  vi.stubEnv('SUBJECT_API_TOKENS', subjects);
  vi.stubEnv('EVIDENCE_DIR', dir);
  vi.stubEnv('JOURNAL_HMAC_KEY', 'h'.repeat(64));
  vi.stubEnv('PORT', String(await freePort()));
  successfulBuild();
  try {
    const server = await serve('cu-nexus');
    const address = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${address.port}/conversations`, {
      method: 'POST', headers: {
        Authorization: 'Bearer startup-subject-token-0000000000001',
        'Content-Type': 'application/json',
      }, body: JSON.stringify({ id: randomUUID() }),
    });
    expect(response.status).toBe(201);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await vi.waitFor(() => expect(end).toHaveBeenCalledOnce());
    const replacement = new Journal(join(dir, 'journal'), 'h'.repeat(64));
    replacement.close();
  } finally {
    end.mockRestore();
    await database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('fails generically and releases resources when database configuration or connection fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'server-postgres-failure-'));
  vi.stubEnv('EVIDENCE_DIR', dir);
  vi.stubEnv('JOURNAL_HMAC_KEY', 'h'.repeat(64));
  vi.stubEnv('DATABASE_URL', 'postgresql://PRIVATE_DATABASE_CANARY@127.0.0.1:1/missing');
  successfulBuild();
  try {
    const missingSubjects = await rejection(serve('cu-nexus'));
    expect(missingSubjects.message).toBe('Conversation storage configuration is invalid');
    expect(missingSubjects.message).not.toContain('PRIVATE_DATABASE_CANARY');

    vi.stubEnv('SUBJECT_API_TOKENS', subjects);
    const started = Date.now();
    const failedConnection = await rejection(serve('cu-nexus'));
    expect(failedConnection.message).toBe('Conversation storage startup failed');
    expect(failedConnection.message).not.toContain('PRIVATE_DATABASE_CANARY');
    expect(Date.now() - started).toBeLessThan(6_000);
    const replacement = new Journal(join(dir, 'journal'), 'h'.repeat(64));
    replacement.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('turns an idle PostgreSQL client failure into controlled server shutdown', async () => {
  const database = await createPostgresFixture();
  const dir = mkdtempSync(join(tmpdir(), 'server-postgres-idle-'));
  vi.stubEnv('DATABASE_URL', database.connectionString);
  vi.stubEnv('SUBJECT_API_TOKENS', subjects);
  vi.stubEnv('EVIDENCE_DIR', dir);
  vi.stubEnv('JOURNAL_HMAC_KEY', 'h'.repeat(64));
  vi.stubEnv('PORT', String(await freePort()));
  successfulBuild();
  let server: Awaited<ReturnType<typeof serve>> | undefined;
  try {
    server = await serve('cu-nexus');
    const applicationName = new URL(database.connectionString).searchParams.get('application_name');
    const connection = await database.pool.query<{ pid: number }>(
      `SELECT pid FROM pg_stat_activity
       WHERE application_name = $1 AND pid <> pg_backend_pid()`,
      [applicationName],
    );
    expect(connection.rows).toHaveLength(1);
    await database.pool.query('SELECT pg_terminate_backend($1)', [connection.rows[0]!.pid]);
    await vi.waitFor(() => expect(server!.listening).toBe(false));
    const replacement = new Journal(join(dir, 'journal'), 'h'.repeat(64));
    replacement.close();
  } finally {
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
    await database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
