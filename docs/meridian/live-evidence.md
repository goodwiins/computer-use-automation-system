# MERIDIAN live evidence — September 5, 2026

Acceptance remains **3 of 7 capabilities**: sign-on, member inquiry and member record each have genuine model discovery, an approved artifact and a deterministic replay. The earlier read/dashboard acceptance baseline remains source-specific at `480b252ab60edc77aff1bc37f6cd08ba9645f8d1`. Offline fixtures, API routing, read rehearsals and later runtime repairs do not increase the capability count or establish a write.

The current integrated runtime baseline is `dev` at `2c7f4ed4577fe01bbfb441525b7cccc14128c46b`. PR #43 delivered the pre-intent `INSUFFICIENT_FUNDS` business outcome, PR #44 repaired CLI browser inspection under the actual `tsx` loader, PR #45 associated sibling transfer review facts with the posting form, PR #46 made the Terminal-only CLI approval handoff explicit, and PR #47 repaired evidence metadata trust boundaries. Their reviewed source gates are summarized in [the checkpoint report](report.md#architecture-and-delivered-runtime). These integrations do not promote the transfer draft, create a replay or change any historical producing source SHA.

The recorded discoveries used the configured Azure `gpt-5.6-luna` model against the hosted synthetic MERIDIAN application. Current read source SHAs are listed separately below.

## Reviewed artifacts

| Approved artifact | Genuine discovery run | Successful deterministic replay |
|---|---|---|
| `meridian-sign-on.v1.0.0.json` | `4ac2997a-7ceb-4592-8497-c660e58e6bdf` | `c9537f94-22f2-4b8e-81cd-8ade977307cf` |
| `meridian-member-inquiry.v1.0.0.json` | `dd1bbcfb-7bb3-4d1a-9268-8166493f1f2a` | `6e701398-0b6b-402e-8bb4-0311fc0a8c73` |
| `meridian-member-record.v1.0.0.json` | `99c13cb8-041b-4487-89bf-cad26467193d` | `8a3247a9-b0b5-4dac-8efd-31b7570b8a3a` |

The approved artifacts and their sanitized evidence directories retain the discovery and replay provenance above. Login references, observed selectors, assertions, table extraction, sensitive metadata and effective risks were reviewed. Inquiry excludes the `td` header row and does not select an ambiguous match. Member-record balances are typed decimal strings. The auxiliary supervisor sign-on replay `322a000a-1e23-4836-85e4-0b9df16496f2` remains historical evidence and does not establish the hold capability.

## Current read ledger

These reads are separate from the artifact provenance table. Each result below is a terminal journal run with a passing local evaluator and zero mutation intents.

| Read flow | Run ID | Producing source SHA | Observed result |
|---|---|---|---|
| Supplied sign-on preflight | `ad12819b-f07a-41ff-9710-bedff1afe1a5` | `7abda4c326260d917795fe75320af99a7233bc6d` | `success` as `TELLER`; 8 attempts; evaluator `pass` |
| Member inquiry replay | `b60ef7b1-a76f-4321-b825-540f8c7ff7d6` | `4252cb70396b3f30f5c126d2ed2e164054a2bcfe` | `success`; 10 attempts; evaluator `pass` |
| Member-record replay | `e4850bd4-6c63-42c9-8719-aaefef1c74e4` | `4252cb70396b3f30f5c126d2ed2e164054a2bcfe` | `success`; 10 attempts; evaluator `pass` |
| Dashboard chat/read | `288d7cae-c486-4f08-b810-c1e4aa1d4afe` | `ca5d99a21e7274445eb119a71bc8c61f548fa9a7` | HTTP `202`, visible `running` → `success`, 24 rows, selected-member and decimal-balance checks true; evaluator `pass`, 10 attempts, 0 mutation intents and 0 risk disagreements |
| Caller chat/API/runtime member-record read | `ff5fda32-db07-443f-930d-db2d65461dc0` | `541d776f85d94097bc1e63fa7966de69da5947de` | HTTP `202`, terminal `success`, 24 rows, selected-member and decimal-balance checks true; evaluator `pass` |

The dashboard row above is the genuine UI read described below. The caller API row remains a separate API/runtime source and did not exercise dashboard UI.

The last row used the real chat-to-API invocation path with caller authority. Repeating the identical chat body with its saved request key returned HTTP `202` and the same run ID; caller history grew by exactly one run. The dashboard UI was not exercised. The sanitized metadata/result projection is preserved in [fresh-read-summary.json](evidence/fresh-read-summary.json). It contains no member, share, balance, contact, credential, token, cookie, session or raw DOM values, and no new screenshot is included; existing masked evidence remains separately linked below.

The read controls were observed as sign-on `operator` (text), `password` (password) and `branch` (select) followed by the sign-on POST; inquiry `by` (select), `q` (text) and GET `Search`; and record GET `Select` followed by shares-table extraction excluding its header row. These read controls did not require a transaction token. No selected member, share, balance or status value is copied into tracked evidence.

## Dashboard UI read and restart check

The genuine dashboard chat/read run `288d7cae-c486-4f08-b810-c1e4aa1d4afe` used source `ca5d99a21e7274445eb119a71bc8c61f548fa9a7`. A fresh browser context connected through the native caller login form, cleared the credential input, showed 3 approved caller capabilities and no caller write capability, role selector or operator action. One explicit chat request returned HTTP `202`; the visible card progressed from `running` to `success`, showed its result step and 24 rows, and its safe projection recorded `selectedMemberMatches=true` and `decimalBalances=true`. The evaluator passed with 10 attempts, 0 mutation intents, 0 risk disagreements, no violations and no incomplete checks.

The original live card omitted elapsed time even though its authenticated `/runs` response contained finite `elapsedMs=2476`. Task9d now renders finite nonnegative elapsed values, including true zero; the focused local browser fixture covers `2.5 s`, `0 ms` and omission for a historical card. That fixture is a display regression check, not another live rehearsal, and it does not retroactively test the earlier card. The initial request key and body remain private harness identity; they are neither a recording nor a posting approval.

The accepted round1 controller evidence observed Refresh focused and activated by Enter after a real `/runs` GET `200`, and Tab from the chat textarea reached the exact Send control. The authenticated `View result.json` control returned `200` and appended the evidence view. These are read-only checks; the original focus-derived keyboard flag alone is not used as activation evidence. Reload cleared the credential, hid the workspace and left local/session storage empty. Reconnecting as caller kept the role selector and operator actions hidden. Reconnecting as operator after the controlled restart showed the fresh run and the preserved unknown run with operator context controls; no approval, retry, abort or supervisor action was clicked.

The independent post-restart projection recorded historical sensitive values as unavailable, 26 run IDs before and after with no new run, and an unchanged signed `POST_OUTCOME_UNKNOWN` envelope. The controller stopped its owned service cleanly and left the journal locks absent. These checks preserve the historical unknown state; they do not establish a write, same-browser repair or approval/handoff keyboard operation.

## Acceptance ledger

The artifact approval below is promotion approval, not transaction approval. A dash marks a missing live gate; the source SHA for the older artifact discovery/replay pair was not embedded in the artifact and is not guessed here.

| Capability/version | Discovery ID | Replay/read ID | Source SHA | Approval and verified state | Safety/evidence path and limitation |
|---|---|---|---|---|---|
| `meridian-sign-on@1.0.0` | `4ac2997a-7ceb-4592-8497-c660e58e6bdf` | `c9537f94-22f2-4b8e-81cd-8ade977307cf`; current preflight `ad12819b-f07a-41ff-9710-bedff1afe1a5` | current preflight `7abda4c326260d917795fe75320af99a7233bc6d` | artifact approved; preflight `success` as `TELLER` | evaluator `pass`, 8 attempts, 0 intents; [sign-on evidence](evidence/sign-on/) and [fresh summary](evidence/fresh-read-summary.json); older pair's source SHA is not recorded |
| `meridian-member-inquiry@1.0.0` | `dd1bbcfb-7bb3-4d1a-9268-8166493f1f2a` | `6e701398-0b6b-402e-8bb4-0311fc0a8c73`; current read `b60ef7b1-a76f-4321-b825-540f8c7ff7d6` | current read `4252cb70396b3f30f5c126d2ed2e164054a2bcfe` | artifact approved; current read `success` | evaluator `pass`, 10 attempts, 0 intents; [inquiry evidence](evidence/member-inquiry/) and [fresh summary](evidence/fresh-read-summary.json); older pair's source SHA is not recorded |
| `meridian-member-record@1.0.0` | `99c13cb8-041b-4487-89bf-cad26467193d` | `8a3247a9-b0b5-4dac-8efd-31b7570b8a3a`; current reads `e4850bd4-6c63-42c9-8719-aaefef1c74e4`, `ff5fda32-db07-443f-930d-db2d65461dc0` | `4252cb70396b3f30f5c126d2ed2e164054a2bcfe`; `541d776f85d94097bc1e63fa7966de69da5947de` | artifact approved; both current reads `success`; caller read was not a posting | evaluator `pass`, 10 attempts, 0 intents for each; [record evidence](evidence/member-record/) and [fresh summary](evidence/fresh-read-summary.json); dashboard UI not exercised |
| `meridian-funds-transfer@1.0.0` | historical success `a06406ce-c425-4cfb-bb61-4e23b73f8845`; latest stopped `e76197b9-1c6f-46cb-965d-094f60f93992` | — | historical `745ef645ae48730e769e6fc639ec4f71739d23e8`; latest `5c18923b6b043b0ed2630930e5ca6848e3513e5d` | one historical human-approved discovery posting with independently verified resulting state; artifact remains `draft`; latest request timed out before approval; no replay | historical evaluator `pass`; latest evaluator `pass`, 16 attempts, 0 intents; no consent reuse; requires a new complete recording, promotion review and separately approved replay |
| `meridian-open-share@1.0.0` | historical `222ebecd-ca02-4960-a875-c2f2f76e0927` | — | — | historical dispatch is `POST_OUTCOME_UNKNOWN`; no promotion or retry | [unknown status](evidence/unknown-posting/); never retry; requires a separate new operation |
| `meridian-update-member@1.0.0` | — | — | — | no artifact, approval or verified save; incomplete | no safety evaluation or evidence path; requires fresh discovery, replay and resulting-state read |
| `meridian-place-hold@1.0.0` | — | — | — | no artifact, approval or verified hold; incomplete | no safety evaluation or evidence path; teller warning is not a denial; requires teller and supervisor evidence |

## Earlier authenticated reads and dashboard checkpoint

[API check results](evidence/api-read-checks.json) preserve earlier authenticated HTTP checks for sign-on, number/name lookup, ambiguous results without automatic selection, a missing-member `NO_SUCH_MEMBER` business outcome and same-key run identity. Their raw names, member numbers, credentials and account values remain omitted.

[Live chat results](evidence/dashboard-chat-read.json) preserve an earlier caller dashboard request that received HTTP `202` and invoked `meridian-member-record`, then stopped at `SESSION_EXPIRED` during sign-on. This remains routing and failure presentation evidence, not a successful dashboard balance rehearsal. The later `288d7cae-c486-4f08-b810-c1e4aa1d4afe` row above is the separate genuine UI read. [The UI check](evidence/dashboard-ui-checks.json) verifies the post-fix hidden operator selector, cleared credential field and empty browser storage; [dashboard-fixed.png](evidence/dashboard-fixed.png) is the existing masked screenshot. The current `ff5fda32-db07-443f-930d-db2d65461dc0` read remains API/runtime evidence and did not exercise this UI.

## Manual form observation

The controller separately inspected unsubmitted forms on hosted MERIDIAN v4.2.1 at `2026-09-04T07:36:36Z`–`2026-09-04T07:38:34Z`. This was a read-only observation, not LLM discovery, replay, approval or posting. Member and selected operation values were retained privately.

| Page | Native method and action | Observed controls | Token presence |
|---|---|---|---|
| Transfer | `POST /members/:id/transfer/review` | source/destination selects, amount and memo inputs, `Continue` | hidden token present |
| New share | `POST /members/:id/open-share/review` | type select (`S0001`, `S0070`, `MMKT`, `CERT`), deposit input, `Continue` | hidden token present |
| Contact update | `POST /members/:id/update` | email, phone and address inputs, `Save Changes` | hidden token present |
| Hold | `POST /members/:id/hold/review` | share/reason selects, notes input, `Continue` | hidden token present |

The teller session displayed `RESTRICTED FUNCTION - SUPERVISOR OVERRIDE REQUIRED` on the hold page while still showing its form. This is a restriction warning only; no teller POST was attempted, so it is not a demonstrated server or guarded denial. No `Continue`, `Save Changes`, `Apply Hold` or final posting control was clicked. No token value, password, cookie, SID or contact value was read into output, no mid-flow reauthentication occurred and no global injection setting changed. Actual selected review transitions, role enforcement and final current posting facts remain unverified for Tasks 5–8.

## Error inspection

[Profile probe results](evidence/profile-probes/summary.json) at source `89d76a9ffab56c926d4cc5d0e753146b5abad277` cover validation, not-found, permission, timeout, maintenance and server responses. They are per-request, read-only probes on an operation route, not LLM discoveries, approved postings or write-capability replays. All recorded probes dispatched no mutation. Maintenance cleared through the observed Continue link to the menu; the original operation was not resumed, so that link is not completion evidence.

## Unknown posting — do not retry

Open-share discovery `222ebecd-ca02-4960-a875-c2f2f76e0927` reached a live review and received explicit user approval. Dispatch occurred. The model later reported completion, but artifact compilation failed because branch selection was omitted. No capability artifact was accepted and no reusable provenance was reconstructed.

Its journal is terminal `POST_OUTCOME_UNKNOWN`; [the backup status and log](evidence/unknown-posting/) preserve that distinction. Follow-up read-only runs stopped immediately after sign-on: `c3f08ee0-c1e7-4a45-8ccc-ecc0945a1cde` on not-found, `fcd95e7f-6058-4780-8fae-47beafa3c94c` on permission and `5125f6dc-e95b-4258-b898-bdf347a82a48` on session expiry. No resulting share was verified and no repeat posting was attempted. The current reads do not rewrite this terminal state.

## Open acceptance gates

The successful funds-transfer discovery post does not establish an approved artifact or a successful deterministic replay. Its draft remains blocked and requires a new complete recording. Open share, contact update and supervisor hold still require fresh discovery and separately approved replay operations, review and final-post inspection, actual result verification and sanitized evidence.

The remaining operation-specific unhappy paths include natural and injected business rejection, absent member, teller/supervisor restriction, timeout or expiry, maintenance, server failure and missing/stale token handling. An integrated dashboard/chat/API rehearsal with a separately approved write, same-browser repair, approval/handoff keyboard operation, and final same-head hosted CI/delivery remain open. The read-only reload, Refresh/Send keyboard, evidence-view, caller/operator visibility and post-restart historical checks above do not close those gates. All new PRs target `dev`; `master` is production and remains untouched.

## Transfer runtime mapping checkpoint

The Task 5a read-only map confirms the member shares table used for current eligibility: `body > table:nth-of-type(1) > tbody:nth-of-type(1) > tr:nth-of-type(3) > td:nth-of-type(1) > table:nth-of-type(2)`, with `shareId`, `type`, `balance` and `status` columns and `tr:not(:first-child)` to exclude its observed legacy header row. Native transfer facts are `_token`, `from`, `to`, `amount` and `memo`. The recorded review labels and formats are `Member: <member> - <name>`, `From:/To: <share> ($<balance>)`, `Amount: $<amount>`, and `Memo: <memo>`. Those labels must be uniquely associated with the posting form; the September 5 inspection below corrects the earlier assumption that its table contains them. The confirmation value has an observed static label/value relationship.

The transaction result's label set, row order, header shape and confirmation/detail relationship remain unverified. Task 5b therefore requires a canonical transaction row (`member`, `sourceShare`, `destinationShare`, `amount`, `memo`, `confirmation`) in the next recording, compares it with the separate confirmation output, and fails closed on legacy or ambiguous shapes. The reviewed runtime does not promote the draft or prove replay success; a new complete recording must establish result selectors and explicit header handling before Task 5c.

## Replacement transfer recording — sign-on failure

The operator selected a new demo transfer with the unresolved result-extraction limitation understood. Genuine Luna discovery `a2941fc8-fd27-4470-bff2-d20b71058349` used runtime source `4f84b9fbcb9b5a1fc09cd05611277b3357561728` and a separately saved request key. It stopped at sign-on and was aborted without human repair. Its authenticated journal is terminal `failure`; the evaluator passed with task status `failure`, 6 attempts, zero mutation intents and no violations. No transfer review, posting approval, candidate artifact or replay resulted. The original successful discovery and draft remain unchanged.

A separate read-only probe using the actual CLI loader (`node --import tsx`) reproduced `elementHandle.evaluate: ReferenceError: __name is not defined` in `inspectControl`. The hosted sign-on has a unique native submit input; the failure occurred when inspecting it, before dispatch. PR #44 repaired this boundary with self-contained local helper methods and a regression under that loader for sign-on, complete transfer review and duplicate-label rejection. The fresh checks and subsequent attempts below used that repair. Passing the older Vitest fixtures alone did not establish this CLI path. Result layout and transfer acceptance remain unverified; coverage stays `3/7`.

## Tool verification and recent transfer attempts

The following live checks used source `0001b3d542446ff0b8ffbd7a8fe207d74ba08a80`. Each journal is terminal `success`, with a passing evaluator and zero mutation intents. They refresh the three accepted reads without establishing another accepted capability.

| Check | Run ID | Result |
|---|---|---|
| Sign-on | `bd266309-7815-4230-84aa-3fbcdb611159` | TELLER; 8 attempts |
| Member inquiry | `a8a498d3-f29b-4082-92b0-29d5a54c8cb1` | 10 attempts |
| Member record | `266b78c5-b507-461f-a2cf-f960fe61cde0` | 10 attempts; selected member/share association and decimal balances checked |
| Real-model caller chat and `run_status` | `11f47224-72bd-4aa4-bf28-1b4ed4bdb65b` | HTTP `202` then success; 10 attempts; current member/share association and decimal balances checked |

Authenticated catalog, history, status and evidence reads passed. Missing credentials returned `401`; a caller's approval request returned `403`. The caller chat run and a direct capability invocation with the same request key resolved to one run and one caller history entry. The owned service closed cleanly.

All eight discovery tools (`navigate`, `fill`, `select`, `assert`, `click`, `extract`, `done`, `escalate`) passed an actual-`tsx` local Chromium smoke test, including explicit abort, with zero write requests. This used scripted model responses and a GET click. The full local gate passed 275 tests in 17 files, typecheck and artifact validation. These checks do not prove live posting, repair or replay acceptance.

The two older CU-NEXUS artifacts were exercised against an owned local fixture with only an in-memory origin override. Balance lookup returned the expected value. Subaccount preview reached review, but its recorded whole-row extracts return label, tab and value; the bare-value assertion failed. Those outputs cannot be treated as a bare nickname or money value without an explicit contract/recording change. No artifact was rewritten.

PR #45 then delivered the sibling review/form association at head `4789be8f2b26c47ccba375d7c1f4d62ea640e218`, merged as `5c18923b6b043b0ed2630930e5ca6848e3513e5d`. Focused 118 tests, 275 tests/17 files, typecheck, artifact validation, independent review and head/merge CI passed. PR #46 delivered the Terminal handoff at head `c4279ac9fb78edcd4847a8b7ad1146d7d259b920`, merged as `8e625cc0db83ebc37ad62f2bc60f1d8feeec1d8c`; 276 tests/17 files and head/merge CI passed. These are source gates, not live acceptance.

## Replacement transfer recording — review layout

Three subsequent genuine Luna attempts used source `096855697bdd91fbe27dde7843cb3f01513522a6`, separate saved request identities and the selected demo operation. All were stopped without posting; authenticated journals are terminal `failure`, evaluators passed with task status `failure`, and each recorded zero mutation intents.

| Run ID | Attempts | Observed stop |
|---|---|---|
| `a4a8b538-9133-45f0-a07a-3a24e263eb13` | 13 | The global transfer menu bypassed the member-record eligibility snapshot; the frame guard correctly rejected entry. |
| `a6c3f359-1485-438b-a3eb-4a110d974463` | 15 | An unnecessary preliminary shares extraction failed money/header validation. |
| `83a198eb-25e0-4fcb-ad12-03d480bfad73` | 17 | The posting-control inspection rejected review facts as missing or ambiguous before approval. |

A separate manual unposted inspection found the review table in a sibling `div.box`, with the posting form directly beside it in the same content `td`. The form contains only hidden native fields and controls, and its nearest table is the outer page layout. The earlier inspector enumerated only tables inside the form and that nearest table, omitting the actual review facts. [The sanitized structural observation](evidence/transfer-review-shape.json) retains tags, labels and field names only. It is fixture input, not discovery or replay provenance. Supporting this layout requires a unique form/review association and the existing visible/native fact checks; ambiguous or unrelated tables must remain rejected.

No new attempt reached posting approval, produced a candidate artifact or established completion/result selectors. The result-extraction and separately approved replay gates remain open. Live acceptance remains `3/7`.

After PR #45, three distinct saved requests reached the real transfer approval boundary. `7a8dd317-77df-458e-bd2c-4768a5c4eb09` timed out and finished `RUN_ABORTED`/`failure` after 17 attempts with zero mutation intents. During `50db3bb4-97a2-45ad-95e4-b72563b9f802`, a human clicked `Post Transfer` directly in the browser; the unarmed route was blocked and could display `ERR_FAILED`, then owned-browser closure finalized `failure` after 20 attempts with zero intents. The latest `e76197b9-1c6f-46cb-965d-094f60f93992` timed out after the five-minute Terminal approval window and finalized `failure` after 16 attempts with zero intents. All three evaluators passed with zero risk disagreements and no reported violations or incomplete checks. This scoped evaluator result does not establish business success or repair older evidence. No candidate, promotion, replay or posting resulted, and no approval or request identity is reused.

For a CLI risk approval, the human must review the current facts, type `approve` and press Return in Terminal, then let the runner perform the native post. Direct browser submission is blocked. PR #46 makes this handoff explicit; it does not itself exercise a posting. A fresh read-only journal/evaluator check also reconfirmed the original `222ebecd-ca02-4960-a875-c2f2f76e0927` record as authenticated `POST_OUTCOME_UNKNOWN`; its terminal state remains unchanged.

Evidence-metadata [PR #47](https://github.com/goodwiins/computer-use-automation-system/pull/47) at `66a9fb0b14450a81311c515e0d61b07a0a2449cb` passed final review, 278 tests/17 files, typecheck, validation, scoped re-review and hosted workflow `33950233434` / producer `101263489851`. It merged as `2c7f4ed4577fe01bbfb441525b7cccc14128c46b` with an identical reviewed tree; merge workflow `33950705840` / producer `101264800819` passed. Existing private evidence was not rewritten. The discovery-input audit at baseline `8e625cc` confirmed missing canonical public inputs can reach runtime/model work and can compile as literals for non-transfer capabilities; the unconditional transfer guard still prevents an unbound canonical transfer post. Its repair is queued from the new baseline. Neither source is live capability evidence.
