// PF-H2: profile screenshots mask sensitive values by tagging matching text
// nodes in one evaluate per frame instead of one getByText locator per value.
// The outcome must be identical: the value's pixels are covered, nothing else
// changes, and no tag survives the shot. PF-M4: repeated collectSensitive()
// calls forward each value once.

import express from 'express';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserSurface } from '../src/surface/browser.js';
import type { AppProfile } from '../src/runtime/profile.js';

const SECRET = 'ACCT-777-SECRET';
const PAGE = `<html><body style="margin:0;background:#fff">
<div id="box" style="width:200px;height:20px">boxed</div>
<p id="leak" style="font:20px monospace;margin:40px">${SECRET}</p>
<p id="plain" style="font:20px monospace;margin:40px">PLAIN TEXT</p>
<table border="1"><tr><td>CELL-ONE</td></tr><tr><td>CELL-TWO</td></tr></table>
</body></html>`;

const profile: AppProfile = { appId: 'test', entryUrl: 'http://127.0.0.1/page', routes: ['^/page$'], maskSelectors: ['#box'] } as AppProfile;

describe('profile screenshot value masking', () => {
  const app = express();
  app.get('/page', (_req, res) => res.send(PAGE));
  const server = app.listen(0, '127.0.0.1');
  let origin = '';
  const listening = once(server, 'listening');
  let surface: BrowserSurface;
  const forwarded: string[][] = [];

  beforeAll(async () => {
    await listening;
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    surface = new BrowserSurface({ allowedOrigins: [origin], profile: { ...profile, entryUrl: `${origin}/page` }, sensitive: values => forwarded.push(values) });
    await surface.start(`${origin}/page`);
  }, 30_000);
  afterAll(async () => { await surface?.close(); await new Promise<void>(resolve => server.close(() => resolve())); });

  /** Decode the PNG in a browser page and sample one pixel — no image dependency needed. */
  async function pixelAt(png: string, x: number, y: number): Promise<number[]> {
    const page = await (surface as unknown as { page: import('playwright').Page }).page.context().newPage();
    try {
      const data = `data:image/png;base64,${readFileSync(png).toString('base64')}`;
      return await page.evaluate(async ({ src, x, y }) => {
        const img = new Image(); img.src = src; await img.decode();
        const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext('2d')!; ctx.drawImage(img, 0, 0);
        return Array.from(ctx.getImageData(x, y, 1, 1).data.slice(0, 3));
      }, { src: data, x, y });
    } finally { await page.close(); }
  }

  it('covers the value text and only the value text, then removes its tags', async () => {
    const page = (surface as unknown as { page: import('playwright').Page }).page;
    const leak = (await page.locator('#leak').boundingBox())!;
    const plain = (await page.locator('#plain').boundingBox())!;
    const shot = join(tmpdir(), `cu-profile-mask-${process.pid}.png`);

    await surface.screenshot(shot, { maskValues: [SECRET, 'never-on-page', 'a.b*c' ] });
    expect(await pixelAt(shot, Math.round(leak.x + 10), Math.round(leak.y + leak.height / 2))).toEqual([255, 0, 255]);
    expect(await pixelAt(shot, Math.round(plain.x + 10), Math.round(plain.y + plain.height / 2))).not.toEqual([255, 0, 255]);
    expect(await page.locator('[data-cu-mask]').count()).toBe(0);

    const bare = join(tmpdir(), `cu-profile-bare-${process.pid}.png`);
    await surface.screenshot(bare, {});
    expect(await pixelAt(bare, Math.round(leak.x + 10), Math.round(leak.y + leak.height / 2))).not.toEqual([255, 0, 255]);
  }, 20_000);

  it('forwards each sensitive value once across repeated collections', async () => {
    // The screenshots above already collected once; three more passes over
    // the same page must not forward a single repeat.
    const batches = forwarded.length;
    await surface.collectSensitive();
    await surface.collectSensitive();
    await surface.collectSensitive();
    const all = forwarded.flat();
    expect(all.filter(v => v === 'CELL-ONE')).toHaveLength(1);
    expect(all.filter(v => v === 'CELL-TWO')).toHaveLength(1);
    expect(forwarded.length).toBe(batches);
  });
});
