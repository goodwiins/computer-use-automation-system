# MERIDIAN Target Application (§2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the assignment's target-application gaps using the existing runtime and PRs, then finish the four missing live write capabilities.

**Architecture:** Retain the hosted MERIDIAN profile, native browser forms, guarded runtime, deterministic replay and authenticated journal. The narrowly typed insufficient-funds result is delivered through PR #43. The existing execution plan continues to own recording, promotion and live acceptance.

**Tech Stack:** Existing Node 22, TypeScript, Playwright, Express, Zod and Vitest. The user separately selected Vercel AI SDK for the conversational backend and [assistant-ui](https://www.assistant-ui.com/) for the final chat component map; an isolated sibling task owns that work.

**Spec:** User-supplied *Adaptation Project — MERIDIAN CORE (Demo Day, Fri Aug 28)*, §2 “The target application,” §2.1 capabilities and §2.2 exceptional states. Read alongside the [replacement design](2026-09-03-meridian-adaptation.md) and [execution plan](2026-09-04-meridian-superpowers.md). The PDF is the assignment source; implementation choices in these plans are not additional assignment requirements. This supplement replaces only the generic insufficient-funds outcome expectation and adds a §2 coverage map; it does not restart completed tasks.

## Global Constraints

- Target `https://web-sample.interface-hiring.com`, through its UI. Use `--profile meridian` for discovery; do not change the legacy default or use the local fixture as proof of hosted completion.
- All seven capabilities require acceptance; the present live count remains **3/7**.
- Keep native per-transaction tokens transient. Inspect the current form before submission; retain origin, frame, role, branch and approval checks.
- A business result is not a broken capability. An underfunded, otherwise valid request must terminate as `business_outcome / INSUFFICIENT_FUNDS` before mutation intent.
- Dispatch intent is not proof of POST delivery. Failed or unverified completion after intent remains `POST_OUTCOME_UNKNOWN`, even if an exception or page text says insufficient funds. Never automatically retry it.
- Validated decimal strings enter the runtime; integer cents are used for money comparisons. Malformed balances, wrong member, duplicate shares and stale evidence remain failures, not insufficient-funds answers.
- Refresh member/share state before each operation: the target is in-memory and can reset on redeploy. Seed IDs, balances and the held share are not permanent fixtures.
- Every major implementation task gets its own PR against `dev`; `master` is production. Use isolated `codex/` branches and preserve the dirty acceptance worktree and its unpromoted draft.
- Do not merge, record or post as part of writing this plan. Future live posts retain individual human approval on current facts.
- Keep the isolated Vercel AI SDK/assistant-ui work independent from capability acceptance. Final integration must preserve Express, the shared `InvocationService`, server approval and the existing dashboard/auth/operator controls. Package versions and visual/interaction scope remain a gate; no dashboard rewrite is implied.
- Document mocked boundaries when access fails, but label offline fixtures and recorded evidence separately from live completion. A contingency demonstration does not increase live coverage.

## Verified implementation and PR ledger — September 5, 2026

Current runtime baseline: `2c7f4ed4577fe01bbfb441525b7cccc14128c46b`. Passing runtime and integration checks do not establish live acceptance.

| PR | Reviewed/final source | Integrated result | Reuse boundary |
| --- | --- | --- | --- |
| [#34](https://github.com/goodwiins/computer-use-automation-system/pull/34) / [#35](https://github.com/goodwiins/computer-use-automation-system/pull/35) | Historical reviewed heads `def4b38a2f906f725813f5c89563f3fe82e31140` / `338734d16e7fc0f30f239886660e0f1af30a6c` | Runtime and safety baseline in `dev` | Reuse; retain regression gates |
| [#37](https://github.com/goodwiins/computer-use-automation-system/pull/37) | `745ef645ae48730e769e6fc639ec4f71739d23e8` | Merged as `480b252ab60edc77aff1bc37f6cd08ba9645f8d1`; merge producer passed | Reuse read acceptance, catalog tests and elapsed rendering |
| [#39](https://github.com/goodwiins/computer-use-automation-system/pull/39) | Repair `05f0647`; final reviewed head `64c9b11` | Merged as `fcd87f7fb8d573c8d44d43436310cce07baae06a`; head/merge producers and 257 local tests passed | Reuse transfer fact, approval and completion binding |
| [#41](https://github.com/goodwiins/computer-use-automation-system/pull/41) | Repair `3aacfac`; final reviewed head `ec5f6a1ea421c7d4b5b345c4d83614eb513d3ec9` | Merged as `aa90387244be07b9955b8b5b83eacf4b9f3058a1`; head/merge producers and 269 local tests passed | Reuse terminal setup, cleanup and cancellation fixes |
| [#43](https://github.com/goodwiins/computer-use-automation-system/pull/43) | Source `6ab82fe`; reviewed head `834f060` | Merged as `4f84b9f`; 131 focused and 274 full offline tests plus merge CI passed | Typed pre-intent `INSUFFICIENT_FUNDS`; no live underfunded acceptance |
| [#44](https://github.com/goodwiins/computer-use-automation-system/pull/44) | Reviewed head `0001b3d` | Merged as `0968556`; 275 tests/17 files and head/merge CI passed | Actual-`tsx` CLI browser inspection |
| [#45](https://github.com/goodwiins/computer-use-automation-system/pull/45) | Reviewed head `4789be8` | Merged as `5c18923`; 275 tests/17 files and head/merge CI passed | Sibling transfer review/form association and submit overrides |
| [#46](https://github.com/goodwiins/computer-use-automation-system/pull/46) | Reviewed head `c4279ac` | Merged as `8e625cc`; 276 tests/17 files and head/merge CI passed | Terminal-only CLI approval guidance |
| [#47](https://github.com/goodwiins/computer-use-automation-system/pull/47) | Reviewed head `66a9fb0` | Merged as `2c7f4ed`; 278 tests/17 files, final review and head/merge CI passed | Trusted event/result metadata; historical evidence unchanged |

No listed PR contains an approved transfer, open-share, update-member, or place-hold artifact. The runtime fixes do not promote the transfer draft. Current live acceptance remains `3/7`, and the producing SHAs in the evidence ledger remain source-specific.

The separate discovery-input audit remains open from this baseline and confirmed canonical discovery can reach runtime/model work with missing public inputs and can compile literal values for non-transfer capabilities; the transfer post backstop remains effective. That shared preflight/promotion repair is queued. PR #47 and the open audit do not close a live capability.

### What §2 already has, and what remains

| Assignment requirement | Existing code/evidence | Remaining delivery |
| --- | --- | --- |
| Hosted sign-on; operator/password/branch; idle timeout | `config/app-profiles/meridian.json`, `config/policy-meridian.json`, `src/runtime/run.ts`; approved sign-on artifact | [Natural bad-login replay](../meridian/evidence/natural-bad-login/summary.json) is verified for shared-runtime/artifact scope; discovery/API login and idle-expiry acceptance remain open |
| Member inquiry by number/name and unambiguous selection | Approved inquiry artifact; #37 read acceptance | Retain number/name/ambiguous/not-found evidence; refresh after target reset |
| Member record with balances/share status | Approved record artifact; #37 read acceptance | Retain read baseline; never infer current funds from old evidence |
| Transfer: input → review → approved post | #39 comparators and guard; #43–#46 outcome/loader/review/approval repairs; draft discovery exists only in the preserved acceptance worktree | Execution Tasks 5c–5d: observed result extraction, genuine recording, reviewed promotion, separately approved replay |
| Open share: type/deposit → review → approved post | Profile route/form and parameter/output declarations exist | Execution Task 6: observe result, bind requested facts, record and accept |
| Contact update: email/phone/address → save | Profile and declarations exist | Execution Task 7: direct-save approval, bound read-back, record and accept |
| Supervisor hold with reason/notes; teller denial | Profile role guard and declarations exist | Execution Task 8: supervisor acceptance plus teller denial; no role escalation |
| Server-rendered tables/forms, hidden token and native submit | `src/surface/browser.ts`, `src/surface/guarded.ts`; existing real-browser regressions | Reuse; adapt only to observed target layout, never fabricated selectors |
| Six injected faults and natural errors | Profile detectors; exact-GET fault injection; read-only profile probes | Task B adds missing acceptance, not another injector; probes alone do not prove operation recovery |

The six-column transfer row, single-process runtime and separate PR boundaries are implementation decisions. Preserve request/result binding if observed HTML requires a smaller extractor change; explain the trade-off in the report rather than attributing those choices to the PDF.

## Integration prerequisite

- [x] PRs #37, #39, #41 and #43–#47 were reviewed and integrated in dependency order. Their source and producer gates are recorded above.
- [x] Confirmed `dev` at `2c7f4ed4577fe01bbfb441525b7cccc14128c46b` includes read acceptance, transfer protections, terminal lifecycle, insufficient-funds classification, CLI loader inspection, sibling review mapping, Terminal approval guidance and trusted evidence metadata.
- [x] Task A was implemented on its isolated branch and merged through PR #43. Its offline proof does not close live underfunded acceptance.

## Task A: Return insufficient funds as a terminal business result

**Delivered checkpoint:** Source `6ab82fe0cde9cc9dae64e5c69ca019753c42ad89` passed 131 focused and 274 full offline tests and merged through PR #43 as `4f84b9fbcb9b5a1fc09cd05611277b3357561728`. The historical implementation steps below are retained for traceability; their unchecked boxes are not current work and do not imply missing delivery. Live underfunded acceptance remains open.

**Files:**
- Modify `src/replay/outcomes.ts`: one fixed error type shared by the guard's validator and its callers.
- Modify `src/runtime/contracts.ts`: distinguish only the valid underfunded case in `assertTransferEligibility`.
- Modify `src/replay/executor.ts`: handle the typed error before generic recovery/escalation, after the existing uncertainty check.
- Modify `src/agent/loop.ts`: stop discovery on the typed business result without another model turn.
- Modify `cli.ts`: preserve the discovery business result in result JSON, console status and journal; do not produce an artifact.
- Test `test/meridian.test.ts`, `test/meridian-cli.test.ts` using their current fixtures.
- Update `docs/meridian/evaluation.md` and the insufficient-funds row in the execution plan with the resulting source SHA and passing evidence.

**Interfaces:**
- Consumes `assertTransferEligibility(expected: TransferFacts, actualMember: string, shares: TransferShare[]): void`, `runReplay(...): Promise<ReplayResult>` and `runDiscovery(...): Promise<DiscoveryResult>`.
- Produces `InsufficientFundsError` with fixed `outcomeCode: 'INSUFFICIENT_FUNDS'` and static safe detail. No values from the account or model enter its message.
- Replay retains the existing `ReplayResult` business branch. Discovery adds `business_outcome` to `status` with `outcomeCode?: string` and `detail?: string`; this branch always supplies both fields. `stopReason` retains the code for existing diagnostic consumers.
- Existing `InvocationService.get()` and journal states already support `business_outcome`; do not add another API envelope or status enum.
- Strict result files retain status/outcome code and omit detail through the existing `RunLogger.writeResult`. Keep that sanitization and the telemetry allowlist unchanged; the live API may expose the fixed safe detail.

- [ ] **Step 1: Add the failing validator regression.** Import `InsufficientFundsError` from `src/replay/outcomes.ts` into `test/meridian.test.ts`; put this inside the existing semantic-check describe block, where `request` and `rows` exist:

```ts
it('classifies only valid underfunding as insufficient funds', () => {
  expect(() => assertTransferEligibility(request, '9001', [
    { ...rows[0]!, balance: '0.99' }, rows[1]!,
  ])).toThrow(InsufficientFundsError);
  for (const balance of ['not-money', '']) {
    expect(() => assertTransferEligibility(request, '9001', [
      { ...rows[0]!, balance }, rows[1]!,
    ])).toThrow('Transfer facts failed validation');
  }
});
```

- [ ] **Step 2: Run red.** `npx vitest run test/meridian.test.ts -t 'classifies only valid underfunding'`. Initially the export is missing; after adding the error class, confirm the old generic validator still fails the typed expectation.
- [ ] **Step 3: Add the fixed error and change only the final funds comparison.** Keep all earlier identity, row, status and money validation unchanged.

```ts
// src/replay/outcomes.ts
export class InsufficientFundsError extends Error {
  readonly outcomeCode = 'INSUFFICIENT_FUNDS';
  constructor() {
    super('Insufficient available balance in the source share.');
    this.name = 'InsufficientFundsError';
  }
}

// src/runtime/contracts.ts: add import, replace final comparison
import { InsufficientFundsError } from '../replay/outcomes.js';
// Inside assertTransferEligibility, after both balances were validated:
if (sourceBalance < amount) throw new InsufficientFundsError();
```

- [ ] **Step 4: Add the replay/discovery boundary regression.** The following test uses the existing `transferArtifact`, `origin`, `policy`, `target` and `temp` definitions. This fixture intentionally throws at the runtime boundary; retain the real `GuardedSurface` eligibility tests as separate proof of where the exception originates.

```ts
it.each([false, true])('keeps funds outcome phase correct: intent=%s', async afterIntent => {
  const artifact = applyMeridianContract(transferArtifact());
  artifact.status = 'approved';
  artifact.steps = artifact.steps.filter(step => step.id === 'post');
  const params = { member: '9001', sourceShare: '9001-A', destinationShare: '9001-B',
    amount: '1.00', memo: 'fixture', operator: 'SUPER1', password: 'secret', branch: 'MAIN-001' };
  const report = { strategyUsed: 0, kind: 'nameAttr', matches: 1 } as const;
  const surface: Surface = {
    mutationDispatched: false,
    start: async () => {}, navigate: async () => {},
    currentUrl: () => `${origin}/members/9001`,
    frameUrls: () => [`${origin}/members/9001`],
    observe: async () => ({ url: `${origin}/members/9001`, title: '', frames: [] }),
    click: vi.fn(async () => {
      surface.mutationDispatched = afterIntent;
      throw new InsufficientFundsError();
    }),
    fill: async () => report, select: async () => report,
    readText: async () => ({ text: '', report }),
    isTextVisible: async () => false, describeTarget: async descriptor => descriptor,
    screenshot: async () => {}, close: async () => {},
  };
  const escalate = vi.fn(async () => 'abort' as const);
  const logger = new RunLogger('replay', new Redactor(), temp(), true);
  const replay = await runReplay(artifact, params, { surface, logger, policy, escalate });
  expect(replay).toMatchObject(afterIntent
    ? { status: 'failure', failure: { code: 'POST_OUTCOME_UNKNOWN' } }
    : { status: 'business_outcome', outcomeCode: 'INSUFFICIENT_FUNDS' });
  expect(JSON.parse(readFileSync(join(logger.dir, 'result.json'), 'utf8'))).toMatchObject(
    afterIntent ? { status: 'failure' } : { status: 'business_outcome', outcomeCode: 'INSUFFICIENT_FUNDS' });
  expect(surface.click).toHaveBeenCalledOnce();
  expect(escalate).not.toHaveBeenCalled();

  surface.mutationDispatched = false;
  vi.mocked(surface.click).mockClear();
  const create = vi.fn(async () => ({ choices: [{ message: {
    role: 'assistant', content: '', tool_calls: [{ id: 'funds-check', type: 'function',
      function: { name: 'click', arguments: JSON.stringify({ nameAttr: 'submit', reason: 'transfer', risk: 'irreversible' }) } }],
  } }] }));
  const openai = { chat: { completions: { create } } } as unknown as Parameters<typeof runDiscovery>[4]['openai'];
  const discovery = await runDiscovery('transfer', `${origin}/members/9001`, params, [origin], {
    surface, logger: new RunLogger('discovery', new Redactor(), temp(), true),
    openai, model: 'fixture', maxSteps: 3, escalate,
  });
  expect(discovery).toMatchObject(afterIntent
    ? { status: 'stopped', stopReason: 'POST_OUTCOME_UNKNOWN' }
    : { status: 'business_outcome', outcomeCode: 'INSUFFICIENT_FUNDS' });
  expect(create).toHaveBeenCalledOnce();
  expect(surface.click).toHaveBeenCalledOnce();
  expect(escalate).not.toHaveBeenCalled();
});
```

Inside the existing guarded-transfer describe block, add this real guard check using its local `request`, `eligibleRows` and `transferHarness`:

```ts
it('stops underfunding before any approval or mutation intent', async () => {
  const harness = transferHarness([{ ...eligibleRows[0]!, balance: '0.99' }, ...eligibleRows.slice(1)]);
  await harness.run.surface.start(`${origin}/members`);
  harness.setUrl(harness.memberUrl);
  harness.setLive({ url: harness.memberUrl, destination: harness.memberUrl,
    method: 'GET', control: 'Select member', submit: false, facts: {} });
  await expect(harness.run.surface.click(target)).rejects.toThrow(InsufficientFundsError);
  expect(harness.gate).not.toHaveBeenCalled();
  expect(harness.run.beforeDispatch).not.toHaveBeenCalled();
  expect(harness.run.surface.mutationDispatched).toBe(false);
});
```

- [ ] **Step 5: Run red.** `npx vitest run test/meridian.test.ts -t 'keeps funds outcome phase correct'`. The pre-intent case must fail on the current generic outcome; the post-intent expectation should already hold.
- [ ] **Step 6: Map the error in replay.** Import the error alongside outcome types. Insert this in `runStep`'s catch immediately after the existing `surface.mutationDispatched` early return, before `noteDialogs`, detectors, retry or escalation. Keep detector handling unchanged.

```ts
if (err instanceof InsufficientFundsError) {
  const result: ReplayResult = {
    status: 'business_outcome', outcomeCode: err.outcomeCode, detail: err.message, ...base,
  };
  logger.log('replay.business_outcome', { stepId: step.id, outcomeCode: err.outcomeCode });
  logger.writeResult(result);
  return result;
}
```

- [ ] **Step 7: Map the same error in discovery.** Import the error. Extend `DiscoveryResult.status` and add its optional fields as specified under Interfaces. Insert the following after the existing post-intent early return in the action catch, before incrementing failures or sending another model message:

```ts
if (err instanceof InsufficientFundsError) {
  return finish('business_outcome', err.outcomeCode, undefined, undefined,
    { outcomeCode: err.outcomeCode, detail: err.message });
}
```

Use these fields in the existing `DiscoveryResult` interface, retaining its other fields:

```ts
status: 'success' | 'escalated' | 'stopped' | 'business_outcome';
outcomeCode?: string;
detail?: string;
```

Replace the nested `finish` function with this version. Existing three-argument callers retain their behavior. A business result is terminal and never eligible for artifact recording.

```ts
function finish(
  status: DiscoveryResult['status'], stopReason?: string, summary?: string,
  finalUrl = surface.currentUrl(),
  outcome?: { outcomeCode: string; detail: string },
): DiscoveryResult {
  if (status === 'success') deps.validateCompletion?.(outputs);
  const result: DiscoveryResult = {
    status, trace, outputs, summary, finalUrl, stopReason, ...outcome,
  };
  logger.log('discovery.finish', { status, stopReason, outputs, steps: trace.length, ...outcome });
  return result;
}
```

Keep the existing four-argument startup exits that pass `entryUrl` as `finalUrl`, and retain the `classifies discovery startup denial before model or escalation` regression in `test/runtime-lifecycle.test.ts`. The new outcome parameter must not make startup cancellation or startup `POST_OUTCOME_UNKNOWN` call `surface.currentUrl()` before the surface starts.

- [ ] **Step 8: Extend the existing CLI discovery fixture, preserving its cleanup and validator assertions.** In `test/meridian-cli.test.ts`, replace that test's opening line with `it.each(['stopped', 'business_outcome'] as const)('supplies the canonical transfer completion validator to discovery: %s', async status => {`. Replace its mocked discovery return with:

```ts
return {
  status, trace: [], outputs: {}, finalUrl: 'https://web-sample.interface-hiring.com/members/9001',
  stopReason: status === 'business_outcome' ? 'INSUFFICIENT_FUNDS' : 'fixture',
  ...(status === 'business_outcome' ? {
    outcomeCode: 'INSUFFICIENT_FUNDS', detail: 'Insufficient available balance in the source share.',
  } : {}),
};
```

After the existing `runCli` invocation, inspect the real temporary journal/result:

```ts
const journalDir = join(dir, 'journal');
const records = readdirSync(journalDir).filter(name => name.endsWith('.json'))
  .map(name => JSON.parse(readFileSync(join(journalDir, name), 'utf8')).record);
expect(records).toHaveLength(1);
expect(records[0].state).toBe(status === 'business_outcome' ? 'business_outcome' : 'failure');
const result = JSON.parse(readFileSync(join(dir, records[0].runId, 'result.json'), 'utf8'));
expect(result.status).toBe(status);
expect(result).not.toHaveProperty('artifact');
if (status === 'business_outcome') {
  expect(result.outcomeCode).toBe('INSUFFICIENT_FUNDS');
  expect(process.exitCode ?? 0).toBe(0);
}
expect(existsSync(join(journalDir, 'server.lock'))).toBe(false);
```

- [ ] **Step 9: Run red.** `npx vitest run test/meridian-cli.test.ts -t 'supplies the canonical transfer completion validator'`. The business variant must fail on current journal/result handling.
- [ ] **Step 10: Preserve business outcomes at the CLI boundary.** Add this branch between discovery success and the existing failure branch:

```ts
} else if (result.status === 'business_outcome') {
  logger.writeResult({ status: result.status, outcomeCode: result.outcomeCode, detail: result.detail });
  console.log(`\nDiscovery outcome: ${result.outcomeCode}`);
} else {
```

Replace the existing discovery journal-update expression with:

```ts
updateJournal(journal, record?.runId, result.status === 'success' ? 'success'
  : dispatchIntent(journal, record?.runId, surface.mutationDispatched) ? 'POST_OUTCOME_UNKNOWN'
  : result.status === 'business_outcome' ? 'business_outcome' : 'failure');
```

Keep catch/finally cleanup, durable intent precedence and success-only artifact recording intact. Reuse the replay CLI and API's existing business-result presentation; no UI changes belong in this task.

- [ ] **Step 11: Run green and check the actual guard boundary.** Run `npx vitest run test/meridian.test.ts test/meridian-cli.test.ts`, including the real guard test from Step 4. The harmless member-selection GET may have occurred; do not label its dispatch spy count as a mutation POST count.
- [ ] **Step 12: Deliver one runtime PR.** Run `npm run ci`, `npm run validate` and `git diff --check`, commit only the listed source/tests/docs, and open the PR against `dev` titled `fix: report underfunded MERIDIAN transfers as business outcomes`. Record exact-head producer CI and review before normal integration. Do not claim live transfer acceptance from these offline tests.

## Task B: Finish §2 acceptance through the existing capability plan

**Files:** `docs/meridian/live-evidence.md`, `docs/meridian/evaluation.md`, `docs/meridian/runbook.md`, `docs/meridian/report.md`; capability artifacts, tests and minimal validators owned by execution Tasks 5c–8. Follow those tasks' exact file lists, commands and observation gates; this is their dependency and acceptance checklist, not a competing implementation.

**Interfaces:** Consumes the integrated #37/#39 runtime and Task A's business-result contract. Produces accepted artifact versions with discovery/replay IDs, source SHA, sanitized evidence, authoritative journal state, and separate intent/observed POST counts. Failed or unavailable acceptance remains explicitly incomplete.

- [ ] Execute [Task 5c](2026-09-04-meridian-superpowers.md#task-5c-resolve-provenance-review-the-exact-candidate-then-promote) and Task 5d in one transfer-capability PR. Preserve the old draft and evidence; record a genuine complete candidate, verify output binding against observed layout, promote only after review, then obtain a separate replay approval.
- [ ] Execute [Task 6](2026-09-04-meridian-superpowers.md#task-6-record-a-new-open-share-operation), [Task 7](2026-09-04-meridian-superpowers.md#task-7-record-contact-update-with-direct-save-review), and [Task 8](2026-09-04-meridian-superpowers.md#task-8-record-supervisor-hold-and-teller-denial), each in its own PR against `dev`. Their first observation gates determine the real result fields; no fabricated selector/code recipe substitutes for that observation.
- [ ] Complete the following matrix in the separate remaining-acceptance PR from execution Task 9. Reuse existing evidence where it establishes the listed behavior; do not repeat a post to obtain another checkbox.

| Case | Required acceptance / expected outcome |
| --- | --- |
| Natural bad login | Verified shared-runtime replay at source `2c7f4ed`: actual invalid-credentials rejection, terminal/journal failure, evaluator pass/task failure, six attempts, zero intents and zero member requests. [Sanitized summary](../meridian/evidence/natural-bad-login/summary.json). This does not establish discovery or HTTP API login acceptance. |
| Injected `validation` / 400 | Exact observed operation-entry GET, one-shot injection; pre-intent replay `VALIDATION_REJECTED` business result. A rejection visible only after mutation intent remains unknown. |
| Injected `notfound` / 404 and absent search member | `NO_SUCH_MEMBER` business result in replay; no alternate member selected. |
| Injected `permission` / 403 and natural teller hold | `PERMISSION_DENIED` or separately documented pre-intent rejection; no automatic supervisor login, approval or mutation. |
| Injected `timeout` / 440 and natural idle expiry | Controlled `SESSION_EXPIRED` stop before intent; no mid-flow login/retry. Record the natural timing rather than inventing a timeout duration. |
| Injected `maintenance` / 503 | One known pre-intent Continue recovery in the same browser; reverify the operation checkpoint. Reaching the menu alone is not success. |
| Injected `server` / 500 | Pre-intent `APPLICATION_ERROR`; post-intent unverified result remains unknown with no retry. |
| Natural insufficient funds | Fresh, valid member/share facts; Task A returns `business_outcome / INSUFFICIENT_FUNDS`, zero mutation intents/posts, no approval/retry. Verify the API result and terminal journal agree. |
| Natural invalid email/phone | Observe the target's actual validation; retain the pre-/post-intent distinction, with no claimed successful save. |
| Missing/stale token and unexpected dialog | Reuse existing token/dialog regressions; capture hosted evidence only when encountered. Client refusal is distinct from a server rejection after intent; neither warrants an automatic repeat. |

- [ ] Record each run's exact route, injection or natural trigger, discovery versus replay phase, terminal result, journal state, intent count, independently observed POST count, and verified business state. The global settings/random fault mode is not needed for deterministic acceptance; restore any deliberately changed target setting and never inject an unapproved POST.
- [x] Keep the PDF's business/recoverable/hard-failure distinction in the current 1–2 page checkpoint report and record exact commands plus labeled offline/recorded fallback through Task 9. Final integration of the independently authorized Vercel AI SDK/assistant-ui task may reuse accepted request identity and evidence after capability/runtime/API acceptance; it cannot create posting authority.

## Self-review and execution boundary

- All seven §2.1 functions and the six §2.2 injected faults have an owner above; natural bad login, funds/contact rejection, teller denial and idle expiry are explicit.
- Existing #34/#35/#37/#39 implementation is reused. Task A is delivered through #43, and CLI/review/approval/evidence-metadata repairs are delivered through #44–#47. Four write artifact/acceptance tasks remain open, so coverage is still 3/7.
- `InsufficientFundsError` is produced only after valid request/member/share/status/money checks. Both callers check dispatch uncertainty first. CLI, journal and result-file propagation are included, not merely the validator unit test.
- All snippets use existing interfaces or the fields introduced here. Hosted selectors and results remain observation-gated in their original tasks.
- This plan records the delivered Task A source and remaining execution. This documentation refresh does not promote an artifact, perform a live operation or close any unchecked live gate.
