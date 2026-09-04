# MERIDIAN demonstration runbook

Status: implementation in progress. Three live LLM-discovered read artifacts are reviewed and replayed: sign-on, member inquiry, and member record. Four write capabilities and verified approved postings remain incomplete. [Live evidence](live-evidence.md) records the completed reads and the separate unknown posting; never retry that posting.

## Setup

Use Node 22 and the existing dependencies:

```sh
npm ci
npx playwright install chromium
cp .env.example .env
chmod 600 .env
```

Fill the local `.env` with the demo operator credentials from the assignment, one OpenAI/Azure provider, and distinct random caller/operator/HMAC keys. The HMAC key must remain stable for the lifetime of the journal. Generate each key with `openssl rand -hex 32` and put it only in `.env`. The file is ignored by Git. Azure requires endpoint, API key, and deployment; otherwise set `OPENAI_API_KEY`. Empty credentials fail startup or discovery.

```sh
cu() { node --env-file=.env --import tsx cli.ts "$@"; }
```

The default MERIDIAN entry point is `https://web-sample.interface-hiring.com/signon`. `--profile meridian` chooses its route/form rules and policy. An explicit `POLICY_PATH` remains authoritative; selecting a profile never widens that policy. `CU_CDP_PORT` is refused for MERIDIAN. Browser windows open locally.

## Record the seven capabilities

Stop the API before CLI discovery/replay: the filesystem journal permits one process. Each CLI invocation below needs a fresh `--idempotency-key` for a genuinely new request; reuse the same key after a transport retry. The key identifies discovery as well as replay. Never use a new key to retry an uncertain posting.

First select current synthetic data manually from the hosted app. Set the following shell variables to those explicit choices (do not assume seed balances or select the first ambiguous result): `MEMBER`, `LAST_NAME`, `SOURCE_SHARE`, `DESTINATION_SHARE`, `HOLD_SHARE`, `EMAIL`, `PHONE`, `ADDRESS`. The source and destination must be suitable current shares; the target has accumulated state and some shares are on hold.

The commands below are recording instructions, not a claim that these recordings have run:

```sh
cu discover --profile meridian --name meridian-sign-on \
  --goal 'Sign on and extract operator, branch and role as separate outputs; assert the authenticated menu.' \
  --idempotency-key record-signon-1

cu discover --profile meridian --name meridian-member-inquiry \
  --goal 'Sign on, search using searchMode/searchValue, and extract the results table as members. Do not select a match. Use named member-number and name columns and exclude the td header row.' \
  --param searchMode=number --param searchValue="$MEMBER" --sensitive searchValue \
  --idempotency-key record-inquiry-1

cu discover --profile meridian --name meridian-member-record \
  --goal 'Sign on, open the exact member record, assert it, and extract shares as a table with shareId, type, balance (money) and status. Exclude the td header row.' \
  --param member="$MEMBER" --sensitive member --idempotency-key record-member-1

cu discover --profile meridian --name meridian-funds-transfer \
  --goal 'Sign on and transfer amount from sourceShare to destinationShare for member with memo. Select share values, inspect review, request the posting click, then assert completion and extract confirmation and a transaction table verifying the posted details.' \
  --param member="$MEMBER" --param sourceShare="$SOURCE_SHARE" --param destinationShare="$DESTINATION_SHARE" \
  --param amount=0.01 --param memo=Demo --sensitive member --sensitive sourceShare --sensitive destinationShare \
  --sensitive amount --sensitive memo --idempotency-key record-transfer-1

cu discover --profile meridian --name meridian-open-share \
  --goal 'Sign on, open shareType for member with deposit, review, request the posting click, assert completion and extract the new shareId.' \
  --param member="$MEMBER" --param shareType=S0001 --param deposit=5.00 \
  --sensitive member --sensitive deposit --idempotency-key record-share-1

cu discover --profile meridian --name meridian-update-member \
  --goal 'Sign on, fill email/phone/address for member, request Save Changes approval, assert the saved result and extract saved containing the verified updated information.' \
  --param member="$MEMBER" --param email="$EMAIL" --param phone="$PHONE" --param address="$ADDRESS" \
  --sensitive member --sensitive email --sensitive phone --sensitive address --idempotency-key record-update-1

cu discover --profile meridian --operator SUPERVISOR --name meridian-place-hold \
  --goal 'Sign on as the configured supervisor, place a hold on share for member with reason/notes, review, request Apply Hold approval, assert completion and extract heldShare.' \
  --param member="$MEMBER" --param share="$HOLD_SHARE" --param reason=FRAUD --param notes=Demo \
  --sensitive member --sensitive share --sensitive notes --idempotency-key record-hold-1
```

Discovery requires a real interactive terminal for each posting approval. Approval permits automation to execute and record the click. An actual human repair makes the discovery incomplete and requires a fresh complete recording. Runtime passwords resolve from environment configuration; do not pass operator, password, or branch with `--param`.

Inspect every draft artifact. Confirm login references, selectors, table row/column selectors, post-action assertions, outputs, sensitive metadata, and effective mutation risk. MERIDIAN's data tables use `td` headers; use an explicit data-row selector such as `:scope > tbody > tr:nth-child(n+2)` where the live table warrants it. Do not manufacture provenance or replace missing live behavior with a fixture.

Promotion is a review operation, distinct from approving a transaction:

```sh
cu replay --artifact artifacts/meridian-member-record.v1.0.0.json --approve
```

Promote each reviewed artifact separately. Keep one pinned version per ID in `ARTIFACT_DIR`; the server refuses duplicate versions. Loading a MERIDIAN artifact validates the seven named contracts, login references and required recorded outputs. Write artifacts also require a posting step followed by assertions and extraction.

## Replay and launch the dashboard

```sh
cu replay --profile meridian --artifact artifacts/meridian-member-record.v1.0.0.json \
  --params '{"member":"REPLACE_WITH_MEMBER"}' --idempotency-key lookup-1
cu serve --profile meridian
```

Open `http://127.0.0.1:4180` exactly (the Host check rejects other aliases). Enter the caller or operator API token; it stays in page memory and a reload signs out. Choose a capability and enter its public inputs, or use chat. Chat always uses caller authority, including when an operator is logged into the page.

The runtime verifies the operator role on the signed-on menu and binds it to the current target session identity. Posting rechecks that identity, profile detectors, review facts, and the current token. The outgoing native URL-encoded POST must exactly match the inspected form data; JavaScript changes during submission are refused. Unsupported form encodings or field types fail closed. Token values and session identifiers remain private in memory.

The dashboard displays progress, recovery, results, safe evidence, and pending interventions. The operator sees the live transaction facts and selects Approve submission or Abort. Repair interventions allow Retry after repair or Abort; there is no unchecked Skip. The browser remains the same window during a handoff. Closing it cancels the intervention. Runs have a ten-minute deadline and approvals a five-minute maximum.

## API

All API and evidence routes require a bearer header; only the page and static assets are public. Configure `CALLER_CAPABILITIES` as a comma-separated allowlist. Only operator credentials can select `SUPERVISOR` or decide an intervention.

| Method and route | Contract |
| --- | --- |
| GET `/capabilities` | Principal and authorized pinned catalog; OpenAI and MCP descriptors; server parameters omitted |
| POST `/capabilities/:id/invoke` | `{args: {...}, operator?: "TELLER" or "SUPERVISOR"}` plus `Idempotency-Key`; returns `202 {runId}` |
| GET `/runs`, `/runs/:id` | Authorized history/detail; results and evidence filenames |
| POST `/runs/:id/decision` | `{approvalId, decision: "approve" or "retry" or "abort"}`; only the matching pending decision is accepted |
| GET `/runs/:id/evidence/:file` | Authenticated, validated evidence file |
| POST `/chat` | `{messages: [{role: "user" or "assistant", content}]}` plus a request key; one bounded interpretation call and the same invocation service |

Same principal/key and normalized request return the original run, including after restart. A changed payload or context returns 409. One active run causes 429 for a different request. Caller access to an operator run or approval returns 403. Duplicate/stale decisions return 409. Keep secrets in headers, never query strings.

## Faults, restart, and uncertainty

Test-only CLI fault injection applies once to the actual operation request, not sign-on, and never changes global settings:

```sh
cu replay --profile meridian --artifact artifacts/meridian-funds-transfer.v1.0.0.json \
  --params '{"member":"REPLACE_WITH_MEMBER","sourceShare":"REPLACE_SOURCE","destinationShare":"REPLACE_DESTINATION","amount":"0.01","memo":"Demo"}' \
  --inject maintenance --fault-route /members/REPLACE_WITH_MEMBER/transfer \
  --attended --idempotency-key maintenance-test-1
```

Repeat with fresh test requests for `validation`, `notfound`, `permission`, `timeout`, and `server`. These flags are absent from chat and ordinary API invocation schemas. Maintenance's observed Continue link returns to the menu; clearing the notice alone does not prove the interrupted capability can finish. It may require bounded human repair. Session expiry and permission errors stop; they do not upgrade roles or log in again.

The journal lives at `EVIDENCE_DIR/journal` with signed records, exclusive creation, atomic replacement and file/directory synchronization. On restart, incomplete undispatched runs become interrupted; dispatching runs become `POST_OUTCOME_UNKNOWN`. No browser action resumes. The same key still identifies that run. A separate read-only inquiry can help investigate; it does not rewrite the original outcome. This is request deduplication, not exactly-once execution at a UI-only target.

Do not delete records or replace the HMAC key during the demo. A wrong key fails startup. A dead process's main lock is recovered under an exclusive startup lock. If a process dies during the short startup-lock section, verify it is stopped before manually removing `startup.lock`. Never clear a lock held by a live process.

## Verification and remaining live gates

```sh
npm run ci
npm run validate
git diff --check
```

`test/meridian.test.ts` contains small offline fixtures for request identity, approvals, live-control checks, private credential resolution, structured extraction, masking and HTTP auth. Existing mock fixtures remain under `test/fixtures/` and can be exercised with `npm test`. They are not a second MERIDIAN app or proof of live coverage.

Before delivery, obtain real LLM recording/replay evidence for all seven functions, approve and verify each actual posting, exercise natural and injected errors (including last-name ambiguity and teller/supervisor holds), check token rejection, rehearse chat/API/dashboard together, and inspect hosted CI on the final SHA. None of those gates may be inferred from the offline suite alone.
