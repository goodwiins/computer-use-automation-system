// Full-thread integration test with a scripted (stub) LLM:
//   discovery loop → recorded artifact → deterministic replay with DIFFERENT
//   params → correct outputs.
// The real-model run lives in /evidence/; this test pins the machinery.

import type { Server } from 'node:http';
import type OpenAI from 'openai';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../target-app/server.js';
import { runDiscovery } from '../src/agent/loop.js';
import { recordArtifact } from '../src/artifact/recorder.js';
import { runReplay } from '../src/replay/executor.js';
import { Policy } from '../src/safety/policy.js';
import { Redactor } from '../src/safety/redact.js';
import { RunLogger } from '../src/evidence/logger.js';
import { BrowserSurface } from '../src/surface/browser.js';
import { GuardedSurface } from '../src/surface/guarded.js';

const PORT = 4199;
const ORIGIN = `http://localhost:${PORT}`;

const policy = Policy.parse({
  allowedOrigins: [ORIGIN],
  allowedActions: ['navigate', 'click', 'fill', 'select', 'extract', 'assert'],
  riskHandling: { read: 'allow', reversible_write: 'allow', irreversible: 'escalate' },
});

/** An OpenAI stand-in that plays a fixed sequence of tool calls. */
function scriptedOpenAI(script: Array<{ name: string; args: Record<string, unknown> }>): OpenAI {
  let i = 0;
  return {
    chat: {
      completions: {
        create: async () => {
          const call = script[i++];
          if (!call) throw new Error('script exhausted');
          return {
            choices: [
              {
                message: {
                  content: '',
                  tool_calls: [
                    {
                      id: `call_${i}`,
                      type: 'function',
                      function: { name: call.name, arguments: JSON.stringify(call.args) },
                    },
                  ],
                },
              },
            ],
          };
        },
      },
    },
  } as unknown as OpenAI;
}

const SCRIPT = [
  { name: 'click', args: { frame: 'workarea', role: 'link', name: 'Member Inquiry / Maintenance', reason: 'open member inquiry' } },
  { name: 'fill', args: { frame: 'workarea', nameAttr: 'q', value: '12345', reason: 'enter the member number' } },
  { name: 'click', args: { frame: 'workarea', role: 'button', name: 'Search', reason: 'run the search' } },
  { name: 'click', args: { frame: 'workarea', role: 'link', name: '12345', reason: 'open the member record' } },
  {
    name: 'extract',
    args: {
      frame: 'workarea',
      css: "tr:has(> td:text-is('SAVINGS')) > td:nth-of-type(4)",
      outputName: 'savingsBalance',
      reason: 'read the savings balance',
    },
  },
  { name: 'done', args: { summary: 'balance read', outputs: { savingsBalance: '4,250.13' } } },
];

describe('discovery → artifact → replay (scripted LLM)', () => {
  let server: Server;
  beforeAll(async () => {
    server = createApp().listen(PORT);
  });
  afterAll(() => new Promise((r) => server.close(r)));

  it(
    'records a parameterized artifact that replays for a different member',
    async () => {
      // --- discovery with the scripted model ---
      const redactor = new Redactor();
      const logger = new RunLogger('discovery', redactor, 'evidence/test-runs');
      const surface = new GuardedSurface(new BrowserSurface(), policy, async () => false);
      const discovery = await runDiscovery(
        'Look up member 12345 and read their current savings balance',
        `${ORIGIN}/`,
        { memberId: '12345' },
        policy.allowedOrigins,
        { surface, logger, openai: scriptedOpenAI(SCRIPT), model: 'scripted', maxSteps: 10 },
      );
      await surface.close();

      expect(discovery.status).toBe('success');
      expect(discovery.outputs).toEqual({ savingsBalance: '4,250.13' });

      // --- record ---
      const artifact = recordArtifact(
        {
          name: 'e2e-lookup',
          description: 'goal',
          goal: 'Look up member 12345 and read their current savings balance',
          entryUrl: `${ORIGIN}/`,
          params: { memberId: '12345' },
          sensitiveParams: [],
          allowedOrigins: policy.allowedOrigins,
          appId: 'cu-nexus',
          appDetectors: [],
          model: 'scripted',
          discoveryRunId: logger.runId,
        },
        discovery,
      );
      artifact.status = 'approved';
      // Parameterization actually happened.
      expect(JSON.stringify(artifact.steps)).toContain('{{memberId}}');
      expect(JSON.stringify(artifact.steps)).not.toContain('12345');

      // --- deterministic replay for a DIFFERENT member ---
      const replayLogger = new RunLogger('replay', new Redactor(), 'evidence/test-runs');
      const replaySurface = new GuardedSurface(new BrowserSurface(), policy, async () => false);
      const result = await runReplay(artifact, { memberId: '23456' }, {
        surface: replaySurface,
        logger: replayLogger,
        policy,
      });
      await replaySurface.close();

      expect(result.status).toBe('success');
      expect(result.status === 'success' && result.outputs.savingsBalance).toBe('9,812.55');
    },
    60_000,
  );
});
