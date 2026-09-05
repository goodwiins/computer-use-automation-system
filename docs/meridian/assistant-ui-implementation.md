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
| Vercel AI SDK typed caller chat | Task 1 | Implemented at 5c5df38; independent review approved after two fixes. Real AI SDK protocol with offline model fixtures; live model gate pending |
| assistant-ui runtime and component map | Task 2 | Implemented at 3c7528d; independent review approved after three fixes |
| Shared run state, approvals, evidence, accessibility | Task 2 | Eleven final offline focused checks pass; independent review approved; live gates pending |
| Live model/read UI invocation and exceptional path | Task 3 | Pending |
| Local CI/build/validate and diff checks | All | Task 1 at 7eeb447: 285 tests / 18 files, typecheck, artifact validation, and diff checks pass. New UI/build gates pending |
| Review, setup, exact commands, write-up, handoff | Task 3 + coordinating task | Pending |

No full-completion claim is made by this branch until all goal requirements have
authoritative evidence. Offline fixtures and recorded evidence do not increase
the live accepted capability count.

## UI acceptance map

| Flow | Observable result | Proof to retain |
| --- | --- | --- |
| Connect as caller/operator | Only authorized catalog/results; role follows server principal | Browser request + rendered role; no credentials in web storage or URL |
| Ask for missing input | Plain clarification; no invocation | Model fixture + zero service invocation count |
| Ask for balance | Tool card has real runId; pending becomes structured result | Actual AI SDK stream + same GET run in card/dashboard |
| Pending transaction | Caller waits; operator sees exact current facts and expiry | Offline real Approval class plus decision endpoint/browser test |
| Wrong/expired/duplicate decision | 403/409; no second decision/action | Existing core tests plus UI error/refresh check |
| Unknown posting | Prominent investigation instruction; no retry/regenerate action | Unknown fixture and zero POST after reload/refresh |
| Transport response lost | Same message key; no second invocation | Duplicate request integration check |
| Chat response stopped | Explicit wording; run remains observable in history | Controlled stream cancellation and run polling check |
| Server disconnected | Stale/unavailable state; no false terminal success | Browser network failure and recoverable read refresh |
| Historical run | Missing sensitive values remain unavailable | Restart projection + ResultCard assertion |
| Hostile text/evidence | Inert text; authorized image blob; no script/HTML execution | CSP, browser dialog/pageerror, storage and request checks |
| Keyboard/responsive | All actions reachable; no overflow at required widths | 320, 768, 1024, 1440 screenshots/checks and keyboard actions |

The SDK tool stream is a conversational record. The runtime journal is the
execution record. Run IDs connect them; rendered SDK tool completion alone
does not prove a browser run completed.

Research references: [AI SDK adapter/version table](https://www.assistant-ui.com/docs/runtimes/ai-sdk/overview),
[v7 transport](https://www.assistant-ui.com/docs/runtimes/ai-sdk/v7),
[backend tool renderers](https://www.assistant-ui.com/docs/tools/tool-ui),
[thread](https://www.assistant-ui.com/docs/api-reference/primitives/thread),
[composer](https://www.assistant-ui.com/docs/api-reference/primitives/composer).

## Audit observations

- At `7eeb447`, `npm audit --omit=dev` reports three existing moderate advisories
  through Express/body-parser/qs. No AI SDK advisory was reported. Task 2 will
  assess a narrow compatible dependency repair and rerun the audit.
- Chat transport retries use the existing durable invocation journal: same key
  and same invocation identity returns the existing run; changed capability or
  arguments returns 409. There is no persisted conversation or chat-response cache.
- Coordinating task reports reviewed PR47 merged at `2c7f4ed`; integrated locally into
  this branch at `6353741` before Task 2 started.

Task 1 review fixed SDK default logging of raw provider errors and legacy mixed
tool responses hiding an accepted run ID. Scoped re-review approved `5c5df38`;
128 combined chat/legacy tests and typecheck passed after the fixes. One minor
regression-test assertion improvement is retained for the final audit.

## Adaptation boundary and remaining coupling

The chat change reuses the existing Express routes, catalog conversion,
`InvocationService`, deterministic executor, approvals, journal, and evidence
access. Vercel AI SDK handles one bounded interpretation/tool-selection step;
the new UI consumes run IDs and existing authenticated read/decision endpoints.
It introduces no model into replay or operator authorization. The React build
and backend tool renderers are Task 2 work until verified below.

The broader core is not yet demonstrably portable by configuration alone.
`config/app-profiles/meridian.json` supplies routes, form rules, detectors, and
mask selectors, but target-specific choices still live in shared TypeScript:
`src/runtime/profile.ts` selects policy by app ID; `src/server/service.ts` applies
MERIDIAN contracts and operator context; `src/runtime/run.ts` wires transfer
facts and a hardcoded observed member-table selector from
`src/runtime/contracts.ts`; `src/replay/executor.ts` validates MERIDIAN transfer
outputs. These are concrete coupling points for a future target adapter.

This branch preserves those reviewed behaviors. Moving them into a generic
plugin framework would add scope without proving another target; a second
concrete target should drive that extraction. No second-target portability
proof or completed full-surface adaptation is claimed here.

## Live UI acceptance procedure (pending execution)

1. Coordinate exclusive hosted-target use, then launch this exact reviewed
   branch with existing local credentials and a new private evidence/journal
   directory. Keep the journal HMAC stable and retain its request identities.
2. Connect as caller through the bundled UI. Ask the real configured model for
   one explicit approved read capability; record its request identity and run ID
   privately. A `202`/tool output proves acceptance only.
3. Wait for the authoritative run to finish, compare the structured result in
   the chat card and dashboard, and run the evidence evaluator against that run.
   Save sanitized booleans/counts plus source SHA and artifact version.
4. Refresh/reconnect through authenticated reads; verify history keeps the same
   run ID and no new invocation occurs. Reload must clear credentials and chat.
5. Exercise an authorized exceptional read path if supported. Keep offline
   approval/unknown fixtures distinct from live operator decisions. Do not
   perform a write or approve one merely to complete the UI check.

The final report must replace these pending steps with actual evidence or exact
blockers. Prior September 4 dashboard evidence is historical and does not test
this AI SDK/assistant-ui implementation.

## Required component connections

| UI component | Existing authority / data source | Acceptance boundary |
| --- | --- | --- |
| AssistantRuntimeProvider, Thread, Message, Composer | useChatRuntime + AssistantChatTransport → `/api/chat` | Server owns tools; stopping text is not cancelling a transaction |
| CapabilityRunCard | Backend tool output runId → shared authenticated `/runs/:id` cache | Accepted/started remains distinct from completed |
| ResultCard | Typed authoritative run result | Decimal values remain strings; historical unavailable data is explicit |
| CapabilityCatalog and invocation form | Authorized `/capabilities` descriptors and pinned versions | Missing/not-authorized functions remain visible only as non-actionable coverage labels |
| RunHistory, RunDetail, recorded event timeline | `/runs`, `/runs/:id`, safe authorized event evidence | Discovery versus replay is explicit; missing raw step IDs are not fabricated |
| EvidenceViewer | Authenticated evidence route | Inert text/JSON and masked image blobs; no credential-bearing URLs |
| ApprovalPanel, EscalationCard | Live intervention context and decision endpoint | Operator-only exact decision/expiry; no retry of an unknown posting |
| Operator session controls | Server principal and allowed role on direct invocation | Credentials stay in memory; chat remains caller-bound |

Implementation paths and final check evidence are recorded after Task 2 review.

Task 2 implemented at `c25214d`. Final focused browser/transport/legacy-dashboard
selection: 7 passed, with backend/UI typecheck, production build, artifact
validation, audit (0 vulnerabilities), and diff checks passing. Earlier full
suite passed 293 tests; a later controlled-stop fixture timed out after 294
passes, was corrected, and passed the final focused run. The final integrated
whole-suite result remains a Task 3 gate.

Independent Task 2 review found over-limit transcripts, polling that stops after
repeated identical failures, and a credential draft retained on disconnect.
All three fixes passed scoped re-review at `3c7528d`. A stale local validation
alert after a later successful send is retained for the Task 3 audit correction. The production bundle is approximately
722 kB minified / 212 kB gzip and emits Vite's size warning; no policy was loosened
or arbitrary warning threshold raised. Browser CSP checks pass after disabling
Zod's optional JIT probe through its published configuration.
