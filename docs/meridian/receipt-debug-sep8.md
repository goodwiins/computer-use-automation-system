# Receipt extraction debugging, September 8

Historical run `06ab58ee-7ce6-434b-88be-c22d2cecf8bd` remains terminal
`POST_OUTCOME_UNKNOWN`. This investigation made no hosted target requests,
posting attempts, journal changes, or artifact promotions.

## Reproduced locally

The saved receipt structure has five two-cell rows. A synthetic fixture uses
that table shape with a separate confirmation paragraph in the same receipt
container. Its labels, values and paragraph markup are hypothetical, not a
reconstruction of the original private receipt.

- An unanchored `tbody > tr:nth-of-type(3)` selector on an outer layout table
  also selects the inner detail table's third row. Relative columns then fail
  with `cell_count`. Anchoring to `:scope > tbody > tr:nth-of-type(3)` selects
  exactly one receipt container and extracts all six canonical fields,
  including confirmation outside the five-row table.
- A real discovery-model probe extracted five columns, then attempted to add
  the missing confirmation in `done.outputs`. The tool schema advertised this
  argument, but `runDiscovery` ignores it and validates only accumulated
  `extract` results. This is a confirmed tool-contract mismatch.
- Further model probes exposed scalar/table formatting mismatches: extracting
  a bare confirmation code with a scalar regex while the structured column
  retains its label. The exact-equality check correctly rejects that result.

## Changes

`src/agent/tools.ts` removes the unused `done.outputs` argument and explains
that all outputs must be recorded by `extract`. The extraction instructions
describe common-ancestor grouping, descendant-only row selection, anchored
selectors, and consistent scalar/table text. No parser, authorization,
completion-validation, or post-dispatch recovery rule changed.

The existing vertical-receipt test now exercises the five-row/external-
confirmation fixture, reproduces the ambiguous nested-row selection, verifies
the correctly scoped extraction, and rejects a mismatched confirmation.

## Limits and retained evidence

The deterministic fixture passes. Three bounded model probes on the synthetic
page stopped at their eight-step limit. After the guidance changes, the model
did extract a complete grouped transaction row, but still mishandled the scalar
confirmation. These results do not establish a reliable autonomous recording,
a statistical improvement, or a fix for the historical live failure.

The original producer did not save the failed selector or extraction category.
Consequently `cell_count` is a reproduced plausible cause, not a proven diagnosis
of that original run. The merged typed extraction diagnostics will identify
the category on future runs; they cannot recover missing historical data.

Private diagnostic script, synthetic model logs and summary:
`/Users/goodwiinz/.codex/visualizations/2026/09/08/01a08260-f35c-7890-a6aa-35e1a17b931a/receipt-debug`.

Focused check:

```sh
npx vitest run test/meridian.test.ts -t 'vertical receipt|ignores invented done outputs|safe extraction category'
```

Five focused tests and the 19-test browser smoke suite passed. Full `npm run ci`
with the local `TEST_DATABASE_URL` set passed both typechecks, the frontend
build, and all 53 test files: 1,209 tests passed and two skipped. `git diff --check`
passed. This isolated branch starts at `dev` commit `6e84ef3` and does not include
the unrelated uncommitted work in the running service checkout. The failed
transfer must not be retried.

## Follow-up: post-dispatch observation errors were terminal

Two further service runs at `2b5d61f` reproduced the stall live. Transfer
`e7312555-d874-4864-b4b6-c8c5e64b15f1` dispatched once at attempt 21, then one
extract succeeded and the next failed; the run finished `POST_OUTCOME_UNKNOWN`
immediately. Update-member `71109685-c468-4bd1-92a2-b422814c93cd` dispatched once
at attempt 14, extracted, and failed completion validation at `done`; same result.
Before dispatch the same loop tolerated four action errors in the transfer run.

Root cause is in `src/agent/loop.ts`, not in any selector: after
`mutationDispatched`, every thrown error was routed to `POST_OUTCOME_UNKNOWN`,
including read-only `extract`/`assert` failures and `done` validation
rejections. The result page is still open in those cases and the surface already
refuses repeat dispatch, so the loop now counts them as consecutive failures and
lets the model re-observe. Exhausting the retry budget, aborts, detectors and
every other error keep unknown precedence, and human-repair escalation is refused
once dispatched. Both live runs remain terminal and must not be retried; their
capabilities stay blocked until a separate read-only inquiry reconciles them.

## Follow-up: receipt row replaced by balance read-back

The six-field transaction row was the second half of the stall. It demanded two
extractions that agreed byte for byte, against a receipt whose shape was never
observed unmasked, and it was the only proof of completion. The transfer contract
now matches open-share: one scalar `confirmation` extracted from the receipt, and
completion proven by `validateTransferCompletion`, which re-reads the member
shares table and requires the source balance to fall and the destination balance
to rise by exactly the requested amount with every other share unchanged. The
pre-dispatch baseline is the same fresh eligibility read taken during approval
revalidation. Replay preflight now refuses a transfer artifact without that
validator, and the `transaction` output, its column allowlist and the tool
guidance about grouped receipt rows are removed.
