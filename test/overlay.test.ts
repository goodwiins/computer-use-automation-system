// Tenant overlays: a thin per-tenant delta layered onto a base artifact at
// load time, so one recorded capability serves many tenants running the same
// vendor product (configured/branded differently) without re-recording.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyOverlay, TenantOverlay } from '../src/artifact/overlay.js';
import { CapabilityArtifact, type CapabilityArtifact as Artifact } from '../src/artifact/schema.js';

const base: Artifact = CapabilityArtifact.parse(
  JSON.parse(readFileSync('artifacts/lookup-member-balance.v1.0.0.json', 'utf8')),
);

const overlayJson = {
  schemaVersion: 1,
  tenant: 'premier',
  appId: 'cu-nexus',
  base: { id: 'lookup-member-balance', version: '1.0.0' },
  entryUrl: 'http://localhost:4173/?tenant=premier',
  stepOverrides: [
    {
      stepId: 's1',
      prepend: [{ kind: 'role', role: 'link', name: 'Account Inquiry' }],
    },
  ],
};

describe('TenantOverlay schema', () => {
  it('parses a valid overlay', () => {
    expect(() => TenantOverlay.parse(overlayJson)).not.toThrow();
  });

  it('rejects an overlay with no tenant identity', () => {
    expect(() => TenantOverlay.parse({ ...overlayJson, tenant: '' })).toThrow();
  });

  it('requires at least one strategy per step override', () => {
    expect(() =>
      TenantOverlay.parse({ ...overlayJson, stepOverrides: [{ stepId: 's1', prepend: [] }] }),
    ).toThrow();
  });
});

describe('applyOverlay composition', () => {
  const composed = applyOverlay(base, TenantOverlay.parse(overlayJson));

  it('validates the overlay against the base (id, version, appId)', () => {
    expect(() =>
      applyOverlay(base, TenantOverlay.parse({ ...overlayJson, base: { ...overlayJson.base, id: 'other' } })),
    ).toThrow(/id/);
    expect(() =>
      applyOverlay(
        base,
        TenantOverlay.parse({ ...overlayJson, base: { ...overlayJson.base, version: '9.9.9' } }),
      ),
    ).toThrow(/version/);
    expect(() => applyOverlay(base, TenantOverlay.parse({ ...overlayJson, appId: 'other-app' }))).toThrow(/appId/);
  });

  it('rejects overrides for steps the base does not have', () => {
    expect(() =>
      applyOverlay(base, TenantOverlay.parse({ ...overlayJson, stepOverrides: [{ stepId: 's99', prepend: [{ kind: 'css', selector: 'a' }] }] })),
    ).toThrow(/s99/);
  });

  it('prepends tenant strategies ahead of the base tiers (variant first, base as fallback)', () => {
    const s1 = composed.steps.find((s) => s.id === 's1')!;
    expect(s1.target!.strategies[0]).toEqual({ kind: 'role', role: 'link', name: 'Account Inquiry' });
    // base tiers survive below the override
    expect(s1.target!.strategies.map((t) => t.kind)).toContain('text');
  });

  it('leaves untouched steps identical to the base', () => {
    expect(composed.steps.find((s) => s.id === 's5')).toEqual(base.steps.find((s) => s.id === 's5'));
  });

  it('applies the tenant entry URL', () => {
    expect(composed.app.entryUrl).toBe('http://localhost:4173/?tenant=premier');
  });

  it('stamps overlay provenance so composed artifacts are reviewable', () => {
    expect(composed.overlay).toEqual({ tenant: 'premier', source: 'lookup-member-balance@1.0.0' });
  });

  it('produces a schema-valid artifact', () => {
    expect(() => CapabilityArtifact.parse(composed)).not.toThrow();
  });

  it('does not mutate the base artifact', () => {
    expect(base.app.entryUrl).toBe('http://localhost:4173/');
    expect(base.steps.find((s) => s.id === 's1')!.target!.strategies[0]).toMatchObject({
      name: 'Member Inquiry / Maintenance',
    });
    expect(base.overlay).toBeUndefined();
  });
});

describe('paramDefaults', () => {
  it('fills missing params at load time; explicit caller params win', () => {
    const withDefaults = TenantOverlay.parse({ ...overlayJson, paramDefaults: { memberId: '12345' } });
    const composed = applyOverlay(base, withDefaults);
    expect(composed.paramDefaults).toEqual({ memberId: '12345' });
  });
});
