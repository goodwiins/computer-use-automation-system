// CLI entry points.
//   discover --goal "..." --name <capability> [--param k=v ...] [--sensitive k] [--entry URL] [--headful]
//   replay   --artifact <path> [--params '{"k":"v"}'] [--entry-override URL] [--attended] [--approve]
//   list     — catalog of saved capabilities (name, params, outputs)

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import OpenAI, { AzureOpenAI } from 'openai';
import { runDiscovery } from './src/agent/loop.js';
import { newRunId, recordArtifact } from './src/artifact/recorder.js';
import { CapabilityArtifact, Detector } from './src/artifact/schema.js';
import { OperatorConsole } from './src/escalation/operator.js';
import { ControlSession } from './src/escalation/session.js';
import { RunLogger } from './src/evidence/logger.js';
import { loadPolicy } from './src/safety/policy.js';
import { Redactor } from './src/safety/redact.js';
import { runReplay } from './src/replay/executor.js';
import { originAllowed } from './src/safety/policy.js';
import { BrowserSurface } from './src/surface/browser.js';
import { GuardedSurface, type HumanGate } from './src/surface/guarded.js';

const ARTIFACT_DIR = 'artifacts';
const APP_PROFILE = 'config/app-profiles/cu-nexus.json';
const POLICY_PATH = process.env.POLICY_PATH ?? 'config/policy.json';

function parseArgs(argv: string[]) {
  const flags: Record<string, string | boolean> = {};
  const params: Record<string, string> = {};
  const sensitive: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--param') {
      const [k, ...rest] = argv[++i]!.split('=');
      params[k!] = rest.join('=');
    } else if (a === '--sensitive') {
      sensitive.push(argv[++i]!);
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

/**
 * Discovery-model client. Azure OpenAI when AZURE_OPENAI_ENDPOINT is set,
 * plain OpenAI otherwise. Both speak the same chat-completions + tools API,
 * so the agent loop is provider-agnostic.
 */
function makeLLMClient(): { openai: OpenAI; model: string } {
  if (process.env.AZURE_OPENAI_ENDPOINT) {
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT ?? fatal('AZURE_OPENAI_DEPLOYMENT is not set');
    if (!process.env.AZURE_OPENAI_API_KEY) fatal('AZURE_OPENAI_API_KEY is not set');
    return {
      openai: new AzureOpenAI({
        endpoint: process.env.AZURE_OPENAI_ENDPOINT,
        apiKey: process.env.AZURE_OPENAI_API_KEY,
        apiVersion: process.env.AZURE_OPENAI_API_VERSION ?? '2024-10-21',
        deployment,
      }),
      model: deployment,
    };
  }
  if (!process.env.OPENAI_API_KEY) {
    fatal('No LLM credentials: set AZURE_OPENAI_ENDPOINT/_API_KEY/_DEPLOYMENT, or OPENAI_API_KEY');
  }
  return { openai: new OpenAI(), model: process.env.OPENAI_MODEL ?? 'gpt-5.6-luna' };
}

async function discover(argv: string[]) {
  const { flags, params, sensitive } = parseArgs(argv);
  const goal = typeof flags.goal === 'string' ? flags.goal : fatal('--goal is required');
  const name = typeof flags.name === 'string' ? flags.name : fatal('--name is required (capability id)');
  const entry = typeof flags.entry === 'string' ? flags.entry : 'http://localhost:4173/';
  const { openai, model } = makeLLMClient();

  const policy = loadPolicy(POLICY_PATH);
  const redactor = new Redactor();
  redactor.addSensitiveValues(sensitive.map((k) => params[k]).filter((v): v is string => !!v));
  const logger = new RunLogger('discovery', redactor);
  console.log(`discovery run ${logger.runId} → ${logger.dir}`);

  const headful = !!flags.headful;
  const browser = new BrowserSurface({ headful });
  const session = new ControlSession((t) => logger.log('control.transfer', t));
  // During discovery risky actions are never auto-approved; the model is told
  // to call escalate instead, which routes through the operator when headful.
  const humanGate: HumanGate = async (action, risk, reason) => {
    logger.log('policy.human_gate', { action, risk, reason, attended: headful, approved: false });
    return false;
  };
  const surface = new GuardedSurface(browser, policy, humanGate, (e) => logger.log('policy.decision', e));

  const result = await runDiscovery(goal, entry, params, policy.allowedOrigins, {
    surface,
    logger,
    openai,
    model,
    maxSteps: policy.maxSteps,
    escalate: headful
      ? (req) => new OperatorConsole(browser.page, logger, session).intervene(req)
      : undefined,
  });

  if (result.status === 'success') {
    const profile = JSON.parse(readFileSync(APP_PROFILE, 'utf8'));
    const artifact = recordArtifact(
      {
        name,
        description: goal,
        goal,
        entryUrl: entry,
        params,
        sensitiveParams: sensitive,
        allowedOrigins: policy.allowedOrigins,
        appId: profile.appId,
        appDetectors: profile.detectors.map((d: unknown) => Detector.parse(d)),
        model,
        discoveryRunId: logger.runId,
      },
      result,
    );
    mkdirSync(ARTIFACT_DIR, { recursive: true });
    const path = join(ARTIFACT_DIR, `${name}.v${artifact.version}.json`);
    writeFileSync(path, JSON.stringify(artifact, null, 2));
    logger.writeResult({ status: 'success', artifact: path, outputs: result.outputs, summary: result.summary });
    console.log(`\n✔ goal achieved in ${result.trace.length} recorded steps`);
    console.log(`  outputs : ${JSON.stringify(result.outputs)}`);
    console.log(`  artifact: ${path} (status: draft — review, then run with --approve to promote)`);
  } else {
    logger.writeResult({ status: result.status, stopReason: result.stopReason });
    console.log(`\n✘ discovery ${result.status}: ${result.stopReason ?? ''}`);
    process.exitCode = 1;
  }
  await surface.close();
}

async function replay(argv: string[]) {
  const { flags } = parseArgs(argv);
  const artifactPath = typeof flags.artifact === 'string' ? flags.artifact : fatal('--artifact is required');
  const artifact = CapabilityArtifact.parse(JSON.parse(readFileSync(artifactPath, 'utf8')));

  if (flags.approve) {
    artifact.status = 'approved';
    writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
    console.log(`✔ ${artifact.id}@${artifact.version} promoted to approved`);
    return;
  }

  const params: Record<string, string | number> =
    typeof flags.params === 'string' ? JSON.parse(flags.params) : {};
  const policy = loadPolicy(POLICY_PATH);
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
  const redactor = new Redactor();
  redactor.addSensitiveValues(
    artifact.parameters.filter((p) => p.sensitive).map((p) => params[p.name] ?? '').filter(Boolean),
  );
  const logger = new RunLogger('replay', redactor);
  console.log(`replay run ${logger.runId} → ${logger.dir}`);

  const attended = !!flags.attended;
  // Attended runs show the live window locally — unless the session is being
  // exposed over CDP (CU_CDP_PORT), where the operator attaches remotely.
  const browser = new BrowserSurface({ headful: (attended && !process.env.CU_CDP_PORT) || !!flags.headful });
  const session = new ControlSession((t) => logger.log('control.transfer', t));
  const humanGate: HumanGate = async (action, risk, reason) => {
    if (!attended) {
      logger.log('policy.human_gate', { action, risk, reason, attended, approved: false });
      return false;
    }
    const decision = await new OperatorConsole(browser.page, logger, session).intervene({
      kind: 'risk_approval',
      capability: `${artifact.id}@${artifact.version}`,
      goal: artifact.description,
      reason: `${reason} (action: ${action})`,
      url: browser.currentUrl(),
    });
    return decision !== 'abort';
  };
  const surface = new GuardedSurface(browser, policy, humanGate, (e) => logger.log('policy.decision', e));

  const result = await runReplay(artifact, params, {
    surface,
    logger,
    policy,
    escalate: attended
      ? (req) => new OperatorConsole(browser.page, logger, session).intervene(req)
      : undefined,
  });

  console.log('\nresult:');
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'failure') process.exitCode = 1;
  await surface.close();
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
    const a = CapabilityArtifact.parse(JSON.parse(readFileSync(join(ARTIFACT_DIR, f), 'utf8')));
    const params = a.parameters.map((p) => `${p.name}: ${p.type}${p.sensitive ? ' (sensitive)' : ''}`).join(', ');
    const outputs = a.outputs.map((o) => `${o.name}: ${o.type}`).join(', ');
    console.log(`  ${a.id}@${a.version} [${a.status}]`);
    console.log(`    ${a.description}`);
    console.log(`    params : (${params || 'none'})`);
    console.log(`    returns: (${outputs || 'none'})`);
    console.log(`    file   : ${join(ARTIFACT_DIR, f)}\n`);
  }
}

const [cmd, ...rest] = process.argv.slice(2);
if (cmd === 'discover') await discover(rest);
else if (cmd === 'replay') await replay(rest);
else if (cmd === 'list') list();
else {
  console.log('usage: cli.ts <discover|replay|list> [flags]');
  process.exit(1);
}
