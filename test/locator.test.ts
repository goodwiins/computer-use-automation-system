// Integration test for tiered locator resolution against a hostile page —
// the determinism core. Uses a data: URL so no server is needed.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkDetectors } from '../src/replay/detectors.js';
import { BrowserSurface } from '../src/surface/browser.js';
import { TargetResolutionError } from '../src/surface/types.js';

const HOSTILE_PAGE = `<html><body bgcolor="#eee">
<table><tr><td><table><tr>
  <td><font size="2">Member Number:</font></td>
  <td><input type="text" name="q" size="24"></td>
  <td><input type="submit" value="Search"></td>
</tr></table></td></tr></table>
<table><tr><td><a href="#one">12345</a></td><td>SMITH, JOHN</td></tr>
<tr><td><a href="#two">12345-S01</a></td><td>PRIMARY SHARE</td></tr></table>
<div hidden>SYSTEM ERROR</div><p>SYSTEM ERROR</p>
<div hidden>HIDDEN ONLY</div>
<iframe name="workarea" srcdoc="<p>FRAME ONLY</p>"></iframe>
</body></html>`;

describe('tiered locator resolution', () => {
  const surface = new BrowserSurface();
  beforeAll(async () => {
    await surface.start('data:text/html,' + encodeURIComponent(HOSTILE_PAGE));
  }, 30_000);
  afterAll(() => surface.close());

  it('resolves via role+name on tier 1', async () => {
    const { report } = await surface.readText({
      description: 'search button',
      strategies: [{ kind: 'role', role: 'button', name: 'Search' }, { kind: 'css', selector: 'input[type=submit]' }],
    }, 3000);
    expect(report).toMatchObject({ strategyUsed: 0, kind: 'role' });
  });

  it('falls back to the next tier when tier 1 misses', async () => {
    const { report } = await surface.readText({
      description: 'member number input (button-name drifted)',
      strategies: [{ kind: 'role', role: 'button', name: 'Execute Query' }, { kind: 'nameAttr', name: 'q' }],
    }, 3000);
    expect(report).toMatchObject({ strategyUsed: 1, kind: 'nameAttr' });
  });

  it('fails loudly on ambiguity instead of guessing', async () => {
    await expect(
      surface.readText({
        description: 'ambiguous partial text',
        strategies: [{ kind: 'text', text: '12345', exact: false }],
      }, 2000),
    ).rejects.toThrow(TargetResolutionError);
  });

  it('honors exact text matching to disambiguate', async () => {
    const { text } = await surface.readText({
      description: 'the member link, exact',
      strategies: [{ kind: 'text', text: '12345', exact: true }],
    }, 3000);
    expect(text).toBe('12345');
  });

  it('derives a tiered descriptor from a live element', async () => {
    const d = await surface.describeTarget({
      description: 'search button',
      strategies: [{ kind: 'css', selector: 'input[type=submit]' }],
    });
    expect(d.strategies[0]).toEqual({ kind: 'role', role: 'button', name: 'Search' });
    expect(d.strategies.at(-1)?.kind).toBe('css');
  });

  it('detects a visible duplicate when the first text match is hidden', async () => {
    expect(await surface.isTextVisible('SYSTEM ERROR')).toBe(true);
    expect(await checkDetectors(surface, { detectors: [] })).toMatchObject({
      id: 'generic-server-error',
      classification: 'fatal',
    });
    expect(await surface.isTextVisible('HIDDEN ONLY')).toBe(false);
    expect(await surface.isTextVisible('ABSENT')).toBe(false);
  });

  it('preserves explicit frame selection for visible text', async () => {
    expect(await surface.isTextVisible('FRAME ONLY', '')).toBe(false);
    expect(await surface.isTextVisible('FRAME ONLY', 'workarea')).toBe(true);
  });
});
