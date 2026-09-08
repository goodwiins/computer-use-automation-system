# B1: individually owned, privacy-safe conversations

Approved direction: proceed from B0/PR94 into working PostgreSQL conversation storage and individual authentication. This spec makes that authorized scope concrete; no further routine implementation approval is required. Express remains the authoritative API. No infrastructure deployment, cloud spending, target operations or UI redesign is included.

## Baseline and dependencies

Start from dev `8950d77`, then explicitly stack PR93 head `c7bba9e` before adapting service ownership. Its balance/linked-inquiry behavior must retain the same subject. PR93 is not assumed merged. Do not edit/restart the served `interface-ai-local-teller-login` checkout. Its unpublished Next static-serving/local teller session and automatic chat-intent changes remain separate integration work. `/capabilities` must keep its existing role-string `principal` field.

Use Node 22 and PostgreSQL 14 or newer. Local PostgreSQL 14.23 is available; use only an isolated test cluster/schema. Add a pinned `pg` client and its development types when the concrete store is implemented. No ORM, broker, unused store interface, or filesystem conversation implementation.

## Identity and authority

Add optional `SUBJECT_API_TOKENS`, a JSON array of `{subjectId, role, token}`. `subjectId` is a canonical UUID, `role` is `caller` or `operator`, and token is a unique printable ASCII bearer secret of 32–200 characters. Reject malformed/empty configuration and duplicate subjects/tokens with generic errors that cannot echo credentials. A token rotation keeps the same subject UUID. Tokens are not stored in PostgreSQL/journal or returned by APIs.

When subject credentials are configured, accept only those tokens: no fallback to legacy caller/operator or demo teller-session tokens. Otherwise retain the existing two-token legacy behavior. Persist a subject run owner as `subject:<uuid>`, independent of role/token, and preserve existing legacy request digests and caller strings. HTTP principal objects are server-created, not accepted from request bodies. `/capabilities` returns its existing `principal: 'caller'|'operator'` and adds `subjectId` only in subject mode.

All subject-mode principals can read/list/link/decide only their own runs, including operators. Operator role remains additionally required for decision endpoints and privileged direct capability/target-role execution. Cross-person supervisor assignments require a later explicit grant design; B1 does not invent a global subject-data administrator. Legacy operators retain access to legacy runs only; they cannot read subject-owned runs. Subjects cannot inherit legacy caller history. Preserve capability-wide unknown quarantine without exposing another owner's record.

Chat always has caller capability authority, including when the authenticated subject is an operator, but retains that subject's ownership in catalog/invoke/get, status-reference binding, historical request lookup, both legacy and streaming handlers, and PR93 identity child runs. No saved conversation is fed into model invocation or approval. Direct/status/idempotency APIs remain authoritative.

## Durable data and API

Opt-in PostgreSQL storage uses `DATABASE_URL` and requires subject-token configuration. Startup migrates the concrete schema before listening; any configuration/connection/migration failure closes resources and fails startup, without echoing the connection string. Legacy mode remains usable without PostgreSQL. Authenticated conversation requests without enabled storage return 503; legacy principals never get conversation access.

Tables hold only opaque UUIDs, fixed enums, sequence/revision numbers and timestamps. Conversations have owner UUID, archived flag, revision, created/updated timestamps and a deletion tombstone. Events have a conversation FK, event UUID, sequence, kind (`message_omitted` or `run_linked`), role (`user` or `assistant`), optional run UUID and timestamp. Only `run_linked` may/must have a run ID. No free-form title, text, metadata, arguments, live outputs, target URL, credentials, PII or approval facts. Reject unknown fields at both HTTP and store boundaries. Templates are server-authored at read time, not supplied by clients.

Conversation routes:

| Method/path | Strict input | Result |
| --- | --- | --- |
| POST `/conversations` | `{id: UUID}` | 201 conversation; identical owner/id creation retry returns same conversation; deleted IDs cannot be resurrected |
| GET `/conversations` | `archived=false|true` (default false), `limit=1..100` (default 50), optional `after=UUID` | `{conversations, nextCursor}` ordered by UUID, owner-filtered; cursor is exclusive, no offset pagination |
| GET `/conversations/:id` | UUID | conversation metadata |
| PATCH `/conversations/:id` | `{archived: boolean, expectedRevision: nonnegative integer}` | updated conversation, revision increment; stale revision 409 |
| DELETE `/conversations/:id` | `{expectedRevision: nonnegative integer}` | 204; remove events and tombstone conversation; never alter journal/runs/aliases/unknown state |
| POST `/conversations/:id/events` | `{id: UUID, kind, role, runId?: UUID, expectedRevision}` | event with sequence; identical event-ID/content retry succeeds even with old expectedRevision; conflicting reuse 409; first check owner and not deleted |
| GET `/conversations/:id/events` | `after=nonnegative sequence` (default 0), `limit=1..100` (default 50) | `{events, nextCursor}` ordered by sequence, safe templates and resolved safe run metadata only |

Every lookup/mutation is owner-scoped; foreign/missing/deleted IDs return 404. Archive is reversible and is the default removal behavior documented for UI integration; archived threads are read-only until unarchived. Explicit deletion removes conversation event content/links, retaining only an opaque tombstone to prevent stale request resurrection. It has no FK or cascade to safety records. Thread/event IDs are client-generated UUIDs to support safe retries; event sequence allocation, revision checks, archive/delete and event dedupe serialize under the conversation row lock within one transaction/client. Concurrent identical append produces one event; changed-content same ID and stale revision fail without partial writes. No client-supplied owner is accepted.

Before appending a run link, the HTTP layer verifies the run is exactly owned by the subject. Read projection resolves that linked run through existing journal/service APIs and `safeResult`, returning only ID/capability/version/state and safe result/structure with values unavailable. Never return live `inputs`, member identity/name, raw outputs or approval details from a saved-history endpoint. Missing safe results remain unavailable; reads never invoke a runtime or decision. PostgreSQL retains only the run ID; the existing authenticated journal/evidence remains run authority until B2.

## Verification and rollout boundaries

Real PostgreSQL tests must exercise separate connections, restart/reopen persistence, concurrent append/dedupe, archive/delete/tombstones, cross-subject denial and raw-data canaries. Tests use an isolated randomly named schema on an explicitly supplied `TEST_DATABASE_URL`, and remove only that owned schema. Missing test DB configuration must not silently pass the required suite. CI supplies a PostgreSQL service. Smoke tests remain database-independent.

Test all auth/run seams across subjects with the same role: history/detail/evidence, direct invoke, both chat endpoints, same idempotency keys, status aliases, PR93 identity child ownership, operator checks, legacy-data isolation and token rotation. Keep no-history-invocation and terminal unknown behavior. Use TDD, task-scoped independent spec/quality review, final whole-branch review, full repository gates and exact-head hosted CI.

The outcome is a usable opt-in backend API, not a rendered conversation sidebar, durable worker queue, four-worker service, or PostgreSQL run authority. Those stay in B2–B5. Live PDF acceptance remains 4/7.
