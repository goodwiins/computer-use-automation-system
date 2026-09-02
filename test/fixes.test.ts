// Regression tests for the security-review fix batch: origin enforcement,
// injection hardening, and the sentinel double-execution bug. Small,
// hand-rolled fixtures throughout — these are unit tests for the guardrails
// themselves, not end-to-end flows (see e2e.test.ts for that).

import { describe, expect, it } from 'vitest';
import {
  CapabilityArtifact,
  Detector,
  Step,
  resolveTemplate,
  resolveTemplateForRegex,
  validateParams,
} from '../src/artifact/schema.js';
import type { InterventionDecision } from '../src/escalation/session.js';
import { Redactor } from '../src/safety/redact.js';
import { Policy } from '../src/safety/policy.js';
import { RunLogger } from '../src/evidence/logger.js';
import { runReplay } from '../src/replay/executor.js';
import { GuardedSurface, PolicyViolationError } from '../src/surface/guarded.js';
import type { Observation, ResolutionReport, Surface } from '../src/surface/types.js';

const policy = Policy.parse({
  allowedOrigins: ['http://localhost:4173'],
  allowedActions: ['navigate', 'click', 'fill', 'select', 'extract', 'assert'],
  riskHandling: { read: 'allow', reversible_write: 'allow', irreversible: 'escalate' },
});

/** Minimal hand-rolled Surface stub — no browser involved. */
function makeStubSurface(overrides: Partial<Surface> = {}): Surface {
  const okReport: ResolutionReport = { strategyUsed: 0, kind: 'css', matches: 1 };
  return {
    start: async () => {},
    observe: async (): Promise<Observation> => ({ url: '', title: '', frames: [] }),
    currentUrl: () => 'http://localhost:4173/',
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

describe('origin enforcement', () => {
  it('start() outside the allowlist throws PolicyViolationError', async () => {
    const guarded = new GuardedSurface(makeStubSurface(), policy, async () => false);
    await expect(guarded.start('https://evil.example.com/')).rejects.toThrow(PolicyViolationError);
  });
});

describe('validateParams strict typing', () => {
  const artifact = CapabilityArtifact.parse({
    schemaVersion: 1,
    id: 'strict-params',
    name: 'strict-params',
    description: 'test',
    version: '1.0.0',
    status: 'draft',
    app: { appId: 'test', entryUrl: 'http://localhost:4173/', allowedOrigins: ['http://localhost:4173'] },
    parameters: [
      { name: 'memberId', type: 'string', description: 'x', required: true, sensitive: false },
      { name: 'amount', type: 'number', description: 'x', required: true, sensitive: false },
    ],
    outputs: [],
    steps: [{ id: 's1', intent: 'x', action: 'navigate', url: 'http://localhost:4173/', risk: 'read', timeoutMs: 1000 }],
    successCondition: { kind: 'urlMatches', pattern: '.*' },
    detectors: [],
    provenance: { discoveredAt: '2026-01-01T00:00:00Z', model: 'test', discoveryRunId: 'r1', goal: 'test' },
  });

  it('rejects a null value for a number parameter', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(validateParams(artifact, { memberId: '1', amount: null as any })).toMatchObject({ ok: false });
  });

  it('rejects an object value for a string parameter', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(validateParams(artifact, { memberId: {} as any, amount: 5 })).toMatchObject({ ok: false });
  });

  it('does not let a prototype-chain property masquerade as a declared parameter', () => {
    // `declared` is a Set, so membership testing is safe regardless — this
    // pins that an unknown key never slips through as "known".
    expect(validateParams(artifact, { memberId: '1', amount: 5, toString: 'x' })).toMatchObject({ ok: false });
  });
});

describe('resolveTemplateForRegex', () => {
  it('regex-escapes substituted param values', () => {
    const pattern = resolveTemplateForRegex('/members/{{memberId}}$', { memberId: '.*' });
    const re = new RegExp(pattern);
    expect(re.test('/members/anything-at-all')).toBe(false);
    expect(re.test('/members/.*')).toBe(true);
  });
});

describe('resolveTemplate + Object.hasOwn', () => {
  it('treats an inherited (not own) property as a missing parameter', () => {
    expect(() => resolveTemplate('{{constructor}}', {})).toThrow(/Missing parameter/);
  });
});

describe('Step.id / Detector.id regex', () => {
  const stepBase = { intent: 'x', action: 'navigate' as const, url: 'http://x/', risk: 'read' as const, timeoutMs: 1000 };
  it('accepts a normal step id', () => {
    expect(() => Step.parse({ ...stepBase, id: 's1' })).not.toThrow();
  });
  it('rejects a path-traversal-shaped step id', () => {
    expect(() => Step.parse({ ...stepBase, id: '../evil' })).toThrow();
  });
  it('rejects a path-traversal-shaped detector id', () => {
    expect(() =>
      Detector.parse({ id: '../evil', description: 'x', match: { kind: 'textVisible', text: 'x' }, classification: 'fatal' }),
    ).toThrow();
  });
});

describe('sentinel double-execution fix', () => {
  it('a fatal-detector skip at step s2 executes s2 zero times and continues to s3', async () => {
    const FATAL_TEXT = 'FATAL CONDITION';
    let fatalChecks = 0;
    const calls = { navigate: 0, click: 0 };
    const surface = makeStubSurface({
      navigate: async () => {
        calls.navigate++;
      },
      click: async () => {
        calls.click++;
        return { strategyUsed: 0, kind: 'css', matches: 1 };
      },
      isTextVisible: async (text: string) => {
        if (text !== FATAL_TEXT) return false;
        fatalChecks++;
        return fatalChecks === 2; // false at s1's pre-check, true once at s2's, false again at s3's
      },
    });

    const artifact = CapabilityArtifact.parse({
      schemaVersion: 1,
      id: 'sentinel-fixture',
      name: 'sentinel-fixture',
      description: 'test',
      version: '1.0.0',
      status: 'approved',
      app: { appId: 'test', entryUrl: 'http://localhost:4173/', allowedOrigins: ['http://localhost:4173'] },
      parameters: [],
      outputs: [],
      steps: [
        { id: 's1', intent: 'noop navigate', action: 'navigate', url: 'http://localhost:4173/', risk: 'read', timeoutMs: 1000 },
        {
          id: 's2',
          intent: 'action that should be skipped',
          action: 'click',
          target: { description: 'skip-me', strategies: [{ kind: 'css', selector: '#skip' }] },
          risk: 'read',
          timeoutMs: 1000,
        },
        {
          id: 's3',
          intent: 'action that should still run',
          action: 'click',
          target: { description: 'run-me', strategies: [{ kind: 'css', selector: '#run' }] },
          risk: 'read',
          timeoutMs: 1000,
        },
      ],
      successCondition: { kind: 'urlMatches', pattern: '.*' },
      detectors: [
        { id: 'fatal-cond', description: 'fatal condition', match: { kind: 'textVisible', text: FATAL_TEXT }, classification: 'fatal' },
      ],
      provenance: { discoveredAt: '2026-01-01T00:00:00Z', model: 'test', discoveryRunId: 'r1', goal: 'test' },
    });

    let escalateCalls = 0;
    const logger = new RunLogger('replay', new Redactor(), 'evidence/test-runs');
    const result = await runReplay(artifact, {}, {
      surface,
      logger,
      policy,
      escalate: async (): Promise<InterventionDecision> => {
        escalateCalls++;
        return 'skip';
      },
    });

    expect(escalateCalls).toBe(1);
    expect(calls.navigate).toBe(1); // s1 ran normally
    expect(calls.click).toBe(1); // only s3's click — s2 was skipped, never executed
    expect(result.status).toBe('success');
  });
});

describe('screenshot evidence passes sensitive values to the surface for masking', () => {
  it('forwards registered sensitive values as maskValues', async () => {
    const seen: Array<unknown> = [];
    const surface = makeStubSurface({
      screenshot: async (_path: string, opts?: { maskValues?: string[] }) => {
        seen.push(opts);
      },
    });
    const redactor = new Redactor();
    redactor.addSensitiveValues(['SECRETPASSWORD']);
    const logger = new RunLogger('replay', redactor, 'evidence/test-runs');
    await logger.screenshot(surface, 'masked-shot');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ maskValues: ['SECRETPASSWORD'] });
  });

  it('sends no maskValues when nothing sensitive is registered', async () => {
    const seen: Array<unknown> = [];
    const surface = makeStubSurface({
      screenshot: async (_path: string, opts?: { maskValues?: string[] }) => {
        seen.push(opts);
      },
    });
    const logger = new RunLogger('replay', new Redactor(), 'evidence/test-runs');
    await logger.screenshot(surface, 'plain-shot');
    expect(seen[0]).toEqual({});
  });
});

describe('detector recovery actions are risk-gated', () => {
  it('executes a recovery click with an explicit reversible_write risk, not the silent default', async () => {
    const NOTICE = 'SCHEDULED MAINTENANCE NOTICE';
    let noticeVisible = true;
    const clickArgs: Array<{ targetDescription: string; risk: string | undefined }> = [];
    const surface = makeStubSurface({
      isTextVisible: async (text: string) => (text === NOTICE ? noticeVisible : false),
      click: async (target: { description: string }, _ms?: number, risk?: string) => {
        clickArgs.push({ targetDescription: target.description, risk });
        noticeVisible = false; // recovery clears the condition
        return { strategyUsed: 0, kind: 'css', matches: 1 };
      },
    });

    const artifact = CapabilityArtifact.parse({
      schemaVersion: 1,
      id: 'recovery-risk-fixture',
      name: 'recovery-risk-fixture',
      description: 'test',
      version: '1.0.0',
      status: 'approved',
      app: { appId: 'test', entryUrl: 'http://localhost:4173/', allowedOrigins: ['http://localhost:4173'] },
      parameters: [],
      outputs: [],
      steps: [
        { id: 's1', intent: 'x', action: 'navigate', url: 'http://localhost:4173/', risk: 'read', timeoutMs: 1000 },
      ],
      successCondition: { kind: 'urlMatches', pattern: '.*' },
      detectors: [
        {
          id: 'notice',
          description: 'interstitial',
          match: { kind: 'textVisible', text: NOTICE },
          classification: 'recoverable',
          recovery: {
            action: 'click',
            target: { description: 'Continue to application', strategies: [{ kind: 'css', selector: '#continue' }] },
          },
        },
      ],
      provenance: { discoveredAt: '2026-01-01T00:00:00Z', model: 'test', discoveryRunId: 'r1', goal: 'test' },
    });

    const logger = new RunLogger('replay', new Redactor(), 'evidence/test-runs');
    const result = await runReplay(artifact, {}, { surface, logger, policy });

    expect(result.status).toBe('success');
    expect(clickArgs).toHaveLength(1);
    expect(clickArgs[0]!.targetDescription).toBe('Continue to application');
    expect(clickArgs[0]!.risk).toBe('reversible_write');
  });
});

describe('mid-step recoverable condition', () => {
  const NOTICE = 'SCHEDULED NOTICE';
  const artifact = CapabilityArtifact.parse({
    schemaVersion: 1, id: 'recover', name: 'recover', description: 'x', version: '1.0.0', status: 'approved',
    app: { appId: 'test', entryUrl: 'http://localhost:4173/', allowedOrigins: ['http://localhost:4173'] },
    parameters: [], outputs: [],
    steps: [{ id: 's1', intent: 'click', action: 'click', target: { description: 'btn', strategies: [{ kind: 'css', selector: 'b' }] } }],
    successCondition: { kind: 'urlMatches', pattern: '/done$' },
    detectors: [{
      id: 'notice', description: 'interstitial', match: { kind: 'textVisible', text: NOTICE }, classification: 'recoverable',
      recovery: { action: 'click', target: { description: 'dismiss', strategies: [{ kind: 'css', selector: 'a' }] } },
    }],
    provenance: { discoveredAt: '2026-01-01T00:00:00Z', model: 'test', discoveryRunId: 'r1', goal: 'x' },
  });

  it('retries the failed step once after recovery clears the condition', async () => {
    let noticeVisible = false;
    let stepClicks = 0;
    const surface = makeStubSurface({
      currentUrl: () => 'http://localhost:4173/done',
      frameUrls: () => ['http://localhost:4173/done'],
      click: async (t) => {
        if (t.description === 'dismiss') { noticeVisible = false; return { strategyUsed: 0, kind: 'css', matches: 1 }; }
        stepClicks++;
        if (stepClicks === 1) { noticeVisible = true; throw new Error('control obscured'); }
        return { strategyUsed: 0, kind: 'css', matches: 1 };
      },
      isTextVisible: async (text) => text === NOTICE && noticeVisible,
    });
    const logger = new RunLogger('replay', new Redactor(), 'evidence/test-runs');
    const result = await runReplay(artifact, {}, { surface, logger, policy });
    expect(result.recoveries).toEqual(['s1:notice']);
    expect(stepClicks).toBe(2);
    expect(result.status).toBe('success');
  });

  it('does not loop: a second failure after recovery is a hard failure', async () => {
    let noticeVisible = false;
    let stepClicks = 0;
    const surface = makeStubSurface({
      click: async (t) => {
        if (t.description === 'dismiss') { noticeVisible = false; return { strategyUsed: 0, kind: 'css', matches: 1 }; }
        stepClicks++;
        noticeVisible = stepClicks === 1;
        throw new Error('still broken');
      },
      isTextVisible: async (text) => text === NOTICE && noticeVisible,
    });
    const logger = new RunLogger('replay', new Redactor(), 'evidence/test-runs');
    const result = await runReplay(artifact, {}, { surface, logger, policy });
    expect(stepClicks).toBe(2);
    expect(result.status).toBe('failure');
  });

  it('never auto-retries an irreversible step, even after recovery', async () => {
    const irreversible = { ...artifact, steps: [{ ...artifact.steps[0]!, risk: 'irreversible' as const }] };
    const allowIrreversible = Policy.parse({ ...policy, riskHandling: { ...policy.riskHandling, irreversible: 'allow' } });
    let noticeVisible = false;
    let stepClicks = 0;
    const surface = makeStubSurface({
      currentUrl: () => 'http://localhost:4173/done',
      frameUrls: () => ['http://localhost:4173/done'],
      click: async (t) => {
        if (t.description === 'dismiss') { noticeVisible = false; return { strategyUsed: 0, kind: 'css', matches: 1 }; }
        stepClicks++;
        if (stepClicks === 1) { noticeVisible = true; throw new Error('control obscured'); }
        return { strategyUsed: 0, kind: 'css', matches: 1 };
      },
      isTextVisible: async (text) => text === NOTICE && noticeVisible,
    });
    const logger = new RunLogger('replay', new Redactor(), 'evidence/test-runs');
    const result = await runReplay(irreversible, {}, { surface, logger, policy: allowIrreversible });
    expect(stepClicks).toBe(1);
    expect(result.recoveries).toEqual(['s1:notice']);
    expect(result.status).toBe('failure');
  });
});
