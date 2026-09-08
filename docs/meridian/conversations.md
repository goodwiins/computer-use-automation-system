# Conversation storage

MERIDIAN can expose an opt-in PostgreSQL conversation API for individually authenticated subjects. Express remains the API authority. The database stores conversation and event identifiers, fixed enums, revisions, sequence numbers, timestamps, archive state, and deletion tombstones. It does not store message text, titles, arguments, member data, live output, approval facts, credentials, or evidence URLs.

## Local isolated PostgreSQL

Use PostgreSQL 14 or newer and a disposable cluster. These commands bind only to localhost and use synthetic local credentials:

```sh
export MERIDIAN_PG_ROOT="$(mktemp -d)"
initdb -D "$MERIDIAN_PG_ROOT/data" --auth=trust --username=meridian_local
pg_ctl -D "$MERIDIAN_PG_ROOT/data" -l "$MERIDIAN_PG_ROOT/postgres.log" -o "-h 127.0.0.1 -p 55432" start
createdb -h 127.0.0.1 -p 55432 -U meridian_local meridian_local
export DATABASE_URL='postgresql://meridian_local@127.0.0.1:55432/meridian_local'
export TEST_DATABASE_URL="$DATABASE_URL"
```

`npm test -- test/conversation-store.test.ts test/conversation-http.test.ts test/server-startup.test.ts` creates a random schema inside `TEST_DATABASE_URL` and removes only that schema. It never drops the database.

Stop the disposable cluster when finished:

```sh
pg_ctl -D "$MERIDIAN_PG_ROOT/data" stop
```

## Server configuration

Conversation storage requires both `DATABASE_URL` and `SUBJECT_API_TOKENS`. `SUBJECT_API_TOKENS` is a JSON array whose entries contain a canonical UUID subject, a `caller` or `operator` role, and a unique printable ASCII bearer token of 32–200 characters:

```sh
export JOURNAL_HMAC_KEY='synthetic-local-hmac-key-at-least-32-characters'
export SUBJECT_API_TOKENS='[{"subjectId":"11111111-1111-4111-8111-111111111111","role":"caller","token":"synthetic-local-subject-token-000001"}]'
export DATABASE_URL='postgresql://meridian_local@127.0.0.1:55432/meridian_local'
npm run serve
```

The server runs the idempotent SQL migration before it listens. Invalid subject configuration, a failed connection, or a failed migration aborts startup and closes the pool, journal, and generated UI assets. There is no in-memory fallback.

Subject mode accepts only the configured subject bearer tokens. Legacy caller/operator tokens and local teller demo-session credentials do not work in subject mode. A subject's role controls capability authority; its UUID controls conversation and run ownership. Operators can access only their own subject's conversations and runs.

To rotate a token, replace the token while keeping the same `subjectId`, restart the server, and retire the old token. Tokens must remain unique and are never written to PostgreSQL or the journal.

## Fixed storage limits and write responses

Each subject may retain at most 128 conversation rows, including archived and deleted (tombstone) rows. Each conversation may retain at most 512 events, and a subject may retain at most 4096 events across all conversations. Conversation writes use a durable PostgreSQL token bucket with a burst of 20 successful mutations and a refill rate of 1 token per second, measured using PostgreSQL time. Reads do not consume tokens.

When a create or append would exceed a fixed capacity, the API returns exactly `507` with `{"error":"Conversation quota exceeded"}` and no retry header. When the write bucket is empty, it returns exactly `429` with `{"error":"Conversation write rate limit exceeded"}` and the server-authored `Retry-After: 1` header. Capacity is checked before rate consumption, so a full capacity returns `507` even when the bucket is also empty. Counts, bucket values, owner identifiers, SQL details, and foreign-row existence are never included in these responses. Other established `400`, `404`, `409`, and `503` responses remain unchanged.

An identical create retry for an existing owner/ID, or an identical append retry for an existing event ID and content, returns the original success even when capacity or rate is exhausted. The retry bypasses both capacity and token consumption; a changed body or ownership remains a conflict or not-found response. The server and clients do not add automatic retries, timers, or backoff.

## HTTP contract

All routes require `Authorization: Bearer <subject token>`. IDs are client-generated lowercase UUIDs. Request bodies and query strings reject unknown fields.

| Method and path | Input | Response |
| --- | --- | --- |
| `POST /conversations` | `{"id":"10000000-0000-4000-8000-000000000001"}` | `201` conversation metadata; an identical owner/ID retry returns the same record |
| `GET /conversations` | `archived=false\|true`, `limit=1..100`, optional exclusive UUID `after` | `{conversations,nextCursor}` ordered by UUID; defaults are `archived=false`, `limit=50` |
| `GET /conversations/:id` | Lowercase UUID path | Conversation metadata |
| `PATCH /conversations/:id` | `{"archived":true,"expectedRevision":0}` | Updated metadata with an incremented revision; stale revision is `409` |
| `DELETE /conversations/:id` | `{"expectedRevision":0}` | `204`; events are removed and the ID becomes a tombstone |
| `POST /conversations/:id/events` | `{"id":"20000000-0000-4000-8000-000000000001","kind":"message_omitted","role":"user","expectedRevision":0}` | `201` event with allocated sequence |
| `GET /conversations/:id/events` | Nonnegative sequence `after`, `limit=1..100` | `{events,nextCursor}` ordered by sequence; defaults are `after=0`, `limit=50` |

`message_omitted` accepts no `runId` and returns the fixed `content` value `Message text was not saved.`. `run_linked` requires a subject-owned run UUID and returns fixed `content` `Linked run.` with a safe projection:

```json
{
  "id": "20000000-0000-4000-8000-000000000002",
  "sequence": 2,
  "kind": "run_linked",
  "role": "assistant",
  "runId": "30000000-0000-4000-8000-000000000001",
  "content": "Linked run.",
  "run": {
    "runId": "30000000-0000-4000-8000-000000000001",
    "capability": "meridian-member-inquiry",
    "version": "1.0.0",
    "state": "success",
    "result": { "status": "success", "sensitiveValuesUnavailable": true }
  }
}
```

The safe run projection can include validated structure whose values are `withheld`. It never includes inputs, member identity, raw outputs, interventions, or evidence paths. Cross-owner or missing runs and conversations return `404`. A subject request made while storage is disabled returns `503`; legacy principals receive `403`.

An event page deduplicates its at-most-100 linked run IDs and reads them in one bounded authenticated journal batch; duplicate events remain in their original sequence. Only one linked-run batch is admitted per subject at a time. An overlapping event-page read or linked-run append for that subject returns `429` with `Linked-run projection is busy` instead of waiting on journal authority; another subject is admitted independently. Rejected reads and appends do not change conversations, runs, aliases, or runtime state.

Archived conversations are read-only until unarchived and are the normal UI removal mechanism. Explicit deletion removes stored events but keeps an opaque tombstone so stale retries cannot resurrect an ID. It does not delete or change journal records, idempotency aliases, evidence, run status, or unknown-outcome quarantine. Apply journal/evidence retention separately according to the existing run policy.

Deletion releases the retained event quota for the subject, but it does not restore conversation-row quota: the tombstone continues to count toward the subject's 128 conversation rows and its ID cannot be reused.

The quota migration is additive and idempotent. It first takes an `EXCLUSIVE` lock on the quota table, then drains and locks `meridian_conversations` before its index, followed by `meridian_conversation_events`, before reconciling the source rows. This ordering gates quota-aware writers and drains an already in-flight legacy transaction without a source-table lock inversion. It preserves existing bucket state on repeat migrations, keeps archived and tombstoned rows, and does not trim over-limit legacy data. Such legacy data remains readable and deletable; new creates/appends that would increase an exhausted dimension return `507` until event deletion creates headroom. The migration may drain a legacy writer already in progress, but after quota-aware writes begin do not start or continue an older writer. If rollback is required, disable conversation writes while retaining the additive quota table, then resolve the migration before re-enabling writes.

Saved events are display references only. They are never replayed into `/chat` or `/api/chat`, never start an invocation, and never make an approval decision. Clients must use the existing run and chat APIs for those actions.

On `SIGINT` or `SIGTERM`, the server rejects new runtime work, closes active HTTP connections, drains the invocation service, ends the PostgreSQL pool, releases the journal lock, and removes its generated UI build.
