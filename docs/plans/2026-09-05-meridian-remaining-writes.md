# MERIDIAN Remaining Write Capabilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise verified live capability coverage from 3/7 to 7/7 by completing funds transfer, open share, member contact update and supervisor hold, each with a genuine recording and separately approved replay.

**Architecture:** Extend the existing guarded browser, canonical contracts, discovery/replay completion checks and authenticated journal. Keep operation-specific comparisons small; use the actual target's observed forms and result structure. Reuse the existing API/operator controls, and integrate the existing assistant-ui work only after capability acceptance.

**Tech Stack:** Node 22, TypeScript, Playwright, Express, Zod and Vitest with existing dependencies. Vercel AI SDK and assistant-ui belong to the final UI integration task.

**Spec:** [Replacement design](2026-09-03-meridian-adaptation.md), [original execution plan, Tasks 5c–9](2026-09-04-meridian-superpowers.md), [target-application supplement](2026-09-04-meridian-target-application.md), and [current requirement matrix](../meridian/implementation-progress.md). This document supplies the forward execution sequence for the four remaining capabilities; it does not reopen completed runtime work or supersede assignment requirements.

## Global constraints

- “All seven required functions must work, including approved posting.”
- “No automatic privilege upgrade or mid-flow login recovery.”
- “Use validated decimal strings for money and integer cents for comparisons.”
- “Continue loading version 1 artifacts unchanged.”
- “Durably record mutation dispatch intent immediately before the final submit.”
- “Never resume their browser actions automatically.”
- “Evidence protection is required before live recording.”
- “An unfinished function or failed safety gate remains explicitly incomplete; it is not replaced by a mock and counted as delivered.”
- One process, one active run, one visible fresh browser and the existing filesystem journal. Preserve caller/operator separation and server-bound credentials.
- Each major capability has a separate PR targeting `dev`. Production `master` (called main by the user) is untouched. Preserve dirty primary and acceptance worktrees.
- Selection, recording, artifact promotion and live posting are separate decisions. Discovery and replay are separately chosen operations with separate live approvals. Do not type a human approval on the user's behalf.
- Any uncertain post remains terminal `POST_OUTCOME_UNKNOWN`; no new key, retry, repair or rewritten history may hide it. A transport retry of the same invocation retains its key.
- Never invent a selector, recorded step, output, confirmation or provenance. Never post solely to discover an unknown result layout. Labeled recorded/mock fallback is permitted for demonstration but adds no live acceptance.
- Assistant-ui integration comes last. Reuse the existing local implementation; obtain UI direction before changing its visual/interaction scope.

## Verified starting point — September 5, 2026

Checked `origin/dev` at `217aadb434423f41e7fcddec71d0131f2ca2900e` (PR #56 merge). Runtime repairs through PR #54 and documentation corrections through #56 are integrated. GitHub returned **no open PRs** during planning; refresh this at execution rather than assume no new work exists.

Runtime checkpoint: 395 tests/17 files and typecheck passed; PR #56 merge workflow `33962737050`, producer `101297354120`, passed. UI source `c89f3d4` has separately reported local 418 tests/19 files and build/typechecks; it is unpublished and not part of this dev baseline. Neither test count proves a live write.

| Capability | Existing implementation | Missing delivery |
| --- | --- | --- |
| Funds transfer | Eligibility, request/review matching, dispatch recheck and output comparators; historical successful discovery/draft | Observed usable result mapping, new complete candidate, promotion and approved replay |
| Open share | Canonical inputs/output names, native form classification, approval/journal machinery | Bound operation checks, new-share result verification, artifact and discovery/replay |
| Update member | Canonical inputs/output name, direct-save classification and approval/journal machinery | Exact contact review/read-back checks, artifact, abort proof and discovery/replay |
| Place hold | Canonical inputs/output name, supervisor form rule and approval/journal machinery | Exact share/reason/notes checks, natural teller denial, artifact and supervisor discovery/replay |

Historical transfer draft and its run remain unchanged. Open-share run `222ebecd-ca02-4960-a875-c2f2f76e0927` remains frozen and unknown. Latest read-only transfer diagnosis found one selected share was no longer OPEN; the old pair cannot be assumed eligible.

## Execution status — September 5, 2026

Receipt extraction and observation-bound work from PRs #59 and #60 are merged; PRs #61 (open share) and #62 (member update) are now merged. PR #63 (supervisor hold and shared fresh transfer eligibility) merged to `dev` at `b3c838b` from reviewed head `32e29f8`, with 545 offline tests and passing head CI. Maintenance recovery is integrated in this change with 557 offline tests, typecheck and artifact validation passing. The user authorized live browser preparation again after the Mac-control interruption. Collect operation inputs and retain a separate human approval for each final posting; prefer headless preparation to avoid taking desktop control. Live acceptance remains 3/7; genuine recordings/replays and the UI-last delivery remain outstanding.

## Delivery sequence and file ownership

| Order / separate PR | Branch | Exit gate |
| --- | --- | --- |
| 1. Funds transfer | `codex/meridian-transfer-completion` | CAP-04 accepted; 4/7 |
| 2. Open share | `codex/meridian-open-share-completion` | CAP-05 accepted; 5/7 |
| 3. Member update | `codex/meridian-update-completion` | CAP-06 accepted; 6/7 |
| 4. Supervisor hold | `codex/meridian-hold-completion` | CAP-07 accepted; 7/7 |
| 5. Remaining acceptance and delivery | `codex/meridian-final-acceptance` | Missing exception/API/rehearsal gates closed or explicitly unresolved |
| 6. Final assistant-ui integration | Existing sibling branch, refreshed from `dev` | Reviewed UI PR, hosted checks and integrated acceptance |

These are branch names, not existing PRs. Start each from updated `origin/dev` after its predecessor lands; do not switch protected dirty checkouts. If a listed branch now exists, inspect and continue its work instead of overwriting it. Keep incomplete artifact work in a draft PR. If an observation-driven runtime repair must land first, split that repair into a small prerequisite PR to `dev`; do not merge an unaccepted artifact to unblock runtime work.

**Shared source ownership, only when a capability needs a change:**

- `src/runtime/contracts.ts`: canonical input/output declarations and pure request/result comparisons.
- `src/runtime/run.ts`, `src/surface/guarded.ts`: bind the capability's selected facts to its current member/frame/navigation and gate the actual operation before approval and again before dispatch.
- `src/surface/browser.ts`, `src/runtime/profile.ts`, `src/surface/types.ts`: only the minimal observed form/result read support required by a concrete mapping gap.
- `cli.ts`, `src/agent/loop.ts`, `src/replay/executor.ts`: invoke the capability comparator before success in both discovery and replay, including completion-failure classification.
- `test/meridian.test.ts`, `test/meridian-cli.test.ts`, `test/runtime-lifecycle.test.ts`: focused semantic, caller-wiring and result/lifecycle regressions. `test/locator.test.ts` only for an extractor/locator change.
- `test/meridian-artifacts.test.ts`: add a capability only with its genuine candidate; retain the approved-status requirement.
- Each task owns its one `artifacts/meridian-*.v1.0.0.json`, sanitized evidence directory, and relevant rows in `docs/meridian/{implementation-progress,live-evidence}.md`.

No new runner, service, dependency, generic validator registry, assertion language or browser pool is planned.

## Common implementation and acceptance procedure

Apply this checklist within each capability PR. Offline work may proceed while live inputs are pending, using synthetic facts and accurately labeled fixtures. Keep live sessions sequential.

- [ ] Refresh `origin/dev`, open PRs and applicable instructions. Trace callers with `rg -n 'createRuntime|runDiscovery|runReplay|validateCompletion|applyMeridianContract' cli.ts src test`; reuse merged repairs.
- [ ] Inspect retained evidence and read-only target observations. Record actual field names, native destination/control, review association, result fields, header shape and member/frame binding. Do not print secrets or copy raw private evidence to GitHub.
- [ ] Require an observation-backed result mapping before claiming the operation is ready to record. If unavailable, identify the exact missing field/relationship and stop that live sequence. Continue independent offline work; a fixture demonstrates validator behavior only.
- [ ] Add one passing control and the concrete negative cases in the task below to the existing tests; run the focused test red, implement the smallest shared fix, then run it green. Do not fabricate a red result for existing passing behavior.
- [ ] Bind native form facts and visible approval facts to the selected request before showing approval. Reinspect after approval and immediately before dispatch. Reject wrong member/frame, changed facts, wrong operation destination, missing/changed token, invalid role and unarmed direct browser submission with zero mutation dispatches.
- [ ] Run the same capability-specific completion comparison on actual extracted outputs and fresh observed state before discovery or replay reports success. Never construct an observed result by copying input parameters. A positive success label alone cannot pass.
- [x] For open-share/update/hold, reuse discovery's existing `validateCompletion` hook and replay's final-output validation location. If verified read-back needs asynchronous I/O, explicitly widen the callback to `void | Promise<void>`, await it in every success path, and add a delayed-rejection regression in both callers. Canonical write execution must fail closed if its required completion check is absent. Keep transfer's existing comparator active. Any new read support must use guarded, allowlisted read actions with evidence; no hidden target HTTP API.
- [ ] Before recording, review the exact candidate runtime diff and run the local gates below. Do not record against a known-broken comparator and try to repair provenance afterward.
- [ ] Obtain the selected new operation's inputs. Save its request identity privately. Record through the real discovery path; the human approves current facts at the terminal/operator boundary. Direct browser final-submit clicks are not the supported approval path.
- [ ] Require genuine post-action checkpoints and extraction in the recorded trace. Review schema, executable parameter/server bindings, provenance, irreversible classification, native control/token behavior and sensitive output metadata. Do not backfill steps into an old recording.
- [ ] Promote only after review has no unresolved Important/Critical finding. Promotion does not post. Execute a separately selected replay through the authenticated API/operator workflow, with model configuration disabled for deterministic replay, a separate key and a separate human approval.
- [ ] Independently read resulting state, authenticate the journal and evaluate both runs. Record source SHA, artifact hash/version, discovery/replay IDs, terminal status, mutation intent count, independently observed native POST count and verified state. Distinguish sign-on/review POSTs from final mutation POSTs.
- [ ] Resubmit the exact same successful replay invocation/key once through the API. It must return the original run and cause zero additional browser launches or POSTs. This verifies request dedupe, not permission for another transaction.
- [ ] Sanitize evidence, update the capability's acceptance row, run focused/full gates, and review the exact PR head before integration. After merge, verify the resulting `dev` SHA and its CI separately.

Commands used within each PR:

```sh
npx vitest run test/meridian.test.ts test/meridian-cli.test.ts test/runtime-lifecycle.test.ts
npm run ci
npm run validate
git diff --check
```

Use the existing [runbook](../meridian/runbook.md#discovery-commands) for complete CLI discovery templates and private input variables; its templates are not default operation selections. For an actual returned run ID, evaluate with the existing private configuration:

```sh
node --env-file=.env --import tsx scripts/evaluate-run.ts "$EVIDENCE_DIR" "$RUN_ID"
```

## Task 1 — Complete funds transfer (CAP-04 / original Tasks 5c–5d)

**Files:** Create `artifacts/meridian-funds-transfer.v1.0.0.json` from a genuine new discovery. Modify `test/meridian-artifacts.test.ts` and `docs/meridian/{live-evidence,implementation-progress}.md`; save sanitized evidence under `docs/meridian/evidence/funds-transfer/`. Change shared source/tests above only if actual result mapping proves a gap.

**Interfaces:** Keep inputs `{member, sourceShare, destinationShare, amount, memo}` and current outputs `confirmation` plus `transaction: Array<Record<string, string>>`. Existing `assertTransferEligibility`, `assertTransferFacts` and `assertTransferOutputs` remain authoritative. The canonical transaction row has member/sourceShare/destinationShare/amount/memo/confirmation; this is an internal output design, not a claim about the target's physical table.

- [ ] Inspect retained result evidence for exact label/value and confirmation relationships. Verify whether existing `Surface.readTable` can produce the canonical row; it reads descendants per row and does not join unrelated rows. If unsupported, prepare only an observation-backed extractor/contract repair and review it before a recording promise.
- [ ] For an extractor change, add actual sanitized layout fixtures proving a legacy `td` header is excluded and a headerless first data row is preserved. Exercise blank/missing/duplicate values and confirmation mismatch; none may become a valid transaction.
- [ ] Request a new eligible source/destination choice. The prior selection is retained only in the private operator worksheet; one selected share was not OPEN. Refresh exact member rows, select distinct OPEN shares and check current source funds. Do not choose a replacement pair silently.
- [ ] Retain the existing semantic test controls, including this failure case; add only missing regression coverage for the observed repair:

```ts
const request = { member: '9001', sourceShare: '9001-A', destinationShare: '9001-B', amount: '1.00', memo: 'fixture' };
expect(() => assertTransferEligibility(request, '9001', [
  { share: '9001-A', status: 'CLOSED', balance: '2.00' },
  { share: '9001-B', status: 'OPEN', balance: '0.00' },
])).toThrow();
```

- [ ] Run the common recording/review/promotion procedure, preserving original discovery `a06406ce-c425-4cfb-bb61-4e23b73f8845` and its draft unchanged.
- [ ] Perform the separately chosen and approved replay. Verify confirmation/output binding and independent source/destination balance effects using integer cents. Unexplained concurrent changes or missing result identity prevent acceptance; do not guess success from aggregate balances.
- [ ] Add `meridian-funds-transfer` to the artifact catalog test and run `npx vitest run test/meridian-artifacts.test.ts -t meridian-funds-transfer`. Publish/merge only after both live operations and exact-head gates are accepted. Coverage becomes **4/7**.

## Task 2 — Implement open share (CAP-05 / original Task 6)

**Files:** Create `artifacts/meridian-open-share.v1.0.0.json`; modify shared contract/guard/completion paths and their focused tests as above; update catalog/evidence/matrix. Evidence directory: `docs/meridian/evidence/open-share/`.

**Interfaces:** Inputs `{member, shareType, deposit}`, with current shareType enum `S0001 | S0070 | MMKT | CERT` and positive decimal deposit. Public output remains `shareId`. Add these small pure comparator interfaces in `src/runtime/contracts.ts`; observation adapters must supply the actual values from the target:

```ts
export type OpenShareFacts = { member: string; shareType: string; deposit: string };
export type OpenShareResult = OpenShareFacts & { shareId: string };
export function assertOpenShareFacts(expected: OpenShareFacts, actual: OpenShareFacts): void;
export function assertOpenShareResult(expected: OpenShareFacts, priorShareIds: readonly string[], actual: OpenShareResult, outputs: Record<string, OutputValue>): void;
```

- [ ] Observe form/review and available result fields. Determine whether a separate confirmation exists and document present/absent with evidence. If present and required for binding, coordinate its observed output declaration/extract/comparator/catalog change in this PR; do not add it from assumption.
- [x] Capture the selected member's complete pre-operation share IDs, rejecting ambiguous/duplicate rows. Require exact member/type/deposit matches on native and visible review facts; compare deposit through `moneyCents` and require positivity.
- [x] Add a passing comparator control and a preexisting-ID rejection using synthetic values:

```ts
const request = { member: '9001', shareType: 'S0001', deposit: '5.00' };
const observed = { ...request, shareId: '9001-S0001-NEW' };
expect(() => assertOpenShareResult(request, ['9001-S0001-OLD'], observed, { shareId: observed.shareId })).not.toThrow();
expect(() => assertOpenShareResult(request, [observed.shareId], observed, { shareId: observed.shareId })).toThrow();
```

- [x] Reject wrong member/type/deposit, absent/empty/output-mismatched ID, preexisting ID, ambiguous new rows, and missing resulting-state facts. Run actual guard and discovery/replay regressions: changed review facts mean no approval/intent; stale post-result means no success and terminal unknown after one dispatch, without recovery.
- [x] Implement completion wiring before live recording, including a fresh observation that the extracted ID is new for this exact member and matches the selected type/deposit.
- [ ] Establish the observed deposit/balance relationship before live recording; do not treat the offline comparator as evidence that the target exposes the required relationship.
- [ ] Ask the user to select a genuinely new opening operation, then follow the common acceptance procedure. Explicitly preserve the historical unknown opening. The separate replay requires a separately selected new opening; do not create another share merely to fill a checkbox.
- [ ] Add `meridian-open-share` to the artifact test and run its focused case. Accepted discovery/replay plus all PR gates raise coverage to **5/7**.

## Task 3 — Implement member contact update (CAP-06 / original Task 7)

**Files:** Create `artifacts/meridian-update-member.v1.0.0.json`; modify shared contract/guard/completion paths and focused tests as necessary; update catalog/evidence/matrix. Evidence directory: `docs/meridian/evidence/update-member/`.

**Interfaces:** Inputs `{member, email, phone, address}`, public output `saved`. Add `MemberUpdateFacts` and `assertMemberUpdateFacts(expected, actual)` in `src/runtime/contracts.ts`:

```ts
export type MemberUpdateFacts = { member: string; email: string; phone: string; address: string };
export function assertMemberUpdateFacts(expected: MemberUpdateFacts, actual: MemberUpdateFacts): void;
```

- [x] Observe direct Save Changes form and the available fresh read-back path. There is no assumed target review page: build the existing operator approval facts from the actual filled form, including all three contact fields and the member.
- [x] Before approval and dispatch, compare every observed field and member exactly. Any target normalization must be observed and explicitly tested; do not loosen comparison through arbitrary trimming/coercion.
- [x] Add a passing exact comparison and field mutations:

```ts
const request = { member: '9001', email: 'demo@example.test', phone: '5550100', address: '1 Test Road' };
expect(() => assertMemberUpdateFacts(request, { ...request })).not.toThrow();
for (const field of ['member', 'email', 'phone', 'address'] as const) {
  expect(() => assertMemberUpdateFacts(request, { ...request, [field]: 'different' })).toThrow();
}
```

- [x] Implement discovery/replay completion checks requiring a fresh read of the same member with all selected values. Keep `saved` extract-backed and consistent with its observed declaration; a generic message or truthy string cannot replace read-back. Test old/other-member values and completion-read failure after dispatch: unknown, no success/retry.
- [ ] Obtain selected synthetic member/contact values. First run a separate abort case at the real approval boundary and prove zero Save POSTs; this is not approval for the successful run.
- [ ] Record an approved update, review/promote, and replay a separately selected update through the API/operator workflow. Verify persistence independently for each, plus exact-key dedupe. Do not restore prior values without selecting and approving that separate operation.
- [ ] Add `meridian-update-member` to the artifact test, run the focused case and all PR gates. Accepted discovery/replay raise coverage to **6/7**.

## Task 4 — Implement supervisor hold (CAP-07 / original Task 8)

**Files:** Create `artifacts/meridian-place-hold.v1.0.0.json`; modify shared contract/guard/completion paths and focused tests; update catalog/evidence/matrix. Evidence directory: `docs/meridian/evidence/place-hold/`. Retain `config/app-profiles/meridian.json`'s supervisor rule.

**Interfaces:** Inputs `{member, share, reason, notes}`, current reason enum `FRAUD | LEGAL | DECEASED`, public output `heldShare`. Proposed pure comparisons in `src/runtime/contracts.ts`:

```ts
export type HoldFacts = { member: string; share: string; reason: string; notes: string };
export type HoldResult = { member: string; share: string; status: string };
export function assertHoldFacts(expected: HoldFacts, actual: HoldFacts, role: 'TELLER' | 'SUPERVISOR'): void;
export function assertHoldResult(expected: HoldFacts, actual: HoldResult, outputs: Record<string, OutputValue>): void;
```

- [ ] Observe the current selected share, native/visible review, and fresh HOLD read path. Document whether a separate confirmation/reason relationship exists. Bind it when exposed through coordinated contract/extraction changes; do not invent a receipt.
- [x] Require supervisor context from the authenticated server operator, exact member/share/reason/notes, and current share eligibility. Bind the target share before approval and recheck after approval. Caller/chat may not supply or obtain supervisor credentials.
- [x] Add controls and negative cases:

```ts
const request = { member: '9001', share: '9001-S0001-1', reason: 'FRAUD', notes: 'fixture' };
expect(() => assertHoldFacts(request, { ...request }, 'SUPERVISOR')).not.toThrow();
expect(() => assertHoldFacts(request, { ...request }, 'TELLER')).toThrow();
expect(() => assertHoldResult(request, { member: '9001', share: '9001-S0001-1', status: 'HOLD' }, { heldShare: request.share })).not.toThrow();
expect(() => assertHoldResult(request, { member: '9001', share: '9001-S0001-2', status: 'HOLD' }, { heldShare: request.share })).toThrow();
```

- [x] Exercise wrong member/share/reason/notes, changed/expired role, unrelated operation destination and stale/other-share result in real guard and both completion paths. Pre-intent refusal dispatches zero times; post-intent result failure preserves unknown after one dispatch.
- [ ] Demonstrate a natural teller denial through the supported guarded path. Record the actual refusal and zero mutation; a static warning is insufficient. Do not weaken the guard to force a server POST, switch that run to supervisor or replay its failed mutation.
- [ ] Obtain separately chosen eligible shares/hold facts for supervisor discovery and replay. Complete each through its own approval and verify fresh HOLD state on its exact share. No arbitrary holds, automatic privilege upgrades or repeated hold on an already-held share for evidence.
- [ ] Add `meridian-place-hold` to the artifact test and run its focused case and all PR gates. Accepted discovery/replay raise capability coverage to **7/7**; final adaptation delivery still requires the next section.

## Final integration after the four capability PRs

- [ ] In the separate acceptance PR, reconcile every open requirement in the matrix. Complete missing discovery/replay exception cases using the existing fault mechanism and exact observed GET routes: validation, injected notfound/404, permission, timeout, maintenance and server. Native absent-member evidence closes only its native half, so EXC-03 remains open until injected discovery/replay is accepted.
- [ ] Verify natural underfunding and invalid contacts with honest pre-/post-intent classification. Retain existing natural bad-login evidence and bounded idle observation; a later CUA timeout was observed on a read, but authenticated runner acceptance remains unverified. Do not invent expiry evidence or repeat unchanged waits. Record unresolved target limitations explicitly.
- [x] Resolve the offline `RECOVERY_CHECKPOINT_REQUIRED` source gap with trusted same-browser checkpoint recovery, an observed checkpoint and a focused failure-path regression; genuine discovery/replay recovery acceptance remains pending.
- [ ] Run the integrated authenticated API/operator read-plus-transfer rehearsal and same-key dedupe. Reuse accepted operations/evidence where sufficient; do not create another post solely for a demo recording. Verify restart evidence retains terminal truth without action resumption.
- [ ] Refresh `docs/meridian/{runbook,report,evaluation,implementation-progress,live-evidence}.md`, `README.md` and `docs/README.md` only as needed for accurate commands, accepted coverage and labeled recorded/offline fallback. Keep the report to the assignment's 1–2 page scope. Run final source, artifact, hosted head and merge gates.
- [ ] Finally inspect the existing assistant-ui sibling changes against integrated `dev`. Ask for UI direction only where the user's intended layout/interaction scope is unresolved. Integrate in its own PR; preserve server-owned approval, caller isolation and unknown-state behavior, and verify browser/keyboard flow against accepted capabilities. Do not treat its old local 418-test result as proof for the new integrated SHA.

## User input schedule

| When needed | Direction needed |
| --- | --- |
| Before transfer recording | Replacement eligible OPEN pair; confirm selected amount/memo on current facts. Replay is a separately selected transfer. |
| Before open share | Member, allowed share type and positive deposit for each genuinely intended new opening. |
| Before contact update | Exact member/email/phone/address for discovery and the separately selected replay. |
| Before hold | Eligible share, reason and notes for each supervisor operation; configured supervisor authority. |
| At each final write | Human approval of current inspected facts. Existing expired approvals do not carry forward. |
| Final UI phase | Direction on any still-undecided visual/interaction scope; assistant-ui is already selected. |

These inputs are requested when the relevant implementation is reviewable, not as a bulk permission gate before offline work. No live operation is authorized merely by saving this plan.

## Self-review and handoff

- [x] All four remaining capabilities map to separate PRs, exact artifact IDs, shared source owners and live exit gates.
- [x] Current code and open PRs checked; completed transfer/runtime/evaluator repairs are reused.
- [x] Contract/result comparisons are defined as internal interfaces; no unobserved HTML selector or confirmation is asserted.
- [x] Completion wiring, callback absence/async failure, frame/fact changes, post-intent unknown and same-key dedupe are explicit.
- [x] Historical unknown operations, protected worktrees and genuine provenance remain preserved.
- [x] UI integration is last; 7/7 capabilities is distinguished from whole-plan delivery.

**Execution entry:** Task 1's retained-result feasibility audit and minimal offline gaps. Request replacement transfer selection only when a supported recording path is established. If no mapping can be established from available evidence, report that exact blocker and continue independently testable guard/comparator work without launching an unready live recording.
