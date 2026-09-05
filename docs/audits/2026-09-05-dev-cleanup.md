# Dev cleanup, performance and verification audit

Base: `origin/dev` at `de262402555ef3a4747dafead5cc17f9c19af6c1`.
Branch: `codex/dev-cleanup-verification`.
Scope: journal lookup callers (CLI discovery/replay and HTTP invocation), local
verification, and triage of the 26 open issues. This is a targeted pass, not a
new full security audit or live MERIDIAN acceptance run.

## Cleanup

`delete:` Remove the duplicate artifact-validation workflow step. The existing
`S-M3` test in `test/fixes.test.ts:438` invokes `cli.ts validate`, checks its
success message and requires exit zero. Both the pre-push hook and GitHub
Actions already execute that test through `npm run ci`.

Net cleanup: -2 workflow lines, -0 dependencies. No tests removed. The inspected
small wrappers contain configuration, schema translation or safety behavior;
their size alone is not a reason to delete them.

## Performance

`Journal.lookup` previously allocated an array of every record and searched it.
A new invocation calls lookup directly and again through reserve. The CLI and
service both use this shared path (`cli.ts:154`, `cli.ts:306`,
`src/server/service.ts:54`).

An in-memory identity-to-run-ID map now avoids the linear scan. It is populated
from authenticated records on startup and after successful durable writes.
Lookup still reads the current record from `records`, so state transitions and
restart recovery do not return stale record objects. Duplicate identities retain
the original first-match behavior. Cost: one extra map entry per journal record.
There are no changes to HMAC, fsync, locking or unknown-post recovery.

Measured with Node v22.23.1 on macOS arm64, 10,000 lookups per case after 1,000
warmups. Each run creates actual journal records; durable setup is excluded from
the measurements. These are local microbenchmark observations, not HTTP or
browser latency claims.

| Records | Lookup | Before, µs | After, µs |
| --- | --- | ---: | ---: |
| 100 | Last hit | 4.42 | 3.02 |
| 100 | Miss | 2.90 | 2.37 |
| 1,000 | Last hit | 8.86 | 2.45 |
| 1,000 | Miss | 6.73 | 2.74 |
| 10,000 | Last hit | 47.20 | 3.89 |
| 10,000 | Miss | 47.83 | 2.59 |

At 10,000 records: approximately 12x faster last hits and 18x faster misses.
Reproduce with `npx tsx scripts/benchmark-journal.ts`. Setup can take several
minutes because it uses real fsync writes. The benchmark is typechecked, uses
no new dependency and removes its temporary journal. No timing threshold was
added to CI.

## Verification loop

Three suites bound fixed ports: `e2e` (4199), `variant` (4198), and
`screenshot-mask` (4201). Two simultaneous baseline screenshot suites reproduced
`EADDRINUSE :::4201`; one passed and the other timed out in setup after 10 seconds.

All three now bind loopback port zero, await the native `listening` event and
propagate the assigned origin into policy and artifacts. Two overlapping runs
of `npm test -- test/e2e.test.ts test/variant.test.ts test/screenshot-mask.test.ts`
both passed all six tests, in 19.51 and 19.48 seconds. This tests process
concurrency directly without adding a port allocator or serializing tests.

README setup now uses `npm ci` and documents worktree dependencies, browser
installation, focused tests and the benchmark. No live credentials are needed
for these checks.

## Open PR and issue triage

GitHub returned zero open PRs at the start of this pass: no existing PR was
available to merge or take over. All 26 issue bodies were read. The following
is reconciliation against dev, not an assertion that every issue's acceptance
criteria are met on the default branch or in a deployed service.

| Issues | Assessment and evidence |
| --- | --- |
| #7, #8, #12, #29 | Their central implementations are present on dev: dual tool-schema export (`src/artifact/tools.ts:3`); HTTP invocation and 202/run polling (`src/server/http.ts:37`); discovery assert and recorder support (`src/agent/loop.ts:155`, `src/artifact/recorder.ts:285`). Candidates for closure after acceptance/release reconciliation. |
| #25 | Profile selector masking and rendered-text masks exist (`src/surface/browser.ts:287`). Unprofiled screenshots retain input-only masking. Narrow the issue to any remaining unprofiled requirement. |
| #9, #10, #11 | Partially addressed: single-active-run backpressure, authenticated caller/operator roles, durable deduplication. No browser pool/FIFO, individual caller identities or configurable TTL established. TTL expiry for write requests needs care to avoid permitting duplicate postings. |
| #13, #15, #16, #18 | Dashboard intervention, authenticated decisions, caller-authority chat and waiting messages exist. The requested skip semantics, individual approver attribution, separate conversational service and complete member UX are not established. |
| #26 | Browser listeners check `isTrusted`, but the exposed action-report binding still needs attribution; no per-frame nonce established (`src/escalation/operator.ts:195`). |
| #14, #17, #19–#24, #27, #28 | No completion evidence established in this pass. Keep these bridge, messaging, artifact lifecycle, telemetry, evidence and runtime feature requests open. |
| #42 | The reported final-step detector gap is still visible: the executor goes directly from the step loop to the success assertion (`src/replay/executor.ts:371`). No runtime reproduction or fix attempted in this cleanup. |
| #66 | Existing three-finding security/correctness audit remains outside this change; no closure claimed. |
| #30 | Tracking issue needs reconciliation with the implemented/partial groups above; its claim that the repo stops at CLI is stale on dev. |

No issues were closed or commented on, and no existing branches were discarded.
No production or live posting action was performed.

## Checks

- Baseline: `npm run ci`, 18 files / 566 tests passed, 19.84 seconds.
- Changed code: `npm run ci`, 18 files / 567 tests passed, 20.15 seconds.
- Added journal regression covers misses, caller isolation, current states,
  terminal/recovered states after restart, and changed-request rejection.
- Concurrent browser suites and before/after benchmark passed as described above.
- `git diff --check` passed. Actionlint was not installed locally.
- The original detached checkout's pre-existing artifact edit was preserved.

The complete suite remains dominated by browser work; no full-suite speedup
is claimed. Hosted CI and live write acceptance are separate from these local
results.
