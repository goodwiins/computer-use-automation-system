# MERIDIAN CORE adaptation — replacement plan

Status: proposed for implementation. Supersedes the earlier adaptation plan and incorporates both Claude Fable 5.1 reviews, with corrections to recommendations that weakened the assignment's safety requirements.

## 1. Outcome, boundaries, and prerequisites

Deliver a local demonstration of the existing discovery → recorded capability → deterministic replay engine against hosted MERIDIAN CORE. All seven required functions must work, including approved posting. Provide a callable API, an LLM chatbot, a dashboard with human approvals and evidence, a runbook, and a 1–2 page write-up.

Use the existing TypeScript, Express, Playwright, Zod, OpenAI/Azure, and Vitest stack. One server process, one active run, one visible browser per run, filesystem persistence, and a plain HTML/CSS/JavaScript frontend. The model interprets requests and discovers flows; it never decides replay steps or authorizes a transaction.

**Three working days is the target, including integration and rehearsal.** It is not a guarantee that unverified live behavior will fit. Reduce visual polish and optional conveniences first. An unfinished function or failed safety gate remains explicitly incomplete; it is not replaced by a mock and counted as delivered. No separate “Day 0.”

### Existing PRs come first

On September 3, the open heads were #32 `376e52d`, #31 `60d6090`, and #6 `9117af2`. These are a planning snapshot, not a merge-readiness claim.

1. Land #32, the GitHub CI workflow.
2. Bring #31 and #6 onto that baseline, resolve valid review findings, and validate each final head before merging. Coordinate with the existing author; do not duplicate concurrent fixes.
3. In #6, remove the raw rejected overlay URL from exceptions. For CSS recording, discard strategies containing parameter-dependent literals or unresolved templates instead of introducing a CSS parser or blindly substituting values. Decode CSS escape forms when checking for sensitive literals; reject an artifact if a safe strategy cannot be established. Preserve invariant structural fallbacks. Never treat a short sensitive value as safe to persist because it is short.
4. Validate quote/backslash inputs, empty and short values, structural indices, overlay defaults, and overlay approval composition. Existing manually templated CSS must be explicitly reviewed; the MERIDIAN recording path will not generate it.
5. Require `npm run ci`, `npm run validate`, and `git diff --check`; verify hosted CI on final heads and the merged baseline.
6. Create `codex/meridian-adaptation` in an isolated worktree from merged `master`. Preserve the primary checkout's modified capability artifact.

## 2. Adapt the shared core and record all seven functions

### Profiles and the browser lifecycle

- Select the application profile through a CLI option and server configuration. Preserve the mock profile and existing commands. Add a MERIDIAN profile containing permitted routes, form-action rules, detectors, review-fact selectors, and evidence masking.
- Every capability starts a fresh browser at sign-on and includes recorded login steps. Sign-on is also independently invocable as an authentication check; it returns operator, branch, and role, not a reusable browser-session token.
- Server configuration binds operator, branch, and password. Public chat schemas exclude these fields. The operator dashboard can select an allowed operator explicitly. The ordinary chat principal is limited to the teller account; supervisor use requires the authenticated operator principal.
- Credentials resolve inside the runtime from environment configuration. Discovery sees references to credential parameters, not password values. Recorded steps store references; model prompts, logs, and artifacts never receive literal passwords.
- A run retains its browser while awaiting human action. Use a ten-minute absolute run deadline, including a maximum five-minute approval wait. Session expiry or the deadline stops the run; restarting requires a new invocation and new approval. No automatic privilege upgrade or mid-flow login recovery.
- Extract shared runtime construction from the CLI. CLI and HTTP execution use the same parameter validation, guarded surface, evidence, mutation tracking, and replay logic. Browser cleanup belongs in `finally`.

### Risk checks before actions

The guarded surface resolves the actual control and inspects its link/form destination before acting. Profile rules match permitted paths, HTTP methods, and submit controls. Final transfer, new-share, hold, and contact-update submissions require approval regardless of the risk declared by the model or artifact. Unknown mutation destinations are denied. Merely focusing or filling a field is not a final submission.

Apply these rules to discovery, replay, detector recovery, and resumed automation. Keep recorder risk validation as a second check. Record the effective runtime mutation classification in the action context and discovery trace; retry protection and dispatch journaling must use that classification, not a potentially lower artifact/model label. Prevent automation from acting while `ControlSession` belongs to the human.

Discovery's human gate must support approval of an automation-performed posting click. After approval, automation performs and records that click. Human actions captured during a repair are evidence, not silently converted into a complete reusable capability.

### Capability contracts

| Capability | Public inputs | Result |
|---|---|---|
| Sign-on check | None; operator context is server-controlled | Authenticated operator, branch, role |
| Member inquiry | Search mode and search value | Matching member rows; no automatic choice among multiple matches |
| Member record | Member number | Share IDs, types, balances, statuses |
| Funds transfer | Member, source share, destination share, amount, memo | Posting confirmation and verified transaction details |
| Open new share | Member, share type, deposit | New share identifier and posting confirmation where the target provides one |
| Update member information | Member, email, phone, mailing address | Verified saved result |
| Place account hold | Member, share, reason, notes | Verified hold result and confirmation where available; supervisor authority required |

Use validated decimal strings for money and integer cents for comparisons. Select shares using stable option values; retain the old label-selection default for existing artifacts. Reject ambiguous member/share matches and invalid or nonfinite amounts.

### Minimal contract additions

- Add discovery's existing-schema `assert` capability so recording emits meaningful checkpoints.
- Introduce version 2 artifacts for server-bound parameters, explicit select-by-value, typed table extraction, sensitive output metadata, and mutation checks. Continue loading version 1 artifacts unchanged; normalize both into the executor's internal representation.
- Table extraction declares a table target and named columns and returns arrays of row objects. Public results are structured JSON, not JSON encoded inside strings. Money columns remain decimal strings.
- Declare outputs only when backed by recorded extraction. Validate their types and required content before success. A model's `done.outputs` claim cannot create an unsupported output.
- Read and validate the current hidden token without logging or recording its value. Submit native browser forms so their current tokens travel normally. Do not introduce a token-copying or runtime-variable framework.
- Inspect the live review/post pages, token rejection, actual submit controls, and all error pages before finalizing profile rules. These are discovery tasks, not assumptions that the current mock already supports them.

## 3. API, chatbot, approvals, and transaction safety

### API and identity

Expose `serve` and follow the existing GitHub issue contracts:

| Endpoint | Behavior |
|---|---|
| `GET /capabilities` | Authorized catalog, pinned versions, public typed parameters and outputs |
| `POST /capabilities/:id/invoke` | Validate arguments and `Idempotency-Key`; return `202 {runId}` |
| `GET /runs` | Authorized history |
| `GET /runs/:id` | Lifecycle, interventions, result, and safe evidence references |
| `POST /runs/:id/decision` | Resolve one pending operator intervention |
| `POST /chat` | Interpret a request and call the same invocation service |

Use two separately configured credentials mapped server-side to a caller principal and an operator principal. The caller has a capability allowlist and teller-only context. Only the operator may decide interventions or invoke supervisor-context runs. All API and evidence endpoints authenticate requests and check run ownership or operator authority.

The chat tool executor receives only invocation/status functions bound to the caller principal. It never receives operator credentials, arbitrary HTTP/browser tools, or an approval function. Even an operator using the chat page is downgraded to caller authority for model-triggered actions.

Bind to loopback; validate Host and Origin. Use bearer headers rather than ambient authentication cookies. The operator enters their credential in the dashboard; retain it only in page memory, not URLs, localStorage, sessionStorage, logs, or model context. A reload requires reauthentication. Use a restrictive Content Security Policy, no third-party scripts, and `textContent` for model, page, and log strings. Serve evidence only from validated run/file identifiers; never serve captured raw HTML as an executable page.

This protects the model/tool boundary and cross-site callers. It does not claim isolation from malicious code running inside the trusted server process or a compromised laptop.

### Explicit approval context

Pass a structured action context through the shared gate: run ID, artifact ID/version, step ID, action destination, authenticated target operator/role, and canonical transaction facts read from the live page. Do not infer authorization state by scraping log messages.

Persist only redacted intervention metadata. Keep live facts in memory. Issue a random, single-use approval ID with a five-minute deadline. Display the actual facts and approve/abort controls. Contact updates use a dashboard-generated review of the live filled form because MERIDIAN has no separate update-review page.

After approval and immediately before submission, re-resolve the control and recheck the target role, expected route/form, current token presence, detectors, and canonical transaction facts. Any mismatch invalidates approval and stops submission. The identifier alone is not evidence that page state is unchanged.

Serialize approval, abort, and submission transitions. A duplicate or stale decision returns `409`; an unauthorized decision returns `403`. An accepted abort prevents dispatch. Once dispatch begins, abort cannot promise to undo it. Browser closure, expiry, or timeout ends the pending intervention safely.

For nonmutation failures, retain bounded retry and human repair with explicit checkpoint revalidation. Human-event capture remains bounded and records trusted browser events where available; do not advertise page-side event filtering as a strong attribution boundary against compromised page scripts.

### Durable invocation identity and uncertain outcomes

- Require `Idempotency-Key` for API invocations and the equivalent CLI option for MERIDIAN mutation-capable runs. The chat wrapper generates and retains a key per confirmed request; transport retries reuse it.
- Use a filesystem journal under the evidence directory, with exclusive creation, atomic replacement, file/directory synchronization, and restrictive permissions. No database or queue is needed for one active process. Refuse a second server instance using the same journal.
- Reserve the request durably before launching its browser. Store the caller, capability/version, run ID, state, and a keyed HMAC of normalized arguments and operator context. Do not store secrets, raw PII, or an unkeyed low-entropy argument hash. Use a stable configured HMAC key; fail startup if existing journal records cannot be validated.
- Same caller/key and same request returns the original run; changed arguments or context return `409`. This applies to running, completed, interrupted, and unknown-outcome runs, including after restart. Retain records for the entire demo; do not silently expire write-request deduplication.
- Durably record mutation dispatch intent immediately before the final submit. Any failure after that point without verified completion becomes a terminal `POST_OUTCOME_UNKNOWN`. The shared executor refuses retry and unchecked skip for that mutation through every adapter.
- After a crash, unfinished runs are interrupted; those with dispatch intent are unknown. Never resume their browser actions automatically. A separate read-only inquiry may help the operator investigate, but it does not silently convert the original run into success.
- State the guarantee accurately: duplicate requests with the same key do not dispatch another run. A UI-only target does not provide proven exactly-once execution, and a new key represents a new requested operation requiring fresh approval.

## 4. Dashboard, evidence, and exception behavior

The dashboard and chat share one small static frontend. Show the catalog, discovery/replay history, active step, recovery events, pending intervention, result, timing, and evidence. Poll while runs are active. Discovery remains CLI-driven; its saved evidence also appears in history. Dashboard approval and handoff are the live demonstration path.

Keep terminal results `success`, `business_outcome`, and `failure`, with stable failure codes including `POST_OUTCOME_UNKNOWN`. Track running, recovering, and awaiting-human separately as lifecycle states. Chat reports those states in plain language and asks for missing inputs rather than inventing them.

**Evidence protection is required before live recording.** Profile selectors identify dynamic member/contact/financial content, not just values supplied as parameters. Mask sensitive page regions and registered values in screenshots. Redact structured logs, errors, outputs, and DOM snapshots before persistence; record sanitized structure/text, never raw HTML, passwords, tokens, cookies, or model transcripts. Unknown pages or failed redaction produce metadata-only evidence with an explicit capture warning.

Authorized callers may see useful synthetic results from in-memory run state. Historical files contain redacted results; after restart, the UI says sensitive values are unavailable instead of fabricating them. Sensitive table columns are covered explicitly by output metadata.

Capture and classify all six injected states and natural errors. Missing members, invalid input, and insufficient funds are business outcomes. Permission failures and session expiry stop or escalate without changing role automatically. Recovery is attempted only when a known control or safe read-only navigation can clear the condition, once; never retry a submitted mutation. A 503 is recoverable only if live evidence supports a safe recovery.

Use test-only, profile-approved per-request fault scenarios on the actual operation route. Keep them outside the normal chatbot schema. Do not change shared global error settings or rely on adding `inject` only to the sign-on URL.

## 5. Three-day sequence and acceptance gates

| Day | Ordered work | Required checkpoint |
|---|---|---|
| 1 | Resolve prerequisite PRs; inspect live forms/error states; add profile selection, shared runtime, pre-action rules, safe evidence, assertions, and login/read artifacts | Existing mock CI passes; live sign-on/inquiry/balance work; a deliberately down-labelled final submit cannot execute |
| 2 | Add authenticated async API, durable request journal, dashboard approvals/handoff, structured outputs, and write recording; connect thin chat | Approved transfer completes through chat/API/dashboard; stale approval and duplicate request do not post |
| 3 | Finish and verify the remaining functions; exercise exceptions, crash/retry boundaries and masking; rehearse; write README/runbook/report | All seven functions and required unhappy paths have evidence; final branch and hosted CI pass |

### Required automated checks

Reuse Vitest and the existing Playwright fixtures. Add focused checks for the new behavior; do not build a second complete MERIDIAN application.

- Existing version 1 artifacts, mock replays, overlays, typechecking, and artifact validation remain green.
- Down-labelled discovery/replay/recovery submissions cannot bypass live risk rules; approved discovery records the actual post step.
- Caller credentials cannot approve, read another caller's run, or select the supervisor. Model output cannot invoke approval or change authority. Unsafe HTML in messages/evidence renders inertly.
- Mutating review facts, target role, or page destination between review and dispatch invalidates approval. Test reused IDs, expiry, accepted abort, and browser closure.
- Same/different-payload idempotency behavior survives process restart. Simulated crashes before reservation, after reservation, and after dispatch intent never trigger automatic repeat posting.
- Human retry, detector recovery, and CLI execution obey the same unknown-outcome restrictions. No unchecked skip yields success.
- Tokens and passwords remain absent from artifacts, logs, screenshots, DOM snapshots, errors, and persisted results. Test dynamically observed PII and the full logger → guarded surface → browser masking path.
- Table results meet their declared type, select-by-value survives changed balances, and unsupported model-only outputs cannot be promoted.

### Required live evidence

For each of the seven capabilities, retain discovery provenance, a reviewed artifact, and replay evidence. For writes, demonstrate actual approved posting and verify the resulting state; merely pausing at approval does not satisfy completion. Use current suitable shares, not hard-coded seed balances.

Cover member-number and last-name lookup, ambiguity, validation, not-found, insufficient funds, teller hold denial, supervisor hold success, session timeout, maintenance, and server errors. Record observed recovery versus explicit stop faithfully. Rehearse a successful balance lookup, an approved transfer, an exceptional outcome, and same-browser escalation through the dashboard.

Before delivery run `npm run ci`, `npm run validate`, and `git diff --check`; inspect same-head hosted results. Supply exact setup/discovery/replay/demo commands, required environment-variable names without values, an offline fixture path clearly labelled as such, the adaptation write-up, and sanitized backup evidence. No production-readiness claim.

### Existing issue coverage and deliberate deferrals

Deliver the demo-relevant parts of #7, #8, #10–13, #15–18, #25, and #29. Export both OpenAI and MCP tool descriptors for #7; no MCP server is required. Keep caller and operator logic separate within the selected single process even though #16 describes a separately deployed agent.

Implement bounded portions of #9 (one active run/backpressure), #20 (filesystem ID/version lookup), and #26 (bounded human-action evidence). Do not close an issue unless its actual acceptance scope is fulfilled.

Defer remote CDP access, artifact signing, multi-tenant catalogs, drift aggregation, LLM repair, production encrypted storage/retention, automated re-login, desktop surfaces, and concurrent pools/queues. Local file access remains a trusted boundary. These omissions must be explicit in the write-up.

Track MERIDIAN-specific artifacts, token/form checks, table extraction, and end-to-end demo acceptance separately from the generic production backlog; do not create duplicate versions of existing issues.

## Sources and review limits

- Assignment: `Adaptation Project — MERIDIAN CORE (Demo Day, Fri Aug 28).pdf`, seven pages, supplied by the user. Its original demo date is historical; the three-day target above is the user's current choice.
- [Architecture walkthrough](https://app.eraser.io/workspace/ziyIb2vBMV2jgfB78FB4).
- [GitHub umbrella issue #30](https://github.com/goodwiins/computer-use-automation-system/issues/30), its child issues #7–29, and [PR #6](https://github.com/goodwiins/computer-use-automation-system/pull/6), [PR #31](https://github.com/goodwiins/computer-use-automation-system/pull/31), [PR #32](https://github.com/goodwiins/computer-use-automation-system/pull/32).
- Two read-only Claude Fable 5.1 reviews of master `34b1369` plus supplied PR diffs. Both returned REVISE. This replacement has not yet undergone another independent review or implementation test.
- Live sign-on, inquiry, record and unsubmitted operation forms were inspected. Actual posting pages, final controls, token expiry, and exceptional-state text remain implementation-time verification gates, not confirmed behavior.
