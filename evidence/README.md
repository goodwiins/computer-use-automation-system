# Evidence

Each run folder contains: `log.jsonl` (structured, redacted event log),
numbered per-step screenshots, and `result.json` (the structured result
returned to the caller).

Layout:

```
discovery/    LLM-driven discovery runs (one dir per capability)
replays/      deterministic replay runs (no LLM)
escalation/   human handoff demos
artifacts/    snapshots of the artifacts each discovery produced
runs/         raw local output (gitignored)
test-runs/    vitest output (gitignored)
```

## Discovery runs (LLM-driven)

`discovery/lookup-member/` — the genuine LLM-driven discovery (Azure OpenAI,
`gpt-5.6-luna`) that produced `artifacts/lookup-member-balance.v1.0.0.json`
(snapshot in `artifacts/`): per-turn observations (accessibility snapshots +
form-field inventory), model tool-call decisions, executed actions, policy
checks, and screenshots. Goal: "Look up member 12345 and read their current
savings balance" → `savings_balance = 4,250.13` in 5 recorded steps.

`discovery/open-subaccount/` — a second genuine LLM discovery of the brief's
example goal: open a sub-account for a member and stop at the confirmation
review screen (the commit click is never made). The model classified the
form-submit click `reversible_write` on its own; three typed parameters
(`memberId`, `nickname`, `deposit`) and two outputs were recorded into
`artifacts/open-subaccount-to-confirmation.v1.0.0.json`.

## Replay runs (deterministic — no LLM)

All replays execute a recorded artifact with different parameters / injected
runtime conditions:

### `replays/` — lookup-member-balance capability

| Folder | Params / condition | Result |
|---|---|---|
| `success-23456/` | `memberId=23456` | `success`, `savings_balance = 9,812.55` — same artifact, different member: parameterization works |
| `business-outcome-not-found/` | `memberId=99999` | `business_outcome`, `NO_SUCH_MEMBER` — a legitimate answer, not a crash |
| `recovered-maintenance/` | `memberId=12345`, entry `?sim=maintenance` | `success` after auto-dismissing the maintenance interstitial (`recoveries: ["s1:maintenance-interstitial"]`) |
| `failure-session-timeout/` | entry `?sim=timeout` | `failure` — session-expiry detector classified fatal; structured error + screenshot |

### `replays/` — open-subaccount-to-confirmation capability

| Folder | Params / condition | Result |
|---|---|---|
| `subaccount-success/` | member `23456`, nickname `RAINY DAY`, deposit `50.00` | `success` — same artifact, entirely different member and values |
| `subaccount-validation-rejected/` | deposit `1.00` (below the 5.00 minimum) | `business_outcome`, `VALIDATION_REJECTED` |

### `replays/` — cross-tenant replay (overlay, no re-recording)

The same vendor product installed at a second "tenant" (`?tenant=premier`:
rebranded banner, menu entry renamed to "Account Inquiry"):

| Folder | Condition | Result |
|---|---|---|
| `tenant-variant-drift-no-overlay/` | base artifact vs the variant, no overlay | `failure` at `s1` — all recorded locator tiers fail (`role=0, text=0, css=2`), expected-vs-observed + screenshot |
| `tenant-variant-overlay-success/` | `--overlay config/overlays/premier.json` | `success` — ONE recorded capability serves the second tenant via a thin overlay; the base artifact is never modified |

## Escalation & handoff

`escalation/handoff/` — target app started with `BREAK_MARKUP=1` (vendor-drift
simulation renames the Search button). Replay of a drift-narrowed artifact gets
stuck, raises an intervention, a human operator attaches to the **same live
browser session** over CDP, performs the step manually (2 recorded, redacted
`human.action` events), answers `skip`, and automation resumes to `success`.
See `control.transfer` / `handoff.*` events in `log.jsonl`. (This run predates
the LLM-recorded artifact and used an equivalent hand-narrowed fixture —
`test/fixtures/drift-lookup.json` — to force the drift.)
