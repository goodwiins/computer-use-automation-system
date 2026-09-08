# B1 Conversations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working opt-in PostgreSQL conversation API with individual authentication and no raw transcript persistence.

**Architecture:** Express authenticates stable subjects separately from role; existing journal records and chat tools use subject-bound request identity. A concrete PostgreSQL store serializes revision/event changes with row locks and returns safe history; it cannot invoke transactions or delete safety state.

**Tech Stack:** Node 22, TypeScript/Express/Zod, PostgreSQL 14+, pinned pg client, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-07-conversations-design.md`

## Global Constraints

- Express remains the authoritative API; no Next backend migration, UI edits or served-checkout restart.
- Node 22 and PostgreSQL 14 or newer. Real isolated PostgreSQL tests; no silent skipped required DB tests.
- Preserve PR93 head c7bba9e's balance/identity behavior and exact subject ownership of its child run.
- No raw text, arbitrary titles/metadata, credentials, PII, arguments, live outputs or approval facts in durable conversations.
- Subject ownership is separate from role. Every subject, including operators, accesses only its own runs/conversations; legacy operators cannot access subject data. Chat retains subject but has caller authority.
- Saved history never starts invocations/decisions; archive/delete never alter run/journal/idempotency/unknown state.
- Keep one active runtime and terminal unknown quarantine; no deployment, cloud spending or live target action. PDF acceptance remains 4/7.
- Do not create unused abstractions or dependencies. Add pg only with its concrete consumer.

### Task 1: Subject authentication and every run/chat ownership seam

**Files:** Create `src/server/auth.ts`, `test/subject-auth.test.ts`; modify `src/server/http.ts`, `src/server/service.ts`, `src/server/chat.ts`; extend `test/member-identity.test.ts` if needed.

**Interfaces:**

```ts
export type Role = 'caller' | 'operator';
export type SubjectPrincipal = { subjectId: string; role: Role };
export type Principal = Role | SubjectPrincipal;
export type SubjectCredential = SubjectPrincipal & { token: string };
export function principalRole(principal: Principal): Role;
export function principalKey(principal: Principal): string; // legacy role or subject:<uuid>
export function canAccessRun(principal: Principal, owner: string): boolean;
export function callerPrincipal(principal: Principal): Principal; // subject retained, role demoted
export function parseSubjectCredentials(value: string | undefined): SubjectCredential[] | undefined;
export function createAuthenticator(config: {callerToken: string; operatorToken: string; subjectTokens?: SubjectCredential[]}): (token: string) => Principal | undefined;
```

Service re-exports `Principal` for existing imports. `createApp` gains optional `subjectTokens` but keeps existing required legacy token config fields so existing consumers compile. In subject mode legacy fields can be empty and are ignored. `serve` parses `SUBJECT_API_TOKENS`. Middleware returns role-string `principal` and optional `subjectId` in `/capabilities`.

- [ ] **Step 1: Write failing seam tests before implementation.** Use existing real `Journal`, app HTTP harness and mock language model only at the external model boundary. Seed two same-role subjects with distinct records and identical request keys. Assert owner-only history/detail/evidence, direct invocation owner keys, token rotation and no legacy access. Cover both chat handlers, status aliases and old-message lookups, operator demotion, decisions and linked identity runs.

```ts
const a = {subjectId: '11111111-1111-4111-8111-111111111111', role: 'caller'} as const;
const b = {subjectId: '22222222-2222-4222-8222-222222222222', role: 'caller'} as const;
const record = journal.reserve(principalKey(a), 'same-key', 'lookup', '1.0.0', {});
expect(() => service.get(b, record.runId)).toThrow();
expect(service.history(b)).toEqual([]);
expect(canAccessRun('operator', principalKey(a))).toBe(false);
expect(callerPrincipal({...a, role:'operator'})).toEqual(a);
```

- [ ] **Step 2: Run RED:** `npm test -- test/subject-auth.test.ts test/member-identity.test.ts`; retain the expected missing-auth-function/ownership assertion failure output in the report.
- [ ] **Step 3: Implement auth helpers and apply them to every caller.** Use Zod strict credential validation and generic configuration failures, SHA256/timingSafeEqual token comparison, UUID normalization, duplicate token/subject rejection. Preserve legacy role keys; subject keys use a fixed prefix. Subject-mode ownership is exact regardless role; legacy operator bypass applies only to non-subject owners.

```ts
const owner = principalKey(principal);
const role = principalRole(principal);
const {existing, identity} = this.journal.lookup(owner, key, request);
// invoke reserve, history/get, approval projection and decide all use the same helpers.
// chat buildTools/textHistory/projectRun receive callerPrincipal(res.locals.principal).
```

Remove every hardcoded journal caller from chat request paths, including bindReference/findRequest. Propagate original principal unchanged into PR93's child inquiry. Do not alter target TELLER/SUPERVISOR authority or capability-wide unknown checks.
- [ ] **Step 4: Run GREEN and full gate before commit:** `npm test -- test/subject-auth.test.ts test/member-identity.test.ts test/chat.test.ts test/journal-alias.test.ts`; `npm run ci`; `git diff --check`.
- [ ] **Step 5: Self-review, commit only owned files, report TDD evidence and exact test results.**

### Task 2: Concrete PostgreSQL store with real transaction tests

**Files:** Create `src/server/conversations.ts`, `src/server/conversations.sql`, `test/conversation-store.test.ts`, `test/fixtures/postgres.ts`; modify `package.json`, `package-lock.json` to pin `pg` and `@types/pg`.

**Interfaces:**

```ts
import type {Pool} from 'pg';
export type Conversation = {id:string; archived:boolean; revision:number; createdAt:string; updatedAt:string};
export type ConversationEvent = {id:string; sequence:number; kind:'message_omitted'|'run_linked'; role:'user'|'assistant'; runId?:string; createdAt:string};
export type AppendEvent = {id:string; kind:'message_omitted'|'run_linked'; role:'user'|'assistant'; runId?:string; expectedRevision:number};
export class ConversationStore {
  constructor(pool:Pool);
  migrate(): Promise<void>;
  create(owner:string,id:string): Promise<Conversation>;
  list(owner:string, options?:{archived?:boolean;after?:string;limit?:number}): Promise<{conversations:Conversation[];nextCursor?:string}>;
  get(owner:string,id:string): Promise<Conversation>;
  archive(owner:string,id:string,archived:boolean,expectedRevision:number): Promise<Conversation>;
  delete(owner:string,id:string,expectedRevision:number): Promise<void>;
  append(owner:string,id:string,event:AppendEvent): Promise<ConversationEvent>;
  events(owner:string,id:string,options?:{after?:number;limit?:number}): Promise<{events:ConversationEvent[];nextCursor?:number}>;
}
```

Owner arguments are bare subject UUIDs, never role strings or request-supplied owners. Runtime-validate all store inputs and exact event shape. Reuse `RequestError` statuses. No production test hooks; tests construct a Pool with an isolated search_path. Pool lifecycle belongs to the caller (Task 3). `migrate` reads the SQL via import.meta.url and executes it under one transactional advisory lock/client.

- [ ] **Step 1: Pin dependencies and write real PostgreSQL tests.** `npm view pg version` and `npm view @types/pg version`, then save exact versions. Fixture reads `TEST_DATABASE_URL` and throws a clear error if absent; creates a random `test_conversations_<uuidhex>` schema and pool search_path, drops only that schema after all connections close. It must never drop a database or another schema.

```ts
const first = await store.create(owner, id);
const event = {id:eventId,kind:'run_linked',role:'assistant',runId,expectedRevision:0} as const;
const appended = await Promise.all([store.append(owner,id,event),store.append(owner,id,event)]);
expect(appended[0]).toEqual(appended[1]);
expect((await store.events(owner,id)).events).toHaveLength(1);
await expect(store.get(otherOwner,id)).rejects.toMatchObject({status:404});
await expect(store.append(owner,id,{...event,runId:otherRunId})).rejects.toMatchObject({status:409});
```

Additional checks: separately reopen pool/store and compare history; competing different events same revision produce one winner; revision/sequence ordering; pagination; archive blocks new append and unarchive restores; delete removes events and prevents create retry resurrection; stale archive/delete cannot partially mutate; foreign owner can't dedupe/read/delete; raw fields and invalid role/kind/UUID rejected, with canary absent from stored row serialization.
- [ ] **Step 2: Run RED:** `TEST_DATABASE_URL=<isolated URL> npm test -- test/conversation-store.test.ts`; capture missing store/failed contract output.
- [ ] **Step 3: Implement minimal SQL and concrete class.** Tables `meridian_conversations` and `meridian_conversation_events`: uuid primary/foreign keys; owner uuid; archive flag; nonnegative revision; tombstone timestamp; sequence unique per conversation; enum CHECKs and conditional runId CHECK. Event FK references conversations only. Transactions use one pool client with `BEGIN/COMMIT/ROLLBACK` and release in finally.

```sql
SELECT * FROM meridian_conversations
WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL FOR UPDATE;
-- after owner/deleted check, identical existing event returns before revision/archive checks
-- otherwise reject archived/stale revision, increment revision, use new revision as event sequence
```

Creation is idempotent per owner/id but tombstones cannot resurrect. Listing orders immutable UUIDs and fetches limit+1 to derive nextCursor. Events order increasing sequence. DELETE transaction removes events, marks tombstone and increments revision; it has no journal dependency. Unexpected DB errors propagate without logging raw arguments; HTTP will sanitize them.
- [ ] **Step 4: Run GREEN plus full gate with the isolated URL:** focused store suite, `npm run ci`, `git diff --check`.
- [ ] **Step 5: Self-review, commit and report TDD/real-database evidence.**

### Task 3: Working HTTP/store integration, startup lifecycle and CI

**Files:** Create `src/server/conversation-http.ts`, `test/conversation-http.test.ts`, `docs/meridian/conversations.md`; modify `src/server/http.ts`, `.github/workflows/ci.yml`, startup tests if necessary. Use Task 1 auth and Task 2 store as concrete dependencies.

**Interfaces:**

```ts
export function conversationRouter(service:InvocationService, store?:ConversationStore): import('express').Router;
// createApp config gains conversations?: ConversationStore
// serve constructs Pool from DATABASE_URL, store.migrate(), injects store, ends pool on all shutdown/error paths.
```

- [ ] **Step 1: Write failing HTTP integration tests using real PostgreSQL and real Journal/service.** Reuse fixture pool/schema. Send authenticated subject tokens through real HTTP for the exact route table in the spec. Validate own create/list/get/append/page/archive/unarchive/delete, stale revisions, raw-field rejection, owner override rejection, legacy refusal, safe own-run links and cross-owner links. Reload via new service/Journal/store after closing original; snapshots/statuses persist without starting a runtime.

```ts
// Seed safe journal records and private live output canaries, then fetch saved-history events.
expect(JSON.stringify(events)).not.toContain('PRIVATE_MEMBER_CANARY');
expect(journal.records.size).toBe(beforeCount);
expect(journal.records.get(unknownRunId)?.state).toBe('POST_OUTCOME_UNKNOWN');
// DELETE only the conversation: same-key lookup still returns the original run.
```

Include operator same-subject decision role checks (existing service tests), foreign/missing404, missing storage503, authfailure401, invalid body/query400, rawDBerror generic500, and startup failure/shutdown pool cleanup.
- [ ] **Step 2: Run RED:** `TEST_DATABASE_URL=<isolated URL> npm test -- test/conversation-http.test.ts test/server-startup.test.ts`.
- [ ] **Step 3: Implement the router exactly as spec.** Use strict Zod request schemas; Express 4 async handler errors must call next. Require object subject principal before storage access. For `run_linked`, verify journal caller equals principalKey, including operator subjects, before append. Read projection calls safeResult on the existing service result and selects only ID/capability/version/state/safe structure; omit live inputs/memberIdentity/intervention/evidence URLs. Event templates are fixed; no full service response is spread into history.

```ts
const {subjectId} = subjectPrincipal;
if (record.caller !== principalKey(subjectPrincipal)) throw new RequestError(404,'Unknown run');
const projected = {runId:run.runId,capability:run.capability,version:run.version,state:run.state,
  result:run.result === undefined ? undefined : safeResult(run.result)};
```

Enable storage only when DATABASE_URL and subject credentials are present; missing subject config is a generic startup error. Migration before listen, no in-memory fallback. Drain service and end pool on shutdown; release journal/UI resources on startup errors. Preserve existing Express UI build/serving and chat contracts.
- [ ] **Step 4: Add PostgreSQL CI service and operational docs.** CI service uses postgres:14, healthcheck, database/user/password for synthetic CI only, and TEST_DATABASE_URL. Document local isolated initdb/pg_ctl setup and required env, migrations, full route contract with synthetic examples, token rotation, privacy/retention, no automatic conversation-to-chat replay, subject-mode demo-token incompatibility, and shutdown. No live secrets/example member data.
- [ ] **Step 5: Run GREEN and final gates:** DB HTTP/store suites, all auth/chat/identity/startup checks, `npm run test:smoke`, `npm run ci`, `npm run validate`, `git diff --check`. Self-review, commit and report. Controller obtains final whole-branch review, publishes a separate PR against dev and checks hosted exact-head CI. PR93 dependency must be explicitly stated or rebased away after it merges.
