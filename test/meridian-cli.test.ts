import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { validateIdempotencyKey } from '../src/runtime/journal.js';

it('rejects invalid request keys before acquiring a journal', () => {
  for (const key of ['', 'space key', '\n', 'x'.repeat(201)]) {
    expect(() => validateIdempotencyKey(key)).toThrow();
  }
  expect(() => validateIdempotencyKey('meridian-new-operation-1')).not.toThrow();
});

it.each([
  ['discover', '--name', 'meridian-sign-on', '--goal', 'Sign on'],
  ['replay', '--artifact', 'artifacts/meridian-sign-on.v1.0.0.json'],
])('rejects an invalid key without retaining resources: %s', (...args) => {
  const dir = mkdtempSync(join(tmpdir(), 'meridian-cli-'));
  try {
    const result = spawnSync(process.execPath,
      ['--import', 'tsx', 'cli.ts', ...args, '--profile', 'meridian',
        '--idempotency-key', 'invalid key'], {
        encoding: 'utf8', timeout: 5000,
        env: {
          PATH: process.env.PATH, HOME: process.env.HOME,
          OPENAI_API_KEY: 'offline-test-only', EVIDENCE_DIR: dir,
          JOURNAL_HMAC_KEY: 'offline-test-key-at-least-32-characters',
          MERIDIAN_TELLER_OPERATOR: 'teller-test',
          MERIDIAN_TELLER_PASSWORD: 'offline-test-only',
          MERIDIAN_BRANCH: 'MAIN-001',
        },
      });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('Idempotency-Key');
    expect(existsSync(join(dir, 'journal', 'server.lock'))).toBe(false);
    expect(readdirSync(dir).filter(name => name !== 'journal')).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
