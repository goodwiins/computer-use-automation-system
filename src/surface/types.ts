// The Surface is the seam between "how we perceive/act on a UI" and
// everything above it (discovery loop, replay executor, recorder). The
// artifact schema speaks only in Surface terms — so a desktop implementation
// (OS accessibility APIs) or a screenshot+coordinates implementation can slot
// in without touching artifacts or the replay engine.

import type { TargetDescriptor } from '../artifact/schema.js';

export interface FrameObservation {
  frame: string; // '' = main frame
  snapshot: string; // accessibility-tree text (aria snapshot)
}

export interface Observation {
  url: string;
  title: string;
  frames: FrameObservation[];
}

/** How a target was actually found — logged for drift diagnostics. */
export interface ResolutionReport {
  strategyUsed: number; // index into descriptor.strategies
  kind: string;
  matches: number;
}

export class TargetResolutionError extends Error {
  constructor(
    public readonly descriptor: TargetDescriptor,
    public readonly attempts: Array<{ kind: string; matches: number }>,
  ) {
    super(
      `Could not uniquely resolve target "${descriptor.description}": ` +
        attempts.map((a) => `${a.kind}=${a.matches}`).join(', '),
    );
  }
}

export interface Surface {
  start(entryUrl: string): Promise<void>;
  observe(): Promise<Observation>;
  currentUrl(): string;

  navigate(url: string): Promise<void>;
  click(target: TargetDescriptor, timeoutMs?: number): Promise<ResolutionReport>;
  fill(target: TargetDescriptor, value: string, timeoutMs?: number): Promise<ResolutionReport>;
  select(target: TargetDescriptor, value: string, timeoutMs?: number): Promise<ResolutionReport>;
  readText(target: TargetDescriptor, timeoutMs?: number): Promise<{ text: string; report: ResolutionReport }>;
  isTextVisible(text: string, frame?: string): Promise<boolean>;

  /** Build a robust TargetDescriptor from whatever hint found the element. */
  describeTarget(hint: TargetDescriptor): Promise<TargetDescriptor>;

  screenshot(path: string): Promise<void>;
  close(): Promise<void>;
}
