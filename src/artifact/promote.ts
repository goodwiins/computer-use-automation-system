// Artifact lifecycle helpers used by the CLI: promotion to approved, and
// capability-name validation for anything that becomes a filename.

import { applyMeridianContract } from '../runtime/contracts.js';
import { CapabilityArtifact } from './schema.js';

/** Approval is a statement about a *valid* artifact — parse before stamping. */
export function promoteToApproved(artifactJson: string): string {
  let artifact = CapabilityArtifact.parse(JSON.parse(artifactJson));
  if (artifact.app.appId === 'meridian') artifact = applyMeridianContract(artifact);
  return JSON.stringify({ ...artifact, status: 'approved' }, null, 2);
}

const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Capability names become filenames — reject anything path-like. */
export function assertSafeCapabilityName(name: string): void {
  if (!SAFE_NAME_RE.test(name) || name.includes('..')) {
    throw new Error(`Invalid capability name "${name}": use letters, digits, dot, dash, underscore`);
  }
}
