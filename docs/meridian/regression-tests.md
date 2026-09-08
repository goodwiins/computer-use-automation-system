# Workspace regression tests

Run with Node 22 after `npm run setup`. Point `TEST_DATABASE_URL` at a disposable
PostgreSQL database that permits creating schemas; each PostgreSQL fixture creates
and drops its own isolated schema. No production credentials, live target
applications, or model API keys are used.

```sh
npm run test:regression -- --maxWorkers=2
npm run ci -- -- --maxWorkers=2
git diff --check
```

The focused command builds the real Next.js UI before running these suites.
Its regression grouping incorporates the parallel workspace regression effort;
the combined implementation must be reviewed and tested as one source head.

| Suite | Regression boundaries |
| --- | --- |
| `chat.test.ts` | Server-observed clarification, edited/forged history, private accepted boundaries, subject isolation, status replies, and bounded history projection. |
| `chat-ui.test.ts` | Real Chromium direct/chat completion, exact-run review, response loss, role changes, and unknown outcomes. Non-MERIDIAN profiles work even with MERIDIAN-style capability names. |
| `ui-readiness.test.ts`, `src/server/ui/session-readiness.test.tsx` | Explicit server readiness policy, conservative missing metadata, catalog binding, pending identity, and unknown-state holds. |
| `journal-read-batch.test.ts` | Filesystem/PostgreSQL parity, nineteen aliases in one authority transaction, private accepted markers, foreign exclusion, input bounds, global quarantine, and per-principal/global nonqueueing read admission. |
| `journal-recent-history.test.ts` | Storage-level ownership and privacy filtering before the 100-row history bound, deterministic ordering, pending private operator review discoverability, and retained older exact-run access. |
| `postgres-journal.test.ts`, `journal-alias.test.ts` | Durable direct/alias identity, restart authentication, ownership, unchanged records, and storage failures. |
| `meridian-cli.test.ts`, `cli-pool.test.ts` | CLI replay/discovery error handling, dispatch fencing, safe evidence, once-only cleanup, and retained recovery ownership. |
| `cli-pool-postgres.test.ts` | Terminates only its own isolated idle test connection and checks real PostgreSQL authority and dispatch-intent retention. |
| `browser-startup-cleanup.test.ts` | Cleanup waits for delayed Chromium launch, prevents further initialization, closes once, and retains close failures. |

Clarification is temporary server memory: at most 100 retained/in-flight slots, each exchange at
most 20 messages / 16,000 serialized characters, usable for 10 minutes. Expiry,
restart, or eviction requires restating the request. A consumed exchange cannot
be reused by a stale or concurrent follow-up. Replaced, consumed, expired, or
evicted producer slots cannot publish a late response back into the cache.
Accepted journal state, including
private accepted markers, takes precedence. Client-supplied historical assistant
text does not establish clarification context.

Chat context, readiness, and recent history each have separate read admission:
one in-flight read per owner and four globally per class (12 across all three), without a waiting queue.
Readiness polling therefore cannot consume a foreground chat slot. Bound actions
continue read-only polling after their own run terminates so another operation's
temporary readiness hold can recover without resubmission.

Recent history returns at most 100 authorized records, with pending operator
reviews taking priority. Ownership and private-record visibility are applied
before selection; the selected records retain ascending chronological order.
Older records are not deleted and remain available through authorized exact-run
reads. The UI supplements recent history with the runs it is already following.

Deterministic model fixtures verify context and tool boundaries, not live-model
classification accuracy. Browser and database tests are local regression evidence;
they do not establish live posting acceptance.
