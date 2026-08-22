// Artifact lifecycle helpers used by the CLI: promotion to approved, and
// capability-name validation for anything that becomes a filename.

export function promoteToApproved(artifactJson: string): string {
  const artifact = JSON.parse(artifactJson) as { status?: string };
  artifact.status = 'approved';
  return JSON.stringify(artifact, null, 2);
}

const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Capability names become filenames — reject anything path-like. */
export function assertSafeCapabilityName(name: string): void {
  if (!SAFE_NAME_RE.test(name) || name.includes('..')) {
    throw new Error(`Invalid capability name "${name}": use letters, digits, dot, dash, underscore`);
  }
}
