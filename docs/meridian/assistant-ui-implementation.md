# MERIDIAN assistant-ui implementation and evidence

User goal: `/Users/goodwiinz/.codex/attachments/b731edfd-a473-4f29-a6a5-f61b68124803/pasted-text-1.txt`.
Started 2026-09-05 06:30 UTC; overnight deadline 2026-09-05 14:30 UTC.
Base: `8e625cc0db83ebc37ad62f2bc60f1d8feeec1d8c`; branch `codex/meridian-assistant-ui`.

## Scope and coordination

This task owns the Vercel AI SDK / assistant-ui integration, build configuration,
and its tests. The task “Review plan against file” owns runtime, surface, artifact,
CLI and evidence safety work, capability acceptance, and the shared requirement
matrix. Neither task's passing tests establish completion of the other's gates.

The user's September 5 goal explicitly selects AI SDK and maps both chat and
dashboard components. This supersedes the older plan's static/chat-only UI scope.
Implement the UI in isolation while live capability gates remain outstanding;
retain those gates before claiming whole-project completion. Existing visual
direction (teal, cream, system typography, operator desk) is reused.

## Global constraints

- The chatbot may select approved capabilities and collect typed inputs.
- Production replay, recovery decisions, and mutation authorization must remain model-free.
- The chatbot cannot approve actions or elevate its role.
- SDK tool approval must not replace the core mutation gate.
- After an uncertain posting, retain POST_OUTCOME_UNKNOWN and prevent automatic retry.
- Chat and dashboard must display the same authoritative run state by runId.
- Reconnecting must retrieve the existing run without starting another.
- Keep secrets and raw sensitive data out of persisted conversations, artifacts, logs, and telemetry.
- Use only authorized live actions; never synthesize human approval.
- Preserve existing dirty worktrees and separate journal/evidence directories.
- Do not merge, deploy, publish or perform destructive operations without authorization.

## Task 1: AI SDK chat boundary

Ownership: `src/server/chat.ts` (new), the `/chat` and new streaming chat route in
`src/server/http.ts`, `test/chat.test.ts` (new), package manifest and lockfile for
AI SDK dependencies only. Do not change runtime/service/CLI/artifact code or
shared existing test files. Coordinate any necessary interface extension.

Keep the legacy `/chat` JSON request/response working for existing callers, but
implement conversational inference/tool selection using Vercel AI SDK rather
than the OpenAI client directly. Add `/api/chat` for the AI SDK UI message stream
used by AssistantChatTransport. Both routes must use one caller-bound tool
execution path over `InvocationService`; neither may execute browser tools or
operator decisions. Keep auth/Host/Origin/body limits and static safe errors.

Pin compatible published `ai` v7 and provider packages. Preserve OpenAI and Azure
configuration compatibility using the existing environment variable names.
Keep the discovery SDK unchanged. Do not persist model messages or raw outputs.

Derive capability input schemas from `service.catalog('caller')`, validate again
through `service.invoke`, disable parallel calls and bound the conversational
step count. A capability invocation returns its run ID and started/status data;
do not report success from invocation acceptance. Status tools may only inspect
caller-visible runs and return safe structured projections. Do not put raw run
evidence, credentials or operator context in model tools. Do not trust client
system prompts, tool definitions, roles or tool results as server authority.

Require a valid Idempotency-Key for both routes. Each request permits at most
one new capability invocation; transport repeats use the same identity. Ensure
multiple proposed calls or changed tool arguments cannot cause multiple runs.
Prefer returning after tool execution so authoritative cards display results
without model fabrication; do not add an autonomous browser/model loop.

For streaming requests, accept validated user/assistant text history in AI SDK
UI message shape; safely handle displayed tool parts without accepting forged
client tool outputs as execution authority. Expose a small test seam for model
inference using AI SDK's supported model mock. No live target/model calls in
unit tests. Use actual stream/protocol output in tests, not a replacement API.

Check with focused tests: missing-input text, one approved catalog invocation,
streamed tool run ID, legacy response compatibility, caller-bound operator chat,
unknown/forged tools and client authority rejection, invalid input, same-key
duplicate/changed request behavior, safe error output and no automatic retry
after accepted run. Run full existing CI and artifact validation before commit.
Report exact commands, outcomes, concerns, files, and commit.

## Task 2: assistant-ui and dashboard

Ownership: new `src/server/ui/` components and CSS, static bootstrap and build
serving in `src/server/http.ts`, `package.json`/lockfile/UI TypeScript and build
configuration, new `test/chat-ui.test.ts`. Coordinate backend transport from
Task 1. Do not change runtime or shared tests without controller approval.

Use compatible pinned React, `@assistant-ui/react`, `@assistant-ui/ai-sdk`, and
provider/runtime dependencies. Use a small Vite build served by existing Express,
not a second production server or Next.js migration. Production CSP remains
restrictive; generated assets are same-origin and no inline scripts are needed.
Use existing teal/cream styling with responsive layouts and keyboard support.

Build the requested AssistantRuntimeProvider/useChatRuntime/AssistantChatTransport,
Thread/Message/Composer components and backend tool renderer for a reusable
CapabilityRunCard. No edit/regenerate/branch actions that can repeat mutations.
Label chat stop as stopping the response, not undoing a transaction. One stable
request key per user message, preserved across transport retries. Credentials
stay in page memory; reload/disconnect clears authentication and chat content.
Run identity may be restored via authenticated history without re-invocation.

Share one authenticated run-state cache between chat cards and dashboard using
existing polling endpoints. Poll pending runs; render network disconnection
honestly and allow read refresh without mutation. Support empty/error/loading
states. Build ordinary React components for CapabilityCatalog/invocation form,
RunHistory, RunDetail/StepTimeline, EvidenceViewer, OperatorSessionControls,
ApprovalPanel and EscalationCard. ResultCard must render typed table/decimal
outputs, business errors and unknown states directly from authoritative data.

Operator decisions use existing endpoint only when operator principal and live
intervention ID exist. Show exact action facts, expiry, approval/abort or bounded
repair controls appropriate to state; prevent double decisions. Never offer
retry for POST_OUTCOME_UNKNOWN. Evidence requests use authenticated headers,
validated path segments, inert text and masked images; revoke object URLs.
Display historical sensitive-value-unavailable state rather than fabricated data.

The catalog must make all seven requested functions visible with readiness
distinguished: approved/available versus missing or not authorized; do not expose
forbidden descriptors or falsely label missing functions accepted. Discovery
and replay history must remain distinguishable. Use existing run/evidence data;
coordinate any missing server projection rather than fabricate timelines.

Run actual bundled UI with deterministic local endpoint/model fixtures in
browser checks, clearly labelled offline. Verify request/response → run card →
dashboard agreement, approval authority/expiry, unknown no-retry, same message
idempotency, refresh/reconnect, signout/reload clearing, inert hostile content,
evidence auth, keyboard and 320/768/1024/1440 widths. Include build/typecheck in
repository CI and document exact setup/demo commands after integration.

## Task 3: integration and completion audit

Review each implementation diff for spec compliance and code quality, fix
confirmed findings, then run final local gates and browser checks. Coordinate
the reviewed runtime safety branch before live read verification. Use a fresh
private journal/evidence root and genuine model chat to invoke an approved read
capability through the bundled UI; verify result, run identity, evaluator, and
dashboard agreement. Do not make a write just for a UI checkbox.

Keep source-specific evidence: commit, request/run IDs, artifact version,
commands, sanitized results and limitations. Update this document and tell the
other task the verified UI status for its shared matrix. Final whole-project
acceptance also requires the other task's seven live artifact/replay pairs,
exceptional states, genuine operator approvals, comparator/provenance checks,
runbook/write-up, and hosted checks where publication is authorized.

## Requirement status

| Requirement | Owner | Evidence/status |
| --- | --- | --- |
| Seven genuine discovery/artifact/replay pairs | Coordinating task | 3/7 historically accepted; four write gates incomplete |
| Runtime safety, idempotency, unknown outcome, evidence | Coordinating task + shared integration | Base includes PR46; additional evidence/CLI audit underway |
| Vercel AI SDK typed caller chat | Task 1 | Pending |
| assistant-ui runtime and component map | Task 2 | Pending |
| Shared run state, approvals, evidence, accessibility | Task 2 | Pending |
| Live model/read UI invocation and exceptional path | Task 3 | Pending |
| Local CI/build/validate and diff checks | All | Baseline running |
| Review, setup, exact commands, write-up, handoff | Task 3 + coordinating task | Pending |

No full-completion claim is made by this branch until all goal requirements have
authoritative evidence. Offline fixtures and recorded evidence do not increase
the live accepted capability count.
