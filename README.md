# Computer-Use Automation System

An LLM discovers how to complete a goal against a live legacy-style UI, records
what it learned as a **typed, versioned capability artifact**, and from then on
the capability replays **deterministically — no model in the loop** — with an
explicit error taxonomy, safety guardrails, and a human-escalation path that
takes over the live session.

> The model discovers. The artifact becomes a reusable capability.
> Deterministic replay is how an AI agent invokes it in production.

What it is for, in concrete terms: **[docs/use-cases.md](docs/use-cases.md)**.
Design rationale, trade-offs, and cut lines: **[REPORT.md](REPORT.md)**.
Evidence from real runs: **[evidence/](evidence/)**.

![Architecture](docs/architecture.png)

## MERIDIAN hosted demo

The assignment target is **https://web-sample.interface-hiring.com**. Start here:
[demo-day guide](docs/meridian/demo-day.md),
[copy-and-paste chat prompts](docs/meridian/demo-day.md#copy-and-paste-chat-prompts),
[short adaptation write-up](docs/meridian/adaptation-writeup.md), and
[recorded hosted evidence](docs/meridian/live-evidence.md).
The latest recorded acceptance is **4/7 capabilities**; transfer, contact update
and supervisor hold remain incomplete. A fresh live rehearsal of the presentation
build is still required. The local mock walkthrough below is a separate fallback.

Source: [repository](https://github.com/goodwiins/computer-use-automation-system),
branch `codex/demo-deliverables`, based on `dev` at
`e427275e93123dec6f2450607a554397725b0333`.

### Install and configure

Use Node **22.12+ within 22.x**, matching CI. In a dedicated checkout:

```sh
git clone --branch codex/demo-deliverables https://github.com/goodwiins/computer-use-automation-system.git
cd computer-use-automation-system
npm run setup
npm run test:smoke
cp .env.example .env
chmod 600 .env
```

Fill `.env` locally; never commit it:

| Setting | Purpose |
| --- | --- |
| `MERIDIAN_TELLER_OPERATOR`, `MERIDIAN_TELLER_PASSWORD`, `MERIDIAN_BRANCH` | Supplied target login and branch, required for the read demo. |
| `MERIDIAN_SUPERVISOR_OPERATOR`, `MERIDIAN_SUPERVISOR_PASSWORD` | Required only for supervisor target operations/login. |
| `CALLER_API_TOKEN`, `OPERATOR_API_TOKEN`, `JOURNAL_HMAC_KEY` | Three distinct values of at least 32 characters; generate each with `openssl rand -hex 32`. Keep the journal key stable. |
| `CALLER_CAPABILITIES` | For the minimal demo: `meridian-sign-on,meridian-member-inquiry,meridian-member-record`. |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Discovery and natural-language chat. Alternatively configure the Azure settings in `.env.example`; Azure takes precedence. Replay/direct API does not need a model key. |
| `EVIDENCE_DIR`, `ARTIFACT_DIR`, `PORT` | Defaults: `evidence/meridian`, `artifacts`, `4180`. Preserve the evidence directory; do not reset an existing journal. |
| `LOCAL_TELLER_LOGIN` | Leave `0` for API-credential login; `1` enables the private loopback teller shortcut. Connect still verifies target sign-on. |

PostgreSQL is optional; leave its settings unset for this filesystem-journal demo.
See [the full runbook](docs/meridian/runbook.md) for storage/approval configuration.

### Run the capability API, chatbot and dashboard

```sh
npm run build
node --env-file=.env --import tsx cli.ts serve --profile meridian
```

One process serves all three at **http://127.0.0.1:4180** (use `127.0.0.1`, not
`localhost`). Open that URL, enter the caller API credential and Connect. Wait
for the verified target sign-on. Chat is the main view; **Activity** contains the
catalog, direct invocation, run history, results and evidence. A static `out/`
preview alone cannot execute capabilities. `.env` is loaded explicitly by the
command above; `npm run serve` alone does not load it.

### Record and replay against the hosted target

Use a dedicated recording checkout and stop `serve` first: the default journal
has one process owner. Discovery below writes the canonical artifact filename;
retain the existing reviewed artifact before deliberately re-recording it.
The existing approved artifact can be replayed without new discovery.

```sh
cu() { node --env-file=.env --import tsx cli.ts "$@"; }
export MEMBER='<selected exact demo member number>'
MEMBER_DISCOVERY_KEY="$(openssl rand -hex 32)"
cu discover --profile meridian --name meridian-member-record \
  --goal 'Fill operator from {{operator}}, fill password from {{password}}, select branch from {{branch}}, then Sign On. Run Member Inquiry, resolve member to exactly one result, open that exact member record, assert the member identity, and extract shares with shareId, type, balance and status, excluding the observed header row.' \
  --param member="$MEMBER" --sensitive member \
  --idempotency-key "$MEMBER_DISCOVERY_KEY"
```

A successful recording writes `artifacts/meridian-member-record.v1.0.0.json` as a
draft and prints its evidence directory/run ID. Inspect recorded selectors,
assertions, outputs and credential references before promotion. Stop on an
incomplete recording; do not promote a guessed or repaired trace.

```sh
# Artifact review approval, not approval of a banking transaction:
cu replay --artifact artifacts/meridian-member-record.v1.0.0.json --approve
npm run validate

# Save this key for this new intentional replay.
MEMBER_REPLAY_KEY="$(openssl rand -hex 32)"
MEMBER_PARAMS="$(node -e 'process.stdout.write(JSON.stringify({member:process.env.MEMBER}))')"
cu replay --profile meridian \
  --artifact artifacts/meridian-member-record.v1.0.0.json \
  --params "$MEMBER_PARAMS" --idempotency-key "$MEMBER_REPLAY_KEY"
```

Expected: `status: success` with typed `shares` rows. Restart `serve`, then ask
chat **“Show the share balances for member <selected member number>.”** Wait for
Completed and inspect the same run in Activity. Follow with **“Search for member
number <selected deliberately absent member number>.”** Expect `business_outcome`
/ `NO_SUCH_MEMBER`, not a success balance. Exact HTTP invocation/polling commands,
a five-minute presentation sequence and local backup links are in the
[demo-day guide](docs/meridian/demo-day.md).

If the model is unavailable, direct API/dashboard replay still uses the hosted
target. If the target is unavailable, label the existing local demonstration
**offline fixture**, or show **recorded evidence**. After setup/build, this
scripted-model/local-browser discovery → record → replay check needs no keys or
external service:

```sh
npx --no-install vitest run test/e2e.test.ts
```

## Local mock setup

Requirements: Node 22.12+ (22.x), 24.x, or 26+, an OpenAI API key (discovery only — replay never needs one).

```bash
npm run setup       # lockfile install + Chromium
npm run test:smoke  # local browser/tsx and evidence checks; no API keys needed

# Local CI: run `npm run ci` (typechecks + full suite) by hand, or wire it
# to run automatically before every push:
git config core.hooksPath .githooks

# Discovery credentials — either plain OpenAI:
export OPENAI_API_KEY=sk-...
# optional: export OPENAI_MODEL=gpt-5.6-luna   (default)

# ...or Azure OpenAI (takes precedence when set):
export AZURE_OPENAI_ENDPOINT='https://<resource>.openai.azure.com'
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_DEPLOYMENT='<deployment name, used as the model>'
# optional: export AZURE_OPENAI_API_VERSION=2024-10-21
```

For the walkthrough below, the target application is a deliberately hostile mock
"legacy credit-union servicing" app (framesets, nested tables, no test IDs)
that ships in this repo — no external services, no real credentials, no real PII.

For fresh worktrees, focused checks and failure diagnosis, see [AGENTS.md](AGENTS.md).
On Linux, `npm run setup -- --with-deps` also installs Chromium's system dependencies.

## Local mock demo path

**1. Start the target app** (keep it running in its own terminal):

```bash
npm run target-app
```

**2. Discovery — the LLM works out the flow and records a capability:**

```bash
npm run discover -- --goal "Look up member 12345 and read their current savings balance" \
  --name lookup-member-balance --param memberId=12345
```

This produces `artifacts/lookup-member-balance.v1.0.0.json` (status: `draft`)
and a full evidence trail under `evidence/runs/<runId>/`.

**3. Review + approve the artifact** (drafts refuse to replay unattended):

```bash
npm run replay -- --artifact artifacts/lookup-member-balance.v1.0.0.json --approve
```

**4. Deterministic replay — different member, no LLM:**

```bash
npm run replay -- --artifact artifacts/lookup-member-balance.v1.0.0.json --params '{"memberId":"23456"}'
```

Returns `{"status":"success","outputs":{"savings_balance":"9,812.55"}}`.

**5. Error & exceptional-state replays:**

```bash
# Legitimate business outcome — not a crash:
npm run replay -- --artifact artifacts/lookup-member-balance.v1.0.0.json --params '{"memberId":"99999"}'
#   -> {"status":"business_outcome","outcomeCode":"NO_SUCH_MEMBER", ...}

# Recoverable interstitial — dismissed automatically, run still succeeds:
npm run replay -- --artifact artifacts/lookup-member-balance.v1.0.0.json --params '{"memberId":"12345"}' \
  --entry-override "http://localhost:4173/?sim=maintenance"

# Hard failure — session expiry detected and reported with evidence:
npm run replay -- --artifact artifacts/lookup-member-balance.v1.0.0.json --params '{"memberId":"12345"}' \
  --entry-override "http://localhost:4173/?sim=timeout"

# Hard failure — permission denied (operator security profile), fatal detector:
npm run replay -- --artifact artifacts/lookup-member-balance.v1.0.0.json --params '{"memberId":"12345"}' \
  --entry-override "http://localhost:4173/?sim=denied"

# Hard failure — an unexpected native confirm() dialog is dismissed (never accepted)
# and named in the failure that follows:
npm run replay -- --artifact artifacts/lookup-member-balance.v1.0.0.json --params '{"memberId":"12345"}' \
  --entry-override "http://localhost:4173/?sim=confirm"
#   -> {"status":"failure","failure":{"stepId":"s2","observed":"unexpected confirm dialog \"...\" was dismissed at s1; then ..."}}
```

**6. The mutating flow — second capability** (form fill → confirmation review, commit never clicked):

```bash
npm run discover -- --goal "For member 12345, start opening a new sub-account of type Secondary Savings with nickname VACATION FUND and initial deposit 25.00. Stop at the confirmation review screen — do NOT click Open Account — and read the confirmed nickname and deposit from the review table." \
  --name open-subaccount-to-confirmation --param memberId=12345 --param nickname="VACATION FUND" --param deposit=25.00
npm run replay -- --artifact artifacts/open-subaccount-to-confirmation.v1.0.0.json --approve
# Different member and values:
npm run replay -- --artifact artifacts/open-subaccount-to-confirmation.v1.0.0.json \
  --params '{"memberId":"23456","nickname":"RAINY DAY","deposit":"50.00"}'
# Below-minimum deposit -> business_outcome VALIDATION_REJECTED:
npm run replay -- --artifact artifacts/open-subaccount-to-confirmation.v1.0.0.json \
  --params '{"memberId":"12345","nickname":"TEST","deposit":"1.00"}'
```

**7. Human escalation & handoff** (scripted end-to-end demo):

```bash
# Terminal A — start the app with simulated vendor drift (renamed button):
BREAK_MARKUP=1 npm run target-app

# Terminal B — replay hits the drift, escalates, a scripted "operator"
# attaches to the SAME live session over CDP, performs the step, hands back:
npx tsx scripts/demo-escalation.ts
```

For a live manual handoff instead, run any replay with `--attended`: the
browser runs headful, and when the run gets stuck you operate the window
yourself, then answer `retry` / `skip` / `abort` at the operator prompt.

**8. Cross-tenant replay — one capability, many tenants** (the second
"tenant" runs the same mock app with `?tenant=premier`: rebranded banner,
menu entry renamed to "Account Inquiry"):

```bash
# Without the overlay the base artifact fails loudly at the renamed control:
npm run replay -- --artifact artifacts/lookup-member-balance.v1.0.0.json \
  --entry-override "http://localhost:4173/?tenant=premier" --params '{"memberId":"23456"}'
#   -> {"status":"failure","failure":{"stepId":"s1","observed":"Could not uniquely resolve target ...: role=0, text=0, css=2"}}

# With a thin tenant overlay, the same base replays — no re-recording:
npm run replay -- --artifact artifacts/lookup-member-balance.v1.0.0.json \
  --overlay config/overlays/premier.json --params '{"memberId":"23456"}'
#   -> {"status":"success","outputs":{"savings_balance":"9,812.55"}}
```

**9. Capability catalog** (what an agent could discover and invoke):

```bash
npm run list
```

**10. Re-check saved artifacts against the current risk rules** (runs in the
test suite, so a tightened risk floor cannot leave an approved artifact behind):

```bash
npm run validate
#   -> All artifacts satisfy the current risk floor.   (exit 1 on drift)
```

## Running without live services

Replay needs no API key. The suite uses local fixtures and a scripted stand-in
model. Full CI additionally requires a disposable PostgreSQL 14 database with
permission to create schemas; set `TEST_DATABASE_URL` before running it. This is
a test dependency even when the demo uses the filesystem journal. No target or
model credentials are needed. See [regression setup](docs/meridian/regression-tests.md).

```bash
export TEST_DATABASE_URL='postgresql://<test-user>:<test-password>@127.0.0.1:5432/<test-database>'
npm test        # builds the UI, then runs the suite
npm run ci      # what the pre-push hook runs: typechecks + the suite
```

[GitHub Actions](.github/workflows/ci.yml) runs the same `npm run ci` gate on
every pull request and pushes to `master` or `dev`, using Node 22 and Chromium
on Ubuntu. It also supports manual runs from the Actions tab. No API keys or
repository secrets are required.

Each new worktree needs its own `npm ci`; Chromium is installed with
`npx playwright install chromium`. Browser fixtures bind to OS-assigned ports,
so suites in different worktrees can run concurrently. For a focused loop:

```bash
npm test -- test/meridian.test.ts -t 'durable request identity'
npx tsx scripts/benchmark-journal.ts  # lookup timings at 100, 1,000 and 10,000 records
```

The benchmark creates and removes a temporary journal. Its setup uses real
authenticated, durable writes; reported timings cover warmed lookups only.
Run `npm run ci` before handing off a change; artifact validation is included
in the suite.

## Repo map

```
target-app/       the hostile mock bank app (+ ?sim=... error injection)
src/surface/      Surface abstraction (perceive/act seam) + Playwright impl + policy guard
src/agent/        LLM discovery loop (OpenAI tool-calling)
src/artifact/     capability schema (Zod) + recorder (trace -> parameterized artifact)
src/replay/       deterministic executor, tiered locators, detectors, outcome taxonomy
src/escalation/   control-owner state machine + operator console
src/safety/       policy allowlist + redaction
src/evidence/     structured run logging
config/           policy.json + per-app detector profiles + tenant overlays
artifacts/        recorded capabilities (JSON, reviewable, versioned)
evidence/         committed demo runs (discovery, replays, escalation)
test/             vitest suite + hand-written fixtures
scripts/          scripted end-to-end escalation demo
docs/             use cases, architecture diagram, demo runbook, audits, plans
.githooks/        pre-push local CI gate (see Setup)
```

## MERIDIAN operational details

The shared runtime, asynchronous API, local operator dashboard and thin chat entry point are described in [the MERIDIAN runbook](docs/meridian/runbook.md). See [the implementation report](docs/meridian/report.md) for verified behavior and the remaining live acceptance gates. Configure `.env` from `.env.example`, then run `npm run build` and `node --env-file=.env --import tsx cli.ts serve --profile meridian`. The chat frontend uses Next.js App Router and assistant-ui; the existing Express service serves its static export and authenticated API together.

For a standalone CLI posting approval, review the displayed facts and type `approve` at `operator>`, or use the exact `approve --run ... --approval ...` command printed by the runner from a second Terminal on the same machine. `approval --run ...` shows the current facts and approval ID; `refuse --run ... --approval ...` stops that action. The original prompt also accepts `refuse` or `abort`. The runner and `approve` command require an interactive terminal, but this is a client-side check, not proof of human presence: all processes running as the same OS user are trusted and can submit decisions directly to the local socket. A decision applies once to the specified pending action and expires after five minutes. The runner checks the facts again before submitting. Do not click the browser's final posting button: its unarmed request is blocked and can display `ERR_FAILED`. See [CLI approval commands](docs/meridian/runbook.md#standalone-cli-approval-commands). Browser repair and API/dashboard decisions retain their existing controls.

Four MERIDIAN capabilities have accepted recording/replay pairs: sign-on, member inquiry, member record and open share. Funds transfer, contact update and supervisor hold remain incomplete. See [live evidence](docs/meridian/live-evidence.md), including the separately recorded unknown posting. Existing mock fixtures are not a substitute for live evidence.
