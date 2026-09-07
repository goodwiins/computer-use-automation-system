# MERIDIAN UX delivery implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each major unit has a separate reviewed PR against dev; update this ledger with its real evidence.

**Goal:** Complete the authorized UI workflow using truthful capability states, readable results and approvals, actual role permissions, safe persistent conversations and accessible navigation.

**Architecture:** Preserve the Next static-export interface and Express authoritative API. Extend existing assistant-ui components and the shared run provider; approved artifacts, journal identities and decision endpoints remain authoritative. Backend owns subject authentication, PostgreSQL and workers; the demo task owns live capability acceptance.

**Tech Stack:** Node 22, Next.js 16.3.4, React 19.2.8, assistant-ui 0.15.18, AI SDK 7.0.93, Express, Vitest and Playwright. Use installed APIs and native browser controls before adding dependencies.

**Spec:** `/Users/goodwiinz/.codex/visualizations/2026/09/03/01a0698c-1872-7691-80f9-d8b796814750/meridian-ux-workflow-plan.md`, read in full. Persistence additionally consumes the backend's committed `docs/superpowers/specs/2026-09-07-conversations-design.md` at `a5900ce` in its isolated checkout.

## Global constraints

- User explicitly authorized final UI implementation and PR delivery; no further visual-scope or routine publication approval is needed.
- Keep `/Users/goodwiinz/.codex/worktrees/interface-ai-local-teller-login`, its running service, dirty edits and evidence unchanged while publishing.
- `dev` was `8950d772e515886800093ec79c44d5009bd16e67` at planning. Recheck before each branch. PR93 `c7bba9e` is separate, open and not presumed merged.
- Express remains the API. UI ownership does not include target mutations, approval execution, backend framework migration, cloud spend, worker scaling or capability recording.
- Source tests, offline fixtures and read cards do not prove missing transfer/update/hold live acceptance. The demo owner holds that gate.
- Exact personal posting approval, expiry, refusal, same-key reuse, stale-decision locking, owner-scoped evidence and terminal `POST_OUTCOME_UNKNOWN` remain intact.
- Dashboard API role, individual subject and target TELLER/SUPERVISOR execution role are distinct. No dropdown grants authority. Subject-mode operators have owner-only data until a real assignment grant exists.
- Persist only backend-authorized fixed safe events and run references. No raw messages, names, balances, contact data, credentials, approval facts or generated private titles.
- Existing chat request IDs remain stable printable keys; new persistence IDs are UUIDs. Restoring history never calls chat, invokes a runtime, upgrades authority or marks old member identity as fresh.
- Heavy local suites run serially. Each major unit gets focused checks, full repository CI, independent review, a scoped PR and exact-head hosted CI.

## Delivery ledger and dependencies

| Unit | Work / current state | Dependency / exact completion gate |
| --- | --- | --- |
| 0 | Published [PR95](https://github.com/goodwiins/computer-use-automation-system/pull/95), head `0914e1d` | Independent task/fix/final reviews clear; local 735 tests/typechecks/Next build and exact-head hosted CI 34082993000 passed; PR remains unmerged |
| 1 | Published [PR93](https://github.com/goodwiins/computer-use-automation-system/pull/93), privacy-fixed head `dcb048c` | Local 749 tests and hosted CI 34083144047 passed; independent final safety review clear. Earlier live read composition passed; privacy fix has not been applied to protected demo. PR remains unmerged |
| 2 | Implementation active in `codex/meridian-ui-readiness` | Plan `2026-09-07-ui-readiness.md`, base `4f9d81c` combines reviewed PR95 and PR93; B1 retains auth/store ownership |
| 3 | Exact-run review and readable approval facts: pending implementation | Unit 2 labels; existing decision API, one active review surface |
| 4 | Transfer/update/hold live acceptance: external demo/runtime gate | Genuine recording, approved artifact and separately approved replay; no UI simulation can close this |
| 5 | Honest role workspace and authorized review queue: pending implementation | Unit 3 review navigation; B1 subject contract for individual identity; cross-person grants unavailable |
| 6 | assistant-ui persistent conversation adapter: pending backend integration | B1 routes/store complete and tested; safe events only, no replay on restore |
| 7 | Responsive/accessibility and rehearsal: pending implementation | Completed UI behavior; live success/exception rehearsal by demo owner, writes only with separate authorization |

### Task 2: Capability readiness and plain-language results

**Files:** `src/server/service.ts` and `src/server/http.ts` for additive availability/completion metadata; `src/server/ui/session.tsx`, `src/server/ui/dashboard.tsx`, `src/server/ui/presentation.ts`; `test/chat-ui.test.ts` and a focused catalog/presentation test.

**Interfaces:** Keep `catalog()` and tool schemas unchanged. Add typed availability for the fixed public MERIDIAN capability set. An entry has `id`, `label`, `state` (`available`, `not_recorded`, `restricted`, `temporarily_unavailable`) and a safe reason. Access checks precede artifact existence checks; a restricted caller receives no hidden recording facts or foreign run IDs. Refresh displayed readiness through authenticated reads. Expose optional `finishedAt` from authoritative live completion for “Read completed at”; withheld historical time stays unavailable.

- [ ] Write boundary cases before the implementation: authorized missing recording differs from restricted access; arbitrary hidden artifacts never enter the public list; unknown quarantine disables fresh invocation without exposing another owner; unavailable metadata does not become “missing” by inference.

```ts
expect(availability.find(item => item.id === publicCapability)?.state).toBe('restricted');
expect(JSON.stringify(availability)).not.toContain(foreignRunId);
expect(availability.some(item => item.id === privateCapability)).toBe(false);
```

- [ ] Add `capabilityLabel(id: string): string`, `runPresentation(run: Run): {label: string; description: string}` and `formatMoney(value: string): string` in the UI presentation module. Fixed status mapping must distinguish running, recovering, awaiting review, submitting, completed, business outcome, interrupted and unknown. A generic failure cannot claim no posting without authoritative evidence. Keep unknown investigation-only copy.

```ts
expect(runPresentation(unknown).label).toBe('Unable to verify outcome');
expect(formatMoney('1200.10')).toBe('$1,200.10');
expect(formatMoney('90071992547409.91')).toBe('$90,071,992,547,409.91');
```

- [ ] Render readable share/field headings and money without floating-point rounding; preserve exact IDs/values in Details. Show actual read completion time and explicit unavailable identity/history states. Do not select the first member from an ambiguous result.
- [ ] Run focused tests and full CI, obtain independent review, commit and publish this unit. Update the delivery ledger with its actual head/PR and compatible backend metadata seam.

### Task 3: Exact-run review and readable approval summary

**Files:** `src/server/ui/session.tsx`, `src/server/ui/dashboard.tsx`, `src/server/ui/main.tsx`, new `src/server/ui/review.tsx`, `src/server/ui/style.css`; existing approval cases in `test/chat-ui.test.ts` and focused browser additions.

**Interfaces:** `useRuns()` adds current `reviewRunId`, `openReview(runId: string)` and `closeReview()`. A single native dialog mounted in `Workspace` resolves that exact ID from current authenticated runs. Chat/history links open this same surface; they do not create duplicate approval panels or execute a request. Session replacement clears the selected review.

- [ ] Write tests proving a chat “Review request” action opens exactly the bound run, caller sees no operator-only facts/decision controls, Escape restores focus, and changing sessions removes the dialog.

```ts
await page.getByRole('button', {name: 'Review request', exact: true}).click();
expect(await page.getByRole('dialog').getAttribute('data-run-id')).toBe(runId);
expect(decisions).toEqual([]);
```

- [ ] Reuse `EscalationCard`/`ApprovalPanel` inside that one dialog. Render public action facts as named fields: member, source/destination, amount/memo, share type/deposit, changed contact fields, or share/reason/notes. Preserve every provided review fact; unknown fields remain readable. Show actual action operator/branch/role and expiry. Technical method/destination/IDs go under Details; never expose filtered credential fields.
- [ ] Use action-specific confirmation labels and “Refuse request” for posting approval; manual recovery remains a separate bounded-retry/stop flow. Missing action context disables confirmation. Expiry, changed facts, stale updates and response loss remain locked to the current server intervention.

```ts
await page.getByRole('button', {name: 'Confirm transfer', exact: true}).dblclick();
expect(decisions).toEqual(['approve']);
expect(await page.getByRole('button', {name: 'Confirm transfer', exact: true}).isDisabled()).toBe(true);
```

- [ ] Run existing duplicate/expired/response-loss/unknown tests with the new review entry path plus full CI. Independent review and a separate PR complete this unit; no real decision is clicked by the implementation task.

### Task 5: Role contract and review-first workspace

**Files:** `src/server/ui/main.tsx`, `src/server/ui/dashboard.tsx`, `src/server/ui/session.tsx`, `src/server/ui/review.tsx`, UI styles/tests; consume backend auth metadata without implementing storage or grants.

**Interfaces:** `/capabilities.principal` remains `caller|operator`; optional `subjectId` identifies the authenticated owner. Target execution role is from the selected direct request or verified action context, never inferred from dashboard login. Unknown branch/target sign-on stays explicitly unavailable. Review queue derives from current authenticated runs, not a second decision cache.

- [ ] Write tests that an operator login still labels chat as teller execution, direct target role is explicit, absent target sign-on is not reported as authenticated, and subject-mode history contains no foreign-owner queue entries.
- [ ] Replace misleading “Supervisor” login authority copy with actual dashboard permission labels. Give authorized operators a review-first Activity filter, with separate needs-review and history views. Keep the originating run summary and exact review link visible.

```ts
expect(await page.getByText('Chat execution: Teller', {exact: true}).isVisible()).toBe(true);
expect(await page.getByText('Target session: Not verified', {exact: true}).isVisible()).toBe(true);
```

- [ ] Display a supported-access explanation when a caller needs an operator. A cross-person supervisor takeover remains unavailable without backend assignment/grant and live target proof; never relabel a fresh operation as a resumed run.
- [ ] Verify caller API rejection, operator owner scoping, keyboard filters and stale queue refresh. Publish a separate tested/reviewed PR; report the real grant/live-hold gates separately.

### Task 6: Safe assistant-ui persistent conversations

**Files:** `src/server/ui/chat.tsx`, `src/server/ui/transport.ts`, `src/server/ui/session.tsx`, `src/server/ui/main.tsx`, new `src/server/ui/conversations.tsx`, UI styles and focused conversation UI tests. Backend owns `auth.ts`, storage, routes and migrations.

**Interfaces:** Consume B1 `GET/POST /conversations`, metadata get/archive/delete with `expectedRevision`, and safe paginated `GET/POST /conversations/:id/events`. New IDs are UUIDs; events are only `message_omitted` or `run_linked`. Use installed `RemoteThreadListAdapter` and `ThreadHistoryAdapter.withFormat` with `useRemoteThreadListRuntime`; check installed types before coding. Do not copy the documentation's raw-message persistence example.

- [ ] Require subject authentication and enabled backend storage for saved navigation; legacy mode remains explicitly unsaved. Write tests for ownership, reload, archived history, conflicts, retries, loading/error states and no execution on restore.

```ts
const before = invocationCount;
await page.getByRole('button', {name: savedConversationLabel, exact: true}).click();
expect(invocationCount).toBe(before);
expect(serializedStoredEvents).not.toMatch(/PRIVATE_MEMBER|PRIVATE_BALANCE|PRIVATE_TOKEN/);
```

- [ ] Implement adapter requests using existing authenticated `request`, fixed safe titles and revision-aware archive/delete. Generate durable request/event IDs once per attempt; preserve them on uncertain retries. Reconcile 409 from the current server revision rather than silently overwriting newer state.
- [ ] Store only omission events and exact authorized run references; never `fmt.encode` raw content into storage. Restore fixed safe templates and safe run projection. Restored run cards cannot call `watch()` or fetch live PII automatically. Keep restored messages out of subsequent model payloads; preserve the current live request IDs and exact journal binding.
- [ ] Keep archive as the normal removal action. Explicit deletion affects only the backend conversation; UI never removes runs, journal or unknown safety state. Loading and switching threads cannot execute tools. On logout/subject change abort requests and clear all per-session caches.
- [ ] Verify with the real completed B1 API and offline browser fixtures, then full CI and independent review. Publish a separate integration PR with explicit backend/base dependencies. If B1 is not ready, complete other UI units and record the precise pending endpoint/version gate.

### Task 7: Responsive, accessible workflow and final rehearsal

**Files:** Existing UI components/styles/tests, `docs/meridian/ui-baseline.md`, a dated `docs/meridian/ui-walkthrough.md`; no target or runtime changes.

- [ ] Add a visible “Stop response” label and the explanation that the operation may continue. Keep authoritative run state visible after stream interruption; do not invent a cancel-run endpoint.
- [ ] Add “Back to conversation” in narrow Activity and restore originating focus/scroll. Retain an operation summary while reviewing. Use native focus trapping in the review dialog and keyboard-accessible filters/thread controls.
- [ ] Exercise 320/768/1024/1440 widths, 200% zoom, keyboard-only connect/request/review/refuse/evidence navigation, visible focus, status announcements without repeated UUID narration, readable errors and color-independent states.

```ts
expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
await page.keyboard.press('Escape');
expect(await reviewTrigger.evaluate(node => node === document.activeElement)).toBe(true);
```

- [ ] Preserve a clearly labeled offline walkthrough for pending approval/exception states. Ask the demo owner to verify the final read success and exception on the reviewed build. Any missing transfer/update/hold pair or real supervisor handoff remains an explicit live gate, not a mocked completion claim.
- [ ] Publish the accessibility/rehearsal PR with actual test counts, exact-head CI and dated source/build/artifact manifest. Report each unit as implemented/published/live-verified/pending with its own evidence, without collapsing those assurance levels.

## Coordination and completion

Backend task: `01a07981-74d9-79f2-a08c-88fcf228c67d`; demo/acceptance task: `01a0698c-1872-7691-80f9-d8b796814750`.

After each major unit, send both owners its actual PR title, URL/head, contract changes and test evidence. Do not wait on an external live gate when an independent UI unit can proceed. A final report must distinguish all delivered UI work from external runtime acceptance, assignments/grants, infrastructure and any backend-dependent item still awaiting a concrete contract.
