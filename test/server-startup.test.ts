import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Journal } from '../src/runtime/journal.js';
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
    const replacement = new Journal(join(dir, 'journal'), 'h'.repeat(64));
    replacement.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
