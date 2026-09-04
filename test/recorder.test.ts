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

  it('accepts the observed result route with changing search queries without persisting them', () => {
    const recorded = recordArtifact(input, { ...discovery, finalUrl: 'http://localhost:4173/members?by=number&q=12345' });
    const pattern = recorded.successCondition.kind === 'urlMatches' ? recorded.successCondition.pattern : '';
    expect(new RegExp(pattern).test('http://localhost:4173/members?by=name&q=Van+Dyke')).toBe(true);
    expect(new RegExp(pattern).test('http://localhost:4173/members/12345')).toBe(false);
    expect(pattern).not.toContain('12345');
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

describe('recordArtifact risk-label floor', () => {
  // The model classifies click risk, but its label must never be lower than
  // what the element itself implies — a mislabeled commit click would sail
  // through the policy gate unattended.
  const clickTrace = (snapshotText: string, tag: string, role: string, modelRisk: 'read' | 'reversible_write' | 'irreversible'): DiscoveryResult => ({
    ...discovery,
    trace: [
      {
        action: 'click',
        reason: 'do the thing',
        descriptor: {
          description: 'the control',
          strategies: [{ kind: 'role', role, name: snapshotText }],
          snapshot: { tag, role, text: snapshotText },
        },
        risk: modelRisk,
        urlAfter: 'http://localhost:4173/x',
      },
    ],
  });

  it('raises a model-read on an "Open Account" button to irreversible', () => {
    const a = recordArtifact(input, clickTrace('Open Account', 'button', 'button', 'read'));
    expect(a.steps[0]!.risk).toBe('irreversible');
  });

  it('raises a model-read on a generic submit button to reversible_write', () => {
    const a = recordArtifact(input, clickTrace('Apply Filters', 'button', 'button', 'read'));
    expect(a.steps[0]!.risk).toBe('reversible_write');
  });

  it('keeps the model label when it already meets the floor', () => {
    const a = recordArtifact(input, clickTrace('Open Account', 'button', 'button', 'irreversible'));
    expect(a.steps[0]!.risk).toBe('irreversible');
  });

  it('never floors plain link clicks', () => {
    const a = recordArtifact(input, clickTrace('12345', 'a', 'link', 'read'));
    expect(a.steps[0]!.risk).toBe('read');
  });
});

describe('recordArtifact regex parameterization', () => {
  const sensitiveInput = {
    ...input,
    name: 'member-regex',
    goal: 'Read member 123',
    params: { member: '123' },
    sensitiveParams: ['member'],
  };

  const traceForPattern = (action: 'assert' | 'extract', pattern: string): DiscoveryResult => ({
    status: 'success',
    outputs: action === 'extract' ? { value: 'captured' } : {},
    finalUrl: 'http://localhost:4173/members/123',
    trace: action === 'assert'
      ? [{ action, reason: 'verify member', assert: { kind: 'urlMatches', pattern }, urlAfter: 'http://localhost:4173/members/123' }]
      : [{ action, reason: 'read value', descriptor: { description: 'value', strategies: [{ kind: 'nameAttr', name: 'value' }] }, outputName: 'value', pattern, extractedText: 'captured', urlAfter: 'http://localhost:4173/members/123' }],
  });

  it.each(['\\x31\\x32\\x33', '[1][2][3]'])('rejects encoded sensitive values in %s before recording assertions or extracts', pattern => {
    expect(() => recordArtifact(sensitiveInput, traceForPattern('assert', pattern))).toThrow(/pattern/);
    expect(() => recordArtifact(sensitiveInput, traceForPattern('extract', pattern))).toThrow(/pattern/);
  });

  it('keeps safe generic captures and supported parameter placeholders', () => {
    const generic = recordArtifact(sensitiveInput, traceForPattern('extract', 'OPR\\s+(\\S+)'));
    expect(generic.steps[0]!.extract?.pattern).toBe('OPR\\s+(\\S+)');

    const placeholder = recordArtifact(sensitiveInput, traceForPattern('assert', '^/members/{{member}}$'));
    expect(placeholder.steps[0]!.assert).toEqual({ kind: 'urlMatches', pattern: '^/members/{{member}}$' });

    const literal = recordArtifact(sensitiveInput, traceForPattern('extract', 'member=(123)'));
    expect(literal.steps[0]!.extract?.pattern).toBe('member=({{member}})');
  });

  it('keeps short numeric values from being confused with regex quantifiers', () => {
    const shortInput = { ...sensitiveInput, params: { member: '4' } };
    const artifact = recordArtifact(shortInput, traceForPattern('assert', '^\\d{1,12}$'));
    expect(artifact.steps[0]!.assert).toEqual({ kind: 'urlMatches', pattern: '^\\d{1,12}$' });
  });
});
