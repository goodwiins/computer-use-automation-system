// Turns a successful discovery trace into a capability artifact. Two jobs:
//  1. Parameterization: every occurrence of an invocation parameter's concrete
//     value (in URLs, filled values, the success condition) becomes a
//     {{param}} template — so no runtime data is baked into the artifact and
//     the capability is genuinely reusable.
//  2. Contract synthesis: extracts become declared outputs; the final URL
//     becomes the success condition; each step keeps the model's stated
//     intent so a reviewer can audit what the capability does and why.

import { randomUUID } from 'node:crypto';
import type { DiscoveryResult } from '../agent/loop.js';
import { CapabilityArtifact, type Detector, type Parameter, type Step } from './schema.js';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface RecorderInput {
  name: string;
  description: string;
  goal: string;
  entryUrl: string;
  params: Record<string, string | number>;
  sensitiveParams: string[];
  allowedOrigins: string[];
  appId: string;
  appDetectors: Detector[];
  model: string;
  discoveryRunId: string;
}

export function recordArtifact(input: RecorderInput, discovery: DiscoveryResult): CapabilityArtifact {
  if (discovery.status !== 'success') {
    throw new Error(`Cannot record artifact from a ${discovery.status} discovery run`);
  }

  // Longer values substitute first so overlapping params can't corrupt each other.
  const paramEntries = Object.entries(input.params).sort(
    (a, b) => String(b[1]).length - String(a[1]).length,
  );
  const templatize = (s: string): string => {
    let out = s;
    for (const [name, value] of paramEntries) out = out.split(String(value)).join(`{{${name}}}`);
    return out;
  };

  const parameters: Parameter[] = Object.entries(input.params).map(([name, value]) => ({
    name,
    type: typeof value === 'number' ? 'number' : 'string',
    description: `Value for ${name} (observed as "${input.sensitiveParams.includes(name) ? '***' : value}" during discovery)`,
    required: true,
    sensitive: input.sensitiveParams.includes(name),
  }));

  const steps: Step[] = discovery.trace.map((entry, i) => {
    const id = `s${i + 1}`;
    switch (entry.action) {
      case 'navigate':
        return { id, intent: templatize(entry.reason), action: 'navigate', url: templatize(entry.url!), risk: 'read', timeoutMs: 10_000 };
      case 'click':
        return { id, intent: templatize(entry.reason), action: 'click', target: entry.descriptor!, risk: 'read', timeoutMs: 10_000 };
      case 'fill':
        return { id, intent: templatize(entry.reason), action: 'fill', target: entry.descriptor!, value: templatize(entry.value!), risk: 'reversible_write', timeoutMs: 10_000 };
      case 'select':
        return { id, intent: templatize(entry.reason), action: 'select', target: entry.descriptor!, value: templatize(entry.value!), risk: 'reversible_write', timeoutMs: 10_000 };
      case 'extract':
        return { id, intent: templatize(entry.reason), action: 'extract', target: entry.descriptor!, extract: { output: entry.outputName! }, risk: 'read', timeoutMs: 10_000 };
    }
  });

  // Click targets whose text was a parameter value (e.g. a search-result link
  // showing the member number) also need templating.
  for (const step of steps) {
    if (!step.target) continue;
    step.target = {
      ...step.target,
      description: templatize(step.target.description),
      strategies: step.target.strategies.map((s) => {
        if (s.kind === 'text') return { ...s, text: templatize(s.text) };
        if (s.kind === 'role') return { ...s, name: templatize(s.name) };
        return s;
      }),
      snapshot: step.target.snapshot && {
        ...step.target.snapshot,
        text: step.target.snapshot.text && templatize(step.target.snapshot.text),
      },
    };
  }

  // Success condition: the flow verifiably ended where discovery ended.
  const finalPath = new URL(discovery.finalUrl).pathname;
  const successCondition = {
    kind: 'urlMatches' as const,
    pattern: `${escapeRegex(templatize(finalPath)).replace(/\\\{\\\{(\w+)\\\}\\\}/g, '{{$1}}')}$`,
  };

  const outputs = Object.keys(discovery.outputs).map((name) => ({
    name,
    type: 'string' as const,
    description: `Extracted during the flow (discovery observed: "${discovery.outputs[name]}")`,
  }));

  return CapabilityArtifact.parse({
    schemaVersion: 1,
    id: input.name,
    name: input.name,
    description: input.goal,
    version: '1.0.0',
    status: 'draft', // human review promotes to approved
    app: { appId: input.appId, entryUrl: templatize(input.entryUrl), allowedOrigins: input.allowedOrigins },
    parameters,
    outputs,
    steps,
    successCondition,
    detectors: input.appDetectors,
    provenance: {
      discoveredAt: new Date().toISOString(),
      model: input.model,
      discoveryRunId: input.discoveryRunId,
      goal: input.goal,
    },
  });
}

export function newRunId(): string {
  return randomUUID();
}
