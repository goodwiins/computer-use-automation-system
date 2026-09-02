import { describe, expect, it } from 'vitest';
import { assertSafeCapabilityName, promoteToApproved } from '../src/artifact/promote.js';

const draft = JSON.stringify({
  schemaVersion: 1,
  id: 'lookup', name: 'lookup', description: 'x', version: '1.0.0', status: 'draft',
  app: { appId: 'test', entryUrl: 'http://localhost:4173/', allowedOrigins: ['http://localhost:4173'] },
  parameters: [], outputs: [],
  steps: [{ id: 's1', intent: 'x', action: 'navigate', url: 'http://localhost:4173/', risk: 'read', timeoutMs: 1000 }],
  successCondition: { kind: 'urlMatches', pattern: '.*' },
  detectors: [],
  provenance: { discoveredAt: '2026-01-01T00:00:00Z', model: 'test', discoveryRunId: 'r1', goal: 'x' },
});

describe('promoteToApproved', () => {
  it('flips draft to approved and preserves everything else', () => {
    const out = JSON.parse(promoteToApproved(draft));
    expect(out.status).toBe('approved');
    expect(out.id).toBe('lookup');
    expect(out.version).toBe('1.0.0');
    expect(out.steps).toHaveLength(1);
  });
  it('is idempotent on an already-approved artifact', () => {
    const approved = JSON.stringify({ ...JSON.parse(draft), status: 'approved' });
    expect(JSON.parse(promoteToApproved(approved)).status).toBe('approved');
  });
  it('refuses to approve an artifact that does not match the schema', () => {
    expect(() => promoteToApproved(JSON.stringify({ schemaVersion: 1, id: 'x', status: 'draft' }))).toThrow();
    expect(() => promoteToApproved(JSON.stringify({ ...JSON.parse(draft), steps: [] }))).toThrow();
  });
});

describe('assertSafeCapabilityName', () => {
  it('accepts ordinary capability names', () => {
    expect(() => assertSafeCapabilityName('lookup-member-balance')).not.toThrow();
    expect(() => assertSafeCapabilityName('open_subaccount.v2')).not.toThrow();
  });
  it('rejects path traversal and separators', () => {
    for (const bad of ['../evil', '../../.ssh/x', 'a/b', 'C:\\x', '..', '.', 'foo/../bar']) {
      expect(() => assertSafeCapabilityName(bad), bad).toThrow();
    }
  });
  it('rejects empty names', () => {
    expect(() => assertSafeCapabilityName('')).toThrow();
  });
});
