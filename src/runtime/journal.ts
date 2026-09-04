import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

const RecordSchema = z.object({
  kind: z.enum(['discovery', 'replay']).default('replay'),
  runId: z.string().uuid(), caller: z.string(), capability: z.string(), version: z.string(),
  request: z.string(), identity: z.string(), createdAt: z.string(),
  state: z.enum(['reserved', 'running', 'dispatching', 'success', 'business_outcome', 'failure', 'interrupted', 'POST_OUTCOME_UNKNOWN']),
});
export type JournalRecord = z.infer<typeof RecordSchema>;
export class RequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** One process per journal; all writes and decisions serialize on the JS event loop. */
export class Journal {
  readonly records = new Map<string, JournalRecord>();
  private readonly lock: string;
  private closed = false;
  constructor(readonly dir: string, private readonly key: string) {
    if (key.length < 32) throw new Error('JOURNAL_HMAC_KEY requires at least 32 characters');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.lock = join(dir, 'server.lock');
    // ponytail: a crash inside startup needs operator lock cleanup; use OS
    // advisory locks if unattended recovery from this window is required.
    const startup = join(dir, 'startup.lock');
    const startupFd = openSync(startup, 'wx', 0o600);
    try {
      if (existsSync(this.lock)) {
        const pid = Number(readFileSync(this.lock, 'utf8'));
        if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid journal lock; operator inspection required');
        try { process.kill(pid, 0); throw new Error('Journal already in use'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
        unlinkSync(this.lock);
      }
      const fd = openSync(this.lock, 'wx', 0o600);
      try { writeFileSync(fd, String(process.pid)); fsyncSync(fd); } finally { closeSync(fd); }
      this.syncDir();
    } finally { closeSync(startupFd); unlinkSync(startup); }
    try {
      for (const file of readdirSync(dir).filter(f => f.endsWith('.json'))) {
        const envelope = JSON.parse(readFileSync(join(dir, file), 'utf8'));
        const actual = Buffer.from(this.mac(envelope.record));
        const signature = Buffer.from(String(envelope.signature));
        if (actual.length !== signature.length || !timingSafeEqual(actual, signature)) throw new Error('Journal authentication failed');
        const record = RecordSchema.parse(envelope.record);
        if (file !== `${record.runId}.json`) throw new Error('Journal filename mismatch');
        this.records.set(record.runId, record);
        if (['reserved', 'running', 'dispatching'].includes(record.state)) {
          this.update(record.runId, record.state === 'dispatching' ? 'POST_OUTCOME_UNKNOWN' : 'interrupted');
        }
      }
    } catch (error) { this.close(); throw error; }
  }
  private mac(value: unknown) { return createHmac('sha256', this.key).update(canonical(value)).digest('hex'); }
  private syncDir() { const fd = openSync(this.dir, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
  private persist(record: JournalRecord) {
    if (this.closed) throw new Error('Journal is closed');
    const path = join(this.dir, `${record.runId}.json`), tmp = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ record, signature: this.mac(record) })); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path); this.syncDir();
    this.records.set(record.runId, record);
  }
  lookup(caller: string, key: string, request: unknown) {
    if (!/^[\x21-\x7e]{1,200}$/.test(key)) throw new RequestError(400, 'A valid Idempotency-Key is required');
    const identity = this.mac({ caller, key }), digest = this.mac(request);
    const existing = [...this.records.values()].find(r => r.identity === identity);
    if (existing && existing.request !== digest) throw new RequestError(409, 'Idempotency key already identifies another request');
    return { existing, identity, digest };
  }
  reserve(caller: string, key: string, capability: string, version: string, request: unknown, kind: 'discovery' | 'replay' = 'replay') {
    const { existing, identity, digest } = this.lookup(caller, key, request);
    if (existing) return existing;
    const record: JournalRecord = { kind, runId: randomUUID(), caller, capability, version, request: digest, identity, createdAt: new Date().toISOString(), state: 'reserved' };
    this.persist(record); return record;
  }
  update(runId: string, state: JournalRecord['state']) {
    const record = this.records.get(runId);
    if (!record) throw new Error('Unknown journal run');
    this.persist({ ...record, state });
  }
  close() { if (!this.closed) { this.closed = true; unlinkSync(this.lock); this.syncDir(); } }
}
