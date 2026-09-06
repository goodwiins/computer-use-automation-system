import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const RecordSchema = z.object({
  kind: z.enum(['discovery', 'replay']).default('replay'),
  runId: z.string().uuid(), caller: z.string(), capability: z.string(), version: z.string(),
  request: z.string(), identity: z.string(), createdAt: z.string(),
  state: z.enum(['reserved', 'running', 'dispatching', 'success', 'business_outcome', 'failure', 'interrupted', 'POST_OUTCOME_UNKNOWN']),
});
export type JournalRecord = z.infer<typeof RecordSchema>;
const AliasSchema = z.object({
  caller: z.string(), identity: z.string().regex(/^[a-f0-9]{64}$/),
  request: z.string().regex(/^[a-f0-9]{64}$/), runId: z.string().uuid(),
}).strict();
type RequestAlias = z.infer<typeof AliasSchema>;
export class RequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function validateIdempotencyKey(key: string): void {
  if (!/^[\x21-\x7e]{1,200}$/.test(key)) {
    throw new RequestError(400, 'A valid Idempotency-Key is required');
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}

function readEnvelope(path: string, key: string): unknown {
  if (key.length < 32) throw new Error('JOURNAL_HMAC_KEY requires at least 32 characters');
  const envelope = JSON.parse(readFileSync(path, 'utf8'));
  const actual = Buffer.from(createHmac('sha256', key).update(canonical(envelope.record)).digest('hex'));
  const signature = Buffer.from(String(envelope.signature));
  if (actual.length !== signature.length || !timingSafeEqual(actual, signature)) throw new Error('Journal authentication failed');
  return envelope.record;
}

/** Authenticate a snapshot without acquiring a lock or recovering/mutating it. */
export function readJournalRecord(dir: string, runId: string, key: string): JournalRecord {
  z.string().uuid().parse(runId);
  const record = RecordSchema.parse(readEnvelope(join(dir, `${runId}.json`), key));
  if (record.runId !== runId) throw new Error('Journal filename mismatch');
  return record;
}

/** One process per journal; all writes and decisions serialize on the JS event loop. */
export class Journal {
  readonly records = new Map<string, JournalRecord>();
  private readonly aliases = new Map<string, RequestAlias>();
  private readonly lock: string;
  private closed = false;
  private writeFailure?: Error;
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
        const record = readJournalRecord(dir, file.slice(0, -5), this.key);
        this.records.set(record.runId, record);
        if (['reserved', 'running', 'dispatching'].includes(record.state)) {
          this.update(record.runId, record.state === 'dispatching' ? 'POST_OUTCOME_UNKNOWN' : 'interrupted');
        }
      }
      const aliasesDir = join(dir, 'aliases');
      if (existsSync(aliasesDir)) for (const file of readdirSync(aliasesDir).filter(file => file.endsWith('.json'))) {
        const alias = AliasSchema.parse(readEnvelope(join(aliasesDir, file), key));
        const target = this.records.get(alias.runId);
        if (file !== `${alias.identity}.json` || !target || target.caller !== alias.caller || target.request !== alias.request
          || [...this.records.values()].some(record => record.identity === alias.identity))
          throw new Error('Invalid journal request alias');
        this.aliases.set(alias.identity, alias);
      }
    } catch (error) { this.close(); throw error; }
  }
  private mac(value: unknown) { return createHmac('sha256', this.key).update(canonical(value)).digest('hex'); }
  private syncDir(dir = this.dir) { const fd = openSync(dir, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
  private persistEnvelope(path: string, record: unknown) {
    if (this.closed) throw new Error('Journal is closed');
    if (this.writeFailure) throw this.writeFailure;
    const tmp = `${path}.${randomUUID()}.tmp`;
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ record, signature: this.mac(record) })); fsyncSync(fd); } finally { closeSync(fd); }
    try {
      renameSync(tmp, path);
      this.syncDir(dirname(path));
    } catch (error) {
      // Publication may have occurred. Reject further writes/lookups until restart authenticates disk state.
      this.writeFailure = new Error('Journal write outcome uncertain; restart required');
      throw error;
    }
  }
  private persist(record: JournalRecord) {
    this.persistEnvelope(join(this.dir, `${record.runId}.json`), record);
    this.records.set(record.runId, record);
  }
  bindReference(caller: string, key: string, runId: string) {
    validateIdempotencyKey(key);
    const target = this.records.get(runId);
    if (!target || target.caller !== caller) throw new RequestError(403, 'Run belongs to another principal');
    const existing = this.findRequest(caller, key);
    if (existing) {
      if (existing.runId !== runId || existing.identity === this.mac({ caller, key })) throw new RequestError(409, 'Idempotency key already identifies another request');
      return;
    }
    const identity = this.mac({ caller, key });
    const alias = { caller, identity, request: target.request, runId };
    const dir = join(this.dir, 'aliases');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.syncDir();
    this.persistEnvelope(join(dir, `${identity}.json`), alias);
    this.aliases.set(identity, alias);
  }
  findRequest(caller: string, key: string) {
    if (this.writeFailure) throw this.writeFailure;
    const identity = this.mac({ caller, key });
    const direct = [...this.records.values()].find(record => record.identity === identity);
    const alias = this.aliases.get(identity);
    return direct ?? (alias ? this.records.get(alias.runId) : undefined);
  }
  lookup(caller: string, key: string, request: unknown) {
    validateIdempotencyKey(key);
    const identity = this.mac({ caller, key }), digest = this.mac(request);
    const existing = this.findRequest(caller, key);
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
    if (!['reserved', 'running', 'dispatching'].includes(record.state)) {
      if (record.state === state) return;
      throw new Error('Terminal journal state cannot be changed');
    }
    if (record.state === 'dispatching') {
      if (state === 'reserved' || state === 'running') throw new Error('Dispatch intent cannot be cleared');
      if (state === 'failure' || state === 'interrupted') state = 'POST_OUTCOME_UNKNOWN';
    }
    this.persist({ ...record, state });
  }
  close() { if (!this.closed) { this.closed = true; unlinkSync(this.lock); this.syncDir(); } }
}
