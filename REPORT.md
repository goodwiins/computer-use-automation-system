# Design Report

## 1. Architecture

Single Node/TypeScript process, four layers with one deliberate seam:

```
discovery (LLM, OpenAI tool-calling)  ─┐
                                       ├─>  Surface (perceive/act port)  ─> Playwright ─> live UI
deterministic replay (no LLM)         ─┘         ▲
        │                                        └─ GuardedSurface: policy allowlist wraps EVERY actor
        └─> capability artifact (Zod-typed JSON) — the only thing that crosses from discovery to replay
```

Key decisions:

- **The artifact is the only bridge.** Discovery emits a typed artifact; replay consumes only the artifact. The model transcript is evidence, never input to production execution. This makes replay auditable and the capability reviewable.
- **Policy enforcement lives in a Surface decorator**, not in the agent or the replayer. The LLM, the executor, and any future caller pass through the same allowlist gate — no code path can act outside it by construction.
- **One process, JSON files on disk** for artifacts and evidence. Hundreds of tenants would need a store and a queue; building them now would be premature infrastructure. The interfaces (artifact in, structured result out) are where that would bolt on.
- **Accessibility-first perception.** Observation is the per-frame accessibility (aria) snapshot, not the DOM: it works on non-semantic table-soup markup, and it is the one representation that conceptually carries over to desktop apps (UIA/AX). The mock target app is deliberately hostile — framesets, nested tables, `<font>` tags, no test IDs — to keep us honest.

## 2. Artifact schema

A capability is a **callable contract**, not a step list. The schema (Zod, `src/artifact/schema.ts`) declares:

- **`parameters` / `outputs`** — typed inputs per invocation and typed returns, like a function signature. Parameters marked `sensitive` are redacted everywhere and never persisted as literals: every occurrence of a parameter's value observed during discovery (in URLs, filled values, even link names like a member number) is lifted into a `{{param}}` template by the recorder (including step intents, target descriptions, drift snapshots, and provenance).
- **`steps`** — each with a human-readable `intent` (reviewability), an action, a **risk class** (`read` / `reversible_write` / `irreversible`) feeding the safety gate, and a timeout.
- **`TargetDescriptor`** — per control, an *ordered tier* of locator strategies: ARIA role + accessible name → form `name` attribute (load-bearing in server-rendered apps: the server reads it) → exact visible text → structural CSS as last resort. Plus the frame name, and a `snapshot` of what discovery saw for drift diagnostics. Replay logs which tier resolved; tier degradation over time is a drift signal.
- **`detectors`** — known runtime conditions (error banners, interstitials, session expiry) with a classification and optional recovery. These are app-level knowledge, curated per app profile and stamped into artifacts at record time.
- **`successCondition`**, **`status: draft|approved`** (drafts refuse unattended replay), **`version`**, and **`provenance`** (which model, which discovery run — no transcript, no raw values).

Ambiguity policy: a strategy that matches more than one element **fails** (unless an explicit `nth` is declared). Determinism over convenience — guessing is how replays silently do the wrong thing to the wrong account.

## 3. Determinism & error handling

Replay (`src/replay/executor.ts`) never consults a model. Determinism comes from: tiered resolution with uniqueness enforcement; bounded polling waits (absorbing slow loads like the `?sim=slow` 5s delay) instead of sleeps; parameter binding at invocation; and a final `successCondition` that is verified, not assumed, before outputs are returned. The schema supports mid-flow `assert` checkpoints too (used in hand-written artifacts/fixtures); recorder-generated artifacts currently rely on self-verifying extracts plus the final success condition — an `assert` tool for discovery is listed as a next step in §7.

The result contract separates three things the brief warns against conflating:

- **Business outcomes** — "no such member", "validation rejected" are legitimate answers: `{status:"business_outcome", outcomeCode:"NO_SUCH_MEMBER"}`. The caller branches; nothing "failed".
- **Recoverable conditions** — a known interstitial is dismissed via its detector's recovery action (bounded to once per step per detector, so a persistent condition cannot loop), logged in `recoveries`; transient slowness is absorbed by waits.
- **Hard failures** — everything else stops with `{stepId, intent, expected, observed, screenshot}`. Permission denial is a fatal detector too (a security-profile problem is not the caller's to retry). An unexpected native dialog is never accepted: the surface dismisses it, logs `dialog.unexpected`, and the executor names it in the failure of the step it broke — which is often a later step than the one it fired on. Session expiry is deliberately fatal-not-recoverable: flow state is lost, and whether to re-run from the entry point is the *caller's* retry decision, not something replay should improvise mid-flow.

Detectors run before every step, and — importantly — **again when a step fails**, because a failure is often *explained* by a condition that appeared mid-flight (the button didn't vanish; the session expired). UI drift, secondary in this environment, surfaces as tier degradation or resolution failure with the discovery-time snapshot attached for diagnosis; the escalation path then covers the gap (see the scripted drift demo).

## 4. Heterogeneity & multi-tenant

**Why this mock is a credible proxy.** Real CU back-office UIs come in three forms: terminal-style keyboard clients (Jack Henry Symitar Episys; CU*Answers CU*BASE GOLD is a GUI skin over 5250 sessions), Windows thick clients (Fiserv Signature Teller), and browser-delivered legacy web — Fiserv Cleartouch's hosted teller, FIS Horizon's browser front end over a 1980s core, and the whole IBM WebFacing/HATS category that refaces green screens into server-rendered table-grid HTML with no semantic markup. The mock imitates that third segment (table layouts, panel codes, function-key legends, full-page POSTs, EOD/memo-post maintenance windows, session-timeout interstitials — all documented behaviors) because it is precisely the segment browser automation can reach; the first two motivate the desktop `Surface` adapter below.

**Surface seam.** Artifacts and the replay engine speak only the `Surface` interface (`observe / click / fill / readText / describeTarget…`). A legacy web app is the same implementation with uglier pages — which is why the mock is one. A desktop surface is a new implementation backed by OS accessibility APIs (UIA/AX): the `role`+`name` tier maps directly onto accessibility trees; `nameAttr`/CSS tiers are declared surface-specific and simply absent there. A screenshot+coordinates implementation slots in the same way for surfaces with no tree at all, at the cost of weaker targeting. The artifact schema does not change.

**Multi-tenant reuse.** Many tenants run the same vendor product configured differently, so an artifact records against the *vendor app profile* (`appId`), not a tenant. A **minimal version is implemented**: a base artifact plus thin per-tenant **overlays** (`config/overlays/*.json`, validated by `TenantOverlay` and composed by `applyOverlay` at load time) — tenant entry URL, parameter defaults, and locator overrides that are *prepended* ahead of the recorded tiers (variant tier first, base tiers as fallback, so a partially-skinned variant degrades gracefully). The composed artifact carries `overlay` provenance and is reviewable as a distinct thing; the base file is never modified, and the overlay pins the exact base `id@version` it was reviewed against — a base version bump forces re-review. Demonstrated end-to-end: the mock app's `?tenant=premier` skin renames the menu entry point; the base artifact alone hard-fails at that step (`role=0, text=0, css=2`), the same base with `--overlay config/overlays/premier.json` replays successfully (evidence/). Not built: the overlay *catalog* per tenant and drift management as telemetry from replays — which locator tier resolved, checkpoint pass rates, per tenant. Tier degradation → flag for review; hard failure → escalation + re-record of the affected step for that overlay. An overlay carries its own `status`: it composes as `draft` unless the overlay itself is marked `approved`, so an unreviewed delta cannot inherit the base's approval and replay unattended — an overlay can re-aim a step's locator at a different control, which is a reviewable change in its own right. Its `entryUrl` must also fall inside the base artifact's allowed origins.

## 5. Escalation & handoff

**Stuck detection.** Discovery: the model calls `escalate`, or three consecutive action failures trip the stuck counter. Replay: a hard failure or fatal detector in attended mode, or a policy verdict of `needs_human` on a risky step.

**Control-transfer model.** A `ControlSession` state machine owns one fact: who controls the live session — `automation` or `human`. Transfers are explicit, logged, and carried in the evidence trail. On escalation, an intervention request (capability, goal, step, reason, URL, screenshot) goes to the operator; automation stops issuing actions; the human operates **the same live browser session** — locally (headful window) or remotely by attaching over CDP, which is exactly what the scripted demo does and what a production co-browsing console would build on. The human's actions are captured (redacted: field names and value lengths, not values) and attributed only while the human owns the session. Handback is a decision: `retry` (re-attempt the stuck step), `skip` (the human performed it manually), or `abort` — after which automation re-runs its detectors and continues to the verified success condition.

**Deliberately mocked:** the operator UI is a terminal prompt plus the live browser; a real console (queueing, auth, screen streaming) is product work on top of the same seam — pause, cede, capture, resume — which is real and demonstrated end-to-end.

## 6. Safety

- **Allowlist** (`config/policy.json`): permitted origins and action types, enforced in the `GuardedSurface` decorator for every actor — including session start, post-action origin verification on every navigating action (start/navigate/click/fill/select), and frame filtering: frames outside the allowlist are invisible to observation and untouchable by locator resolution. Artifact origins must be a subset of policy origins — both gates must pass. Denials never echo query strings (which may carry member data).
- **Risk classes**: per-step `read` / `reversible_write` / `irreversible`, with per-class handling (`allow` / `confirm` / `escalate` / `block`). Default policy escalates irreversible steps to a human; discovery never auto-approves them — the model is instructed to `escalate` instead. Limit: risk classification of a recorded step is assigned by heuristics + review, and a mislabeled step is the main residual risk — which is why `draft` artifacts refuse unattended replay until a human promotes them. `validate` re-applies the current risk floor to every saved artifact (run in the test suite), and a risk approval is only accepted from a TTY, so a piped `--attended` caller cannot approve an irreversible step.
- **Data handling**: artifacts store `{{param}}` templates, never runtime values (including inside `css` selectors, which the model is prompted to anchor on row labels); the recorder also templatizes values that leaked into locator names and drift snapshots. All evidence passes through a redactor that masks registered sensitive values (including inside URLs) and credential-shaped strings. Secrets live in env vars, never in the repo or artifacts.
- **Limits**: approval is a plaintext `status` field — anyone with write access to `artifacts/` can flip it; artifact signing (HMAC over the canonical JSON, verified at replay) is the next safety item and is deliberately not built here. Redaction is deny-list-of-values, not NLP — free text an app renders (e.g. a name on screen) can appear in screenshots; production would add region masking and encrypted evidence storage.

## 7. Cuts

Cut deliberately, seams left clean:

- **Operator console UI** — terminal + CDP attach instead; the transfer model and capture are real (§5).
- **Desktop / second surface implementation** — the `Surface` port exists; only the browser adapter is built (§4).
- **Tenant overlay catalog & drift telemetry** — overlays themselves are implemented (§4); the per-tenant catalog/registry and tier-degradation telemetry are not.
- **Session-expiry re-entry** — modeled as a fatal outcome with a caller-side retry story rather than automated re-login mid-flow.
- **Artifact store/queue/API** — files + CLI. The `list` command is the embryo of the agent-facing catalog.

Next, in order: (1) expose the catalog as a tool-calling surface (each artifact's parameters/outputs already are a function schema, so this is mostly transport); (2) assisted fallback — on locator failure, a bounded single-step LLM repair, policy-checked and recorded as a new draft version; (3) the tenant overlay catalog + tier-degradation telemetry (overlays themselves are already in); (4) a real operator console over the CDP seam.
