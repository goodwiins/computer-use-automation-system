# Audit Fixes (2026-09-01) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Close H1, M1, M4, M5, M6 and the dead-code items from `docs/audits/2026-09-01-codebase-audit.md`, each with a regression test.

**Architecture:** Six independent, small tasks on branch `dev`. Each task: failing test → minimal fix → green suite → commit. No task depends on another; do them in order anyway (security first).

**Tech Stack:** TypeScript (strict, NodeNext), vitest 2 → 4, zod, Playwright. Run everything with `npx`. Repo root: `/Users/goodwiinz/development/interface.ai`.

**Conventions:**
- Tests are hand-rolled stubs, no mocking libs. `test/fixes.test.ts` has `makeStubSurface()` — reuse it.
- Commit messages: `fix(scope): ...` / `chore(scope): ...`. End every commit body with:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0143Q4mqeCYvjHdtrNGtZjTD
  ```
- Full suite: `npx vitest run` (~20s, launches Chromium). Typecheck: `npx tsc --noEmit`.
- Baseline before starting: 75 tests pass, typecheck clean.

---

### Task 1: H1 — `originAllowed` resolves instead of prefix-matching

**Files:**
- Modify: `src/safety/policy.ts:57-70`
- Test: `test/safety.test.ts` (append to the existing `describe` that holds the protocol-relative cases, ~line 35)

**Step 1: Write the failing test**

Append inside the same `describe` block as the existing `'denies protocol-relative URLs'` test:

```ts
  it('denies backslash-spelled authority forms (WHATWG treats \\ as / for http)', () => {
    for (const u of ['/\\evil.example.com/x', '\\/evil.example.com/x', '/\\\\evil.example.com/x', '\\\\evil.example.com/x']) {
      expect(originAllowed(policy.allowedOrigins, u), u).toBe(false);
      expect(checkAction(policy, 'navigate', u, 'read').verdict, u).toBe('deny');
    }
  });

  it('still allows genuinely relative paths and query-only URLs', () => {
    expect(originAllowed(policy.allowedOrigins, '/members/search')).toBe(true);
    expect(originAllowed(policy.allowedOrigins, '?sim=maintenance')).toBe(true);
  });

  it('denies non-http schemes that parse but have a null origin', () => {
    expect(originAllowed(policy.allowedOrigins, 'javascript:alert(1)')).toBe(false);
    expect(originAllowed(policy.allowedOrigins, 'about:blank')).toBe(false);
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/safety.test.ts`
Expected: FAIL — `'/\\evil.example.com/x'` expected false, received true.

**Step 3: Replace `originAllowed`**

Replace the whole function at `src/safety/policy.ts:57-70` with:

```ts
export function originAllowed(allowed: string[], url: string): boolean {
  // Never classify "relative" by string prefix: WHATWG URL parsing treats
  // `\` as `/` for http(s), so `/\host`, `\/host`, `//host` all resolve to a
  // foreign origin. Resolve against a known-good base and compare origins —
  // a relative URL resolves to an allowed origin, an authority form does not.
  const base = allowed[0];
  if (!base) return false;
  try {
    return allowed.includes(new URL(url, base).origin);
  } catch {
    return false;
  }
}
```

**Step 4: Run the full suite + typecheck**

Run: `npx tsc --noEmit && npx vitest run`
Expected: all pass (78 tests). If `test/guarded.test.ts` or `fixes.test.ts` break on relative-URL cases, the base-resolution is wrong — do not weaken the test.

**Step 5: Commit**

```bash
git add src/safety/policy.ts test/safety.test.ts
git commit -m "fix(security): resolve URLs against an allowed base instead of prefix-matching

/\\host, \\/host and friends are authority forms under WHATWG parsing and
escaped the pre-navigation origin gate. Closes H1 of the 2026-09-01 audit."
```

---

### Task 2: M1 — retry the step after a successful mid-step recovery

**Files:**
- Modify: `src/replay/executor.ts:223-241` (the `catch` in `runStep`)
- Test: `test/fixes.test.ts` (new `describe` at end of file)

**Step 1: Write the failing test**

Append to `test/fixes.test.ts`:

```ts
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
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/fixes.test.ts -t "mid-step"`
Expected: first case FAILS — `stepClicks` 1, status `failure`. Second case may already pass.

**Step 3: Add the retry guard**

In `src/replay/executor.ts`, inside `runStep`'s `catch (err)` block, replace:

```ts
      const conditionResult = await handleConditions(step.id);
      if (conditionResult === CONTINUE_SENTINEL) return null;
      if (conditionResult) return conditionResult;
```

with:

```ts
      const recoveriesBefore = recoveries.length;
      const conditionResult = await handleConditions(step.id);
      if (conditionResult === CONTINUE_SENTINEL) return null;
      if (conditionResult) return conditionResult;
      // A recovery ran and cleared the condition that (most likely) broke this
      // step — re-run it once. Bounded: the retry's own failure is terminal.
      if (recoveries.length > recoveriesBefore && !isRetry) return runStep(step, true);
```

**Step 4: Run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: all pass (80 tests).

**Step 5: Commit**

```bash
git add src/replay/executor.ts test/fixes.test.ts
git commit -m "fix(replay): retry a step once after a mid-step recovery clears the condition

handleConditions returned null after a successful recovery and the caller
fell through to hard failure. Closes M1 of the 2026-09-01 audit."
```

---

### Task 3: M4 — `promoteToApproved` validates the artifact first

**Files:**
- Modify: `src/artifact/promote.ts:4-8`
- Modify: `test/promote.test.ts:4-22` (existing fixture is not a valid artifact — replace it)

**Step 1: Rewrite the test fixture and add a rejection case**

Replace the top of `test/promote.test.ts` (the `draft` const and the `promoteToApproved` describe) with:

```ts
import { describe, expect, it } from 'vitest';
import { assertSafeCapabilityName, promoteToApproved } from '../src/artifact/promote.js';

const draft = JSON.stringify({
  schemaVersion: 1,
  id: 'lookup', name: 'lookup', description: 'x', version: '1.0.0', status: 'draft',
  app: { appId: 'test', entryUrl: 'http://localhost:4173/', allowedOrigins: ['http://localhost:4173'] },
  parameters: [], outputs: [],
  steps: [{ id: 's1', intent: 'x', action: 'navigate', url: 'http://localhost:4173/', risk: 'read', timeoutMs: 1000 }],
  successCondition: { kind: 'urlMatches', pattern: '.*' },
  detectors: [],
  provenance: { discoveredAt: '2026-01-01T00:00:00Z', model: 'test', discoveryRunId: 'r1', goal: 'x' },
});

describe('promoteToApproved', () => {
  it('flips draft to approved and preserves everything else', () => {
    const out = JSON.parse(promoteToApproved(draft));
    expect(out.status).toBe('approved');
    expect(out.id).toBe('lookup');
    expect(out.version).toBe('1.0.0');
    expect(out.steps).toHaveLength(1);
  });
  it('is idempotent on an already-approved artifact', () => {
    const approved = JSON.stringify({ ...JSON.parse(draft), status: 'approved' });
    expect(JSON.parse(promoteToApproved(approved)).status).toBe('approved');
  });
  it('refuses to approve an artifact that does not match the schema', () => {
    expect(() => promoteToApproved(JSON.stringify({ schemaVersion: 1, id: 'x', status: 'draft' }))).toThrow();
    expect(() => promoteToApproved(JSON.stringify({ ...JSON.parse(draft), steps: [] }))).toThrow();
  });
});
```

Keep the `assertSafeCapabilityName` describe as-is.

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/promote.test.ts`
Expected: `refuses to approve` FAILS (no throw).

**Step 3: Validate in `promoteToApproved`**

Replace `src/artifact/promote.ts:4-8` with:

```ts
import { CapabilityArtifact } from './schema.js';

/** Approval is a statement about a *valid* artifact — parse before stamping. */
export function promoteToApproved(artifactJson: string): string {
  const artifact = CapabilityArtifact.parse(JSON.parse(artifactJson));
  return JSON.stringify({ ...artifact, status: 'approved' }, null, 2);
}
```

Note: `parse` applies zod defaults (e.g. `risk`, `timeoutMs`, `detectors: []`), so the written file may gain explicit default fields. That is acceptable and makes the approved file self-describing.

**Step 4: Run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: all pass (81 tests). Also sanity-check the committed artifacts still round-trip:
`npx tsx -e 'import {promoteToApproved} from "./src/artifact/promote.ts"; import {readFileSync} from "node:fs"; for (const f of ["artifacts/lookup-member-balance.v1.0.0.json","artifacts/open-subaccount-to-confirmation.v1.0.0.json"]) { promoteToApproved(readFileSync(f,"utf8")); console.log("ok", f) }'`
Expected: two `ok` lines. Do **not** rewrite the committed artifacts.

**Step 5: Commit**

```bash
git add src/artifact/promote.ts test/promote.test.ts
git commit -m "fix(artifact): validate against the schema before promoting to approved

Closes M4 of the 2026-09-01 audit."
```

---

### Task 4: M5 — `surface.start` failure is a structured pre-flight failure

**Files:**
- Modify: `src/replay/executor.ts:67-68`
- Test: `test/fixes.test.ts` (new `describe`)

**Step 1: Write the failing test**

Append to `test/fixes.test.ts`:

```ts
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
```

Add to the imports at the top of `test/fixes.test.ts`:

```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run test/fixes.test.ts -t "pre-flight start"`
Expected: FAIL — rejected with `browser launch failed` (unhandled throw, no result).

**Step 3: Route `start` through `fail`**

In `src/replay/executor.ts`, replace:

```ts
  logger.log('replay.start', { capability: artifact.id, version: artifact.version, params });
  await surface.start(resolveTemplate(artifact.app.entryUrl, params));
```

with:

```ts
  logger.log('replay.start', { capability: artifact.id, version: artifact.version, params });
  try {
    await surface.start(resolveTemplate(artifact.app.entryUrl, params));
  } catch (err) {
    return fail({
      stepId: '(pre-flight)',
      intent: 'open the capability entry URL',
      expected: `a live session at ${artifact.app.entryUrl}`,
      observed: err instanceof Error ? err.message : String(err),
    });
  }
```

(`fail` is a hoisted function declaration; it is already used above this point.)

**Step 4: Run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: all pass (82 tests).

**Step 5: Commit**

```bash
git add src/replay/executor.ts test/fixes.test.ts
git commit -m "fix(replay): report a failed surface.start as a structured pre-flight failure

Previously an uncaught throw left no result.json and skipped surface.close().
Closes M5 of the 2026-09-01 audit."
```

---

### Task 5: Dead-code removal (ponytail)

**Files:**
- Modify: `cli.ts:10` (drop `newRunId` from import)
- Modify: `src/artifact/recorder.ts:10,156-158` (delete `newRunId` and the `randomUUID` import)
- Modify: `src/escalation/session.ts:49-51` (delete `history()`)
- Modify: `src/agent/loop.ts:148-153` (drop cast + stale comment)
- Modify: `src/surface/browser.ts:87,97,103` (drop `_risk?: string` params)
- Modify: `src/replay/detectors.ts:18-30` (drop `DetectorHit` wrapper)
- Modify: `src/replay/executor.ts:81-83` (adapt to `Detector | null`)

**Step 1: Confirm nothing references the dead symbols**

Run: `grep -rn "newRunId\|\.history()\|DetectorHit\|randomUUID" src cli.ts test scripts`
Expected: only the definitions/imports listed above. If a test references any, stop and report.

**Step 2: Apply the deletions**

`cli.ts:10`:
```ts
import { recordArtifact } from './src/artifact/recorder.js';
```

`src/artifact/recorder.ts`: delete line 10 (`import { randomUUID } ...`) and lines 156-158 (`export function newRunId ...`).

`src/escalation/session.ts`: delete lines 49-51 (`history() { ... }`).

`src/agent/loop.ts:148-153`, replace:
```ts
            // Surface.click's public signature omits risk (only GuardedSurface
            // consumes it, to gate discovery's risky clicks like replay's).
            await (surface.click as (t: TargetDescriptor, ms?: number, risk?: string) => Promise<unknown>)(
              descriptor, undefined, risk,
            );
```
with:
```ts
            await surface.click(descriptor, undefined, risk);
```

`src/surface/browser.ts`: remove the trailing `, _risk?: string` parameter from `click`, `fill`, `select` (lines 87, 97, 103). TypeScript permits an implementation with fewer parameters than the interface.

`src/replay/detectors.ts`, replace lines 18-30 with:
```ts
/** First matching detector (artifact-declared first, then built-ins), or null. */
export async function checkDetectors(surface: Surface, artifact: CapabilityArtifact): Promise<Detector | null> {
  for (const detector of [...artifact.detectors, ...BUILTIN_DETECTORS]) {
    if (await matchDetector(surface, detector)) return detector;
  }
  return null;
}
```

`src/replay/executor.ts:81-83`, replace:
```ts
        const hit = await checkDetectors(surface, artifact);
        if (!hit) return null;
        const d = hit.detector;
```
with:
```ts
        const d = await checkDetectors(surface, artifact);
        if (!d) return null;
```

**Step 3: Typecheck + full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean, all pass (82 tests). No behavior change.

**Step 4: Commit**

```bash
git add cli.ts src/artifact/recorder.ts src/escalation/session.ts src/agent/loop.ts src/surface/browser.ts src/replay/detectors.ts src/replay/executor.ts
git commit -m "chore: remove dead code flagged by the 2026-09-01 audit

newRunId, ControlSession.history, unused _risk params, obsolete click cast,
one-field DetectorHit wrapper."
```

---

### Task 6: M6 — bump vitest to clear `npm audit`

**Files:**
- Modify: `package.json` (devDependencies.vitest), `package-lock.json`

**Step 1: Record baseline**

Run: `npm audit --audit-level=moderate; echo "exit=$?"`
Expected: 5 vulnerabilities, non-zero exit.

**Step 2: Upgrade**

Run: `npm install -D vitest@4`
Expected: lockfile updated; no peer-dep errors. If `@vitest/*` peer warnings mention `vite`, that is fine — vite is transitive.

**Step 3: Verify**

Run: `npm audit --audit-level=moderate; echo "exit=$?"`
Expected: `found 0 vulnerabilities`, `exit=0`.

Run: `npx tsc --noEmit && npx vitest run`
Expected: all 82 tests pass. vitest 4 removed nothing this suite uses (plain `describe/it/expect`); if a test fails on a vitest API change (not on behavior), fix the test call, not the source.

**Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): vitest 2 -> 4 to clear npm audit findings

All flagged advisories were vite/esbuild/vitest dev-server issues in
devDependencies. Closes M6 of the 2026-09-01 audit."
```

---

### Task 7: Update the audit doc

**Files:**
- Modify: `docs/audits/2026-09-01-codebase-audit.md` (header, after the "Baseline" paragraph)

**Step 1: Add fix-status line**

Insert after the baseline paragraph:

```markdown
**Fix status (<today>, commit <sha of Task 6>):** H1, M1, M4, M5, M6 and the
Ponytail deletions are fixed with regression tests (82 total). Open: M2, M3,
L1–L7, and the Aug-22 carry-overs (M2, M3, M4 signing, M5, L1, L3).
```

Fill `<sha>` from `git rev-parse --short HEAD`.

**Step 2: Commit**

```bash
git add docs/audits/2026-09-01-codebase-audit.md docs/plans/2026-09-01-audit-fixes.md
git commit -m "docs(audit): mark H1/M1/M4/M5/M6 fixed; add fix plan"
```

**Step 3: Final verification**

Run: `git log --oneline -8 && npx tsc --noEmit && npx vitest run 2>&1 | tail -4 && npm audit --audit-level=moderate | tail -1`
Expected: 7 new commits, typecheck clean, 82 passed, 0 vulnerabilities.
