// Tenant overlays: one recorded capability, many tenants. Tenants commonly run
// the same underlying vendor product configured, branded, and versioned
// differently — so an artifact records against the *vendor app* (appId), and a
// thin per-tenant overlay supplies the deltas at load time: entry URL,
// parameter defaults, and locator strategies for steps whose controls differ
// in this tenant's configuration.
//
// Override strategies are PREPENDED, not replacements: the variant tier is
// tried first and the base tiers remain as fallback, so a partially-skinned
// variant degrades gracefully instead of hard-failing. The base artifact on
// disk is never modified; the composed artifact carries overlay provenance so
// it is reviewable as a distinct thing from its base.

import { z } from 'zod';
import { originAllowed, redactUrlForLog } from '../safety/policy.js';
import { CapabilityArtifact, TargetStrategy, type CapabilityArtifact as Artifact } from './schema.js';

export const TenantOverlay = z.object({
  schemaVersion: z.literal(1),
  tenant: z.string().min(1),
  // The vendor app this overlay applies to. Must match the base artifact's
  // appId — an overlay for a different product is a configuration error.
  appId: z.string().min(1),
  // Which base artifact (id + exact version) this delta was written against.
  base: z.object({ id: z.string().min(1), version: z.string() }),
  // An overlay is reviewed in its own right: it can re-aim a step's locator at
  // a different control, so inheriting the base's approval would let an
  // unreviewed delta replay unattended. Defaults to draft.
  status: z.enum(['draft', 'approved']).default('draft'),
  // This tenant's entry point (e.g. carries a tenant routing/brand param).
  entryUrl: z.string().optional(),
  // Defaults for declared parameters; caller-supplied params win.
  paramDefaults: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  stepOverrides: z
    .array(
      z.object({
        stepId: z.string(),
        // Locator strategies to try BEFORE the recorded tiers.
        prepend: z.array(TargetStrategy).min(1),
      }),
    )
    .default([]),
});

export type TenantOverlay = z.infer<typeof TenantOverlay>;

/** Compose a tenant overlay onto a base artifact. Returns a new artifact. */
export function applyOverlay(base: Artifact, overlay: TenantOverlay): Artifact {
  if (overlay.base.id !== base.id) {
    throw new Error(`Overlay is for artifact id "${overlay.base.id}" but was applied to "${base.id}"`);
  }
  if (overlay.base.version !== base.version) {
    throw new Error(
      `Overlay version mismatch: written against ${overlay.base.id}@${overlay.base.version} but base is @${base.version} — re-review the overlay against the new base`,
    );
  }
  if (overlay.appId !== base.app.appId) {
    throw new Error(`Overlay appId "${overlay.appId}" does not match base artifact appId "${base.app.appId}"`);
  }

  if (overlay.entryUrl && !originAllowed(base.app.allowedOrigins, overlay.entryUrl)) {
    throw new Error(
      // Thrown before the CLI builds its Redactor, so keep the query string out:
      // a tenant entry URL can carry a sensitive default (?pin=...).
      `Overlay entryUrl "${redactUrlForLog(overlay.entryUrl)}" is outside the base artifact's allowed origins [${base.app.allowedOrigins.join(', ')}]`,
    );
  }

  const overridden = new Map(overlay.stepOverrides.map((o) => [o.stepId, o.prepend]));
  for (const stepId of overridden.keys()) {
    if (!base.steps.some((s) => s.id === stepId)) {
      throw new Error(`Overlay overrides step "${stepId}" which does not exist in ${base.id}@${base.version}`);
    }
  }

  const steps = base.steps.map((step) => {
    const prepend = overridden.get(step.id);
    if (!prepend || !step.target) return step;
    return {
      ...step,
      target: { ...step.target, strategies: [...prepend, ...step.target.strategies] },
    };
  });

  const composed = {
    ...base,
    steps,
    app: overlay.entryUrl ? { ...base.app, entryUrl: overlay.entryUrl } : base.app,
    paramDefaults: overlay.paramDefaults,
    // The composed artifact is only as approved as the overlay itself.
    status: overlay.status === 'approved' ? base.status : 'draft',
    overlay: { tenant: overlay.tenant, source: `${base.id}@${base.version}` },
  };
  return CapabilityArtifact.parse(composed);
}
