# MERIDIAN Conversation Storage Limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce durable, concurrency-safe per-subject conversation/event quotas and write rate limits, expose fixed 507/429 API behavior, and make the saved-conversation UI report failures truthfully.

**Architecture:** A metadata-only PostgreSQL quota row serializes every mutation for one subject before any conversation row lock. Store transactions resolve exact retries before capacity/rate accounting and update bucket/counters with the data mutation. Express maps typed failures to fixed responses; the saved-conversation adapter shows an unsaved state and never retries automatically.

**Tech Stack:** Node 22, TypeScript/Express/Zod, PostgreSQL 14+, pg, React/assistant-ui, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-09-08-conversation-storage-limits-design.md`

## Global Constraints

- Fixed limits: 128 conversation rows per subject including tombstones; 512 retained events per conversation; 4096 retained events per subject; token bucket burst 20 and refill 1 token/second.
- Fixed failures: capacity is HTTP 507 with `{"error":"Conversation quota exceeded"}`; rate is HTTP 429 with `{"error":"Conversation write rate limit exceeded"}` and `Retry-After: 1`. Capacity precedes rate.
- Every mutation locks the durable subject quota row before a conversation row. Exact create/append retries bypass capacity and rate consumption.
- Deletion frees event quota but retains conversation/tombstone quota. Tombstones never expire or resurrect.
- Preserve strict subject isolation, metadata-only persistence, journal/run authority, terminal unknown handling, and existing 400/404/409/503 behavior.
- Use real isolated PostgreSQL for required store/HTTP/concurrency tests. No skipped required DB suite and no synthetic test represented as deployed or live behavior.
- Preserve the saved-conversations owner's branch. Integrate only its independently reviewed exact commit, record that dependency, and do not edit its worktree.
- No `dev` merge, deployment, protected-demo restart, cloud spending, production database change, or live transaction.

### Task 1: Durable quota schema and transactional store enforcement

**Files:** Modify `src/server/conversations.sql`, `src/server/conversations.ts`, `test/conversation-store.test.ts`; modify `test/fixtures/postgres.ts` only if another isolated connection helper is required.

**Interfaces:**

```ts
export const CONVERSATION_LIMIT = 128;
export const CONVERSATION_EVENT_LIMIT = 512;
export const SUBJECT_EVENT_LIMIT = 4096;
export const WRITE_RATE_BURST = 20;
export const WRITE_RATE_REFILL_PER_SECOND = 1;

type LockedSubjectQuota = {
  conversationCount: number;
  eventCount: number;
  rateTokens: number;
  rateRefilledAt: string;
};
```

Quota helpers are private to the concrete store. `ConversationStore` keeps its public constructor and methods unchanged.

- [ ] **Step 1: Write migration RED tests.** Seed the pre-limit `meridian_conversations` and `meridian_conversation_events` schema/data before running the new migration. Include active, archived, deleted rows and events for two owners. Assert derived counts include tombstones, exclude deleted events because deletion already removed them, preserve all source rows, and preserve existing rate fields on a repeat migration. Seed an owner above each new bound and prove migration succeeds without trimming.
- [ ] **Step 2: Write capacity and deletion RED tests.** Seed valid boundary rows with SQL inside the isolated schema, run migration to reconcile counters, then exercise the boundary through store mutations; do not sleep or weaken the rate contract to manufacture hundreds of rows. Cover exactly 128 conversations, 512 events in one conversation, and 4096 events across a subject. The next distinct create/append must reject with status 507 and message `Conversation quota exceeded`. An exact create/append retry at the limit must return the original success. Delete must release exactly its retained event count, keep conversation count at 128, block ID resurrection, and permit a new event once subject event headroom exists. Tests may set only metadata-table bucket state through their isolated SQL fixture between scenarios; no production clock/rate override.
- [ ] **Step 3: Write rate RED tests.** Consume exactly 20 successful mutations, assert the next is status 429/message `Conversation write rate limit exceeded`, reopen the pool/store and prove exhaustion persists, then wait using PostgreSQL-observed time until one token refills. Exact retries at zero tokens must succeed without changing the bucket. Capacity exhaustion at zero tokens must return 507. Do not add a production clock override.
- [ ] **Step 4: Write concurrency and isolation RED tests.** Use separate PostgreSQL clients/pools for same-subject different-ID creates, same-ID create retries, same-conversation same-event append retries, different-event append races, mixed append/delete, and conflicting globally unique IDs. Assert stored rows and quota counts agree after every race and failed transactions leak no token/count. Hold one subject's quota-row lock and prove another subject can mutate independently without seeing its counts or failure reason.
- [ ] **Step 5: Run RED:** `TEST_DATABASE_URL=postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql npm test -- test/conversation-store.test.ts`; retain representative missing-table/unbounded behavior in the task report.
- [ ] **Step 6: Implement the additive migration.** Add only `meridian_conversation_subject_quotas` with owner UUID, nonnegative conversation/event counts, `double precision` tokens constrained to 0..20, and refill timestamp. Reconcile counts from existing rows inside the current advisory-lock migration transaction while leaving rate fields unchanged on conflict. Do not add expiry, payload, token, role, JSON, or foreign-owner metadata.
- [ ] **Step 7: Implement the quota-row-first transaction protocol.** Ensure and `FOR UPDATE` the owner quota row before any mutable conversation-row lock. Resolve exact retries, then capacity, then refill/consume rate using `clock_timestamp()`, then apply the mutation and counter delta. Archive changes no count; delete subtracts deleted events and retains conversation count. Translate only expected quota/conflict errors; let unexpected database failures use the existing sanitized path.
- [ ] **Step 8: Run GREEN and self-review:** rerun the focused store suite at least twice for concurrency stability; inspect raw tables/counters after test cases; run `npm run typecheck:backend` and `git diff --check`. Commit only Task 1 files and write exact command/result evidence to the task report.

### Task 2: Fixed HTTP responses and real application integration

**Files:** Modify `src/runtime/journal.ts`, `src/server/http.ts`, `src/server/conversation-http.ts`, `test/conversation-http.test.ts`, `test/conversation-http-postgres.test.ts`, and `docs/meridian/conversations.md`.

**Interfaces:**

```ts
export class RequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly headers?: Readonly<Record<string, string>>,
  ) { super(message); }
}
```

Only safe, server-authored header names/values may be emitted. Rate failures carry `{ 'Retry-After': '1' }`; capacity failures carry no special header.

- [ ] **Step 1: Write HTTP RED tests against a real app and isolated PostgreSQL.** Drive authenticated subject requests through `createApp`, not direct store calls. Reach create capacity, per-conversation event capacity, subject event capacity, and rate exhaustion; assert exact status/body/header contracts and capacity-before-rate precedence. Assert 429/507 do not expose counts, UUID ownership, SQL, or canaries. Keep distinct 409 linked-projection behavior and 503 storage-unavailable behavior.
- [ ] **Step 2: Write retry/rollback HTTP RED tests.** At exhausted rate/capacity, repeat the exact create and append body and assert the original success with no extra event/counter/token. Trigger a deterministic rolled-back write through ordinary conflicting input or an isolated test-only database constraint/trigger, then prove the next valid request sees unchanged quota/rate. No production fault-injection hook.
- [ ] **Step 3: Run RED:** `TEST_DATABASE_URL=postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql npm test -- test/conversation-http.test.ts test/conversation-http-postgres.test.ts`.
- [ ] **Step 4: Implement safe response headers and fixed failures.** Extend the typed error path minimally and have Express apply only its server-authored header map before the existing JSON error response. Store quota errors must surface the exact 507/429 messages; 429 sets exactly `Retry-After: 1`. Do not add an automatic retry at any server or client layer.
- [ ] **Step 5: Update the public contract documentation.** Document all fixed limits, tombstone behavior, rate semantics, exact retry bypass, responses, migration compatibility, and operational rollback rule: after quota-aware writes begin, do not run an older writer; disable conversation writes during rollback while keeping the additive table. State that deleting a conversation does not restore its conversation-row quota.
- [ ] **Step 6: Run GREEN and self-review:** run both focused HTTP suites and the store suite on real PostgreSQL, `npm run typecheck:backend`, `npm run test:smoke`, and `git diff --check`. Commit Task 2 files and report exact results.

### Task 3: Integrate the reviewed saved-conversation UI and truthful failure states

**Dependency:** The saved-conversations owner must first provide an independently reviewed exact commit. Record that SHA in the ledger and integrate that commit into this worktree without editing the owner's worktree. Resolve conflicts here.

**Files:** Modify the integrated `src/server/ui/conversations.tsx` and `test/conversation-ui.test.ts`; create `test/conversation-ui-postgres.test.ts` only if the real HTTP seam cannot be covered cleanly in the existing PostgreSQL integration file; modify UI status styling only when needed for an already-supported state.

**Interfaces:**

```ts
export type ConversationSaveStatus =
  | 'loading' | 'saving' | 'saved' | 'unavailable'
  | 'capacity' | 'rate-limited' | 'conflict' | 'unsaved';
```

The exact enum shape may adapt to the reviewed owner interface, but capacity and rate-limited must remain distinguishable from 503 and 409 in state and rendered text.

- [ ] **Step 1: Record and integrate the owner handoff.** Confirm the exact reviewed owner head and its focused/full test evidence. Merge or cherry-pick that exact commit range into this branch, record the dependency and conflict resolutions, and run its unchanged focused UI suite before changing behavior.
- [ ] **Step 2: Write UI RED tests.** For 507, assert a capacity-specific unsaved state/text that does not promise deletion restores conversation capacity. For 429, assert a temporary rate-limited unsaved state/text. In both cases assert exactly one POST, no timer/retry/backoff, frozen request body/UUID retained for a later user-initiated exact retry, and no saved-success marker.
- [ ] **Step 3: Add a real PostgreSQL seam.** Start the real app/store on an isolated schema, exhaust capacity and rate through actual authenticated requests, pass the resulting responses through the conversation adapter, and assert the same truthful state/text and single attempted UI request. This proves the adapter against real server behavior without treating it as deployed or live acceptance.
- [ ] **Step 4: Implement the minimal adapter mapping.** Parse status only; do not reflect server error text, counts, owner identifiers, or SQL. Preserve 409 reconciliation and 503 unavailable behavior. Do not introduce automatic retry. Ensure a manual retry uses the already frozen exact body.
- [ ] **Step 5: Run GREEN and self-review:** run the saved-conversation UI suite, real PostgreSQL UI/HTTP suite, `npm run typecheck:ui`, `npm run test:smoke`, and `git diff --check`. Commit Task 3 files and report the integrated owner SHA plus exact results.

### Task 4: Migration/release compatibility and branch-wide evidence

**Files:** Modify only tests or `docs/meridian/conversations.md` for gaps found by verification; create no deployment files.

- [ ] **Step 1: Recreate upgrade compatibility end to end.** Initialize the prior schema and representative legacy data at the branch's starting commit shape, run the new migration twice, reopen with a fresh pool/store, and exercise read, exact retry, create, append, archive, delete, and subject isolation. Confirm no source rows or tombstones were lost.
- [ ] **Step 2: Run release gates on the exact candidate:** `TEST_DATABASE_URL=postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql npm run ci`; `npm run validate`; `npm run typecheck:ui`; `git diff --check`. Repeat any concurrency-focused suite once. Record checkout, commit, database/schema isolation, commands, counts, and failures verbatim.
- [ ] **Step 3: Inspect the final diff for scope/privacy.** Verify the quota table is metadata-only, no tombstone cleanup exists, every mutation follows quota-row-first ordering, no client auto-retry exists, and no unrelated review finding or live/deploy action entered the branch.
- [ ] **Step 4: Commit any evidence-only fixes and report.** The controller obtains a broad independent whole-branch review, fixes reviewed blockers through the SDD loop, pushes only the scoped feature branch, opens a PR against `dev`, and verifies hosted checks at the exact PR head. Do not merge it.
