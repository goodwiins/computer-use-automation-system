# MERIDIAN demo-day guide

This guide targets **https://web-sample.interface-hiring.com**, using the source
linked from the [README](../../README.md). Preparation baseline: `dev`
`e427275e93123dec6f2450607a554397725b0333` (September 8, 2026). The brief's
Friday, August 28 date has passed; the next presentation date needs confirmation.

The minimum presentation is a member balance success followed by a natural
missing-member outcome, both through the same chatbot/API/dashboard. The latest
recorded acceptance is **4/7 capabilities**; transfer, contact update and hold
remain incomplete. Earlier hosted evidence is available below. A fresh rehearsal
of the presentation build still requires valid target credentials and selected
member inputs. Do not describe the offline checks as that rehearsal.

## Prepare before the presentation

Follow [README setup](../../README.md#meridian-hosted-demo) in a dedicated checkout.
Install dependencies, Chromium and the UI build before losing network access.
Use the default filesystem journal for this single-process demonstration; optional
PostgreSQL conversation storage is not required. Preserve the existing evidence
directory and stable HMAC key. Stop the API before using standalone CLI commands
against its journal, then restart it for the presentation.

Select one exact current demo member and one deliberately absent member number.
The target may reset: a historical share count or member ID is not a current
precondition. Store those two inputs privately as `MEMBER` and `ABSENT_MEMBER` in
the presentation terminal. Do not enter target passwords into chat.

1. Run `npm run setup` and `npm run test:smoke`. For full `npm run ci`, configure
   `TEST_DATABASE_URL` for a disposable PostgreSQL 14 database as described in
   [regression setup](regression-tests.md); then run CI and `npm run validate`.
2. Start the API/UI with the README command and open `http://127.0.0.1:4180`.
3. Connect as caller. Connect performs a target sign-on; wait for the verified
   operator/role/branch message before continuing. In Activity, confirm sign-on,
   member inquiry and member record are available. An API token alone is not
   proof that the target login succeeded.
4. Rehearse the two runs below and retain their run IDs. Inspect authoritative
   status, results and safe evidence. Stop if a run requires operator attention.
5. Download/retain the repository's recorded evidence locally. Check each file
   opens with networking disabled. Keep the private current evidence and journal
   available only to the operator; do not upload `.env` or HMAC keys.

## Presentation script (about five minutes, label LIVE)

| Beat | Action | Show / completion condition |
| --- | --- | --- |
| 1. Reusable capability | Activity → capability catalog → member record | Approved version, typed `member` input and `shares` output. Explain that discovery recorded the artifact; replay uses no model. |
| 2. Success | Chat: “Show the share balances for member <selected MEMBER>.” | Wait for `Completed`, then show the share table and run ID. In Activity, open the same run and confirm `state: success`, `result.status: success` and columns `shareId`, `type`, `balance`, `status`. Row counts can change. |
| 3. Status | Chat: “What is the status of run <that run ID>?” | The original run and result; no fresh capability execution. A balance run can have one internal identity lookup; it is separate from a status request. |
| 4. Exceptional outcome | Chat: “Search for member number <selected ABSENT_MEMBER>.” | Wait for `Member not found`; Activity/API must report `business_outcome` and `NO_SUCH_MEMBER`. If the number exists, the exception was not demonstrated. |
| 5. Evidence | Open `Run details and evidence` for each run | Structured result, event timeline and masked evidence. Explain that HTTP 202 means accepted, not completed. |

The classifier interprets the message; there is no request-type selector. If it
asks for clarification, answer it rather than interpreting prose as execution.
The run's server status is authoritative. If the model is unavailable but the
hosted target works, use Activity's direct capability form or the API below.
That is a **live deterministic API/dashboard** demo; chat is then unavailable.

## Exact API path (no model required)

Run in a second terminal at the checkout root while `serve` is running. Replace
the two inputs with the selected values; keep this terminal out of recordings
while loading credentials.

```sh
export MEMBER='<selected exact member number>'
export ABSENT_MEMBER='<selected deliberately absent member number>'
CALLER_API_TOKEN="$(node --env-file=.env -p 'process.env.CALLER_API_TOKEN')"
API=http://127.0.0.1:4180
curl --fail-with-body -sS "$API/capabilities" \
  -H "Authorization: Bearer $CALLER_API_TOKEN"

# A new intentional balance request: save this key before submitting.
BALANCE_KEY="$(openssl rand -hex 32)"
BALANCE_BODY="$(node -e 'process.stdout.write(JSON.stringify({args:{member:process.env.MEMBER}}))')"
curl --fail-with-body -sS -X POST "$API/capabilities/meridian-member-record/invoke" \
  -H "Authorization: Bearer $CALLER_API_TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $BALANCE_KEY" --data "$BALANCE_BODY"
# HTTP 202: {"runId":"<UUID>"}. Copy the actual returned UUID:
RUN_ID='<returned UUID>'
curl --fail-with-body -sS "$API/runs/$RUN_ID" \
  -H "Authorization: Bearer $CALLER_API_TOKEN"
```

Repeat only the GET until terminal; do not poll by invoking again. Retain the
balance run ID before setting `RUN_ID` to the next response. Wait for the balance
and linked identity work to finish before the next request.

```sh
ABSENT_KEY="$(openssl rand -hex 32)"
ABSENT_BODY="$(node -e 'process.stdout.write(JSON.stringify({args:{searchMode:"number",searchValue:process.env.ABSENT_MEMBER}}))')"
curl --fail-with-body -sS -X POST "$API/capabilities/meridian-member-inquiry/invoke" \
  -H "Authorization: Bearer $CALLER_API_TOKEN" -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $ABSENT_KEY" --data "$ABSENT_BODY"
# Set RUN_ID to this response's UUID, then repeat the GET above until terminal.
```

The expected exception projection includes:

```json
{"state":"business_outcome","result":{"status":"business_outcome","outcomeCode":"NO_SUCH_MEMBER","detail":"No member records matched the search"}}
```

Refresh Activity to inspect API-started runs. A transport error is not proof of
rejection: retain the original key/body and use lookup-only recovery (add
`"lookupOnly":true` to the original body at the same invocation URL and key).
A 404 lookup does not prove an in-flight original request will never be accepted.
Do not create a replacement key to resolve uncertain acceptance.

## Optional escalation (label OFFLINE FIXTURE)

The existing scripted demonstration narrows a mock artifact's locator to force
a renamed-button failure, attaches to the same live mock browser, repairs the
step, and hands control back. It demonstrates repair, not human transaction
approval and not hosted MERIDIAN escalation acceptance.

```sh
# Terminal A: dedicated mock app, port 4173 must be free.
BREAK_MARKUP=1 npm run target-app
# Terminal B: opens a headed mock browser; do not run during a live operation.
npx tsx scripts/demo-escalation.ts
```

Use a separate terminal with no MERIDIAN credentials/config loaded. Stop the app
you started with Ctrl-C afterward. If a port is occupied, inspect its owner with
`lsof -nP -iTCP:4173 -sTCP:LISTEN`; do not kill another task's process.

## Network-independent backup (label RECORDED EVIDENCE)

These repository-relative links work from a downloaded checkout. They retain
their original producer SHAs and are not new runs of the presentation build.

| Backup | File / interpretation |
| --- | --- |
| Hosted chat/API/dashboard success | [Balance summary](evidence/ui-final-sep6/balance.json): run `56030b14-15c0-4d41-8e41-c593e228b934`, producer `53a6f5686b680bcb34f9232adef46fd44ce3d6b0`; 35 typed rows, matching card/dashboard, signed evaluator PASS, zero mutation intents. |
| Hosted chat/API/dashboard exception | [Missing-member summary](evidence/ui-final-sep6/missing-member.json): run `d3fbdd8c-21a5-46cc-9e1c-3cee890287c9`, same producer; `NO_SUCH_MEMBER`, signed evaluator PASS, status/reconnect without reinvocation. |
| Hosted recording/replay | [Member-record discovery log](evidence/member-record/discovery-log.jsonl), [replay log](evidence/member-record/replay-log.jsonl), [masked final image](evidence/member-record/final.png); provenance in [live evidence](live-evidence.md). |
| Hosted stopped escalation | [Pre-post escalation](evidence/transfer-checkpoint-sep6/attempt-2.json): run `56915f92-1942-4e03-a7f3-f72d363362f2`, producer `d1124eb7548705364a0e58b6d70f5d1a279f137e`; aborted with zero intents. It never reached the intended injected fault. |
| Mock repair completed | [Handoff log](../../evidence/escalation/handoff/log.jsonl), [result](../../evidence/escalation/handoff/result.json), [final image](../../evidence/escalation/handoff/028-success.png). |
| Current UI reference | [Activity image](evidence/ui-walkthrough/activity-1440.png) is an offline synthetic UI fixture; it is not a screenshot of the hosted runs above. |

The public hosted summaries contain hashes and metadata; they cannot independently
reauthenticate a private journal. For a new filesystem-journal run, evaluate the
retained private evidence with the same `.env`/HMAC key before shutting down:

```sh
node --env-file=.env --import tsx scripts/evaluate-run.ts evidence/meridian RUN_UUID
```

Replace the directory if `EVIDENCE_DIR` differs. Evaluator PASS validates evidence
and safety invariants; inspect `taskStatus` too, because a cleanly handled failure
can also pass evaluation. Keep run IDs, producer SHA, command/result and hashes
with any new backup. A short screen recording is still to be captured during the
fresh rehearsal: capture only the chat/Activity window after sign-in, exclude
credentials and private member details, and review it before sharing.

If the target is unavailable, the existing offline discovery → recording →
replay check runs without a model key or external application:

```sh
npx --no-install vitest run test/e2e.test.ts
```

This is the bundled local target and scripted model, not a mocked hosted-target
acceptance result. Never change modes during a write. `POST_OUTCOME_UNKNOWN`
means investigate using a separate read-only inquiry; it must not be retried.

## Remaining sign-off

Source/docs and local verification can be prepared now. Before calling the full
brief delivered, record a successful and exceptional run on the actual chosen
presentation build, confirm the live date, and capture/review the backup clip.
The three unaccepted write capabilities remain separate work; this minimum demo
does not claim seven-capability completion.
