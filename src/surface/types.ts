import type { FrameContext, LiveControl } from '../runtime/profile.js';
// The Surface is the seam between "how we perceive/act on a UI" and
// everything above it (discovery loop, replay executor, recorder). The
// artifact schema speaks only in Surface terms — so a desktop implementation
// (OS accessibility APIs) or a screenshot+coordinates implementation can slot
// in without touching artifacts or the replay engine.

import type { RiskClass, TargetDescriptor, TableColumn } from '../artifact/schema.js';

export interface FrameObservation {
  frame: string; // '' = main frame
  snapshot: string; // accessibility-tree text (aria snapshot)
  // Form controls by name attribute. Legacy inputs rarely have accessible
  // names (no <label>), so the aria snapshot alone leaves them anonymous —
  // this is the reliable handle for them.
  fields: Array<{ name: string; type: string }>;
  tables?: Array<{ selector: string; headers: string[]; headerCells: string[]; rows: number }>;
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
  prepareClick?(target: TargetDescriptor, timeoutMs?: number): Promise<{ inspect(timeoutMs?: number): Promise<LiveControl>; dispatch(expected: LiveControl, timeoutMs?: number): Promise<ResolutionReport> }>;
  mutationDispatched?: boolean;
  effectiveRisk?: RiskClass;
  setStep?(id: string): void;
  readTable?(target: TargetDescriptor, columns: TableColumn[], timeoutMs?: number, rowSelector?: string): Promise<Array<Record<string, string>>>;
  start(entryUrl: string): Promise<void>;
  observe(): Promise<Observation>;
  currentUrl(): string;
  /** Identity of the current working frame, when the surface has frame state. */
  currentFrame?(): FrameContext | undefined;
  /** Identity of the frame used by the most recent target resolution. */
  lastResolvedFrame?(): FrameContext | undefined;
  /** URL of every live frame (top included) — bounds checks must cover all of them. */
  frameUrls(): string[];

  navigate(url: string): Promise<void>;
  // `risk` is consumed by guarding implementations to route through the
  // policy gate; unguarded implementations ignore it.
  /** Guarded recovery only: explicit reversible-write risk, no mutation or approval. */
  recoverClick?(target: TargetDescriptor, timeoutMs?: number): Promise<ResolutionReport>;
  click(target: TargetDescriptor, timeoutMs?: number, risk?: RiskClass): Promise<ResolutionReport>;
  fill(target: TargetDescriptor, value: string, timeoutMs?: number, risk?: RiskClass): Promise<ResolutionReport>;
  select(target: TargetDescriptor, value: string, timeoutMs?: number, risk?: RiskClass, selectBy?: 'label' | 'value'): Promise<ResolutionReport>;
  readText(target: TargetDescriptor, timeoutMs?: number): Promise<{ text: string; report: ResolutionReport }>;
  isTextVisible(text: string, frame?: string): Promise<boolean>;

  /** Build a robust TargetDescriptor from whatever hint found the element. */
  describeTarget(hint: TargetDescriptor, timeoutMs?: number): Promise<TargetDescriptor>;

  screenshot(path: string, opts?: { maskValues?: string[] }): Promise<void>;
  close(): Promise<void>;

  /**
   * Native dialogs (alert/confirm/prompt/beforeunload) the surface dismissed
   * since the last call. Optional: surfaces without a dialog concept omit it.
   */
  drainDialogs?(): Array<{ type: string; message: string }>;
}
