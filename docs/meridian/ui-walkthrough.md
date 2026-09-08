# MERIDIAN UI Walkthrough

## Provenance

The application, test, and four-image evidence source for this walkthrough is
`8d5a227a161b7c8f156e07fdcff5607b3fbe5015`. It is checked out on
`codex/meridian-ui-accessibility`. This is the source/evidence SHA, not the
documentation commit: the final documentation commit and PR head necessarily
include a later SHA because this file is committed afterward.

This source SHA includes current dev
`ad5e62539c18986a3228a0d604b4da266d1db965` (including PR #105), normally merged
as `6610655e76be812281bc10ea1d759c5bdeca17f6`. The PR changes only Unit 7 UI,
browser tests, documentation and evidence; upstream storage behavior is intact.

The checks were run in the shared Ubuntu environment (`Linux onubuntu`, kernel
`6.8.0-124-generic`, x86_64). The native-zoom check starts `/usr/bin/Xvfb` for
headed Chromium; its single-frame capture is 1440×900. The recorded runtime
and package output was:

```text
git rev-parse HEAD
8d5a227a161b7c8f156e07fdcff5607b3fbe5015
node --version
v22.22.0
npm --version
10.9.4
npm pkg get dependencies.next dependencies.react dependencies.@assistant-ui/react devDependencies.playwright devDependencies.vitest
{
  "dependencies.next": "16.3.4",
  "dependencies.react": "19.2.8",
  "dependencies.@assistant-ui/react": "0.15.18",
  "devDependencies.vitest": "^4.1.11"
}
```

`package-lock.json` (lockfile version 3) resolves Playwright to 1.62.1 and
Vitest to 4.1.11; Playwright is declared under `dependencies` as `^1.49.0`,
which is why `devDependencies.playwright` is absent from the `npm pkg get`
output above.

`npm run build` passed with Next.js 16.3.4 and Turbopack:

```text
> cu-capability-system@0.1.0 build
> next build

▲ Next.js 16.3.4 (Turbopack)
✓ Running next.config.mjs took 23ms

  Creating an optimized production build ...
✓ Compiled successfully in 4.0s
  Running TypeScript ...
  Finished TypeScript in 10.7s ...
  Collecting page data using 4 workers ...
  Generating static pages using 4 workers (0/3) ...
✓ Generating static pages using 4 workers (3/3) in 1113ms
  Finalizing page optimization ...
Route (app)
┌ ○ /
└ ○ /_not-found


○  (Static)  prerendered as static content
```

## Fixture boundaries and safety

All browser, model, run, dialog, and screenshot data referenced here are
offline synthetic fixtures. The focused suite routes the UI to a local test
server and explicitly invokes no MERIDIAN target. Fixture tokens, IDs,
members, branch names, balances, and approval facts are not live credentials,
records, or authorization.

The catalog intentionally shows one fixture capability as `Approved · available
· 1.0.0` and six as `not_recorded · No approved recording`. A fixture approval
may be inspected or exercised only to verify UI behavior; it is not permission
to post a real transaction. Caller access has no approval/takeover controls,
and the access summary keeps `Target session: Not verified` and
`Branch: Not verified` unless the current run supplies verified context. Do not treat any
image below as genuine authenticated demo acceptance.

## Keyboard walkthrough

1. Connect from the login form. With local access, leave `Role` at the
   `TELLER1 · Teller` option for caller coverage. `Tab` from the role selector
   reaches `Connect`; `Enter` submits it. Once connected, the login form is
   hidden and the sidebar shows the large `Disconnect`-only control. To use
   local supervisor sign-on, activate `Disconnect`, select `SUPER1 ·
   Supervisor`, enter `Operator` and `Password`, and submit `Connect`; the
   workspace opens only after the verified operator, role, and branch are
   returned. Failed passwords are cleared and locally throttled. In credential
   mode, enter the API credential and submit `Connect`; credentials remain only
   in page memory and the connected state also shows the large `Disconnect`
   control.

2. After connection, focus `Activity` and press `Enter`. At narrow widths,
   focus moves to `Back to conversation`; press `Enter` to close and return
   focus to `Activity`. At wide widths the chat and Activity panel remain
   side-by-side, so `Back to conversation` is hidden; pressing `Enter` on
   `Activity` still toggles the panel. Crossing the breakpoint transfers focus
   between Activity and Back when needed, while a visible catalog or run control
   keeps its focus.

3. For an operator run awaiting review, activate its `Review request` button.
   The neutral `Review request` heading receives focus first. `Tab` visits
   `Close`, `Details`, `Confirm request`, and `Refuse request`, wrapping inside
   the modal; `Escape` closes it and returns focus to the opener. Inspect the
   exact visible request before confirming or refusing. An expired intervention
   must expose the text `Intervention expired.` and disable confirmation.

4. Use `Refresh` with `Enter` to request current authenticated history. In a
   run's details, `Tab` from the result table reaches `Run details and evidence`,
   then the `View result.json`, `View log.jsonl`, and `View masked.png` controls.
   Every focused control must retain a visible focus indicator; no action is
   inferred from color alone.

## Responsive Activity walkthrough

Connect to the caller fixture, type `Draft survives Activity`, and seed or
observe an active run. Scroll the `.messages` region to 320px, then focus
`Activity` and press `Enter`. The Activity view must open without a navigation
mutation. At 320px and 768px, verify that `Back to conversation` is visible
and focused; press `Enter` and verify that Activity regains focus, the draft
and active-run status remain, and the `.messages` scroll position returns to
320px. At 1024px and 1440px, verify the split view, hidden Back control, and
the same draft/run preservation while toggling Activity by keyboard.

The test asserts nonzero Activity-panel width and no panel or document horizontal
overflow while Activity is visibly open at each width. It records no new `POST`
to `/api/chat`, `/invoke`, `/decision`, `/cancel`, or `/transaction` during navigation.
Additional regressions preserve a newer visible scroll when wide Activity closes,
and preserve scrollTop 520 through narrow → wide → scroll → narrow → close. The
latest visible position is captured immediately before chat becomes hidden.

The connected screenshots below show the current authenticated layout: the
login form is hidden and the sidebar contains only the large `Disconnect`
control for session exit.

![Activity open at 1440px — offline synthetic fixture](evidence/ui-walkthrough/activity-1440.png)

*Activity open at 1440×900 — offline synthetic fixture.*

![Activity open at 320px — offline synthetic fixture](evidence/ui-walkthrough/activity-320.png)

*Activity open at 320×1359 full-page capture — offline synthetic fixture.*

## Dialog walkthrough

The narrow dialog fixture represents an operator review request with amount
`$25.00`, source `OFFLINE-A`, destination `OFFLINE-B`, and a synthetic
`OFFLINE` branch. Those values demonstrate readable wrapping and the neutral
focus entry point; they are not a live transfer. Caller access can open the
same request for read-only inspection but never receives `Confirm request`,
`Refuse request`, `Retry after repair`, or `Stop request` controls. Operator
access receives only the action permitted by the current, unexpired public
intervention and verified action context.

![Review request at 320px — offline synthetic fixture](evidence/ui-walkthrough/review-320.png)

*Review request at 320×902 — offline synthetic fixture.*

## Status and evidence walkthrough

Read the text status on each run card and in the dialog. The UI's plain-language
states include `Submitting`, `In progress`, `Recovering`, `Awaiting review`,
`Completed`, `Run stopped`, `Interrupted`, `Unable to verify outcome`, and
business outcomes such as `Insufficient funds`, `Validation rejected`, and
`Member not found`. `Unable to verify outcome` means the posting result is
unknown: investigate with a separate read-only inquiry and do not retry.

`Run history` is the caller's authoritative discovery/replay list. Operator
Activity starts on `Needs review (N)` and also exposes `All runs (N)`; arrow
keys move between these tabs and preserve a visible focus indicator. Use
`Run details and evidence` to inspect recorded inputs, safe run details, the
timeline, and authenticated evidence files. The synthetic status/evidence
check confirms that result JSON, event log, and masked image controls remain
keyboard reachable, that evidence is fetched with the caller's authorization,
and that an unauthenticated evidence request is rejected.

On a refresh outage, read
`Disconnected from run updates. Displayed data may be stale.`, refresh before acting, and preserve the last confirmed state. A
disconnect clears the authenticated workspace and chat. The focused fixture
also verifies that `localStorage` and `sessionStorage` stay empty.

## Width matrix

| CSS viewport width | Activity behavior | Exact checks |
| ---: | --- | --- |
| 320 | Narrow Activity view; `Back to conversation` is visible and focused. | Enter closes it; focus returns to Activity; draft, active status, and scrollTop 320 persist; no horizontal overflow or mutation POST. |
| 768 | Narrow Activity view with the same Back/focus handoff. | Enter closes it; focus, draft, active status, and scrollTop 320 persist; no horizontal overflow or mutation POST. |
| 1024 | Wide split view; chat and Activity remain visible; Back is hidden. | Activity toggles by Enter; draft and active status persist; no horizontal overflow or mutation POST. |
| 1440 | Wide split view; chat and Activity remain visible; Back is hidden. | Activity toggles by Enter; draft and active status persist; no horizontal overflow or mutation POST. |

The matrix is a responsive CSS-viewport check. It is separate from the
physical native-zoom capture below.

## Actual 200% browser zoom

Headed Chromium loaded a persistent-profile preference equivalent to 200%
browser zoom and captured one OS-level Xvfb frame at 1440×900. Chromium
reported `devicePixelRatio = 2`, `visualViewport.scale = 1`, `innerWidth =
720`, and `outerWidth × outerHeight = 1440 × 900`. The layout remained within
the measured CSS viewport, the catalog heading did not overflow, `Back to
conversation` received focus in the narrow CSS viewport, the draft survived
Activity navigation, and no mutation POST was emitted.

This was genuine browser zoom in headed Chromium. No CSS `zoom`,
`deviceScaleFactor`, `--force-device-scale-factor`, or CDP viewport emulation
was used. The image is the physical single-frame capture, not a CSS-scaled
mockup.

The owned Xvfb root display is 1441×901 to avoid Chromium's one-pixel window
clamping. The capture covers the complete 1440×900 physical browser window at
origin 0,0; the extra root-display margin is outside the image. Xvfb allocates a
free display through its private `-displayfd` pipe. Before Chromium or ffmpeg
connects, the fixture checks that its child is alive and that the allocated
socket has not been replaced. An opt-in regression allocates two distinct
displays and rejects capture after ownership ends. Default tests never launch
Xvfb or xdpyinfo; native setup requires `MERIDIAN_NATIVE_ZOOM=1`.

![Native 200% browser zoom — offline synthetic fixture](evidence/ui-walkthrough/native-zoom-200.png)

*Headed Chromium native 200% zoom, 1440×900 Xvfb frame — offline synthetic fixture.*

## Checks performed

The merged `test/chat-ui.test.ts` registers 109 tests by default. Opting in to
native verification adds one native cleanup parameter, for 110 tests. The two
native tests are skipped by default; the full database-backed gate includes the
real PostgreSQL recovery case against a disposable local PostgreSQL 16 database.
These focused checks passed on the application/test/evidence tree:

```text
MERIDIAN_WALKTHROUGH_SCREENSHOT_DIR=docs/meridian/evidence/ui-walkthrough npx vitest run test/chat-ui.test.ts -t 'surfaces setup and cleanup errors|refuses native display|reads only a complete valid display|rejects native allocation|registers idempotent teardown|Activity focus|visible Activity controls|scroll position|restores narrow conversation scroll|restores the latest scroll|preserves the conversation across responsive Activity navigation|offline operator review controls require live authority|neutral replacement focus resets|Connect signs on directly|Connect does not open chat after sign-on|connects a local supervisor using operator and password|reconciles a clean tool-bearing chat stream|offline direct invocation keeps an uncertain request key|status text shows the authoritative step|operator Activity filters start in a review-first queue|offline stopping the response|can stop the response before|keeps saved conversation row controls'
Test Files  1 passed (1)
Tests       25 passed | 84 skipped (109)
Duration    44.08s

MERIDIAN_NATIVE_ZOOM=1 MERIDIAN_WALKTHROUGH_SCREENSHOT_DIR=docs/meridian/evidence/ui-walkthrough npx vitest run test/chat-ui.test.ts -t 'registers idempotent teardown|allocates distinct owned native displays|actual Chromium browser zoom at 200%'
Test Files  1 passed (1)
Tests       4 passed | 106 skipped (110)
Duration    10.09s

npx vitest run test/chat-ui.test.ts -t 'retains focus on visible Activity controls'
Test Files  1 passed (1)
Tests       1 passed | 108 skipped (109)
Duration    4.74s
```

The full local gate used disposable PostgreSQL 16 at `127.0.0.1:55437` and the
same source SHA. Exact parallel `npm run ci` passed both typechecks and build,
then failed with 1113 passed / 2 failed / 2 native skips (1117), 49/51 files,
in 258.71s. The unchanged approval-cli second-process case hit its 60s timeout;
the history-structure browser case hit its 5s timeout. Both passed individually
at the same SHA (15.42s and 1.62s test time), supporting shared-host contention
as the cause. The failed parallel result is not treated as a pass.

The requested serial equivalent passed both typechecks, the production build,
and every executed test, including the real PostgreSQL browser recovery case:

```text
npm run typecheck
npm run typecheck:ui
TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:55437/meridian_unit7 npm test -- --maxWorkers=1
Test Files  51 passed (51)
Tests       1115 passed | 2 skipped (1117)
Duration    403.76s
```

Final documentation-head smoke/build/native checks and exact-head hosted CI
are recorded on PR #104. All four screenshots were recaptured and visually
inspected from the source/evidence tree; three recaptured byte-identically and
the review image changed with its synthetic expiry time.

The required evidence/link/hygiene checks also passed: all four evidence
files exist, the required provenance/boundary phrases match this document,
and `git diff --check` is clean. The four checks were:

```bash
test -f docs/meridian/evidence/ui-walkthrough/activity-1440.png
test -f docs/meridian/evidence/ui-walkthrough/activity-320.png
test -f docs/meridian/evidence/ui-walkthrough/review-320.png
test -f docs/meridian/evidence/ui-walkthrough/native-zoom-200.png
rg -n 'offline synthetic fixture|200%|320|768|1024|1440|separate acceptance|source SHA|npm run build' docs/meridian/ui-walkthrough.md
git diff --check
```

## Separate genuine demo acceptance

Authenticated genuine-demo rehearsal remains a separate acceptance step and
was not performed. The source/evidence SHA, focused checks, build, and four
offline synthetic fixtures establish only the local UI behavior and its
documented safety boundaries; they do not establish a genuine authenticated
MERIDIAN operation, posting, approval, or target-session result.
