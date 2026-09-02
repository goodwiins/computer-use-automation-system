# Codebase Audit — 2026-09-01

Scope: full repo (src/, cli.ts, target-app/, config/, test/, deps). Method:
manual read of every source file, `tsc --noEmit`, `vitest run`, `npm audit`,
secret grep, plus two empirical probes (URL-bypass, executor recovery path).
File:line references valid at commit 0993853 (branch `dev`).

Baseline: typecheck clean, 75/75 tests pass, no secrets or `.env` tracked.

**Fix status (2026-09-02, commit 1b7208d):** H1, M1 (plus an irreversible-step
guard on the new retry), M4, M5, M6 and the Ponytail deletions are fixed with
regression tests (83 total, vitest 4). Open: M2, M3, L1–L7, and the Aug-22
carry-overs (M2, M3, M4 signing, M5, L1, L3). Plan:
`docs/plans/2026-09-01-audit-fixes.md`.

Follow-up on 2026-08-22 audit: C1, C3, H1–H4 fixes verified in code.
Aug-22 M2, M3, M5 fixed 2026-09-02 (credential regex + URL-encoded masking;
urlMatches ReDoS/compile guard in the schema; `--param`/`--sensitive` missing
value now a clean fatal). Sep-01 M2 (risk approval now refuses a non-TTY
stdin) and M3 (`validate` subcommand re-applies the risk floor; both s3 Search
steps relabeled `reversible_write`) fixed the same day. Still open: Aug-22 M4,
L1, L3; Sep-01 L1–L7. C2/M4
(artifact signing) remains the largest design gap.

## High

### H1 — Backslash path-relative URL bypasses the pre-navigation allowlist

`src/safety/policy.ts:62` rejects `//host` and `\\host`, but not `/\host`.
WHATWG URL parsing treats `\` as `/` for http(s), so Chromium resolves
`/\evil.com/x` against the current origin to `http://evil.com/x`.

Verified: `originAllowed(['http://localhost:4173'], '/\\evil.com/x')` → `true`;
`new URL('/\\evil.com/x', 'http://localhost:4173').href` → `http://evil.com/x`.

Impact: the `gate('navigate')` check passes, the request is sent cross-origin
(with whatever is in the URL), and only the post-navigation
`assertStillInBounds` catches the escape — after the fact. Same class as the
fixed C3; the fix was incomplete.

**Fix:** in `originAllowed`, resolve relative URLs against a known in-bounds
base and check the resulting origin, instead of pattern-matching prefixes:

```ts
const resolved = new URL(url, allowed[0]); // any allowed origin works as base
return allowed.includes(resolved.origin);
```

(Drop the try/catch fallback entirely; a URL that fails to parse against a
base is not a URL.) Add `/\evil.com`, `\/evil.com`, `/\\evil.com` regression
cases to `test/fixes.test.ts`.

## Medium

### M1 — Recovered mid-step condition never retries the step

`src/replay/executor.ts:226-241`. When a step throws, `handleConditions` runs.
If it finds a *recoverable* detector, performs the recovery click, and the
condition clears, it returns `null` — and control falls through to the hard
failure path. The step that failed *because of* the now-cleared condition is
never re-attempted.

Verified with a stub surface: click #1 throws and raises an interstitial,
recovery dismisses it, `recoveries = ['s1:notice']`, click count stays at 1,
result is `failure`. Expected `success`.

The README maintenance demo passes only because the interstitial is on the
entry page and is caught by the *pre*-step check.

**Fix (one guard):** after `handleConditions` returns `null` in the catch
block, if `recoveries.length` grew during the call and `!isRetry`, `return
runStep(step, true)`.

### M2 — "Attended" is not "human"

`executor.ts:63` gates draft replay on `!deps.escalate`, and `cli.ts` sets
`escalate` whenever `--attended` is passed. The operator console reads
decisions from stdin. `scripts/demo-escalation.ts` pipes stdin and answers
`skip` programmatically — proving that any automated caller can satisfy the
"approved or attended" invariant, including approving `irreversible` actions
via the risk-approval prompt. Fine for a demo; document it as a trust-boundary
caveat in REPORT.md, or require a TTY (`process.stdin.isTTY`) for
`risk_approval` decisions.

### M3 — Committed approved artifacts predate the record-time risk floor

`artifacts/open-subaccount-to-confirmation.v1.0.0.json` step `s3` (Search
button, `role=button`) is labeled `read`; the current recorder would floor it
to `reversible_write` (`recorder.ts:29-43`). Harmless here (search is a GET),
but it shows approved artifacts on disk are not re-validated against current
rules. Consider a `validate` CLI subcommand that re-applies `riskFloorFor` to
every step of an artifact and reports drift, run in CI over `artifacts/`.

### M4 — `promoteToApproved` approves without schema validation

`src/artifact/promote.ts:4-8` does `JSON.parse`, sets `status`, re-serializes.
A malformed or hand-tampered artifact can be stamped `approved` and only
fails at replay. Parse through `CapabilityArtifact` first so approval is a
statement about a *valid* artifact.

### M5 — Uncaught throw from `surface.start` leaves no `result.json`

`executor.ts:68`: if the resolved entry URL is denied by policy (or the
browser fails to launch), `runReplay` throws out of the pre-flight section.
`cli.ts` has no try/catch around it, so the CLI dies with a stack trace,
`surface.close()` is skipped, and the evidence dir has no `result.json`.
Wrap the start in the same `fail()` path as the other pre-flight checks.

### M6 — Dev-dependency vulnerabilities (npm audit: 1 critical, 1 high, 3 moderate)

| Package | Installed | Issue | Exposure |
|---|---|---|---|
| vitest | 2.1.9 | arbitrary file read/exec when `--ui` server listening | dev only, `--ui` not used |
| vite | (transitive) | path traversal in optimized-deps `.map`; launch-editor NTLM leak | dev only |
| esbuild | ≤0.24.2 | dev server CORS | dev only |

No runtime dependency is affected. Bump `vitest` to 4.x (pulls fixed
vite/esbuild). `openai` is 3 majors behind (4.104 → 7.9); `zod` 3 → 4 also
available. Neither is a vulnerability; schedule as hygiene.

## Low

| # | Where | Problem |
|---|---|---|
| L1 | `browser.ts:197` | `[name="${s.name}"]` is built unescaped. A `nameAttr` containing `"` yields an invalid selector → `count()` throws → treated as 0 matches. Not exploitable (nameAttr is never templated) but silently mis-reports drift. Use `CSS.escape`-style quoting or `frame.locator('[name]').filter(...)`. |
| L2 | `redact.ts:25` | Short sensitive values (e.g. `"1"`) are substring-masked everywhere, shredding unrelated log content. Consider a minimum length or word-boundary match for values under ~4 chars. |
| L3 | `cli.ts:215` | `params[p.name] ?? ''` then `.filter(Boolean)` drops a numeric sensitive param whose value is `0`. |
| L4 | `cli.ts:237` | Replay result is printed to stdout **unredacted** (`console.log(JSON.stringify(result))`). Outputs are the contract, but `failure.observed` can echo Playwright error text. Route through the same `Redactor` the logger uses. |
| L5 | `cli.ts:226-245` | `list()` parses every artifact with `CapabilityArtifact.parse`; one malformed file crashes the whole catalog. Catch per-file and print the error inline. |
| L6 | `operator.ts:96` | `exposeBinding('__cuReportHumanAction')` is callable by page JS — a hostile page can flood `human.action` log entries. Acceptable for the mock; note it for a real target. |
| L7 | `evidence/` | 11 MB / 54 files / 29 PNGs committed. Fine for a take-home; will hurt clone time if the repo lives on. Consider trimming to one discovery + one replay + one escalation run. |

## Ponytail (over-engineering / dead code)

Repo is already lean; these are the only deletions worth making:

| Where | What | Action |
|---|---|---|
| `cli.ts:10`, `recorder.ts:156` | `newRunId` imported, never called | delete both |
| `session.ts:49` | `history()` — no callers | delete |
| `loop.ts:148-153` | `(surface.click as …)` cast + stale comment "public signature omits risk". `Surface.click` *does* declare `risk?` (`types.ts:53`) since 62a5ccc | `await surface.click(descriptor, undefined, risk)` |
| `browser.ts:87,97,103` | `_risk?: string` params — unused; TS allows fewer params in an impl | drop them |
| `detectors.ts:18-20` | `DetectorHit = { detector }` — one-field wrapper | return `Detector \| null` directly |
| `executor.ts:166` | `Symbol('continue') as unknown as ReplayResult` sentinel | works, but a `'continue'` literal in a union is honest typing; optional |

Everything else earns its keep. No interface with one implementation
(`Surface` has `BrowserSurface` + `GuardedSurface` + test stubs), no
speculative config, no scaffolding.

## Strongest attack chain (updated)

H1 + open M4-from-Aug: with file access, relabel risks, flip `status`, and
add a `navigate` step to `/\attacker.tld/?{{memberId}}`. The pre-nav gate
passes, the request leaves with the param in the URL, and only then does
`assertStillInBounds` fail the run. Exfiltration already happened.

## Recommended order

1. H1 — one-line rewrite of `originAllowed` + 3 regression cases.
2. M1 — one guard in `runStep`'s catch, plus the stub-surface test above.
3. M4 + M5 — CLI hygiene, ~10 lines total.
4. Ponytail deletions (5 minutes, zero risk).
5. M6 — `npm i -D vitest@4`, re-run suite.
6. M2/M3 — document or add `validate` subcommand; design call.
7. Artifact signing (Aug C2/M4) — still the real trust-model gap.
