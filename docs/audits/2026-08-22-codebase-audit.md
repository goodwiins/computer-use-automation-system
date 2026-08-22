# Codebase Audit — 2026-08-22

Scope: full repo (src/, cli.ts, config/). Method: manual inspection of
safety-critical seams (policy guard, executor, CLI, redaction, evidence).

Findings ranked by severity. File:line references valid at commit b317e68.

## Critical

### C1 — `--overlay` + `--approve` corrupts the base artifact

`cli.ts:152-162` — the overlay is composed into `artifact` *before* the
`--approve` check. Approving with an overlay active writes the tenant-composed
artifact (overrides + overlay provenance) back to the base file path,
permanently mutating it.

**Fix:** approve before composing, or reject the flag combination.

### C2 — Risk class is trusted from artifact JSON; approval is one unauthenticated flag

`executor.ts:191-207` passes `step.risk` straight from the artifact into the
policy gate. Relabeling an irreversible click as `read` makes policy auto-allow
it unattended. The only defense is artifact approval — and `cli.ts:158` flips
`draft → approved` with a single CLI flag, no auth or confirmation.

**Fix:** derive risk server-side from action semantics, or sign artifacts and
verify at load.

### C3 — Protocol-relative URL bypasses origin allowlist

`policy.ts:57-66` — `new URL('//evil.com/x')` throws (no scheme), so control
falls to the relative-URL check: starts with `/` → allowed.
`goto('//evil.com')` then navigates cross-origin.

**Fix:** reject scheme-less URLs, or resolve against the current origin before
the membership check.

## High

| # | Where | Problem |
|---|-------|---------|
| H1 | `cli.ts:131`, `schema.ts:107` | Path traversal: `--name ../../foo` writes outside `artifacts/`. `id`/`name` are unconstrained `z.string()` |
| H2 | `browser.ts:49-55` | `currentUrl()` prefers a frame named `workarea`, else `frames[0]`. Used by `gate()` default and `assertStillInBounds()` — post-navigation bounds check can read a stale/wrong frame URL and pass |
| H3 | `logger.ts:31-39` | Screenshots bypass the Redactor entirely — sensitive values rendered on-page persist in evidence PNGs while logs are masked |
| H4 | `executor.ts:100-102` | Detector recovery clicks execute config-supplied targets at default `'read'` risk. Tampered app-profile detector = free unattended click on any control |

## Medium

| # | Where | Problem |
|---|-------|---------|
| M1 | `executor.ts:191,198,205` | `(surface.click as …)` casts drop the `risk` param from the `Surface` interface. Composing `runReplay` with a raw `BrowserSurface` silently disables enforcement — guardedness is comment-only, not type-enforced |
| M2 | `redact.ts:9` | Credential regex misses `AKIA…`, `ghp_…`, `xox[bap]-…`, `AIza…`; sensitive-value masking is plain substring — URL-encoded values escape it |
| M3 | `schema.ts:67`, detectors | `urlMatches` patterns compile via `new RegExp` unescaped (only param values escape). A bad pattern in an approved artifact can hang an unattended worker via catastrophic backtracking |
| M4 | `artifacts/*.json` | No integrity protection: approval status is a plaintext field anyone can edit; TOCTOU between review and replay |
| M5 | `cli.ts:34,37` | `--param` / `--sensitive` with missing value → TypeError crash |

## Low

| # | Where | Problem |
|---|-------|---------|
| L1 | `browser.ts:43` | `CU_CDP_PORT` passed unvalidated into chromium args; the CDP handoff seam itself is an unauthenticated full-session control channel (localhost-bound by default) |
| L2 | `logger.ts:21` | Timestamp-only runId — two runs in the same second share one evidence dir |
| L3 | `browser.ts:101` | `select` fallback retries the full timeout → 2× stall |

## Strongest attack chain

C2 + C3 + M4: an attacker with file access relabels step risks as `read`,
flips `status` to `approved`, then exfiltrates via a protocol-relative
navigate — and the post-navigation bounds check reads a stale frameset URL
(H2), so the escape goes unnoticed.

## Recommended fix order

1. C3 (one-line validation, closes navigation escape)
2. C1 + H1 (CLI input hygiene)
3. C2 + M4 (artifact trust model — biggest design change)
4. H2/H3/H4
5. Remaining medium/low as hygiene passes
