// System-level guardrails. The policy is configuration, not code — an
// operator can tighten it without a deploy. Enforcement happens at the
// Surface layer (see surface/guarded.ts) so every actor — LLM discovery,
// deterministic replay, even a buggy caller — passes through the same gate.

import { readFileSync } from 'node:fs';
import { z } from 'zod';
import type { RiskClass } from '../artifact/schema.js';

export const Policy = z.object({
  // Origins the system may touch at all. An artifact's own allowedOrigins
  // must be a subset — both gates must pass.
  allowedOrigins: z.array(z.string()).min(1),
  // Action types permitted (e.g. a read-only deployment can drop fill/select).
  allowedActions: z.array(z.enum(['navigate', 'click', 'fill', 'select', 'extract', 'assert'])),
  // How each risk class is handled when executing.
  riskHandling: z.object({
    read: z.enum(['allow', 'confirm', 'escalate', 'block']),
    reversible_write: z.enum(['allow', 'confirm', 'escalate', 'block']),
    irreversible: z.enum(['allow', 'confirm', 'escalate', 'block']),
  }),
  maxSteps: z.number().int().positive().default(25),
  // Unattended replay requires an approved artifact.
  requireApprovedForUnattended: z.boolean().default(true),
});
export type Policy = z.infer<typeof Policy>;

export function loadPolicy(path: string): Policy {
  return Policy.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export type PolicyVerdict =
  | { verdict: 'allow' }
  | { verdict: 'deny'; reason: string }
  | { verdict: 'needs_human'; reason: string }; // confirm/escalate both route to a human

export function checkAction(
  policy: Policy,
  action: string,
  url: string,
  risk: RiskClass,
): PolicyVerdict {
  if (!originAllowed(policy.allowedOrigins, url)) {
    return { verdict: 'deny', reason: `URL ${redactUrlForLog(url)} is outside the allowed origins` };
  }
  if (!(policy.allowedActions as string[]).includes(action)) {
    return { verdict: 'deny', reason: `Action type "${action}" is not in the policy allowlist` };
  }
  const handling = policy.riskHandling[risk];
  if (handling === 'block') return { verdict: 'deny', reason: `Risk class "${risk}" is blocked by policy` };
  if (handling === 'confirm' || handling === 'escalate') {
    return { verdict: 'needs_human', reason: `Risk class "${risk}" requires human ${handling}` };
  }
  return { verdict: 'allow' };
}

export function originAllowed(allowed: string[], url: string): boolean {
  // Scheme-less "authority" forms (protocol-relative `//host/path`, and the
  // backslash variant some browsers normalize) are NOT relative paths: a
  // browser resolves them against a full origin and escapes the allowlist.
  if (url.startsWith('//') || url.startsWith('\\\\')) return false;
  try {
    const origin = new URL(url).origin;
    return allowed.includes(origin);
  } catch {
    // Relative URLs stay on the current origin, which was already checked
    // when we navigated there.
    return url.startsWith('/') || url.startsWith('?');
  }
}

// Keep query strings (which may carry member IDs etc.) out of denial reasons.
function redactUrlForLog(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url.split('?')[0] ?? url;
  }
}
