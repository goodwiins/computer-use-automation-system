# MERIDIAN assistant-ui implementation and evidence

## Current integration checkpoint — September 6

The reviewed UI/AI SDK branch is integrated with dev
`cfccec5f64c7174e363e495428ecf27e70002d03` (PR67 approval safety) on
`codex/meridian-assistant-ui-integration`. Source `cdee438` passes the combined
644 tests across 20 files, both typechecks, production build, artifact validation,
and dependency audit (zero vulnerabilities). The only merge conflict was adjacent
test imports; both were retained.

The current dev versions of `src/server/service.ts`, `src/runtime/approval.ts`
and the escalation implementation are unchanged. The bundled approval regression
now consumes the actual `publicIntervention` projection: visible transaction facts
remain reviewable, hidden body/token and short URL credentials stay absent, and
the UI sends only the current approval ID and decision. No client approval model
or alternate execution authority was introduced.

This is a separate PR integration, not an AWS update or new live acceptance run.
The source-specific live read evidence below remains produced by `681ab82`.
Overall accepted capability pairs remain 3/7, and remote human handoff and four
write acceptance pairs remain separate gates. Older local-only status and test
counts below are historical checkpoints, not the current integration result.


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

## Verified integration status

Source `681ab82a25aa9238b4ac15a542dc92b55d53adb1` integrates reviewed
Task 1 `5c5df38`, Task 2 `3c7528d`, Task 3 correction `fa934f4`, and reviewed
discovery-contract source `e507e8af` through dev merge `245ba838`.

Subsequent local integration `3cc0ee4827d798ad8dfe887dd231af20b5ab9090`
includes independently reviewed discovery/recovery repair
`90ce880701251631e317c99d1f53170301e98f3c` and shared documentation
checkpoint `254ac519`. The combined branch passes `npm run ci`,
`npm run validate`, `npm audit --audit-level=moderate`, and `git diff --check`:
391 tests across 19 files, both typechecks, production build, artifact validation,
and zero dependency vulnerabilities. Included recovery regressions cover both
discovery and replay, refuse mutation/approval controls and post-intent recovery,
and require guarded recovery support without invoking the model or escalation.
These are offline safety checks; no additional hosted invocation was made.
The three live phases below remain evidence for source `681ab82`.

Local integration `34f59619c25bade62e652c476af1911df7da4451` adds reviewed
CLI fault-option repair `0baf8df24e5d09a8be3996778afed53a4b221df9`. The same
combined gates pass with 404 tests / 19 files and zero vulnerabilities. CLI
regressions cover validated scenario forwarding, malformed-option rejection,
same-key deduplication/conflict, and unchanged historical no-fault identity.
No new hosted run or live acceptance is inferred from these offline checks.

Local integration `1585de917e0a8fe6174eec6c5f4a39459aebe825` adds independently
reviewed visibility repair `b15a2ad` and evaluator repair `9a83e24`. The final
combined gate passes both typechecks, build, 413 tests / 19 files, artifact
validation, zero dependency vulnerabilities, and diff check. An initial suite
run collided with another worktree's fixture server on port 4199 (412 passed,
one failed with EADDRINUSE); the unchanged source passed after coordinating
exclusive use of that port. This is recorded as local test interference.

The exact synthetic evaluator counterexamples that previously passed now fail
closed: duplicate classification retains the mutation and reports duplicate
classification, downgrade, and mutation-without-intent violations; absent
mutation metadata produces an unknown/incomplete verdict. Both closed native
absent-member discovery/replay journals were independently HMAC-authenticated
and re-evaluated with the repaired reducer: each passes with 9 attempts and
zero intents, matching public query parameters, distinct bound request keys,
and unchanged journal/log hashes. Their producer remains `0baf8df`; this is
local re-evaluation, not a new target run or write acceptance. The UI timeline
was task/final-reviewed at `41b9ab`; live UI evidence remains at `681ab82`.

| Requirement | Verified result / remaining boundary |
| --- | --- |
| AI SDK caller chat and assistant-ui | Genuine configured Azure model invoked an approved read through the production bundle; authoritative card/dashboard result agreement verified |
| Shared run state, evidence, approval controls, accessibility | Offline bundled browser checks pass; live reads prove history/reconnect and typed results; live mutation approval remains a separate gate |
| Exceptional read | Separate direct inquiry observed `business_outcome / NO_SUCH_MEMBER`; evaluator passed |
| Model-free replay | Fresh process without provider credentials/configuration invoked the approved read through the direct UI form; evaluator passed |
| Integrated local gates | At `1585de9`: both typechecks, build, 413 tests / 19 files, artifact validation, dependency audit (0 vulnerabilities), and diff check pass |
| Seven discovery/artifact/replay pairs | Coordinating task owns the complete matrix; this UI verification does not add write acceptance or complete the four write gates |
| Publication / hosted checks | This task made no push, PR, remote merge or deployment; branch-head hosted checks remain outside this local result |

No whole-project completion is claimed: 3/7 capability pairs are accepted. The
four write artifact/replay pairs and genuine operator approvals remain
incomplete. Remaining exceptional states, mutation comparator/provenance checks,
and the shared runbook/write-up remain the coordinating task's gates.

## Final audit corrections

`fa934f4` clears a prior local draft-validation alert in the existing transport
preparation callback after the next request validates. The ineffective Composer
`onSubmit` handler was removed. The bundled browser regression first failed
because the old alert remained, then passed with zero POSTs for the rejected
4001-character draft, exactly one POST for the next valid draft, and no stale
alert. Normalization and request-key behavior are unchanged.

The provider-error regression now asserts that `console.error` was never called.
Serializing an Error produced `{}` and could conceal the original SDK default
logger defect. Reviewed production logger handling remains unchanged.

## Source-specific live evidence

All three phases ran sequentially on source `681ab82` using approved v1.0.0
artifacts, port 4197, separate fresh private journals and request identities,
and the caller allowlist restricted to sign-on, member inquiry and member record.
The existing synthetic member was read only from the authorized private input;
its old failed-transfer request identity was not reused. Provider credentials
were loaded privately from the existing configuration. No raw transcript,
member/share/contact/balance values or operation keys are committed here.

| Phase | Run ID | Observed authoritative result | Evaluator |
| --- | --- | --- | --- |
| Genuine model chat → member record | `bc63c854-0781-4f24-bcb7-c0d57ade1d65` | success; typed table valid; 30 rows; chat card and dashboard share run/state and all returned values | pass; 10 attempts; 0 mutation intents; 0 violations/incomplete |
| Fresh provider-disabled server → direct member record | `18427423-fe11-4ee7-ae46-398bd6f1eb84` | success; typed table valid; 30 rows; dashboard values agree | pass; 10 attempts; 0 mutation intents; 0 violations/incomplete |
| Separate direct inquiry with synthetic negative candidate | `0e013cb4-9f31-496a-8a54-8e278d801e9d` | business_outcome / NO_SUCH_MEMBER, observed live | pass; 9 attempts; 0 mutation intents; 0 violations/incomplete |

Each phase sent exactly one application POST and zero decision POSTs. The chat
request key equaled its user message ID. Refresh, reload with manual credential
entry, and disconnect/reconnect restored the same single run without another
POST or invocation. Reload cleared authentication and chat; browser storage was
empty and browser page errors were zero. Every server exited 0 through graceful
shutdown, all owned UI browsers closed, and port 4197 was confirmed closed before
the coordinated live window was released.

A separate local-only restart then reopened the first completed journal using
its unchanged HMAC and no provider credentials. The original run returned in
history with **Historical sensitive values are unavailable**. Authenticated
result and safe-event evidence rendered (67 events, two evidence GETs), with
zero POSTs, empty chat/storage, and an unchanged SHA-256 of the completed journal
record before/after startup and shutdown. A private Node child-process spawn
counter observed zero server subprocess launches. That server exited 0 and its
UI browser closed. This durable server-restart check is distinct from browser
reload and from the fresh model-disabled replay above.

The model-disabled phase used a new server process with provider configuration
and credentials omitted from its environment. `createRuntime`/`executeReplay`
have no model dependency. This proves provider-independent replay with the
configured direct path; network-level model egress blocking was not enforced
or measured. The two successful reads were separate observations of current
state, not a transaction before/after comparator.

Authenticated local journal records plus complete safe JSONL logs were passed
to `evaluateRun`; an SDK tool completion alone was never counted as completion.
Private phase summaries retain source SHA, run IDs, artifact versions and
counts/booleans, alongside masked screenshots. Request identities and HMACs
remain in separate private configuration files with mode 0600. They live under ignored
`evidence/meridian/assistant-ui-task3-private/`; inputs, journal HMACs and server
configuration stay private. The full command/output report is
`.superpowers/sdd/assistant-ui-implementation/task-3-report.md`.

## Component connections verified

| Component / source | Authority and observed behavior |
| --- | --- |
| `chat.tsx`: AssistantRuntimeProvider, Thread, Message, Composer | `useChatRuntime` + AssistantChatTransport → `/api/chat`; server defines tools; stop affects the response, not the transaction |
| `session.tsx`: RunProvider | One authenticated cache over `/runs` and `/runs/:id` shared by chat/dashboard; polling, failure recovery, manual refresh and session cleanup |
| `dashboard.tsx`: CapabilityRunCard / ResultCard | Tool supplies run ID; server supplies current state/version and typed table/decimal values; live agreement verified |
| CapabilityCatalog / invocation form | Authorized descriptors populate inputs; all seven coverage labels are visible, three available here, remaining four unavailable; direct replay uses its own request key |
| RunHistory / RunDetail / StepTimeline | Discovery/replay identity and safe recorded evidence; absent raw step identifiers are explained rather than fabricated |
| `evidence.tsx`: EvidenceViewer | Authenticated validated paths; inert JSON/JSONL and masked image blobs; offline tests verify auth, hostile content and URL cleanup |
| ApprovalPanel / EscalationCard | Existing operator intervention/expiry authority; offline tests cover disabled expired/duplicate decisions and unknown no-retry; no live operator decision was made here |
| `main.tsx`: session controls | Server principal, memory-only credentials, clearing on disconnect/expiry/pagehide/reload; live manual reconnect verified |

Offline bundled tests also cover 320/768/1024/1440 layouts, keyboard controls,
CSP, inert hostile content, transport bounds, uncertain-response request-key
preservation, stopping the stream, polling recovery, and historical sensitive
values being unavailable. These are offline fixtures, not live mutations.

## Build, serve and demo

From this checkout, using Node 22 and installed project dependencies:

```sh
npm ci
npx playwright install chromium
npm run ci
npm run validate
npm audit --audit-level=moderate
git diff --check
```

For an already configured private `.env`, explicitly load the file. Configure
the API credentials, stable journal HMAC and MERIDIAN operator settings in that
file; keep it private. Choose a fresh evidence directory for a new acceptance
series and retain its HMAC and identities if restarting that series.

```sh
npm run build
PORT=4197 EVIDENCE_DIR=evidence/meridian/private-ui-demo \
CALLER_CAPABILITIES=meridian-sign-on,meridian-member-inquiry,meridian-member-record \
node --env-file=.env --import tsx cli.ts serve --profile meridian
```

Open `http://127.0.0.1:4197`, connect with the caller token and request an explicit
read using known inputs. For direct replay, open **Invoke an approved capability
directly**, select the read and supply its exact parameters. Approval remains
operator-owned; do not use a mutation as a UI demonstration. Stop the server
with Ctrl-C when finished.

`npm run serve` builds then invokes `tsx cli.ts serve`; it does **not** load a
file-based `.env` by itself. Direct CLI serving also requires the built assets.

The reproducible offline browser demo/check is:

```sh
npm run build
npx vitest run test/chat-ui.test.ts
```

The private acceptance harness used these exact commands after coordinating
exclusive hosted-target access; its inputs/configuration are intentionally not
published with the repository:

```sh
node --import tsx evidence/meridian/assistant-ui-task3-private/acceptance.ts chat
node --import tsx evidence/meridian/assistant-ui-task3-private/acceptance.ts replay
node --import tsx evidence/meridian/assistant-ui-task3-private/acceptance.ts missing
# Local-only history/evidence read; no hosted-target invocation:
node --import tsx evidence/meridian/assistant-ui-task3-private/restart.ts
```

## Remaining coupling and limitations

The integration reuses Express, catalog conversion, InvocationService,
deterministic execution, approvals, journal and evidence. AI SDK performs one
bounded interpretation/tool-selection step. It adds no model to replay or
authorization and no second capability execution path.

The core is not yet demonstrably portable by configuration alone. The MERIDIAN
profile supplies routes/form rules/detectors/masks, while shared TypeScript still
contains target choices: `src/runtime/profile.ts` selects policy by app ID;
`src/server/service.ts` applies contracts/operator context; `src/runtime/run.ts`
wires transfer facts and the member table contract; `src/runtime/contracts.ts`
contains observed target structure; `src/replay/executor.ts` validates transfer
outputs and selects guarded detector recovery for MERIDIAN. A second concrete target should drive any extraction. This work proves
no second-target portability.

The production JS bundle is 732.19 kB minified / 215.07 kB gzip and retains Vite's
standard >500 kB warning. No speculative splitting or relaxed warning threshold
was added. Browser checks cover native keyboard semantics and layout, not a
separate screen-reader or axe session. Offline approval/unknown fixtures do not
prove a hosted write or genuine human decision.

## Task 4: Recorded step timeline

Run details now project recognized `log.jsonl` events into a human-readable,
accessible ordered timeline. Static labels and typed allowlisted metadata show
recorded ISO timestamps, sequence/file order, step and action lifecycle,
attempts, discovery turns, safety decisions and terminal events. Raw step IDs,
page strings, tool arguments, errors and unknown fields never become timeline
content. Malformed lines, unknown events, duplicate sequences, sequence gaps,
invalid fields and legacy entries are omitted or qualified with explicit
incompleteness counts; no missing transition, retry, result or posting outcome
is inferred.

The authenticated evidence GET starts only after native run details open.
Active runs refresh every second only after the prior read finishes; closing the
details, changing the run or disconnecting aborts the pending read and clears the
next timer. Completed and historical runs remain still and provide a native
manual refresh. A failed refresh retains the last rendered entries with an
alert, absent logs state that no timeline is available, and logs over 50
recognized entries show the newest page with an exact total and an older-events
control. The implementation adds no POST, dependency, server or logger path.

Bundled offline browser coverage renders replay steps/actions and discovery
turns, receives active additions through authenticated GETs only, rejects
hostile and malformed metadata, exercises local pagination, retains historical
data through refresh failure, reports missing logs, and proves non-overlapping
polling stops on close and disconnect. Desktop and 320 px captures have no
horizontal overflow. The full local gate passes both typechecks, the production
build, and 406 tests across 19 files; the existing bundle-size warning remains.

This UI work made no hosted request, live mutation, approval or deployment. It
does not change the source-specific live acceptance boundary: 3/7 capability
pairs remain accepted. The four write artifact/replay pairs and genuine operator
approvals remain incomplete, and `POST_OUTCOME_UNKNOWN` remains non-retryable.

## Final local handoff checkpoint

At user-requested finish, source `c89f3d45152215074d56be53eae2004d1eea33fe`
integrates reviewed evaluator lifecycle repair `5d710702923dc2b924ba40510c0b62d29b918819`.
Both typechecks, production build, all 418 tests across 19 files, artifact
validation, dependency audit (zero vulnerabilities), and diff checks pass.
The fixed fixture port was reserved for this run and released afterward.

Independent synthetic checks reject array-valued action, action status, discovery
status, and terminal code, plus the unsupported discovery failure status, as
unknown. The earlier duplicate-classification case fails and missing mutation
metadata remains unknown. The closed native not-found discovery/replay pair still
authenticates and passes with nine attempts and zero mutation intents each;
request identities are bound and journal/log hashes remain unchanged. This
checkpoint made no hosted request.

Overall live acceptance remains **3/7**. Transfer, open share, update member, and
supervisor hold still require genuine discovery/artifact/replay acceptance with
approved operations and resulting-state evidence. The original selected transfer
pair includes a non-OPEN share; selecting an eligible pair and approving its exact
posting are separate outstanding steps. No approval is inferred from silence.
The old uncertain posting remains frozen and must not be retried.

The branch remains local and unpublished. Shared documentation is owned by
“Review plan against file”; its pending final checkpoint was not silently
integrated or represented as reviewed here. Setup and demo commands above remain
the handoff instructions.

## Authorized Vercel UI-only preview

After the local handoff, the user explicitly authorized a UI-only deployment.
URL: https://meridian-core-ui-preview.vercel.app
Deployment: `dpl_5obfifowQNShkumpe6zbA9zDaFw3` in `goodwiins-projects`.
Only the built HTML, CSS, JavaScript and static Vercel configuration were uploaded;
no backend, credentials, artifacts, journals or evidence were included.
The deployment HTML sets `data-ui-preview="true"`: credential entry and Connect
are disabled, submission exits without dispatch, and the page clearly labels the
backend as unavailable. Its CSP also sets `connect-src 'none'`.

Both typechecks, the Vite build and the focused browser regression pass. The live
alias returned HTTP 200, rendered the preview notice and disabled controls, and
produced zero page errors and POST requests. Live capability acceptance remains
3/7; this frontend publication does not advance backend or write acceptance.
