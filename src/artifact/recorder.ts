// Turns a successful discovery trace into a capability artifact. Two jobs:
//  1. Parameterization: every occurrence of an invocation parameter's concrete
//     value (in URLs, filled values, the success condition) becomes a
//     {{param}} template — so no runtime data is baked into the artifact and
//     the capability is genuinely reusable.
//  2. Contract synthesis: extracts become declared outputs; the final URL
//     becomes the success condition; each step keeps the model's stated
//     intent so a reviewer can audit what the capability does and why.

import type { DiscoveryResult } from '../agent/loop.js';
import { CapabilityArtifact, type Detector, type Parameter, type Step } from './schema.js';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const RISK_RANK: Record<Step['risk'], number> = { read: 0, reversible_write: 1, irreversible: 2 };

// Commit-shaped control text implies a risk floor regardless of what the
// model claimed — a downlabeled irreversible click would sail through the
// policy gate unattended.
const IRREVERSIBLE_TEXT_RE =
  /\b(open account|open a|commit|finalize|confirm (?:the )?(?:transfer|order|payment)|delete|remove|approve|post(?:ing)? the|submit transfer|pay now)\b/i;
const SUBMIT_ROLE_RE = /^(button|submit)$/;

/**
 * Risk floor implied by the element itself (from the discovery snapshot).
 * Returns null when the element implies nothing beyond a read (e.g. links).
 */
export function riskFloorFor(descriptor: { snapshot?: { tag?: string; role?: string; text?: string } }): Step['risk'] | null {
  const snap = descriptor.snapshot;
  if (!snap) return null;
  const isButtonish = snap.tag === 'button' || SUBMIT_ROLE_RE.test(snap.role ?? '') ||
    (snap.tag === 'input' && SUBMIT_ROLE_RE.test(snap.role ?? ''));
  if (!isButtonish) return null;
  if (IRREVERSIBLE_TEXT_RE.test(snap.text ?? '')) return 'irreversible';
  return 'reversible_write';
}

function floorRisk(modelRisk: Step['risk'], descriptor: { snapshot?: { tag?: string; role?: string; text?: string } }): Step['risk'] {
  const floor = riskFloorFor(descriptor);
  if (!floor) return modelRisk;
  return RISK_RANK[modelRisk] >= RISK_RANK[floor] ? modelRisk : floor;
}

export interface RecorderInput {
  name: string;
  description: string;
  goal: string;
  entryUrl: string;
  params: Record<string, string | number>;
  sensitiveParams: string[];
  allowedOrigins: string[];
  appId: string;
  appDetectors: Detector[];
  model: string;
  discoveryRunId: string;
}

export function recordArtifact(input: RecorderInput, discovery: DiscoveryResult): CapabilityArtifact {
  if (discovery.status !== 'success') {
    throw new Error(`Cannot record artifact from a ${discovery.status} discovery run`);
  }

  // Longer values substitute first so overlapping params can't corrupt each other.
  const paramEntries = Object.entries(input.params).sort(
    (a, b) => String(b[1]).length - String(a[1]).length,
  );
  const substitute = (s: string, entries: typeof paramEntries): string => {
    let out = s;
    for (const [name, value] of entries) out = out.split(String(value)).join(`{{${name}}}`);
    return out;
  };
  const templatize = (s: string): string => substitute(s, paramEntries);

  // CSS selectors are the one place a param value collides with *syntax*: the
  // discovery prompt asks for `td:nth-of-type(4)`-style anchors, so a 1-3 char
  // param ("4", "12") templatizes a structural literal and silently re-aims the
  // selector at another cell on the next replay. Same threshold the redactor
  // uses for the same reason (redact.ts MIN_SUBSTRING_LEN), opposite handling:
  // there a short value is matched as a whole token, here there is no token
  // boundary to lean on — `(4)` looks like one — so short values are left
  // literal. That trades a silent wrong-cell read for a loud resolution
  // failure. A *sensitive* short value (a PIN) is the one case with nothing
  // safe to do: it must not be persisted literal and cannot be templatized
  // safely, so recording refuses rather than writing the secret into the artifact.
  const MIN_CSS_PARAM_LEN = 4;
  const templatizeCss = (s: string): string => {
    for (const [name, value] of paramEntries) {
      const v = String(value);
      if (v.length < MIN_CSS_PARAM_LEN && v.length > 0 && input.sensitiveParams.includes(name) && s.includes(v)) {
        throw new Error(
          `Cannot record artifact: sensitive parameter "${name}" is too short to templatize safely and appears literally in css selector "${s}"`,
        );
      }
    }
    return substitute(s, paramEntries.filter(([, v]) => String(v).length >= MIN_CSS_PARAM_LEN));
  };

  const parameters: Parameter[] = Object.entries(input.params).map(([name, value]) => ({
    name,
    type: typeof value === 'number' ? 'number' : 'string',
    description: `Invocation parameter "${name}"`,
    required: true,
    sensitive: input.sensitiveParams.includes(name),
  }));

  const steps: Step[] = discovery.trace.map((entry, i) => {
    const id = `s${i + 1}`;
    switch (entry.action) {
      case 'navigate':
        return { id, intent: templatize(entry.reason), action: 'navigate', url: templatize(entry.url!), risk: 'read', timeoutMs: 10_000 };
      case 'click':
        return { id, intent: templatize(entry.reason), action: 'click', target: entry.descriptor!, risk: floorRisk(entry.risk ?? 'read', entry.descriptor!), timeoutMs: 10_000 };
      case 'fill':
        return { id, intent: templatize(entry.reason), action: 'fill', target: entry.descriptor!, value: templatize(entry.value!), risk: 'reversible_write', timeoutMs: 10_000 };
      case 'select':
        return { id, intent: templatize(entry.reason), action: 'select', target: entry.descriptor!, value: templatize(entry.value!), risk: 'reversible_write', timeoutMs: 10_000 };
      case 'extract':
        return { id, intent: templatize(entry.reason), action: 'extract', target: entry.descriptor!, extract: { output: entry.outputName! }, risk: 'read', timeoutMs: 10_000 };
    }
  });

  // Click targets whose text was a parameter value (e.g. a search-result link
  // showing the member number) also need templating.
  for (const step of steps) {
    if (!step.target) continue;
    step.target = {
      ...step.target,
      description: templatize(step.target.description),
      strategies: step.target.strategies.map((s) => {
        if (s.kind === 'text') return { ...s, text: templatize(s.text) };
        if (s.kind === 'role') return { ...s, name: templatize(s.name) };
        // css too: the model is told to anchor table selectors on a row label
        // (tools.ts), so a param value can end up inside the selector. Replay
        // already resolves templates in css (schema.resolveTarget) — without
        // this the runtime value would be persisted into the artifact.
        if (s.kind === 'css') return { ...s, selector: templatizeCss(s.selector) };
        return s;
      }),
      snapshot: step.target.snapshot && {
        ...step.target.snapshot,
        text: step.target.snapshot.text && templatize(step.target.snapshot.text),
      },
    };
  }

  // Success condition: the flow verifiably ended where discovery ended.
  const finalPath = new URL(discovery.finalUrl).pathname;
  const successCondition = {
    kind: 'urlMatches' as const,
    pattern: `${escapeRegex(templatize(finalPath)).replace(/\\\{\\\{(\w+)\\\}\\\}/g, '{{$1}}')}$`,
  };

  // Find which step extracted each output, for a description that carries no
  // observed values (PII may have been extracted during discovery).
  const outputStepId = (name: string): string =>
    steps.find((s) => s.action === 'extract' && s.extract?.output === name)?.id ?? '?';
  const outputs = Object.keys(discovery.outputs).map((name) => ({
    name,
    type: 'string' as const,
    description: `Extracted during the flow at step ${outputStepId(name)}`,
  }));

  return CapabilityArtifact.parse({
    schemaVersion: 1,
    id: input.name,
    name: input.name,
    description: templatize(input.goal),
    version: '1.0.0',
    status: 'draft', // human review promotes to approved
    app: { appId: input.appId, entryUrl: templatize(input.entryUrl), allowedOrigins: input.allowedOrigins },
    parameters,
    outputs,
    steps,
    successCondition,
    detectors: input.appDetectors,
    provenance: {
      discoveredAt: new Date().toISOString(),
      model: input.model,
      discoveryRunId: input.discoveryRunId,
      goal: templatize(input.goal),
    },
  });
}
