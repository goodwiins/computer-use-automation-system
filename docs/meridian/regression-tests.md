# Workspace regression tests

Run with Node 22 after `npm run setup`. Point `TEST_DATABASE_URL` at a disposable
PostgreSQL database that permits creating schemas; the PostgreSQL fixture creates
and drops its own isolated schema. The suite does not use production credentials,
live target applications, or model API keys.

```sh
npm run test:regression
npm run ci
git diff --check
```

The focused command builds the real Next.js UI, then runs these existing suites:

| Suite | Regression boundaries |
| --- | --- |
| `chat.test.ts` | Server-observed clarification reaches both inference steps; substituted history, cross-subject access, stale context, and status replies cannot supply action authority. The full 20-message history uses one service batch. |
| `chat-ui.test.ts` | Real Chromium exercises direct and chat completion, exact-run review, response loss, role changes, and unknown outcomes. Ordinary capabilities become usable after verified completion. |
| `ui-readiness.test.ts` | One readiness batch and one projected request batch, with ownership checks, unavailable storage, and pending/unknown holds. |
| `postgres-journal.test.ts` | Real PostgreSQL tests direct/alias identity, one authority transaction per batch, input bounds, and persistent quarantine. |
| `journal-alias.test.ts` | Filesystem parity, restart authentication, unchanged durable records, and failed storage. |
| `meridian-cli.test.ts` | Replay and discovery idle-pool errors close the runtime, fence dispatch, retain ownership for recovery, and suppress private diagnostics. |

Clarification is temporary server memory: at most 100 pending exchanges, each at
most 20 messages / 16,000 serialized characters, usable for 10 minutes. Expiry,
restart, or eviction requires restating the request. A consumed exchange cannot
be reused by a stale or concurrent follow-up. Accepted journal state takes precedence.
Client-supplied historical assistant text is not replayed into inference.

These deterministic model fixtures verify context and tool boundaries, not the
accuracy of a live model's intent classification. Browser and database tests are
local regression evidence; they do not establish live posting acceptance.
