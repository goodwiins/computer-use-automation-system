# MERIDIAN CORE Adaptation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete and demonstrate all seven MERIDIAN capabilities through the existing discovery, replay, API, chat, and operator approval workflow.

**Architecture:** Reuse the implementation in PR #34 and safety evaluation in PR #35. One Express process owns one active browser run, guarded actions, approvals, and the durable filesystem journal. Complete the missing live recordings and validation; do not rebuild those subsystems.

**Tech Stack:** Node 22, TypeScript, Express, Playwright, Zod, OpenAI/Azure, Vitest, static HTML/CSS/JavaScript; no new dependency.

**Spec:** [MERIDIAN CORE adaptation — replacement plan](2026-09-03-meridian-adaptation.md). Read it alongside this document. Its requirements remain authoritative; this document replaces its outdated implementation sequence and production-branch starting point.

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

### Current repair and integration status

- Task 1 — complete: reviewed PR #34 repairs were integrated into `dev` at `4252cb7`; both the reviewed PR head and the resulting dev SHA passed their respective hosted CI checks above.
- Task 2 — complete: CLI journal/resource and terminal-outcome repairs landed through `9a3e24d` after the scoped review; the recorded focused, CI, typecheck, validate and diff-check gates passed.
- Task 3 — complete: click-budget and trusted-step-reporting repairs landed through `47537d2` after the final deadline review; the recorded focused, CI, typecheck, validate and diff-check gates passed.
- Task 4 — complete for the read baseline: the three approved artifact checks and fresh sign-on, member-inquiry and member-record reads passed their recorded evaluator checks; the separate unsubmitted-form inspection recorded native POST destinations, controls and hidden-token presence. Chosen write review transitions and final posting facts remain open.
- Task 9a — complete for deterministic/offline acceptance at `541d776f85d94097bc1e63fa7966de69da5947de`: the reviewed dispatch, browser-closure, authority, identity, evidence and typed-output checks passed. This does not establish live target, posting, dashboard or hosted final-head acceptance.
- Task 9b — complete for the scoped documentation and sanitized metadata backup at `ca5d99a21e7274445eb119a71bc8c61f548fa9a7`; its source-specific local and hosted checks passed. This did not change runtime behavior or establish a live write.
- Task 9c — complete for the scoped real dashboard read, reload, evidence, role and keyboard checks. The accepted run `288d7cae-c486-4f08-b810-c1e4aa1d4afe` and independent post-restart projection preserve the `3/7` boundary, historical redaction and unknown state. The missing elapsed-time display was assigned to Task 9d.
- Task 9d — complete for the scoped shared elapsed-time renderer, focused browser assertion and current read documentation alignment on this branch. The new head awaits independent controller review and hosted checks; this does not close the write or whole-Task-9 gates.
- Tasks 5–8 and the remaining live portions of Task 9 remain pending: new write discoveries/replays, separate current-fact approvals, result verification, operation-specific unhappy paths, integrated dashboard/chat rehearsal, same-browser repair, approval/handoff keyboard operation and final delivery gates are not inferred from the read or offline evidence.
- Controller ordering ruling: Task 9a, Task 9b, Task 9c and Task 9d may proceed while Tasks 5–8 await fresh live choices and approvals; a read or artifact promotion does not authorize a write, and the historical `222ebecd-ca02-4960-a875-c2f2f76e0927` operation remains `POST_OUTCOME_UNKNOWN`.

Read [PR #34](https://github.com/goodwiins/computer-use-automation-system/pull/34), [PR #35](https://github.com/goodwiins/computer-use-automation-system/pull/35), and their `docs/meridian/live-evidence.md`. Existing evidence reports:

- Sign-on, member inquiry, and member record have real discovery and deterministic replay evidence. Preserve that provenance. Refresh a read before each new live session.
- Four write artifacts and approved replays remain incomplete.
- Open-share discovery `222ebecd-ca02-4960-a875-c2f2f76e0927` is terminal `POST_OUTCOME_UNKNOWN`. A model completion message did not establish success; compilation failed after dispatch. Never repeat this request, delete its journal record, or reconstruct its missing provenance.
- Six injected-error probes are read-only probes; they do not prove complete write replay or successful recovery.
- Dashboard/chat previously invoked a read but ended in `SESSION_EXPIRED`; a later caller chat/API/runtime read at `541d776f85d94097bc1e63fa7966de69da5947de` (`ff5fda32-db07-443f-930d-db2d65461dc0`) returned `202` and success with evaluator pass, and an exact-key duplicate returned the same run ID. Task 9c separately recorded genuine dashboard UI read `288d7cae-c486-4f08-b810-c1e4aa1d4afe` at source `ca5d99a21e7274445eb119a71bc8c61f548fa9a7`, including reload, role, evidence and accepted Refresh/Send keyboard checks. The successful integrated write rehearsal and same-browser repair remain open.
- PR #35's evaluator checks local event ordering and journal consistency. It is not a business-result verifier, and older incomplete event logs must not be relabelled as passing.

## Task map and file ownership

This is a completion plan for one demo, with separately reviewable deliverables. Execute in dependency order. Each task can produce a separate PR against `dev` after its prerequisites land; do not start parallel live browser runs.

| Task | Owned files / responsibility | Dependency |
| --- | --- | --- |
| 1 | Existing #34/#35 branches and their review fixes; integrate without duplicating their feature code | None |
| 2 | `cli.ts`, `src/runtime/journal.ts`, `test/meridian-cli.test.ts` — CLI journal lifetime and safe terminal failures | Current #34/#35 candidate; resolve during 1 |
| 3 | `src/surface/{types,browser,guarded}.ts`, `src/replay/executor.ts`, `src/server/service.ts`, `test/{meridian,guarded}.test.ts` — unresolved review checks | Current #34/#35 candidate; resolve during 1 |
| 4 | `test/meridian-artifacts.test.ts`, `docs/meridian/live-evidence.md` — artifact acceptance check and live readiness | 2, 3 |
| 5 | `artifacts/meridian-funds-transfer.v1.0.0.json`, its evidence directory | 4 |
| 6 | `artifacts/meridian-open-share.v1.0.0.json`, its evidence directory | 4; separate explicit new operation |
| 7 | `artifacts/meridian-update-member.v1.0.0.json`, its evidence directory | 4 |
| 8 | `artifacts/meridian-place-hold.v1.0.0.json`, its evidence directory | 4; supervisor operator |
| 9 | `test/meridian.test.ts`, `docs/meridian/{live-evidence,runbook,report,evaluation}.md`, sanitized evidence, `README.md`, `docs/README.md` — acceptance and delivery | 5–8 |

Profile or contract corrections discovered in Tasks 5–8 belong in `config/app-profiles/meridian.json` or `src/runtime/contracts.ts` with a focused regression in `test/meridian.test.ts`. Only change observed rules; do not add another browser runner, API, UI framework, job queue, telemetry backend, or MERIDIAN clone.

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
- [ ] Inspect each chosen write's review transition and final posting control with fresh facts and its separate approval. The controller inspection did not click `Continue`, `Save Changes`, `Apply Hold` or any final posting control; no write artifact, approval or posting is established.
- [x] Commit the artifact check and sanitized readiness note after the final integrated gates. Existing contract tests establish the baseline; do not manufacture a failing test when the behavior already exists.

## Live-operation rules for Tasks 5–8

For every task, discovery and replay are **two separately requested operations**, each with new live facts and separate approval. Choose fresh keys only for genuinely new operations; retries of one invocation reuse its key. Save each key locally before dispatch. Never auto-repeat any run after dispatch intent or `POST_OUTCOME_UNKNOWN`.

After recording, inspect the complete draft: explicit operator/password/branch references, stable select values, meaningful assertions, extract-backed outputs, effective irreversible post risk and sensitive metadata. Confirm its real discovery run ID. Promote with `cu replay --artifact <the recorded artifact path> --approve` only after that review. Promotion returns without submitting a transaction.

The commands below assume Task 4's wrapper and selected variables. A declaration such as `TRANSFER_DISCOVERY_KEY` means a locally saved request identity, not a secret and not permission to retry by changing it. Do not paste real credentials or raw member data into GitHub.

For each terminal run, use the existing evaluator with the existing private `EVIDENCE_DIR` and journal key loaded from `.env`:

```sh
node --env-file=.env --import tsx scripts/evaluate-run.ts "$EVIDENCE_DIR" "$RUN_ID"
```

Set `RUN_ID` from that command's actual output and `EVIDENCE_DIR` to the configured run root, not its `journal` subdirectory. Success requires safety pass **and** the expected business result. Preserve a failing or unknown result faithfully. Copy only inspected sanitized evidence into `docs/meridian/evidence/`; never copy the private journal, `.env`, cookies or full raw output.

## Task 5: Record and verify funds transfer

**Files:** Create `artifacts/meridian-funds-transfer.v1.0.0.json`; modify `test/meridian-artifacts.test.ts`, `docs/meridian/live-evidence.md`; save sanitized evidence under `docs/meridian/evidence/funds-transfer/`.

**Interfaces:** Public inputs `{member, sourceShare, destinationShare, amount, memo}`; outputs `confirmation` and typed `transaction` rows. Reuse the existing named contract. The posting requires teller authority and operator approval.

- [ ] Add `'meridian-funds-transfer'` to the artifact check's `ids`. Run `npx vitest run test/meridian-artifacts.test.ts -t meridian-funds-transfer`; expected missing-artifact failure.
- [ ] Confirm source balance and status, distinct eligible destination, amount `0.01`, and memo `Demo` with the operator. Record current balances privately for verification, using integer cents.
- [ ] Start real discovery with a saved new-operation key:

```sh
cu discover --profile meridian --name meridian-funds-transfer \
  --goal 'Sign on with explicit operator/password/branch references. Transfer amount between the exact sourceShare and destinationShare for member with memo. Select share values, inspect review, request posting approval, then assert completion and extract confirmation and a transaction table verifying the posted details.' \
  --param member="$MEMBER" --param sourceShare="$SOURCE_SHARE" \
  --param destinationShare="$DESTINATION_SHARE" --param amount=0.01 --param memo=Demo \
  --sensitive member --sensitive sourceShare --sensitive destinationShare \
  --sensitive amount --sensitive memo --idempotency-key "$TRANSFER_DISCOVERY_KEY"
```

- [ ] Human inspects and approves the actual facts. Automation performs and records the post. Verify the source/destination effects and any confirmation on a fresh read. If completion or artifact compilation fails after intent, stop with unknown outcome and do not rerun discovery.
- [ ] Review and promote the artifact:

```sh
cu replay --artifact artifacts/meridian-funds-transfer.v1.0.0.json --approve
npx vitest run test/meridian-artifacts.test.ts -t meridian-funds-transfer
```

- [ ] Start the dashboard with `cu serve --profile meridian`. As caller, request a separately approved transfer through chat or direct invoke. Supply the selected current inputs and a saved `TRANSFER_REPLAY_KEY`. As operator, verify facts and approve. A fresh read must verify the second operation independently; do not mistake discovery's balance change for replay's result.
- [ ] Evaluate both runs; record exact IDs, artifact version, source SHA, approval/result distinction, and sanitized verification summary. Commit this artifact/test/evidence as one deliverable: `feat: record verified MERIDIAN funds transfer`.

## Task 6: Record a new open-share operation

**Files:** Create `artifacts/meridian-open-share.v1.0.0.json`; modify the artifact test and live evidence; save sanitized evidence under `docs/meridian/evidence/open-share/`.

**Interfaces:** Inputs `{member, shareType, deposit}`; output `shareId`. This is a new explicitly chosen operation, never a retry of `222ebecd-ca02-4960-a875-c2f2f76e0927`.

- [ ] Add `'meridian-open-share'` to the test's `ids`; run `npx vitest run test/meridian-artifacts.test.ts -t meridian-open-share`. Expected: missing-artifact failure.
- [ ] Operator chooses the new operation, confirms current member/share state, share type `S0001` and deposit `5.00`, and saves its request key. If a second new share is not wanted, do not use replay merely to satisfy a checkbox; leave the live gate incomplete.
- [ ] Discover with all three explicit server login references:

```sh
cu discover --profile meridian --name meridian-open-share \
  --goal 'Record explicit operator/password/branch references before sign-on. Open shareType for member with deposit, inspect review, request posting approval, assert completion and extract the newly created shareId. Never infer completion from reaching review.' \
  --param member="$MEMBER" --param shareType=S0001 --param deposit=5.00 \
  --sensitive member --sensitive deposit --idempotency-key "$SHARE_DISCOVERY_KEY"
```

- [ ] Approve current facts interactively; verify the resulting share ID against a fresh member record. A model message is insufficient. On any post-intent ambiguity, preserve unknown and stop.
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
- [ ] Select an eligible current synthetic share for this new hold. Verify role before writing. Retain a natural teller-denial example without elevating that run or replaying its failed mutation.
- [ ] Discover the explicitly requested supervisor operation:

```sh
cu discover --profile meridian --operator SUPERVISOR --name meridian-place-hold \
  --goal 'Record explicit supervisor operator/password/branch references and sign on. Place a hold on the exact share for member with reason/notes. Inspect review, request Apply Hold approval, assert completion and extract heldShare from verified resulting state.' \
  --param member="$MEMBER" --param share="$HOLD_SHARE" --param reason=FRAUD --param notes=Demo \
  --sensitive member --sensitive share --sensitive notes --idempotency-key "$HOLD_DISCOVERY_KEY"
```

- [ ] Approve only after role and share facts match. Verify HOLD on that share through a fresh read. Review/promote and check:

```sh
cu replay --artifact artifacts/meridian-place-hold.v1.0.0.json --approve
npx vitest run test/meridian-artifacts.test.ts -t meridian-place-hold
```

- [ ] Operator chooses a separate eligible share for replay with `HOLD_REPLAY_KEY`; invoke through the operator dashboard with supervisor context, approve and verify the new hold. Caller attempts to select supervisor or approve must return 403. Do not silently hold a second arbitrary share to complete testing.
- [ ] Evaluate both runs, retain the distinct teller denial and supervisor success evidence, and commit as `feat: record verified MERIDIAN account holds`.

## Task 9: Finish unhappy paths, integrated rehearsal and delivery

**Files:** Extend existing `test/meridian.test.ts` only for missing deterministic checks; repair the shared dashboard renderer in `src/server/public/app.js`; update `docs/meridian/live-evidence.md`, `docs/meridian/runbook.md`, `docs/meridian/report.md`, `docs/meridian/evaluation.md`, and the scoped sanitized evidence summary under `docs/meridian/evidence/`. The broader `README.md` and `docs/README.md` remain outside this narrow Task 9d update.

**Interfaces:** Existing HTTP endpoints and auth remain unchanged. `GET /runs/:id` exposes lifecycle/result; operator `/decision` resolves one intervention. `npm run eval` consumes local evidence and authenticated journal records without mutating them.

- [x] Run existing offline coverage first for Task 9a:

```sh
npx vitest run test/meridian.test.ts test/evidence-eval.test.ts test/meridian-artifacts.test.ts test/screenshot-mask.test.ts
```

This passed with 4 files and 66 tests at `541d776f85d94097bc1e63fa7966de69da5947de`; the earlier 198-test run at `4ec9b93` is historical and not a current-head full-suite claim.

- [x] Task 9a's reviewed deterministic matrix is covered by focused local regressions at `541d776f85d94097bc1e63fa7966de69da5947de`; its scope remains offline and does not satisfy the live operation rows below. Do not duplicate passing coverage. The assertion is the required observable result, not a test-name substring.

- [x] Task 9b's scoped evidence ledger and sanitized read summary retain the source-specific `3/7` boundary, current caller API-only distinction, evaluator results and historical unknown state.

- [x] Task 9c's real dashboard read and independent restart check recorded login, reload, caller/operator visibility, evidence view, accepted Refresh/Send keyboard effects, historical redaction, unchanged 26-run count and unchanged unknown envelope. The initial focus-derived flag remains insufficient on its own.

- [x] Task 9d repairs the shared run-card elapsed display and adds a focused browser assertion for known elapsed time, true zero and missing historical timing. The local fixture is a display check, not another live rehearsal; the new head's independent review and hosted checks remain pending.

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
| Hostile message/HTML, unauthorized evidence path | Inert UI text; denied evidence access; no credential in URL/storage |

- [ ] Exercise six per-request scenarios on the actual operation route using runbook `--inject`/`--fault-route`, with new test requests and operator-selected inputs. Do not loop live mutation commands blindly. Verify the target's actual response and run classification:

| Scenario | Expected decision |
| --- | --- |
| validation, bad contact fields, insufficient funds | Business rejection; no claimed successful posting |
| not-found / absent member | Business outcome; never choose another member automatically |
| permission / teller hold | Stop; no automatic supervisor substitution |
| timeout / natural expiry | Stop; no mid-flow login |
| maintenance | At most supported bounded recovery; Continue→menu alone is not completion |
| server | Explicit stop or known safe behavior; never retry a submitted mutation |
| missing/stale hidden token | Fail closed or target rejection recorded; token value never persisted |

- [ ] Rehearse a successful balance request and a separately authorized transfer through real chat→API→dashboard. Repeat the same API request key and confirm the original run ID without a second transaction. Rehearse an exceptional outcome and a repair that retains the same browser. Keep human repair distinct from complete discovery provenance.
- [x] Reauthenticate after reload and verify caller/operator visibility, read-only keyboard usability, status/result presentation, evidence view, elapsed time and historical `sensitiveValuesUnavailable` behavior after restart through the scoped Task 9c read and Task 9d local display check. Approval/handoff controls were not clicked; their keyboard operation, same-browser repair and integrated write rehearsal remain open.
- [ ] Update the evidence ledger with capability/version, discovery ID, replay ID, source SHA, approval, actual verified state, safety evaluation, evidence path and any limitation. If one of those facts is absent, mark the gate incomplete. Remove outdated completion claims, not adverse evidence. Update the 1–2 page report and exact setup/discovery/replay/demo commands.
- [ ] Run final repository gates and inspect hosted CI on the same final PR head:

```sh
npm run ci
npm run validate
git diff --check
gh pr checks --required
```

If no required checks are configured, inspect `gh pr view --json headRefOid,statusCheckRollup` and the producer jobs explicitly. A missing workflow is not a pass. Open the delivery PR against `dev`; after merge, verify the resulting dev SHA and its CI separately. No production deployment is included.

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

- Scope checked against every section of the replacement design; existing implementation is reused and four missing write capabilities retain explicit gates.
- Paths/signatures checked against #35 at `338734d`; new helper/test paths are labelled as additions. Rebase drift requires refreshing these checks.
- No live selectors, post confirmations, resulting balances or new provenance were invented. Those are observation-dependent deliverables with explicit stop conditions.
- The old production-based branching instruction is superseded by the user's `dev` rule.
- No code implementation, live posting, branch retargeting or merge was performed while writing this plan.
