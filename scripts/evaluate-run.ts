import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateRun } from '../src/evidence/evaluate.js';
import { readJournalRecord } from '../src/runtime/journal.js';

const [dir, runId] = process.argv.slice(2);
try {
  if (!dir || !runId) throw new Error('usage');
  const record = readJournalRecord(join(dir, 'journal'), runId, process.env.JOURNAL_HMAC_KEY ?? '');
  const result = evaluateRun(readFileSync(join(dir, runId, 'log.jsonl'), 'utf8'), record);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'pass' ? 0 : 1;
} catch {
  // Parse errors can contain raw input; never echo journal/log contents.
  console.error('Evaluation unavailable: check evidence, run ID, and JOURNAL_HMAC_KEY. Usage: npm run eval -- <evidence-dir> <run-id>');
  process.exitCode = 1;
}
