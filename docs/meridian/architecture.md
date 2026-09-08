> Source: [Eraser document and editable diagram](https://app.eraser.io/workspace/ziyIb2vBMV2jgfB78FB4). Exported September 8, 2026; the architecture snapshot below is pinned to `7cd18b7`.

![MERIDIAN system architecture](../architecture.png)

# MERIDIAN — architecture and code walkthrough
Updated September 8, 2026 from merged `dev` commit `7cd18b778e409931b59281b5099972040e373b11`. This is a source architecture snapshot. The latest repository-recorded hosted acceptance is **4/7 capabilities**; this documentation update performs no new live rehearsal.

The model discovers a workflow and records a typed capability. A person reviews and promotes that artifact. Requests then replay it deterministically through the same guarded browser runtime. Chat also uses a model to understand requests; replay, recovery decisions, authorization, and native mutation dispatch remain model-free.

## 1. The current system
One Express process serves the capability API and a statically exported Next.js App Router interface using React and assistant-ui. Chat is the primary view; Activity exposes the catalog, direct invocation, run history, status, evidence, and operator decisions. A static `out/` preview alone cannot execute capabilities.

There are three distinct authority concepts: dashboard caller/operator access, execution context such as TELLER/SUPERVISOR, and a verified target session. A signed-in supervisor does not make every chat request a supervisor operation. Model chat always uses caller authority. Displayed role selection alone does not verify the target session or branch.

The optional local teller/supervisor login supports target sign-on readiness. API credentials remain server-side or in page memory as appropriate; build output contains no API secrets. Sources: [src/server/http.ts](https://github.com/goodwiins/computer-use-automation-system/blob/7cd18b778e409931b59281b5099972040e373b11/src/server/http.ts), [src/server/auth.ts](https://github.com/goodwiins/computer-use-automation-system/blob/7cd18b778e409931b59281b5099972040e373b11/src/server/auth.ts), [src/server/ui/session.tsx](https://github.com/goodwiins/computer-use-automation-system/blob/7cd18b778e409931b59281b5099972040e373b11/src/server/ui/session.tsx).

## 2. Request to authoritative run
1. The UI submits an explicit request through chat or a guided operation form.
2. Express authenticates the principal. `InvocationService`  checks capability approval, caller permissions, input contracts, requested execution role, and admission.
3. The journal reserves the signed request identity **before opening a browser**. Reusing an accepted key with the same request returns its original run.
4. The service constructs the shared runtime and starts discovery or deterministic replay.
5. The client follows the returned `runId`  through authoritative run status. An accepted asynchronous tool result is not proof of successful completion.
6. Native writes pause at a separately bound operator approval. Completion requires the operation's observed result checks.
There is one active execution and one journal authority owner, not a concurrent browser pool. Shutdown drains admitted work and browser cleanup before releasing ownership; uncertain cleanup retains authority for recovery.

| API | Responsibility |
| ----- | ----- |
| `GET /capabilities`  | Authorized catalog, availability and operation contracts |
| `POST /capabilities/:id/invoke`  | Replay an approved capability |
| `POST /capabilities/:id/discover`  | Explicit operator-supervised canonical discovery |
| `GET /runs`, `GET /runs/:id`  | Authorized history and authoritative run state |
| `POST /runs/:id/decision`  | Decision for the exact current intervention |
| `GET /runs/:id/evidence/:file`  | Authenticated safe evidence |
| `POST /api/chat`, `POST /chat`  | Streaming chat and legacy JSON chat |
| `GET /api/chat/request`  | Read-only recovery using the original request key |
Sources: [src/server/http.ts](https://github.com/goodwiins/computer-use-automation-system/blob/7cd18b778e409931b59281b5099972040e373b11/src/server/http.ts), [src/server/service.ts](https://github.com/goodwiins/computer-use-automation-system/blob/7cd18b778e409931b59281b5099972040e373b11/src/server/service.ts).

## 3. Chat and guided operations
`src/server/chat.ts` uses the Vercel AI SDK with OpenAI or Azure OpenAI. Automatic intent classification has no executable capability tools. It chooses a new invocation, a status question, or conversation from the message; the UI does not require a request-type selector.

A new explicit request exposes approved caller capability tools and `run_status`. Status exposes only `run_status`; conversation exposes no tools. At most one distinct capability can be attempted per chat request. Ephemeral, server-observed clarification can supply missing inputs for an unaccepted request; expired or restarted context requires restatement. The model cannot approve transactions, retry a run, or select supervisor context.

Guided forms cover transfer, opening a share, contact update, and supervisor hold using authenticated server contract metadata. Preview displays entered facts. Starting an operation invokes an approved available recording. Where the canonical transfer/update/hold recording is missing, an operator can explicitly start supervised discovery with a fixed server goal.

**“Discovery finished” is not “capability ready.”** A verified discovery writes a private draft under `ARTIFACT_DIR/drafts/<runId>.json`. The sequence is:

**private draft → provenance and safety review → artifact promotion → controlled idle activation → separately approved replay → verified acceptance evidence.**

The supplied UI screenshot shows the private-draft state and explicitly says no approved callable recording exists. It does not establish a successful posting or a new accepted capability pair. It also shows distinct access/execution/session-readiness fields; these must not be collapsed into one “authenticated” state.

Sources: [src/server/chat.ts](https://github.com/goodwiins/computer-use-automation-system/blob/7cd18b778e409931b59281b5099972040e373b11/src/server/chat.ts), [src/server/service.ts](https://github.com/goodwiins/computer-use-automation-system/blob/7cd18b778e409931b59281b5099972040e373b11/src/server/service.ts), [docs/meridian/runbook.md](https://github.com/goodwiins/computer-use-automation-system/blob/7cd18b778e409931b59281b5099972040e373b11/docs/meridian/runbook.md).

## 4. Discovery, artifact and replay
Discovery uses `src/agent/loop.ts` and `tools.ts`: observe the allowed frames, let the model choose a tool, resolve the target, then act through the policy boundary. `BrowserSurface.describeTarget` derives durable locator strategies from the live element before navigation can remove it. The recorder parameterizes the trace, applies the risk floor, and synthesizes the contract.

Artifacts are typed, versioned JSON validated by `src/artifact/schema.ts`. Schema-v2 includes server-bound credential references, typed table extraction, and select-by-value; schema-v1 remains supported. Schema version and capability version are separate. Unknown or malformed public inputs fail validation; server-bound credentials are excluded from public tool schemas.

Replay executes recorded steps without model decisions. Locator resolution uses ordered role, name-attribute, text, and CSS strategies, refusing unsafe ambiguity. Runtime detectors distinguish business outcomes, bounded recoverable conditions, and fatal errors. Success conditions and declared outputs are checked; native mutations also require the canonical completion checks.

Tenant overlays compose entry/default/locator deltas at load time. Base identity, exact version, app identity and origins are checked. Both base and overlay must be approved for unattended composed replay.

The original `lookup-member-balance` and `open-subaccount-to-confirmation` artifacts are **local mock examples**. The latter stops before commitment. MERIDIAN separately implements guarded native posting; the mock example's stopping point does not describe every MERIDIAN operation.

Sources: [src/artifact/schema.ts](https://github.com/goodwiins/computer-use-automation-system/blob/7cd18b778e409931b59281b5099972040e373b11/src/artifact/schema.ts), [src/artifact/recorder.ts](https://github.com/goodwiins/computer-use-automation-system/blob/7cd18b778e409931b59281b5099972040e373b11/src/artifact/recorder.ts), [src/artifact/overlay.ts](https://github.com/goodwiins/computer-use-automation-system/blob/7cd18b778e409931b59281b5099972040e373b11/src/artifact/overlay.ts), [src/replay/executor.ts](https://github.com/goodwiins/computer-use-automation-system/blob/7cd18b778e409931b59281b5099972040e373b11/src/replay/executor.ts).

## 5. Shared runtime, approval and dispatch
`src/runtime/run.ts` constructs `ControlSession`, `RunLogger`, `BrowserSurface`, and `GuardedSurface` for both CLI and service execution. Profiles and canonical contracts bind requested members, shares, decimal money, review facts, server credentials, and completion outputs.

The guarded browser checks effective risk from the live page, allowed origins and frames, native destination/method/body/token/control, and operator facts. A transaction approval is single-use, bound to the current action, and expires after at most five minutes. Facts are checked again immediately before dispatch. Durable dispatch intent must be recorded before an irreversible native action.

Risk approval permits approve/abort; a stuck intervention permits its matching bounded recovery/abort. Neither is a model decision. Artifact promotion is a different approval from a banking transaction.

API decisions require operator authority. Subject mode rejects self-approval and keeps other subjects owner-isolated; cross-subject dashboard approval is not solved by simply choosing another operator. Standalone CLI approval uses status/approve/refuse over a same-user Unix socket. TTY checks do not authenticate a human against other processes running as that OS user. The original local CDP console remains a control seam, not a production authentication boundary.

Sources: [src/runtime/run.ts](https://github.com/goodwiins/computer-use-automation-system/blob/7cd18b778e409931b59281b5099972040e373b11/src/runtime/run.ts), [src/runtime/approval.ts](https://github.com/goodwiins/computer-use-automation-system/blob/7cd18b778e409931b59281b5099972040e373b11/src/runtime/approval.ts), [src/surface/guarded.ts](https://github.com/goodwiins/computer-use-automation-system/blob/7cd18b778e409931b59281b5099972040e373b11/src/surface/guarded.ts), [src/escalation/approval-cli.ts](https://github.com/goodwiins/computer-use-automation-system/blob/7cd18b778e409931b59281b5099972040e373b11/src/escalation/approval-cli.ts).

## 6. Durable identity, recovery and unknown outcomes
The default `Journal` is a signed filesystem store. Optional `PostgresJournal` requires `RUN_JOURNAL=postgres`, `DATABASE_URL`, a stable `JOURNAL_HMAC_KEY`, and an authenticated completed one-way cutover marker. PostgreSQL authenticates run rows and dispatch intent, admits one owner UUID, and never falls back to filesystem state.

After response loss, `GET /api/chat/request` uses the **original Idempotency-Key** to find an accepted request without launching work: 404 means no accepted request; 503 means lookup unavailable. Direct invocation/discovery recovery uses the original body/key with `lookupOnly: true`, checking owner, capability, and signed recovery identity. Status aliases cannot authorize direct invocation recovery.

Restart does not resume browser actions. Unfinished pre-dispatch work becomes interrupted; uncertain post-intent work becomes terminal `POST_OUTCOME_UNKNOWN`, retaining quarantine. Unknown posting is never automatically retried, resumed, or reclassified. Journal import and fenced recovery preserve signed identities and unknown outcomes.

Sources: [src/runtime/journal.ts](https://github.com/goodwiins/computer-use-automation-system/blob/7cd18b778e409931b59281b5099972040e373b11/src/runtime/journal.ts), [src/runtime/open-journal.ts](https://github.com/goodwiins/computer-use-automation-system/blob/7cd18b778e409931b59281b5099972040e373b11/src/runtime/open-journal.ts), [src/runtime/postgres-journal.ts](https://github.com/goodwiins/computer-use-automation-system/blob/7cd18b778e409931b59281b5099972040e373b11/src/runtime/postgres-journal.ts), [docs/meridian/runbook.md](https://github.com/goodwiins/computer-use-automation-system/blob/7cd18b778e409931b59281b5099972040e373b11/docs/meridian/runbook.md).

## 7. Evidence and conversation storage
Evidence uses structured safe events, redacted JSONL/results, and safe screenshots or metadata-only capture. MERIDIAN masks dynamically observed values as well as supplied secrets. Screenshots require their own masking controls; text redaction alone is insufficient. Historical projections withhold input/output values. The evaluator verifies authenticated saved-run evidence within its recorded scope.

A successful fresh balance request can compose an exact number-mode member inquiry for display identity. Its private child run is excluded from public history/recovery; restored history does not recover the member name.

Conversation storage is separate from run authority. PostgreSQL plus subject tokens enables owner-scoped metadata, events, and run links without message text by default. An alternative local-login mode uses stable local conversation subjects. Optional `CONVERSATION_TEXT_KEY` enables AES-256-GCM user/assistant text retention with database key binding. Typed private details are retained if included in saved text.

Restored messages are plain display-only text, excluded from model requests and execution/approval. Quotas, rate limits, archives and deletion tombstones bound storage. Deleting a conversation does not remove journal records, evidence, or unknown-outcome quarantine. Run-journal PostgreSQL and conversation PostgreSQL are independently enabled.

Sources: [src/evidence/safe-event.ts](https://github.com/goodwiins/computer-use-automation-system/blob/7cd18b778e409931b59281b5099972040e373b11/src/evidence/safe-event.ts), [src/evidence/logger.ts](https://github.com/goodwiins/computer-use-automation-system/blob/7cd18b778e409931b59281b5099972040e373b11/src/evidence/logger.ts), [docs/meridian/conversations.md](https://github.com/goodwiins/computer-use-automation-system/blob/7cd18b778e409931b59281b5099972040e373b11/docs/meridian/conversations.md).

## 8. Recorded live acceptance
| Capability | Repository-recorded hosted acceptance |
| ----- | ----- |
| Sign-on | Accepted discovery/replay pair |
| Member inquiry | Accepted discovery/replay pair |
| Member record | Accepted discovery/replay pair |
| Open share | Accepted discovery/replay pair |
| Funds transfer | Implementation exists; complete accepted pair outstanding |
| Contact update | Implementation exists; complete accepted pair outstanding |
| Supervisor hold | Implementation exists; complete accepted pair outstanding |
**4/7 recorded accepted pairs.** A private draft, completed UI flow, green source checks, or local mock cannot increase this count. A fresh presentation rehearsal remains separate. Historical evidence rows retain their original source baseline; use the linked ledger for individual outcomes. Sources: [README.md](https://github.com/goodwiins/computer-use-automation-system/blob/7cd18b778e409931b59281b5099972040e373b11/README.md), [docs/meridian/live-evidence.md](https://github.com/goodwiins/computer-use-automation-system/blob/7cd18b778e409931b59281b5099972040e373b11/docs/meridian/live-evidence.md), [docs/meridian/implementation-progress.md](https://github.com/goodwiins/computer-use-automation-system/blob/7cd18b778e409931b59281b5099972040e373b11/docs/meridian/implementation-progress.md).

## 9. Code map and verification
| Area | Main entry points | Existing checks |
| ----- | ----- | ----- |
| API and chat | `http.ts`, `service.ts`, `chat.ts`  | `chat.test.ts`, `chat-ui.test.ts`, `server-discovery.test.ts`  |
| UI and readiness | `src/app`, `src/server/ui`  | `session-readiness.test.tsx`, `ui-readiness.test.ts`  |
| Shared runtime and safety | `run.ts`, `contracts.ts`, `guarded.ts`  | `meridian.test.ts`, `runtime-lifecycle.test.ts`, `browser-startup-cleanup.test.ts`  |
| Artifact engine | `schema.ts`, `recorder.ts`, `executor.ts`  | `schema.test.ts`, `recorder.test.ts`, `meridian-artifacts.test.ts`  |
| Durable authority | `journal.ts`, `postgres-journal.ts`, `journal-maintenance.ts`  | `postgres-journal.test.ts`, `journal-maintenance.test.ts`  |
| Conversations | `conversations.ts`, `conversations.sql`, `conversation-http.ts`  | `conversation-store.test.ts`, `conversation-http.test.ts`, `local-conversations.test.ts`  |
| Approvals and evidence | `approval.ts`, `approval-cli.ts`, `safe-event.ts`, `scripts/evaluate-run.ts`  | `approval-cli.test.ts`, `evidence-eval.test.ts`  |
Use Node 22 matching CI. `npm run setup` installs locked dependencies and Chromium. `npm run test:smoke` exercises real local Chromium/tsx and evidence checks. `npm run ci` runs backend/UI typechecks and the full test suite; the pretest builds Next.js. Also run `npm run validate` and `git diff --check` for delivery. PostgreSQL suites require `TEST_DATABASE_URL`.

These are verification instructions, not checks executed by this Eraser update. Hosted checks must match the delivered head; live acceptance requires separate authenticated target evidence. Source: [package.json](https://github.com/goodwiins/computer-use-automation-system/blob/7cd18b778e409931b59281b5099972040e373b11/package.json).
