import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

const RecordSchema = z.object({
  kind: z.enum(['discovery', 'replay']).default('replay'),
  runId: z.string().uuid(), caller: z.string(), capability: z.string(), version: z.string(),
  request: z.string(), identity: z.string(), createdAt: z.string(),
  recoveryRequest: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  invocationScope: z.enum(['public', 'member-identity']).optional(),
  state: z.enum(['reserved', 'running', 'dispatching', 'success', 'business_outcome', 'failure', 'interrupted', 'POST_OUTCOME_UNKNOWN']),
});
export type JournalRecord = z.infer<typeof RecordSchema>;
export type InvocationScope = 'public' | 'member-identity';
export type ReservationOptions = { invocationScope?: InvocationScope; recoveryRequest?: unknown };
const AliasSchema = z.object({
  caller: z.string(), identity: z.string().regex(/^[a-f0-9]{64}$/),
  request: z.string().regex(/^[a-f0-9]{64}$/), runId: z.string().uuid(),
}).strict();
export type RequestAlias = z.infer<typeof AliasSchema>;
export type JournalSnapshot = { records: JournalRecord[]; aliases: RequestAlias[] };
export type Awaitable<T> = T | Promise<T>;
export type JournalLookup = { existing?: JournalRecord; identity: string; digest: string };
export type JournalRecoveryLookup = { existing?: JournalRecord; matches: boolean; direct: boolean };
export interface RunJournal {
  get(runId: string): Awaitable<JournalRecord | undefined>;
  getMany(runIds: readonly string[]): Awaitable<Map<string, JournalRecord>>;
  list(): Awaitable<JournalRecord[]>;
  hasUnknown(capability: string): Awaitable<boolean>;
  lookup(caller: string, key: string, request: unknown): Awaitable<JournalLookup>;
  recover(caller: string, key: string, request: unknown): Awaitable<JournalRecoveryLookup>;
  findRequest(caller: string, key: string): Awaitable<JournalRecord | undefined>;
  reserve(caller: string, key: string, capability: string, version: string, request: unknown,
    kind?: 'discovery' | 'replay', options?: ReservationOptions): Awaitable<JournalRecord>;
  bindReference(caller: string, key: string, runId: string): Awaitable<void>;
  update(runId: string, state: JournalRecord['state']): Awaitable<void>;
  assertHealthy(): void;
  close(): Awaitable<void>;
}
export class RequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function validateIdempotencyKey(key: string): void {
  if (!/^[\x21-\x7e]{1,200}$/.test(key)) {
    throw new RequestError(400, 'A valid Idempotency-Key is required');
  }
}
export const MAX_RUN_BATCH = 100;
const BatchRunIds = z.array(z.string().uuid().refine(value => value === value.toLowerCase())).max(MAX_RUN_BATCH);
export function validateRunBatch(runIds: readonly string[]): string[] {
  const parsed = BatchRunIds.safeParse(runIds);
  if (!parsed.success) throw new RequestError(400, 'Journal run batch does not match the contract');
  return [...new Set(parsed.data)];
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function journalDigest(key: string, value: unknown): string {
  if (key.length < 32) throw new Error('JOURNAL_HMAC_KEY requires at least 32 characters');
  return createHmac('sha256', key).update(canonical(value)).digest('hex');
}

export function journalRecoveryDigest(key: string, value: unknown): string {
  return journalDigest(key, { domain: 'meridian.external-invocation-recovery.v1', request: value });
}

export function readSignedEnvelope(path: string, key: string): unknown {
  if (key.length < 32) throw new Error('JOURNAL_HMAC_KEY requires at least 32 characters');
  const envelope = JSON.parse(readFileSync(path, 'utf8'));
  const actual = Buffer.from(createHmac('sha256', key).update(canonical(envelope.record)).digest('hex'));
  const signature = Buffer.from(String(envelope.signature));
  if (actual.length !== signature.length || !timingSafeEqual(actual, signature)) throw new Error('Journal authentication failed');
  return envelope.record;
}

const AUTHORITY_MARKER = 'postgres-authority.json';
export const AuthorityMarkerSchema = z.object({
  importId: z.string().uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/),
  phase: z.enum(['pending', 'complete']),
}).strict();
export type AuthorityMarker = z.infer<typeof AuthorityMarkerSchema>;

function readEnvelope(path: string, key: string): unknown { return readSignedEnvelope(path, key); }

export function validateReservationScope(capability: string, runKind: 'discovery' | 'replay', options?: ReservationOptions): InvocationScope {
  const scope = options?.invocationScope ?? 'public';
  if (scope !== 'public' && scope !== 'member-identity') throw new RequestError(400, 'Invalid invocation scope');
  if (scope === 'member-identity' && (runKind !== 'replay' || capability !== 'meridian-member-inquiry')) {
    throw new RequestError(400, 'Invalid invocation scope');
  }
  return scope;
}

/** Authenticate a snapshot without acquiring a lock or recovering/mutating it. */
export function readJournalRecord(dir: string, runId: string, key: string): JournalRecord {
  z.string().uuid().parse(runId);
  const record = RecordSchema.parse(readEnvelope(join(dir, `${runId}.json`), key));
  if (record.runId !== runId) throw new Error('Journal filename mismatch');
  return record;
}

const tempName = (name: string) => /^(?:[0-9a-f-]{36}\.json|postgres-authority\.json)\.[0-9a-f-]{36}\.tmp$/.test(name);
const aliasTempName = (name: string) => /^[0-9a-f]{64}\.json\.[0-9a-f-]{36}\.tmp$/.test(name);

/** Authenticate and normalize the complete filesystem journal without opening it. */
export function readJournalSnapshot(dir: string, key: string): JournalSnapshot {
  journalDigest(key, { records: [], aliases: [] });
  const files = readdirSync(dir);
  const records: JournalRecord[] = [];
  for (const file of files) {
    if (file === 'startup.lock' || file === 'server.lock' || file === AUTHORITY_MARKER || tempName(file)) continue;
    if (file === 'aliases') continue;
    if (!file.endsWith('.json')) throw new Error('Invalid journal snapshot entry');
    records.push(readJournalRecord(dir, file.slice(0, -5), key));
  }
  const byRun = new Set<string>(), identities = new Set<string>();
  for (const record of records) {
    if (byRun.has(record.runId) || identities.has(record.identity)) throw new Error('Journal snapshot contains duplicate identities');
    byRun.add(record.runId); identities.add(record.identity);
  }
  const aliases: RequestAlias[] = [];
  const recordsByRun = new Map(records.map(record => [record.runId, record]));
  const aliasesDir = join(dir, 'aliases');
  if (existsSync(aliasesDir)) {
    for (const file of readdirSync(aliasesDir)) {
      if (tempName(file) || aliasTempName(file)) continue;
      if (!file.endsWith('.json')) throw new Error('Invalid journal snapshot entry');
      const alias = AliasSchema.parse(readSignedEnvelope(join(aliasesDir, file), key));
      const target = recordsByRun.get(alias.runId);
      if (file !== `${alias.identity}.json` || !target || target.caller !== alias.caller || target.request !== alias.request
        || identities.has(alias.identity)) throw new Error('Invalid journal request alias');
      identities.add(alias.identity); aliases.push(alias);
    }
  }
  records.sort((a, b) => a.runId.localeCompare(b.runId));
  aliases.sort((a, b) => a.identity.localeCompare(b.identity));
  return { records, aliases };
}

/** One process per journal; all writes and decisions serialize on the JS event loop. */
export class Journal implements RunJournal {
  readonly records = new Map<string, JournalRecord>();
  private readonly runIdsByIdentity = new Map<string, string>();
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
      if (existsSync(join(dir, AUTHORITY_MARKER))) throw new Error('Filesystem journal is fenced for PostgreSQL cutover');
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
        if (!this.runIdsByIdentity.has(record.identity)) this.runIdsByIdentity.set(record.identity, record.runId);
        if (['reserved', 'running', 'dispatching'].includes(record.state)) {
          this.update(record.runId, record.state === 'dispatching' ? 'POST_OUTCOME_UNKNOWN' : 'interrupted');
        }
      }
      const aliasesDir = join(dir, 'aliases');
      if (existsSync(aliasesDir)) for (const file of readdirSync(aliasesDir).filter(file => file.endsWith('.json'))) {
        const alias = AliasSchema.parse(readEnvelope(join(aliasesDir, file), key));
        const target = this.records.get(alias.runId);
        if (file !== `${alias.identity}.json` || !target || target.caller !== alias.caller || target.request !== alias.request
          || this.runIdsByIdentity.has(alias.identity))
          throw new Error('Invalid journal request alias');
        this.aliases.set(alias.identity, alias);
      }
    } catch (error) { this.close(); throw error; }
  }
  private mac(value: unknown) { return journalDigest(this.key, value); }
  private syncDir(dir = this.dir) { const fd = openSync(dir, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
  private persistEnvelope(path: string, record: unknown) {
    if (this.closed) throw new Error('Journal is closed');
    if (this.writeFailure) throw this.writeFailure;
    if (existsSync(join(this.dir, AUTHORITY_MARKER))) throw new Error('Filesystem journal is fenced for PostgreSQL cutover');
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
    if (!this.runIdsByIdentity.has(record.identity)) this.runIdsByIdentity.set(record.identity, record.runId);
  }
  get(runId: string) { this.assertHealthy(); return this.records.get(runId); }
  getMany(runIds: readonly string[]) {
    this.assertHealthy();
    const ids = validateRunBatch(runIds);
    return new Map(ids.flatMap(runId => {
      const record = this.records.get(runId);
      return record ? [[runId, record] as const] : [];
    }));
  }
  list() { this.assertHealthy(); return [...this.records.values()]; }
  hasUnknown(capability: string) { this.assertHealthy(); return [...this.records.values()].some(record => record.capability === capability && record.state === 'POST_OUTCOME_UNKNOWN'); }
  assertHealthy() { if (this.closed) throw new Error('Journal is closed'); if (this.writeFailure) throw this.writeFailure; }
  bindReference(caller: string, key: string, runId: string) {
    this.assertHealthy();
    validateIdempotencyKey(key);
    if (existsSync(join(this.dir, AUTHORITY_MARKER))) throw new Error('Filesystem journal is fenced for PostgreSQL cutover');
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
    this.assertHealthy();
    const identity = this.mac({ caller, key });
    const runId = this.runIdsByIdentity.get(identity);
    const direct = runId === undefined ? undefined : this.records.get(runId);
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
  recover(caller: string, key: string, request: unknown) {
    validateIdempotencyKey(key);
    const identity = this.mac({ caller, key });
    const existing = this.findRequest(caller, key);
    return {
      existing,
      matches: existing?.recoveryRequest === journalRecoveryDigest(this.key, request),
      direct: existing?.identity === identity,
    };
  }
  reserve(caller: string, key: string, capability: string, version: string, request: unknown,
    kind: 'discovery' | 'replay' = 'replay', options?: ReservationOptions) {
    const invocationScope = validateReservationScope(capability, kind, options);
    const { existing, identity, digest } = this.lookup(caller, key, request);
    if (existing) return existing;
    if (this.hasUnknown(capability)) throw new RequestError(409, 'This capability has an unknown posting outcome; use a separate read-only inquiry');
    const recoveryRequest = options?.recoveryRequest === undefined
      ? undefined : journalRecoveryDigest(this.key, options.recoveryRequest);
    const record: JournalRecord = { kind, runId: randomUUID(), caller, capability, version, request: digest, identity,
      ...(recoveryRequest === undefined ? {} : { recoveryRequest }),
      invocationScope, createdAt: new Date().toISOString(), state: 'reserved' };
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
      if (state === 'failure' || state === 'business_outcome' || state === 'interrupted') state = 'POST_OUTCOME_UNKNOWN';
    }
    this.persist({ ...record, state });
  }
  close() { if (!this.closed) { this.closed = true; unlinkSync(this.lock); this.syncDir(); } }
}
