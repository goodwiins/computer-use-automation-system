import { describe, expect, it } from 'vitest';
import { Policy } from '../src/safety/policy.js';
import { GuardedSurface, PolicyViolationError } from '../src/surface/guarded.js';
import type { Observation, ResolutionReport, Surface } from '../src/surface/types.js';

const policy = Policy.parse({
  allowedOrigins: ['http://localhost:4173'],
  allowedActions: ['navigate', 'click', 'fill', 'select', 'extract', 'assert'],
  riskHandling: { read: 'allow', reversible_write: 'allow', irreversible: 'escalate' },
});

const okReport: ResolutionReport = { strategyUsed: 0, kind: 'css', matches: 1 };

function makeStubSurface(overrides: Partial<Surface> = {}): Surface {
  return {
    start: async () => {},
    observe: async (): Promise<Observation> => ({ url: '', title: '', frames: [] }),
    currentUrl: () => 'http://localhost:4173/',
    // A frameset app keeps the top page stable while workarea frames
    // navigate — the guard must verify every frame, not just the reported one.
    frameUrls: () => ['http://localhost:4173/'],
    navigate: async () => {},
    click: async () => okReport,
    fill: async () => okReport,
    select: async () => okReport,
    readText: async () => ({ text: '', report: okReport }),
    isTextVisible: async () => false,
    describeTarget: async (hint) => hint,
    screenshot: async () => {},
    close: async () => {},
    ...overrides,
  };
}

describe('GuardedSurface post-action bounds verification', () => {
  it('passes when every frame is inside the allowlist', async () => {
    const guarded = new GuardedSurface(makeStubSurface(), policy, async () => false);
    await expect(guarded.navigate('/members/1')).resolves.toBeUndefined();
  });

  it('throws when a navigation escaped into a frame outside the allowlist', async () => {
    const escaped = makeStubSurface({
      // currentUrl() reports the stale workarea URL (the frameset heuristic);
      // the top-level page actually went somewhere hostile.
      currentUrl: () => 'http://localhost:4173/members/1',
      frameUrls: () => ['https://evil.example.com/capture'],
    });
    const guarded = new GuardedSurface(escaped, policy, async () => false);
    await expect(guarded.navigate('/members/1')).rejects.toThrow(PolicyViolationError);
  });

  it('throws when any frame is outside the allowlist after a click', async () => {
    const escaped = makeStubSurface({
      frameUrls: () => ['http://localhost:4173/', 'https://evil.example.com/ad'],
    });
    const guarded = new GuardedSurface(escaped, policy, async () => false);
    await expect(guarded.click({ description: 'x', strategies: [{ kind: 'css', selector: 'a' }] })).rejects.toThrow(
      PolicyViolationError,
    );
  });

  it('ignores about:blank frames', async () => {
    const blank = makeStubSurface({ frameUrls: () => ['about:blank'] });
    const guarded = new GuardedSurface(blank, policy, async () => false);
    await expect(guarded.navigate('/members/1')).resolves.toBeUndefined();
  });
});
