// PF-H1: observe() on a frameset shell must not wait out the ariaSnapshot
// timeout on the bodyless parent frame. Before the fix every discovery turn
// paid a flat 3 s here (18.5 s of the 19.5 s e2e test).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
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

  it('observes XHTML bodies and waits for late HTML bodies', async () => {
    const page = (surface as unknown as { page: Page }).page;
    await page.goto('data:application/xhtml+xml,' + encodeURIComponent('<html xmlns="http://www.w3.org/1999/xhtml"><body><p>XHTML CONTENT</p><input name="x"/><table><tr><td>cell</td></tr></table></body></html>'));
    const xhtml = await surface.observe();
    expect(xhtml.frames[0]?.snapshot).toContain('XHTML CONTENT');
    expect(xhtml.frames[0]?.fields).toEqual([{ name: 'x', type: 'text' }]);
    expect(xhtml.frames[0]?.tables?.[0]?.selector).toBe('body > table:nth-of-type(1)');

    await page.goto('data:text/html,<html><body><p>LATE CONTENT</p><input name="late"></body></html>');
    await page.evaluate(() => {
      const body = document.body;
      body.remove();
      setTimeout(() => document.documentElement.append(body), 150);
    });
    const late = await surface.observe();
    expect(late.frames[0]?.snapshot).toContain('LATE CONTENT');
    expect(late.frames[0]?.fields).toEqual([{ name: 'late', type: 'text' }]);
  });
});
