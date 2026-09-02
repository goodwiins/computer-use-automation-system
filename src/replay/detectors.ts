// Runtime-condition detection. Before (and after) each step, replay checks
// the live page against the artifact's detector list plus a few generic
// built-ins. A hit is classified — business outcome, recoverable, or fatal —
// and the executor responds deliberately.

import type { CapabilityArtifact, Detector } from '../artifact/schema.js';
import type { Surface } from '../surface/types.js';

export const BUILTIN_DETECTORS: Detector[] = [
  {
    id: 'generic-server-error',
    description: 'App-level error page (5xx / trancode failure)',
    match: { kind: 'textVisible', text: 'SYSTEM ERROR' },
    classification: 'fatal',
  },
];

/** First matching detector (artifact-declared first, then built-ins), or null. */
export async function checkDetectors(surface: Surface, artifact: CapabilityArtifact): Promise<Detector | null> {
  for (const detector of [...artifact.detectors, ...BUILTIN_DETECTORS]) {
    if (await matchDetector(surface, detector)) return detector;
  }
  return null;
}

/** Check a single detector's match condition against the live page. */
export async function matchDetector(surface: Surface, detector: Detector): Promise<boolean> {
  const m = detector.match;
  if (m.kind === 'textVisible') return surface.isTextVisible(m.text);
  try {
    return new RegExp(m.pattern).test(surface.currentUrl());
  } catch {
    // Invalid regex authored into a detector — skip it rather than crash replay.
    return false;
  }
}
