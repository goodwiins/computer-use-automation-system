# MERIDIAN demonstration runbook

Status: partial Task 9 checkpoint. Live acceptance remains **3/7**: sign-on, member inquiry and member record are accepted. Funds transfer, open share, member update and supervisor hold still need complete recordings, promotion review and separately approved replays. The current integrated baseline is `dev` merge `a80ac4e48138efd916fad8fe23f94b93767c5d97`, including approval safety, auxiliary-page cleanup, transfer eligibility and assistant-ui integration. Reviewed head `53a6f56` and this merge share tree `25e6d5`; 699 tests, both typechecks/build and head/merge CI passed. These source gates do not create write acceptance. Preserve the historical successful transfer discovery/draft and the open-share `POST_OUTCOME_UNKNOWN` record; neither authorizes another post.

The user-selected Vercel AI SDK and assistant-ui stack merged through PR #84. Genuine final-head chat/API/dashboard balance and missing-member demos passed, including explicit status lookup and reconnect without duplicate runs; see [live evidence](live-evidence.md#merged-ui-exception-and-status-rehearsal). Express, shared `InvocationService`, server approval, authentication and operator boundaries remain authoritative. Final write acceptance remains open.

## Setup

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
cu serve --profile meridian
```

Open `http://127.0.0.1:4180` exactly. Caller and operator tokens stay in page memory; reload signs out. Chat always has caller authority and cannot approve or select supervisor context. The dashboard shows authorized catalog/history, active steps, safe evidence, status/result and pending interventions; operator decisions remain server-side. CLI risk approval follows the Terminal handoff above.

The merged assistant-ui/Vercel AI SDK chat renders authoritative run results from the same API. Chat defaults to **Check run status** on connection and after a run: it can inspect an existing run without executing another capability. Choose **New operation** explicitly for a new request, including a deliberate repeat with identical arguments. Status uses the original signed run; it never retries an unknown posting. Separate server instances build isolated UI assets.

## Faults, restart and result classes

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

## Verification and demonstration labels

```sh
npm run ci
npm run validate
git diff --check
```

Final delivery also requires hosted checks on the same final head and separate verification of the merged `dev` SHA. Current runtime/UI gates and their earlier history are recorded in [the report](report.md) and [live evidence](live-evidence.md). PR #84 head workflow `34031468183` / producer `101481646089` and merge workflow `34033072454` passed. None of these gates closes the four writes or raises live acceptance above 3/7.

Label every demonstration **live**, **offline fixture** or **recorded evidence**. Only a hosted, separately approved and verified operation can raise `3/7`. If the model alone is unavailable, the API/operator path may replay an already approved artifact with a new key for a genuinely new request. If target/browser access is unavailable, show sanitized recorded evidence and run the existing offline fixture only when a browser exists. Never switch modes during a live write or retry the preserved unknown posting.

The existing **offline fixture** command is:

```sh
npx vitest run test/e2e.test.ts
```

It exercises the scripted-model/local-target discovery-to-replay path. It is not hosted evidence and does not increase `3/7`. These commands are documented for an operator; none was run during this prose-only repair.
