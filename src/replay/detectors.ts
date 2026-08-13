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

export interface DetectorHit {
  detector: Detector;
}

export async function checkDetectors(
  surface: Surface,
  artifact: CapabilityArtifact,
): Promise<DetectorHit | null> {
  for (const detector of [...artifact.detectors, ...BUILTIN_DETECTORS]) {
    const m = detector.match;
    const hit =
      m.kind === 'textVisible'
        ? await surface.isTextVisible(m.text)
        : new RegExp(m.pattern).test(surface.currentUrl());
    if (hit) return { detector };
  }
  return null;
}
