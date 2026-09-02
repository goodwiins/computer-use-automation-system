# Leadership demo runbook

Dry-run verified 2026-09-02 at commit 0b35a2e: every command below produced the
output shown. Total live time ≈ 8 minutes if you skip live discovery.

## Before the room

```bash
cd ~/development/interface.ai
npm run test           # 95/95 — proves the build is healthy, 20s
npx tsx cli.ts validate
```

Open three terminals, big font. Close other browser windows (the escalation
step pops a headful Chromium that the audience should see).

- **T1** target app: `npm run target-app` — leave running.
- **T2** commands.
- **T3** reserved for the escalation app restart (step 5).

Do NOT run live discovery (`npm run discover`) in the room: it needs Azure
creds via `az`, takes 1–3 min, and has failed 2 of 3 runs historically. Show
the committed evidence instead: `evidence/discovery/`.

## The story (one sentence)

> The model discovers a flow once; the artifact becomes a typed, reviewed
> capability; production replays it deterministically with no model in the
> loop, and when the UI drifts a human takes over the SAME live session.

## Beats

### 1. Catalog — what an agent can invoke (10s)
```bash
npm run list
```
Say: two capabilities, both `approved`, typed params/outputs, versioned.

### 2. Deterministic replay — no LLM (30s)
```bash
npm run replay -- --artifact artifacts/lookup-member-balance.v1.0.0.json --params '{"memberId":"23456"}'
#  status: success, savings_balance: 9,812.55
```
Say: no API key set, no model call; artifact + Playwright only. Point at the
`evidence/replays/<runId>/` dir it printed: log + screenshots, redacted.

### 3. Errors are typed, not crashes (1 min)
```bash
# business outcome, not a failure
npm run replay -- --artifact artifacts/lookup-member-balance.v1.0.0.json --params '{"memberId":"99999"}'
#  status: business_outcome, outcomeCode: NO_SUCH_MEMBER

# recoverable interstitial — dismissed automatically, run still succeeds
npm run replay -- --artifact artifacts/lookup-member-balance.v1.0.0.json --params '{"memberId":"12345"}' \
  --entry-override "http://localhost:4173/?sim=maintenance"
#  status: success, savings_balance: 4,250.13

# hard failure with evidence
npm run replay -- --artifact artifacts/lookup-member-balance.v1.0.0.json --params '{"memberId":"12345"}' \
  --entry-override "http://localhost:4173/?sim=timeout"
#  status: failure, observed: "session-expired: Session timed out..."

# optional if asked "what about a popup?": dialog is dismissed, never accepted, and named
npm run replay -- --artifact artifacts/lookup-member-balance.v1.0.0.json --params '{"memberId":"12345"}' \
  --entry-override "http://localhost:4173/?sim=confirm"
#  status: failure, observed: "unexpected confirm dialog ... was dismissed at s1; then ..."
```
Say: three outcome classes — business outcome / recovered / failure — the
caller's agent can branch on them.

### 4. Mutating flow, stops before the irreversible click (45s)
```bash
npm run replay -- --artifact artifacts/open-subaccount-to-confirmation.v1.0.0.json \
  --params '{"memberId":"23456","nickname":"RAINY DAY","deposit":"50.00"}'
#  status: success
npm run replay -- --artifact artifacts/open-subaccount-to-confirmation.v1.0.0.json \
  --params '{"memberId":"12345","nickname":"TEST","deposit":"1.00"}'
#  status: business_outcome, outcomeCode: VALIDATION_REJECTED
```
Say: every step carries a risk class; `irreversible` steps escalate to a human
by policy; "Open Account" is never clicked unattended.

### 5. Vendor drift → human takes over the live session (2 min) — THE MONEY SHOT
In **T1** Ctrl-C the app. In **T3**:
```bash
BREAK_MARKUP=1 npm run target-app      # renames "Search" → "Execute Query"
```
In **T2**:
```bash
npx tsx scripts/demo-escalation.ts
```
What they'll see: replay hits the renamed button, prints
`HUMAN INTERVENTION REQUIRED`, a scripted operator attaches over CDP to the
same browser window, clicks the button, answers `skip`, automation resumes,
`status: success`. Say: the operator got the automation's session, not a fresh
one; production swaps the script for a co-browsing console on the same seam.

Then in **T3** Ctrl-C, in **T1** restart `npm run target-app`.

### 6. Multi-tenant: one artifact, many tenants (45s)
```bash
# same base artifact, tenant "premier" renamed the menu → fails loudly
npm run replay -- --artifact artifacts/lookup-member-balance.v1.0.0.json \
  --entry-override "http://localhost:4173/?tenant=premier" --params '{"memberId":"23456"}'
#  status: failure, observed: "Could not uniquely resolve target ... role=0, text=0, css=2"

# thin overlay, no re-recording
npm run replay -- --artifact artifacts/lookup-member-balance.v1.0.0.json \
  --overlay config/overlays/premier.json --params '{"memberId":"23456"}'
#  status: success, savings_balance: 9,812.55
```
Show `config/overlays/premier.json` — it is 13 lines.

### 7. Safety close (30s, no commands)
Open `docs/audits/2026-09-01-codebase-audit.md` header: two audit rounds, 22
findings closed with regression tests, PR #1. Open items: artifact signing
(design decision), evidence trimming.

## Likely questions

- **"Where's the model?"** Discovery only. `evidence/discovery/` shows the
  transcript-free provenance; replay has no network egress to any model.
- **"What if the vendor changes the page?"** Beat 5 (escalate + handoff) and
  beat 6 (overlay). Not built: drift telemetry across replays.
- **"What if the app pops a dialog / denies permission?"** Beat 3 optional command; `?sim=denied` is the fatal-detector case.
- **"Can a script approve a risky action?"** No — risk approval requires a TTY
  (`operator.ts`); the scripted demo only answers a stuck-step handback.
- **"Desktop / terminal-style cores?"** `Surface` seam; REPORT.md §4.
- **"Is the artifact tamper-proof?"** Not yet — plaintext `status: approved`.
  Signing is the next design item; `validate` already re-checks risk labels.

## If something breaks

- Port 4173 busy: `lsof -ti:4173 | xargs kill`.
- Chromium missing: `npx playwright install chromium`.
- Escalation demo hangs at `operator>`: the app in T3 wasn't started with
  `BREAK_MARKUP=1`, or T1's app is still on 4173.
- Any replay fails unexpectedly: fall back to `evidence/replays/` — every
  scenario above has a committed run with screenshots.
