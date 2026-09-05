// Regression tests for the security-review fix batch: origin enforcement,
// injection hardening, and the sentinel double-execution bug. Small,
// hand-rolled fixtures throughout — these are unit tests for the guardrails
// themselves, not end-to-end flows (see e2e.test.ts for that).

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  CapabilityArtifact,
  Detector,
  Step,
  resolveTemplate,
  resolveTemplateForRegex,
  validateParams,
} from '../src/artifact/schema.js';
import { OperatorConsole } from '../src/escalation/operator.js';
import { ControlSession, type InterventionDecision } from '../src/escalation/session.js';
import { Redactor } from '../src/safety/redact.js';
import { Policy } from '../src/safety/policy.js';
import { RunLogger } from '../src/evidence/logger.js';
import { runReplay } from '../src/replay/executor.js';
import { runDiscovery } from '../src/agent/loop.js';
import { applyOverlay, TenantOverlay } from '../src/artifact/overlay.js';
import { recordArtifact } from '../src/artifact/recorder.js';
import { BrowserSurface } from '../src/surface/browser.js';
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

  // The logger is always handed the *guarded* surface (cli.ts wires it that
  // way for both discover and replay), so a decorator that drops the options
  // silently unmasks every evidence screenshot in every real run.
  it('survives the GuardedSurface decorator', async () => {
    const seen: Array<unknown> = [];
    const inner = makeStubSurface({
      screenshot: async (_path: string, opts?: { maskValues?: string[] }) => {
        seen.push(opts);
      },
    });
    const guarded = new GuardedSurface(inner, policy, async () => false);
    const redactor = new Redactor();
    redactor.addSensitiveValues(['SECRETPASSWORD']);
    const logger = new RunLogger('replay', redactor, 'evidence/test-runs');
    await logger.screenshot(guarded, 'masked-shot-through-guard');
    expect(seen[0]).toEqual({ maskValues: ['SECRETPASSWORD'] });
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

describe('pre-flight start failure', () => {
  it('returns a structured failure (and writes result.json) when the surface cannot start', async () => {
    const artifact = CapabilityArtifact.parse({
      schemaVersion: 1, id: 'start-fail', name: 'start-fail', description: 'x', version: '1.0.0', status: 'approved',
      app: { appId: 'test', entryUrl: 'http://localhost:4173/', allowedOrigins: ['http://localhost:4173'] },
      parameters: [], outputs: [],
      steps: [{ id: 's1', intent: 'x', action: 'navigate', url: 'http://localhost:4173/', risk: 'read', timeoutMs: 1000 }],
      successCondition: { kind: 'urlMatches', pattern: '.*' },
      detectors: [],
      provenance: { discoveredAt: '2026-01-01T00:00:00Z', model: 'test', discoveryRunId: 'r1', goal: 'x' },
    });
    const surface = makeStubSurface({ start: async () => { throw new Error('browser launch failed'); } });
    const logger = new RunLogger('replay', new Redactor(), 'evidence/test-runs');
    const result = await runReplay(artifact, {}, { surface, logger, policy });
    expect(result.status).toBe('failure');
    if (result.status === 'failure') {
      expect(result.failure.stepId).toBe('(pre-flight)');
      expect(result.failure.observed).toContain('browser launch failed');
    }
    expect(existsSync(join(logger.dir, 'result.json'))).toBe(true);
  });
});

describe('Aug-22 audit carry-overs (A-M2, A-M3, A-M5)', () => {
  it('A-M2: masks AWS/GitHub/Slack/Google token shapes', () => {
    const r = new Redactor();
    const out = r.redactString(
      'AKIAIOSFODNN7EXAMPLE ghp_' + 'a'.repeat(36) + ' xoxb-1234567890-abc AIza' + 'b'.repeat(35),
    );
    expect(out).not.toMatch(/AKIA|ghp_|xoxb|AIza/);
  });

  it('A-M2: masks the URL-encoded form of a sensitive value', () => {
    const r = new Redactor();
    r.addSensitiveValues(['p@ss word']);
    expect(r.redactString('q=p%40ss%20word&x=p@ss word')).not.toMatch(/p%40ss|p@ss/);
  });

  it('A-M3: rejects urlMatches patterns with quantified groups or invalid syntax', () => {
    const det = (pattern: string) =>
      Detector.safeParse({ id: 'd', description: '', match: { kind: 'urlMatches', pattern }, classification: 'fatal' }).success;
    expect(det('^(a+)+$')).toBe(false);
    expect(det('(')).toBe(false);
    expect(det('/members/{{id}}$')).toBe(true);
  });

  it('A-M5: --param without a value exits with an error instead of a TypeError', () => {
    const res = spawnSync('npx', ['tsx', 'cli.ts', 'replay', '--param'], { encoding: 'utf8' });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('--param requires a value');
  });

  it('S-M3: `validate` passes over the committed artifacts (risk labels meet the current floor)', () => {
    const res = spawnSync('npx', ['tsx', 'cli.ts', 'validate'], { encoding: 'utf8' });
    expect(res.stdout).toContain('All artifacts satisfy');
    expect(res.status).toBe(0);
  });
});

describe('Sep-02 audit LOW findings', () => {
  it('S-L1: a nameAttr containing a quote still resolves (selector is escaped)', async () => {
    const surface = new BrowserSurface();
    await surface.start('data:text/html,' + encodeURIComponent(`<input type="text" name='a"b' value="hit">`));
    try {
      const { report } = await surface.readText(
        { description: 'quoted name', strategies: [{ kind: 'nameAttr', name: 'a"b' }] },
        3000,
      );
      expect(report).toMatchObject({ strategyUsed: 0, kind: 'nameAttr', matches: 1 });
    } finally {
      await surface.close();
    }
  }, 30_000);

  const TSX = resolve('node_modules/.bin/tsx');
  const CLI = resolve('cli.ts');

  it('S-L5: `list` reports a malformed artifact inline and still lists the good ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cu-list-'));
    mkdirSync(join(dir, 'artifacts'));
    cpSync('artifacts/lookup-member-balance.v1.0.0.json', join(dir, 'artifacts/good.json'));
    writeFileSync(join(dir, 'artifacts/broken.json'), '{ not json');
    const res = spawnSync(TSX, [CLI, 'list'], { cwd: dir, encoding: 'utf8' });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain('broken.json: unreadable');
    expect(res.stdout).toContain('lookup-member-balance@1.0.0');
  }, 60_000);

  it('S-L3/S-L4: replay redacts stdout, including a sensitive param whose value is 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cu-replay-'));
    // Port 9 (discard) is never served, so the run fails in pre-flight and the
    // entry URL — carrying both sensitive values — lands in failure.observed.
    const origin = 'http://localhost:9';
    writeFileSync(join(dir, 'policy.json'), JSON.stringify({
      allowedOrigins: [origin],
      allowedActions: ['navigate'],
      riskHandling: { read: 'allow', reversible_write: 'allow', irreversible: 'escalate' },
    }));
    writeFileSync(join(dir, 'artifact.json'), JSON.stringify({
      schemaVersion: 1, id: 'redact-stdout', name: 'redact-stdout', description: 'x',
      version: '1.0.0', status: 'approved',
      app: { appId: 'test', entryUrl: `${origin}/?token=ZZSECRETZZ&n=0`, allowedOrigins: [origin] },
      parameters: [
        { name: 'token', type: 'string', description: 'x', required: true, sensitive: true },
        { name: 'n', type: 'number', description: 'x', required: true, sensitive: true },
      ],
      outputs: [],
      steps: [{ id: 's1', intent: 'x', action: 'navigate', url: `${origin}/`, risk: 'read', timeoutMs: 1000 }],
      successCondition: { kind: 'urlMatches', pattern: '.*' },
      detectors: [],
      provenance: { discoveredAt: '2026-01-01T00:00:00Z', model: 'test', discoveryRunId: 'r1', goal: 'x' },
    }));
    const res = spawnSync(
      TSX,
      [CLI, 'replay', '--artifact', join(dir, 'artifact.json'), '--params', '{"token":"ZZSECRETZZ","n":0}'],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, POLICY_PATH: join(dir, 'policy.json') } },
    );
    expect(res.stdout).toContain('failure');
    expect(res.stdout).not.toContain('ZZSECRETZZ'); // S-L4
    expect(res.stdout).not.toContain('n=0'); // S-L3: a 0-valued sensitive param is still registered
  }, 60_000);

  it('A-L1: an out-of-range CU_CDP_PORT is rejected before chromium launches', async () => {
    const prev = process.env.CU_CDP_PORT;
    process.env.CU_CDP_PORT = '80; rm -rf /';
    try {
      await expect(new BrowserSurface().start('about:blank')).rejects.toThrow(/CU_CDP_PORT/);
    } finally {
      if (prev === undefined) delete process.env.CU_CDP_PORT;
      else process.env.CU_CDP_PORT = prev;
    }
  });

  it('A-L3: the select value= fallback shares the budget instead of doubling it', async () => {
    const surface = new BrowserSurface();
    await surface.start(
      'data:text/html,' + encodeURIComponent('<select name="s"><option value="v">Label</option></select>'),
    );
    const started = Date.now();
    try {
      // Neither the label nor the value matches, so both attempts time out.
      await expect(
        surface.select({ description: 'sel', strategies: [{ kind: 'nameAttr', name: 's' }] }, 'nope', 2000),
      ).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(3200); // 2x2000 before the fix
    } finally {
      await surface.close();
    }
  }, 30_000);

  it('S-L6: the page-callable human-action binding stops logging at the cap', async () => {
    let report!: (source: unknown, action: unknown) => void;
    const page = {
      exposeBinding: async (_n: string, fn: (s: unknown, a: unknown) => void) => void (report = fn),
      frames: () => [],
      on: () => {},
      off: () => {},
    };
    const events: string[] = [];
    const session = new ControlSession();
    session.transfer('human', 'test');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const op = new OperatorConsole(page as any, { log: (e: string) => events.push(e) } as any, session);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (op as any).recordHumanActions();
    for (let i = 0; i < 250; i++) report(null, { type: 'click' }); // hostile page floods the binding
    expect(events.filter((e) => e === 'human.action')).toHaveLength(200);
    expect(events.filter((e) => e === 'human.action.capped')).toHaveLength(1);
  });

  it('keeps terminal-only risk approval out of the browser and refuses non-TTY input', async () => {
    const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const bringToFront = vi.fn(async () => {});
    const page = {
      isClosed: () => false,
      bringToFront,
      exposeBinding: async () => {},
      frames: () => [],
      on: (event: string, callback: () => void) => { if (event === 'close') queueMicrotask(callback); },
      off: () => {},
    };
    const events: Array<{ event: string; data: unknown }> = [];
    const session = new ControlSession();
    const op = new OperatorConsole(page as never, { log: (event: string, data: unknown) => events.push({ event, data }) } as never, session);

    try {
      await expect(op.intervene({ kind: 'risk_approval', capability: 'hold', goal: 'apply hold', reason: 'posting requires approval', url: 'https://example.test/review' })).resolves.toBe('abort');

      expect(bringToFront).not.toHaveBeenCalled();
      expect(session.currentOwner).toBe('automation');
      expect(events.at(-1)).toEqual({ event: 'handoff.to_automation', data: { decision: 'abort', reason: 'stdin_not_tty' } });

      await expect(op.intervene({ kind: 'replay_stuck', capability: 'hold', goal: 'apply hold', reason: 'repair required', url: 'https://example.test/review' })).resolves.toBe('abort');
      expect(bringToFront).toHaveBeenCalledOnce();
    } finally {
      consoleLog.mockRestore();
      if (stdinIsTTY) Object.defineProperty(process.stdin, 'isTTY', stdinIsTTY);
      else delete (process.stdin as { isTTY?: boolean }).isTTY;
    }
  });

  it('S-L2: a short sensitive value is masked as a whole token, not as a substring', () => {
    const r = new Redactor();
    r.addSensitiveValues([1, 'SECRETPASSWORD']);
    const out = r.redactString('id=1 amount 12 at step s1 — xSECRETPASSWORDy');
    expect(out.startsWith('id=•')).toBe(true); // the standalone value is masked
    expect(out).toContain('amount 12'); // ...but not inside a longer number
    expect(out).toContain('step s1'); // ...nor inside an identifier
    expect(out).not.toContain('SECRETPASSWORD'); // long values stay substring-masked
  });
});

describe('brief §3.1/§3.3 gaps closed 2026-09-02', () => {
  const clickArtifact = (detectors: unknown[] = []) =>
    CapabilityArtifact.parse({
      schemaVersion: 1, id: 'gap-fixture', name: 'gap-fixture', description: 'test', version: '1.0.0', status: 'approved',
      app: { appId: 'test', entryUrl: 'http://localhost:4173/', allowedOrigins: ['http://localhost:4173'] },
      parameters: [], outputs: [],
      steps: [{ id: 's1', intent: 'click it', action: 'click', target: { description: 'x', strategies: [{ kind: 'css', selector: '#x' }] }, risk: 'read', timeoutMs: 500 }],
      successCondition: { kind: 'urlMatches', pattern: '.*' },
      detectors,
      provenance: { discoveredAt: '2026-01-01T00:00:00Z', model: 'test', discoveryRunId: 'r1', goal: 'test' },
    });

  it('discovery stops on the wall-clock deadline without calling the model', async () => {
    let modelCalls = 0;
    const openai = { chat: { completions: { create: async () => { modelCalls++; throw new Error('should not be called'); } } } } as never;
    const logger = new RunLogger('discovery', new Redactor(), 'evidence/test-runs');
    const r = await runDiscovery('goal', 'http://localhost:4173/', {}, policy.allowedOrigins, {
      surface: makeStubSurface(), logger, openai, model: 'stub', maxSteps: 5, timeoutMs: -1,
    });
    expect(r.status).toBe('stopped');
    expect(r.stopReason).toMatch(/timeout/);
    expect(modelCalls).toBe(0);
  });

  it('BrowserSurface dismisses a native confirm() and reports it via drainDialogs', async () => {
    const surface = new BrowserSurface();
    await surface.start('data:text/html,' + encodeURIComponent(`<a id="go" href="#" onclick="return confirm('Sure?')">go</a>`));
    try {
      await surface.click({ description: 'go', strategies: [{ kind: 'css', selector: '#go' }] }, 3000);
      expect(surface.drainDialogs()).toEqual([{ type: 'confirm', message: 'Sure?' }]);
      expect(surface.drainDialogs()).toEqual([]);
    } finally {
      await surface.close();
    }
  });

  it('a dismissed dialog is named in the failure the caller receives', async () => {
    const surface = makeStubSurface({
      click: async () => { throw new Error('Could not uniquely resolve target'); },
      drainDialogs: () => [{ type: 'confirm', message: 'Continue?' }],
    });
    const logger = new RunLogger('replay', new Redactor(), 'evidence/test-runs');
    const result = await runReplay(clickArtifact(), {}, { surface, logger, policy });
    expect(result.status).toBe('failure');
    if (result.status !== 'failure') throw new Error('unreachable');
    expect(result.failure.observed).toMatch(/unexpected confirm dialog "Continue\?" was dismissed at s1; then Could not/);
  });

  it('a permission-denied page is a fatal condition, not a resolution failure', async () => {
    const DENIED = 'Operator not authorized for this function';
    const surface = makeStubSurface({ isTextVisible: async (t: string) => t === DENIED });
    const logger = new RunLogger('replay', new Redactor(), 'evidence/test-runs');
    const artifact = clickArtifact([
      { id: 'permission-denied', description: 'SEC-4031', match: { kind: 'textVisible', text: DENIED }, classification: 'fatal' },
    ]);
    const result = await runReplay(artifact, {}, { surface, logger, policy });
    expect(result.status).toBe('failure');
    if (result.status !== 'failure') throw new Error('unreachable');
    expect(result.failure.observed).toMatch(/permission-denied/);
  });
});

describe('security review 2026-09-03 (G1/G2/G3)', () => {
  const TSX2 = resolve('node_modules/.bin/tsx');
  const CLI2 = resolve('cli.ts');
  const BASE = CapabilityArtifact.parse({
    schemaVersion: 1, id: 'ov-base', name: 'ov-base', description: 'x', version: '1.0.0', status: 'approved',
    app: { appId: 'test', entryUrl: 'http://localhost:4173/', allowedOrigins: ['http://localhost:4173'] },
    parameters: [], outputs: [],
    steps: [{ id: 's1', intent: 'x', action: 'navigate', url: 'http://localhost:4173/', risk: 'read', timeoutMs: 1000 }],
    successCondition: { kind: 'urlMatches', pattern: '.*' },
    detectors: [],
    provenance: { discoveredAt: '2026-01-01T00:00:00Z', model: 'test', discoveryRunId: 'r1', goal: 'x' },
  });
  const overlay = (extra: Record<string, unknown> = {}) =>
    TenantOverlay.parse({ schemaVersion: 1, tenant: 't', appId: 'test', base: { id: 'ov-base', version: '1.0.0' }, ...extra });

  it('G1: a sensitive value supplied by an overlay default is redacted from stdout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cu-ovl-'));
    const origin = 'http://localhost:9'; // discard port: fails in pre-flight, entry URL lands in failure.observed
    writeFileSync(join(dir, 'policy.json'), JSON.stringify({
      allowedOrigins: [origin], allowedActions: ['navigate'],
      riskHandling: { read: 'allow', reversible_write: 'allow', irreversible: 'escalate' },
    }));
    writeFileSync(join(dir, 'artifact.json'), JSON.stringify({
      schemaVersion: 1, id: 'ovl-redact', name: 'ovl-redact', description: 'x', version: '1.0.0', status: 'approved',
      app: { appId: 'test', entryUrl: `${origin}/?pin=OVERLAYSECRET`, allowedOrigins: [origin] },
      parameters: [{ name: 'pin', type: 'string', description: 'x', required: true, sensitive: true }],
      outputs: [],
      steps: [{ id: 's1', intent: 'x', action: 'navigate', url: `${origin}/`, risk: 'read', timeoutMs: 1000 }],
      successCondition: { kind: 'urlMatches', pattern: '.*' },
      detectors: [],
      provenance: { discoveredAt: '2026-01-01T00:00:00Z', model: 'test', discoveryRunId: 'r1', goal: 'x' },
    }));
    // The secret exists ONLY in the overlay's paramDefaults — never in --params.
    writeFileSync(join(dir, 'overlay.json'), JSON.stringify({
      schemaVersion: 1, tenant: 't', status: 'approved', appId: 'test',
      base: { id: 'ovl-redact', version: '1.0.0' }, paramDefaults: { pin: 'OVERLAYSECRET' },
    }));
    const res = spawnSync(
      TSX2, [CLI2, 'replay', '--artifact', join(dir, 'artifact.json'), '--overlay', join(dir, 'overlay.json')],
      { cwd: dir, encoding: 'utf8', env: { ...process.env, POLICY_PATH: join(dir, 'policy.json') } },
    );
    expect(res.stdout).toContain('failure');
    expect(res.stdout).not.toContain('OVERLAYSECRET');
  }, 60_000);

  it('G2: the recorder discards parameter-dependent CSS and retains structural fallbacks', () => {
    const artifact = recordArtifact(
      {
        name: 'css-tmpl', description: 'x', goal: 'x', entryUrl: 'http://localhost:4173/',
        params: { memberId: '10042' }, sensitiveParams: ['memberId'],
        appId: 'test', allowedOrigins: ['http://localhost:4173'], appDetectors: [],
        model: 'test', discoveryRunId: 'r1',
      },
      {
        status: 'success', outputs: {}, finalUrl: 'http://localhost:4173/members/10042',
        trace: [{
          action: 'click', reason: 'open the row', urlAfter: 'http://localhost:4173/members/10042',
          descriptor: { description: 'row', strategies: [{ kind: 'css', selector: "tr:has(> td:text-is('10042')) > td:nth-of-type(2)" }, { kind: 'css', selector: 'tr:nth-of-type(1) > td:nth-of-type(2)' }] },
        }],
      },
    );
    const sel = JSON.stringify(artifact.steps[0]!.target!.strategies);
    expect(sel).not.toContain('10042');       // the raw value must never be persisted
    expect(sel).not.toContain('{{memberId}}');
    expect(sel).toContain('tr:nth-of-type(1)');
  });

  // ...but not at any cost: a short value collides with selector syntax, and a
  // {{param}} substituted into nth-of-type() re-aims the selector at a different
  // cell on the next replay — a silently wrong extracted value.
  it('G2: a param too short to distinguish from selector syntax is left literal', () => {
    const artifact = recordArtifact(
      {
        name: 'css-short', description: 'x', goal: 'x', entryUrl: 'http://localhost:4173/',
        params: { col: '4' }, sensitiveParams: [],
        appId: 'test', allowedOrigins: ['http://localhost:4173'], appDetectors: [],
        model: 'test', discoveryRunId: 'r1',
      },
      {
        status: 'success', outputs: {}, finalUrl: 'http://localhost:4173/members/1',
        trace: [{
          action: 'extract', reason: 'read the balance', outputName: 'balance', extractedText: '1.00',
          urlAfter: 'http://localhost:4173/members/1',
          descriptor: { description: 'balance cell', strategies: [{ kind: 'css', selector: "tr:has(> td:text-is('SAVINGS')) > td:nth-of-type(4)" }] },
        }],
      },
    );
    const strategy = artifact.steps[0]!.target!.strategies[0]!;
    expect(strategy.kind === 'css' && strategy.selector).toBe("tr:has(> td:text-is('SAVINGS')) > td:nth-of-type(4)");
  });

  it('G2: a short *sensitive* param inside a css selector refuses to record rather than persist it', () => {
    expect(() => recordArtifact(
      {
        name: 'css-pin', description: 'x', goal: 'x', entryUrl: 'http://localhost:4173/',
        params: { pin: '123' }, sensitiveParams: ['pin'],
        appId: 'test', allowedOrigins: ['http://localhost:4173'], appDetectors: [],
        model: 'test', discoveryRunId: 'r1',
      },
      {
        status: 'success', outputs: {}, finalUrl: 'http://localhost:4173/members/1',
        trace: [{
          action: 'click', reason: 'open the row', urlAfter: 'http://localhost:4173/members/1',
          descriptor: { description: 'row', strategies: [{ kind: 'css', selector: "tr:has(> td:text-is('123')) > td:nth-of-type(2)" }] },
        }],
      },
    )).toThrow(/no safe target strategy/);
  });

  it('G3: a rejected overlay entryUrl is reported without its query string', () => {
    let msg = '';
    try { applyOverlay(BASE, overlay({ status: 'approved', entryUrl: 'http://evil.test/login?pin=OVERLAYSECRET' })); }
    catch (e) { msg = (e as Error).message; }
    expect(msg).toMatch(/outside the base artifact allowed origins/);
    expect(msg).not.toContain('http://evil.test/login');
    expect(msg).not.toContain('OVERLAYSECRET');
  });

  it('G3: an overlay is only as approved as itself, and its entryUrl is bounds-checked', () => {
    expect(applyOverlay(BASE, overlay()).status).toBe('draft');                         // default: unreviewed
    expect(applyOverlay(BASE, overlay({ status: 'approved' })).status).toBe('approved');
    expect(applyOverlay({ ...BASE, status: 'draft' }, overlay({ status: 'approved' })).status).toBe('draft');
    expect(() => applyOverlay(BASE, overlay({ status: 'approved', entryUrl: 'http://evil.test/' })))
      .toThrow(/outside the base artifact allowed origins/);
  });
});
