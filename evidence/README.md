# Evidence

Each folder is one complete run: `log.jsonl` (structured, redacted event log),
numbered per-step screenshots, and `result.json` (the structured result
returned to the caller).

## Replay runs (deterministic — no LLM)

All replays execute `artifact.hand-lookup-member-balance.json` (also saved
here) with different parameters / injected runtime conditions:

| Folder | Params / condition | Result |
|---|---|---|
| `replay-success-12345/` | `memberId=12345` | `success`, `savingsBalance = 4,250.13` |
| `replay-success-23456/` | `memberId=23456` | `success`, `savingsBalance = 9,812.55` — same artifact, different member: parameterization works |
| `replay-business-outcome-not-found/` | `memberId=99999` | `business_outcome`, `NO_SUCH_MEMBER` — a legitimate answer, not a crash |
| `replay-recovered-maintenance/` | entry `?sim=maintenance` | `success` after auto-dismissing the maintenance interstitial (`recoveries: ["s1:maintenance-interstitial"]`) |
| `replay-failure-session-timeout/` | entry `?sim=timeout` | `failure` — session-expiry detector classified fatal; structured error + screenshot |

## Escalation & handoff

`escalation-handoff/` — target app started with `BREAK_MARKUP=1` (vendor-drift
simulation renames the Search button). Replay of a drift-narrowed artifact gets
stuck, raises an intervention, a human operator attaches to the **same live
browser session** over CDP, performs the step manually (2 recorded, redacted
`human.action` events), answers `skip`, and automation resumes to `success`.
See `control.transfer` / `handoff.*` events in `log.jsonl`.

## Discovery run (LLM-driven)

`discovery-run/` — the genuine LLM-driven discovery that produced the recorded
capability artifact: per-turn observations (accessibility snapshots),
model decisions, actions, policy checks, and screenshots.
