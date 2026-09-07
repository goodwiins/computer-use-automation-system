# MERIDIAN backend: capacity and conversation persistence

Audit base: `8950d772e515886800093ec79c44d5009bd16e67` (`origin/dev`, PR #92).
This is additional backend scope. The PDF demonstration remains the delivery priority.
The [report](../meridian/report.md) and [requirement matrix](../meridian/implementation-progress.md)
both currently say **4/7 accepted pairs**: sign-on, inquiry, member record/balance, and open share.
Transfer, contact update, hold, exceptional-state pairs and the integrated balance/transfer/exception
demonstration remain unfinished. Earlier per-row 3/7 statements describe historical evidence.
No benchmark, source test, deployment check or saved chat increases live acceptance.

## Focused audit

| Priority | Confirmed source / observation | Consequence and next change |
| --- | --- | --- |
| P1 before concurrency | `src/server/service.ts:20-23,66-68`: one `active` run, one completion promise; `src/runtime/journal.ts:49-83`: one-process filesystem lock, startup recovers all active records | Extra API replicas cannot share this journal or safely execute independently. Introduce shared ownership and deduplication before changing the one-run limit. Never make separate per-worker journals authoritative. |
| P1 before multiple users | `src/server/http.ts:36-40`, `src/server/service.ts:17,132`: bearer tokens resolve to the shared roles `caller` and `operator` | Every caller has the same ownership identity. Individual conversation/run access needs stable authenticated subject IDs and role checks. A teller/supervisor role selector is not authentication or target authorization. |
| P1 migration boundary | `src/runtime/approval.ts:16-43`, `src/surface/guarded.ts:1041-1096`: approvals and exact facts live in memory; dispatch persistence is synchronous and followed by native dispatch | A PostgreSQL implementation must await durable intent, preserve page revalidation across the new async boundary, and reject stale owner/approval epochs. A lease cannot revoke a target POST already authorized in an old browser. |
| P1 persistence boundary | `src/server/chat.ts:150-168,218-237`: history arrives in the request; past request IDs reconstruct authoritative run context, but there is no thread store | Retain only an allowlisted conversation history projection and linked run IDs. Persisting UIMessage JSON, model text, tool inputs or live results would retain sensitive values and could recreate old intent. |
| P2 before sustained traffic | `src/server/service.ts:20,76,147-152`: completed entries keep inputs/results/runtime closures in `live`; `history()` projects every record and reads files synchronously | Memory and history work grow with all completed runs. Add bounded volatile result retention and paginated history with durable safe metadata; raw results become explicitly unavailable after expiry/restart. |
| Required invariant | `src/runtime/journal.ts:149-169`, `src/server/service.ts:56-65`: HMAC request identity, immutable terminal states, capability-wide unknown block | Import exact old identities and unknown outcomes. Never relax the broad unknown block during migration merely to enable concurrency. A new key, new thread, archive or deletion is not reconciliation. |

The trace includes HTTP/chat callers, service invocation, runtime construction, approval, guarded
native dispatch, journal recovery, `safeResult`/`recordedStructure`, replay and existing journal,
chat, history, approval and lifecycle tests. The benchmark adds no runtime API or UI change.

## Deployment audit (read-only, September 7 UTC)

SSH confirmed `/opt/meridian/current` points to `/opt/meridian/releases/8138dc4`.
The application is active with zero recorded automatic restarts; display, window manager and
VNC services are active; Caddy is inactive. The API listens on `127.0.0.1:4180` and VNC on
loopback. This is not public HTTPS or authenticated end-to-end acceptance. The application
cgroup reported 139,300,864 bytes current memory and 166,776,832 peak; these are idle observations,
not browser-load measurements. Host memory reported 3,834 MiB and no swap.

The historical deployment README lives outside this branch at
`/Users/goodwiinz/.codex/worktrees/interface-ai-lightsail/deploy/lightsail/README.md`.
Its recorded allocation is 2 vCPU / 4 GB / 80 GB; the AWS API query failed because the local
AWS session expired, so current bundle, firewall, snapshots and cost are **not verified**.
No host files, services, locks, credentials, target transactions or infrastructure were changed.
Current `dev` HTTP code is loopback-only; the older Lightsail branch's public-origin work must
be reconciled explicitly rather than assuming it was merged. The local UI at port 5173 is a
separate environment and says nothing about the deployed release.

## Agreed architecture, still proposed

One UI/API service, initially four isolated Node/Chromium workers, PostgreSQL as the authority
for run state, ownership, request identity, approval decisions, dispatch intent and conversations,
and private S3 storage for sanitized evidence. Each worker has one active browser and its own
ephemeral browser profile/display/handoff channel. No shared CDP port, credential-bearing
profile directory or process-global member/session state. Start with one enabled worker during
migration; enable four only after the conflict, crash and capacity gates pass.

PostgreSQL row locks can coordinate reservation and claims; `SKIP LOCKED` is suitable for
queue consumers, not a substitute for business conflict serialization. This follows the
[PostgreSQL locking documentation](https://www.postgresql.org/docs/current/sql-select.html#SQL-FOR-UPDATE-SHARE).
Use a job table initially; no extra broker or autoscaler is needed for four workers.

Conflict keys must cover the target environment, operator session, member and every affected
account; transfers acquire both account keys in deterministic order. Persist keyed HMACs,
not raw member/account values. Start conservatively with exclusive member/session ownership,
including reads that would invalidate a pending review. If the target only supports one active
session per configured operator, that operator remains serialized; four browsers alone cannot
promise four simultaneous automations. Keep the existing capability-wide unknown quarantine.

An ownership timeout does **not** release a potentially active browser to a replacement writer.
For an uncertain owner, stop/fence the old process and session first; if physical revocation cannot
be established, quarantine its conflicts. Any durable dispatch intent with no verified completion
is terminal `POST_OUTCOME_UNKNOWN`; never redispatch it. Do not label this exactly-once posting.
Target authorization must be checked in the actual browser session; UI supervisor approval does
not upgrade a teller session. Live role takeover is not currently established.

## Retention contract

Retained conversations preserve chronology and result links across restarts, with a clear
"values withheld" state. They do not promise an exact transcript containing member data.

| Durable, allowlisted | Volatile only |
| --- | --- |
| Opaque thread, message, run and subject IDs; role; timestamps; archive state; revision/sequence | Free-form user/model text, names, balances, amounts, contact fields, member/share numbers, arbitrary titles |
| Server-authored event kinds/templates, pinned capability ID/version, safe typed field structure, terminal/outcome codes | Raw UIMessage/tool payloads, arguments, result values, DOM/HTML, URLs containing identifiers |
| Request and exact-approval-context HMACs; approval IDs, expiry, actor ID, decision, owner epoch; dispatch intent | Passwords, target sessions, cookies, tokens, native form bodies, raw approval facts |
| Run-linked sanitized evidence manifest with hashes and authenticated access | Unchecked screenshots, attachments, model-generated summaries |

Reuse `safeResult` and `recordedStructure`; do not rely on regex or model-based redaction of an
arbitrary transcript. Display fixed server templates for omitted messages. Reopening a thread
only loads history/status tools. A fresh operation requires explicit new intent, fresh inputs,
a fresh key and, for a mutation, a separately bound live approval.

Archive is the default removal action; explicit deletion removes conversation content and links
subject to the agreed retention policy. It does not cascade to safety records, dispatch intent,
idempotency tombstones or unknown runs. Do not silently recycle deleted request identities.
Raw details already exist only in memory today; encryption alone does not satisfy a promise
not to persist them. Disable body logging, crash/core dumps and swap for sensitive worker/API
processes when deploying this contract; inspect evidence before upload.

The same rule limits durable queues: store only job metadata and request HMACs. Deliver raw
inputs over an authenticated transient channel to the claimed worker and discard them after
completion. Loss of that channel/process interrupts a pre-intent run; do not reconstruct its
inputs from a saved conversation. Resume requires restated inputs/new explicit intent, and
only after prior execution is proven stopped. An acknowledged run ID survives a lost response;
same-key requests remain status/deduplication, not a second dispatch. Durable unattended retry
of raw transaction payloads is outside this retention contract.

## Phased implementation backlog

Each row is a reviewable PR boundary against `dev`, with focused tests, full repository gates
and exact-head CI before handoff. No production merge or deployment is implied.

| Phase | Deliverable and dependency | Acceptance gate |
| --- | --- | --- |
| B0 — this PR | Offline worker benchmark, current audit and this plan. Reuse existing lookup fixture/replay/logger; no new runtime abstractions or infrastructure. | One/four worker measurements with the same workload, output/screenshot assertions, observed browser overlap, sampled Node+Chromium RSS, bounded failure cleanup, and a two-worker CI check. It is a measurement tool, not the proposed worker service. |
| B1 — conversation persistence | PostgreSQL migration and concrete conversation store; authenticated subject/role mapping; create/list/read/archive/delete endpoints with pagination and optimistic revisions. Store safe event templates and run references. Coordinate the additive contract with the UI owner before touching `chat.ts` or auth integration. | Real temporary PostgreSQL tests: restart survival, cross-subject read/link/delete denial, concurrent append/dedupe, archive/delete behavior, privacy canaries in stored rows and logs, reload creates zero invocations/decisions. Legacy shared-role data stays operator-only until explicitly mapped. |
| B2 — authoritative runs | Migrate journal reservation, aliases, terminal state/dispatch intent to PostgreSQL with unique constraints and conditional transitions. Start with one worker. Change `beforeDispatch` callers to await storage and revalidate after the await. Import signed historical journal records and aliases in a non-executing maintenance mode. | Real DB race tests for duplicate keys and changed facts; corruption rejects import; exact unknown states and identity mappings survive import/restart; uncertain DB commit blocks dispatch/retry; no dual writers. Disable the old service before migration. Rollback must not restore an older journal and enable writes. |
| B3 — isolated execution and approvals | Separate API and worker entry points; atomic claim/epoch, per-resource conflict ownership, transient input delivery, durable single-use approval decisions tied to live worker context, controlled shutdown and result expiry. Depends on B2. | Competing workers, duplicate delivery, owner loss before/after intent, expiry/abort/duplicate approval races, old-browser freeze/resume, contradictory completion, session collision and API restart. Assert actual fixture POST counts; unknown is terminal and not requeued. Prove owner fencing before enabling replacement writers. |
| B4 — private evidence | Store only validated sanitized objects in S3; DB manifest maps run and content hash; API authorizes each retrieval; archive/delete policy has no audit cascade. May overlap B3 after B2 contracts stabilize. | Private-object and cross-subject denial tests, upload-failure states, no raw text/PII/secret canaries, hash verification and isolated restore rehearsal. Enable [S3 Block Public Access](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html); bucket encryption is additional protection, not sanitization. |
| B5 — four-worker rollout | Run the constrained capacity exercise below, then review the exact release and deployment diff. Reconcile existing Lightsail/public-origin work; configure HTTPS/authenticated handoff and target operator/session limits. | One then four workers on separate non-conflicting read-only fixtures, realistic sustained load, OOM/timeout/restart and recovery tests, resource/cost measurements, safe rollback. Live target approvals and PDF acceptance remain separate gates. |

B1 is the next product backend PR; B0 deliberately avoids a throwaway filesystem conversation
store or an unused database interface. Existing dependencies cannot provide a PostgreSQL client;
add one pinned client with B1's actual integration, not before it has a consumer.

## Capacity measurement

```sh
npm run setup
npm run benchmark:workers -- --workers 1,4,4,1 --iterations 10
# On an isolated Linux display matching deployment:
npm run benchmark:workers -- --workers 1,4,4,1 --iterations 10 --headed
```

The script launches independent Node workers, synchronizes their start, and gives each a local
GET-only fixture on a fresh loopback port. Each iteration starts fresh Chromium and executes
the existing six-step lookup artifact through `GuardedSurface` and `runReplay`, validates exact
synthetic outputs and screenshot evidence, then closes the browser and removes temporary
evidence. It forwards no API/target credentials or CDP settings to children. There is no live URL
override, model call, shared production journal, target login or target mutation.

Reported run time includes browser startup, replay, evidence capture and browser close. Batch
time starts at the barrier after fixture/import setup and includes worker completion. RSS is a
250ms sample of all worker process trees, including Chromium and local fixtures, excluding the
parent harness. Shared pages can be counted more than once and short peaks can be missed.
CPU count and memory fields describe the host, not container limits. Small-sample p95 is a
descriptive statistic, not an SLO; warm OS caches and concurrent machine work affect results.
Repeated 1/4/4/1 ordering makes some order effects visible; do not infer linear speedup.

The proposed **1 vCPU / 2 GB per worker remains unvalidated**. Docker is installed locally but
its daemon is unavailable, so this PR does not claim a resource-constrained run. Next measure
each worker in its own Linux cgroup/container at that allocation, including Node, headed Chromium,
display and handoff processes, against one versus four concurrent workers. Record memory peak,
CPU throttling, completed work, latency distribution, evidence bytes, failures and approval-wait
occupancy over sustained runs. Reject the allocation if it OOMs or misses an agreed latency target;
no target or budget has been agreed yet. Include API/PostgreSQL, backups, storage and model use
separately before any capacity or monthly-budget commitment. Do not run load tests on live writes.

## Ownership and delivery status

Backend checkout: `/Users/goodwiinz/.codex/worktrees/782e/meridian-backend-foundation`, branch
`codex/meridian-backend-foundation`. No open PRs were present at the initial conflict check.
The concurrent task **MERIDIAN remaining project capabilities** owns the local teller/login,
Next.js/assistant-ui, intent and member-name work; its checkout/services were not edited or
restarted. Backend storage APIs should preserve authoritative `runId` rendering and additive
contracts. No chat UI implementation is included here.

Implemented by this PR: B0 only. PostgreSQL, persistent conversations, shared workers and S3
are proposed, not deployed. PDF live acceptance remains 4/7. Benchmark results and verification
are recorded alongside the final PR; passing them does not establish B1–B5 or a live role takeover.
