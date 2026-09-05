# Task 1 implementation report

Status: complete in the isolated worktree. Baseline was `5af34c1ff07f945ed00612311ba2db1149982f3a`; parent documentation commits `e71e80cdba10c382b60b2e1b200097781c84513e` and `daf252c885099eafbcd818eea89cabf7cc2501e0` were preserved. Source and focused tests are committed as `41243470836a1938403736716594e7362ac3fa63` (`Add standalone CLI approval decisions`), `f3ebca0e948b3836cd61530e018f853c4130404f` (`Harden local approval transport boundaries`) and `58e54b5db700877e7111bd77bdfa4473561fa9c1` (`Keep approval socket lifetime bounded`).

## Implemented

- Added `approval`, `approve`, and `refuse` CLI commands with required run and approval UUID validation before local transport access. `approve` rejects non-TTY stdin; `refuse` maps only to abort. Success text says the decision was recorded and does not claim a post occurred.
- Routed standalone risk handoffs through a single existing `Approval` instance. Original Terminal input and the second-process commands both call `Approval.decide`; timeout and page close call `Approval.cancel`. Generic repair still accepts only retry/skip/abort on its original path. `refuse` is also accepted as an abort alias at the original risk prompt.
- Passed the guarded action context separately instead of embedding it in the intervention reason. Status and prompt output include the exact approval ID, expiry, safe destination/method and action facts. Query strings and fact keys associated with tokens, passwords, secrets, cookies, authorization and bodies are omitted from the new transport/Terminal projection.
- Added a same-user Unix socket under `~/.cu-approvals` or `CU_APPROVAL_DIR`. The endpoint uses only the run UUID in its filename. The directory and socket must be real, current-user-owned and inaccessible to group/other users. Existing endpoints are rejected and never replaced.
- Bounded requests to 8 KiB, responses to 32 KiB and idle/client activity to three seconds. Requests are parsed only after the client finishes sending, so trailing bytes cannot be applied after a valid decision. Errors are sanitized.
- Listener cleanup destroys idle readers, lets an already-produced decision acknowledgment drain and waits for listener closure. Every client has a three-second absolute lifetime, including response/error writers, and the server accepts at most 16 concurrent clients. The browser-close race is checked before and after endpoint startup.

## Focused verification

- `npm run typecheck` — passed.
- `npx vitest run test/approval-cli.test.ts` — passed, 5/5.
  - Second-process top-level `approval` status succeeded and returned safe facts plus exact commands.
  - Second-process top-level `refuse` succeeded; wrong and duplicate approval IDs failed without changing another decision.
  - Second-process top-level `approve` rejected non-TTY stdin without consuming the approval.
  - A second-process fixture invoked the same exported CLI dispatcher with a test-only TTY descriptor and recorded approve through the socket.
  - First-decision-wins, response draining with a hostile idle client, unavailable endpoints, malformed/oversized requests, insecure/symlink directories, occupied endpoint preservation and browser-close cancellation passed.
  - A 128-client mix of trickle and oversized hold-open inputs was fully closed after the absolute three-second lifetime without consuming the pending approval.
- `npx vitest run test/fixes.test.ts -t 'keeps terminal-only risk approval'` — passed, 1/1 selected.
- `npx vitest run test/meridian.test.ts -t 'expires, rejects stale IDs|allows one approved mutation|stops replay with no target POST when the browser closes before intervention'` — passed, 3/3 selected.
- `git diff --check` — passed before commit.

## Boundaries and follow-up

- No full suite, pre-push, push, headful/CUA/live-target run or real approval was performed, as assigned. Parent owns full CI, independent review, the real tool-PTY top-level approve check and PR delivery.
- The implementation does not add TCP, persistence, a daemon, remote/API CLI behavior, automatic pending-action selection or a dependency. API-managed approval remains unchanged.
- Review reproduced a Node 22 platform limit: `net.Server.close()` automatically unlinks the filesystem path that the server originally bound, even if the directory owner manually replaced that path before close. Public Node 22 `net.ListenOptions` has no cleanup/unlink control. Private Node APIs, rename/restore races and leaked listeners were rejected as disproportionate. The honest boundary is exclusive same-user ownership of the private active endpoint directory/path: do not mutate it while the runner is active. Startup never overwrites an existing endpoint; a crash-stale path is removed manually only after confirming its runner stopped.

## Hosted CI follow-up

- PR #65 head `048e7b4` run `33991700966`, producer job `101374975966`, passed typecheck and 565 tests but failed `test/approval-cli.test.ts:124`: the winner acknowledgment had succeeded, while the remote idle client's `close` event had not yet been delivered when `idle.destroyed` was asserted.
- Commit `f573bc66950b08ee5ba8a9ce333a2e4a2d76214f` registers the idle client's close promise before server cleanup, awaits the actual event under Vitest's timeout, then preserves the destruction and winner-acknowledgment assertions. No runtime source changed.
- `npx vitest run test/approval-cli.test.ts -t 'uses the Approval state machine for first-decision-wins and drains the winner response during cleanup'` — passed, 1/1 selected. `git diff --check` — passed before commit.
