# Adapting the capability system to MERIDIAN

MERIDIAN is the hosted legacy banking UI at
`https://web-sample.interface-hiring.com`. The reusable unit is a reviewed,
versioned capability artifact: a model discovers the workflow once, then a
deterministic executor replays its actions, assertions and output extraction.
The [demo guide](demo-day.md) shows a balance success and a missing-member
exception through chat/API/dashboard. The latest recorded acceptance is four
of seven capabilities: sign-on, inquiry, member record and open share. Transfer,
contact update and supervisor hold are incomplete. These are recorded results,
not a claim that the September 8 presentation build has passed a fresh live run.

## What adapting the target took

This required more than changing an entry URL. MERIDIAN has sign-on, operator
roles, branch context, legacy tables, member-specific navigation, hidden form
tokens and irreversible posting controls. A profile supplies the hosted origin,
allowed routes/forms, detectors and masking rules. Recorded read capabilities
resolve one exact member and extract typed rows, excluding headers that use
ordinary `td` elements. Ambiguous results stop instead of selecting the first row.

The core gained shared runtime enforcement so CLI discovery, replay and HTTP
invocation use the same guarded browser path. Frame/navigation identity and
current member eligibility bind an action to the page actually inspected.
Transfer must be entered from the verified member record; jumping through a
global shortcut had bypassed eligibility initialization. Native table capture,
grouped extraction and explicit result contracts address the legacy layout
without inventing selectors or receipt provenance.

Mutations required a request-bound approval gate and durable dispatch intent.
The browser's native review facts, role, token, URL and outgoing body are checked
again immediately before posting. Completion must match the requested operation;
a generic “success” banner is insufficient. Auxiliary pages are taken offline
before closure to prevent cleanup from issuing unintended requests. These changes
live below the chat layer because every entry point needs the same guarantees.

## Capability API and chatbot contract

Express exposes the shared `InvocationService`; Next.js statically exports the
assistant-ui frontend, served by that same process. There is no separate chatbot
or dashboard backend. The Vercel AI SDK classifies chat intent and offers only
the authorized tools for that request. Status uses the existing run. Models
interpret language; server code controls authorization, invocation and approval.

| Request | Contract |
| --- | --- |
| `GET /capabilities` | Authenticated catalog with approved versions, public parameter/output schemas and availability. Server credentials are excluded. |
| `POST /capabilities/:id/invoke` | Bearer credential, `Idempotency-Key`, strict JSON such as `{"args":{"member":"<selected member>"}}`. Returns HTTP 202 and `{"runId":"<UUID>"}`. |
| `GET /runs/:id` | Caller-scoped state, step, result, evidence filenames and permitted intervention projection. Poll this until terminal. |
| `POST /api/chat` | SDK UI-message stream; tool acceptance binds to the same authoritative run. A text response is not completion evidence. |
| `POST /runs/:id/decision` | Operator-only current `approvalId` and permitted decision; caller/chat cannot grant approval. |

Inputs are validated against the approved artifact and canonical capability
contract. Reusing the same key and identity returns the original run; conflicting
inputs fail. Lookup-only recovery never starts execution. Success contains typed
outputs (member record returns `shares` with `shareId`, `type`, `balance`,
`status`). Business outcomes contain an `outcomeCode`; failures retain a safe
reason and evidence. An accepted HTTP request can subsequently fail or escalate.

## Reliability and exceptional states

Replay resolves locators in the recorded frame using ranked strategies, requires
unique matches, waits within bounds, and checks assertions and profile detectors.
It does not ask a model to improvise a repair. Native dialogs and unexpected
navigation are guarded. Business conditions such as `NO_SUCH_MEMBER` are reported
as outcomes, rather than successful empty balances or unexplained crashes.
Permission/session/application errors stop explicitly. Known pre-intent
maintenance recovery is bounded and rechecks the same-browser checkpoint.

Unresolved drift can hand control of the existing browser to an operator; repair
and approval are separate interventions. The API dashboard projects pending
review and clean terminal states. The repository includes hosted success and
missing-member evidence, a hosted escalation that was aborted before posting,
and a mock same-session repair demo. The mock is labeled separately. Natural idle
expiry and several operation-specific exceptional discovery/replay pairs remain
unverified; detector unit coverage is not live acceptance.

## Safety, evidence and limits

Credentials stay server-side; chat always uses caller authority. Origin, frame,
role, member, token and request-fact checks apply below all frontends. Posting
approval is scoped to one current action, expires, and is revalidated before
native dispatch. CLI approval trusts the local OS account: an interactive-terminal
check is not proof of human presence against another same-user process.

A signed journal reserves request identity and records intent before dispatch.
After restart, unfinished undispatched work becomes interrupted; unverifiable
posting becomes terminal `POST_OUTCOME_UNKNOWN` and is never automatically
retried. The historical unknown open-share run remains preserved. HMAC integrity
depends on keeping the journal key private and stable. The default single-process
filesystem authority suffices for this demo; optional PostgreSQL authority and
conversation storage already exist, with explicit configuration and migration.

Run logs, masked screenshots and safe results provide evidence. Sensitive runtime
outputs can be shown to an authorized caller while available; restored history
withholds values rather than reconstructing them from unrelated runs. Evaluation
checks signed journal/log consistency, attempts and mutation intent, while task
success is reported separately. Public summaries retain producer SHAs and hashes;
private journals and secrets are not a public backup bundle.

The deliberate cut is a narrow, reproducible read/exception demonstration using
the existing UI. Multi-worker scheduling, a remote production deployment and
additional dashboards are unnecessary for it. Next work is to complete and review
the remaining three write recordings, obtain separately approved replays and
operation-specific exceptions, then rehearse the chosen source build and capture
a sanitized backup clip. [Recorded evidence](live-evidence.md) and the
[requirement matrix](implementation-progress.md) keep those gaps explicit.
