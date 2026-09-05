# Discovery contract implementation report

Base: `2c7f4ed4577fe01bbfb441525b7cccc14128c46b`

## Result

- MERIDIAN discovery now resolves a canonical contract and validates and normalizes only its caller-owned public parameters before model creation, operator secret lookup, journal construction/reservation, runtime creation, or discovery. Unknown capabilities, invalid/missing/extra fields, and server-owned parameter attempts produce static CLI errors without echoing caller values.
- `createRuntime` refuses an incomplete `meridian-funds-transfer` binding before redactors, logger/evidence, session, timer, or browser allocation. A successfully preflighted CLI transfer continues to install `assertTransferOutputs` as its discovery completion validator.
- `applyMeridianContract` now requires exact incoming public declaration names and an executable template reference for every required public parameter before it replaces declarations with canonical metadata. Metadata and ignored properties do not count. Promotion inherits this check through its existing call to `applyMeridianContract`.
- Legacy cu-nexus discovery and replay/API validation paths are unchanged. The three approved schema-v2 MERIDIAN v1.0.0 artifacts remain unmodified and validate successfully. The existing pre-dispatch missing-transfer backstop remains green; no live target or mutation was used.

## Caller trace

- Discovery: `cli.ts:106-133` now performs canonical public preflight; journal construction starts at `cli.ts:133`, runtime creation at `cli.ts:146`, and discovery at `cli.ts:160`.
- Replay/API: CLI replay still applies the contract and normalizes before runtime (`cli.ts:276-298`); `InvocationService.invoke` still validates and normalizes public arguments before runtime (`src/server/service.ts:37-78`); `runReplay` retains its own preflight (`src/replay/executor.ts:50-78`).
- Transfer binding: callers are discovery (`cli.ts:131`), runtime construction (`src/runtime/run.ts:30`), and deterministic replay (`src/replay/executor.ts:54`). Runtime construction is now the allocation backstop.
- Contract application: discovery, CLI replay/validation, promotion, and service artifact loading all route through `applyMeridianContract`.
- Executable template fields match replay resolution: entry URL; navigate URL; click/fill/select/extract target role/text/CSS strategies; fill/select value; assert text/URL pattern; extract pattern; and the success condition. Descriptions, intents, snapshots, name attributes, detector metadata, and unrelated step properties are not replay-bound and do not satisfy the check.

## RED

Command:

```sh
npx vitest run test/meridian-cli.test.ts test/meridian.test.ts -t "invalid canonical discovery inputs|public parameter declarations|metadata is the only reference|incomplete canonical transfer"
```

Before the production repair: exit 1; 6 failed. Canonical discovery continued instead of rejecting, missing/duplicate/extra declarations and metadata-only binding were accepted, and direct incomplete transfer runtime construction reached allocation code.

The audit compiler counterexample also reproduced before the repair. With the repair applied, its old positive-exploit assertion exits 1 at `applyMeridianContract` with `Recording parameters must exactly match the meridian-open-share contract`, proving the previously accepted literal-deposit artifact is rejected.

## GREEN

```sh
npx vitest run test/meridian-cli.test.ts test/meridian.test.ts test/meridian-artifacts.test.ts test/schema.test.ts test/promote.test.ts test/recorder.test.ts test/runtime-lifecycle.test.ts
```

Exit 0: 7 files, 193 tests passed.

```sh
npm run typecheck
```

Exit 0.

```sh
npm run validate
```

Exit 0: `All artifacts satisfy the current risk floor.`

```sh
git diff --check
```

Exit 0.

The audit probe `still blocks a transfer post when the transfer binding is absent` remains green (1 passed). Its incomplete-discovery case now observes `runtimeStarted: false` and `discoveryStarted: false`; the probe still expects a thrown `runCli` rejection, while the established CLI boundary catches errors and reports `process.exitCode = 1`. The committed CLI regression asserts that actual contract and also verifies no model, journal, runtime, or discovery call.

## Scoped review round 1

The initial guards keyed only on the capability ID and incorrectly rejected a legacy cu-nexus capability named `meridian-funds-transfer`. Both refusals are now gated by `profile.appId === 'meridian'`; the MERIDIAN runtime refusal remains before redactor, logger, session, timer, and browser allocation.

RED:

```sh
npx vitest run test/meridian-cli.test.ts test/meridian.test.ts -t "cu-nexus.*capability ID"
```

Exit 1 before the profile-scope fix: 2 tests failed. The cu-nexus CLI never reached runtime construction, and direct cu-nexus runtime construction threw the canonical MERIDIAN transfer error.

GREEN:

```sh
npx vitest run test/meridian-cli.test.ts test/meridian.test.ts -t "cu-nexus.*capability ID|incomplete canonical transfer"
```

Exit 0: 3 tests passed. The colliding cu-nexus CLI reaches generic runtime construction, direct cu-nexus construction succeeds and closes without launching a browser, and incomplete MERIDIAN transfer still refuses before evidence allocation.

```sh
npx vitest run test/meridian-cli.test.ts test/meridian.test.ts test/meridian-artifacts.test.ts test/schema.test.ts test/promote.test.ts test/recorder.test.ts test/runtime-lifecycle.test.ts
```

Exit 0: 7 files, 195 tests passed.

`npm run typecheck` and `git diff --check` both exited 0.

## Whole-branch final-review fix

The executable-reference collector now counts `extract.pattern` only for scalar extraction. When `extract.columns` exists, replay calls `readTable` and ignores the pattern, so that property can no longer rescue an otherwise unbound canonical input.

RED:

```sh
npx vitest run test/meridian.test.ts -t "table extraction pattern|scalar extraction pattern"
```

Exit 1 before the repair: the ignored table-pattern rejection failed while the scalar-pattern positive control passed.

GREEN:

```sh
npx vitest run test/meridian.test.ts -t "table extraction pattern|scalar extraction pattern"
```

Exit 0: 2 tests passed. Both direct `applyMeridianContract` and `promoteToApproved` reject the in-memory genuine member-record clone whose only `member` reference is an ignored table pattern; a scalar extraction pattern remains accepted. No approved artifact was modified.

```sh
npx vitest run test/meridian-cli.test.ts test/meridian.test.ts test/meridian-artifacts.test.ts test/schema.test.ts test/promote.test.ts test/recorder.test.ts test/runtime-lifecycle.test.ts
```

Exit 0: 7 files, 197 tests passed.

`npm run typecheck` and `git diff --check` both exited 0.
