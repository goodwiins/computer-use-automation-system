# Working in this repository

## Start from the requested base

Default base is `dev`. Run `git status --short` and `git fetch origin dev`, and check
open PRs before starting: another branch may already contain the intended fix.
Preserve existing edits. For an implementation, use a separate worktree outside
this checkout (`git worktree add -b <branch> ../<worktree> origin/dev`).
Record the base SHA with `git rev-parse HEAD` before editing.

## Set up and verify

Use Node 22, matching CI. From the new worktree root:

```sh
npm run setup        # npm ci, then the lockfile-matched Chromium installation
npm run test:smoke   # real Chromium through Node/tsx plus evidence/privacy checks
```

On Linux hosts missing browser system libraries, use
`npm run setup -- --with-deps`; this also installs Playwright's OS dependencies.
Setup needs network access; the smoke tests need no API keys or live services.
They start their own local fixtures, including a mock transaction endpoint.

Use the smallest relevant existing suite while editing:

| Change | Focused command |
| --- | --- |
| Journal/idempotency | `npm test -- test/meridian.test.ts -t 'durable request identity'` |
| Approval transport | `npm test -- test/approval-cli.test.ts` |
| Artifact contracts | `npm test -- test/schema.test.ts test/recorder.test.ts test/meridian-artifacts.test.ts` |
| Runtime cleanup | `npm test -- test/runtime-lifecycle.test.ts` |

Before handoff, run `npm run ci` and `git diff --check`. The full suite includes
artifact validation and the smoke tests; passing smoke alone is not the full gate.
For performance claims, record the same workload before and after the change.

## Diagnose the failing layer

- Missing module or Chromium executable: run setup in this worktree. Do not
  change application code to compensate for an incomplete environment.
- Browser inspection fails only through Node/tsx: use the smoke fixture's
  captured child stdout/stderr; a Vitest-only browser test uses a different loader.
- `EADDRINUSE`: identify the process holding the reported port before retrying.
  Other agents may own it. A failure is not a flake without same-SHA evidence.

Keep verification evidence precise: checkout, commit, command and result. Check
hosted CI at the PR's exact head before claiming it passed. Local mock tests do
not prove live MERIDIAN posting or approval acceptance; use
[the MERIDIAN runbook](docs/meridian/runbook.md) for authorized live work and
[the evaluator](scripts/evaluate-run.ts) for authenticated saved-run evidence.
