// Turns a successful discovery trace into a capability artifact. Two jobs:
//  1. Parameterization: every occurrence of an invocation parameter's concrete
//     value (in URLs, filled values, the success condition) becomes a
//     {{param}} template — so no runtime data is baked into the artifact and
//     the capability is genuinely reusable.
//  2. Contract synthesis: extracts become declared outputs; the final URL
//     becomes the success condition; each step keeps the model's stated
//     intent so a reviewer can audit what the capability does and why.

import type { DiscoveryResult } from '../agent/loop.js';
import { CapabilityArtifact, type Detector, type Parameter, type Step } from './schema.js';

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const RISK_RANK: Record<Step['risk'], number> = { read: 0, reversible_write: 1, irreversible: 2 };

// Commit-shaped control text implies a risk floor regardless of what the
// model claimed — a downlabeled irreversible click would sail through the
// policy gate unattended.
const IRREVERSIBLE_TEXT_RE =
  /\b(open account|open a|commit|finalize|confirm (?:the )?(?:transfer|order|payment)|delete|remove|approve|post(?:ing)? the|submit transfer|pay now)\b/i;
const SUBMIT_ROLE_RE = /^(button|submit)$/;

/**
 * Risk floor implied by the element itself (from the discovery snapshot).
 * Returns null when the element implies nothing beyond a read (e.g. links).
 */
export function riskFloorFor(descriptor: { snapshot?: { tag?: string; role?: string; text?: string } }): Step['risk'] | null {
  const snap = descriptor.snapshot;
  if (!snap) return null;
  const isButtonish = snap.tag === 'button' || SUBMIT_ROLE_RE.test(snap.role ?? '') ||
    (snap.tag === 'input' && SUBMIT_ROLE_RE.test(snap.role ?? ''));
  if (!isButtonish) return null;
  if (IRREVERSIBLE_TEXT_RE.test(snap.text ?? '')) return 'irreversible';
  return 'reversible_write';
}

function floorRisk(modelRisk: Step['risk'], descriptor: { snapshot?: { tag?: string; role?: string; text?: string } }): Step['risk'] {
  const floor = riskFloorFor(descriptor);
  if (!floor) return modelRisk;
  return RISK_RANK[modelRisk] >= RISK_RANK[floor] ? modelRisk : floor;
}

export interface RecorderInput {
  name: string;
  description: string;
  goal: string;
  entryUrl: string;
  params: Record<string, string | number>;
  sensitiveParams: string[];
  serverParams?: string[];
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
  const substitute = (s: string, entries: typeof paramEntries): string => {
    let out = s;
    for (const [name, value] of entries) if (String(value)) out = out.split(String(value)).join(`{{${name}}}`);
    return out;
  };
  const templatize = (s: string): string => substitute(s, paramEntries);

  // Regex syntax can encode a value without containing its literal spelling.
  // Keep a small grammar: generic escapes/classes stay opaque, deterministic
  // literals can be templated, and unsupported encodings fail closed.
  // ponytail: regex projection is intentionally bounded; extend the grammar only for a reviewed pattern.
  const safeRegexPattern = (pattern: string): string => {
    const genericEscapes = 'dDsSwWbB';
    const literalEscapes = '\\^$.*+?()[\]{}|\/-';
    const controlEscapes: Record<string, string> = { n: '\n', r: '\r', t: '\t', f: '\f', v: '\v' };
    type Projection = { char: string; start: number; end: number } | null;
    const projection: Projection[] = [];
    const protectedSpans: Array<{ start: number; end: number }> = [];
    const protect = (start: number, end: number) => protectedSpans.push({ start, end });
    const classEnd = (start: number): number => {
      for (let i = start + 1; i < pattern.length; i++) {
        if (pattern[i] === '\\') i++;
        else if (pattern[i] === ']') return i;
      }
      throw new Error('Cannot record parameter-dependent regex patterns with an unterminated class');
    };
    const exactClass = (body: string): string | undefined => {
      if (/^[A-Za-z0-9]$/.test(body)) return body;
      const range = /^([A-Za-z0-9])-\1$/.exec(body);
      return range?.[1];
    };
    // A class with more than one possible character is generic for this
    // boundary. Singleton classes and equal-character ranges are handled by
    // `exactClass` above because they can encode a parameter one character at
    // a time; preserving every other class keeps existing captures such as
    // `[^|]` and `[?#]` usable without trying to interpret class semantics.
    const genericClass = (body: string): boolean => !exactClass(body);

    for (const match of pattern.matchAll(/\\([A-Za-z0-9])/g)) {
      if (!genericEscapes.includes(match[1]!) && !Object.hasOwn(controlEscapes, match[1]!)) {
        throw new Error('Cannot record parameter-dependent regex patterns with unsupported escapes');
      }
    }

    for (let i = 0; i < pattern.length;) {
      const placeholder = /^\{\{\w+\}\}/.exec(pattern.slice(i));
      if (placeholder) {
        protect(i, i + placeholder[0].length);
        projection.push(null);
        i += placeholder[0].length;
        continue;
      }
      const char = pattern[i]!;
      if (char === '\\') {
        const next = pattern[i + 1];
        if (!next) throw new Error('Cannot record parameter-dependent regex patterns with a trailing escape');
        if (genericEscapes.includes(next)) projection.push(null);
        else if (Object.hasOwn(controlEscapes, next)) projection.push({ char: controlEscapes[next]!, start: i, end: i + 2 });
        else if (literalEscapes.includes(next)) projection.push({ char: next, start: i, end: i + 2 });
        else throw new Error('Cannot record parameter-dependent regex patterns with unsupported escapes');
        protect(i, i + 2);
        i += 2;
        continue;
      }
      if (char === '[') {
        const end = classEnd(i);
        const body = pattern.slice(i + 1, end);
        const literal = exactClass(body);
        if (literal) projection.push({ char: literal, start: i, end: end + 1 });
        else if (genericClass(body)) projection.push(null);
        else throw new Error('Cannot record parameter-dependent regex patterns with unsupported classes');
        protect(i, end + 1);
        i = end + 1;
        continue;
      }
      if (char === '(') {
        i++;
        if (pattern[i] === '?') {
          if (![':', '=', '!', '>'].includes(pattern[i + 1] ?? '')) throw new Error('Cannot record parameter-dependent regex patterns with unsupported groups');
          i += 2;
        }
        continue;
      }
      if (char === ')' || char === '^' || char === '$') {
        i++;
        continue;
      }
      if (char === '|') {
        projection.push(null);
        i++;
        continue;
      }
      if (char === '{') {
        const end = pattern.indexOf('}', i + 1);
        if (end < 0) throw new Error('Cannot record parameter-dependent regex patterns with an unterminated quantifier');
        const quantifier = pattern.slice(i + 1, end);
        const previous = projection.at(-1);
        if (/^\d+$/.test(quantifier) && previous && Number(quantifier) > 1 && Number(quantifier) <= 32) {
          for (let repeat = 1; repeat < Number(quantifier); repeat++) projection.push({ ...previous });
        } else if (!/^\d+$/.test(quantifier)) {
          projection.push(null);
        }
        protect(i, end + 1);
        i = end + 1;
        continue;
      }
      if ('*+?.'.includes(char)) {
        projection.push(null);
        i++;
        continue;
      }
      projection.push({ char, start: i, end: i + 1 });
      i++;
    }

    for (const [name, value] of paramEntries) {
      const v = String(value);
      if (!v) continue;
      const hasSafeRawOccurrence = (startAt: number): boolean => {
        for (let start = pattern.indexOf(v, startAt); start >= 0; start = pattern.indexOf(v, start + 1)) {
          const end = start + v.length;
          if (!protectedSpans.some(span => start < span.end && end > span.start)) return true;
        }
        return false;
      };
      const hasSafeLiteralOccurrence = hasSafeRawOccurrence(0);
      for (let start = 0; start <= projection.length - v.length; start++) {
        const run = projection.slice(start, start + v.length);
        if (run.length !== v.length || run.some((part) => !part) || run.map((part) => (part as Exclude<Projection, null>).char).join('') !== v) continue;
        const rawStart = (run[0] as Exclude<Projection, null>).start;
        const rawEnd = (run.at(-1) as Exclude<Projection, null>).end;
        if (pattern.slice(rawStart, rawEnd) !== v) {
          throw new Error(`Cannot record parameter-dependent regex pattern containing encoded parameter "${name}"`);
        }
      }
      // If a value's characters occur in separate literal tokens, the
      // pattern may still encode the value through groups, alternation, or
      // other regex structure that this small grammar does not interpret.
      // Keep direct raw occurrences usable, but fail closed on any such
      // fragment rather than allowing a partial secret to remain in the
      // artifact.
      if (!hasSafeLiteralOccurrence && projection.some(part => part !== null && v.includes(part.char))) {
        throw new Error(`Cannot record parameter-dependent regex pattern containing encoded parameter "${name}"`);
      }
    }

    let templated = '';
    let cursor = 0;
    for (const span of protectedSpans.sort((a, b) => a.start - b.start)) {
      templated += templatize(pattern.slice(cursor, span.start)) + pattern.slice(span.start, span.end);
      cursor = span.end;
    }
    return templated + templatize(pattern.slice(cursor));
  };

  // Never splice runtime data into CSS syntax. Keep only invariant strategies.
  const safeCss = (selector: string): boolean => {
    const decoded = selector.replace(/\\(?:\r\n|[\n\r\f])/g, '').replace(/\\([0-9a-f]{1,6})\s?|\\([^\n\r\f])/gi,
      (_, hex: string | undefined, char: string) => hex ? (() => { const code = parseInt(hex, 16); return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff) ? '\ufffd' : String.fromCodePoint(code); })() : char);
    if (decoded.includes('{{')) return false;
    // Structural indices are not invocation data; sensitive values still fail closed.
    const semantic = decoded.replace(/:nth-(?:of-type|child)\(\d+\)/g, '');
    return !paramEntries.some(([name, value]) => String(value) &&
      ((input.sensitiveParams.includes(name) ? decoded : semantic).includes(String(value)) || selector.includes(String(value)) && input.sensitiveParams.includes(name)));
  };

  const valueTemplate = (entry: DiscoveryResult['trace'][number]) => {
    const matches = paramEntries.filter(([, value]) => String(value) === entry.value);
    if (matches.length === 1) return `{{${matches[0]![0]}}}`;
    if (matches.length > 1) {
      const field = entry.descriptor?.strategies.find(s => s.kind === 'nameAttr');
      const match = matches.find(([name]) => field?.kind === 'nameAttr' && field.name === name);
      if (match) return `{{${match[0]}}}`;
      throw new Error('Cannot record an ambiguous parameter binding');
    }
    return templatize(entry.value!);
  };

  const parameters: Parameter[] = Object.entries(input.params).map(([name, value]) => ({
    name,
    type: typeof value === 'number' ? 'number' : 'string',
    description: `Invocation parameter "${name}"`,
    required: true,
    sensitive: input.sensitiveParams.includes(name),
    ...(input.serverParams?.includes(name) ? { source: 'server' as const } : {}),
  }));

  const steps: Step[] = discovery.trace.map((entry, i) => {
    const id = `s${i + 1}`;
    switch (entry.action) {
      case 'assert':
        return { id, intent: templatize(entry.reason), action: 'assert', assert: entry.assert!.kind === 'textVisible' ? { ...entry.assert!, text: templatize(entry.assert!.text) } : { ...entry.assert!, pattern: safeRegexPattern(entry.assert!.pattern) }, risk: 'read', timeoutMs: 10_000 };
      case 'navigate':
        return { id, intent: templatize(entry.reason), action: 'navigate', url: templatize(entry.url!), risk: 'read', timeoutMs: 10_000 };
      case 'click':
        return { id, intent: templatize(entry.reason), action: 'click', target: entry.descriptor!, risk: floorRisk(entry.risk ?? 'read', entry.descriptor!), timeoutMs: 10_000 };
      case 'fill':
        return { id, intent: templatize(entry.reason), action: 'fill', target: entry.descriptor!, value: valueTemplate(entry), risk: 'reversible_write', timeoutMs: 10_000 };
      case 'select':
        return { id, intent: templatize(entry.reason), action: 'select', target: entry.descriptor!, value: valueTemplate(entry), selectBy: entry.selectBy, risk: 'reversible_write', timeoutMs: 10_000 };
      case 'extract':
        return { id, intent: templatize(entry.reason), action: 'extract', target: entry.descriptor!, extract: { output: entry.outputName!, columns: input.appId === 'meridian' ? entry.columns?.map(c => ({ ...c, sensitive: true })) : entry.columns, pattern: entry.pattern === undefined ? undefined : safeRegexPattern(entry.pattern), rowSelector: entry.rowSelector }, risk: 'read', timeoutMs: 10_000 };
    }
  });

  // Click targets whose text was a parameter value (e.g. a search-result link
  // showing the member number) also need templating.
  for (const step of steps) {
    if (step.extract && ((step.extract.rowSelector && !safeCss(step.extract.rowSelector)) || step.extract.columns?.some(c => !safeCss(c.selector)))) throw new Error('Cannot record parameter-dependent table selectors');
    if (!step.target) continue;
    step.target = {
      ...step.target,
      description: templatize(step.target.description),
      strategies: step.target.strategies.filter((s) => s.kind !== 'css' || safeCss(s.selector)).map((s) => {
        if (s.kind === 'text') return { ...s, text: templatize(s.text) };
        if (s.kind === 'role') return { ...s, name: templatize(s.name) };
        return s;
      }),
      snapshot: step.target.snapshot && {
        ...step.target.snapshot,
        text: step.target.snapshot.text && templatize(step.target.snapshot.text),
      },
    };
    if (!step.target.strategies.length) throw new Error('Cannot record artifact: no safe target strategy remains');
  }

  // Success condition: the flow verifiably ended where discovery ended.
  const finalLocation = new URL(discovery.finalUrl);
  const finalPath = finalLocation.pathname;
  const ending = finalLocation.search || finalLocation.hash ? '(?:[?#].*)?$' : '$';
  const successCondition = {
    kind: 'urlMatches' as const,
    pattern: `${escapeRegex(templatize(finalPath)).replace(/\\\{\\\{(\w+)\\\}\\\}/g, '{{$1}}')}${ending}`,
  };

  // Find which step extracted each output, for a description that carries no
  // observed values (PII may have been extracted during discovery).
  const outputStepId = (name: string): string =>
    steps.find((s) => s.action === 'extract' && s.extract?.output === name)?.id ?? '?';
  const outputs = [...new Set(steps.flatMap((s) => s.extract ? [s.extract.output] : []))].map((name) => ({
    name,
    type: steps.find(s => s.extract?.output === name)?.extract?.columns ? 'table' as const : 'string' as const,
    columns: steps.find(s => s.extract?.output === name)?.extract?.columns,
    sensitive: input.appId === 'meridian',
    description: `Extracted during the flow at step ${outputStepId(name)}`,
  }));

  return CapabilityArtifact.parse({
    schemaVersion: input.appId === 'meridian' || steps.some(s => s.selectBy || s.extract?.columns || s.extract?.pattern) ? 2 : 1,
    id: input.name,
    name: input.name,
    description: templatize(input.goal),
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
      goal: templatize(input.goal),
    },
  });
}
