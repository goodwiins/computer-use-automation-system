import { expect, it } from 'vitest';
import { fetchMissingRuns, RunWatch } from './run-watch.js';

type TestRun = { runId: string; state: string; memberIdentity?: { status: string } };

const run = (runId: string, state: string): TestRun => ({ runId, state });

it('bounds followed terminal runs while retaining the newest followed run', () => {
  const watch = new RunWatch<TestRun>({ maxEntries: 8 });
  for (let index = 0; index < 101; index += 1) {
    const runId = `completed-${index}`;
    watch.watch(runId);
    watch.observe(run(runId, 'success'));
  }
  watch.watch('new-active');

  const history = Array.from({ length: 7 }, (_, index) => ({ runId: `completed-${index + 94}` }));
  const missing = watch.missing(history, new Set(['new-active']));

  expect(watch.size).toBe(8);
  expect(watch.has('completed-0')).toBe(false);
  expect(watch.has('completed-100')).toBe(true);
  expect(missing).toEqual(['new-active']);
});

it('hard-bounds stale nonterminal observations instead of issuing an unbounded fallback batch', () => {
  const watch = new RunWatch<TestRun>({ maxEntries: 8 });
  for (let index = 0; index < 101; index += 1) {
    const runId = `stale-${index}`;
    watch.watch(runId);
    watch.observe(run(runId, 'running'));
  }
  watch.watch('new-active');

  const missing = watch.missing([], new Set(['new-active']));

  expect(watch.size).toBe(8);
  expect(missing).toHaveLength(8);
  expect(missing.at(-1)).toBe('new-active');
});

it('never evicts an older bound action or exact open review when terminal history is noisy', () => {
  const watch = new RunWatch<TestRun>({ maxEntries: 4 });
  const pinned = new Set(['held-parent', 'old-review']);
  watch.watch('held-parent', pinned);
  watch.observe(run('held-parent', 'success'));
  watch.watch('old-review', pinned);
  watch.observe(run('old-review', 'awaiting-human'));
  for (let index = 0; index < 100; index += 1) {
    const runId = `completed-${index}`;
    watch.watch(runId, pinned);
    watch.observe(run(runId, 'failure'));
  }

  const history = [{ runId: 'completed-98' }, { runId: 'completed-99' }];
  const missing = watch.missing(history, pinned);

  expect(watch.has('held-parent')).toBe(true);
  expect(watch.has('old-review')).toBe(true);
  expect(missing).toEqual(['held-parent', 'old-review']);
});

it('evicts a completed run only after its pending work is observed as finished', () => {
  const watch = new RunWatch<TestRun>({ maxEntries: 2 });
  watch.watch('linked-parent');
  watch.observe({ ...run('linked-parent', 'success'), memberIdentity: { status: 'pending' } });
  watch.watch('recent');
  watch.observe(run('recent', 'success'));

  watch.watch('newer');
  watch.observe(run('newer', 'success'));
  watch.prune(new Set());
  expect(watch.has('linked-parent')).toBe(true);

  watch.observe({ ...run('linked-parent', 'success'), memberIdentity: { status: 'verified' } });
  watch.watch('newest');
  watch.observe(run('newest', 'success'));
  watch.prune(new Set());
  expect(watch.has('linked-parent')).toBe(false);
});

it('reads missing runs in stable order with bounded concurrency and no retries', async () => {
  const ids = Array.from({ length: 9 }, (_, index) => `run-${index}`);
  let active = 0;
  let maximumActive = 0;
  const reads: string[] = [];
  const result = await fetchMissingRuns(ids, async id => {
    reads.push(id);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active -= 1;
    return { id };
  }, 3);

  expect(result).toEqual(ids.map(id => ({ id })));
  expect(reads).toEqual(ids);
  expect(maximumActive).toBe(3);
});

it('forgets a closed review watch without removing a separately followed run', () => {
  const watch = new RunWatch<TestRun>({ maxEntries: 4 });
  watch.watch('followed');
  watch.watch('review-only', new Set(['review-only']));
  watch.forget('review-only');
  expect([...watch.ids]).toEqual(['followed']);
  expect(watch.missing([], new Set())).toEqual(['followed']);
});

it('stops scheduling after a fallback read fails and waits for started reads to settle', async () => {
  const started: string[] = [];
  let releaseSecond!: () => void;
  const second = new Promise<void>(resolve => { releaseSecond = resolve; });
  const reads = fetchMissingRuns(['run-0', 'run-1', 'run-2'], async id => {
    started.push(id);
    if (id === 'run-0') {
      await Promise.resolve();
      throw new Error('read failed');
    }
    await second;
    return id;
  }, 2);
  let settled = false;
  const failure = reads.catch(() => { settled = true; });

  await new Promise(resolve => setTimeout(resolve, 0));
  expect(started).toEqual(['run-0', 'run-1']);
  expect(settled).toBe(false);
  releaseSecond();
  await failure;
  expect(started).toEqual(['run-0', 'run-1']);
});
