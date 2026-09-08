// Offline cold-browser baseline, not MERIDIAN capacity or live acceptance.
// npm run benchmark:workers -- --workers 1,4 --iterations 3 [--headed]
import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { cpus, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CapabilityArtifact } from '../src/artifact/schema.js';
import { RunLogger } from '../src/evidence/logger.js';
import { runReplay } from '../src/replay/executor.js';
import { Policy } from '../src/safety/policy.js';
import { Redactor } from '../src/safety/redact.js';
import { BrowserSurface } from '../src/surface/browser.js';
import { GuardedSurface } from '../src/surface/guarded.js';
import { createApp } from '../target-app/server.js';

const { values } = parseArgs({ options: {
  workers: { type: 'string', default: '1,4' }, iterations: { type: 'string', default: '3' },
  headed: { type: 'boolean', default: false }, child: { type: 'boolean', default: false },
} });
const iterations = Number(values.iterations);
const counts = values.workers.split(',').map(Number);
assert(Number.isInteger(iterations) && iterations >= 1 && iterations <= 100, 'iterations must be 1..100');
assert(counts.length > 0 && counts.length <= 4 && counts.every(n => Number.isInteger(n) && n >= 1 && n <= 4), 'workers must be 1..4 (at most four batches)');

async function worker() {
  assert(process.send, 'child mode requires the benchmark parent');
  const dir = mkdtempSync(join(tmpdir(), 'meridian-worker-benchmark-'));
  const app = createApp();
  // The existing fixture uses only GET for lookup. Refuse other methods even if it changes.
  const server = (await import('node:http')).createServer((req, res) => {
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    app(req, res);
  }).listen(0, '127.0.0.1');
  let browser: BrowserSurface | undefined;
  let stopped = false;
  const abort = new AbortController();
  const stop = () => { stopped = true; abort.abort(); void browser?.close().catch(() => {}); server.closeAllConnections(); };
  process.on('SIGTERM', stop);
  process.on('disconnect', stop);
  try {
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const artifact = CapabilityArtifact.parse(JSON.parse(readFileSync(new URL('../test/fixtures/hand-lookup.json', import.meta.url), 'utf8')));
    artifact.app.entryUrl = `${origin}/`;
    artifact.app.allowedOrigins = [origin];
    const policy = Policy.parse({ allowedOrigins: [origin], allowedActions: ['navigate', 'click', 'fill', 'extract', 'assert'],
      riskHandling: { read: 'allow', reversible_write: 'allow', irreversible: 'block' } });
    const start = once(process, 'message', { signal: abort.signal });
    process.send({ ready: true });
    const [message] = await start;
    assert.deepEqual(message, { start: true });
    const samples: number[] = [];
    for (let i = 0; i < iterations; i++) {
      assert(!stopped, 'worker stopped');
      const started = performance.now();
      browser = new BrowserSurface({ allowedOrigins: [origin], headful: values.headed });
      const surface = new GuardedSurface(browser, policy, async () => false);
      const logger = new RunLogger('replay', new Redactor(), dir, true);
      try {
        const result = await runReplay(artifact, { memberId: '23456' }, { surface, logger, policy });
        assert.equal(result.status, 'success', 'fixture replay failed');
        assert.deepEqual(result.status === 'success' && result.outputs, { savingsBalance: '9,812.55' });
        assert(readdirSync(logger.dir).some(file => file.endsWith('.png')), 'screenshot missing');
        assert(!readFileSync(join(logger.dir, 'log.jsonl'), 'utf8').includes('"event":"evidence.warning"'), 'incomplete evidence');
      } finally { await surface.close(); browser = undefined; }
      samples.push(performance.now() - started);
      rmSync(logger.dir, { recursive: true, force: true });
    }
    process.send({ samples });
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('disconnect', stop);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
    process.disconnect?.();
  }
}

const round = (n: number) => +n.toFixed(2);
async function batch(count: number) {
  // Do not forward credentials, CDP flags, Node hooks, or fixture fault settings.
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'PLAYWRIGHT_BROWSERS_PATH', 'DISPLAY', 'XAUTHORITY']
    .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
  const children = Array.from({ length: count }, () => fork(fileURLToPath(import.meta.url),
    ['--child', '--iterations', String(iterations), ...(values.headed ? ['--headed'] : [])],
    { execArgv: ['--import', 'tsx'], env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }));
  const samples: number[] = [];
  let peakTreeRssKiB = 0;
  let peakSimultaneousBrowsers = 0;
  let samplingError: unknown;
  const sample = () => {
    try {
      // ps RSS includes Chromium descendants, unlike process.memoryUsage().
      // ponytail: 250ms samples miss short peaks and double-count shared pages;
      // use per-worker cgroup memory.peak for an allocation decision.
      const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8', timeout: 2000 })
        .trim().split('\n').map(row => {
          const match = row.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
          assert(match, 'unsupported ps output');
          return { pid: Number(match[1]), ppid: Number(match[2]), rss: Number(match[3]), command: match[4]! };
        });
      const tree = new Set(children.flatMap(child => child.pid === undefined ? [] : [child.pid]));
      let size;
      do { size = tree.size; for (const row of rows) if (tree.has(row.ppid)) tree.add(row.pid); } while (tree.size !== size);
      peakTreeRssKiB = Math.max(peakTreeRssKiB, rows.filter(row => tree.has(row.pid)).reduce((sum, row) => sum + row.rss, 0));
      // A Chromium root is launched directly by each Node worker; helpers are excluded.
      peakSimultaneousBrowsers = Math.max(peakSimultaneousBrowsers, rows.filter(row => children.some(child => child.pid === row.ppid) && /chrom(e|ium)/i.test(row.command)).length);
    } catch (error) { samplingError = error; }
  };
  let ready = 0;
  let started = 0;
  const done = children.map(child => new Promise<void>((resolve, reject) => {
    let received = false;
    let stderr = '';
    child.stderr!.on('data', data => { stderr = (stderr + data).slice(-4000); });
    child.on('error', reject);
    child.on('message', (message: { ready?: boolean; samples?: number[] }) => {
      if (message.ready && ++ready === count) {
        started = performance.now();
        children.forEach(worker => worker.send({ start: true }));
      }
      if (message.samples) { received = true; samples.push(...message.samples); }
    });
    child.on('exit', (code, signal) => code === 0 && received ? resolve() : reject(new Error(`worker failed (${code ?? signal}): ${stderr}`)));
  }));
  let forceStop: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    forceStop ??= setTimeout(() => {
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 5000);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const timer = setInterval(sample, 250);
  const timeout = setTimeout(stop, iterations * 30_000 + 30_000);
  try {
    const results = await Promise.allSettled(done.map(promise => promise.catch(error => { stop(); throw error; })));
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    if (samplingError) throw samplingError;
    assert.equal(samples.length, count * iterations);
    assert.equal(peakSimultaneousBrowsers, count, 'full browser concurrency was not observed; baseline is invalid');
    assert(peakTreeRssKiB > 0);
    samples.sort((a, b) => a - b);
    const elapsedMs = performance.now() - started;
    return { workers: count, iterationsPerWorker: iterations, completed: samples.length, peakSimultaneousBrowsers,
      batchMs: round(elapsedMs), runsPerMinute: round(samples.length * 60_000 / elapsedMs),
      p50RunMs: round(samples[Math.ceil(samples.length * 0.5) - 1]!), p95RunMs: round(samples[Math.ceil(samples.length * 0.95) - 1]!),
      sampledPeakTreeRssMiB: round(peakTreeRssKiB / 1024), runMs: samples.map(round) };
  } finally {
    clearInterval(timer); clearTimeout(timeout); clearTimeout(forceStop);
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}

if (values.child) await worker();
else {
  assert(['darwin', 'linux'].includes(process.platform), 'benchmark requires macOS or Linux ps');
  const results = [];
  for (const count of counts) results.push(await batch(count));
  console.log(JSON.stringify({ schemaVersion: 1, workload: 'offline-hand-lookup-cold-browser-v1',
    sourceHashes: Object.fromEntries(['scripts/benchmark-workers.ts', 'test/fixtures/hand-lookup.json', 'package-lock.json']
      .map(path => [path, createHash('sha256').update(readFileSync(new URL(`../${path}`, import.meta.url))).digest('hex')])),
    platform: process.platform, arch: process.arch, node: process.version, cpuModel: cpus()[0]?.model,
    logicalCpus: cpus().length, hostMemoryGiB: round(totalmem() / 1024 ** 3), headed: values.headed,
    resourceLimitsEnforcedByHarness: false, results }, null, 2));
}
