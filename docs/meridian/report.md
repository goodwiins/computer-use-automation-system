# MERIDIAN adaptation: current acceptance report

Date: September 4, 2026
Current documentation/test head: `541d776f85d94097bc1e63fa7966de69da5947de`
Branch: `codex/meridian-capability-acceptance`

This is a current acceptance checkpoint, not a completed demonstration or production-readiness claim. Three of seven MERIDIAN capabilities have genuine model discovery, approved artifacts, and deterministic replays: sign-on, member inquiry, and member record. Funds transfer, open share, contact update, and supervisor hold remain open. This documentation update adds no runtime, test, artifact, dependency, target, credential, posting, push or merge change.

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

The current caller read repeated the identical chat body with its saved key and received the same run ID; caller history grew by exactly one run. The dashboard UI was not exercised. The [sanitized fresh-read backup](evidence/fresh-read-summary.json) retains these run IDs, source SHAs and outcomes while omitting member, share, balance, contact, credential, token, cookie, session and raw DOM values. No new screenshot is included because the metadata/result projection is sufficient; existing masked screenshots remain in the evidence manifest.

## Manual and adverse evidence

The controller's hosted MERIDIAN v4.2.1 inspection observed unsubmitted native forms for transfer, open share, contact update and hold. Each had its expected POST destination and hidden token field. The teller hold page displayed `RESTRICTED FUNCTION - SUPERVISOR OVERRIDE REQUIRED`, but no teller POST was attempted; this is not evidence of server or guarded denial. No review transition, final posting control, token value, password, cookie, SID or contact value was captured. These facts remain a partial readiness observation.

The existing profile probes cover validation, not-found, permission, timeout, maintenance and server responses with no mutation dispatch. Maintenance returned to the menu through its Continue link; the operation was not resumed. They are read-only probes, not complete write replay or recovery evidence. The earlier dashboard request ended at `SESSION_EXPIRED`; the latest chat/API read did not exercise the UI, so a successful dashboard rehearsal remains open.

Open-share discovery `222ebecd-ca02-4960-a875-c2f2f76e0927` received approval and dispatched, then failed artifact compilation because branch selection was omitted. Its journal remains `POST_OUTCOME_UNKNOWN`; no resulting share was verified and no retry was made. Current reads do not change that terminal state.

## Repository evidence and limits

The integrated PR #34 head `def4b38a2f906f725813f5c89563f3fe82e31140` passed hosted workflow `33847936549` with producer `100943958989`. The resulting `dev` SHA `4252cb70396b3f30f5c126d2ed2e164054a2bcfe` passed workflow `33848572273` with producer `100945942684`. The Task4/PR37 checkpoint `5be82a9c53b64fa1e8bbfa6b2e7fa91bc42d49f9` passed hosted workflow `33850329935` with producer `100951419518`. The current `541d776` head has no hosted result recorded yet; final same-head hosted checks remain pending.

At the current head, Task 9a's focused four-file matrix passed with 66 tests, `npm run typecheck`, `npm run validate` and `git diff --check`. The earlier full 198-test result belongs to `4ec9b933c9e39fcf471c52f7f5b2bcf7479f1457` and is historical. This docs-only change does not rerun the full suite.

Completing the plan still requires four new write discoveries and separately approved replays, actual review and final-post facts, resulting-state verification, operation-specific unhappy paths including stale or missing token handling, successful dashboard/chat/API rehearsal, same-browser repair, reload reauthentication and keyboard checks, and final local/hosted delivery evidence against `dev`. `master` remains production and was not changed.
