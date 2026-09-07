# Authoritative Runs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make PostgreSQL authoritative for migrated runs without changing single-worker or exact-approval safety.

**Architecture:** Two actual journal implementations share an awaitable contract. PostgreSQL constraints and a durable exclusive owner serialize writes; a one-way filesystem fence protects migration. Service and CLI await storage, and the browser revalidates after intent commits.

**Tech Stack:** Node22, TypeScript, installed pg8.23.0, PostgreSQL14+, existing Vitest/Chromium fixtures.

**Spec:** `docs/superpowers/specs/2026-09-07-authoritative-runs.md`

## Global Constraints

- One worker; no automatic owner takeover or retry after uncertain intent/commit.
- Preserve exact HMAC identities, terminal unknown, alias conflicts, subject ownership and capability-wide unknown quarantine.
- Store safe journal metadata only; no raw inputs, target values, approval facts, credentials or model text.
- Reuse installed pg and existing test fixtures. Do not add dependencies or speculative worker abstractions.
- No production merge, deployment, cloud spend or live target action. Live acceptance remains 4/7.
- Preserve UI-owner availability/finishedAt work; source scope is backend plus necessary caller adaptations.
- Each task leaves focused runnable regression coverage, reports its RED/GREEN evidence and commits only its owned source/tests/docs. Never commit `.superpowers/sdd` artifacts.

---

### Task 1: Await durable intent and revalidate the prepared control

**Files:** Modify `src/runtime/run.ts`, `src/surface/guarded.ts`, and relevant cases in `test/meridian.test.ts` / `test/runtime-lifecycle.test.ts` only.

**Interfaces:** Produce `beforeDispatch?: (context: ActionContext) => void | Promise<void>` in runtime options and equivalent required callback on the guarded runtime. `createRuntime` must return/await the callback promise. Preserve existing synchronous callers.

- [ ] Add a deferred-promise regression using the existing guarded fixture. Start an approved click; wait until the hook is entered; assert native dispatch count zero; resolve the hook and assert exactly one dispatch. Add rejection and page/role/facts change while pending, automation/expiry invalidation, plus a real local browser fixture POST-count check. Reuse existing fixture builders and deferred promises rather than new infrastructure.

```ts
let release!: () => void;
const durable = new Promise<void>(resolve => { release = resolve; });
// Supply beforeDispatch: () => durable to the existing guarded fixture.
// Await hook entry before asserting dispatch has not occurred.
release();
// Unchanged approved state dispatches once; changed state or rejected durable rejects with zero POSTs.
```

- [ ] Run `npx vitest run test/meridian.test.ts -t 'durable intent await'` before implementation and record the expected failure. Use that phrase in new regression names.
- [ ] Change both callback types, return the callback promise from the runtime wrapper, and await it in the guarded mutation path. Extract the existing post-approval live inspection/review/eligibility checks into one local async closure called before and after storage. The closure asserts automation/deadline, exact snapshot equality, applicable operation/authority/review checks and transfer/hold eligibility with a final inspection. Do not emit mutation intent or set `mutationDispatched` until storage and validation succeed. Do not change native dispatch arguments or retry behavior.

```ts
await revalidateApprovedControl();
await this.runtime.beforeDispatch(context);
await revalidateApprovedControl();
this.assertAutomation();
```

- [ ] Run the focused new cases, ensure `npm run build` has produced `out/index.html`, then run `npx vitest run test/meridian.test.ts test/runtime-lifecycle.test.ts` and `npm run typecheck`. Coordinate the browser-heavy run with controller first. Commit `fix: await durable intent before revalidating dispatch` and report exact counts/output. Full combined CI runs at final integration, not after every task.

### Task 2: Concrete PostgreSQL journal and shared contract

**Files:** Modify `src/runtime/journal.ts`; create `src/runtime/postgres-journal.ts`, `src/runtime/journal.sql`, `test/postgres-journal.test.ts`. Reuse `test/fixtures/postgres.ts` unchanged.

**Interfaces:** Export `RequestAlias`, `JournalSnapshot = { records: JournalRecord[]; aliases: RequestAlias[] }`, and `journalDigest(key: string, value: unknown): string` from journal.ts using its unchanged canonical HMAC. Export a `RunJournal` contract whose methods are sync-or-Promise: `get(runId): JournalRecord|undefined`, `list(): JournalRecord[]`, `hasUnknown(capability): boolean`, existing `lookup`, `findRequest`, `reserve`, `bindReference`, `update`, `close`. Use `Awaitable<T> = T | Promise<T>`. Existing `Journal` implements this with small access methods; keep its records Map for legacy tests/evaluator callers.

Produce `PostgresJournal` implementing that contract. Static methods: `migrate(pool: Pool): Promise<void>`, `importSnapshot(pool: Pool, key: string, snapshot: JournalSnapshot, importId: string, digest: string, initialize = true): Promise<void>`, `open(pool: Pool, key: string, importId: string, digest: string): Promise<PostgresJournal>`, `recover(pool: Pool, ownerId: string): Promise<void>`. Instance exposes readonly `ownerId: string`. Pool lifetime belongs to the caller. Import/recover launch no execution. Task3 supplies authenticated snapshots and the maintenance/fencing CLI. `initialize=false` permits only verification/no-op of an existing matching import; reject uninitialized authority before any imported writes. Task3 passes false once its local migration marker is complete, preventing repopulation of an empty/restored database from stale filesystem data.

Also include `assertHealthy(): void` in RunJournal and both implementations. It synchronously rejects known closed/failed state, without a database query; PG poisoning is sticky. Task4 uses it immediately before native dispatch to catch another write failing during post-intent page inspection. Do not add an event bus or lease mechanism.

- [ ] Write real DB tests against a fresh fixture/schema. Migrate then initialize empty state through `importSnapshot` with an opaque UUID and valid HMAC digest; open one owner. Concurrent identical reserve calls yield one run; changed facts with the same key yield one success/one409; different active reservations yield one429; same-key status remains accessible. Alias/direct identities share a namespace; unauthorized aliases reject. Terminal changes reject, intent survives failure as UNKNOWN and blocks a fresh capability key. Restart after healthy close preserves exact identities and aliases.

```ts
const pair = await Promise.all([journal.reserve(owner, key, capability, version, request), journal.reserve(owner, key, capability, version, request)]);
expect(pair[0].runId).toBe(pair[1].runId);
expect(await journal.list()).toHaveLength(1);
await journal.update(pair[0].runId, 'dispatching');
await journal.update(pair[0].runId, 'failure');
expect((await journal.get(pair[0].runId))?.state).toBe('POST_OUTCOME_UNKNOWN');
```

- [ ] Run `npx vitest run test/postgres-journal.test.ts` for RED. Add schema with `meridian_journal_authority` singleton `(singleton=true PRIMARY KEY, import_id UUID, source_digest TEXT, owner_id UUID)`, `meridian_runs` existing journal fields plus `dispatch_intent BOOLEAN`, and `meridian_run_requests` identity primary key, caller/request/run foreign-key metadata and alias flag. Constrain hash formats, states, safe owner/capability/version formats and unique direct run identities. A partial unique index on constant true over reserved/running/dispatching enforces one active record. Use named columns, no arbitrary JSON request storage.
- [ ] Implement transactions with `BEGIN`, authority-row `FOR UPDATE`, owner verification, conditional writes, `COMMIT`, release in finally. Validation/RequestError rollbacks do not poison; SQL/transport/commit uncertainty does poison, retains owner, sanitizes error and rejects later operations. `open` claims only initialized matching import/digest with null owner; never recovers. `close` releases only a healthy instance with no active records. Concurrent calls through the same instance remain valid and DB-serialized. Reads query the DB and reject poisoned/closed instances.
- [ ] Implement conservative import into empty uninitialized authority, preserving exact request mappings. Reject duplicate direct/alias identities and mismatched alias targets. Convert reserved/running to interrupted and dispatching to UNKNOWN; retain UNKNOWN. A repeated exact import ID/digest is a no-op and must not overwrite later state. Different imports reject. Recover uses exact non-null owner CAS; convert active states by intent and clear ownership atomically. No lease clocks.
- [ ] Add tests for second-owner denial after client disconnect, exact-owner recovery, stale-owner writes, close with active records, uncertain COMMIT (inject lost acknowledgement around a real committed DB transaction), subsequent-read/write rejection, and persisted intent/owner after failure. Canary raw requests must not appear in any database table values or public error text. Cover schema rejection with direct SQL where it protects races.
- [ ] Run `npx vitest run test/postgres-journal.test.ts` and the existing HMAC identity regressions with `npx vitest run test/meridian.test.ts -t 'durable request identity'`, then `npm run typecheck`, `git diff --check`; commit `feat: add authoritative PostgreSQL run journal`. Report any actual interface changes for Task3/4. No full browser suite required for this task.

### Task 3: Non-executing import and fenced maintenance commands

**Files:** Modify `src/runtime/journal.ts`, `cli.ts`; create `src/runtime/journal-maintenance.ts`, `test/journal-maintenance.test.ts`; update `docs/meridian/runbook.md`.

**Interfaces:** Consume Task2 `JournalSnapshot`, `journalDigest`, `PostgresJournal` methods. Export `readJournalSnapshot(dir: string, key: string): JournalSnapshot` from journal.ts using existing signed-envelope authentication without construction/recovery. Maintenance exports `importJournal(dir: string, pool: Pool, key: string): Promise<void>` and `readAuthorityMarker(dir: string, key: string): { importId: string; digest: string }`. The signed marker filename is exactly `postgres-authority.json`.

- [ ] Build a real signed filesystem fixture with direct record, alias, and dispatching/unknown state. Assert import preserves exact IDs/HMACs/aliases, converts active state safely, and permits PG restart. Tampered signature, filename/alias owner mismatch or duplicate identity rejects before any imported row. Import must not call `createRuntime`, `InvocationService`, `makeLLMClient` or start a browser/server.
- [ ] Run `npx vitest run test/journal-maintenance.test.ts` for RED. Authenticate snapshots via shared readers, sorting records by runId and aliases by identity before hashing, skipping only known lock/marker/temp names; reject invalid `.json` records and aliases. Acquire the existing `startup.lock` exclusively, reject any `server.lock`, authenticate all snapshot data, fsync the signed marker with phase `pending` before attempting import. Existing marker is validated and reused only for the same snapshot digest. Release only the owned startup lock in finally.

```ts
// The irreversible local migration fence precedes every database import attempt.
const snapshot = readJournalSnapshot(dir, key);
const digest = journalDigest(key, snapshot);
// Persist/authenticate { importId, digest, phase: 'pending' | 'complete' }.
await PostgresJournal.importSnapshot(pool, key, snapshot, marker.importId, marker.digest, marker.phase === 'pending');
// Atomically publish/fsync phase complete only after acknowledged import.
```

- [ ] Add marker checks to filesystem Journal startup inside its startup-lock section and before all filesystem writes. Any marker existence refuses execution; malformed markers cannot enable fallback. `readAuthorityMarker` requires phase complete before returning its importId/digest to runtime open; the importer privately handles pending markers. Keep `readJournalRecord` usable for signed historical evaluation.
- [ ] Add `journal-import` CLI requiring DATABASE_URL and JOURNAL_HMAC_KEY, using configured EVIDENCE_DIR/journal. Add `journal-recover --owner <uuid> --confirm-fenced` requiring exact UUID plus explicit flag, then calling recover. Commands create/close only their own pool; safe fixed error messages omit connection strings and SQL details. Do not log secrets or snapshot bodies. CLI dispatch must select maintenance before entering discover/replay/serve code.
- [ ] Test active old filesystem service rejection, concurrent import lock, DB failure leaves pending marker and blocks both runtime modes, exact repeated import after lost acknowledgment, complete marker refuses empty target initialization, mismatched target/marker refusal, and maintenance CLI zero execution. Document stop/fence verification, stale lock handling, one-way cutover, owner inspection with read-only SQL, exact-owner recovery and no rollback to older journal. All commands are operator instructions, not executed against production.
- [ ] Run focused maintenance/journal tests and typecheck; commit `feat: fence filesystem journal migration to PostgreSQL`.

### Task 4: Await authoritative storage through every entry point

**Files:** Modify `src/server/service.ts`, `src/server/http.ts`, `src/server/chat.ts`, `src/server/conversation-http.ts`, `src/runtime/run.ts`, `src/surface/guarded.ts`, `src/server/ui/session.tsx` (type-only Promise unwrapping), `cli.ts`, necessary existing caller tests; create `src/runtime/open-journal.ts` and focused PG service integration coverage (prefer `test/postgres-journal.test.ts` or `test/subject-http.test.ts` if their fixtures fit). Update runbook configuration section.

**Interfaces:** Consume Task2 `RunJournal`, Task3 `readAuthorityMarker` and Task1 awaited dispatch. Produce `openRunJournal(dir: string, key: string, pool?: Pool): Promise<RunJournal>`: select from `process.env.RUN_JOURNAL` (unset/filesystem/postgres only); PG requires passed pool and matching marker, calls migrate/open; never fallback. This factory has three actual production callers: serve, MERIDIAN discover, MERIDIAN replay. Do not move evaluator readers to an executing opener.

- [ ] First integrate the controller-confirmed final PR97 head (initial reviewed base `724519663c2d2fd650923de0234a7ff5fad834fe`, subsequent frontend fix pending) by an explicit merge, not copying its implementation. Parent/UI preflight found service/http identity+availability conflicts: keep B1 principalRole/principalKey and subjectId, add availability, preserve six-argument `invoke(..., role, lookupOnly=false)` shared normalized lookup before reserve, keep live-only finishedAt. Keep one current PR97 browser identity test where duplicate placement conflicts. Controller supplies final exact head before dispatch. No provider/dialog edits; session.tsx changes are only Awaited Run/Availability aliases (catalog stays sync).

- [ ] Read `/tmp/meridian-b2-callers.md` for the complete caller inventory. Add failing integration coverage for delayed journal admission: concurrent same-key calls start exactly one runtime; different keys produce one admitted run and one429 with no orphan reservation. Status/history/alias/reload paths await storage and cause zero fresh invokes. Same-key replay during shutdown/unknown quarantine remains readable.
- [ ] Make service journal consumers async, replace production Map access with get/list/hasUnknown, and serialize only invocation admission using an in-process promise tail (release after startup/admission, not after replay). Do not hold it across internal identity inquiry completion. Await durable running state before executing replay; await completion writes; catch storage failure without starting/retrying another runtime or leaking raw errors. Journal intent, not just mutationDispatched, controls unknown terminal state. Ensure service.close prevents new admission immediately, drains admitted setup and completions, and only permits owner release after runtime shutdown is verified.

```ts
const prior = this.admission;
let release!: () => void;
this.admission = new Promise<void>(resolve => { release = resolve; });
await prior;
try { return await this.admitRun(/* validated invocation */); }
finally { release(); }
```

- [ ] Await get/history/invoke/decide in all HTTP/chat/conversation paths. Express4 requires explicit promise rejection forwarding: reuse conversationRouter's async wrapper pattern or a small local shared wrapper with real callers. Approval decisions re-check authorization after awaited lookup and rely on existing Approval live-context checks. Internal identity inquiry retains original principal and privacy projection. Preserve fixed public errors.
- [ ] Add individual-subject lookupOnly regressions: same subject/exact normalized key returns accepted run including UNKNOWN without execution; missing key404 creates no reservation/runtime; changed facts409; another subject cannot recover that run or acquire an operator grant. Readiness checks access before artifact existence and asynchronously checks journal unknown state without exposing another owner.
- [ ] Fix the confirmed private-child intervention liveness issue using the existing history/GET/decision contract. Include a private child in history only for an authorized operator while that child's approval is pending. Centralize the private pending projection in get: preserve only original pending id/expiresAt and request.kind, pinned capability, goal `Complete the linked identity check.`, reason `Linked identity check needs operator attention.`, url `(unavailable)`; omit action/step/screenshot and raw request fields. Other private inputs/results remain withheld and private terminal history stays hidden. Existing decision validation still targets exact run/id and cannot auto-retry, clear active or infer expiry. A generic private card without exact public action facts cannot enable new mutation approval.
- [ ] Reuse the confirmed synthetic reproduction at `/Users/goodwiinz/.codex/visualizations/2026/09/07/01a079b3-6fa0-70c1-a90c-2f49e64deca2/replay-stuck-private-repro.json` as context, not a live acceptance claim. Add regressions through the real internal inquiry/Approval path for discoverable pending child, raw canaries absent from history and GET, authorized explicit abort/retry only, wrong run/id and stale/duplicate/expired decision rejection, and cross-subject/caller denial. Do not expose raw private child data or duplicate the audit. Use existing fixtures and fixed metadata projection, no new queue subsystem.
- [ ] In serve, configure/migrate pool before opening PG journal/service; preserve optional B1 conversation configuration. Clean up service, then journal, then pool, and keep ownership blocked if runtime cleanup is uncertain. In CLI, use openRunJournal for MERIDIAN replay/discovery, await helper reads/writes/close, create/end a pool only for PostgreSQL mode, and preserve terminal/error evidence behavior. No unhandled async callbacks in beforeDispatch or finalizers. Legacy unmigrated FS behavior remains covered.
- [ ] Existing `closeRuntime` deliberately suppresses browser close errors to preserve result evidence. Expose a sticky `cleanupFailed: boolean` on the concrete runtime, initially false and set in that catch. Service/CLI must retain PG ownership when this is true, even if later close appears successful. Await admission and replay completion before releasing the journal; a close during browser startup cannot release it early. Adapt UI `Run` type to `Awaited<ReturnType<InvocationService['get']>>` only. Keep filesystem benchmark and offline evaluator explicit about their filesystem scope.
- [ ] Thread optional `assertDispatchAllowed?: () => void` through runtime options and guarded runtime; supply `() => journal.assertHealthy()` in service and MERIDIAN CLI. Call it after post-intent revalidation's final await immediately before native dispatch/intent emission. Add a regression that poisons storage during that final inspection, then asserts zero native dispatch. The method checks known failure synchronously; it must not issue another asynchronous query and reopen the same gap.
- [ ] Update existing tests to await the async service without weakening assertions. Add real PG serve startup/restart, owner denial, safe errors, subject HTTP ownership, alias/history survival and uncertainty/no-second-runtime regressions. Apply any reviewed UI-owner head by controller-directed integration only; availability/finishedAt implementation is owned elsewhere.
- [ ] Run focused changed suites, then coordinate `npm run ci`, `npm run test:smoke`, `npm run validate`, `git diff --check` with controller. Record exact checkout/HEAD/counts. Commit `feat: route invocation entry points through authoritative journal`.

## Delivery

Controller performs one final whole-B2 safety review against PR96 head, resolves findings through the scoped loop, and publishes a tested PR with explicit PR96 dependency. Hosted CI must succeed at its exact final head. Archive reports/rulings before deleting only this plan's SDD scratch directory. Preserve worktree for review. No merge or deployment.
