import { describe, expect, it } from 'vitest';
import {
  CapabilityArtifact,
  resolveTemplate,
  validateParams,
} from '../src/artifact/schema.js';

const minimalArtifact = {
  schemaVersion: 1,
  id: 'lookup-member-balance',
  name: 'lookup-member-balance',
  description: 'Look up a member and read their savings balance',
  version: '1.0.0',
  status: 'draft',
  app: { appId: 'cu-nexus', entryUrl: 'http://localhost:4173/', allowedOrigins: ['http://localhost:4173'] },
  parameters: [
    { name: 'memberId', type: 'string', description: 'Member number', required: true, sensitive: false },
  ],
  outputs: [{ name: 'savingsBalance', type: 'string', description: 'Current savings balance' }],
  steps: [
    {
      id: 's1',
      intent: 'open member inquiry',
      action: 'click',
      target: {
        description: 'Member Services link',
        frame: 'workarea',
        strategies: [{ kind: 'role', role: 'link', name: 'Member Services' }],
      },
      risk: 'read',
      timeoutMs: 10000,
    },
  ],
  successCondition: { kind: 'urlMatches', pattern: '/members/{{memberId}}$' },
  detectors: [],
  provenance: { discoveredAt: '2026-08-13T00:00:00Z', model: 'test', discoveryRunId: 'r1', goal: 'test goal' },
};

describe('CapabilityArtifact schema', () => {
  it('round-trips through JSON', () => {
    const parsed = CapabilityArtifact.parse(minimalArtifact);
    const again = CapabilityArtifact.parse(JSON.parse(JSON.stringify(parsed)));
    expect(again).toEqual(parsed);
  });

  it('rejects a step list that is empty', () => {
    expect(() => CapabilityArtifact.parse({ ...minimalArtifact, steps: [] })).toThrow();
  });

  it('R3-A1: rejects duplicate step ids', () => {
    const bad = JSON.parse(JSON.stringify(minimalArtifact));
    bad.steps.push({ ...bad.steps[0] });
    expect(() => CapabilityArtifact.parse(bad)).toThrow(/unique/);
  });

  it('rejects an unknown risk class', () => {
    const bad = JSON.parse(JSON.stringify(minimalArtifact));
    bad.steps[0].risk = 'catastrophic';
    expect(() => CapabilityArtifact.parse(bad)).toThrow();
  });
});

describe('param templating', () => {
  it('resolves templates', () => {
    expect(resolveTemplate('/members/{{memberId}}', { memberId: '12345' })).toBe('/members/12345');
  });
  it('throws on a missing param', () => {
    expect(() => resolveTemplate('/members/{{memberId}}', {})).toThrow(/Missing parameter/);
  });
});

describe('validateParams', () => {
  const artifact = CapabilityArtifact.parse(minimalArtifact);
  it('accepts a complete param set', () => {
    expect(validateParams(artifact, { memberId: '12345' })).toEqual({ ok: true });
  });
  it('rejects missing required params', () => {
    expect(validateParams(artifact, {})).toMatchObject({ ok: false });
  });
  it('rejects undeclared params', () => {
    expect(validateParams(artifact, { memberId: '1', extra: 'x' })).toMatchObject({ ok: false });
  });
});
