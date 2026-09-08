import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('measures two isolated offline browser workers and verifies their replay outputs', () => {
  const result = spawnSync(process.execPath,
    ['--import', 'tsx', 'scripts/benchmark-workers.ts', '--workers', '2', '--iterations', '1'],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 25_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report.resourceLimitsEnforcedByHarness).toBe(false);
  expect(report.results).toHaveLength(1);
  expect(report.results[0]).toMatchObject({ workers: 2, completed: 2, peakSimultaneousBrowsers: 2 });
  expect(report.results[0].sampledPeakTreeRssMiB).toBeGreaterThan(0);
  expect(report.results[0].runMs).toHaveLength(2);
  expect(result.stdout).not.toContain('9,812.55');
}, 30_000);
