// PF-H1: observe() on a frameset shell must not wait out the ariaSnapshot
// timeout on the bodyless parent frame. Before the fix every discovery turn
// paid a flat 3 s here (18.5 s of the 19.5 s e2e test).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BrowserSurface } from '../src/surface/browser.js';

const FRAME = 'data:text/html,' + encodeURIComponent('<html><body><p>FRAME ONLY</p><input name="q"><table><tr><th>A</th></tr><tr><td>1</td></tr></table></body></html>');
const SHELL = `<html><head><title>shell</title></head><frameset cols="*"><frame name="workarea" src="${FRAME}"></frameset></html>`;

describe('observe() on a frameset shell', () => {
  const surface = new BrowserSurface();
  beforeAll(async () => { await surface.start('data:text/html,' + encodeURIComponent(SHELL)); }, 30_000);
  afterAll(() => surface.close());

  it('skips the bodyless parent frame without burning the snapshot timeout', async () => {
    const started = Date.now();
    const obs = await surface.observe();
    const elapsed = Date.now() - started;
    expect(obs.frames.map(f => f.frame)).toEqual(['workarea']);
    expect(obs.frames[0]!.snapshot).toContain('FRAME ONLY');
    expect(obs.frames[0]!.fields).toEqual([{ name: 'q', type: 'text' }]);
    expect(obs.frames[0]!.tables).toHaveLength(1);
    expect(elapsed).toBeLessThan(1500);
  }, 15_000);
});
