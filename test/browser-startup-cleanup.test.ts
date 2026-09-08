import { chromium, type Browser } from 'playwright';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserSurface } from '../src/surface/browser.js';
import { openExecutionJournal } from '../cli.js';

afterEach(() => vi.restoreAllMocks());

it.each([false, true])('awaits pending browser launch before once-only CLI cleanup (close failure: %s)', async fails => {
  let release!: (browser: Browser) => void;
  const launch = new Promise<Browser>(resolve => { release = resolve; });
  vi.spyOn(chromium, 'launch').mockReturnValue(launch);
  const close = vi.fn(async () => { if (fails) throw new Error('fixture close failure'); });
  const newContext = vi.fn(async () => { throw new Error('initialization must not continue'); });
  const launched = { close, newContext } as unknown as Browser;
  const browser = new BrowserSurface({});
  const handle = await openExecutionJournal(false);
  const runtime = { close: () => browser.close(), cleanupFailed: false, logger: { log: vi.fn() } } as unknown as Parameters<typeof handle.attachRuntime>[0];
  handle.attachRuntime(runtime);
  const startup = browser.start('https://fixture.invalid').catch(error => error);
  const cleanup = handle.closeRuntime();
  let finished = false;
  void cleanup.then(() => { finished = true; });
  await Promise.resolve();
  const completedBeforeLaunch = finished;
  release(launched);
  await cleanup;
  await handle.closeRuntime();
  expect(await startup).toBeInstanceOf(Error);
  expect(close).toHaveBeenCalledOnce();
  expect(completedBeforeLaunch).toBe(false);
  expect(newContext).not.toHaveBeenCalled();
  expect(runtime.cleanupFailed).toBe(fails);
  expect(finished).toBe(true);
  await expect(browser.start('https://fixture.invalid')).rejects.toThrow(/closed/);
  expect(chromium.launch).toHaveBeenCalledOnce();
});
