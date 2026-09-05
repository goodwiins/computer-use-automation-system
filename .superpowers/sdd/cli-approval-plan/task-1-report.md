# Task 1 implementation report

Status: complete in the isolated worktree. Baseline was `5af34c1ff07f945ed00612311ba2db1149982f3a`; parent documentation commit `e71e80cdba10c382b60b2e1b200097781c84513e` was preserved. Source and focused tests are committed as `41243470836a1938403736716594e7362ac3fa63` (`Add standalone CLI approval decisions`).

## Implemented

- Added `approval`, `approve`, and `refuse` CLI commands with required run and approval UUID validation before local transport access. `approve` rejects non-TTY stdin; `refuse` maps only to abort. Success text says the decision was recorded and does not claim a post occurred.
- Routed standalone risk handoffs through a single existing `Approval` instance. Original Terminal input and the second-process commands both call `Approval.decide`; timeout and page close call `Approval.cancel`. Generic repair still accepts only retry/skip/abort on its original path. `refuse` is also accepted as an abort alias at the original risk prompt.
- Passed the guarded action context separately instead of embedding it in the intervention reason. Status and prompt output include the exact approval ID, expiry, safe destination/method and action facts. Query strings and fact keys associated with tokens, passwords, secrets, cookies, authorization and bodies are omitted from the new transport/Terminal projection.
- Added a same-user Unix socket under `~/.cu-approvals` or `CU_APPROVAL_DIR`. The endpoint uses only the run UUID in its filename. The directory and socket must be real, current-user-owned and inaccessible to group/other users. Existing endpoints are rejected and never replaced.
- Bounded requests to 8 KiB, responses to 32 KiB and idle/client activity to three seconds. Requests are parsed only after the client finishes sending, so trailing bytes cannot be applied after a valid decision. Errors are sanitized.
- Listener cleanup destroys idle readers, lets an already-produced decision acknowledgment drain, waits for owned listener closure, and removes only the socket inode created by that server. The browser-close race is checked before and after endpoint startup.

## Focused verification

- `npm run typecheck` — passed.
- `npx vitest run test/approval-cli.test.ts` — passed, 4/4.
  - Second-process top-level `approval` status succeeded and returned safe facts plus exact commands.
  - Second-process top-level `refuse` succeeded; wrong and duplicate approval IDs failed without changing another decision.
  - Second-process top-level `approve` rejected non-TTY stdin without consuming the approval.
  - A second-process fixture invoked the same exported CLI dispatcher with a test-only TTY descriptor and recorded approve through the socket.
  - First-decision-wins, response draining with a hostile idle client, unavailable endpoints, malformed/oversized requests, insecure/symlink directories, occupied endpoint preservation and browser-close cancellation passed.
- `npx vitest run test/fixes.test.ts -t 'keeps terminal-only risk approval'` — passed, 1/1 selected.
- `npx vitest run test/meridian.test.ts -t 'expires, rejects stale IDs|allows one approved mutation|stops replay with no target POST when the browser closes before intervention'` — passed, 3/3 selected.
- `git diff --check` — passed before commit.

## Boundaries and follow-up

- No full suite, pre-push, push, headful/CUA/live-target run or real approval was performed, as assigned. Parent owns full CI, independent review, the real tool-PTY top-level approve check and PR delivery.
- The implementation does not add TCP, persistence, a daemon, remote/API CLI behavior, automatic pending-action selection or a dependency. API-managed approval remains unchanged.
