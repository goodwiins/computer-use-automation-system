# MERIDIAN current acceptance checkpoint

Date: September 5, 2026
Current integrated `dev`: `2c7f4ed4577fe01bbfb441525b7cccc14128c46b`

This is a partial Task 9 checkpoint, not final delivery or production readiness. Live acceptance remains **3/7**: sign-on, member inquiry and member record have genuine model discoveries, approved artifacts and deterministic replays. Funds transfer, open share, contact update and supervisor hold still lack accepted complete recording/replay evidence. The long, source-specific history remains in [live evidence](live-evidence.md); historical run IDs and producing SHAs are not relabeled as current runs.

## Architecture and delivered runtime

One Node/TypeScript process owns one Playwright browser run, the Express API, guarded native-form execution and the signed filesystem journal. The shared `InvocationService` keeps chat and direct API calls on the same caller-bound invocation path; server-side approval remains the only posting authority. A durable `dispatching` transition precedes a native post. A failed or unverified completion after that point is `POST_OUTCOME_UNKNOWN` and is never automatically retried.

The current baseline includes these reviewed repairs:

- PR #43: typed, validated pre-intent underfunding returns `business_outcome / INSUFFICIENT_FUNDS`; source `6ab82fe0cde9cc9dae64e5c69ca019753c42ad89`, merge `4f84b9fbcb9b5a1fc09cd05611277b3357561728`, 131 focused and 274 full offline tests, merge workflow `33940912820` / producer `101238031113`.
- PR #44: browser inspection works under the actual `node --import tsx` loader; head `0001b3d542446ff0b8ffbd7a8fe207d74ba08a80`, merge `096855697bdd91fbe27dde7843cb3f01513522a6`, 275 tests/17 files, head workflow `33944662021` / `101248476308`, merge workflow `33945029813` / `101249456017`.
- PR #45: transfer review facts are uniquely associated with the sibling posting form, including wrapped-form ambiguity and submit overrides; head `4789be8f2b26c47ccba375d7c1f4d62ea640e218`, merge `5c18923b6b043b0ed2630930e5ca6848e3513e5d`, 275 tests/17 files, head workflow `33947212609` / `101255382945`, merge workflow `33947319923` / `101255671770`.
- PR #46: a risk approval stays in Terminal with explicit `approve` + Return guidance while the runner owns the browser post; head `c4279ac9fb78edcd4847a8b7ad1146d7d259b920`, merge `8e625cc0db83ebc37ad62f2bc60f1d8feeec1d8c`, 276 tests/17 files, head workflow `33949006345` / `101260137449`, merge workflow `33949275807` / `101260869453`.
- PR #47: evidence metadata no longer lets payload fields replace trusted event/result status; head `66a9fb0b14450a81311c515e0d61b07a0a2449cb`, merge `2c7f4ed4577fe01bbfb441525b7cccc14128c46b`, identical tree `4c45496eb20e5c93a8f01ed8f0f00b0fb6187386`, 278 tests/17 files, final review, head workflow `33950233434` / `101263489851` and merge workflow `33950705840` / `101264800819` passed.

These gates verify source and offline behavior. They do not promote the transfer draft or prove a live write. The semantic member/share/amount/memo/completion comparators are currently transfer-specific; equivalent binding and completion evidence for the other writes remain missing.

## Verified evidence and adverse outcomes

The accepted reads and dashboard checkpoint are summarized in [the acceptance ledger](live-evidence.md#acceptance-ledger). The latest PR #44 tool check refreshed sign-on (`bd266309-7815-4230-84aa-3fbcdb611159`), inquiry (`a8a498d3-f29b-4082-92b0-29d5a54c8cb1`), member record (`266b78c5-b507-461f-a2cf-f960fe61cde0`) and caller chat/status (`11f47224-72bd-4aa4-bf28-1b4ed4bdb65b`). Each evaluator passed with zero mutation intents. The genuine dashboard read `288d7cae-c486-4f08-b810-c1e4aa1d4afe` visibly progressed from `running` to `success`, preserved caller/operator separation, exposed authenticated evidence and survived the scoped restart check. Offline approval, cancellation, identity, masking, typed-output and evaluator checks remain offline evidence only.

The original successful transfer discovery and independently verified resulting state remain historical; its artifact is still a draft and no replay exists. Later replacement attempts are adverse evidence, not consent. Three reached the current review/approval boundary after PR #45: `7a8dd317-77df-458e-bd2c-4768a5c4eb09` timed out, `50db3bb4-97a2-45ad-95e4-b72563b9f802` blocked a manual browser `Post Transfer` attempt and then aborted, and `e76197b9-1c6f-46cb-965d-094f60f93992` timed out after five minutes. Their evaluators passed with 17, 20 and 16 attempts respectively, each with zero mutation intents. No approval is reused. The historical open-share run remains `POST_OUTCOME_UNKNOWN` and must not be retried.

Business outcomes, recoverable conditions and hard errors stay distinct. Valid underfunding established before intent is a terminal business result. A known pre-intent maintenance condition may receive one bounded same-browser repair followed by checkpoint revalidation. Permission, expiry, policy/validation failures and application errors stop the run. Any failed or unverified post-intent result stays unknown.

## Current audit status and remaining acceptance

The discovery-input defect found at `8e625cc` remains present in current `2c7f4ed`: missing canonical public inputs can reach runtime/model work, emit a premature lower-layer success, and be compiled as literals for non-transfer capabilities. The unconditional transfer post backstop still blocks an unbound canonical transfer post. Its shared preflight/promotion repair is queued separately and is not integrated. PR #47 does not rewrite old private evidence.

Final acceptance still requires complete recordings, reviewed promotions and separately approved replays for all four writes; observed result selectors and headers; operation-specific business, recoverable and hard-error checks; stale/missing-token evidence; same-browser repair; approval/handoff keyboard checks; an integrated write rehearsal; sanitized ledger updates; and final local plus same-head hosted gates. Result extraction is unresolved, so no selector or output shape is promised.

The original target was three working days. Work has extended beyond that target across staged runtime, review and evidence repairs; this checkpoint does not hide that schedule variance. The six-column transfer result is an adaptable contract whose physical extraction still depends on observed HTML. The single-process design keeps journal and browser ownership simple but limits concurrency. Separate PRs improve review isolation at the cost of integration time.

Demonstrations must be labeled **live**, **offline fixture** or **recorded evidence**. Only separately approved and verified hosted operations can increase `3/7`. A model outage may use the existing API/operator path for an already approved artifact with a fresh key for a genuinely new replay. A target/browser outage may use sanitized recorded evidence and, when a browser exists, the existing offline fixture. Never switch modes during a write or retry an unknown post.

The user separately authorized parallel implementation of a Vercel AI SDK conversational backend and an [assistant-ui](https://www.assistant-ui.com/) component map. Backend commits `7eeb447` and `6353741` resolve locally on that isolated work; root has not independently verified its UI tests, PR or integrated acceptance. Final integration must preserve Express, the shared `InvocationService`, server approval, dashboard/auth/operator controls and authoritative run ID/status/result/evidence. Package versions and visual/interaction scope remain a final-phase gate; the UI work does not satisfy any of the seven live capabilities.
