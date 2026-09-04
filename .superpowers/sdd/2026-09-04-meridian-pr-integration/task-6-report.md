# Task 6 report — PR #40 documentation reconciliation

## Result

PR #40 now consumes the integrated runtime baseline `aa90387244be07b9955b8b5b83eacf4b9f3058a1`. PRs #37, #39 and #41 remain tied to their reviewed heads, repair commits, merge commits, local test counts, and separate head/merge producer checks. No historical live/read evidence was relabeled as a run on the integrated source.

The model-outage fallback correction was committed separately as `4d9a05e`: each genuinely new replay uses a fresh idempotency key; only a transport retry of the exact same invocation reuses its key; every unknown run retains its original key and terminal `POST_OUTCOME_UNKNOWN` state.

The ordinary `origin/dev` merge produced conflicts in `docs/meridian/report.md`, `docs/meridian/runbook.md`, and `docs/plans/2026-09-04-meridian-superpowers.md`. They were resolved paragraph by paragraph, retaining current `dev` read/runtime facts and #40's later extraction-feasibility, capability-specific completion, intent-versus-observed-dispatch, insufficient-funds, fallback-mode, and UI-ordering gates. Relative to `origin/dev`, the candidate changes documentation only.

## Current facts

- PR #37: reviewed head `745ef645ae48730e769e6fc639ec4f71739d23e8`; merged as `480b252ab60edc77aff1bc37f6cd08ba9645f8d1`; merge run `33919679746`, producer `101174884826`, passed.
- PR #39: repair `05f0647`; final reviewed head `64c9b11`; merged as `fcd87f7fb8d573c8d44d43436310cce07baae06a`; 257 local tests; head run/job `33920737879` / `101178214101` and merge run/job `33920922815` / `101178797950` passed.
- PR #41: repair `3aacfac`; final reviewed head `ec5f6a1ea421c7d4b5b345c4d83614eb513d3ec9`; merged as `aa90387244be07b9955b8b5b83eacf4b9f3058a1`; 269 local tests; head run/job `33921302067` / `101180000937` and merge run/job `33921529657` / `101180716774` passed. The three reviewed lifecycle findings are fixed.
- PR #40: remote head `f635798435dca7fb7eb40c616df74f26e4ccb69f` has historical run/job `33912439907` / `101151716399`. Local plan commit `0f6f11a1c324073a66e9bd6d08964ac72340abf1`, fallback correction `4d9a05e`, and this reconciliation are newer. The final candidate still needs independent review, publication, exact-head hosted CI, merge, and post-merge `dev` CI.

Live capability acceptance remains `3/7`. The transfer draft remains unpromoted; four write recordings, promotions, separately approved replays, and resulting-state gates remain open. Task A remains the next runtime task: valid current-fact underfunding before intent becomes `business_outcome / INSUFFICIENT_FUNDS`; malformed or wrong-account facts remain failures; failed or unverified completion after intent remains `POST_OUTCOME_UNKNOWN`. Assistant-ui remains the final phase after capability/runtime/API/operator acceptance and user direction.

The controller verified the protected primary and acceptance worktree dirty-file hashes and status were unchanged. No live run, posting, artifact promotion, push, or remote merge occurred in Task 6.

## Checks

- `npm run ci`: passed; TypeScript typecheck plus 269 tests across 16 files.
- `npm run validate`: passed; all artifacts satisfy the current risk floor.
- `git diff --check`: passed.
- Changed-document relative links: passed across nine files.
- Conflict-marker scan: passed.
- Stale-state scan: no current claim that PR #37, #39, or #41 remains open; no claim that a write capability is accepted.

## Remaining delivery gates

The reconciled local candidate is committed. Run the independent final documentation review, then publish it for exact-head hosted CI. PR #40 and the final post-merge `dev` SHA must remain pending until those results exist.
