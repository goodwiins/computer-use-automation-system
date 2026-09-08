# Task 4 report: migration/release compatibility and branch-wide evidence

## Scope and checkout

- Worktree: `/home/clawdbot/meridian-worktrees/conversation-storage-limits`
- Starting head: `0246a417c626dbbf7f8658179f4e5b242580c2e8`
- Database URL for every PostgreSQL command: `postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql`
- PostgreSQL isolation: every test acquired a unique `test_conversations_<random-hex>` schema through `test/fixtures/postgres.ts`; setup and cleanup touched only that schema.
- No live, deployed, protected-demo, cloud, restart, push, PR, merge, or transaction activity was performed.

## Migration compatibility evidence

Added `test/fixtures/conversations-prior.sql`, a byte-for-byte copy of
`7fb01a7f82ea8db1a18ca256a4ab411b38a176a2:src/server/conversations.sql`.
The fixture is 1,118 bytes and its SHA-256 is
`ed127e0cf303a4fec487d4021977310ead80a4f965a784efce7c744ed4d41a79`; the
compatibility test asserts that hash before executing it. This is the prior
two-table schema, including its index, checks, foreign key, and uniqueness
constraints—not a reduced approximation.

`test/conversation-migration-compatibility.test.ts` seeds two subjects with
explicit legacy timestamps and metadata: active and archived conversations,
a deleted tombstone, message and linked-run events, and a second subject's
active conversation/event. It then:

1. Runs the current migration, sets a non-default rate state, and runs the
   current migration a second time.
2. Compares every source conversation/event row and metadata before and after
   migration, verifies counters (`owner: 3/3`, `other: 1/1`), and reopens with
   a fresh pool and `ConversationStore`.
3. Exercises subject-owned get/list/history, cross-subject 404/list isolation,
   exact create and append retries at zero tokens, rate rejection for new
   writes, create, append, archive, unarchive, delete, tombstone ID reuse
   rejection, and independent progress for the other subject.
4. Reconciles quota counters against retained source rows after mutations and
   reruns migration; the original tombstone row and metadata remain present,
   with no expiry or cleanup observed.

Command and result:

```text
TEST_DATABASE_URL=postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql npm test -- test/conversation-migration-compatibility.test.ts
exit 0
Test Files 1 passed (1)
Tests 1 passed (1)
```

The test includes the production migration and store code; no production
defect was reproduced.

## Concurrency and boundary reruns

The required PostgreSQL store suite was run twice serially on the exact
starting branch head plus the Task 4 test changes. Both runs were green:

```text
TEST_DATABASE_URL=postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql npm test -- test/conversation-store.test.ts
Run 1: exit 0; Test Files 1 passed (1); Tests 13 passed (13)
Run 2: exit 0; Test Files 1 passed (1); Tests 13 passed (13)
```

These tests retain coverage for quota-row-first serialization, exact create
and append retries, rollback counter/token integrity, event/conversation
boundary races, global-ID conflicts, mixed append/delete, and cross-subject
progress while one subject quota row is held.

## Branch-wide release gates

The first full-CI invocation overlapped a heavy CI in the separate
`review-repairs` worktree. It is retained as observed but is not counted as a
serial gate. Its visible first failures were journal maintenance (1), variant
(1), approval CLI (1), history structure (1), conversation UI acceptance (1),
and fixes validation (1); the process ended without a retrievable final
summary.

A second full-CI invocation also overlapped a later `review-repairs` run that
started shortly after it. Its complete result is retained but likewise not
counted as uncontended evidence:

```text
TEST_DATABASE_URL=postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql npm run ci
exit 1
Test Files 7 failed | 32 passed (39)
Tests 14 failed | 977 passed | 3 skipped (994)
```

The observed failures in that overlapped run were: browser crash/abort in
`test/screenshot-mask-profile.test.ts`; approval CLI timeout; six browser
failures in `test/conversation-ui-acceptance.test.ts`; e2e output mismatch;
validation timeout; history timeout; and four MERIDIAN browser crash/abort
failures. The migration compatibility and conversation store suites were not
among its failures.

After the controller confirmed no competing heavy suite remained, one final
uncontended `npm run ci` was run and its exact result is recorded below:

```text
TEST_DATABASE_URL=postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql npm run ci
exit 1
Test Files 1 failed | 38 passed (39)
Tests 1 failed | 993 passed (994)
Failure: test/approval-cli.test.ts > standalone approval CLI transport > shows facts and records exact approve/refuse commands from a second process
  Test timed out in 60000ms.
Duration 200.07s
```

The remaining release gates were run serially:

```text
npm run validate
exit 0
All artifacts satisfy the current risk floor.

npm run typecheck:ui
exit 0

npm run build
exit 0
Next.js production build compiled successfully and generated the static /
and /_not-found routes.

TEST_DATABASE_URL=postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql npm run test:smoke
exit 0
Test Files 2 passed (2)
Tests 19 passed (19)
```

The required baseline whitespace check was also run exactly:

```text
git diff --check 7fb01a7f82ea8db1a18ca256a4ab411b38a176a2..HEAD
exit 2
docs/superpowers/specs/2026-09-08-conversation-storage-limits-design.md:90: new blank line at EOF.
```

That finding predates Task 4 and is in the approved design spec, outside the
permitted Task 4 files; it was not changed. The Task 4 fixture and test have
no whitespace errors.

## Scope/privacy audit

The exact source audit confirmed:

- The quota table contains only owner UUID, conversation/event counters, rate
  tokens, and refill time; no transcript, member, token, role, run output,
  evidence, or arbitrary JSON fields.
- Constants are exactly 128 conversations, 512 events per conversation, 4096
  events per subject, burst 20, and refill 1 token/second.
- Every mutation calls the quota-row lock before any conversation-row lock;
  exact create/append retries return before capacity and rate consumption.
- Delete removes retained events, leaves conversation/tombstone count intact,
  and there is no expiry worker or cleanup path.
- Capacity/rate failures remain fixed 507/429 responses; only the server-authored
  `Retry-After: 1` header is emitted for 429. No counters, identifiers, SQL,
  or foreign-row details are returned.
- The UI derives capacity/rate text from status only, does not parse failed
  response bodies, and has no automatic retry, timer, or backoff for these
  failures.
- `docs/meridian/conversations.md` was not amended: its migration compatibility
  and rollback contract already matched the verified behavior, so no verified
  documentation gap was found.

## Source versus deployed/live disclaimer

All evidence in this report is from the checked-out source at the stated
starting head plus the scoped Task 4 test/report changes, local Node 22,
local PostgreSQL, isolated schemas, and local fixtures. Passing local tests,
builds, validation, or smoke checks does not establish deployed behavior,
hosted CI status, production database state, live MERIDIAN acceptance, or
protected-demo behavior. No such claim is made.

## Gate reopening and approval-CLI diagnosis

The controller authorized one mechanical change: remove the extra trailing
newline at EOF from
`docs/superpowers/specs/2026-09-08-conversation-storage-limits-design.md`.
No wording or semantic content changed. No production or test source changed.

The approval-CLI failure was diagnosed using the exact PostgreSQL URL and the
focused suite alone, serially:

```text
TEST_DATABASE_URL=postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql npm test -- test/approval-cli.test.ts
Run 1: exit 0; Test Files 1 passed (1); Tests 56 passed (56)
Run 2: exit 0; Test Files 1 passed (1); Tests 56 passed (56)
```

After both isolated reruns passed, the host was checked and had no competing
heavy Vitest/npm process. One final full CI was then run uncontended:

```text
TEST_DATABASE_URL=postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql npm run ci
exit 1
Test Files 1 failed | 38 passed (39)
Tests 1 failed | 993 passed (994)
Failure: test/approval-cli.test.ts > standalone approval CLI transport > shows facts and records exact approve/refuse commands from a second process
  Test timed out in 60000ms.
Duration 204.08s
```

The timeout therefore reproduces only in the full-suite context in this
environment; it does not reproduce in two isolated focused runs. This remains
an honest release-gate blocker. No out-of-scope code or test change was made.

With the authorized EOF edit present in the working tree, the baseline
whitespace check passed:

```text
git diff --check 7fb01a7f82ea8db1a18ca256a4ab411b38a176a2
exit 0
```

## Fix round 1: over-limit legacy compatibility

Added a second compatibility test using the same hash-guarded exact prior
schema fixture. It seeds legacy data with SQL `generate_series`, before the
current migration, rather than creating thousands of rows through the store:

- one subject has 129 conversation rows, including a retained tombstone;
  all 128 active rows paginate and remain readable, deletion is allowed, and
  a subsequent distinct create remains fixed 507 because the tombstone keeps
  the conversation count at 129;
- a separate subject has nine conversations and 4,097 retained events,
  distributed as eight 512-event rows plus one one-event row; source rows and
  metadata survive migration, the over-capacity append is fixed 507, deleting
  a 512-event conversation releases exactly its events while retaining the
  conversation/tombstone count, and a valid append then succeeds;
- both subjects remain isolated, and quota counters are checked against
  retained source rows after each mutation boundary.

The new test's pre-migration source assertions recorded 138 conversations and
4,097 events in total, including 129 conversations for the conversation-over-
limit subject and 9/4,097 for the event-over-limit subject.

Exact results after the test-only change:

```text
TEST_DATABASE_URL=postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql npm test -- test/conversation-migration-compatibility.test.ts
Run 1: exit 0; Test Files 1 passed (1); Tests 2 passed (2)
Run 2: exit 0; Test Files 1 passed (1); Tests 2 passed (2)

TEST_DATABASE_URL=postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql npm test -- test/conversation-store.test.ts
Run 1: exit 0; Test Files 1 passed (1); Tests 13 passed (13)
Run 2: exit 0; Test Files 1 passed (1); Tests 13 passed (13)

TEST_DATABASE_URL=postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql npm test -- test/conversation-migration-compatibility.test.ts test/conversation-store.test.ts test/conversation-http.test.ts test/conversation-http-postgres.test.ts test/conversation-ui.test.ts test/conversation-ui-acceptance.test.ts
exit 0
Test Files 6 passed (6)
Tests 92 passed (92)
```

### Independent-review diagnostic supplied by reviewer (not run by this task)

The reviewer supplied the following separate diagnostic; it is not local
evidence from this task and is not claimed as agent-executed verification:

```text
HEAD 37ebe86
Node 22.22
PostgreSQL 16.15
TEST_DATABASE_URL=postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql npm test -- --no-file-parallelism
exit 0
Test Files 39 passed (39)
Tests 994 passed (994)
Duration 354.27s
```

The reviewer noted that this command expanded to the build first and did not
separately run typechecks. It is independent-review context only; the default
CI blocker remains explicit: local full `npm run ci` still times out in the
approval CLI test at 993/994 even though two isolated approval-cli reruns pass
56/56.
