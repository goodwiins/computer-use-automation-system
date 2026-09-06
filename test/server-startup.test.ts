import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, connect, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { Journal } from '../src/runtime/journal.js';
import { InvocationService } from '../src/server/service.js';
import { serve } from '../src/server/http.js';

const { build } = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock('vite', () => ({ build }));
afterEach(() => { vi.unstubAllEnvs(); build.mockReset(); });

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
