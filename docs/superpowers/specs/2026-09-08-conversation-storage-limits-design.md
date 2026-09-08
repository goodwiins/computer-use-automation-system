# MERIDIAN conversation storage limits

Approved direction: add durable per-subject conversation quotas and write-rate accounting before shared deployment. This extends the B1 conversation contract without persisting transcript text or weakening subject ownership. Express and PostgreSQL remain authoritative. No deployment, protected-demo restart, cloud spend, production database operation, or live transaction is in scope.

## Baseline and ownership

Start from reviewed UI-roles head `7fb01a7f82ea8db1a18ca256a4ab411b38a176a2` in an isolated Ubuntu worktree. Preserve the saved-conversations owner's work and integrate only its independently reviewed exact head when adding user-facing handling. The storage-limits PR remains a separate dependency against `dev`; it must state its stack rather than implying its dependencies are merged.

The owner key is the authenticated subject UUID already stored as `meridian_conversations.owner_id`. Every count and rate bucket is per subject, never per token or role. Operators and callers receive the same limits, and one subject's state or failures must not reveal or affect another subject. Legacy principals still have no conversation API access.

## Fixed contract

The following values and semantics are fixed:

- At most 128 conversation rows per subject, counting active, archived, and deleted tombstone rows.
- At most 512 retained event rows per conversation.
- At most 4096 retained event rows across all conversations owned by a subject.
- One durable token bucket per subject for successful conversation mutations: burst 20, refill 1 token per second, one token per non-retry mutation.
- Exact create and append retries return their original success without checking or consuming capacity or rate tokens.
- Capacity failures are HTTP 507 with exactly `{"error":"Conversation quota exceeded"}`.
- Rate failures are HTTP 429 with exactly `{"error":"Conversation write rate limit exceeded"}` and `Retry-After: 1`.
- Capacity is checked before rate accounting, so an operation blocked by both always returns the fixed 507 failure.
- Deletion removes retained events and releases those event counts. It marks the conversation deleted and does not reduce the subject's conversation-row count.
- Tombstones never expire and are never reused. No expiry worker, compactor, or administrative reset is added.

Existing 400, 404, and 409 behavior remains intact for invalid input, inaccessible rows, stale revisions, and identifier/content conflicts. A 507 or 429 response is not success and must never be silently retried by the UI.

## Durable metadata and migration

Add one metadata-only table keyed by owner UUID:

```sql
CREATE TABLE IF NOT EXISTS meridian_conversation_subject_quotas (
  owner_id uuid PRIMARY KEY,
  conversation_count integer NOT NULL CHECK (conversation_count >= 0),
  event_count integer NOT NULL CHECK (event_count >= 0),
  rate_tokens double precision NOT NULL CHECK (rate_tokens >= 0 AND rate_tokens <= 20),
  rate_refilled_at timestamptz NOT NULL
);
```

The table contains no transcript, member data, token, role, run output, approval fact, or arbitrary JSON. Existing conversation and event tables remain authoritative for row identity. Migration runs inside the existing advisory-lock transaction, creates the additive table, and initializes/reconciles each owner's conversation and event counts from legacy rows. Re-running migration preserves `rate_tokens` and `rate_refilled_at` for existing quota rows while reconciling counts. It must not delete, expire, truncate, or rewrite legacy conversations, events, or tombstones.

Legacy datasets already over a new limit remain readable and deletable. They are not silently trimmed. A new create or append that would increase an exhausted dimension fails 507 until event deletion creates event headroom; tombstone-retained conversation capacity cannot be recovered by ordinary deletion.

## Transaction and lock protocol

Every mutating store method uses one PostgreSQL transaction and one client. It first ensures the caller's quota row exists, then locks that row `FOR UPDATE`. Only after that lock may it lock or inspect the target conversation for mutation. This quota-row-first ordering is shared by create, archive/unarchive, delete, and append.

Within that transaction:

1. Resolve ownership, tombstone, stale-revision, and identifier/content conflicts without exposing foreign state.
2. Return an exact create or append retry before quota and rate checks. Event retry equality covers event ID, conversation, kind, role, and run ID; `expectedRevision` may be stale on a retry.
3. For create or append, check the relevant capacity limits. Per-conversation retained event count is read while the conversation row is locked; the subject retained-event count comes from the locked quota row.
4. Refill the locked token bucket from PostgreSQL `clock_timestamp()`, capped at 20. If fewer than one token is available, fail with the fixed 429 response. Otherwise consume exactly one token.
5. Apply the mutation and counter delta atomically, then commit. Any conflict, database error, or rolled-back mutation also rolls back token and counter changes.

Creates increment `conversation_count`. Appends increment `event_count`. Deletes count and remove the target's events, subtract exactly that number from `event_count`, increment the tombstoned conversation revision, and leave `conversation_count` unchanged. Archive and unarchive change neither count. Reads do not lock or consume rate tokens.

Concurrent mutations for one subject serialize on its quota row. Mutations for different subjects remain independent. Existing unique constraints remain the final defense for cross-subject or cross-conversation identifier races; a losing transaction must surface the established generic conflict and roll back quota/rate changes.

## HTTP and UI behavior

The server's typed request error path may carry a small allowlisted response-header map so the rate error can set `Retry-After: 1`; unexpected database errors remain generic 500 responses. No quota counters, bucket values, owner UUIDs, or foreign existence details are returned.

After the saved-conversations owner delivers an independently reviewed exact commit, the conversation adapter must distinguish these outcomes:

- 507: storage capacity is full and the attempted item was not saved. The text must not claim that deleting a conversation restores conversation capacity.
- 429: saving is temporarily rate-limited, the attempted item was not saved, and the client did not automatically retry it.
- 409: the existing reconciliation/conflict behavior remains.
- 503: storage remains unavailable rather than capacity- or rate-limited.

The frozen client-generated UUID/body is retained so a user-initiated retry is an exact retry. No timer, backoff loop, hidden replay, or second POST is introduced. UI tests must prove the displayed state is truthful and the request count remains one on 507/429.

## Verification

Required tests use a real isolated PostgreSQL schema on explicit `TEST_DATABASE_URL`, with separately acquired clients or pools where concurrency is under test. They cover:

- migration of pre-limit active, archived, tombstoned, and event rows; repeat migration; over-limit legacy compatibility; rate-state preservation;
- boundaries at 128 conversations, 512 events per conversation, and 4096 events per subject;
- same-subject concurrent creates/appends/deletes, exact same-ID races, different-ID races, and rollback counter/token integrity;
- distinct-subject progress and isolation while one subject is locked, full, or rate-limited;
- burst 20, refill 1/second using database time, persistent bucket state across store/pool reopen, and exact retry bypass at exhausted capacity/rate;
- deletion event-count release, retained tombstone count, no resurrection, and no tombstone expiry;
- exact HTTP statuses, bodies, and `Retry-After`, including capacity-before-rate precedence;
- real app/store/PostgreSQL integration plus UI adapter tests that prove 507/429 are shown as unsaved without automatic retries;
- raw-data canaries and metadata-only schema inspection.

Run focused database suites during TDD. Before handoff run the full repository gate, validation, smoke suite, UI typecheck where applicable, and `git diff --check`. Obtain task-scoped independent review and a broad final review. Hosted checks must be reported only for the exact pushed PR head.
