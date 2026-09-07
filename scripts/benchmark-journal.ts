// Run with: npx tsx scripts/benchmark-journal.ts
// Measures lookup only; real authenticated records and fsync stay in setup.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/runtime/journal.js';

const dir = mkdtempSync(join(tmpdir(), 'journal-benchmark-'));
const journal = new Journal(dir, 'benchmark-only-key-at-least-32-characters');
const request = { member: 'fixture' };
const iterations = 10_000;
try {
  for (const size of [100, 1_000, 10_000]) {
    for (let i = journal.records.size; i < size; i++) {
      journal.reserve('caller', `request-${i}`, 'inquiry', '1.0.0', request);
    }
    for (const key of [`request-${size - 1}`, 'missing']) {
      const expected = key === 'missing' ? undefined : 'inquiry';
      for (let i = 0; i < 1_000; i++) journal.lookup('caller', key, request);
      const started = performance.now();
      for (let i = 0; i < iterations; i++) {
        assert.equal(journal.lookup('caller', key, request).existing?.capability, expected);
      }
      console.log(JSON.stringify({ records: size, lookup: key === 'missing' ? 'miss' : 'last hit',
        iterations, microsecondsPerLookup: +((performance.now() - started) * 1_000 / iterations).toFixed(2) }));
    }
  }
} finally {
  journal.close();
  rmSync(dir, { recursive: true, force: true });
}
