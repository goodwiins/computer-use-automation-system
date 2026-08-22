import { describe, expect, it } from 'vitest';
import { assertSafeCapabilityName, promoteToApproved } from '../src/artifact/promote.js';

const draft = JSON.stringify({
  schemaVersion: 1,
  id: 'lookup',
  status: 'draft',
  version: '1.0.0',
});

describe('promoteToApproved', () => {
  it('flips draft to approved and preserves everything else', () => {
    const out = JSON.parse(promoteToApproved(draft));
    expect(out.status).toBe('approved');
    expect(out.id).toBe('lookup');
    expect(out.version).toBe('1.0.0');
  });
  it('is idempotent on an already-approved artifact', () => {
    const approved = JSON.stringify({ ...JSON.parse(draft), status: 'approved' });
    expect(JSON.parse(promoteToApproved(approved)).status).toBe('approved');
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
