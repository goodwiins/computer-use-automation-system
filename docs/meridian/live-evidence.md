# MERIDIAN live evidence — September 4, 2026

Implementation checkpoint: **3 of 7 capabilities recorded, reviewed and replayed**. The model was Azure `gpt-5.6-luna`. These runs used the hosted synthetic MERIDIAN application. Offline fixtures are separate and do not establish live completion.

| Approved artifact | Genuine discovery run | Successful deterministic replay |
|---|---|---|
| `meridian-sign-on.v1.0.0.json` | `4ac2997a-7ceb-4592-8497-c660e58e6bdf` | `c9537f94-22f2-4b8e-81cd-8ade977307cf` |
| `meridian-member-inquiry.v1.0.0.json` | `dd1bbcfb-7bb3-4d1a-9268-8166493f1f2a` | `6e701398-0b6b-402e-8bb4-0311fc0a8c73` |
| `meridian-member-record.v1.0.0.json` | `99c13cb8-041b-4487-89bf-cad26467193d` | `8a3247a9-b0b5-4dac-8efd-31b7570b8a3a` |

Each corresponding directory under [evidence](evidence/) contains discovery/replay logs and results, a masked final screenshot and sanitized control metadata. Persisted results intentionally omit sensitive values. These snapshots cannot restore account data after restart.

Review checked login references, observed selectors, assertions and actual extraction. Sign-on captures operator/branch/role separately without session identifiers or timestamps. Inquiry checkpoints permit encoded query parameters; table columns are explicitly sensitive and exclude the target's `td` header row. Member selection has no positional fallback that could silently choose among ambiguous matches. Member-record balances remain decimal strings. The supervisor sign-on also replayed successfully as `322a000a-1e23-4836-85e4-0b9df16496f2`.

## Authenticated API reads

[API check results](evidence/api-read-checks.json) record actual HTTP invocations using the shared service:

- Sign-on returned the expected configured branch and teller role.
- Number and surname lookup returned the expected member.
- An ambiguous name query returned two rows without selecting either.
- A missing member returned `NO_SUCH_MEMBER` as a business outcome.
- Repeating each request with the same key returned its original run ID.

Raw names, member numbers, credentials and returned account values are omitted from the backup.

## Dashboard and chat checkpoint

[Live chat results](evidence/dashboard-chat-read.json) show a caller request through the real dashboard and Azure model received HTTP 202 and invoked `meridian-member-record`. Run `b1c437d4-708f-40cb-bf38-b20f11566922` stopped on `SESSION_EXPIRED` at sign-on. This verifies request routing and failure presentation, not a successful balance rehearsal.

The rehearsal exposed CSS overriding the caller's hidden operator selector. The shared hidden rule was corrected; [the subsequent UI check](evidence/dashboard-ui-checks.json) verifies that the selector is hidden, the credential field is cleared, and browser storage contains no credential. The original result retains the observed pre-fix value. [The masked screenshot](evidence/dashboard-fixed.png) shows the corrected caller view. Automated coverage checks both caller and operator visibility; server-side authority checks were unchanged.

## Error inspection

[Profile probe results](evidence/profile-probes/summary.json) cover validation, not-found, permission, timeout, maintenance and server errors. These are per-request, read-only live probes on an operation route; no global settings were changed. They are not LLM discoveries, approved postings or write-capability replays. Maintenance cleared through the observed Continue link to the menu; the original operation was not resumed.

## Current read-only readiness — September 4, 2026

Task 4's fresh reads ran from the integrated `dev` tree at source SHA `4252cb70396b3f30f5c126d2ed2e164054a2bcfe`. The supplied sign-on preflight remains the only sign-on check for this task; it ran at source SHA `7abda4c326260d917795fe75320af99a7233bc6d` and completed as role `TELLER` with a passing evaluator result, 8 attempts and 0 mutation intents.

| Read-only operation | Run ID | Target outcome | Evaluator |
|---|---|---|---|
| Member inquiry for the exact selected synthetic member | `b60ef7b1-a76f-4321-b825-540f8c7ff7d6` | `success` | `pass`; 10 attempts, 0 mutation intents, no violations or incomplete checks |
| Member record and current shares table | `e4850bd4-6c63-42c9-8719-aaefef1c74e4` | `success` | `pass`; 10 attempts, 0 mutation intents, no violations or incomplete checks |

The current sanitized control observations show sign-on `operator` (text), `password` (password), and `branch` (select), followed by the `Sign On` POST. Inquiry used `by` (select), `q` (text), and a GET `Search`; record selection used a GET `Select` and extracted the shares table while excluding its header row. These read controls have no transaction token requirement. The current session used teller context; token values and session identifiers were never persisted.

The record read confirms that a current shares table was extracted, but strict evidence protection omits member, share, balance and status values from replay results and committed documentation. The signed private journal and ignored task-private evidence retain the request identity and selected read fact for controller use; no raw output was copied into this document. No source, destination or hold share was selected for a proposed operation. No write form was submitted, and no review transition or posting control was clicked. Review-time token revalidation, role checks, concrete eligible-share choices and per-post approval therefore remain gates for the separately approved write tasks.

The controller performed a separate manual read-only inspection of unsubmitted forms on the hosted MERIDIAN v4.2.1 application at `2026-09-04T07:36:36Z`–`2026-09-04T07:38:34Z`. It observed both HOLD and OPEN shares, with the selected operation facts retained privately. The initial native write-form facts were:

| Page | Native method and action | Observed controls | Token presence |
|---|---|---|---|
| Transfer | `POST /members/:id/transfer/review` | source/destination selects, amount and memo inputs, `Continue` | hidden token present |
| New share | `POST /members/:id/open-share/review` | type select (`S0001`, `S0070`, `MMKT`, `CERT`), deposit input, `Continue` | hidden token present |
| Contact update | `POST /members/:id/update` | email, phone and address inputs, `Save Changes` | hidden token present |
| Hold | `POST /members/:id/hold/review` | share/reason selects, notes input, `Continue` | hidden token present |

The teller session displayed `RESTRICTED FUNCTION - SUPERVISOR OVERRIDE REQUIRED` on the hold page while still showing its form. This is a restriction warning only; no teller POST was attempted, so it does not prove a server or guarded denial. No `Continue`, `Save Changes`, `Apply Hold` or final posting control was clicked. No token value, password, cookie, SID or contact value was read into the output, no mid-flow reauthentication occurred, and no global injection setting changed. Actual selected review transitions and final current posting facts remain unverified for Tasks 5–8; this inspection does not establish a write artifact, approval or posting.

Before each read, the private journal had no active lock and no MERIDIAN API listener was running; both runs closed with terminal `success` records. The historical open-share discovery `222ebecd-ca02-4960-a875-c2f2f76e0927` remains terminal `POST_OUTCOME_UNKNOWN`; these separate read-only runs did not retry it or alter its journal state.

## Unknown posting — do not retry

Open-share discovery `222ebecd-ca02-4960-a875-c2f2f76e0927` reached a live review and received explicit user approval. Dispatch occurred. The model subsequently reported completion, but artifact compilation failed because the trace omitted branch selection. No capability artifact was accepted and no reusable provenance was reconstructed.

The original journal is terminal `POST_OUTCOME_UNKNOWN`; [the backup status and log](evidence/unknown-posting/) preserve that distinction. Follow-up read-only runs stopped immediately after sign-on: `c3f08ee0-c1e7-4a45-8ccc-ecc0945a1cde` on not-found, `fcd95e7f-6058-4780-8fae-47beafa3c94c` on permission, and `5125f6dc-e95b-4258-b898-bdf347a82a48` on session expiry. No resulting share was verified and no repeat posting was attempted. A later successful inquiry may assist investigation but must not silently change the original outcome to success.

Completing the plan still requires new, separately approved operations for all four write recordings and replays, verified resulting state, remaining unhappy paths, dashboard/chat rehearsal, and final same-head CI evidence.
