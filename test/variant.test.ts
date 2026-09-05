// Cross-tenant reuse (the multi-tenant stretch): ONE recorded capability
// applied to a second "tenant" running the same vendor product with a
// differently-configured UI (?tenant=premier renames the menu entry point).
//
//   1. Without the overlay: the base artifact hard-fails at the renamed step
//      — expected-vs-observed, no guessing.
//   2. With a thin tenant overlay: the same base artifact replays cleanly —
//      no re-recording, base file untouched.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../target-app/server.js';
import { applyOverlay, TenantOverlay } from '../src/artifact/overlay.js';
import { CapabilityArtifact, type CapabilityArtifact as Artifact } from '../src/artifact/schema.js';
import { runReplay } from '../src/replay/executor.js';
import { Policy } from '../src/safety/policy.js';
import { Redactor } from '../src/safety/redact.js';
import { RunLogger } from '../src/evidence/logger.js';
import { BrowserSurface } from '../src/surface/browser.js';
import { GuardedSurface } from '../src/surface/guarded.js';

let policy: Policy;

const base: Artifact = CapabilityArtifact.parse(
  JSON.parse(readFileSync('artifacts/lookup-member-balance.v1.0.0.json', 'utf8')),
);
const overlayJson = {
  schemaVersion: 1,
  tenant: 'premier',
  // A reviewed overlay: without this it composes as `draft` and unattended
  // replay is refused (an overlay can re-aim a locator, so it needs its own review).
  status: 'approved',
  appId: 'cu-nexus',
  base: { id: 'lookup-member-balance', version: '1.0.0' },
  entryUrl: '', // Set to the test server's assigned port in beforeAll.
  stepOverrides: [
    { stepId: 's1', prepend: [{ kind: 'role', role: 'link', name: 'Account Inquiry' }] },
  ],
};

async function replay(artifact: Artifact, params: Record<string, string | number>) {
  const logger = new RunLogger('replay', new Redactor(), 'evidence/test-runs');
  const surface = new GuardedSurface(new BrowserSurface(), policy, async () => false);
  try {
    return await runReplay(artifact, params, { surface, logger, policy });
  } finally {
    await surface.close();
  }
}

describe('cross-tenant replay via overlay', () => {
  let server: Server;
  beforeAll(async () => {
    server = createApp().listen(0, '127.0.0.1');
    await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    policy = Policy.parse({
      allowedOrigins: [origin],
      allowedActions: ['navigate', 'click', 'fill', 'select', 'extract', 'assert'],
      riskHandling: { read: 'allow', reversible_write: 'allow', irreversible: 'escalate' },
    });
    base.app.allowedOrigins = [origin];
    base.app.entryUrl = overlayJson.entryUrl = `${origin}/?tenant=premier`;
  });
  afterAll(() => new Promise((r) => server.close(r)));

  it(
    'base artifact alone fails loudly at the renamed control',
    async () => {
      const result = await replay(base, { memberId: '23456' });
      expect(result.status).toBe('failure');
      if (result.status === 'failure') {
        expect(result.failure.stepId).toBe('s1');
        // All recorded tiers fail to resolve against the renamed control.
        expect(result.failure.observed).toContain('role=0');
      }
    },
    60_000,
  );

  it(
    'composed with the tenant overlay, the same base replays successfully',
    async () => {
      const composed = applyOverlay(base, TenantOverlay.parse(overlayJson));
      expect(composed.overlay).toEqual({ tenant: 'premier', source: 'lookup-member-balance@1.0.0' });
      const result = await replay(composed, { memberId: '23456' });
      expect(result.status).toBe('success');
      expect(result.status === 'success' && result.outputs.savings_balance).toBe('9,812.55');
    },
    60_000,
  );

  it(
    'overlay paramDefaults fill in when the caller omits a param',
    async () => {
      const composed = applyOverlay(
        base,
        TenantOverlay.parse({ ...overlayJson, paramDefaults: { memberId: '12345' } }),
      );
      const result = await replay(composed, {});
      expect(result.status).toBe('success');
      expect(result.status === 'success' && result.outputs.savings_balance).toBe('4,250.13');
    },
    60_000,
  );
});
