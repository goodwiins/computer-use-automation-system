# Task 3 — Integration and truthful quota failure states

Date: 2026-09-08
Worktree: `/home/clawdbot/meridian-worktrees/conversation-storage-limits`
Storage base before integration: `1a1eafefe630dae093fcc0624f973c2d77f32333`

## Integration

Integrated the reviewed saved-conversations owner handoff with a local
non-fast-forward merge:

- Owner base: `7fb01a7`
- Reviewed owner commits: `3222d6c` and `f4e48274f22a373982fdff6d4ffe6a2e93c69b25`
- Local merge commit: `77af41d1ef6ed7a4950042c3ea80e2128620104d`
- Merge parents: storage `1a1eafefe630dae093fcc0624f973c2d77f32333`, owner `f4e48274f22a373982fdff6d4ffe6a2e93c69b25`
- Conflicts: none; `ort` completed without manual conflict resolution.

The handoff evidence supplied with the dependency was: focused owner UI 32/32;
real authenticated createApp + ConversationStore + PostgreSQL + Chromium
acceptance 10/10; serial 38 files / 961 tests; UI and backend type checks and
build passed; independent rereview READY.

Before quota-status edits, the unchanged merged focused UI suite passed:

```text
TEST_DATABASE_URL=postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql npm test -- test/conversation-ui.test.ts
Test Files 1 passed; Tests 32 passed
```

## RED

Added UI tests for 507 and 429. Before the adapter change, both failed for the
intended reason: the controller reported `unsaved` instead of the required
distinct `capacity` or `rate-limited` state. The real acceptance seam likewise
failed with `unsaved` for the real 507 response. The tests also cover one POST
before manual retry, no fake-timer-driven replay, frozen request body/UUID
reuse, no confirmation marker, and no server-body details in rendered text.

## GREEN and implementation

`src/server/ui/conversations.tsx` now:

- Adds `capacity` and `rate-limited` to `ConversationSaveStatus`.
- Maps only numeric response status 507/429/503 to UI states; response bodies
  are never read for failed requests.
- Renders explicit text that the item was not saved, capacity is full, or
  saving is temporarily rate-limited. The capacity text does not promise that
  deleting conversations restores capacity.
- Retains existing 409 reconciliation/conflict and 503 unavailable behavior.
- Adds no timer, backoff, automatic retry, or new request scheduling; existing
  frozen attempts remain available to the caller's explicit retry.

The existing pagination acceptance fixture was changed to insert its 52 valid
conversation rows directly in the isolated PostgreSQL schema with matching
quota metadata. This prevents fixture setup from consuming the real 20-token
write burst while preserving the source rows and mutation behavior under test.

## Verification

All commands used the isolated PostgreSQL URL where applicable:

```text
TEST_DATABASE_URL=postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql npm test -- test/conversation-ui.test.ts
  1 file, 34 tests passed

TEST_DATABASE_URL=postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql npm test -- test/conversation-ui-acceptance.test.ts
  1 file, 11 tests passed (real createApp/store/authenticated PostgreSQL + Chromium path)

npm run typecheck:ui
  passed

npm run typecheck
  passed

npm run test:smoke
  2 files, 19 tests passed

TEST_DATABASE_URL=postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql npm test -- test/conversation-store.test.ts test/conversation-http.test.ts test/conversation-ui.test.ts test/conversation-ui-acceptance.test.ts
  4 files, 69 tests passed

git diff --check
  passed
```

No push, PR, deploy, or live acceptance action was performed.

## Fix round 1/5 — review findings

Started from clean `f9bcda01322c0e54ea6099d874510064b2071889`.

### Finding 1: conversation failure-body parsing

Verified `RunProvider.request` in `src/server/ui/session.tsx` parsed every
non-401 failed response with `response.json()`. Added a browser acceptance
seam that returns a private 507 body, instruments `Response.prototype.json`,
and asserts fixed capacity text with no canary parsing or reflection.

RED: the targeted acceptance test observed
`privateConversationBodyParsed === true` despite the fixed capacity status.

GREEN: conversation paths now attach only numeric status and do not consume
failure bodies. Non-conversation failures retain their existing JSON parsing;
401 still disconnects. A fixed status-derived 409 message preserves the
existing safe conflict log without reading the server body.

Targeted result:

```text
TEST_DATABASE_URL=postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql npm test -- test/conversation-ui-acceptance.test.ts -t 'does not parse or reflect'
1 passed
```

### Finding 2: truthful PostgreSQL capacity/rate setup

RED: the added source-vs-quota assertion showed `source_events: '0'` versus
`quota_events: '4096'` in the previous metadata-only setup.

GREEN: the capacity checkpoint now inserts eight real conversations with 512
valid retained `message_omitted` rows each, revisions 512, one target
conversation, and matching conversation/event quota counters. The actual
authenticated controller request through `createApp` then receives 507.

The rate checkpoint now performs an authenticated HTTP create and an
authenticated accepted event append first. It records matching source and
quota conversation/event counts and confirms the bucket has consumed tokens
before setting only the isolated bucket to zero at the deterministic 429
checkpoint. The adapter then performs one real authenticated failed event
request.

Targeted result:

```text
TEST_DATABASE_URL=postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql npm test -- test/conversation-ui-acceptance.test.ts -t 'maps real authenticated'
1 passed
```

### Finding 3: preserve unsaved quota status across refresh

Added four focused regressions covering list/fetch refreshes × capacity/rate
limited failures. RED showed every refreshed state became `saved` while the
failure error remained. `remember` now preserves capacity/rate-limited status
and error only while a matching frozen, incomplete attempt exists; normal
refresh clears stale errors. A successful exact retry marks the attempt saved,
updates the revision, and clears the error.

Targeted result:

```text
TEST_DATABASE_URL=postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql npm test -- test/conversation-ui.test.ts -t 'preserves a'
4 passed
```

### Fix-round verification

```text
TEST_DATABASE_URL=postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql npm test -- test/conversation-ui.test.ts
  1 file, 38 tests passed

TEST_DATABASE_URL=postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql npm test -- test/conversation-ui-acceptance.test.ts
  1 file, 12 tests passed
```

Additional fix-round verification:

```text
TEST_DATABASE_URL=postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql npm test -- test/conversation-store.test.ts test/conversation-http.test.ts test/conversation-ui.test.ts test/conversation-ui-acceptance.test.ts
  4 files, 74 tests passed

npm run typecheck:ui
  passed

npm run typecheck
  passed

npm run test:smoke
  2 files, 19 tests passed

git diff --check
  passed after the final report append

TEST_DATABASE_URL=postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql npm test -- test/chat-ui.test.ts -t 'keeps the latest capability catalog when refresh metadata omits capabilities'
  1 passed (84 skipped)
```

The full 85-test chat UI suite had one unrelated/flaky failure in that same
capability-catalog refresh test (84 passed); its isolated rerun passed. No
conversation quota test failed. The initial full-suite invocation without
`TEST_DATABASE_URL` was not used as evidence.

## Fix round 2/5 — durable quota-failure state

RED: the new archive-list and delete-fetch regressions showed a failed 429
mutation becoming `saved` after refresh. The list/fetch append-retry
regressions likewise showed a concurrent refresh becoming `saved` while the
explicit retry request was still pending.

GREEN: the controller now keeps a quota-failure marker keyed by conversation
and mutation operation for creation, event append, archive/unarchive, and
delete. List, fetch, and event hydration preserve an unresolved quota status;
an explicit retry may show truthful `saving` while in flight, and a failed
retry restores `rate-limited`/`capacity`. Matching successful mutation clears
the marker and stale error; successful delete and controller disposal clear
the record's lifecycle state. Conflict, epoch, no-auto-retry, and frozen-body
behavior remain unchanged.

Targeted RED/GREEN result:

```text
TEST_DATABASE_URL=postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql npm test -- test/conversation-ui.test.ts -t 'preserves a rate-limited'
RED: 4 failed (archive-list, delete-fetch, append/list, append/fetch)
GREEN: 4 passed
```

### Fix-round 2 verification

```text
TEST_DATABASE_URL=postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql npm test -- test/conversation-ui.test.ts
  1 file, 42 tests passed

TEST_DATABASE_URL=postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql npm test -- test/conversation-ui-acceptance.test.ts
  1 file, 12 tests passed

TEST_DATABASE_URL=postgresql:///meridian_test?host=%2Fvar%2Frun%2Fpostgresql npm test -- test/conversation-store.test.ts test/conversation-http.test.ts test/conversation-ui.test.ts test/conversation-ui-acceptance.test.ts
  4 files, 78 tests passed on rerun

npm run typecheck:ui
  passed

npm run typecheck
  passed

npm run test:smoke
  2 files, 19 tests passed

git diff --check
  passed after the final report append
```

The first combined invocation had one transient fresh-browser assistant-event
failure (77/78); the unchanged combined rerun passed 78/78. No quota-state
test failed in either run.

Final post-review self-check after the creation-to-event marker correction:

```text
focused UI: 42/42 passed
real PostgreSQL/Chromium acceptance: 12/12 passed
combined quota/UI: 78/78 passed
npm run typecheck:ui: passed
npm run typecheck: passed
npm run test:smoke: 2 files, 19 tests passed
```
