# Task 1 report — inline operator approval

Base: `928450c728e496d2adc4ff70aa445e1436672198`

Implemented the existing `ApprovalPanel` inside assistant-ui run cards for current operator `risk_approval` interventions. Chat uses literal **Accept** and **Reject** labels, while the shared panel still posts the exact `{ approvalId, decision }` to the existing run decision endpoint. Caller cards, repair interventions, replaced interventions, and terminal runs do not expose inline controls. Activity remains available.

The shared session attempt remains the single decision lock across chat and Activity. Submitted status focus is limited to the surface that initiated the decision; duplicate/background mounts do not steal focus. Existing authoritative refresh/probe behavior remains unchanged.

Verification:

- `npm run setup` — passed (Node `v22.23.1`)
- `npm run test:smoke` — 19 passed
- focused inline Accept/Reject/caller/duplicate-lock browser regression — 3 passed
- focused approval authority/replacement/exact-lock/action-context/caller regressions — 7 passed
- existing offline operator decision lifecycle regression — 1 passed in isolation
- `npm run typecheck` — passed
- `npm run typecheck:ui` — passed
- `npm run build` — passed as the focused test pretest
- `git diff --check` — passed

Full `npm run ci` with disposable PostgreSQL on port 55442 is assigned to root's shared heavy-check slot. No live mutation or capability acceptance is claimed by these offline UI fixtures.
