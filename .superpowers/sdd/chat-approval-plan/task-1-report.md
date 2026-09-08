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

Root subsequently ran full `npm run ci` at `758a48d` with disposable PostgreSQL on port 55442: 51 files and 1108 tests passed.

Independent review found a duplicate-panel recovery race. The follow-up fix claims the probe from a fresh shared-attempt snapshot and gives each probe an identity; callbacks update the attempt only while that identity remains current. A held-response browser regression verifies one recovery probe across inline and dialog mounts and keeps a newer decision locked on both surfaces.

No live mutation or capability acceptance is claimed by these offline UI fixtures.
