# Evidence

Each folder is one complete run: `log.jsonl` (structured, redacted event log),
numbered per-step screenshots, and `result.json` (the structured result
returned to the caller).

## Discovery run (LLM-driven)

`discovery-run/` — the genuine LLM-driven discovery (Azure OpenAI,
`gpt-5.6-luna`) that produced `artifact.lookup-member-balance.v1.0.0.json`
(also saved here): per-turn observations (accessibility snapshots + form-field
inventory), model tool-call decisions, executed actions, policy checks, and
screenshots. Goal: "Look up member 12345 and read their current savings
balance" → `savings_balance = 4,250.13` in 5 recorded steps.

## Replay runs (deterministic — no LLM)

All replays execute that same recorded artifact with different parameters /
injected runtime conditions:

| Folder | Params / condition | Result |
|---|---|---|
| `replay-success-23456/` | `memberId=23456` | `success`, `savings_balance = 9,812.55` — same artifact, different member: parameterization works |
| `replay-business-outcome-not-found/` | `memberId=99999` | `business_outcome`, `NO_SUCH_MEMBER` — a legitimate answer, not a crash |
| `replay-recovered-maintenance/` | `memberId=12345`, entry `?sim=maintenance` | `success` after auto-dismissing the maintenance interstitial (`recoveries: ["s1:maintenance-interstitial"]`) |
| `replay-failure-session-timeout/` | entry `?sim=timeout` | `failure` — session-expiry detector classified fatal; structured error + screenshot |

## Second capability — the mutating flow

`discovery-run-subaccount/` — a second genuine LLM discovery of the brief's
example goal: open a sub-account for a member and stop at the confirmation
review screen (the commit click is never made). The model classified the
form-submit click `reversible_write` on its own; three typed parameters
(`memberId`, `nickname`, `deposit`) and two outputs were recorded into
`artifact.open-subaccount-to-confirmation.v1.0.0.json`.

| Folder | Params / condition | Result |
|---|---|---|
| `replay-subaccount-success/` | member `23456`, nickname `RAINY DAY`, deposit `50.00` | `success` — same artifact, entirely different member and values |
| `replay-subaccount-validation-rejected/` | deposit `1.00` (below the 5.00 minimum) | `business_outcome`, `VALIDATION_REJECTED` |

## Escalation & handoff

`escalation-handoff/` — target app started with `BREAK_MARKUP=1` (vendor-drift
simulation renames the Search button). Replay of a drift-narrowed artifact gets
stuck, raises an intervention, a human operator attaches to the **same live
browser session** over CDP, performs the step manually (2 recorded, redacted
`human.action` events), answers `skip`, and automation resumes to `success`.
See `control.transfer` / `handoff.*` events in `log.jsonl`. (This run predates
the LLM-recorded artifact and used an equivalent hand-narrowed fixture —
`test/fixtures/drift-lookup.json` — to force the drift.)
