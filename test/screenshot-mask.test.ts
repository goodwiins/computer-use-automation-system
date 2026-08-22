// Screenshots are evidence, but they must not persist sensitive values that
// are rendered on-screen (e.g. a filled password field). The surface masks
// matching inputs for the duration of the shot.

import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../target-app/server.js';
import { BrowserSurface } from '../src/surface/browser.js';

const PORT = 4201;
const ORIGIN = `http://localhost:${PORT}`;
const maskShotPath = join(tmpdir(), `cu-mask-test-${process.pid}.png`);

describe('BrowserSurface screenshot masking', () => {
  let server: Server;
  let surface: BrowserSurface;

  beforeAll(async () => {
    server = createApp().listen(PORT);
    await new Promise<void>((r) => server.on('listening', () => r()));
    surface = new BrowserSurface({ allowedOrigins: [ORIGIN] });
    await surface.start(`${ORIGIN}/members/search`);
  });
  afterAll(async () => {
    await surface?.close();
    server?.close();
  });

  it('restores masked inputs after the shot and preserves their values', async () => {
    const page = surface.page;
    await page.fill('input[name="q"]', 'SECRETPASSWORD');
    const before = await page.getAttribute('input[name="q"]', 'type');

    await surface.screenshot(maskShotPath, { maskValues: ['SECRETPASSWORD'] });

    const after = await page.getAttribute('input[name="q"]', 'type');
    const value = await page.inputValue('input[name="q"]');
    expect(before).not.toBe('password');
    expect(after).toBe(before);
    expect(value).toBe('SECRETPASSWORD');
  });

  it('leaves unrelated inputs untouched', async () => {
    const page = surface.page;
    await page.fill('input[name="q"]', 'PLAINTEXT');
    await surface.screenshot(maskShotPath, { maskValues: ['SECRETPASSWORD'] });
    expect(await page.getAttribute('input[name="q"]', 'type')).not.toBe('password');
    expect(await page.inputValue('input[name="q"]')).toBe('PLAINTEXT');
  });
});
