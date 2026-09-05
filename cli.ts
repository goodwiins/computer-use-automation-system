// CLI entry points.
//   discover --goal "..." --name <capability> [--param k=v ...] [--sensitive k] [--entry URL] [--headful]
//   replay   --artifact <path> [--overlay <tenant overlay>] [--params '{"k":"v"}'] [--entry-override URL] [--attended] [--approve]
//   list     — catalog of saved capabilities (name, params, outputs)
//   validate — re-apply the current risk floor to every saved artifact; exit 1 on drift

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeLLMClient } from './src/agent/client.js';
import { createRuntime, operatorContext } from './src/runtime/run.js';
import { Journal, RequestError, validateIdempotencyKey, type JournalRecord } from './src/runtime/journal.js';
import { loadProfile, profilePolicy, FaultScenario } from './src/runtime/profile.js';
import { applyMeridianContract, assertTransferOutputs, meridianContracts, transferFactsFromParams } from './src/runtime/contracts.js';
import { serve } from './src/server/http.js';
import { runDiscovery } from './src/agent/loop.js';
import { RISK_RANK, recordArtifact, riskFloorFor } from './src/artifact/recorder.js';
import { applyOverlay, TenantOverlay } from './src/artifact/overlay.js';
import { assertSafeCapabilityName, promoteToApproved } from './src/artifact/promote.js';
import { CapabilityArtifact, Detector, normalizeParams, validateParams } from './src/artifact/schema.js';
import { OperatorConsole } from './src/escalation/operator.js';
import { originAllowed } from './src/safety/policy.js';
import { runReplay } from './src/replay/executor.js';
import type { ReplayResult } from './src/replay/outcomes.js';

const ARTIFACT_DIR = 'artifacts';

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const params: Record<string, string> = {};
  const sensitive: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const value = () => argv[++i] ?? fatal(`${a} requires a value`);
    if (a === '--param') {
      const [k, ...rest] = value().split('=');
      params[k!] = rest.join('=');
    } else if (a === '--sensitive') {
      sensitive.push(value());
    } else if (a.startsWith('--')) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = true;
      else flags[a.slice(2)] = argv[++i]!;
    }
  }
  return { flags, params, sensitive };
}

function fatal(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function updateJournal(journal: Journal | undefined, runId: string | undefined, state: JournalRecord['state']): void {
  if (!journal || !runId) return;
  const current = journal.records.get(runId)?.state;
  if (!current || !['reserved', 'running', 'dispatching'].includes(current)) return;
  try { journal.update(runId, state); } catch { process.exitCode = 1; }
}

function dispatchIntent(journal: Journal | undefined, runId: string | undefined, dispatched = false): boolean {
  return dispatched || (!!journal && !!runId && journal.records.get(runId)?.state === 'dispatching');
}

function replayFailure(runtime: ReturnType<typeof createRuntime>, uncertain: boolean): ReplayResult {
  return {
    status: 'failure',
    failure: {
      code: uncertain ? 'POST_OUTCOME_UNKNOWN' : 'RUN_FAILED',
      stepId: '(runtime)',
      intent: 'complete the replay',
      expected: 'a terminal replay result',
      observed: uncertain
        ? 'Posting may have occurred. Investigate with a separate read-only inquiry; do not retry.'
        : 'Replay failed before completion. Inspect safe run evidence.',
    },
    escalated: false,
    runId: runtime.logger.runId,
    evidenceDir: runtime.logger.dir,
    recoveries: [],
  };
}

function replayOutput(runtime: ReturnType<typeof createRuntime>, result: ReplayResult): unknown {
  if (runtime.logger.strict && result.status === 'failure') {
    return {
      status: 'failure',
      outcomeCode: undefined,
      sensitiveValuesUnavailable: true,
      failure: { code: result.failure.code ?? 'RUN_FAILED' },
    };
  }
  return runtime.redactor.redact(result);
}

async function closeRuntime(runtime: ReturnType<typeof createRuntime> | undefined): Promise<void> {
  if (!runtime) return;
  try { await runtime.close(); } catch { process.exitCode = 1; }
}

function closeJournal(journal: Journal | undefined): void {
  if (!journal) return;
  try { journal.close(); } catch { process.exitCode = 1; }
}

async function discover(argv: string[]) {
  const { flags, params: rawParams, sensitive } = parseArgs(argv);
  let params: Record<string, string | number> = rawParams;
  const goal = typeof flags.goal === 'string' ? flags.goal : fatal('--goal is required');
  const name = typeof flags.name === 'string' ? flags.name : fatal('--name is required (capability id)');
  const profile = loadProfile(typeof flags.profile === 'string' ? flags.profile : 'cu-nexus');
  const meridian = profile.appId === 'meridian';
  if (meridian) {
    if (!Object.hasOwn(meridianContracts, name)) fatal('Unknown MERIDIAN capability contract');
    if (['operator', 'password', 'branch'].some(parameter => Object.hasOwn(params, parameter))) fatal('Caller cannot override server parameters');
    const contract = meridianContracts[name as keyof typeof meridianContracts];
    if (!validateParams(contract, params).ok) fatal('Parameters do not match the capability contract');
    params = normalizeParams(contract, params);
  }
  assertSafeCapabilityName(name); // becomes a filename under artifacts/
  const entry = typeof flags.entry === 'string' ? flags.entry : profile.entryUrl ?? 'http://localhost:4173/';
  const { openai, model } = makeLLMClient();

  const policy = profilePolicy(profile);
  const key = typeof flags['idempotency-key'] === 'string' ? flags['idempotency-key'] : '';
  if (meridian) validateIdempotencyKey(key);
  const operator = meridian ? operatorContext(flags.operator === 'SUPERVISOR' ? 'SUPERVISOR' : 'TELLER') : undefined;
  const serverParams = operator ? ['operator', 'password', 'branch'] : [];
  for (const key of serverParams) params[key] = `{{${key}}}`;
  if (operator) sensitive.push('password');
  const expectedTransfer = meridian && name === 'meridian-funds-transfer' ? transferFactsFromParams(params) : undefined;
  if (meridian && name === 'meridian-funds-transfer' && !expectedTransfer) fatal('Parameters do not match the capability contract');
  const journal = meridian ? new Journal(join(process.env.EVIDENCE_DIR ?? 'evidence/meridian', 'journal'), process.env.JOURNAL_HMAC_KEY ?? '') : undefined;
  let record: JournalRecord | undefined;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let candidate: CapabilityArtifact | undefined;
  try {
    const request = { mode: 'discovery', name, goal, params, operator: operator && { operator: operator.operator, branch: operator.branch, role: operator.role } };
    if (journal) {
      const existing = journal.lookup('operator', key, request).existing;
      if (existing) { console.log(`Existing discovery run: ${existing.runId} (${existing.state})`); return; }
    }
    record = journal?.reserve('operator', key, name, '1.0.0', request, 'discovery');
    const headful = meridian || !!flags.headful;
    try {
      runtime = createRuntime({ kind: 'discovery', artifact: name, version: '1.0.0', policy, profile, params, sensitive, operator, headful,
        runId: record?.runId, evidenceDir: meridian ? process.env.EVIDENCE_DIR ?? 'evidence/meridian' : undefined,
        gate: async (action, risk, reason, context) => {
          if (!headful) return false;
          const decision = await new OperatorConsole(runtime!.browser.page, runtime!.logger, runtime!.session).intervene({
            kind: 'risk_approval', capability: name, goal, reason: context ? JSON.stringify(context) : reason, url: runtime!.surface.currentUrl(),
          });
          return decision === 'retry';
        }, beforeDispatch: () => journal!.update(record!.runId, 'dispatching'),
      });
      const { surface, browser, logger, session } = runtime;
      updateJournal(journal, record?.runId, 'running');
      console.log(`discovery run ${logger.runId} → ${logger.dir}`);
      const discoveryGoal = meridian && Object.hasOwn(meridianContracts, name) ? `${goal}\nRecord explicit fill operator, fill password, and select branch actions using server references before Sign On, even if the selected branch already matches. Add assertions and extract these required outputs: ${meridianContracts[name as keyof typeof meridianContracts].outputs.join(', ')}. Table outputs must use named columns. ${name === 'meridian-funds-transfer' ? 'The transaction output must declare exactly one row with canonical columns member, sourceShare, destinationShare, amount, memo, confirmation; use type money only for amount and type string for the other columns, and mark every output and column sensitive. Observe each column selector and header handling from this recording; do not invent them.' : ''} Never choose the first of ambiguous matches.` : goal;
      const result = await runDiscovery(discoveryGoal, entry, params, policy.allowedOrigins, {
        surface,
        logger,
        openai,
        model,
        maxSteps: policy.maxSteps,
        timeoutMs: policy.maxDiscoveryMs,
        boundParams: operator ? { operator: operator.operator, password: operator.password, branch: operator.branch } : undefined,
        sanitizeObservation: text => runtime!.promptRedactor.redactString(text),
        escalate: headful
          ? (req) => new OperatorConsole(browser.page, logger, session).intervene(req)
          : undefined,
        validateCompletion: expectedTransfer ? outputs => assertTransferOutputs(expectedTransfer, outputs) : undefined,
      });

      if (result.status === 'success') {
        let artifact = recordArtifact(
          {
            name,
            description: goal,
            goal,
            entryUrl: entry,
            params,
            sensitiveParams: sensitive,
            serverParams,
            allowedOrigins: policy.allowedOrigins,
            appId: profile.appId,
            appDetectors: profile.detectors.map((d: unknown) => Detector.parse(d)),
            model,
            discoveryRunId: logger.runId,
          },
          result,
        );
        candidate = artifact;
        if (meridian) artifact = applyMeridianContract(artifact);
        mkdirSync(ARTIFACT_DIR, { recursive: true });
        const path = join(ARTIFACT_DIR, `${name}.v${artifact.version}.json`);
        writeFileSync(path, JSON.stringify(artifact, null, 2));
        logger.writeResult({ status: 'success', artifact: path, outputs: result.outputs, summary: result.summary });
        console.log(`\n✔ goal achieved in ${result.trace.length} recorded steps`);
        console.log(`  outputs : ${JSON.stringify(runtime.redactor.redact(result.outputs))}`);
        console.log(`  artifact: ${path} (status: draft — review, then run with --approve to promote)`);
      } else if (result.status === 'business_outcome') {
        logger.writeResult({ status: result.status, outcomeCode: result.outcomeCode, detail: result.detail });
        console.log(`\nDiscovery outcome: ${result.outcomeCode}`);
      } else {
        const code = result.stopReason === 'RUN_ABORTED' || result.stopReason === 'POST_OUTCOME_UNKNOWN' ? result.stopReason : undefined;
        logger.writeResult(code ? { status: 'failure', failure: { code } } : { status: result.status });
        console.log(`\n✘ discovery ${result.status}: ${result.stopReason ?? ''}`);
        process.exitCode = 1;
      }
      updateJournal(journal, record?.runId, result.status === 'success' ? 'success'
        : dispatchIntent(journal, record?.runId, surface.mutationDispatched) ? 'POST_OUTCOME_UNKNOWN'
        : result.status === 'business_outcome' ? 'business_outcome' : 'failure');
    } catch {
      process.exitCode = 1;
      const uncertain = dispatchIntent(journal, record?.runId, runtime?.surface.mutationDispatched);
      if (runtime) {
        if (candidate) {
          try { writeFileSync(join(runtime.logger.dir, 'rejected-artifact.redacted.json'), JSON.stringify(runtime.redactor.redact(candidate), null, 2), { mode: 0o600 }); } catch { /* evidence is best effort */ }
        }
        try { runtime.logger.writeResult({ status: 'failure', failure: { code: uncertain ? 'POST_OUTCOME_UNKNOWN' : 'DISCOVERY_FAILED' } }); } catch { /* preserve journal and cleanup */ }
      }
      updateJournal(journal, record?.runId, uncertain ? 'POST_OUTCOME_UNKNOWN' : 'failure');
    } finally { await closeRuntime(runtime); }
  } finally { closeJournal(journal); }
}

async function replay(argv: string[]) {
  const { flags } = parseArgs(argv);
  const artifactPath = typeof flags.artifact === 'string' ? flags.artifact : fatal('--artifact is required');
  const rawArtifact = readFileSync(artifactPath, 'utf8');

  // Promotion always acts on the BASE artifact file. Refuse to combine it
  // with an overlay: writing a tenant-composed artifact back over the base
  // would corrupt the base (this used to be the actual behavior).
  if (flags.approve && flags.overlay) {
    fatal('Cannot combine --approve with --overlay — promote the base artifact by itself');
  }
  if (flags.approve) {
    writeFileSync(artifactPath, promoteToApproved(rawArtifact));
    console.log(`✔ promoted ${artifactPath} to approved`);
    return;
  }

  let artifact = CapabilityArtifact.parse(JSON.parse(rawArtifact));

  // Compose a tenant overlay onto the base (cross-tenant reuse): the base
  // file is never modified; the composed artifact carries overlay provenance.
  if (typeof flags.overlay === 'string') {
    const overlay = TenantOverlay.parse(JSON.parse(readFileSync(flags.overlay, 'utf8')));
    artifact = applyOverlay(artifact, overlay);
    console.log(`composed tenant overlay "${overlay.tenant}" onto ${overlay.base.id}@${overlay.base.version}`);
  }

  let params: Record<string, string | number> =
    typeof flags.params === 'string' ? JSON.parse(flags.params) : {};
  const profile = loadProfile(typeof flags.profile === 'string' ? flags.profile : artifact.app.appId === 'meridian' ? 'meridian' : 'cu-nexus');
  const policy = profilePolicy(profile);
  if (typeof flags['entry-override'] === 'string') {
    // For demos: point the same capability at an entry URL that injects a
    // simulated runtime condition (e.g. ?sim=maintenance). Still has to land
    // inside both the artifact's and the policy's allowed origins.
    const override = flags['entry-override'];
    if (!originAllowed(artifact.app.allowedOrigins, override) || !originAllowed(policy.allowedOrigins, override)) {
      fatal(`--entry-override ${override} is outside the artifact's or policy's allowed origins`);
    }
    artifact.app.entryUrl = override;
  }
  // Overlay paramDefaults fill in under the caller's params — runReplay merges
  // them the same way. A sensitive value arriving from a default must reach the
  // redactor too, or it lands unmasked in the log, the result and screenshots.
  const meridian = profile.appId === 'meridian';
  const key = typeof flags['idempotency-key'] === 'string' ? flags['idempotency-key'] : '';
  if (meridian) validateIdempotencyKey(key);
  if ((artifact.app.appId === 'meridian') !== meridian) fatal('Artifact and runtime profile do not match');
  if (meridian) artifact = applyMeridianContract(artifact);
  const operator = meridian ? operatorContext(flags.operator === 'SUPERVISOR' ? 'SUPERVISOR' : 'TELLER') : undefined;
  for (const parameter of artifact.parameters.filter(p => p.source === 'server')) {
    if (parameter.name in params) fatal('Caller cannot override server parameters');
    if (!operator || !['operator', 'password', 'branch'].includes(parameter.name)) fatal('Unsupported server parameter');
    params[parameter.name] = operator[parameter.name as 'operator' | 'password' | 'branch'];
  }
  if (meridian) params = normalizeParams(artifact, params);
  const fault = flags.inject || flags['fault-route'] ? FaultScenario.parse({ kind: flags.inject, path: flags['fault-route'] }) : undefined;
  if (fault && !meridian) fatal('Fault scenarios require the MERIDIAN profile');
  const request = { mode: 'replay', fault: fault ?? null, id: artifact.id, version: artifact.version, params: Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'password')), role: operator?.role ?? null };
  const journal = meridian ? new Journal(join(process.env.EVIDENCE_DIR ?? 'evidence/meridian', 'journal'), process.env.JOURNAL_HMAC_KEY ?? '') : undefined;
  let record: JournalRecord | undefined;
  let runtime: ReturnType<typeof createRuntime> | undefined;
  try {
    if (journal) {
      const existing = journal.lookup('operator', key, request).existing;
      if (existing) { console.log(`Existing run: ${existing.runId} (${existing.state})`); return; }
    }
    record = journal?.reserve('operator', key, artifact.id, artifact.version, request);
    const attended = !!flags.attended;
    try {
      runtime = createRuntime({ kind: 'replay', artifact: artifact.id, version: artifact.version, policy, profile, fault, params: { ...artifact.paramDefaults, ...params },
        sensitive: artifact.parameters.filter(p => p.sensitive).map(p => p.name), operator, headful: meridian || attended || !!flags.headful,
        runId: record?.runId, evidenceDir: meridian ? process.env.EVIDENCE_DIR ?? 'evidence/meridian' : undefined,
        gate: async (action, risk, reason, context) => {
          if (!attended) return false;
          const decision = await new OperatorConsole(runtime!.browser.page, runtime!.logger, runtime!.session).intervene({
            kind: 'risk_approval', capability: artifact.id, goal: artifact.description, reason: context ? JSON.stringify(context) : reason, url: runtime!.surface.currentUrl(),
          });
          return decision === 'retry';
        }, beforeDispatch: () => journal!.update(record!.runId, 'dispatching'),
      });
      console.log(`replay run ${runtime.logger.runId} → ${runtime.logger.dir}`);
      updateJournal(journal, record?.runId, 'running');
      const result = await runReplay(artifact, params, { surface: runtime.surface, logger: runtime.logger, policy,
        escalate: attended ? req => new OperatorConsole(runtime!.browser.page, runtime!.logger, runtime!.session).intervene(req) : undefined });
      const uncertain = dispatchIntent(journal, record?.runId, runtime.surface.mutationDispatched);
      const output = result.status === 'failure' && uncertain && result.failure.code !== 'POST_OUTCOME_UNKNOWN'
        ? { ...result, failure: { ...result.failure, code: 'POST_OUTCOME_UNKNOWN', observed: 'Posting may have occurred. Investigate with a separate read-only inquiry; do not retry.' } }
        : result;
      if (output !== result || (runtime.logger.strict && output.status === 'failure')) runtime.logger.writeResult(output);
      console.log(JSON.stringify(replayOutput(runtime, output), null, 2));
      if (output.status === 'failure') process.exitCode = 1;
      updateJournal(journal, record?.runId, output.status === 'failure' && uncertain ? 'POST_OUTCOME_UNKNOWN' : output.status);
    } catch {
      process.exitCode = 1;
      const uncertain = dispatchIntent(journal, record?.runId, runtime?.surface.mutationDispatched);
      if (runtime) {
        const result = replayFailure(runtime, uncertain);
        try { runtime.logger.writeResult(result); } catch { /* preserve journal and cleanup */ }
        try { console.log(JSON.stringify(replayOutput(runtime, result), null, 2)); } catch { /* preserve exit status */ }
      }
      updateJournal(journal, record?.runId, uncertain ? 'POST_OUTCOME_UNKNOWN' : 'failure');
    } finally { await closeRuntime(runtime); }
  } finally { closeJournal(journal); }
}

function list() {
  let files: string[] = [];
  try {
    files = readdirSync(ARTIFACT_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    /* no artifacts yet */
  }
  if (files.length === 0) return void console.log('No capabilities recorded yet.');
  console.log('Capability catalog:\n');
  for (const f of files) {
    let a;
    try {
      a = CapabilityArtifact.parse(JSON.parse(readFileSync(join(ARTIFACT_DIR, f), 'utf8')));
    } catch (e) {
      // One bad file must not hide the rest of the catalog.
      console.log(`  ${f}: unreadable — ${(e as Error).message.split('\n')[0]}\n`);
      continue;
    }
    const params = a.parameters.map((p) => `${p.name}: ${p.type}${p.sensitive ? ' (sensitive)' : ''}`).join(', ');
    const outputs = a.outputs.map((o) => `${o.name}: ${o.type}`).join(', ');
    console.log(`  ${a.id}@${a.version} [${a.status}]`);
    console.log(`    ${a.description}`);
    console.log(`    params : (${params || 'none'})`);
    console.log(`    returns: (${outputs || 'none'})`);
    console.log(`    file   : ${join(ARTIFACT_DIR, f)}\n`);
  }
}

/**
 * Approved artifacts on disk are not re-checked when the recorder's risk
 * rules tighten. Re-apply the current floor to every step and fail on drift,
 * so CI catches a step that is now labeled below what its element implies.
 */
function validate() {
  let drift = 0;
  for (const f of readdirSync(ARTIFACT_DIR).filter((f) => f.endsWith('.json'))) {
    const a = CapabilityArtifact.parse(JSON.parse(readFileSync(join(ARTIFACT_DIR, f), 'utf8')));
    if (a.app.appId === 'meridian') applyMeridianContract(a);
    for (const s of a.steps) {
      const floor = s.target && riskFloorFor(s.target);
      if (floor && RISK_RANK[s.risk] < RISK_RANK[floor]) {
        console.log(`${f}: step ${s.id} is labeled ${s.risk}; current floor is ${floor}`);
        drift++;
      }
    }
  }
  console.log(drift ? `${drift} step(s) below the current risk floor` : 'All artifacts satisfy the current risk floor.');
  if (drift) process.exit(1);
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const [cmd, ...rest] = argv;
  try {
    if (cmd === 'serve') { const { flags } = parseArgs(rest); await serve(typeof flags.profile === 'string' ? flags.profile : 'meridian'); }
    else if (cmd === 'discover') await discover(rest);
    else if (cmd === 'replay') await replay(rest);
    else if (cmd === 'list') list();
    else if (cmd === 'validate') validate();
    else {
      console.log('usage: cli.ts <discover|replay|list|validate|serve> [flags]');
      process.exit(1);
    }
  } catch (error) {
    console.error(error instanceof RequestError ? `error: ${error.message}` : 'error: Request failed; inspect safe run evidence or server configuration');
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runCli();
