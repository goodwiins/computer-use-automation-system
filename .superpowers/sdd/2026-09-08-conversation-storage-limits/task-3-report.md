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
