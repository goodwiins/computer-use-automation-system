import { describe, expect, it } from 'vitest';
import type { DiscoveryResult } from '../src/agent/loop.js';
import { recordArtifact } from '../src/artifact/recorder.js';

const discovery: DiscoveryResult = {
  status: 'success',
  outputs: { savingsBalance: '4,250.13' },
  finalUrl: 'http://localhost:4173/members/12345',
  trace: [
    {
      action: 'fill',
      reason: 'enter the member number 12345',
      descriptor: {
        description: 'member number input',
        frame: 'workarea',
        strategies: [{ kind: 'nameAttr', name: 'q' }, { kind: 'css', selector: 'input' }],
      },
      value: '12345',
      urlAfter: 'http://localhost:4173/members/search',
    },
    {
      action: 'click',
      reason: 'open the matching member record',
      descriptor: {
        description: 'result row link for the member',
        frame: 'workarea',
        strategies: [{ kind: 'role', role: 'link', name: '12345' }, { kind: 'text', text: '12345', exact: true }],
        snapshot: { tag: 'a', role: 'link', text: '12345' },
      },
      urlAfter: 'http://localhost:4173/members/12345',
    },
    {
      action: 'extract',
      reason: 'read the savings balance',
      descriptor: { description: 'savings balance cell', strategies: [{ kind: 'css', selector: 'td' }] },
      outputName: 'savingsBalance',
      extractedText: '4,250.13',
      urlAfter: 'http://localhost:4173/members/12345',
    },
  ],
};

const input = {
  name: 'lookup-member-balance',
  description: 'goal',
  goal: 'Look up member 12345 and read their savings balance',
  entryUrl: 'http://localhost:4173/',
  params: { memberId: '12345' },
  sensitiveParams: [],
  allowedOrigins: ['http://localhost:4173'],
  appId: 'cu-nexus',
  appDetectors: [],
  model: 'test-model',
  discoveryRunId: 'run-1',
};

describe('recordArtifact parameterization', () => {
  const artifact = recordArtifact(input, discovery);

  it('lifts concrete values into {{param}} templates in step values', () => {
    expect(artifact.steps[0]!.value).toBe('{{memberId}}');
  });

  it('templatizes locator strategies that contain the param value', () => {
    const click = artifact.steps[1]!;
    expect(click.target!.strategies).toContainEqual({ kind: 'role', role: 'link', name: '{{memberId}}' });
    expect(click.target!.snapshot?.text).toBe('{{memberId}}');
  });

  it('parameterizes the success condition from the final URL', () => {
    expect(artifact.successCondition).toEqual({ kind: 'urlMatches', pattern: '/members/{{memberId}}$' });
  });

  it('declares extracted outputs in the contract', () => {
    expect(artifact.outputs.map((o) => o.name)).toEqual(['savingsBalance']);
  });

  it('never stores a raw artifact with concrete param values', () => {
    expect(JSON.stringify(artifact.steps)).not.toContain('12345');
  });

  it('starts life as a draft', () => {
    expect(artifact.status).toBe('draft');
  });

  it('refuses to record a failed discovery', () => {
    expect(() => recordArtifact(input, { ...discovery, status: 'stopped' })).toThrow();
  });
});
