# MERIDIAN CORE Adaptation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete and demonstrate all seven MERIDIAN capabilities through the existing discovery, replay, API, chat, and operator approval workflow.

**Architecture:** Reuse the implementation in PR #34 and safety evaluation in PR #35. One Express process owns one active browser run, guarded actions, approvals, and the durable filesystem journal. Complete the missing live recordings and validation; do not rebuild those subsystems.

**Tech Stack:** Node 22, TypeScript, Express, Playwright, Zod, OpenAI/Azure, Vitest, static HTML/CSS/JavaScript; no new dependency.

**Spec:** [MERIDIAN CORE adaptation — replacement plan](2026-09-03-meridian-adaptation.md). Read it alongside this document. Its requirements remain authoritative; this document replaces its outdated implementation sequence and production-branch starting point.

**Execution status:** Resumed by the user on September 4, 2026, with a separate PR against `dev` for each major task. Tasks 5a–5b are delivered for review in [PR #39](https://github.com/goodwiins/computer-use-automation-system/pull/39), using isolated branch `codex/meridian-transfer-runtime` from `5bc21fe9728b59ce6c9cf2013c48b85646eaf179`. Preserve the earlier acceptance worktree and its draft artifact. Each live posting still requires its own approval on current facts; implementation authorization does not reuse an earlier posting decision.

## Global Constraints

- “All seven required functions must work, including approved posting.”
- “One server process, one active run, one visible browser per run, filesystem persistence, and a plain HTML/CSS/JavaScript frontend.”
- “Three working days is the target, including integration and rehearsal.” This was the original estimate, not three additional days or a promise of completion despite target failures.
- “No automatic privilege upgrade or mid-flow login recovery.”
- “Use validated decimal strings for money and integer cents for comparisons.”
- “Continue loading version 1 artifacts unchanged.” Schema version and capability version are distinct: a schema-v2 artifact may be named `*.v1.0.0.json`.
- “The chat tool executor receives only invocation/status functions bound to the caller principal.”
- “A duplicate or stale decision returns `409`; an unauthorized decision returns `403`.”
- “Durably record mutation dispatch intent immediately before the final submit.”
- “Never resume their browser actions automatically.”
- “Evidence protection is required before live recording.”
- “An unfinished function or failed safety gate remains explicitly incomplete; it is not replaced by a mock and counted as delivered.”
- User branch rule: all new PRs target `dev`. `master` is the actual production branch in this repository; the user calls it main. Do not rewrite or deploy production.
- User delivery rule: each major task gets its own PR against `dev`, including its relevant tests and documentation. Do not combine the remaining implementation into one delivery PR; use the boundaries below.
- Preserve the dirty primary checkout. Use an isolated worktree and a `codex/` branch from `origin/dev`.
- Each posting requires a separate human decision on current live facts. Artifact promotion is not transaction approval. Do not synthesize approvals in a terminal or dashboard.

---

## Verified planning baseline — September 4, 2026

| Ref | SHA | Observed state |
| --- | --- | --- |
| `origin/dev` | `787ba16` | PR #33 merged; contains the replacement design |
| PR #34 | `cd3ec9e7c5141d8e69a6c9a13043d0c433016113` | Draft implementation; base is currently `master`; hosted Typecheck and tests succeeded |
| PR #35 | `338734d16e7fc4d0f30f239886660e0f1af30a6c` | Safety/evaluation follow-up stacked on #34; hosted Typecheck and tests succeeded |

These are inspected historical snapshots, not authorization to merge. Refresh refs, reviews, and checks at execution; the current integrated baseline is recorded below.

## Current integrated baseline — September 4, 2026

Task 1 is now integrated into `dev` at `4252cb70396b3f30f5c126d2ed2e164054a2bcfe`; its tree equals the reviewed `def4b38a2f906f725813f5c89563f3fe82e31140`. The exact PR-head checks passed at `33847936549` (producer `100943958989`) on `def4b38a2f906f725813f5c89563f3fe82e31140`, and the subsequent dev merge check passed at `33848572273` (producer `100945942684`) on `4252cb70396b3f30f5c126d2ed2e164054a2bcfe`; the resulting trees are equal. Task 4's `codex/meridian-capability-acceptance` branch starts from this commit. These CI results validate the integrated code baseline; they do not establish live capability behavior.

The current acceptance worktree is `codex/meridian-capability-acceptance` at `745ef645ae48730e769e6fc639ec4f71739d23e8`. [PR #37](https://github.com/goodwiins/computer-use-automation-system/pull/37) remains open against `dev`; it contains `test/meridian-artifacts.test.ts` plus the dashboard timing/read acceptance, and its [hosted check](https://github.com/goodwiins/computer-use-automation-system/actions/runs/33859462030/job/100980319268) passed on that SHA. Separately, [PR #38](https://github.com/goodwiins/computer-use-automation-system/pull/38) merged into `dev` at `5bc21fe9728b59ce6c9cf2013c48b85646eaf179`, with [successful merge CI](https://github.com/goodwiins/computer-use-automation-system/actions/runs/33872301781) on that exact SHA. [PR #39](https://github.com/goodwiins/computer-use-automation-system/pull/39) remains open at head `b093b6503a39339399f57c2d59a3d5f5b417c18d`; its 248 tests and hosted CI pass as recorded there, but its runtime branch does not contain PR #37's artifact catalog test. The transfer draft, catalog-test edit and local evidence are uncommitted; neither PR #37 nor #39's checks cover the complete post-integration tree. Preserve those files and coordinate branch integration before future artifact work; do not infer that this worktree already includes the dev merge.

### Required integration gate for PRs #37 and #39

PR #37 and PR #39 are both prerequisites for any Task 5c–8 artifact branch. Follow the user's review order: first review and normally integrate #37, preserving its artifact catalog test and dashboard timing/read acceptance; then refresh `dev`, reconcile PR #39 onto that resulting baseline without dropping its runtime commits, and review and normally integrate #39. If both branches changed this plan, preserve this latest PR #39 plan context and merge in only the factual #37 acceptance details; do not let an older plan copy overwrite the current status, hashes or constraints. These are review and integration steps, not merge authorization.

- [ ] Before artifact work, refresh both exact heads, bases, review decisions and producer checks. Confirm #37 is still `745ef645ae48730e769e6fc639ec4f71739d23e8` (or record its refreshed head) and #39 is still `b093b6503a39339399f57c2d59a3d5f5b417c18d` (or record its refreshed head); inspect the actual diffs and do not assume either is merge-ready from a green check alone.
- [ ] After each normal, user-approved integration, refresh `origin/dev`, record the resulting SHA and its producer CI separately, and check that the expected files are present. The final post-#39 `dev` tree must contain `test/meridian-artifacts.test.ts`, PR #37's dashboard timing/read acceptance, and PR #39's reviewed transfer runtime before any artifact branch is created.
- [ ] Verify the merged `dev` SHA and full required CI on that exact tree, including the artifact catalog test and transfer regressions; only then create isolated artifact branches from it. If either PR remains open or cannot be reconciled without losing reviewed work, stop the artifact sequence and preserve the blocker.

### Current repair and integration status

- Task 1 — complete: reviewed PR #34 repairs were integrated into `dev` at `4252cb7`; both the reviewed PR head and the resulting dev SHA passed their respective hosted CI checks above.
- Task 2 — complete: CLI journal/resource and terminal-outcome repairs landed through `9a3e24d` after the scoped review; the recorded focused, CI, typecheck, validate and diff-check gates passed.
- Task 3 — complete: click-budget and trusted-step-reporting repairs landed through `47537d2` after the final deadline review; the recorded focused, CI, typecheck, validate and diff-check gates passed.
- Task 4 — complete for the read baseline: the three approved artifact checks and fresh sign-on, member-inquiry and member-record reads passed their recorded evaluator checks; the separate unsubmitted-form inspection recorded native POST destinations, controls and hidden-token presence. Task 5 later observed and posted one chosen transfer; the other write review transitions and final posting facts remain open.
- Task 5 — partial: discovery `a06406ce-c425-4cfb-bb61-4e23b73f8845` succeeded at source `745ef645ae48730e769e6fc639ec4f71739d23e8`, with one human-approved posting, evaluator pass and independent resulting-state verification. Its genuine 22-step artifact remains `draft`: the runtime protections for its four Important findings are independently reviewed in PR #39, while artifact-specific closure still requires a new complete recording. No transfer replay occurred; fully accepted capability coverage remains `3/7`.
- Task 9a — complete for deterministic/offline acceptance at `541d776f85d94097bc1e63fa7966de69da5947de`: the reviewed dispatch, browser-closure, authority, identity, evidence and typed-output checks passed. This does not establish live target, posting, dashboard or hosted final-head acceptance.
- Task 9b — complete for the scoped documentation and sanitized metadata backup at `ca5d99a21e7274445eb119a71bc8c61f548fa9a7`; its source-specific local and hosted checks passed. This did not change runtime behavior or establish a live write.
- Task 9c — complete for the scoped real dashboard read, reload, evidence, role and keyboard checks. The accepted run `288d7cae-c486-4f08-b810-c1e4aa1d4afe` and independent post-restart projection preserve the `3/7` boundary, historical redaction and unknown state. The missing elapsed-time display was assigned to Task 9d.
- Task 9d — complete for the scoped shared elapsed-time renderer, focused browser assertion and current read documentation alignment at `745ef645ae48730e769e6fc639ec4f71739d23e8`. Independent review and hosted checks passed; this does not close the local transfer draft, write or whole-Task-9 gates.
- Task 5 runtime integration, new recording/promotion/replay, Tasks 6–8 and the remaining live portions of Task 9 remain pending: the successful first transfer does not establish a reusable verified write artifact, separate replay, the other write capabilities, operation-specific unhappy paths, integrated dashboard/chat rehearsal, same-browser repair, approval/handoff keyboard operation or final delivery.
- Controller ordering ruling: Task 9a, Task 9b, Task 9c and Task 9d may proceed while Tasks 5–8 await fresh live choices and approvals; a read or artifact promotion does not authorize a write, and the historical `222ebecd-ca02-4960-a875-c2f2f76e0927` operation remains `POST_OUTCOME_UNKNOWN`.

Read [PR #34](https://github.com/goodwiins/computer-use-automation-system/pull/34), [PR #35](https://github.com/goodwiins/computer-use-automation-system/pull/35), and their `docs/meridian/live-evidence.md`. Existing evidence reports:

- Sign-on, member inquiry, and member record have real discovery and deterministic replay evidence. Preserve that provenance. Refresh a read before each new live session.
- One genuine funds-transfer draft exists locally but is blocked on the four findings below; three other write artifacts remain incomplete. All four write replay gates remain open.
- Open-share discovery `222ebecd-ca02-4960-a875-c2f2f76e0927` is terminal `POST_OUTCOME_UNKNOWN`. A model completion message did not establish success; compilation failed after dispatch. Never repeat this request, delete its journal record, or reconstruct its missing provenance.
- Six injected-error probes are read-only probes; they do not prove complete write replay or successful recovery.
- Dashboard/chat previously invoked a read but ended in `SESSION_EXPIRED`; a later caller chat/API/runtime read at `541d776f85d94097bc1e63fa7966de69da5947de` (`ff5fda32-db07-443f-930d-db2d65461dc0`) returned `202` and success with evaluator pass, and an exact-key duplicate returned the same run ID. Task 9c separately recorded genuine dashboard UI read `288d7cae-c486-4f08-b810-c1e4aa1d4afe` at source `ca5d99a21e7274445eb119a71bc8c61f548fa9a7`, including reload, role, evidence and accepted Refresh/Send keyboard checks. The successful integrated write rehearsal and same-browser repair remain open.
- PR #35's evaluator checks local event ordering and journal consistency. It is not a business-result verifier, and older incomplete event logs must not be relabelled as passing.

## Task map and file ownership

This is a completion plan for one demo, with separately reviewable deliverables. Execute in dependency order: 5a → 5b → 5c → 5d → 6 → 7 → 8 → remaining 9. Each major deliverable must have a separate PR against `dev` after its prerequisites land; do not start parallel live browser runs. Tasks 1–3 below are retained historical instructions, already complete as recorded above; their old unchecked boxes are not a request to retarget or reimplement merged work.

| Task | Owned files / responsibility | Dependency |
| --- | --- | --- |
| 1 | Existing #34/#35 branches and their review fixes; integrate without duplicating their feature code | None |
| 2 | `cli.ts`, `src/runtime/journal.ts`, `test/meridian-cli.test.ts` — CLI journal lifetime and safe terminal failures | Current #34/#35 candidate; resolve during 1 |
| 3 | `src/surface/{types,browser,guarded}.ts`, `src/replay/executor.ts`, `src/server/service.ts`, `test/{meridian,guarded}.test.ts` — unresolved review checks | Current #34/#35 candidate; resolve during 1 |
| 4 | `test/meridian-artifacts.test.ts`, `docs/meridian/live-evidence.md` — artifact acceptance check and live readiness | 2, 3 |
| 5 | Shared transfer validation and its focused regressions; transfer draft, catalog test and evidence, as detailed in 5a–5d | 4; resumed in a separate runtime PR |
| 6 | Open-share artifact, its capability-specific contract/guard/completion checks and evidence | 5d; separate explicit new operation |
| 7 | Member-update artifact, its capability-specific contract/guard/completion checks and evidence | 6; apply the same bound-fact review gates |
| 8 | Account-hold artifact, its capability-specific contract/guard/completion checks and evidence | 7; supervisor operator |
| 9 | `test/meridian.test.ts`, `docs/meridian/{live-evidence,runbook,report,evaluation}.md`, sanitized evidence, `README.md`, `docs/README.md` — acceptance and delivery | 5–8 |

Profile and contract corrections reuse `config/app-profiles/meridian.json`, `src/runtime/contracts.ts` and the existing shared execution paths identified in Task 5, with focused regressions in existing tests. Only change observed rules; do not add another browser runner, API, UI framework, job queue, telemetry backend, or MERIDIAN clone. Permission to consider assistant-ui is not part of this transfer repair's scope.

### Required PR boundaries

These are planned deliverables, not existing GitHub PR numbers. Keep PR #37 scoped to its existing timing/read-acceptance changes.

| Separate PR | Plan tasks | Included work / completion gate |
| --- | --- | --- |
| Transfer runtime validation | 5a–5b | Observed field mapping, shared eligibility/review/output/header checks and focused regressions; independent review and passing local/hosted code checks |
| Funds-transfer artifact and acceptance | 5c–5d | Genuine recording/provenance, reviewed promotion, separately approved replay, catalog gate and sanitized evidence; requires the runtime PR in `dev` |
| Open-share capability | 6 | Its artifact, required scoped runtime fixes/tests, separate discovery/replay approvals and verified result evidence |
| Member-update capability | 7 | Its artifact, required scoped runtime fixes/tests and verified persistence evidence |
| Account-hold capability | 8 | Its artifact, required scoped runtime fixes/tests, teller-denial and supervisor-success evidence |
| Remaining integrated acceptance and delivery | Remaining 9 | Missing exception/integration regressions, rehearsal evidence and final runbook/report/setup updates; reuse accepted capability evidence |

Use a separate isolated `codex/` branch from updated `origin/dev` for each PR. Include only that deliverable's changes. Keep the current draft and pending transfer catalog-test entry in the artifact work, outside the runtime PR; preserve them without weakening the approved-status gate. The runtime PR must pass its own complete checks from its isolated checkout. A blocked artifact may stay in a draft PR with the failed/incomplete gate stated explicitly; it is not ready to merge.

Before each PR is ready for review, run its focused regressions, `npm run ci`, `npm run validate` and `git diff --check`; inspect hosted checks on that exact head. Describe the behavior, validation and unresolved limitations. Review and integrate in dependency order, verify the resulting `dev` SHA and CI separately, and do not bundle later tasks into an earlier PR. Creating a PR is not permission to merge or post a live transaction. The final acceptance PR contains only the remaining Task 9 changes, not copies of already delivered capability work.

## Task 1: Integrate the existing work through dev

**Files:** Existing PR files only, plus their review-driven tests. This task produces the common baseline, not a third implementation of the feature.

**Interfaces:** Consumes the two PRs above. Produces `origin/dev` containing shared `createRuntime`, `executeReplay`, `InvocationService`, `Journal`, `Approval`, `applyMeridianContract`, and `evaluateRun`.

- [ ] Refresh exact heads, bases, checks, review threads and branch state:

```sh
git fetch origin
git status --short
gh pr view 34 --json baseRefName,headRefName,headRefOid,isDraft,reviewDecision,statusCheckRollup
gh pr view 35 --json baseRefName,headRefName,headRefOid,isDraft,reviewDecision,statusCheckRollup
```

- [ ] Coordinate with owners of the existing worktrees. Retarget #34 to `dev`; review its new diff. Keep #35's current stack intact until #34 lands, then rebase its own commits onto updated `origin/dev` and retarget #35 to `dev`. Do not cherry-pick the whole stacked history twice. Use `git range-diff` against the saved old base/head to verify the rebase. Never force-push `dev` or production.

```sh
gh pr edit 34 --base dev
gh pr diff 34 --name-only
# After #34 is integrated and #35's own commits are rebased:
gh pr edit 35 --base dev
```

- [ ] Resolve still-valid findings using Tasks 2–3 as a checklist if their authors have not already done so. These tasks may be performed on the existing PR branches before integration; do not block fixes on a merge that itself requires those fixes. If already resolved, skip duplicate changes and cite the fixing SHA.
- [ ] Run each changed head's required gates in its own checkout:

```sh
npm ci
npm run ci
npm run validate
git diff --check
```

Expected: exit 0 for all commands. Existing counts (142 and 151 in PR reports) are historical, not required magic numbers. Inspect hosted checks on the final head after all pushes.
- [ ] Integrate only review-ready work through the normal PR workflow. After each merge, refresh `origin/dev` and record the merged SHA and its hosted checks in the acceptance notes. Start remaining task branches from that baseline. This plan does not itself merge anything.

## Task 2: Make CLI failures close journals and preserve terminal outcomes

**Files:** Modify `cli.ts`, `src/runtime/journal.ts`; create `test/meridian-cli.test.ts` only if these regressions remain uncovered after Task 1.

**Interfaces:** Reuse `Journal.lookup/reserve/update/close` and `RequestError`. Add `validateIdempotencyKey(key: string): void` in `src/runtime/journal.ts`, consumed both by `lookup` and by CLI discovery/replay before acquiring the journal lock. Reuse `runtime.surface.mutationDispatched` and the existing `ReplayResult` failure shape.

- [ ] Write and run the smallest failing validation check:

```ts
import { expect, it } from 'vitest';
import { validateIdempotencyKey } from '../src/runtime/journal.js';

it('rejects invalid request keys before acquiring a journal', () => {
  for (const key of ['', 'space key', '\n', 'x'.repeat(201)]) {
    expect(() => validateIdempotencyKey(key)).toThrow();
  }
  expect(() => validateIdempotencyKey('meridian-new-operation-1')).not.toThrow();
});
```

```sh
npx vitest run test/meridian-cli.test.ts
```

Expected on the inspected baseline: missing export failure. Do not add a second copy if the helper already exists in the integrated code.
- [ ] Extract the existing validation exactly; keep lookup validation for all API callers:

```ts
export function validateIdempotencyKey(key: string): void {
  if (!/^[\x21-\x7e]{1,200}$/.test(key)) {
    throw new RequestError(400, 'A valid Idempotency-Key is required');
  }
}
```

In both CLI paths, calculate `key`, validate it when `meridian` is true, and only then call `new Journal`. Enclose lookup, reservation, runtime creation, and execution in the journal's `try/finally`; the existing early duplicate return also passes through `finally`. Runtime creation failure must release the lock. Keep browser cleanup in its own `finally`.
- [ ] Add this CLI subprocess regression to the same test file. It must fail on the original lock-leaking paths and pass after cleanup. The explicit child environment cannot inherit real provider credentials.

```ts
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

it.each([
  ['discover', '--name', 'meridian-sign-on', '--goal', 'Sign on'],
  ['replay', '--artifact', 'artifacts/meridian-sign-on.v1.0.0.json'],
])('rejects an invalid key without retaining resources: %s', (...args) => {
  const dir = mkdtempSync(join(tmpdir(), 'meridian-cli-'));
  try {
    const result = spawnSync(process.execPath,
      ['--import', 'tsx', 'cli.ts', ...args, '--profile', 'meridian',
        '--idempotency-key', 'invalid key'], {
        encoding: 'utf8', timeout: 5000,
        env: {
          PATH: process.env.PATH, HOME: process.env.HOME,
          OPENAI_API_KEY: 'offline-test-only', EVIDENCE_DIR: dir,
          JOURNAL_HMAC_KEY: 'offline-test-key-at-least-32-characters',
          MERIDIAN_TELLER_OPERATOR: 'teller-test',
          MERIDIAN_TELLER_PASSWORD: 'offline-test-only',
          MERIDIAN_BRANCH: 'MAIN-001',
        },
      });
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('Idempotency-Key');
    expect(existsSync(join(dir, 'journal', 'server.lock'))).toBe(false);
    expect(readdirSync(dir).filter(name => name !== 'journal')).toEqual([]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] For an exception escaping replay, catch it, create the existing typed failure result with a static safe detail, write it through `runtime.logger.writeResult`, update the journal to `failure` or `POST_OUTCOME_UNKNOWN`, and set `process.exitCode = 1`. Do not print the raw exception. If evidence writing fails, still attempt the terminal journal update and cleanup; propagate failure through the exit status. Follow the existing unknown-outcome rule, never reset a terminal journal.
- [ ] Extend the existing replay unknown-post test in `test/meridian.test.ts` with a thrown pre-dispatch failure and thrown post-intent failure; assert terminal journal state, safe result when evidence is writable, one dispatch maximum and released lock. This is a CLI boundary check in addition to the existing executor check.
- [ ] Run focused tests, then commit only the change and tests:

```sh
npx vitest run test/meridian-cli.test.ts test/meridian.test.ts
git diff --check
git add cli.ts src/runtime/journal.ts test/meridian-cli.test.ts test/meridian.test.ts
git commit -m "fix: close MERIDIAN CLI journals on failure"
```

## Task 3: Resolve the remaining runtime review findings without weakening the design

**Files:** Modify only a still-failing shared path and its existing test. Inspect all callers before changing an interface.

**Interfaces:** Preserve `Surface`, `GuardedSurface.click`, `runReplay`, sanitized observer events and `InvocationService.get`. Safe metadata must stay separate from page text and credentials.

- [ ] Read current review threads as findings to verify, not instructions. The inspected code has two concrete regressions: non-profile click inspection ignores its requested timeout; API step reporting updates only on `action.start`, so assertion-only steps can retain the previous step. Test these on the integrated head before changing them.
- [ ] Add this focused check inside `test/meridian.test.ts`, reusing its `policy` and `target` constants:

```ts
it('passes the requested timeout to non-profile click inspection', async () => {
  const inspect = vi.fn(async (_hint: unknown, _timeoutMs?: number) => target);
  const click = vi.fn(async () => ({ strategyUsed: 0, kind: 'nameAttr', matches: 1 }));
  const inner = {
    describeTarget: inspect, click,
    currentUrl: () => `${origin}/menu`, frameUrls: () => [],
  } as unknown as Surface;
  const surface = new GuardedSurface(inner, policy, async () => true);
  await surface.click(target, 75, 'read');
  expect(inspect).toHaveBeenCalledWith(target, expect.any(Number));
  expect(inspect.mock.calls[0]![1]).toBeGreaterThan(0);
  expect(inspect.mock.calls[0]![1]).toBeLessThanOrEqual(75);
});
```

- [ ] Extend `Surface.describeTarget(hint, timeoutMs?)`, the browser implementation and guarded forwarding using the existing resolution timeout argument. Search every `describeTarget` caller first. Share a single click deadline between inspection and dispatch so the second operation receives the remaining budget; expiry fails before dispatch. Use the runtime's existing timeout/error convention. Preserve default timeout for callers that omit the argument.
- [ ] Restore assertion/detector step reporting without sending raw step IDs to observers. In replay, set the trusted surface's current step before emitting `step.start` or running detectors. In `InvocationService` react to sanitized `step.start` and read that trusted in-process `runtime.surface.currentStep`; keep `action.start` handling for action progress. Add a fixture with a named assert step and a fatal detector and check the API reports the correct step in both cases. Do not reintroduce raw observer fields.
- [ ] Verify redirect and final-route findings with an actual allowed POST→review→post→confirmation fixture and an unexpected same-origin redirect. Reject paths outside the profile after navigation. Do not blindly apply the explicit-navigation `/review` and `/post` ban to legitimate native form responses; that would break posting. If a new shared route check is required, distinguish requesting a URL directly from observing an allowed form transition, and test both. Keep native method/body/token enforcement in `BrowserSurface`.
- [ ] Resolve low-risk review items only when reproduced: remove ignored `selectBy` from `fill`; use module-relative static asset paths if serving outside the repo root is supported. Do not blindly delete finished in-memory results: authorized live results intentionally remain available until restart. Do not remove teller write invocation from the intended demo merely because approval is separate; configure an explicit capability allowlist and retain operator-only approval/supervisor checks.
- [ ] Run existing related checks and commit only actual repairs:

```sh
npx vitest run test/meridian.test.ts test/guarded.test.ts test/evidence-eval.test.ts
npm run typecheck
git diff --check
```

Expected: regressions now pass; existing approval, mutation-intent, observer isolation, masking and v1 replay tests remain green. Review fixes on their exact SHA before beginning live writes.

## Task 4: Establish artifact checks and live readiness

**Files:** Create `test/meridian-artifacts.test.ts`; update `docs/meridian/live-evidence.md` with current read-only readiness. Reuse the current runbook and runtime; no live-test server is added.

**Interfaces:** `CapabilityArtifact.parse(unknown)`, `applyMeridianContract(artifact)` and `meridianContracts` are existing exports. The test below is a contract gate, not proof of live behavior.

- [x] Add `test/meridian-artifacts.test.ts` with only the three already recorded IDs. Tasks 5–8 each add their ID before recording, making that task fail until its artifact exists and passes the shared contract.

```ts
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { CapabilityArtifact } from '../src/artifact/schema.js';
import { applyMeridianContract } from '../src/runtime/contracts.js';

const ids = [
  'meridian-sign-on',
  'meridian-member-inquiry',
  'meridian-member-record',
];
it.each(ids)('%s is reviewed and satisfies the recorded contract', id => {
  const artifact = CapabilityArtifact.parse(JSON.parse(
    readFileSync(`artifacts/${id}.v1.0.0.json`, 'utf8'),
  ));
  expect(artifact.id).toBe(id);
  expect(artifact.status).toBe('approved');
  expect(artifact.app.appId).toBe('meridian');
  expect(artifact.provenance.discoveryRunId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
  const checked = applyMeridianContract(artifact);
  expect(checked.schemaVersion).toBe(2);
  expect(checked.parameters.filter(p => p.source === 'server').map(p => p.name).sort())
    .toEqual(['branch', 'operator', 'password']);
  expect(artifact.steps.some(s => s.action === 'assert')).toBe(true);
});
```

- [x] Run `npx vitest run test/meridian-artifacts.test.ts`: 3 tests passed on `4252cb70396b3f30f5c126d2ed2e164054a2bcfe`. Existing approved artifacts satisfy the shared contract; no contract was loosened.
- [x] Follow the read-only portion of `docs/meridian/runbook.md` setup. The ignored `.env` is mode 600 with a stable journal key, and the existing CLI wrapper was used. Write-task member/share/contact choices were intentionally not established because this task authorizes no posting.

```sh
cu() { node --env-file=.env --import tsx cli.ts "$@"; }
```

Stop `cu serve` before any CLI discovery/replay. Use an interactive terminal for discovery's approval gate. Choose current synthetic member/share/contact inputs with the operator and set `MEMBER`, `SOURCE_SHARE`, `DESTINATION_SHARE`, `HOLD_SHARE`, `EMAIL`, `PHONE`, and `ADDRESS` locally. These are selected operation facts, not inferred defaults; values must be known before a write can be proposed for approval.
- [x] Run the supplied fresh sign-on preflight at source `7abda4c326260d917795fe75320af99a7233bc6d` (`ad12819b-f07a-41ff-9710-bedff1afe1a5`, `TELLER`, evaluator pass) without repeating it, then run fresh member inquiry `b60ef7b1-a76f-4321-b825-540f8c7ff7d6` and member record `e4850bd4-6c63-42c9-8719-aaefef1c74e4` reads at source `4252cb70396b3f30f5c126d2ed2e164054a2bcfe`. Both reads succeeded with evaluator pass, 10 attempts, 0 mutation intents, and no violations or incomplete checks.
- [x] Inspect the sanitized read transitions: sign-on operator/password/branch fields and POST, inquiry by/q fields and GET Search, and record GET Select plus shares-table extraction. No write form was submitted, and no review transition or posting control was clicked; write-route token/role checks and concrete eligible-share choices remain incomplete gates. The historical unknown operation stayed terminal `POST_OUTCOME_UNKNOWN` and was not retried.
- [x] Record the controller's separate manual read-only inspection of unsubmitted write forms: transfer, new-share, contact-update and hold native POST destinations, controls and hidden token presence are documented in [live evidence](../meridian/live-evidence.md). The teller hold page warning is not a demonstrated server or guarded denial.
- [ ] Finish each chosen write's review transition and final posting inspection with fresh facts and its separate approval. The original controller inspection was unsubmitted; Task 5 subsequently established one approved transfer posting. That later result does not close the other three write inspections or the transfer's promotion findings.
- [x] Commit the artifact check and sanitized readiness note after the final integrated gates. Existing contract tests establish the baseline; do not manufacture a failing test when the behavior already exists.

## Live-operation rules for Tasks 5–8

For every task, discovery and replay are **two separately requested operations**, each with new live facts and separate approval. Choose fresh keys only for genuinely new operations; retries of one invocation reuse its key. Save each key locally before dispatch. Never auto-repeat any run after dispatch intent or `POST_OUTCOME_UNKNOWN`.

After recording, inspect the complete draft: explicit operator/password/branch references, stable select values, meaningful assertions, extract-backed outputs, effective irreversible post risk and sensitive metadata. Confirm its real discovery run ID. Promote with `cu replay --artifact <the recorded artifact path> --approve` only after that review. Promotion returns without submitting a transaction.

Apply Task 5's semantic review to every remaining write: bind the selected member and eligible resource to exact current rows, compare the actual reviewed/filled facts with the bound request, verify operation-specific output values, and exclude headers according to the observed table structure. A page heading, any visible `OPEN`, a nonempty output or a safety-evaluator pass alone closes none of these gates. Keep assertions/locators supported by the runtime; parameter values must not be interpolated into CSS.

Preserve the original recording and run history. Runtime validation added after discovery is new runtime behavior, not a recorded checkpoint from the older run. A changed recorded step sequence requires a new complete discovery with its own provenance. If that requires posting, the operator must choose and separately approve a genuinely new operation; never repeat a completed or unknown operation to repair its artifact.

The commands below assume Task 4's wrapper and selected variables. A declaration such as `TRANSFER_DISCOVERY_KEY` means a locally saved request identity, not a secret and not permission to retry by changing it. Do not paste real credentials or raw member data into GitHub.

For each terminal run, use the existing evaluator with the existing private `EVIDENCE_DIR` and journal key loaded from `.env`:

```sh
node --env-file=.env --import tsx scripts/evaluate-run.ts "$EVIDENCE_DIR" "$RUN_ID"
```

Set `RUN_ID` from that command's actual output and `EVIDENCE_DIR` to the configured run root, not its `journal` subdirectory. Success requires safety pass **and** the expected business result. Preserve a failing or unknown result faithfully. Copy only inspected sanitized evidence into `docs/meridian/evidence/`; never copy the private journal, `.env`, cookies or full raw output.

### Capability-specific validation for Tasks 6–8

The transfer comparators are deliberately request-bound and are not a generic completion framework. Before recording any remaining write, inspect retained/read-only evidence and the actual target's form, review and completion/result state. Record the facts and available result fields that are genuinely observed; do not invent selectors, outputs or a result relationship. Implement the smallest comparator and guard changes in that capability's own PR, reusing `DiscoveryDeps.validateCompletion`, the existing replay final-output validation path and `GuardedSurface` request/review checks. Run the same comparator on actual accumulated outputs before `discovery.finish('success')` and before `replay.success`; a generic nonempty output or success text is insufficient. Add one passing fixture and the listed negative regression in both discovery and replay paths before that capability's live recording/replay.

- **Open share:** Bind the exact member route/review facts, selected `shareType` value and positive `deposit`. Before success, require the extracted `shareId` to be nonempty and to match a newly observed share for that member with the requested type and deposit, where the target exposes those facts. A wrong or stale member/share/type/deposit in the review must stop before approval and dispatch; a preexisting, other-member or otherwise stale `shareId` must fail completion, emit no success, and after dispatch intent remain `POST_OUTCOME_UNKNOWN` with one dispatch and no retry or repair. If the target does not expose enough resulting state to bind the ID, stop and document the limitation.
- **Member update:** Bind the exact member and each filled email, phone and address in the live form and dashboard review. Before success, require `saved` to be backed by a fresh read of that same member showing the requested fields; a generic “saved” message is not evidence. A wrong/stale member or changed contact fact must invalidate approval before dispatch; a stale result or old/other-member contact state must fail completion with no success and, after dispatch intent, `POST_OUTCOME_UNKNOWN`, one dispatch and no retry or repair.
- **Account hold:** Bind the exact member, share, reason, notes and authenticated supervisor role in the review and native form. Before success, require `heldShare` to be backed by a fresh read showing HOLD on that requested share (and any observed confirmation or reason relationship). A wrong/stale member/share or teller context must stop before approval and dispatch; a stale/other-share hold result must fail completion with no success and, after dispatch intent, `POST_OUTCOME_UNKNOWN`, one dispatch and no retry or repair. Preserve a teller denial as its own pre-intent permission outcome.

Each capability PR must keep these checks capability-specific and request-bound; do not add a generic validator or defer the implementation until after a live artifact exists. If a result cannot be bound from observed target facts, leave the artifact gate incomplete rather than promise discovery or replay success.

Before recording open share or account hold, make an explicit observed decision about a separate completion confirmation. Inspect retained/read-only evidence and the actual target result when it is available; record `present` with its observed relationship, or record `absent` with the evidence and limitation. If present, coordinate the minimal changes in that capability PR to `meridianContracts`/`applyMeridianContract`, the artifact output declaration and extract, the request-bound completion comparator, discovery/replay wiring and the catalog test; `applyMeridianContract` currently requires the exact declared outputs and rejects extras. If absent, document that fact and keep the current public outputs `shareId` or `heldShare`. Do not change the contract now from the specification alone, invent a selector, or post solely to inspect a result.

## Task 5: Clear the four transfer findings before promotion and replay

**Existing deliverable:** A genuine 22-step draft from discovery `a06406ce-c425-4cfb-bb61-4e23b73f8845` at source `745ef645ae48730e769e6fc639ec4f71739d23e8`. Frozen draft SHA256: `65a54c76307356d1bedaf0ab228c0ace8eae4000d09b28c6b102d70741e026e4`. Independent review found four Important issues and no Critical issue. Schema, server references, sensitive metadata, irreversible post classification and supplied run/hash alignment passed that review; they do not clear the four semantic findings.

**Interfaces:** Preserve public inputs `{member, sourceShare, destinationShare, amount, memo}` and outputs `confirmation` plus typed `transaction` rows. Reuse `moneyCents`, `Surface.readTable`, `LiveControl.facts`, `GuardedSurface.click`, `createRuntime`, `runReplay`, discovery's extract-backed outputs and `applyMeridianContract`. Current `Assertion` supports only `urlMatches` and `textVisible`; do not write a plan or artifact as if a structured row assertion already exists.

### Completed evidence — retain without repeating the operation

- [x] Funds-transfer ID added to the local artifact catalog test. Its approved-status gate remains deliberately RED while this artifact is `draft`; do not weaken it or claim final CI passes with the local draft.
- [x] One separately approved discovery posting completed successfully: evaluator pass, 18 attempts, one mutation intent, zero risk disagreements, no violations or incomplete checks. Independent private before/after reads established that the selected source/destination effects matched the approved amount. These reads verify that operation, not reusable artifact semantics.
- [x] Preserve the earlier terminal, unposted attempts `26d911f0-cfd6-41db-959d-5b05c1aabcea` and `19603104-aac5-4e87-8cc5-1c6470fde11d`, each with zero mutation intents. Preserve the successful run and its original draft; do not backfill checkpoints into any run. No promotion or replay is complete.

### Four mandatory acceptance gates

| Finding / draft steps | Required behavior | Smallest meaningful negative check |
| --- | --- | --- |
| 1. Unbound member/share eligibility (`s9`–`s11`, after generic Select) | Exact selected member route; exactly one row for each requested share; distinct IDs; each selected row `OPEN`; valid source funds covering the requested amount using integer cents | Wrong member, duplicate/missing row, source equals destination, selected closed row with an unrelated `OPEN` row, malformed/insufficient balance: no posting approval or mutation intent |
| 2. Heading-only review (`s18`, before `s19`) | Native request facts and visible review facts each match member, source, destination, amount and memo; missing/duplicate/conflicting facts fail closed; approval remains a separate decision and facts are rechecked immediately before dispatch | Change each fact independently, including after approval: no dispatch; an unchanged confirmation heading must not make the test pass |
| 3. Unbound completion/output values (`s20`–`s22`) | Extracted confirmation and transaction details belong to this operation and match all five inputs; outputs are produced by observed extraction and verified before success | Empty confirmation, missing/duplicate detail, stale/unrelated details, wrong member/share/amount/memo or model-only `done.outputs`: no success; after intent, preserve `POST_OUTCOME_UNKNOWN`, never retry |
| 4. Possible legacy `td` header in data (`s22`) | Verify the exact table's shape; return only data rows while retaining the first real row of a headerless table | A `td` header cannot satisfy `minRows` or appear as a transaction; headerless first data row cannot be silently discarded |

### Task 5a: Establish the observed field and table mapping

**Files:** Frozen artifact and private discovery evidence, `src/surface/browser.ts`, `src/runtime/profile.ts`, approved member-record extraction and the sanitized mapping in `docs/meridian/live-evidence.md`.

- [x] Verified the frozen hash and source; preserved the dirty acceptance artifact, test and evidence edits in their original worktree. Refreshed PR #37 and `dev` before creating the separate runtime branch. Refresh them again before artifact integration; do not overwrite concurrent work.
- [x] Mapped the observed member route, share ID/status/balance columns, native inputs, visible review labels/formats and confirmation label/value adjacency. Runtime uses invariant structural selectors and exact TypeScript comparisons; parameter-dependent CSS remains rejected.
- [x] Recorded the evidence boundary: transaction result labels, order, header shape and confirmation/detail relationship are unverified. General `td`-header guidance does not prove that table's shape. Task 5c must establish this mapping through genuine observations; never post merely to inspect a table.
- [x] Used the verified member/input/review map for runtime comparisons and defined the typed output contract below without guessing physical result selectors. Task 5c requires a new complete recording; submitted parameters cannot stand in for extracted outputs.

### Transfer result extraction feasibility gate

Before another transfer posting is requested, inspect the frozen draft, retained/read-only evidence and any available unsubmitted or previously captured result structure. `Surface.readTable` extracts each declared column from descendants of each selected row; it does not join labels or values across rows. The six canonical transaction columns therefore require an actually observed single-row shape (or an explicitly reviewed extractor/contract change supported by observed evidence), including confirmation relationship and header handling.

- [ ] Record whether retained/read-only observations establish that one supported `readTable` target can produce exactly one row with `member`, `sourceShare`, `destinationShare`, `amount`, `memo` and `confirmation`. Do not guess selectors or infer the layout from the contract.
- [ ] If the physical result is unsupported or the feasibility evidence is absent, stop the artifact sequence before posting and make only a reviewed minimal contract/extractor adjustment from actual evidence, with its focused regression; otherwise leave the artifact blocked. Never ask an operator to post solely to inspect the result, backfill a selector or provenance, or promise that a selected operation will produce a valid artifact. If the operator separately chooses and approves a write while this gate is unresolved, label that limitation up front and treat any resulting observation as unaccepted until the gate is reviewed.

### Task 5b: Enforce the semantics in the shared runtime, offline first

**Implementation checkpoint:** [PR #39](https://github.com/goodwiins/computer-use-automation-system/pull/39) delivers the separate runtime change against `dev`. Source `082e4c74a299b3fb6b1237a2d2c7846c2f60a663` passed independent review with no remaining findings, 248 tests across 14 files, typecheck, artifact validation and diff checks. The PR records exact-head hosted CI. Review-driven fixes bind frame/navigation state, reject ambiguous or invisible review facts, preserve Continue and child-frame submission, and retain correct action-event identity. This completes the offline runtime work, not live result-layout verification or approval of the original draft.

**Regression evidence:** The initial comparison regressions and later navigation, rendering and action-lifecycle repairs captured failing checks before their fixes. The first review-fix round did not capture a RED run; that limitation is retained rather than reconstructed. The final hidden-descendant regression failed before the fix and passed afterward.

**Files:** Minimal changes within `src/runtime/contracts.ts`, `src/runtime/run.ts`, `src/surface/{browser,guarded}.ts`, `src/replay/executor.ts`, `src/agent/loop.ts` and its `cli.ts` call site. Use `test/meridian.test.ts` and, only for discovery/CLI completion wiring, `test/meridian-cli.test.ts`. Change `src/surface/types.ts` or `src/runtime/profile.ts` only for the concrete observed data passed across that existing boundary. No new runner, assertion language, dependency or generic validation framework.

**Runtime additions:** Small pure comparisons in `src/runtime/contracts.ts`, with names/signatures below defined by this task. Map observed data into these inputs; never manufacture `actual` from `expected`:

```ts
import type { OutputValue } from '../artifact/schema.js';

type TransferFacts = {
  member: string; sourceShare: string; destinationShare: string;
  amount: string; memo: string;
};
type TransferShare = { share: string; status: string; balance: string };
function assertTransferEligibility(
  expected: TransferFacts, actualMember: string, shares: TransferShare[],
): void;
function assertTransferFacts(expected: TransferFacts, actual: TransferFacts): void;
function assertTransferOutputs(
  expected: TransferFacts, outputs: Record<string, OutputValue>,
): void;
```

Export these comparison functions for the existing execution paths and tests. The first requires the exact member, distinct share IDs, one matching row per ID, both statuses `OPEN`, a positive amount and sufficient source funds via `moneyCents`. The second requires exact member/share/memo equality and equal validated positive monetary values in integer cents. The output comparator requires a nonempty extracted confirmation and exactly one typed `transaction` row with `member`, `sourceShare`, `destinationShare`, `amount`, `memo` and `confirmation` columns. Amount is a money column; the others are strings, with all columns sensitive. Compare the five facts using `assertTransferFacts` and require the row confirmation to equal the separately extracted confirmation. Reject missing/extra rows or columns. These are declared output names, not guessed target labels. `applyMeridianContract` must reject the old generic `{field,value}` declaration before promotion or execution; the genuine old draft therefore requires a new complete recording. Reject missing or duplicate observed fields before constructing `TransferFacts`; never coerce a blank value to zero or normalize unrelated strings until they match.

- [x] Added behavioral regressions, with RED evidence and its one recorded limitation above. Use synthetic values in existing fixtures; include a control that passes and table-driven mutations for every gate above. The minimum pure comparison check is:

```ts
const request = {
  member: '9001', sourceShare: '9001-A', destinationShare: '9001-B',
  amount: '1.00', memo: 'fixture',
};
const rows = [
  { share: '9001-A', status: 'OPEN', balance: '2.00' },
  { share: '9001-B', status: 'OPEN', balance: '0.00' },
];
expect(() => assertTransferEligibility(request, '9001', rows)).not.toThrow();
expect(() => assertTransferEligibility(request, '9001', [
  { ...rows[0]!, status: 'CLOSED' }, rows[1]!,
])).toThrow();
expect(() => assertTransferEligibility({ ...request, destinationShare: request.sourceShare }, '9001', rows)).toThrow();
expect(() => assertTransferFacts(request, { ...request, amount: '2.00' })).toThrow();
```

- [x] Wire the bound invocation parameters from `createRuntime` into the shared guarded path for discovery and replay. After the member-selection action (`s8` in the frozen draft), before leaving `/members/{{member}}`, reuse the observed member-record table target/columns through `Surface.readTable`, mapping `shareId` to the comparison's `share` field. Reject a wrong member or ambiguous row. Require this run's eligibility snapshot before entering transfer and before posting; preserve it only through that member's expected transfer/review transitions, and clear it on unrelated navigation, member change or terminal outcome. Skipping the member page or reusing another run's snapshot cannot bypass it. Keep private facts in memory. This is a current pre-transfer observation, not a promise of atomic balance reservation; the native target remains responsible for concurrent balance changes.
- [x] In `GuardedSurface.click`, compare the observed native and visible review facts to the bound request before presenting approval, and repeat on the freshly inspected control before `beforeDispatch`. Parse the verified display formatting first: member ID with display name, share ID with parenthesized currency balance, currency-prefixed amount and exact memo. Require exact ID boundaries and valid monetary suffixes; a prefix match or arbitrary substring is insufficient. Reuse existing token, role, deadline, approval invalidation and native-body checks. Scope visible labels to the actual review table, rejecting duplicate/conflicting labels instead of silently overwriting them in `inspectControl`.
- [x] Call `assertTransferOutputs` before `runReplay` emits success. Add the narrow optional `DiscoveryDeps.validateCompletion?: (outputs: Record<string, OutputValue>) => void` callback in `src/agent/loop.ts`, supplied for funds transfer by `cli.ts`; call it on actual accumulated extracts before `finish('success')`. A check only after `runDiscovery` returns is too late to prevent a false `discovery.finish` success event. Keep `done.outputs` ignored and `recordArtifact` provenance trace-only. Missing/mismatched details after intent must take the existing terminal unknown path with no retry, skip, repair or second post; the negative regression must also assert no success event.
- [x] Keep generic `readTable` behavior unchanged. The stricter transfer contract rejects legacy field/value output, header/extra rows and invalid money, preventing a header from counting as a transaction. A new recording must supply observed invariant row/column selectors for its single typed transaction row and prove that the selected values are data. Preserve a headerless table's first real data; do not globally drop the first row or guess the old result table's header status. Column selectors execute as native CSS; record structural selectors supported by `querySelectorAll`, not Playwright-only text pseudo-selectors. The result layout remains a live artifact-review gate.
- [x] Exercise the shared path with existing local browser fixtures: an unrelated `OPEN` row cannot rescue an ineligible selection; each review mismatch prevents the human gate/dispatch; a change after approval prevents dispatch; a bad result after one intent terminates unknown with exactly one dispatch. Run both discovery and replay completion wiring checks. Fixtures establish regression behavior only and are never live discovery evidence.

```sh
npx vitest run test/meridian.test.ts test/meridian-cli.test.ts
npm run typecheck
git diff --check
```

Expected: focused behavioral checks pass after the fixes. The catalog test still rejects the unapproved transfer draft. Do not replace these regressions with assertion counts or checks of contract literals written by the same constructor. Independent review covered all four runtime findings and the shared call paths; all reported findings are closed. Live artifact review remains separate.

- [x] Delivered Tasks 5a–5b in the separate transfer-runtime PR #39 against `dev`, with the code, regression and independent review gates above. Confirm its final hosted checks before integration. Keep the pending artifact/catalog changes in their own worktree. Begin Task 5c on the resulting reviewed `dev` baseline after integration; no live posting is authorized by the runtime merge.

### Task 5c: Resolve provenance, review the exact candidate, then promote

**Files:** `artifacts/meridian-funds-transfer.v1.0.0.json`, `test/meridian-artifacts.test.ts`, `docs/meridian/live-evidence.md`, `docs/meridian/evidence/funds-transfer/`. Preserve the frozen original privately and maintain the same named public contract.

- [ ] Pass the transfer result extraction feasibility gate above using retained/read-only observations before requesting another posting. If it cannot be established before the selected operation, record the limitation and keep the artifact unpromised and blocked unless the operator separately chooses and approves that write with the limitation understood.
- [ ] Require a new complete recording after runtime hardening because the typed transaction contract changes extraction semantics; do not reuse or promote the frozen field/value draft. This remains gated on an explicitly requested new operation, not automatic execution. Preserve the old successful discovery and label all new checks with their new source SHA; the old run did not execute them.
- [ ] If required recorded steps/targets/row selectors change, or genuine observations are missing, require a new complete discovery. Preserve `a06406ce-c425-4cfb-bb61-4e23b73f8845` as the successful original; the replacement has its own run ID and source SHA. No manual JSON insertion or human-repair capture may masquerade as original discovery provenance.
- [ ] Prepare any necessary replacement discovery only after the operator chooses a genuinely new operation and requests it. Use selected inputs rather than fixed amount/memo defaults, a separately saved discovery key, explicit `{{operator}}`, `{{password}}`, `{{branch}}` references, all four verified semantic gates and a separate human approval at the actual posting gate. If another posting is not wanted, leave the artifact blocked. Never reuse the previous consent or request key as permission for a new operation.
- [ ] Freeze the final candidate hash and reviewed runtime SHA. Fresh review must close each numbered finding, verify the actual table structure, compare artifact steps to genuine provenance, confirm sensitive metadata and irreversible risk, and inspect the minimal regressions. Retain evaluator results and independent before/after business verification separately. No Critical or Important finding may remain at promotion.
- [ ] Only after that review, promote and run the existing catalog gate:

```sh
cu replay --artifact artifacts/meridian-funds-transfer.v1.0.0.json --approve
npx vitest run test/meridian-artifacts.test.ts -t meridian-funds-transfer
```

Expected: promotion changes artifact approval status without posting; the unchanged approved-status gate now passes. Promotion remains distinct from approval to execute a transaction.

### Task 5d: Separately approved replay and transfer acceptance

- [ ] Stop CLI discovery before starting the existing server. Through real caller chat→API→operator dashboard, request an explicitly selected new transfer with current member/share/balance facts and its saved replay key. Require a separate human decision on the exact review facts, then verify that run's output correspondence and fresh resulting-state deltas. Do not reuse the discovery's balance change as replay evidence.
- [ ] Repeat only the same API invocation/key to confirm the original replay run ID returns without another browser or mutation. Preserve any unknown outcome and investigate with a read; changing the key is a new operation, not a repair.
- [ ] Evaluate the actual replay and whichever discovery produced the accepted artifact. Update the sanitized ledger with source SHA, artifact version/hash, original/superseding discovery distinction, replay ID, separate approvals, all four findings' closure evidence and resulting-state verification. Omit concrete member/share/contact/amount/balance/token/session values from tracked documentation.
- [ ] Only then count funds transfer as accepted (`4/7` if the three reads remain valid). Deliver Tasks 5c–5d through the separate funds-transfer artifact/acceptance PR against `dev`, with its catalog, local and exact-head hosted checks. Tasks 6–8 each get their own PR in order; preserve their independent approvals and capability-specific result checks.

## Task 6: Record a new open-share operation

**Files:** Create `artifacts/meridian-open-share.v1.0.0.json`; modify the artifact test and live evidence; save sanitized evidence under `docs/meridian/evidence/open-share/`.

**Interfaces:** Inputs `{member, shareType, deposit}`; output `shareId`. This is a new explicitly chosen operation, never a retry of `222ebecd-ca02-4960-a875-c2f2f76e0927`.

- [ ] Add `'meridian-open-share'` to the test's `ids`; run `npx vitest run test/meridian-artifacts.test.ts -t meridian-open-share`. Expected: missing-artifact failure.
- [ ] Before live discovery, complete the open-share validation in this PR from observed target facts: guard the exact member, `shareType` and deposit before approval, and bind the extracted `shareId` to a newly observed row for that member with the requested type and deposit before discovery or replay can report success. Add one passing fixture plus wrong/stale member, share ID, type and deposit mutations through both existing completion paths; pre-intent mutations dispatch zero times, and post-intent result failures produce one dispatch and `POST_OUTCOME_UNKNOWN` with no retry or repair.
- [ ] Operator chooses the new operation, confirms current member/share state, share type `S0001` and deposit `5.00`, and saves its request key. If a second new share is not wanted, do not use replay merely to satisfy a checkbox; leave the live gate incomplete.
- [ ] Discover with all three explicit server login references:

```sh
cu discover --profile meridian --name meridian-open-share \
  --goal 'Record explicit operator/password/branch references before sign-on. Open shareType for member with deposit, inspect review, request posting approval, assert completion and extract the newly created shareId. Never infer completion from reaching review.' \
  --param member="$MEMBER" --param shareType=S0001 --param deposit=5.00 \
  --sensitive member --sensitive deposit --idempotency-key "$SHARE_DISCOVERY_KEY"
```

- [ ] Approve current facts interactively; verify the resulting share ID against a fresh member record. A model message is insufficient. On any post-intent ambiguity, preserve unknown and stop.
- [ ] Record the observed separate confirmation decision before this recording. If the target supplies one, use the coordinated contract/output/comparator/catalog changes above; if it does not, document the absence and retain the `shareId` contract.
- [ ] Review and promote, then run the targeted contract check:

```sh
cu replay --artifact artifacts/meridian-open-share.v1.0.0.json --approve
npx vitest run test/meridian-artifacts.test.ts -t meridian-open-share
```

- [ ] Through the dashboard/API, request a separately chosen new-share replay with `SHARE_REPLAY_KEY`, approve it and verify that run's new share ID. Evaluate and record discovery and replay separately. Commit as `feat: record verified MERIDIAN share opening`.

## Task 7: Record contact update with direct-save review

**Files:** Create `artifacts/meridian-update-member.v1.0.0.json`; modify the artifact test and live evidence; save sanitized evidence under `docs/meridian/evidence/update-member/`.

**Interfaces:** Inputs `{member, email, phone, address}`; output `saved`. The native form posts directly to `/members/:id/update`; the dashboard supplies the review of live filled facts before Save Changes.

- [ ] Add `'meridian-update-member'` to the test's `ids`; run `npx vitest run test/meridian-artifacts.test.ts -t meridian-update-member`. Expected: missing-artifact failure.
- [ ] Before live discovery, complete the member-update validation in this PR from observed target facts: guard the exact member and all filled contact fields in the live form and dashboard review, and require a fresh read of that member with the requested values before either discovery or replay can report `saved`. Add one passing fixture plus wrong/stale member, changed contact fields and stale/other-member result mutations through both existing completion paths; pre-intent mutations dispatch zero times, and post-intent result failures produce one dispatch and `POST_OUTCOME_UNKNOWN` with no retry or repair.
- [ ] Choose synthetic contact values and a member explicitly. Before dispatch, verify the approval view contains the actual email, phone and address from the filled form. Test abort first on a separate undispatched run: no Save POST may occur.
- [ ] Discover the explicitly requested update:

```sh
cu discover --profile meridian --name meridian-update-member \
  --goal 'Record explicit operator/password/branch references and sign on. Open the exact member, fill email/phone/address, request approval before Save Changes, then assert the saved result and extract saved from verified updated information.' \
  --param member="$MEMBER" --param email="$EMAIL" --param phone="$PHONE" --param address="$ADDRESS" \
  --sensitive member --sensitive email --sensitive phone --sensitive address \
  --idempotency-key "$UPDATE_DISCOVERY_KEY"
```

- [ ] Approve the exact filled facts and verify persistence with a fresh read. Review/promote and check:

```sh
cu replay --artifact artifacts/meridian-update-member.v1.0.0.json --approve
npx vitest run test/meridian-artifacts.test.ts -t meridian-update-member
```

- [ ] Request a separately approved replay with operator-chosen contact values and `UPDATE_REPLAY_KEY` through dashboard/API. Verify persisted fields. Scan artifacts, screenshots, DOM and logs for these dynamic values before copying sanitized evidence. Evaluate both runs. Commit as `feat: record verified MERIDIAN member updates`.

## Task 8: Record supervisor hold and teller denial

**Files:** Create `artifacts/meridian-place-hold.v1.0.0.json`; modify the artifact test and live evidence; save sanitized evidence under `docs/meridian/evidence/place-hold/`.

**Interfaces:** Inputs `{member, share, reason, notes}`; output `heldShare`. Invocation requires the authenticated operator principal selecting supervisor context. Caller/chat cannot obtain that context.

- [ ] Add `'meridian-place-hold'` to the test's `ids`; run `npx vitest run test/meridian-artifacts.test.ts -t meridian-place-hold`. Expected: missing-artifact failure.
- [ ] Before live discovery, complete the account-hold validation in this PR from observed target facts: guard the exact member, share, reason, notes and supervisor role, and bind `heldShare` to a fresh read showing HOLD on that requested share before either discovery or replay can report success. Add one passing fixture plus wrong/stale member, share, role and result mutations through both existing completion paths; pre-intent mutations dispatch zero times, and post-intent result failures produce one dispatch and `POST_OUTCOME_UNKNOWN` with no retry or repair.
- [ ] Select an eligible current synthetic share for this new hold. Verify role before writing. Retain a natural teller-denial example without elevating that run or replaying its failed mutation.
- [ ] Discover the explicitly requested supervisor operation:

```sh
cu discover --profile meridian --operator SUPERVISOR --name meridian-place-hold \
  --goal 'Record explicit supervisor operator/password/branch references and sign on. Place a hold on the exact share for member with reason/notes. Inspect review, request Apply Hold approval, assert completion and extract heldShare from verified resulting state.' \
  --param member="$MEMBER" --param share="$HOLD_SHARE" --param reason=FRAUD --param notes=Demo \
  --sensitive member --sensitive share --sensitive notes --idempotency-key "$HOLD_DISCOVERY_KEY"
```

- [ ] Record the observed separate confirmation decision before this recording. If the target supplies one, use the coordinated contract/output/comparator/catalog changes above; if it does not, document the absence and retain the `heldShare` contract. Approve only after role and share facts match. Verify HOLD on that share through a fresh read. Review/promote and check:

```sh
cu replay --artifact artifacts/meridian-place-hold.v1.0.0.json --approve
npx vitest run test/meridian-artifacts.test.ts -t meridian-place-hold
```

- [ ] Operator chooses a separate eligible share for replay with `HOLD_REPLAY_KEY`; invoke through the operator dashboard with supervisor context, approve and verify the new hold. Caller attempts to select supervisor or approve must return 403. Do not silently hold a second arbitrary share to complete testing.
- [ ] Evaluate both runs, retain the distinct teller denial and supervisor success evidence, and commit as `feat: record verified MERIDIAN account holds`.

## Task 9: Finish unhappy paths, integrated rehearsal and delivery

**Files:** Extend existing `test/meridian.test.ts` only for missing deterministic checks; update `docs/meridian/{live-evidence,runbook,report,evaluation}.md`, inspected sanitized evidence and the final setup/demo links in `README.md` and `docs/README.md`. Task 9d's shared renderer repair in `src/server/public/app.js` is complete; do not repeat it or expand this work into a frontend rewrite.

**Interfaces:** Existing HTTP endpoints and auth remain unchanged. `GET /runs/:id` exposes lifecycle/result; operator `/decision` resolves one intervention. `npm run eval` consumes local evidence and authenticated journal records without mutating them.

- [x] Run existing offline coverage first for Task 9a:

```sh
npx vitest run test/meridian.test.ts test/evidence-eval.test.ts test/meridian-artifacts.test.ts test/screenshot-mask.test.ts
```

This passed with 4 files and 66 tests at `541d776f85d94097bc1e63fa7966de69da5947de`; the earlier 198-test run at `4ec9b93` is historical and not a current-head full-suite claim.

- [x] Task 9a's original deterministic matrix is covered by focused local regressions at `541d776f85d94097bc1e63fa7966de69da5947de`; its scope remains offline and does not satisfy the newly added transfer semantic row or live operation rows below. Do not duplicate passing coverage. The assertion is the required observable result, not a test-name substring.

- [x] Task 9b's scoped evidence ledger and sanitized read summary retain the source-specific `3/7` boundary, current caller API-only distinction, evaluator results and historical unknown state.

- [x] Task 9c's real dashboard read and independent restart check recorded login, reload, caller/operator visibility, evidence view, accepted Refresh/Send keyboard effects, historical redaction, unchanged 26-run count and unchanged unknown envelope. The initial focus-derived flag remains insufficient on its own.

- [x] Task 9d repairs the shared run-card elapsed display and adds a focused browser assertion for known elapsed time, true zero and missing historical timing. Independent review and hosted checks passed at `745ef645ae48730e769e6fc639ec4f71739d23e8`. The local fixture is a display check, not another live rehearsal or validation of the uncommitted transfer draft.

| Boundary | Required observable check |
| --- | --- |
| Wrong/reused/expired approval; accepted abort; browser closure | Zero dispatch for that rejected intervention; 403/409 as appropriate |
| Changed facts, role, destination, token, outgoing form body | Approval invalidation or fail-closed request interception; no unchecked post |
| Same-key retry before/after restart | Same run ID; changed payload/context 409; no new browser dispatch |
| Crash before reservation / after reservation / after dispatch intent | No operation / interrupted / unknown respectively; no automatic resume |
| Human retry and detector recovery after intent | No second mutation; terminal `POST_OUTCOME_UNKNOWN` |
| Model asks to approve/select supervisor/read operator run | Rejected through caller-bound service; operator secrets absent from tool context |
| Dynamic PII, short secrets, unknown pages, logger observer failure | Sanitized evidence or metadata-only warning; observer cannot affect dispatch |
| Tables, money, select values, unsupported outputs | Typed decimal-string rows; stable IDs; model-only outputs refused |
| Exact transfer eligibility, review facts, completion details, table headers — runtime reviewed; artifact pending | Task 5a–5c regression and review gates pass; no wrong member/share/amount/memo accepted; no header returned as transaction data |
| Hostile message/HTML, unauthorized evidence path | Inert UI text; denied evidence access; no credential in URL/storage |

- [ ] Exercise each applicable per-request scenario on the actual operation route with a new request and operator-selected inputs. Use `--inject <kind> --fault-route <observed operation-entry GET path>` only when that exact path and injection behavior are observed; the fault hook is for that exact operation-entry navigation only and excludes `/review`, `/post` and every POST request. Otherwise record the native method and form action and exercise the target response without forcing a route. Do not loop live mutation commands blindly. For every run, record the observed method/path, whether the condition occurred before or after the durable journal transition to `dispatching`, the terminal run and journal states, and the exact dispatch count. Use offline fixtures for after-intent simulated errors; do not claim that the live route-injection hook covers a post-intent response.

For the status column, record discovery and replay separately (`D` and `R` below): a pre-intent discovery stop or escalation is `D: stopped` or `escalated` with journal `failure`; a pre-intent replay business detector is `R: business_outcome` with journal `business_outcome`; a pre-intent replay fatal or policy/validation failure is `R: failure(<code>)` with journal `failure`; and post-intent discovery is `D: stopped(POST_OUTCOME_UNKNOWN)` while post-intent replay is `R: failure(POST_OUTCOME_UNKNOWN)`, with journal `POST_OUTCOME_UNKNOWN` in both cases. A post-intent run with verified completion remains success; the unknown branch applies only to a failed or unverified completion.

`Dispatch count` below means durable mutation-intent count: the `beforeDispatch` journal transition to `dispatching`, not proof that an HTTP POST reached the target. Record observed native POST attempts separately as `0`, `1` or `unknown` when browser or network evidence cannot establish delivery, and preserve that uncertainty.

| Scenario | Injection method/path or observed route decision | Phase relative to durable dispatch intent | Expected terminal run / journal status | Dispatch count |
| --- | --- | --- | --- | --- |
| validation | `--inject validation --fault-route <observed operation-entry GET path>`, or native `POST <observed form action>` if the target only rejects the submitted form | Detector or target rejection before intent is pre-intent; a rejection visible only in the POST response is post-intent | Pre-intent: `D stopped`/`escalated` → journal `failure`; `R business_outcome` → journal `business_outcome`. Post-intent: `D stopped(POST_OUTCOME_UNKNOWN)` and `R failure(POST_OUTCOME_UNKNOWN)` → journal `POST_OUTCOME_UNKNOWN` | 0 pre-intent; 1 post-intent |
| bad contact fields | Native `POST <observed member-update form action>` with explicitly chosen invalid values; no guessed fault route | Classify from the observed response; do not call a post-intent response a verified business outcome | Pre-intent: `D stopped`/`escalated` → journal `failure`; `R business_outcome` → journal `business_outcome`. Post-intent: `D stopped(POST_OUTCOME_UNKNOWN)` and `R failure(POST_OUTCOME_UNKNOWN)` → journal `POST_OUTCOME_UNKNOWN` | 0 pre-intent; 1 post-intent |
| insufficient funds | Freshly observe an underfunded source; PR #39's eligibility guard should reject it before the review/post route. If the target itself supplies a native rejection, record its observed `POST <form action>` rather than forcing an injection | PR #39 policy/validation refusal is pre-intent; a target business detector is pre-intent only if actually observed; a native rejection visible only after POST is post-intent | Pre-intent guard: `D stopped`/`escalated` → journal `failure`; `R failure(RUN_FAILED)` → journal `failure`. Pre-intent target detector: `R business_outcome` → journal `business_outcome`. Post-intent: `D stopped(POST_OUTCOME_UNKNOWN)` and `R failure(POST_OUTCOME_UNKNOWN)` → journal `POST_OUTCOME_UNKNOWN` | 0 pre-intent; 1 post-intent |
| not-found / absent member | Fresh read-only `GET <observed member/search path>` or exact member route; do not inject a mutation path or choose another member | Pre-intent read/business result | Discovery `stopped`/`escalated` → journal `failure`; replay `business_outcome` → journal `business_outcome`, with no claimed write | 0 |
| permission / teller hold | Teller context on the observed hold route, or `--inject permission --fault-route <observed hold-entry GET path>`; never substitute supervisor context | Pre-intent authority/detector check | `D stopped`/`escalated` → journal `failure`; `R failure(PERMISSION_DENIED)` → journal `failure` (or an explicitly observed pre-intent target business outcome) | 0 |
| timeout / natural expiry | `--inject timeout --fault-route <observed operation-entry GET path>`, or record the natural expiry route and timing | Pre-intent expiry stops; if expiry is observed only after intent, treat it as unknown | Pre-intent: `D stopped`/`escalated` → `failure`; `R failure(SESSION_EXPIRED)` → `failure`. Post-intent: `D stopped(POST_OUTCOME_UNKNOWN)` and `R failure(POST_OUTCOME_UNKNOWN)` → `POST_OUTCOME_UNKNOWN` | 0 pre-intent; 1 post-intent |
| maintenance | `--inject maintenance --fault-route <observed operation-entry GET path>`; record the observed Continue destination before attempting one recovery | Pre-intent only; same-browser repair may clear a known maintenance condition once, and menu/Continue alone is not completion | If not cleared or not reverified: `D stopped`/`escalated` → `failure`, `R failure` → `failure`; if a later approved post occurs, classify its result by its own phase. Post-intent maintenance is `D stopped(POST_OUTCOME_UNKNOWN)` and `R failure(POST_OUTCOME_UNKNOWN)` → `POST_OUTCOME_UNKNOWN` | 0 unless an explicitly approved post occurs; 1 for that post |
| server | `--inject server --fault-route <observed operation-entry GET path>`, or native `POST <observed form action>` if the target emits the error only after submission | Pre-intent application error is a stop; post-intent response is unknown | Pre-intent: `D stopped`/`escalated` → journal `failure`; `R failure(APPLICATION_ERROR)` → journal `failure`. Post-intent: `D stopped(POST_OUTCOME_UNKNOWN)` and `R failure(POST_OUTCOME_UNKNOWN)` → `POST_OUTCOME_UNKNOWN` | 0 pre-intent; 1 post-intent |
| missing hidden token | Remove or observe absence of the token before approval/dispatch on the exact inspected form; do not persist its value | Pre-intent client/guard refusal | `D stopped`/`escalated` → journal `failure`; `R failure` → journal `failure`; no server rejection is claimed | 0 |
| stale token rejected by server | Inspect a present token, then record the target's actual native `POST <observed form action>` response if it rejects after submission | Post-intent if the durable intent was recorded before the POST | `D stopped(POST_OUTCOME_UNKNOWN)` and `R failure(POST_OUTCOME_UNKNOWN)` → journal `POST_OUTCOME_UNKNOWN`; preserve the target text only as sanitized evidence | 1 |

`business_outcome` is valid only for a detector or target rejection observed before durable dispatch intent. The existing executor skips detectors after intent and maps unverified completion to `POST_OUTCOME_UNKNOWN`, even when the response text resembles a business rejection. After intent, do not retry, skip, run detector recovery or repair in the same browser. Same-browser repair is limited to an observed, profile-approved pre-intent recoverable condition such as maintenance; session expiry, permission and server failure do not permit repair or role change. Any allowed repair must revalidate the checkpoint before a new approval or dispatch.

- [ ] After Task 5c promotion, use Task 5d's separately authorized transfer replay as the real chat→API→dashboard write rehearsal; retain the existing successful balance-read evidence. Do not post another transfer solely to duplicate this checkbox. Repeat that same replay request key and confirm the original run ID without a second transaction. Rehearse an exceptional outcome and a repair that retains the same browser. Keep human repair distinct from complete discovery provenance.
- [x] Reauthenticate after reload and verify caller/operator visibility, read-only keyboard usability, status/result presentation, evidence view, elapsed time and historical `sensitiveValuesUnavailable` behavior after restart through the scoped Task 9c read and Task 9d local display check. Approval/handoff controls were not clicked; their keyboard operation, same-browser repair and integrated write rehearsal remain open.
- [ ] Update the evidence ledger with capability/version, discovery ID, replay ID, source SHA, approval, actual verified state, safety evaluation, evidence path and any limitation. If one of those facts is absent, mark the gate incomplete. Remove outdated completion claims, not adverse evidence. Update the 1–2 page report and exact setup/discovery/replay/demo commands.
- [ ] Run final repository gates and inspect hosted CI on the same final PR head:

```sh
npm run ci
npm run validate
git diff --check
gh pr checks --required
```

If no required checks are configured, inspect `gh pr view --json headRefOid,statusCheckRollup` and the producer jobs explicitly. A missing workflow is not a pass. Open the separate remaining-acceptance PR against `dev`; the capability PRs must already have delivered their own work. After merge, verify the resulting dev SHA and its CI separately. No production deployment is included.

## Coverage and completion boundary

| Replacement design section | Execution coverage |
| --- | --- |
| Outcome, prerequisites, seven functions | Tasks 1, 4–9 |
| Shared runtime, profile, login, guards, assertions, v2 tables | Reused #34 implementation; Tasks 1, 3–8 validate remaining gaps |
| API, auth, chat, approval, durable identity | Reused #34/#35; Tasks 2, 3, 5 and 9 |
| Dashboard, safe evidence, exceptions | Tasks 3–9; shared logger/guard/browser regression gates |
| Three-day scope, live evidence, delivery | Task 9; report elapsed work and incomplete gates honestly |
| Issues and deferrals | Preserve the replacement design's issue map; no automatic issue closures |

Done means seven reviewed artifacts with real discovery and separately approved replay evidence, all required exceptional paths, working dashboard/chat rehearsal, sanitized backup, runbook/report, and passing final local/hosted gates. Passing offline checks alone is not done. A target outage or unknown posting leaves the corresponding task incomplete with evidence and a concrete next read-only investigation.

## Plan self-review

- Scope checked against the replacement design; existing implementation is reused. One successful transfer discovery remains blocked on four promotion findings, three write recordings remain incomplete, and all four write replay gates remain open.
- Remaining transfer interfaces checked against `745ef645ae48730e769e6fc639ec4f71739d23e8`; Task 5b's additions are independently reviewed at `082e4c74a299b3fb6b1237a2d2c7846c2f60a663` on the separate runtime branch based on `5bc21fe9728b59ce6c9cf2013c48b85646eaf179`; PR #39 records its final hosted checks. Future artifact work must use the reviewed integrated baseline.
- No live selectors, post confirmations, resulting balances or new provenance were invented. Those are observation-dependent deliverables with explicit stop conditions.
- The old production-based branching instruction is superseded by the user's `dev` rule.
- Earlier planning revisions performed no code implementation or live posting. The resumed runtime implementation is scoped to Tasks 5a–5b; it performed no live posting, artifact promotion, replay or merge.
