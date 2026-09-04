import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { CapabilityArtifact } from '../src/artifact/schema.js';
import { applyMeridianContract } from '../src/runtime/contracts.js';

const ids = [
  'meridian-sign-on',
  'meridian-member-inquiry',
  'meridian-member-record',
];
it.each(ids)('%s is reviewed and satisfies the recorded contract', id => {
  const artifact = CapabilityArtifact.parse(JSON.parse(
    readFileSync(`artifacts/${id}.v1.0.0.json`, 'utf8'),
  ));
  expect(artifact.id).toBe(id);
  expect(artifact.status).toBe('approved');
  expect(artifact.app.appId).toBe('meridian');
  expect(artifact.provenance.discoveryRunId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
  const checked = applyMeridianContract(artifact);
  expect(checked.schemaVersion).toBe(2);
  expect(checked.parameters.filter(p => p.source === 'server').map(p => p.name).sort())
    .toEqual(['branch', 'operator', 'password']);
  expect(artifact.steps.some(s => s.action === 'assert')).toBe(true);
});
