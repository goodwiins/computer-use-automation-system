export type WatchedRun = {
  runId: string;
  state: string;
  memberIdentity?: { status?: string };
};

type WatchEntry<Run extends WatchedRun> = { lastRun?: Run };

const ACTIVE_STATES = new Set([
  'accepted', 'reserved', 'running', 'dispatching', 'recovering', 'awaiting-human',
]);

function remainsRelevant(run: WatchedRun): boolean {
  return ACTIVE_STATES.has(run.state) || run.memberIdentity?.status === 'pending';
}

export class RunWatch<Run extends WatchedRun = WatchedRun> {
  private readonly entries = new Map<string, WatchEntry<Run>>();
  private readonly watched = new Set<string>();
  private readonly maxEntries: number;
  private pinned = new Set<string>();

  constructor(options: { maxEntries: number }) {
    if (!Number.isInteger(options.maxEntries) || options.maxEntries < 1) {
      throw new Error('Run watch capacity must be a positive integer');
    }
    this.maxEntries = options.maxEntries;
  }

  get ids(): ReadonlySet<string> {
    return this.watched;
  }

  get size(): number {
    return this.entries.size;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  forget(id: string): void {
    this.entries.delete(id);
    this.watched.delete(id);
    this.pinned.delete(id);
  }

  clear(): void {
    this.entries.clear();
    this.watched.clear();
    this.pinned.clear();
  }

  watch(id: string, pinned: ReadonlySet<string> = this.pinned): void {
    const current = this.entries.get(id);
    this.entries.delete(id);
    this.entries.set(id, current ?? {});
    this.watched.delete(id);
    this.watched.add(id);
    this.prune(pinned);
  }

  observe(run: Run): void {
    const entry = this.entries.get(run.runId);
    if (entry) entry.lastRun = run;
  }

  prune(pinned: ReadonlySet<string>): void {
    this.pinned = new Set(pinned);
    const protectedIds = new Set([...this.entries.keys()].filter(id => pinned.has(id)));
    const capacity = Math.max(0, this.maxEntries - protectedIds.size);
    const candidates = [...this.entries.entries()]
      .filter(([id]) => !protectedIds.has(id))
      .map(([id, entry], order) => ({ id, order, priority: !entry.lastRun ? 3 : remainsRelevant(entry.lastRun) ? 2 : 1 }))
      .sort((left, right) => right.priority - left.priority || right.order - left.order);
    const keep = new Set([...protectedIds, ...candidates.slice(0, capacity).map(candidate => candidate.id)]);
    for (const id of this.entries.keys()) {
      if (keep.has(id)) continue;
      this.entries.delete(id);
      this.watched.delete(id);
    }
  }

  missing(history: readonly Pick<Run, 'runId'>[], pinned: ReadonlySet<string>): string[] {
    this.prune(pinned);
    const present = new Set(history.map(run => run.runId));
    return [...this.entries.keys()].filter(id => !present.has(id));
  }
}

export async function fetchMissingRuns<T>(
  ids: readonly string[],
  read: (id: string) => Promise<T>,
  maxConcurrency: number,
): Promise<T[]> {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error('Run watch concurrency must be a positive integer');
  }
  const results = new Array<T | undefined>(ids.length);
  let next = 0;
  let failed = false;
  let failure: unknown;
  async function worker(): Promise<void> {
    while (!failed && next < ids.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await read(ids[index]!);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
        return;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(maxConcurrency, ids.length) }, () => worker()));
  if (failed) throw failure;
  return results as T[];
}
