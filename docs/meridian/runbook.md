# MERIDIAN demonstration runbook

For the concise presentation path, API examples and backup evidence, use the
[demo-day guide](demo-day.md). This document covers detailed operation and recovery.

Status: partial Task 9 checkpoint. Live acceptance is **4/7**: sign-on, member inquiry, member record and open share are accepted. Funds transfer, member update and supervisor hold still need complete recordings, promotion review and separately approved replays. See [open-share evidence](live-evidence.md#accepted-open-share-recording-and-replay) for its distinct approved pair and catalog checks. The earlier service checkpoint was `dev` merge `27767cfacd8ea6076969ce714d2f74438a39fb70`, including approval safety, auxiliary-page cleanup, transfer eligibility, assistant-ui, discovery outcome classification and historical field structure. Reviewed head `e9ab9d5` and this merge share tree `ab3fe003`; 710 tests, both typechecks/build and head/merge CI passed. These source gates do not create write acceptance. Preserve the historical successful transfer discovery/draft and the open-share `POST_OUTCOME_UNKNOWN` record; neither authorizes another post.

The user-selected Vercel AI SDK and assistant-ui stack merged through PR #84. Genuine final-head chat/API/dashboard balance and missing-member demos passed, including explicit status lookup and reconnect without duplicate runs; see [live evidence](live-evidence.md#merged-ui-exception-and-status-rehearsal). Express, shared `InvocationService`, server approval, authentication and operator boundaries remain authoritative. Final write acceptance remains open.

## Setup

For a private local demo, set `LOCAL_TELLER_LOGIN=1` before starting `serve`. Select the teller and Connect without entering an API credential, or select the supervisor and enter the configured target operator and password. Initial supervisor login requires a successful target sign-on confirming the operator, supervisor role and branch. The default is credential-only login.

This opt-in trusts local users with the existing caller allowlist and caller history. Local login accepts only same-origin requests over loopback and issues separate process-lifetime bearer tokens; it never returns either configured API key. Tokens stay in page memory and are invalid after a server restart. Switching operators or disconnecting clears the page session. Caller sessions cannot approve decisions or select supervisor execution; model tool calls remain caller-bound even after supervisor login. Authenticated operators can use the guided forms and approval controls described below. Do not enable this mode for a shared or remotely exposed deployment.

After reload, a supervisor must re-enter the operator and password. While an accessible, unexpired approval is pending, the same server process can restore its previously target-verified supervisor access without starting another sign-on. Fresh credentials and unchanged configured supervisor/profile context are required. A typo returns no token but does not discard otherwise valid proof; configuration changes, a new target verification or a server restart invalidate it. This restores application access only: the pending action still requires its own native facts and explicit decision.

Use Node 22.12+ (22.x), 24.x, or 26+ and the repository's existing dependencies:

```sh
npm ci
npx playwright install chromium
cp .env.example .env
chmod 600 .env
```

Fill `.env` with the supplied demo operator credentials, one configured OpenAI/Azure provider, distinct caller/operator tokens and a stable journal HMAC key. MERIDIAN resolves `operator`, `password` and `branch` from the configured TELLER or SUPERVISOR context; never pass them with `--param`. Generate secrets with `openssl rand -hex 32`, store them only in `.env`, and keep the HMAC key unchanged for the journal lifetime.

```sh
cu() { node --env-file=.env --import tsx cli.ts "$@"; }
```

`--profile meridian` selects the hosted entry point, route/form rules and policy. An explicit `POLICY_PATH` remains authoritative. `CU_CDP_PORT` is refused. Stop `cu serve` before CLI discovery/replay because the journal supports one process.

## Select and preserve request facts before any write

The earlier `601e266` checkpoint includes PR #49's offline checks for unknown, missing, extra and invalid canonical discovery inputs before journal/runtime/model work, plus exact declarations and executable binding checks during promotion. PRs #50–#51 add shared discovery condition handling and fault-scenario wiring; PRs #52–#54 add visible condition detection and scoped evaluator integrity checks. These repairs close their source/offline boundaries only; they do not authorize a live recording. Launch a discovery template below only after the capability's observed result mapping, request-bound write semantics, current facts and separate approval prerequisites are complete. Approved read replay remains the supported checkpoint path.

Current discovery runs the shared profile detectors and accepts the configured fault scenarios. Operation-specific exception acceptance still requires the plan's exact natural or injected trigger, discovery/replay pair, terminal journal, intent and independently observed POST evidence. In particular, the native absent-member pair does not satisfy the separate injected `notfound` / 404 discovery/replay case; the older injected probe is read-only route evidence only.

Do not start a write discovery until the operator has refreshed current state and explicitly selected every fact below. The target can reset and a share can change status. Do not assume seed data, select the first ambiguous match, or reuse old consent.

```sh
export MEMBER='<selected exact member number>'
export SOURCE_SHARE='<selected eligible source share>'
export DESTINATION_SHARE='<selected distinct eligible destination share>'
export AMOUNT='<selected transfer amount>'
export MEMO='<selected transfer memo>'
export SHARE_TYPE='<selected new-share type>'
export DEPOSIT='<selected opening deposit>'
export EMAIL='<selected email>'
export PHONE='<selected phone>'
export ADDRESS='<selected address>'
export HOLD_SHARE='<selected share for hold>'
export HOLD_REASON='<selected hold reason>'
export HOLD_NOTES='<selected hold notes>'
```

Before transfer, run the accepted member-inquiry/member-record read path only when current-state refresh is operationally required. Resolve `MEMBER` to one exact result, open that exact member record, and verify `SOURCE_SHARE` and `DESTINATION_SHARE` belong to it, are distinct, eligible and currently funded. Enter **Funds Transfer from that member record**. The global transfer menu bypasses this prerequisite and the guard refuses it.

Result extraction now has an implemented, fixture-proven grouped `tbody`/native-CSS path with improved structural evidence; use selectors observed in the new recording for that mapping. A six-column physical table is not required. Hosted receipt mapping and confirmation verification remain pending before claiming a valid artifact. Do not require an old screenshot, guess selectors or provenance, or post solely to inspect the result. Keep selected-operation handling and human posting approval separate, and stop before launch if a complete recording still cannot establish the declared outputs from observed HTML.

Failed extraction actions retain a fixed `extractionFailure` category in `action.end` evidence: `invalid_selector`, `cell_count`, `invalid_money`, `target_unresolved`, or `other`. These categories omit receipt values, selectors and raw exceptions. They do not reconstruct errors missing from older evidence. A failure after posting remains terminal `POST_OUTCOME_UNKNOWN`; availability reports the investigation requirement even when no approved artifact exists. An unavailable journal also blocks discovery readiness. Neither diagnostic metadata nor a source fix clears the unknown outcome or establishes transfer acceptance.

Generate and privately save a distinct request identity before each new request. Keep the same value only for a transport retry of that exact invocation. Never generate a new key to retry an uncertain post.

```sh
SIGNON_DISCOVERY_KEY="$(openssl rand -hex 32)"
INQUIRY_DISCOVERY_KEY="$(openssl rand -hex 32)"
MEMBER_DISCOVERY_KEY="$(openssl rand -hex 32)"
TRANSFER_DISCOVERY_KEY="$(openssl rand -hex 32)"
OPEN_SHARE_DISCOVERY_KEY="$(openssl rand -hex 32)"
UPDATE_DISCOVERY_KEY="$(openssl rand -hex 32)"
HOLD_DISCOVERY_KEY="$(openssl rand -hex 32)"
```

Record these values in the private operator worksheet before starting their commands. The accepted read discoveries must not be rerun merely to refresh this document. The following are exact CLI templates for a separately authorized recording session.

## Discovery commands

Every goal names the server references explicitly. The runtime records fill `operator`, fill `password` and select `branch` before Sign On even when the configured branch already appears selected.

```sh
cu discover --profile meridian --name meridian-sign-on \
  --goal 'Fill operator from {{operator}}, fill password from {{password}}, select branch from {{branch}}, then Sign On. Assert the authenticated menu and extract operator, branch and role as separate outputs.' \
  --idempotency-key "$SIGNON_DISCOVERY_KEY"

cu discover --profile meridian --name meridian-member-inquiry \
  --goal 'Fill operator from {{operator}}, fill password from {{password}}, select branch from {{branch}}, then Sign On. Search using searchMode and searchValue. Extract members with named member-number and name columns, excluding the legacy td header row. Do not select an ambiguous match.' \
  --param searchMode=number --param searchValue="$MEMBER" --sensitive searchValue \
  --idempotency-key "$INQUIRY_DISCOVERY_KEY"

cu discover --profile meridian --name meridian-member-record \
  --goal 'Fill operator from {{operator}}, fill password from {{password}}, select branch from {{branch}}, then Sign On. Run Member Inquiry, resolve member to exactly one result, open that exact member record, assert the member identity, and extract shares with shareId, type, balance and status, excluding the observed header row.' \
  --param member="$MEMBER" --sensitive member \
  --idempotency-key "$MEMBER_DISCOVERY_KEY"

cu discover --profile meridian --name meridian-funds-transfer \
  --goal 'Fill operator from {{operator}}, fill password from {{password}}, select branch from {{branch}}, then Sign On. Run Member Inquiry, resolve member to exactly one result, open that exact member record, verify its current eligible shares, and enter Funds Transfer from that record. Use only sourceShare, destinationShare, amount and memo selected by the operator. Inspect the uniquely associated review facts and request the native posting control. After the runner posts, assert completion and extract only result fields whose selectors, header handling and confirmation relationship are observed in this recording; stop if they cannot be established.' \
  --param member="$MEMBER" --param sourceShare="$SOURCE_SHARE" \
  --param destinationShare="$DESTINATION_SHARE" --param amount="$AMOUNT" --param memo="$MEMO" \
  --sensitive member --sensitive sourceShare --sensitive destinationShare --sensitive amount --sensitive memo \
  --idempotency-key "$TRANSFER_DISCOVERY_KEY"

cu discover --profile meridian --name meridian-open-share \
  --goal 'Fill operator from {{operator}}, fill password from {{password}}, select branch from {{branch}}, then Sign On. Resolve member to one exact record, use only shareType and deposit selected by the operator, inspect review, request the native posting control, assert the observed completion, and extract the observed new share identifier. Stop if completion or its selector is unresolved.' \
  --param member="$MEMBER" --param shareType="$SHARE_TYPE" --param deposit="$DEPOSIT" \
  --sensitive member --sensitive deposit \
  --idempotency-key "$OPEN_SHARE_DISCOVERY_KEY"

cu discover --profile meridian --name meridian-update-member \
  --goal 'Fill operator from {{operator}}, fill password from {{password}}, select branch from {{branch}}, then Sign On. Resolve member to one exact record, use only email, phone and address selected by the operator, request approval for the native Save Changes action, then verify the saved values from observed current UI.' \
  --param member="$MEMBER" --param email="$EMAIL" --param phone="$PHONE" --param address="$ADDRESS" \
  --sensitive member --sensitive email --sensitive phone --sensitive address \
  --idempotency-key "$UPDATE_DISCOVERY_KEY"

cu discover --profile meridian --operator SUPERVISOR --name meridian-place-hold \
  --goal 'Fill operator from {{operator}}, fill password from {{password}}, select branch from {{branch}}, then Sign On. Resolve member to one exact record, use only share, reason and notes selected by the operator, inspect review, request the native Apply Hold control, assert observed completion, and extract the observed held share. Stop if completion or its selector is unresolved.' \
  --param member="$MEMBER" --param share="$HOLD_SHARE" --param reason="$HOLD_REASON" --param notes="$HOLD_NOTES" \
  --sensitive member --sensitive share --sensitive notes \
  --idempotency-key "$HOLD_DISCOVERY_KEY"
```

## Approval and native posting

Each write form's hidden native token stays in browser memory. The runtime rechecks origin, frame, operator role/session, selected facts, token and outgoing URL-encoded body immediately before dispatch. Approval applies only to the current facts and expires after five minutes.

At a `risk_approval` prompt, the human reviews the current facts in **Terminal**, types `approve`, and presses Return, or uses the separate CLI commands below. The runner then checks the current facts again and performs the native post. Do not click `Post Transfer` or another final submit in the browser. Direct browser submission is unarmed, is blocked by the route guard and may display `ERR_FAILED`. Type `refuse` or `abort` + Return to refuse. A timeout aborts the run. Human repair is separate from a complete discovery and does not become reusable provenance.

### Standalone CLI approval commands

Leave the recording/replay Terminal running. In a second Terminal, use the same repository, OS user and host. Replace `RUN_UUID` with the run ID printed by the runner:

```sh
npx tsx cli.ts approval --run RUN_UUID
```

Review the returned action facts, destination, method, operator, branch, role, control, token-presence indicator, expiry and approval ID. Copy exactly one of the printed commands, or replace both placeholders here with those current IDs:

```sh
npx tsx cli.ts approve --run RUN_UUID --approval APPROVAL_UUID
# To refuse instead:
npx tsx cli.ts refuse --run RUN_UUID --approval APPROVAL_UUID
```

`approve` requires an interactive Terminal; it does not accept piped input. The runner also requires a TTY before opening its approval endpoint. These are client-side checks, not authentication of a human operator: another process running as the same OS user can send an approval directly to the socket. The local transport trusts all processes under that OS account; it does not isolate an automated agent from an operator sharing the account. `refuse` means abort, not retry or skip. Both commands require the explicit current approval ID. The first decision wins, including a decision entered at the original prompt. A wrong, duplicate, expired or unavailable approval fails without approving another action. The five-minute timeout and browser-close cancellation still apply; these commands cannot revive a stopped run or retry an unknown posting. Artifact promotion (`replay --approve`) remains a different operation and does not approve a transaction.

The standalone runner exposes only a same-user local Unix socket under `~/.cu-approvals`. No TCP port or persisted decision is added. If `CU_APPROVAL_DIR` is configured, use the same value for the runner and command; the directory must be private, owned by the current user and not a symlink. An insecure directory or an existing endpoint is rejected rather than overwritten. Run the commands on the runner host (for example, in an interactive SSH Terminal for a remote runner). They do not open the journal, so the recording process keeps its existing journal lock. Keep the socket directory and active endpoint unchanged while the runner is running: Node removes the bound socket path when its listener closes. If a crash leaves an endpoint behind, confirm that its runner has stopped before removing that exact stale socket; startup never replaces it automatically.

These commands cover standalone CLI recordings and replays. API-started runs continue using the authenticated operator dashboard or existing decision endpoint. The commands add no live capability acceptance by themselves.

Inspect a successful draft before promotion: login references, selectors, row/header handling, assertions, outputs, sensitive metadata, effective risk, native post ordering and result binding must all be supported by the recording. Promotion is artifact review, not transaction approval:

```sh
cu replay --artifact artifacts/meridian-funds-transfer.v1.0.0.json --approve
```

Promote each reviewed artifact separately. The server refuses duplicate versions, unapproved artifacts and incomplete MERIDIAN contracts.

## Replay and dashboard

Generate and privately save a new replay key for each genuinely new replay. The approved member-record artifact is the supported read demonstration; serialize its selected member input with Node:

```sh
MEMBER_RECORD_REPLAY_KEY="$(openssl rand -hex 32)"
MEMBER_RECORD_PARAMS="$(node -e 'process.stdout.write(JSON.stringify({member:process.env.MEMBER}))')"

cu replay --profile meridian \
  --artifact artifacts/meridian-member-record.v1.0.0.json \
  --params "$MEMBER_RECORD_PARAMS" \
  --idempotency-key "$MEMBER_RECORD_REPLAY_KEY"
```

The transfer command is future-only. Run it only after result extraction, complete recording, promotion review and the approved transfer artifact all exist. Serialize the selected values with Node so punctuation is preserved:

```sh
TRANSFER_REPLAY_KEY="$(openssl rand -hex 32)"
TRANSFER_PARAMS="$(node -e 'process.stdout.write(JSON.stringify({member:process.env.MEMBER,sourceShare:process.env.SOURCE_SHARE,destinationShare:process.env.DESTINATION_SHARE,amount:process.env.AMOUNT,memo:process.env.MEMO}))')"

cu replay --profile meridian \
  --artifact artifacts/meridian-funds-transfer.v1.0.0.json \
  --params "$TRANSFER_PARAMS" --attended \
  --idempotency-key "$TRANSFER_REPLAY_KEY"
```

`--attended` is required for a replay that can post. Repeat the same command/key only after a transport failure where the existing run can safely be returned; an unknown outcome is terminal and is never retried.

```sh
npm run build
cu serve --profile meridian
```

Open `http://127.0.0.1:4180` exactly. Caller and operator tokens stay in page memory; reload signs out. The chat model always has caller authority and cannot approve or select supervisor context. Operator chat runs are owned by the shared caller principal, visible to the caller token holder, and share its idempotency-key namespace; use distinct key prefixes for separate clients. The chat workspace also contains explicit operator forms and approval controls, backed by the same server authorization as Activity. The dashboard shows authorized catalog/history, active steps, safe evidence, status/result and pending interventions; operator decisions remain server-side. CLI risk approval follows the Terminal handoff above.

With subject tokens, HTTP refuses approval by the subject that requested the run; use the current approval CLI pathway because other operator subjects remain blocked by owner-only access.

The merged assistant-ui/Vercel AI SDK chat renders authoritative run results from the same API. Chat infers intent from each message; there is no request-type selector. A server-side model call with no executable capability tools classifies the latest message as a new request, a status question, or conversation. Only a new request exposes approved caller capability tools to the response model; status exposes only `run_status`, and conversation exposes no tools. Unclear requests should prompt clarification. A repeat must be explicitly requested in the message. Classification is model-based, while authorization, input validation, request identity, unknown-outcome blocking, and transaction approval remain enforced by the server. Status uses the original signed run; it never retries an unknown posting. The Next.js App Router frontend is statically exported by `npm run build`; `npm run serve` builds it automatically. Separate server instances snapshot the export into isolated directories. The default view is a full-height assistant-ui conversation; Activity opens the existing capability catalog, run history, evidence and operator approval controls. Exported bootstrap scripts use exact CSP hashes; no API credentials are included in the frontend build. Historical runs show recorded input/output field names and types with values withheld; files created before this metadata existed remain explicitly unavailable. Discovery business outcomes retain their category after service restart.

### Guided banking operations

Choose an operation in chat and enter the exact member number and requested values. Fields, required values and enums come from authenticated server contract metadata. An operator selects the target TELLER or SUPERVISOR context; an account hold requires SUPERVISOR. Selecting a role does not itself verify the target session.

| Operation | Requested values, in addition to member number | Native action |
| --- | --- | --- |
| Funds Transfer | From share, to share, amount, memo | Review, then Post |
| Open New Share | Share type, initial deposit | Review, then Post |
| Update Member Information | Email, phone, mailing address | Save Changes; the target has no separate review page |
| Place Account Hold | Share, reason code, notes | Supervisor review, then Post |

**Preview request** only displays the entered request. **Start operation** invokes an approved available recording. When a supported recording is missing, an authenticated operator can explicitly choose **Start supervised discovery**. Neither action automatically approves a write. At the native gate, review the fresh target facts and select **Accept** or **Reject** in the run card. These map to the existing server `approve` or `abort` decision for that exact run and intervention. Activity exposes the same shared approval state. A verified final result remains visible until dismissed; unknown outcomes remain blocked.

Discovery uses `POST /capabilities/:id/discover` with an `Idempotency-Key` and the same `{args, operator?}` body as invocation. It is limited to the canonical transfer, member-update and hold workflows, fixed server goals and operator authorization. The `/capabilities` response's `operationContracts` describes form shape; it is not proof of availability, an approved recording or extra permission. After a lost response, **Look up original request** sends the original body/key with `lookupOnly: true`; it does not start another attempt or switch from replay to discovery.

A genuinely verified discovery writes a private draft under `ARTIFACT_DIR/drafts/<runId>.json`. Draft creation does not approve or activate replay. Review and promotion remain separate, followed by controlled idle activation and a separately approved replay. The four chat forms and offline tests do not change the **4/7** live-acceptance ledger or unblock a historical unknown outcome.

## Faults, restart and result classes

A fresh successful member-record request also starts one approved member-inquiry read in number mode, using the exact requested member, caller and execution role. Its request key is `member-identity:<balance run ID>`; the balance response links the inquiry run ID. Verification requires exactly one matching member-number/name row. Missing permission, unavailable outputs, failure or ambiguity leaves the balance intact with identity unavailable. Status and same-key reuse never start another lookup. Names and linkage remain in server/page memory; the UI clears identity display on disconnect, reload or stale updates and never joins historical runs by recency. Restored results cannot recover the name. This composition does not change capability artifacts or posting/approval guards.

Use `--inject <kind> --fault-route <observed operation-entry GET path>` only after observing that exact GET route. The hook never applies to `/review`, `/post` or a POST. Do not guess a route or run a write-fault loop. Native POST-only rejection must be classified from its actual phase.

```sh
FAULT_REPLAY_KEY="$(openssl rand -hex 32)"
cu replay --profile meridian \
  --artifact artifacts/meridian-funds-transfer.v1.0.0.json \
  --params "$TRANSFER_PARAMS" --inject maintenance \
  --fault-route '<observed operation-entry GET path>' --attended \
  --idempotency-key "$FAULT_REPLAY_KEY"
```

- **Business outcome:** an observed pre-intent business rejection, including validated `INSUFFICIENT_FUNDS`, terminates without approval or dispatch.
- **Recoverable:** only a known pre-intent condition such as maintenance may receive one bounded same-browser repair; revalidate the checkpoint before approval.
- **Hard error:** permission, expiry, policy/validation or application failures stop. A failed or unverified completion after durable intent is `POST_OUTCOME_UNKNOWN`.

The signed journal lives under `EVIDENCE_DIR/journal`. On restart, incomplete undispatched runs become interrupted and dispatching runs become `POST_OUTCOME_UNKNOWN`; no browser action resumes. Do not delete records, replace the HMAC key or clear a lock owned by a live process.

The default `RUN_JOURNAL` mode is the signed filesystem journal. PostgreSQL authority is opt-in: set `RUN_JOURNAL=postgres`, `DATABASE_URL`, `JOURNAL_HMAC_KEY`, and any non-default `EVIDENCE_DIR` only after the cutover marker below has reached its authenticated `complete` phase. `DATABASE_URL` has an independent journal role: `RUN_JOURNAL=postgres` may run without `SUBJECT_API_TOKENS`, retaining the legacy caller/operator credentials and leaving conversation storage disabled. Conversation storage is enabled only when both `DATABASE_URL` and valid `SUBJECT_API_TOKENS` are present; outside PostgreSQL journal-only mode, a database URL without subject credentials remains the B1 fail-closed configuration error. `cu serve` migrates the enabled stores and opens the matching marker before it snapshots the UI or constructs the invocation service; a marker mismatch, pending import or unavailable database fails startup without a filesystem fallback. PostgreSQL admits one owner UUID at a time. Each authority transaction applies a 2-second lock timeout and 5-second statement timeout; reads check ownership without locking the authority row. Read timeouts return retryable 503 `Journal is busy; retry` and leave the instance healthy. Connection acquisition, BEGIN or timeout-setup failures return retryable 503 `Journal is unavailable; retry` before mutation. Only uncertain writes poison the active instance and require restart or operator recovery; static startup/maintenance reports a sanitized operation failure (or authentication failure for invalid rows). On shutdown, the service drains admitted setup, replay completion and browser cleanup before releasing the owner; an uncertain browser cleanup keeps that owner held for operator recovery.

PostgreSQL run rows carry an HMAC `signature` over all journal record fields and durable dispatch intent, using the journal key and a PostgreSQL run domain. Reservation, update, authenticated snapshot import and explicit recovery write signatures atomically. Safety checks authenticate all rows before computing active-run or capability quarantine decisions; changing a capability cannot hide an unknown outcome. This scan is linear in retained history.

New tables require `signature`; the idempotent upgrade adds it nullable to existing tables without signing old rows. Missing or mismatched signatures fail closed with `Journal authentication failed`. Preexisting unsigned rows require an independently trusted, authenticated snapshot imported through the snapshot import path into a fresh empty authority under a separately approved migration. Preserve the old authority and evidence, fence its worker, and reconcile all post-cutover activity before preparing that snapshot. The ordinary repeat-import command only verifies an initialized authority and cannot repair unsigned rows. Do not delete rows, sign current database contents blindly, remove a completed cutover marker, or re-import a stale filesystem snapshot; if no complete trusted snapshot exists, remain fenced pending operator reconciliation.

Each new reservation records immutable `invocationScope` metadata (`public` or `member-identity`) alongside the signed filesystem record or nullable PostgreSQL `invocation_scope` column. Only the internal number-mode member-identity inquiry uses the private scope; ordinary direct member inquiries, including requests with internal-looking keys, are public. Missing/`NULL` scope is legacy-unclassified: historical `meridian-member-inquiry` is treated conservatively as private, while other historical capabilities remain public. This metadata contains no request facts, member values, results, credentials or approvals. Private child runs stay out of caller GET/history and public invoke/lookup recovery; an authorized operator sees only the fixed pending repair projection while its exact live intervention remains pending.

A fresh public API reservation additionally stores `recoveryRequest` in the signed filesystem record or nullable `recovery_request` in PostgreSQL. This is only a domain-separated HMAC of the public capability ID, the original raw argument map and the requested operator role; no raw argument, member fact or credential is written. Internal/private reservations and legacy records leave the field absent/`NULL`. Direct `lookupOnly` recovery requires the same owner, original direct invocation key, capability and exact recovery digest. A status alias remains valid for the read-only `/api/chat/request` status endpoint but never authorizes direct invocation recovery. Legacy `NULL` records use the current approved artifact and versioned exact-request check, failing closed if the artifact is removed. Filesystem snapshot import and PostgreSQL cutover preserve the optional digest and do not rewrite legacy records or their authenticated import identity.

## One-way filesystem journal cutover

Stop the filesystem service and verify that no process owns the journal before importing. Inspect `EVIDENCE_DIR/journal/server.lock` and `startup.lock` with read-only filesystem tools; a stale lock requires operator investigation and is never removed automatically. The importer takes `startup.lock`, rejects any `server.lock`, authenticates every signed record and alias, and writes `postgres-authority.json` with a signed `pending` phase before the database attempt.

Set `DATABASE_URL`, `JOURNAL_HMAC_KEY`, and (when non-default) `EVIDENCE_DIR`, then run the operator command from the repository:

```sh
npx tsx cli.ts journal-import
```

The command is safe to repeat after a lost acknowledgment. It reuses the marker only when its authenticated snapshot digest matches, and PostgreSQL preserves the original `runId`, request identity, aliases, optional recovery digest, and unknown outcomes. A successful acknowledged import atomically publishes the signed `complete` phase. A failed database attempt leaves `pending`; both filesystem runtime startup and completed-marker runtime reads remain fenced until the import is resolved. There is no rollback to an older filesystem journal.

After cutover, inspect ownership with read-only SQL:

```sql
SELECT import_id, source_digest, owner_id
FROM meridian_journal_authority
WHERE singleton = true;
```

If a process died while holding the PostgreSQL authority, verify it independently and recover only with the exact displayed owner UUID and explicit fence confirmation:

```sh
npx tsx cli.ts journal-recover --owner <owner-uuid> --confirm-fenced
```

Recovery requires the configured `JOURNAL_HMAC_KEY`, authenticates every row before making safety decisions, and signs each changed row in the owner-fenced transaction. Recovery converts unfinished non-dispatching runs to `interrupted`, preserves dispatching intent as `POST_OUTCOME_UNKNOWN`, and releases only that exact owner. These are operator instructions for a stopped, approved environment; do not run them against production without the required change approval and evidence capture.

## Verification and demonstration labels

```sh
npm run ci
npm run validate
git diff --check
```

Final delivery also requires hosted checks on the same final head and separate verification of the merged `dev` SHA. Current runtime/UI gates and their earlier history are recorded in [the report](report.md) and [live evidence](live-evidence.md). PR #84 head workflow `34031468183` / producer `101481646089` and merge workflow `34033072454` passed. Those earlier source gates did not establish write acceptance; the later open-share pair is recorded separately.

Label every demonstration **live**, **offline fixture** or **recorded evidence**. Only a hosted, separately approved and verified operation can raise the accepted capability count. If the model alone is unavailable, the API/operator path may replay an already approved artifact with a new key for a genuinely new request. If target/browser access is unavailable, show sanitized recorded evidence and run the existing offline fixture only when a browser exists. Never switch modes during a live write or retry the preserved unknown posting.

The existing **offline fixture** command is:

```sh
npx vitest run test/e2e.test.ts
```

It exercises the scripted-model/local-target discovery-to-replay path. It is not hosted evidence and does not increase the accepted capability count.
