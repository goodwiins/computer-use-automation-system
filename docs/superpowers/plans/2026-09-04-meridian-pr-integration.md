# MERIDIAN Open-PR Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish point 1 of the next-work list: deliver the reviewed changes from PRs #37, #39, #40 and #41 into `dev`, with conflict resolutions checked and CI verified on the resulting commits.

**Architecture:** Reuse the four existing PRs and their tests. Review in number order (#37, #39, #40, #41), then integrate in dependency order (#37, #39, #41, #40), putting the current documentation last so older plan copies cannot overwrite it. Perform work serially; this plan does not add another runtime, feature branch containing duplicate implementations, or live browser operation.

**Tech Stack:** Existing Git/GitHub CLI, Node 22, TypeScript, Playwright, Vitest and Zod; no new dependencies.

**Spec:** The user's next-work point 1, the three runtime review comments fixed in #41, [remaining execution plan](../../plans/2026-09-04-meridian-superpowers.md), and [target-application supplement](../../plans/2026-09-04-meridian-target-application.md). This is an integration supplement, not a replacement for the capability acceptance plan.

## Global Constraints

- Every PR targets `dev`. The repository's production/default branch is `master`; do not update it.
- Preserve dirty worktrees, the unpromoted transfer recording and its evidence. Do not reset, stash, clean, or publish unrelated edits.
- Use isolated checkouts for reviews. Updating an existing PR branch requires a clean checkout and verification that another worker is not using it.
- Prefer merging current `origin/dev` into an existing PR branch and pushing normally. Do not rewrite shared branch history merely to integrate this work.
- Planning does not execute merges. At execution, establish that the current session authorizes merging the concrete reviewed candidates before using the merge commands. Prepare and validate candidates first if approval is still needed.
- No hosted sign-on, recording, artifact promotion or transaction posting belongs to this integration task.
- Live acceptance stays **3/7**. Passing integration tests does not accept a write capability.
- Keep `POST_OUTCOME_UNKNOWN` terminal. Cleanup failures and cancellation cannot clear dispatch intent or permit automatic retry.
- Keep values, URLs, raw exceptions and credentials out of strict diagnostics. Preserve the authenticated journal and existing evidence projection.
- Assistant-ui remains the final chat phase. Preserve #37's existing elapsed-time correction; do not expand it into new UI work.
- Implement `INSUFFICIENT_FUNDS` in the next separate runtime PR, after this baseline is integrated.

## Verified starting point and execution ledger

Snapshot refreshed September 4, 2026. Historical head results remain attached to the source that produced them; passing integration tests do not establish live capability acceptance.

Current consumed `origin/dev`: `aa90387244be07b9955b8b5b83eacf4b9f3058a1`.

| PR | Reviewed/final head | Integration result | Hosted producer evidence |
| --- | --- | --- | --- |
| [#37](https://github.com/goodwiins/computer-use-automation-system/pull/37) | `745ef645ae48730e769e6fc639ec4f71739d23e8` | Merged as `480b252ab60edc77aff1bc37f6cd08ba9645f8d1`; read acceptance and elapsed-time display retained | Historical head [passed](https://github.com/goodwiins/computer-use-automation-system/actions/runs/33859462030/job/100980319268); merge [run `33919679746`, job `101174884826`](https://github.com/goodwiins/computer-use-automation-system/actions/runs/33919679746/job/101174884826) passed |
| [#39](https://github.com/goodwiins/computer-use-automation-system/pull/39) | Initial inspected `b093b6503a39339399f57c2d59a3d5f5b417c18d`; repair `05f0647`; final reviewed `64c9b11` | Merged as `fcd87f7fb8d573c8d44d43436310cce07baae06a`; transfer guards retained; 257 local tests | Head [run `33920737879`, job `101178214101`](https://github.com/goodwiins/computer-use-automation-system/actions/runs/33920737879/job/101178214101) and merge [run `33920922815`, job `101178797950`](https://github.com/goodwiins/computer-use-automation-system/actions/runs/33920922815/job/101178797950) passed |
| [#41](https://github.com/goodwiins/computer-use-automation-system/pull/41) | Repair `3aacfac`; final reviewed `ec5f6a1ea421c7d4b5b345c4d83614eb513d3ec9` | Merged as `aa90387244be07b9955b8b5b83eacf4b9f3058a1`; three reviewed lifecycle findings fixed; 269 local tests | Head [run `33921302067`, job `101180000937`](https://github.com/goodwiins/computer-use-automation-system/actions/runs/33921302067/job/101180000937) and merge [run `33921529657`, job `101180716774`](https://github.com/goodwiins/computer-use-automation-system/actions/runs/33921529657/job/101180716774) passed |
| [#40](https://github.com/goodwiins/computer-use-automation-system/pull/40) | Remote head `f635798435dca7fb7eb40c616df74f26e4ccb69f`; reviewed local plan commit `0f6f11a1c324073a66e9bd6d08964ac72340abf1`; fallback-key fix `4d9a05e` | The documentation reconciliation is committed locally and consumes `aa903872`; independent final review, hosted CI, push and merge remain pending | Remote-head-only [run `33912439907`, job `101151716399`](https://github.com/goodwiins/computer-use-automation-system/actions/runs/33912439907/job/101151716399) passed; it is not evidence for the unpublished candidate |

PRs #37, #39 and #41 are integrated with passing head and merge producer checks. PR #40 remains the protected documentation candidate and must obtain review and hosted CI on its published final head before merge. CodeRabbit's earlier skipped-review status is not used as review evidence.

The combined tree retains the three-artifact read acceptance, #39 operation/fact binding, and #41 terminal lifecycle handling. Those runtime fixes do not approve or promote the transfer draft, accept any of the four write capabilities, or raise live coverage above `3/7`.

## Ownership and deliverables

| Area | Files | Required result |
| --- | --- | --- |
| Read acceptance | `test/meridian-artifacts.test.ts`, `test/meridian.test.ts`, `src/server/public/app.js`, `docs/meridian/evidence/fresh-read-summary.json` | Preserve three approved artifact checks, read evidence and elapsed-time rendering |
| Transfer runtime | `src/runtime/contracts.ts`, `src/runtime/profile.ts`, `src/surface/{types,browser,guarded}.ts`, `src/runtime/run.ts`, `src/replay/executor.ts`, `src/agent/loop.ts`, `cli.ts` | Preserve live fact validation, approval binding and verified completion |
| Terminal outcomes | `src/server/service.ts`, `src/runtime/run.ts`, `src/replay/executor.ts`, `src/agent/loop.ts`, `src/surface/guarded.ts`, `src/evidence/safe-event.ts`, `test/runtime-lifecycle.test.ts` | All nine lifecycle regressions survive integration |
| Documentation | `docs/README.md`, `docs/meridian/{live-evidence,evaluation,report,runbook}.md`, `docs/plans/2026-09-03-meridian-adaptation.md`, `docs/plans/2026-09-04-meridian-{superpowers,target-application}.md` | One consistent remaining plan and an honest evidence ledger |
| Integration record | This file | Replace the unchecked gates with actual reviewed heads, merge commits and producer results as execution progresses |

The deliverable is a verified `dev` baseline, not another PR duplicating the four existing PRs. A newly discovered independent defect can receive its own scoped PR if it cannot be resolved within an existing PR's responsibility.

## Task 1: Establish the execution baseline and protect existing work

**Files:** Read worktree status and Git refs; update only this plan's execution record.

**Interfaces:** Consumes the four PR numbers and current repository state; produces a frozen review ledger and safe checkout locations.

- [ ] Run the following from a repository checkout:

```bash
git status --short
git worktree list --porcelain
git fetch origin
git rev-parse origin/dev
gh pr list --repo goodwiins/computer-use-automation-system --state open --limit 20 \
  --json number,title,baseRefName,headRefName,headRefOid,mergeable,reviewDecision,statusCheckRollup
```

- [ ] Record each current head and base. If a PR has already merged, inspect its merge commit and resulting `dev` history instead of recreating its work. If a head changed, review its new diff.
- [ ] Inspect `git status --short` separately in `/Users/goodwiinz/development/interface.ai` and `/Users/goodwiinz/.codex/worktrees/5400/interface.ai`. These were previously dirty; preserve their contents. In particular, do not commit the transfer draft or its pending catalog entry while reviewing #37.
- [ ] Use the Superpowers worktree workflow to obtain a detached review checkout for a pinned PR head. Do not check out an already occupied PR branch in a second worktree. The review checkout is disposable; the original checkout is not.
- [ ] Read applicable `AGENTS.md`/`RTK.md` instructions, use Node 22, and run `npm ci --no-audit --no-fund` in a new review checkout. If Chromium is missing, install the project's pinned Playwright browser; do not update dependencies.

**Acceptance:** Every candidate is identified by a current SHA; no source or evidence in an existing dirty worktree has changed.

## Task 2: Finish the four source reviews before integration

**Files:** Review the files in the ownership table; change code only to address a concrete finding with a regression.

**Interfaces:** Consumes pinned PR heads; produces one verdict and exact validation evidence per head.

- [ ] Review #37's diff against its actual base. Confirm that `test/meridian-artifacts.test.ts` still names only `meridian-sign-on`, `meridian-member-inquiry` and `meridian-member-record`, requires approved status and genuine discovery IDs, and preserves server-bound login parameters.
- [ ] Verify the one-line elapsed-time display checks finite, nonnegative values and preserves the existing text-only rendering and credential handling. Check that fresh-read summaries describe reads, not accepted write capabilities.
- [ ] Review #39's eligibility and review paths end to end. Follow the observed member/share lookup, decimal-to-cents validation, scoped review facts, token/role/branch checks, approval, reinspection, durable intent and final output verification. Wrong rows, duplicate labels and stale facts must fail closed.
- [ ] Review #40 against the source and evidence, not its checkbox count. Preserve the four transfer-artifact findings, the typed insufficient-funds work as still pending, the fallback modes, and assistant-ui ordering.
- [ ] Review #41's setup catch, safe cleanup helper and typed cancellation. Confirm the active slot survives until constructed-runtime cleanup finishes; a failed setup becomes terminal; cleanup cannot replace a verified result; denied approval cannot enter recovery, another model turn or another handoff.
- [ ] Run relevant existing checks in the checkout for each candidate:

```bash
# #37
npx vitest run test/meridian-artifacts.test.ts test/meridian.test.ts

# #39
npx vitest run test/meridian.test.ts test/meridian-cli.test.ts test/guarded.test.ts

# #41
npx vitest run test/runtime-lifecycle.test.ts test/guarded.test.ts
```

- [ ] For a concrete new defect, reproduce it with the smallest regression at its real boundary, fix the shared cause, and repeat that regression. Do not create speculative tests or rebuild already passing features.
- [ ] Record verdict, reviewed head, relevant file locations and any unresolved finding. Any changed head needs updated local checks and a new hosted producer result.

**Acceptance:** All four candidates have an explicit review disposition. Earlier review findings are either fixed or clearly block their owning PR; a skipped bot review is never used as approval.

## Task 3: Integrate #37 and verify the resulting `dev`

**Files:** Existing #37 files; no new feature scope.

**Interfaces:** Consumes the reviewed #37 head; produces a CI-verified `dev` commit containing its read baseline.

- [x] Recheck #37's current SHA, base, mergeability and checks. If `dev` moved, refresh the candidate and review the changed comparison before merging.
- [x] Run `npm run ci`, `npm run validate` and `git diff --check` on the final candidate, unless that exact unchanged tree already has recorded passing local checks. Keep producer evidence for the exact PR head.
- [x] When merge authorization is established, merge with the reviewed head pinned. Run the following from the checkout whose current HEAD was just reviewed and validated. The guard refuses the merge if the remote PR head differs:

```bash
pr37_head=$(git rev-parse HEAD)
gh pr merge 37 --repo goodwiins/computer-use-automation-system --merge --match-head-commit "$pr37_head"
git fetch origin
gh pr view 37 --repo goodwiins/computer-use-automation-system --json state,mergeCommit
```

- [x] Record the returned merge commit. Inspect the CI run whose `headSha` is that merge commit; do not substitute the PR-head CI result. If a later unrelated commit has already advanced `dev`, record it separately.
- [x] Confirm the merged tree contains the three-artifact test and read summary. Do not promote the pending transfer draft to make a catalog test pass.

**Acceptance:** #37 is merged into `dev`, its merge commit's CI passes, and the read-only acceptance boundary is unchanged.

## Task 4: Reconcile #39 with the new `dev`

**Files:** Initially the three known conflict files, plus any newly reported conflict. Preserve the runtime files in #39's ownership.

**Interfaces:** Consumes `dev` after #37 and #39's reviewed changes; produces an updated, independently validated #39 head.

- [x] Confirm `/Users/goodwiinz/.codex/worktrees/interface-ai-transfer-runtime` is clean, on `codex/meridian-transfer-runtime`, and not being edited by another worker. Fetch and inspect divergence before editing; if unexpected work exists, coordinate ownership rather than overwriting it.
- [x] Bring `origin/dev` into that branch using a merge. Resolve reported conflicts individually:

```bash
git fetch origin
git merge --no-commit origin/dev
git diff --name-only --diff-filter=U
```

- [x] In `test/meridian.test.ts`, retain both #37's timing/read tests and #39's transfer tests. Remove duplicated unchanged helpers only after checking their definitions; do not discard a whole side of the file. Preserve the tests for wrong canonical transaction rows, scoped review facts, native Continue forms, workarea frames, changed posting facts and per-attempt evidence.
- [x] In `docs/meridian/live-evidence.md`, retain #37's read acceptance details and #39's transfer discovery limitations. A successful discovery post does not imply an approved artifact or successful deterministic replay.
- [x] In `docs/plans/2026-09-04-meridian-superpowers.md`, keep #39's transfer-runtime progress and #37's factual read updates. Treat #40 as the authority for the final remaining execution gates; it will be reconciled in Task 6.
- [x] Scan tracked files for conflict markers, then run the focused transfer checks and full gates:

```bash
git grep -n -E '^(<<<<<<<|=======|>>>>>>>)' -- '*.ts' '*.js' '*.md'
npx vitest run test/meridian.test.ts test/meridian-cli.test.ts test/meridian-artifacts.test.ts test/guarded.test.ts
npm run ci
npm run validate
git diff --check
```

The marker scan normally returns exit status 1 because no markers match. Inspect any match; Markdown separators may require interpretation.

- [x] Stage only resolved files, complete the merge commit, and push normally. Review the conflict-resolution diff as new code. Wait for the updated #39 head's CI before merging it using the same head-pinning pattern as Task 3, with PR number 39.
- [x] Record #39's merge commit and verify its `dev` CI. Do not start live acceptance between #39 and #41: the terminal-outcome fixes are still a prerequisite.

**Acceptance:** #39 includes the read baseline, retains its transfer protections, and has passing CI both on its final PR head and its resulting merge commit.

## Task 5: Integrate #41 without weakening transfer safety

**Files:** `src/{agent/loop,replay/executor,runtime/run,server/service,surface/guarded,evidence/safe-event}.ts` and `test/runtime-lifecycle.test.ts`.

**Interfaces:** Consumes `dev` after #39; produces a combined transfer runtime with correct terminal outcomes.

- [x] Confirm the terminal-outcomes worktree is clean and not actively owned by another worker. Merge current `origin/dev` into `codex/meridian-runtime-terminal-outcomes`; preserve both sets of changes even if Git reports no conflict.
- [x] Trace `createRuntime`, `executeReplay`, `closeRuntime`, `InvocationService.invoke`, `runReplay`, `runDiscovery` and `GuardedSurface` in the combined tree. Preserve #39's output validation and #41's cleanup handling together.
- [x] Confirm cancellation is handled before ordinary recovery/escalation, while `mutationDispatched` uncertainty still takes precedence. A cancelled operation after intent cannot become an ordinary safe-to-retry failure.
- [x] Run the existing integration-relevant tests:

```bash
npx vitest run test/runtime-lifecycle.test.ts test/meridian.test.ts test/meridian-cli.test.ts test/guarded.test.ts
npm run ci
npm run validate
git diff --check
```

- [x] Inspect all nine lifecycle cases: construction failure and idempotent lookup; verified success despite cleanup failure; original error despite diagnostic failure; partial-setup cleanup before slot release; terminal denial in replay, discovery and recovery; API/journal/result consistency with both successful and failing cleanup.
- [x] Preserve strict `RUNTIME_CLEANUP_FAILED` metadata without persisting the raw exception. Confirm that `result.json`, journal and API agree in the cleanup-failure regression.
- [x] Commit any merge resolution, push, inspect exact-head CI, merge authorized #41 with the reviewed head pinned, and verify the resulting `dev` commit's CI.

**Acceptance:** The combined runtime passes the lifecycle and transfer regressions. These checks demonstrate code behavior offline; live coverage remains 3/7.

## Task 6: Integrate #40 as the final documentation source

**Files:** This plan, `docs/README.md`, `docs/meridian/{report,runbook,live-evidence,evaluation}.md`, and the three existing design/execution/target-application plan files as necessary for factual reconciliation.

**Interfaces:** Consumes the integrated runtime and read evidence; produces one current documentation baseline and next-task handoff.

- [x] Preserve this newly written integration plan deliberately before refreshing the documentation branch. Review its diff, then commit it as documentation if it is to be delivered with #40; do not discard it as an unexpected untracked file.
- [x] Merge current `origin/dev` into `codex/meridian-plan-review-fixes`. Resolve overlapping plans and reports paragraph by paragraph; do not use blanket `ours` or `theirs` selection.
- [x] Update the PR ledger with actual reviewed heads and merge commits for #37, #39 and #41. Keep historical evidence associated with the source that produced it; do not relabel it as a fresh run on the integrated source.
- [x] Mark the three #41 runtime findings fixed, while retaining the transfer artifact's separate recording/provenance, fact-binding and completion acceptance gates. Runtime fixes alone do not promote an artifact.
- [x] Keep Task A, `INSUFFICIENT_FUNDS`, explicitly pending. State that valid pre-intent underfunding should become a business outcome; malformed/wrong-account data remains a failure and post-intent uncertainty remains unknown.
- [x] Preserve the distinction between live execution, offline fixture demonstration and recorded evidence. None raises the 3/7 live count. Keep assistant-ui deferred until capability/runtime/API acceptance and user UI direction.
- [x] Check relative links and search changed documentation for stale claims that #37/#39/#41 are still open or that the four writes are already accepted. Preserve historical quotations where their date and source are clear.
- [ ] Run `npm run ci`, `npm run validate` and `git diff --check` as required by the repository gates. Commit only the scoped documentation, push, review the new #40 head, then merge the authorized candidate and verify its `dev` CI.

Local candidate gates passed after reconciliation: `npm run ci` completed typecheck and 269 tests across 16 files; `npm run validate`, `git diff --check`, the relative-link scan, and the conflict-marker scan passed. The combined item remains open for the final commit, independent review, publication, exact-head hosted CI, merge, and post-merge `dev` producer.

**Acceptance:** The latest execution gates survive integration, source/evidence claims agree, and the plan clearly names the next runtime task.

## Task 7: Final verification and handoff

**Files:** Read the integrated tree and update the execution record below. Do not start Task A in this task.

**Interfaces:** Consumes all four integrated changes; produces a verified baseline SHA and a bounded next task.

- [ ] Fetch current refs and confirm all four PRs report `MERGED` into `dev`. Verify the final branch contains the expected files and review-fix behavior; do not infer this solely from PR state.
- [ ] Record the final integrated `dev` SHA, its exact CI producer link and test count. Reuse an already passing check for the same commit/tree; rerun locally only if integration changed code after the last local gate or a failure needs diagnosis.
- [ ] Inspect producer logs for any failed gate. Separate dependency/browser-install failures from test failures. Do not rerun until green without explaining the original failure.
- [ ] Confirm the protected original worktrees still contain their original draft/evidence edits and that no live run or artifact promotion occurred during integration.
- [ ] Hand off a short status: merged PRs, final SHA, local/hosted checks, live coverage 3/7, remaining blockers, and the next task below.

**Next task:** Create a separate isolated `codex/` branch from this verified `origin/dev` for the target-application supplement's Task A. Implement `InsufficientFundsError` and propagate a pre-intent `business_outcome / INSUFFICIENT_FUNDS` through replay, discovery and CLI persistence. Preserve #41 cancellation handling and post-intent uncertainty. Open that implementation as its own PR against `dev`.

## Failure and recovery rules

- **A PR head changes during review:** Stop that candidate's merge, inspect the new delta and repeat affected validation. Other read-only reviews may continue.
- **A worktree contains unexpected edits:** Preserve it. Use a detached review checkout or coordinate ownership; never repair this by discarding files.
- **Conflict resolution fails tests:** Keep the candidate unmerged, compare the failing behavior with both parent versions and make the smallest repair. Do not weaken assertions to make the integration pass.
- **Hosted infrastructure fails before tests:** Report the producer error and keep the check incomplete. A justified retry is allowed after the cause is understood; it is not evidence that the source passed.
- **A merge commit fails CI:** Pause dependent merges and fix the concrete defect in a scoped PR against `dev`. Do not rewrite `dev` or production history.
- **Merge authorization is absent:** Deliver the fully reviewed, validated candidates and concrete merge order for approval. Continue other authorized read-only preparation; do not merge automatically.
- **Live target is unavailable:** This task can still complete offline. Do not make a fallback demonstration appear to be live acceptance.

## Execution record and definition of done

Execution through the committed PR #40 local candidate is recorded below. PR #40 itself is not yet published, reviewed on its final head, CI-verified, or merged, so the integration point remains in progress.

- [x] Current consumed baseline `aa90387244be07b9955b8b5b83eacf4b9f3058a1` recorded.
- [x] #37 reviewed, integrated as `480b252ab60edc77aff1bc37f6cd08ba9645f8d1`, and its passing merge producer recorded.
- [x] #39 repair `05f0647`, final head `64c9b11`, merge `fcd87f7fb8d573c8d44d43436310cce07baae06a`, 257 local tests, and passing head/merge producers recorded.
- [x] #41 repair `3aacfac`, final head `ec5f6a1ea421c7d4b5b345c4d83614eb513d3ec9`, merge `aa90387244be07b9955b8b5b83eacf4b9f3058a1`, 269 local tests, and passing head/merge producers recorded.
- [ ] #40 final candidate committed, independently reviewed, published, hosted-CI verified, and merged.
- [ ] Final post-#40 `dev` SHA, test count and hosted producer recorded.
- [x] Controller verified the protected primary and acceptance worktree dirty-file hashes and status unchanged; the unpromoted transfer evidence remains protected.
- [x] Live capability count remains `3/7`; assistant-ui remains deferred.
- [x] Task A handoff points to baseline `aa90387244be07b9955b8b5b83eacf4b9f3058a1` and a separate implementation PR. Valid pre-intent underfunding becomes `business_outcome / INSUFFICIENT_FUNDS`; malformed or wrong-account facts remain failures, and post-intent uncertainty remains `POST_OUTCOME_UNKNOWN`.

The individual point is complete only when all execution gates above are checked with evidence, or explicitly reported as blocked. Writing this plan or opening a PR does not itself complete integration.
