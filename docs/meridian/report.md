# MERIDIAN adaptation: current acceptance report

Date: September 4, 2026
Published checkpoint before this scoped repair: `ca5d99a21e7274445eb119a71bc8c61f548fa9a7`; the new head awaits controller checks
Branch: `codex/meridian-capability-acceptance`

This is a current acceptance checkpoint, not a completed demonstration or production-readiness claim. Three of seven MERIDIAN capabilities have genuine model discovery, approved artifacts, and deterministic replays: sign-on, member inquiry, and member record. Funds transfer, open share, contact update, and supervisor hold remain open. This scoped update repairs shared dashboard elapsed rendering and adds one local browser assertion; it adds no artifact, dependency, target, credential, posting, push or merge change.

## Code and security baseline

The shared TypeScript/Express/Playwright runtime is integrated in `dev` at `4252cb70396b3f30f5c126d2ed2e164054a2bcfe`. Accepted repairs provide the guarded runtime, authenticated filesystem journal, caller/operator authorization, request deduplication, live form and token checks, typed table and money extraction, safe evidence projection, observer isolation, and bounded click/deadline handling. A dispatching run becomes `POST_OUTCOME_UNKNOWN`; no browser action or detector recovery automatically retries it. The chat executor receives caller-bound invocation/status tools and cannot approve a transaction or select supervisor context.

The Task 9a deterministic acceptance work is accepted at `541d776f85d94097bc1e63fa7966de69da5947de`. Its local checks cover approval and abort dispatch boundaries, browser closure, changed live facts, same-key identity and restart, caller authority, evidence protection, typed outputs, hostile UI text and observer failures. These are offline fixtures and runtime seams; they do not prove target behavior or a posted result.

## Verified reads

The reviewed artifact provenance remains in [live evidence](live-evidence.md). Current read runs and source distinctions are:

| Flow | Run ID | Source SHA | Result |
|---|---|---|---|
| Supplied sign-on preflight | `ad12819b-f07a-41ff-9710-bedff1afe1a5` | `7abda4c326260d917795fe75320af99a7233bc6d` | `success`, teller role, evaluator pass, 8 attempts, 0 mutation intents |
| Member inquiry replay | `b60ef7b1-a76f-4321-b825-540f8c7ff7d6` | `4252cb70396b3f30f5c126d2ed2e164054a2bcfe` | `success`, evaluator pass, 10 attempts, 0 mutation intents |
| Member-record replay | `e4850bd4-6c63-42c9-8719-aaefef1c74e4` | `4252cb70396b3f30f5c126d2ed2e164054a2bcfe` | `success`, evaluator pass, 10 attempts, 0 mutation intents |
| Caller chat/API/runtime member-record read | `ff5fda32-db07-443f-930d-db2d65461dc0` | `541d776f85d94097bc1e63fa7966de69da5947de` | HTTP `202`, terminal `success`, 24 rows, selected-member and decimal-balance checks true; evaluator pass, 10 attempts, 0 mutation intents |
| Dashboard chat/read | `288d7cae-c486-4f08-b810-c1e4aa1d4afe` | `ca5d99a21e7274445eb119a71bc8c61f548fa9a7` | HTTP `202`, visible `running` → `success`, 24 rows, selected-member and decimal-balance checks true; evaluator pass, 10 attempts, 0 mutation intents, 0 risk disagreements |

The caller chat/API/runtime read repeated the identical chat body with its saved key and received the same run ID; caller history grew by exactly one run. That row is API/runtime evidence only. The separate dashboard row is genuine UI evidence. The [sanitized fresh-read backup](evidence/fresh-read-summary.json) retains these run IDs, source SHAs and outcomes while omitting member, share, balance, contact, credential, token, cookie, session and raw DOM values. No new screenshot is included because the metadata/result projection is sufficient; existing masked screenshots remain in the evidence manifest.

The genuine UI run used the native caller login, cleared the credential input, showed 3 approved caller capabilities with no caller write capability or operator controls, submitted one explicit chat request, and visibly progressed from `running` to `success`. The result card showed its step and 24 rows; safe checks recorded selected-member and decimal-balance matches. The accepted round1 controller check activated Refresh with Enter after `/runs` returned `200`, reached Send by Tab, opened `View result.json` with `200`, and verified caller/operator visibility after reload. Reload cleared the credential, hid the workspace and left browser storage empty. After the independently recorded restart, historical sensitive values were unavailable, run count stayed 26 before and after, and the signed unknown envelope was unchanged. No approval, retry, abort or supervisor action was clicked.

The live card's authenticated `/runs` response contained `elapsedMs=2476`, while the old card omitted timing. The shared renderer now displays finite nonnegative durations, including true zero; the local focused browser fixture asserts `2.5 s`, `0 ms` and no timing label for missing historical timing. This display check is not another live rehearsal and does not retroactively test the old card. The initial script key and body remain private and are not a recording or posting approval.

## Manual and adverse evidence

The controller's hosted MERIDIAN v4.2.1 inspection observed unsubmitted native forms for transfer, open share, contact update and hold. Each had its expected POST destination and hidden token field. The teller hold page displayed `RESTRICTED FUNCTION - SUPERVISOR OVERRIDE REQUIRED`, but no teller POST was attempted; this is not evidence of server or guarded denial. No review transition, final posting control, token value, password, cookie, SID or contact value was captured. These facts remain a partial readiness observation.

The existing profile probes cover validation, not-found, permission, timeout, maintenance and server responses with no mutation dispatch. Maintenance returned to the menu through its Continue link; the operation was not resumed. They are read-only probes, not complete write replay or recovery evidence. The earlier dashboard request ended at `SESSION_EXPIRED`; the later UI read is a successful read-only dashboard check, while a successful integrated write rehearsal and same-browser repair remain open.

Open-share discovery `222ebecd-ca02-4960-a875-c2f2f76e0927` received approval and dispatched, then failed artifact compilation because branch selection was omitted. Its journal remains `POST_OUTCOME_UNKNOWN`; no resulting share was verified and no retry was made. Current reads do not change that terminal state.

## Repository evidence and limits

The integrated PR #34 head `def4b38a2f906f725813f5c89563f3fe82e31140` passed hosted workflow `33847936549` with producer `100943958989`. The resulting `dev` SHA `4252cb70396b3f30f5c126d2ed2e164054a2bcfe` passed workflow `33848572273` with producer `100945942684`. The Task4/PR37 checkpoint `5be82a9c53b64fa1e8bbfa6b2e7fa91bc42d49f9` passed hosted workflow `33850329935` with producer `100951419518`. The published Task9a/9b checkpoint `ca5d99a21e7274445eb119a71bc8c61f548fa9a7` passed hosted workflow `33854138902` with producer `100963404693`, including artifact validation; hosted checks for the new head remain pending.

The published checkpoint had 199 local tests across 15 files, `npm run typecheck`, `npm run validate` and `git diff --check`, plus the hosted checks above. Task9d's focused browser check first failed on the absent timing label and then passed after the one-line renderer repair; `npm run typecheck` and `git diff --check` remain required on the new head. No full suite rerun is planned here because the controller owns the required pre-push and hosted checks. The earlier full 198-test result belongs to `4ec9b933c9e39fcf471c52f7f5b2bcf7479f1457` and is historical.

Completing the plan still requires four new chosen write discoveries and separately approved replays with independent current-fact posting decisions, actual review and final-post controls, resulting-state verification, operation-specific unhappy paths including stale or missing token handling, an integrated dashboard/chat/API rehearsal, same-browser repair, approval/handoff keyboard operation, exception rehearsal and final local/hosted delivery evidence against `dev`. The read-only reload, basic Refresh/Send keyboard, evidence-view and caller/operator checks are recorded above. `master` remains production and was not changed.
