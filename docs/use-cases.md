# Use cases

What this system is for, in the words of the people who would pay for it.

## The situation it exists for

A credit union runs an AI agent that talks to members. A member asks "what's my
savings balance?" or "open me a vacation savings account". The agent knows what
it wants to do. It cannot do it, because the answer lives in a back-office
servicing application that has no API — a server-rendered legacy web app with
framesets, nested tables and no test IDs, or a green-screen refaced into HTML.
Today a human operator reads the screen and types.

This system is the pair of hands. The model works out the flow **once**, that run
becomes a typed capability, and from then on the agent invokes the capability
with parameters and gets structured data back. No model in the production loop.

> The model discovers. The artifact becomes a reusable capability. Deterministic
> replay is how the AI agent invokes it in production.

Two capabilities are recorded in this repo. They are deliberately different
shapes: one reads, one writes and stops.

---

## 1. Read — balance inquiry during a member conversation

**Capability:** `lookup-member-balance@1.0.0`
**In:** `memberId: string` · **Out:** `savings_balance: string`

The member asks for their balance. The agent calls the capability instead of
routing the call to a human.

```bash
npm run replay -- --artifact artifacts/lookup-member-balance.v1.0.0.json \
  --params '{"memberId":"23456"}'
#  {"status":"success","outputs":{"savings_balance":"9,812.55"}}
```

Five recorded steps run behind that: open Member Inquiry, type the member
number, submit, open the record, read the savings row. The success condition
(`/members/{{memberId}}$`) is **verified** before the output is returned, so the
agent cannot be handed a balance scraped from the wrong member's page.

**Why it matters:** the same recording serves every member. Member `12345`
returns `4,250.13`, member `23456` returns `9,812.55`. Nothing is re-recorded and
no model is called, so the marginal cost of the ten-thousandth lookup is a
browser session, not a model invocation.

**When the answer is "no":**

```bash
npm run replay -- --artifact artifacts/lookup-member-balance.v1.0.0.json \
  --params '{"memberId":"99999"}'
#  {"status":"business_outcome","outcomeCode":"NO_SUCH_MEMBER", ...}
```

That is not a crash and must not be reported as one. "No such member" is a
legitimate answer the agent needs in order to say "I can't find that account,
can you confirm the number?" Conflating it with a failure is how an agent tells
a member the system is broken when the member simply mistyped a digit.

---

## 2. Write — open a sub-account, and stop before the irreversible click

**Capability:** `open-subaccount-to-confirmation@1.0.0`
**In:** `memberId`, `nickname`, `deposit` · **Out:** `confirmedNickname`, `confirmedDeposit`

The member wants a new Secondary Savings sub-account. Eleven steps: navigate to
the member, open the sub-account form, choose the type, fill the nickname and
the deposit, submit, then read back what the confirmation screen says.

```bash
npm run replay -- --artifact artifacts/open-subaccount-to-confirmation.v1.0.0.json \
  --params '{"memberId":"23456","nickname":"RAINY DAY","deposit":"50.00"}'
#  {"status":"success", "outputs":{"confirmedNickname":"RAINY DAY", ...}}
```

**The important part is where it stops.** The capability ends at the
confirmation review screen. The "Open Account" button is never clicked, and the
recording contains no step that clicks it. Every recorded step is classified
`read` or `reversible_write`; nothing in this capability is `irreversible`.
Opening a real account is a decision a person makes, holding the confirmation
screen the automation prepared.

That boundary is enforced in four independent places, so no single mistake
crosses it:

| Layer | What it does |
|---|---|
| Recorder | Floors a submit-looking control to at least `reversible_write`; text like "open account" floors it to `irreversible` |
| Policy | `irreversible` is set to `escalate`, so such a step stops and asks a human |
| Approval | Only a real terminal can approve a risky step; a piped caller is refused |
| `validate` | Re-checks every saved artifact against the current risk floor, in CI |

**When the app says no:**

```bash
npm run replay -- --artifact artifacts/open-subaccount-to-confirmation.v1.0.0.json \
  --params '{"memberId":"12345","nickname":"TEST","deposit":"1.00"}'
#  {"status":"business_outcome","outcomeCode":"VALIDATION_REJECTED", ...}
```

The deposit is below the minimum. The agent needs that as an answer, so it can
tell the member what to change, not as a stack trace.

---

## 3. Scale — one recording, many institutions

Hundreds of institutions run the same vendor product, branded and configured
differently. Re-recording per institution does not scale, and neither does a
capability that silently breaks on the second one.

The second tenant here renames the menu entry from "Member Inquiry /
Maintenance" to "Account Inquiry". The base recording fails loudly:

```bash
npm run replay -- --artifact artifacts/lookup-member-balance.v1.0.0.json \
  --entry-override "http://localhost:4173/?tenant=premier" --params '{"memberId":"23456"}'
#  {"status":"failure","failure":{"observed":"Could not uniquely resolve ...: role=0, text=0, css=2"}}
```

A thirteen-line overlay fixes it without touching the recording:

```bash
npm run replay -- --artifact artifacts/lookup-member-balance.v1.0.0.json \
  --overlay config/overlays/premier.json --params '{"memberId":"23456"}'
#  {"status":"success","outputs":{"savings_balance":"9,812.55"}}
```

The overlay carries only what differs for that tenant: the entry URL and one
extra locator, prepended ahead of the recorded tiers so a partially-skinned
variant degrades gracefully. It pins the exact base version it was reviewed
against, so bumping the base forces re-review.

---

## 4. When the run cannot finish — a person takes the wheel

The vendor ships a point release that renames the Search button. The recorded
locator no longer resolves. Instead of failing the member's request, the run
raises an intervention carrying the capability, the goal, the step, the reason,
the URL and a screenshot. An operator attaches to **the same live browser
session** the automation was driving, does the step by hand, and hands control
back. Automation re-runs its detectors and continues to the verified success
condition.

```bash
BREAK_MARKUP=1 npm run target-app      # the drift
npx tsx scripts/demo-escalation.ts     # stuck -> human -> resumed -> success
```

What the human did is recorded too, redacted, and attributed only while they
held control. A `ControlSession` state machine owns the single fact of who is
driving, so "who is in control" is never ambiguous.

The operator console here is a terminal prompt plus the live window. The seam it
sits on — pause, cede, capture, resume — is the real thing, and a production
co-browsing console is product work on top of it.

---

## What the caller has to handle

Every invocation returns exactly one of three shapes. This is the contract the
calling agent is written against.

| Result | Meaning | What the agent does |
|---|---|---|
| `success` | Goal reached, success condition verified | Use the typed outputs |
| `business_outcome` | The app gave a legitimate answer: not found, validation rejected | Tell the member; branch on `outcomeCode` |
| `failure` | Something is wrong: session expired, permission denied, unexpected dialog, unresolvable control | Escalate or retry the whole call; never guess |

Recoverable conditions never reach the caller. A known interstitial is dismissed
by its detector and the step is retried once, with the recovery recorded in the
evidence trail.

Every run leaves `evidence/`: a redacted JSONL log of what happened and why,
per-step screenshots, and the `result.json` the caller received. Sensitive
parameter values are never written to the artifact or the log — the artifact
stores `{{templates}}`, and the logger masks registered values and
credential-shaped strings.

---

## Where this is not the answer

If the application has an API, use the API. This system exists for the long tail
where there is no API and the only surface is the one a human operator sees. It
is also not a general web agent: it does not reason about the page at run time,
by design. Everything it will do was decided once, reviewed by a person, and
frozen into a versioned artifact.
