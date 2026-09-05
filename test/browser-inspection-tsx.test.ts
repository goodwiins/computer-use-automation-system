import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('inspects sign-on and transfer controls through the Node tsx loader', () => {
  const fixture = fileURLToPath(new URL('fixtures/browser-inspection-cli.ts', import.meta.url));
  const result = spawnSync(process.execPath, ['--import', 'tsx', fixture], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 15_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}, 20_000);
