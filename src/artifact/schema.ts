// The capability artifact: a typed, versioned, reviewable contract for one
// recorded flow. This is what an AI agent invokes in production — so it
// declares parameters and outputs like a function signature, not just steps.
//
// Values that vary per invocation are stored as "{{param}}" templates and
// resolved at replay time. Raw values from the discovery run never persist.

import { z } from 'zod';

// ---------- Targeting ----------
// Ordered, robustness-ranked strategies for finding one control. Replay tries
// them top to bottom and fails loudly on ambiguity instead of guessing.
export const TargetStrategy = z.discriminatedUnion('kind', [
  // Accessibility tree: role + accessible name. Most stable, and the only
  // tier that transfers conceptually to desktop surfaces (UIA/AX APIs).
  z.object({ kind: z.literal('role'), role: z.string(), name: z.string() }),
  // Form-control name attribute. In legacy server-rendered apps the input
  // name is load-bearing (the server reads it), so it changes rarely.
  z.object({ kind: z.literal('nameAttr'), name: z.string() }),
  // Visible text (links, cells). Exact match unless exact=false.
  z.object({ kind: z.literal('text'), text: z.string(), exact: z.boolean().default(true) }),
  // Structural CSS. Last resort; brittle by definition.
  z.object({ kind: z.literal('css'), selector: z.string() }),
]);
export type TargetStrategy = z.infer<typeof TargetStrategy>;

export const TargetDescriptor = z.object({
  description: z.string(), // human-readable, for reviewers
  frame: z.string().optional(), // frame name (framesets are real in this world)
  strategies: z.array(TargetStrategy).min(1),
  nth: z.number().int().nonnegative().optional(), // only honored when a strategy matches >1
  // What discovery observed — not used to act, but invaluable when a replay
  // fails and you need to diff "then" vs "now" (drift diagnostics).
  snapshot: z
    .object({ tag: z.string().optional(), role: z.string().optional(), text: z.string().optional() })
    .optional(),
});
export type TargetDescriptor = z.infer<typeof TargetDescriptor>;

// ---------- Runtime-condition detectors ----------
// Known page states that can legitimately appear at any step: error banners,
// session expiry, interstitials. Each is classified so replay responds
// deliberately instead of blindly proceeding.
// urlMatches patterns come from approved artifacts and are compiled with
// `new RegExp` at replay time; an unattended worker must not hang on one.
// ponytail: heuristic ReDoS guard (rejects quantified groups + uncompilable
// patterns); swap for a real complexity checker if patterns get hand-authored.
const UrlPattern = z.string().refine((p) => {
  try { new RegExp(p); } catch { return false; }
  return !/\)[+*{]/.test(p);
}, 'urlMatches pattern is invalid or has a quantified group (ReDoS risk)');

export const Detector = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  description: z.string(),
  match: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('textVisible'), text: z.string() }),
    z.object({ kind: z.literal('urlMatches'), pattern: UrlPattern }),
  ]),
  classification: z.enum(['business_outcome', 'recoverable', 'fatal']),
  // business_outcome: a legitimate result the caller needs (e.g. NO_SUCH_MEMBER)
  outcomeCode: z.string().optional(),
  // recoverable: how to get past it (dismiss an interstitial), bounded to one
  // attempt per step so a persistent condition can't loop forever
  recovery: z
    .object({ action: z.enum(['click', 'none']), target: TargetDescriptor.optional() })
    .optional(),
});
export type Detector = z.infer<typeof Detector>;

export const TableColumn = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  selector: z.string().min(1),
  type: z.enum(['string', 'money']),
  sensitive: z.boolean().optional(),
});
export type TableColumn = z.infer<typeof TableColumn>;
export type OutputValue = string | number | Array<Record<string, string>>;

// ---------- Steps ----------
export const RiskClass = z.enum(['read', 'reversible_write', 'irreversible']);
export type RiskClass = z.infer<typeof RiskClass>;

export const Assertion = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('urlMatches'), pattern: UrlPattern }),
  z.object({ kind: z.literal('textVisible'), text: z.string(), frame: z.string().optional() }),
]);
export type Assertion = z.infer<typeof Assertion>;

export const Step = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
  intent: z.string(), // why this step exists — reviewability
  action: z.enum(['navigate', 'click', 'fill', 'select', 'extract', 'assert']),
  target: TargetDescriptor.optional(), // click/fill/select/extract
  url: z.string().optional(), // navigate; may contain {{param}}
  value: z.string().optional(), // fill/select; may contain {{param}}
  extract: z.object({ output: z.string(), columns: z.array(TableColumn).min(1).optional(), pattern: UrlPattern.optional(), rowSelector: z.string().optional() }).optional(),
  selectBy: z.enum(['label', 'value']).optional(), // extract -> which declared output
  assert: Assertion.optional(), // assert steps = checkpoints
  risk: RiskClass.default('read'),
  timeoutMs: z.number().int().positive().default(10_000),
});
export type Step = z.infer<typeof Step>;

// ---------- Contract ----------
export const Parameter = z.object({
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  type: z.enum(['string', 'number']),
  description: z.string(),
  required: z.boolean().default(true),
  // sensitive params are redacted in all logs/evidence and must never be
  // written into the artifact as literals
  sensitive: z.boolean().default(false),
  source: z.enum(['public', 'server']).optional(),
  format: z.enum(['money', 'positiveMoney']).optional(),
  pattern: UrlPattern.optional(),
  enum: z.array(z.string()).min(1).optional(),
});
export type Parameter = z.infer<typeof Parameter>;

export const Output = z.object({
  name: z.string(),
  type: z.enum(['string', 'number', 'table']),
  description: z.string(),
  sensitive: z.boolean().optional(),
  columns: z.array(TableColumn).min(1).optional(),
  minRows: z.number().int().nonnegative().optional(),
});
export type Output = z.infer<typeof Output>;

export const CapabilityArtifact = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  id: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  // draft artifacts require supervision; only approved ones may replay unattended
  status: z.enum(['draft', 'approved']),
  app: z.object({
    appId: z.string(),
    entryUrl: z.string(), // may contain {{param}}
    // Origins this capability is allowed to touch. Intersected with the
    // system-level policy allowlist at replay time — both must permit.
    allowedOrigins: z.array(z.string()).min(1),
  }),
  parameters: z.array(Parameter),
  outputs: z.array(Output),
  steps: z.array(Step).min(1),
  successCondition: Assertion,
  detectors: z.array(Detector).default([]),
  // Present only when a tenant overlay was composed onto a base artifact at
  // load time (see overlay.ts): the composed artifact is reviewable as a
  // distinct thing from its base, and the base file is never modified.
  overlay: z.object({ tenant: z.string(), source: z.string() }).optional(),
  // Optional per-tenant defaults for declared parameters; merged under the
  // caller's explicit params at replay time.
  paramDefaults: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  provenance: z.object({
    discoveredAt: z.string(),
    model: z.string(),
    discoveryRunId: z.string(),
    goal: z.string(),
  }),
});
export type CapabilityArtifact = z.infer<typeof CapabilityArtifact>;
type ParameterContract = Pick<CapabilityArtifact, 'parameters' | 'paramDefaults'>;

// ---------- Param templating ----------
const TEMPLATE_RE = /\{\{(\w+)\}\}/g;

export function resolveTemplate(template: string, params: Record<string, string | number>): string {
  return template.replace(TEMPLATE_RE, (_, name: string) => {
    if (!Object.hasOwn(params, name)) throw new Error(`Missing parameter "${name}" for template "${template}"`);
    return String(params[name]);
  });
}

const escapeRegexChars = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Like resolveTemplate, but for templates that will themselves be compiled
 * as a RegExp (e.g. urlMatches patterns): each substituted param value is
 * regex-escaped so a param value can never inject regex syntax.
 */
export function resolveTemplateForRegex(template: string, params: Record<string, string | number>): string {
  return template.replace(TEMPLATE_RE, (_, name: string) => {
    if (!Object.hasOwn(params, name)) throw new Error(`Missing parameter "${name}" for template "${template}"`);
    return escapeRegexChars(String(params[name]));
  });
}

/** Resolve {{param}} templates inside a target descriptor's strategies. */
export function resolveTarget(
  target: TargetDescriptor,
  params: Record<string, string | number>,
): TargetDescriptor {
  return {
    ...target,
    strategies: target.strategies.map((s) => {
      switch (s.kind) {
        case 'role': return { ...s, name: resolveTemplate(s.name, params) };
        case 'text': return { ...s, text: resolveTemplate(s.text, params) };
        case 'css': return { ...s, selector: resolveTemplate(s.selector, params) };
        case 'nameAttr': return s;
      }
    }),
  };
}

/** Validate caller-supplied params against the artifact's declared contract. */
export function validateParams(
  artifact: ParameterContract,
  params: Record<string, string | number>,
): { ok: true } | { ok: false; error: string } {
  for (const p of artifact.parameters) {
    if (!Object.hasOwn(params, p.name)) {
      if (p.required) return { ok: false, error: `Missing required parameter "${p.name}"` };
      continue;
    }
    const v = params[p.name];
    if (p.format) {
      try { const cents = moneyCents(String(v)); if (p.format === 'positiveMoney' && cents === 0) throw new Error(); }
      catch { return { ok: false, error: `Parameter "${p.name}" must be a valid decimal amount` }; }
    }
    if (p.pattern && !new RegExp(p.pattern).test(String(v))) return { ok: false, error: `Parameter "${p.name}" has an invalid format` };
    if (p.enum && !p.enum.includes(String(v))) return { ok: false, error: `Invalid choice for "${p.name}"` };
    if (p.type === 'string' && typeof v !== 'string') {
      return { ok: false, error: `Parameter "${p.name}" must be a string, got "${v}"` };
    }
    if (
      p.type === 'number' &&
      (!Number.isFinite(Number(v)) || (typeof v !== 'number' && (typeof v !== 'string' || v.trim() === '' || !Number.isFinite(Number(v)))))
    ) {
      return { ok: false, error: `Parameter "${p.name}" must be a number, got "${v}"` };
    }
  }
  const declared = new Set(artifact.parameters.map((p) => p.name));
  for (const k of Object.keys(params)) {
    if (!declared.has(k)) return { ok: false, error: `Unknown parameter "${k}"` };
  }
  return { ok: true };
}

/** Canonical decimal strings only; no floating-point money comparisons. */
export function moneyCents(value: string): number {
  if (!/^(0|[1-9]\d{0,12})(\.\d{1,2})?$/.test(value)) throw new Error('Invalid decimal amount');
  const [whole, fraction = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) throw new Error('Amount exceeds safe range');
  return cents;
}

export function validOutput(output: Output, value: OutputValue | undefined): boolean {
  if (output.type === 'string') return typeof value === 'string' && value.trim().length > 0;
  if (output.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  return Array.isArray(value) && value.length >= (output.minRows ?? 0) && !!output.columns?.length && value.every(row =>
    output.columns!.every(column => typeof row[column.name] === 'string' &&
      (column.type !== 'money' || /^-?(0|[1-9]\d*)\.\d{2}$/.test(row[column.name]!))));
}

export function normalizeParams(artifact: ParameterContract, params: Record<string, string | number>) {
  const normalized = { ...artifact.paramDefaults, ...params };
  const check = validateParams(artifact, normalized);
  if (!check.ok) throw new Error('Parameters do not match the capability contract');
  for (const p of artifact.parameters) {
    if (!Object.hasOwn(normalized, p.name)) continue;
    if (p.type === 'number') normalized[p.name] = Number(normalized[p.name]);
    if (p.format) {
      const cents = moneyCents(String(normalized[p.name]));
      normalized[p.name] = `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
    }
  }
  return normalized;
}

/** Extract one explicitly captured value from shared legacy text, never an entire session footer. */
export function extractText(text: string, pattern?: string): string {
  if (!pattern) return text;
  const matches = [...text.matchAll(new RegExp(UrlPattern.parse(pattern), 'g'))];
  if (matches.length !== 1 || matches[0]!.length !== 2 || !matches[0]![1]?.trim()) throw new Error('Text extraction requires one match and one nonempty capture');
  return matches[0]![1]!.trim();
}
