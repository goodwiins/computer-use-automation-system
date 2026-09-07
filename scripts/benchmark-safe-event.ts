// Run: npx tsx scripts/benchmark-safe-event.ts
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunLogger } from '../src/evidence/logger.js';
import { safeEvent } from '../src/evidence/safe-event.js';
import { Redactor } from '../src/safety/redact.js';

const events: Array<[string, Record<string, unknown>]> = [
  ['action.start', { attempt: 1, action: 'click', requestedRisk: 'read' }],
  ['risk.classified', { attempt: 1, requestedRisk: 'read', effectiveRisk: 'irreversible', mutation: true }],
  ['approval.result', { attempt: 1, approved: true }],
  ['mutation.intent', { attempt: 1, effectiveRisk: 'irreversible' }],
  ['action.end', { attempt: 1, status: 'success' }],
  ['replay.success', {}],
];
const iterations = 3_000;
const dir = mkdtempSync(join(tmpdir(), 'safe-event-benchmark-'));
try {
  for (const [event, data] of events) assert.deepEqual(safeEvent(event, data), { event, data });
  for (const mode of ['sanitize', 'strict log', 'legacy log'] as const) {
    const logger = new RunLogger('replay', new Redactor(), dir, mode === 'strict log');
    const run = () => {
      for (let i = 0; i < iterations; i++) {
        const [event, data] = events[i % events.length]!;
        if (mode === 'sanitize') safeEvent(event, data);
        else logger.log(event, data);
      }
    };
    run(); // Warm the same code path before collecting samples.
    const samples: number[] = [];
    for (let sample = 0; sample < 5; sample++) {
      const started = performance.now();
      run();
      samples.push((performance.now() - started) * 1_000 / iterations);
    }
    if (mode !== 'sanitize') {
      const lines = readFileSync(join(logger.dir, 'log.jsonl'), 'utf8').trim().split('\n');
      assert.equal(lines.length, iterations * 6);
      assert.equal(JSON.parse(lines.at(-1)!).event, 'replay.success');
    }
    console.log(JSON.stringify({ mode, eventsPerSample: iterations,
      microsecondsPerEvent: samples.map(n => +n.toFixed(2)),
      medianMicroseconds: +[...samples].sort((a, b) => a - b)[2]!.toFixed(2) }));
  }
} finally { rmSync(dir, { recursive: true, force: true }); }
