import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import {
  journalDigest,
  journalRecoveryDigest,
  type JournalLookup,
  type JournalRecoveryLookup,
  type JournalRecord,
  type JournalSnapshot,
  type InvocationScope,
  type ReservationOptions,
  type RequestAlias,
  RequestError,
  type RunJournal,
  validateReservationScope,
  validateIdempotencyKey,
  validateRunBatch,
  validateKeyBatch,
} from './journal.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid().refine(value => value === value.toLowerCase());
const safeText = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+,-]{0,199}$/);
const state = z.enum(['reserved', 'running', 'dispatching', 'success', 'business_outcome', 'failure', 'interrupted', 'POST_OUTCOME_UNKNOWN']);
const kind = z.enum(['discovery', 'replay']);
const record = z.object({
  kind,
  runId: uuid,
  caller: safeText,
  capability: safeText,
  version: safeText,
  request: hash,
  recoveryRequest: hash.optional(),
  identity: hash,
  createdAt: z.string(),
  invocationScope: z.enum(['public', 'member-identity']).optional(),
  state,
}).strict();
const alias = z.object({ caller: safeText, identity: hash, request: hash, runId: uuid }).strict();
const snapshot = z.object({ records: z.array(record), aliases: z.array(alias) }).strict();

type RunRow = {
  run_id: string;
  kind: JournalRecord['kind'];
  caller: string;
  capability: string;
  version: string;
  request: string;
  recovery_request: string | null;
  identity: string;
  created_at: Date | string;
  invocation_scope: InvocationScope | null;
  state: JournalRecord['state'];
  dispatch_intent: boolean;
};
type AuthorityRow = { import_id: string | null; source_digest: string | null; owner_id: string | null };

const ACTIVE_STATES = ['reserved', 'running', 'dispatching'] as const;
const POISON_MESSAGE = 'Journal storage outcome uncertain; restart or recover required';
const CLOSED_MESSAGE = 'Journal is closed';
export const POSTGRES_LOCK_TIMEOUT_MS = 2_000;
export const POSTGRES_STATEMENT_TIMEOUT_MS = 5_000;

async function configureTransactionTimeouts(client: PoolClient): Promise<void> {
  await client.query(`SET LOCAL lock_timeout = '${POSTGRES_LOCK_TIMEOUT_MS}ms'`);
  await client.query(`SET LOCAL statement_timeout = '${POSTGRES_STATEMENT_TIMEOUT_MS}ms'`);
}

function parse<T>(schema: z.ZodType<T>, value: unknown, message = 'Journal request does not match the contract'): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new RequestError(400, message);
  return result.data;
}

function safeDigest(key: string, value: unknown): string {
  try { return journalDigest(key, value); }
  catch { throw new RequestError(400, 'Journal request does not match the contract'); }
}

function validateKey(key: string): void {
  if (key.length < 32) throw new RequestError(400, 'JOURNAL_HMAC_KEY requires at least 32 characters');
}

function validateCaller(caller: string): string {
  return parse(safeText, caller, 'Invalid journal caller');
}

function validateCapability(capability: string): string {
  return parse(safeText, capability, 'Invalid journal capability');
}

function validateVersion(version: string): string {
  return parse(safeText, version, 'Invalid journal version');
}

function validateRunId(runId: string): string {
  return parse(uuid, runId, 'Invalid journal run');
}

function validateState(value: JournalRecord['state']): JournalRecord['state'] {
  return parse(state, value, 'Invalid journal state');
}

function validateImport(importId: string, digest: string): [string, string] {
  return [parse(uuid, importId, 'Invalid journal import'), parse(hash, digest, 'Invalid journal snapshot digest')];
}

function dateValue(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new RequestError(400, 'Journal request does not match the contract');
  return parsed;
}

function recordFromRow(row: RunRow): JournalRecord {
  const date = row.created_at instanceof Date ? row.created_at : new Date(row.created_at);
  if (!Number.isFinite(date.getTime())) throw new Error('Journal row validation failed');
  try {
    const value = {
      kind: row.kind,
      runId: row.run_id,
      caller: row.caller,
      capability: row.capability,
      version: row.version,
      request: row.request,
      ...(row.recovery_request === null || row.recovery_request === undefined ? {} : { recoveryRequest: row.recovery_request }),
      identity: row.identity,
      createdAt: date.toISOString(),
      state: row.state,
      ...(row.invocation_scope === null || row.invocation_scope === undefined ? {} : { invocationScope: row.invocation_scope }),
    };
    return record.parse(value);
  } catch { throw new Error('Journal row validation failed'); }
}

function requestConflict(message: string): RequestError {
  return new RequestError(409, message);
}

function isUnique(error: unknown, constraint: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && 'constraint' in error
    && (error as { code?: string }).code === '23505' && (error as { constraint?: string }).constraint === constraint;
}

async function staticTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  let client: PoolClient;
  try { client = await pool.connect(); }
  catch { throw new Error('Journal operation failed'); }
  let discard = false;
  try {
    try {
      await client.query('BEGIN');
      await configureTransactionTimeouts(client);
    }
    catch { discard = true; throw new Error('Journal operation failed'); }
    let commitAttempted = false;
    try {
      const result = await work(client);
      commitAttempted = true;
      await client.query('COMMIT');
      return result;
    } catch (error) {
      if (commitAttempted) discard = true;
      try { await client.query('ROLLBACK'); }
      catch { discard = true; }
      if (error instanceof RequestError) throw error;
      throw new Error('Journal operation failed');
    }
  } finally { client.release(discard); }
}

export class PostgresJournal implements RunJournal {
  readonly ownerId: string;
  private closed = false;
  private poisoned?: Error;
  private closePromise?: Promise<void>;

  private constructor(private readonly pool: Pool, ownerId: string, private readonly key: string) {
    this.ownerId = ownerId;
  }

  static async migrate(pool: Pool): Promise<void> {
    const sql = await readFile(new URL('./journal.sql', import.meta.url), 'utf8');
    await staticTransaction(pool, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('meridian_journal_migration'))");
      await client.query(sql);
    });
  }

  static async importSnapshot(pool: Pool, key: string, input: JournalSnapshot, importId: string, digest: string, initialize = true): Promise<void> {
    validateKey(key);
    const parsed = parse(snapshot, input);
    const [validatedImport, validatedDigest] = validateImport(importId, digest);
    if (safeDigest(key, parsed) !== validatedDigest) throw new RequestError(400, 'Journal snapshot authentication failed');
    const records = new Map<string, z.infer<typeof record>>();
    const identities = new Set<string>();
    for (const item of parsed.records) {
      if (records.has(item.runId) || identities.has(item.identity)) throw requestConflict('Journal snapshot contains duplicate identities');
      records.set(item.runId, item);
      identities.add(item.identity);
      dateValue(item.createdAt);
      validateReservationScope(item.capability, item.kind,
        item.invocationScope === undefined ? undefined : { invocationScope: item.invocationScope });
    }
    for (const item of parsed.aliases) {
      const target = records.get(item.runId);
      if (!target || target.caller !== item.caller || target.request !== item.request || identities.has(item.identity)) {
        throw requestConflict('Journal snapshot contains an invalid alias');
      }
      identities.add(item.identity);
    }
    await staticTransaction(pool, async client => {
      if (initialize) await client.query(
        `INSERT INTO meridian_journal_authority (singleton) VALUES (true)
         ON CONFLICT (singleton) DO NOTHING`,
      );
      const authority = await client.query<AuthorityRow>(
        `SELECT import_id::text, source_digest, owner_id::text
         FROM meridian_journal_authority WHERE singleton = true FOR UPDATE`,
      );
      const marker = authority.rows[0];
      if (!marker) throw requestConflict('Journal authority is not initialized');
      if (marker.import_id !== null || marker.source_digest !== null) {
        if (marker.import_id === validatedImport && marker.source_digest === validatedDigest) return;
        throw requestConflict('Journal snapshot import is already initialized');
      }
      if (!initialize) throw requestConflict('Journal authority is not initialized');
      if (marker.owner_id !== null) throw requestConflict('Journal authority is already owned');
      const existing = await client.query<{ present: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM meridian_runs) OR EXISTS (SELECT 1 FROM meridian_run_requests) AS present`,
      );
      if (existing.rows[0]?.present) throw requestConflict('Journal authority is not empty');
      for (const item of parsed.records) {
        const importedState = item.state === 'reserved' || item.state === 'running' ? 'interrupted'
          : item.state === 'dispatching' ? 'POST_OUTCOME_UNKNOWN' : item.state;
        const dispatchIntent = item.state === 'dispatching' || item.state === 'POST_OUTCOME_UNKNOWN';
        try {
          await client.query(
            `INSERT INTO meridian_runs
              (run_id, kind, caller, capability, version, request, recovery_request, identity, created_at, state, dispatch_intent, invocation_scope)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
            [item.runId, item.kind, item.caller, item.capability, item.version, item.request, item.recoveryRequest ?? null,
              item.identity, dateValue(item.createdAt), importedState, dispatchIntent, item.invocationScope ?? null],
          );
          await client.query(
            `INSERT INTO meridian_run_requests (identity, caller, request, run_id, is_alias)
             VALUES ($1, $2, $3, $4, false)`,
            [item.identity, item.caller, item.request, item.runId],
          );
        } catch (error) {
          if (isUnique(error, 'meridian_runs_one_active')) throw requestConflict('Journal snapshot contains multiple active runs');
          throw error;
        }
      }
      for (const item of parsed.aliases) {
        await client.query(
          `INSERT INTO meridian_run_requests (identity, caller, request, run_id, is_alias)
           VALUES ($1, $2, $3, $4, true)`,
          [item.identity, item.caller, item.request, item.runId],
        );
      }
      await client.query(
        `UPDATE meridian_journal_authority SET import_id = $1, source_digest = $2 WHERE singleton = true`,
        [validatedImport, validatedDigest],
      );
    });
  }

  static async open(pool: Pool, key: string, importId: string, digest: string): Promise<PostgresJournal> {
    validateKey(key);
    const [validatedImport, validatedDigest] = validateImport(importId, digest);
    const ownerId = randomUUID();
    await staticTransaction(pool, async client => {
      const authority = await client.query<AuthorityRow>(
        `SELECT import_id::text, source_digest, owner_id::text
         FROM meridian_journal_authority WHERE singleton = true FOR UPDATE`,
      );
      const marker = authority.rows[0];
      if (!marker || marker.import_id !== validatedImport || marker.source_digest !== validatedDigest) {
        throw requestConflict('Journal import identity does not match');
      }
      if (marker.owner_id !== null) throw requestConflict('Journal is already owned');
      await client.query(
        `UPDATE meridian_journal_authority SET owner_id = $1 WHERE singleton = true AND owner_id IS NULL`,
        [ownerId],
      );
    });
    return new PostgresJournal(pool, ownerId, key);
  }

  static async recover(pool: Pool, ownerId: string): Promise<void> {
    const owner = parse(uuid, ownerId, 'Invalid journal owner');
    await staticTransaction(pool, async client => {
      const authority = await client.query<AuthorityRow>(
        `SELECT import_id::text, source_digest, owner_id::text
         FROM meridian_journal_authority WHERE singleton = true FOR UPDATE`,
      );
      const marker = authority.rows[0];
      if (!marker || marker.owner_id === null || marker.owner_id !== owner) throw requestConflict('Journal owner is no longer valid');
      await client.query(
        `UPDATE meridian_runs
         SET state = CASE WHEN dispatch_intent THEN 'POST_OUTCOME_UNKNOWN' ELSE 'interrupted' END
         WHERE state IN ('reserved', 'running', 'dispatching')`,
      );
      const released = await client.query(
        `UPDATE meridian_journal_authority SET owner_id = NULL
         WHERE singleton = true AND owner_id = $1`,
        [owner],
      );
      if (released.rowCount !== 1) throw requestConflict('Journal owner is no longer valid');
    });
  }

  assertHealthy(): void {
    if (this.poisoned) throw this.poisoned;
    if (this.closed) throw new Error(CLOSED_MESSAGE);
  }

  async get(runId: string): Promise<JournalRecord | undefined> {
    this.assertHealthy();
    const parsedId = uuid.safeParse(runId);
    if (!parsedId.success) return undefined;
    const id = parsedId.data;
    return this.transaction(async client => {
      await this.lockAuthority(client);
      const result = await client.query<RunRow>(
        `SELECT run_id::text, kind, caller, capability, version, request, recovery_request, identity, created_at, invocation_scope, state, dispatch_intent
         FROM meridian_runs WHERE run_id = $1`,
        [id],
      );
      return result.rows[0] ? recordFromRow(result.rows[0]) : undefined;
    });
  }

  async getMany(runIds: readonly string[]): Promise<Map<string, JournalRecord>> {
    this.assertHealthy();
    const ids = validateRunBatch(runIds);
    if (ids.length === 0) return new Map();
    return this.transaction(async client => {
      await this.lockAuthority(client);
      const result = await client.query<RunRow>(
        `SELECT run_id::text, kind, caller, capability, version, request, recovery_request, identity, created_at, invocation_scope, state, dispatch_intent
         FROM meridian_runs WHERE run_id = ANY($1::uuid[])`,
        [ids],
      );
      const records = new Map(result.rows.map(row => {
        const record = recordFromRow(row);
        return [record.runId, record] as const;
      }));
      return new Map(ids.flatMap(runId => {
        const record = records.get(runId);
        return record ? [[runId, record] as const] : [];
      }));
    });
  }

  async list(): Promise<JournalRecord[]> {
    this.assertHealthy();
    return this.transaction(async client => {
      await this.lockAuthority(client);
      const result = await client.query<RunRow>(
        `SELECT run_id::text, kind, caller, capability, version, request, recovery_request, identity, created_at, invocation_scope, state, dispatch_intent
         FROM meridian_runs ORDER BY created_at, run_id`,
      );
      return result.rows.map(recordFromRow);
    });
  }

  async hasUnknown(capability: string): Promise<boolean> {
    this.assertHealthy();
    const name = validateCapability(capability);
    return this.transaction(async client => {
      await this.lockAuthority(client);
      const result = await client.query<{ present: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM meridian_runs WHERE capability = $1 AND state = 'POST_OUTCOME_UNKNOWN') AS present`,
        [name],
      );
      return result.rows[0]?.present === true;
    });
  }

  async unknownCapabilities(capabilities: readonly string[]): Promise<Set<string>> {
    this.assertHealthy();
    const names = validateKeyBatch(capabilities).map(validateCapability);
    if (!names.length) return new Set();
    return this.transaction(async client => {
      await this.lockAuthority(client);
      const result = await client.query<{ capability: string }>(
        "SELECT DISTINCT capability FROM meridian_runs WHERE capability = ANY($1::text[]) AND state = 'POST_OUTCOME_UNKNOWN'",
        [names],
      );
      return new Set(result.rows.map(row => row.capability));
    });
  }

  async findRequests(caller: string, keys: readonly string[]): Promise<Map<string, JournalRecord>> {
    this.assertHealthy();
    const principal = validateCaller(caller);
    const identities = new Map(validateKeyBatch(keys).map(key => [key, safeDigest(this.key, { caller: principal, key })]));
    if (!identities.size) return new Map();
    return this.transaction(async client => {
      await this.lockAuthority(client);
      const result = await client.query<RunRow & { lookup_identity: string }>(
        `SELECT q.identity AS lookup_identity, r.run_id::text, r.kind, r.caller, r.capability, r.version, r.request,
          r.recovery_request, r.identity, r.created_at, r.invocation_scope, r.state, r.dispatch_intent
         FROM meridian_run_requests q JOIN meridian_runs r ON r.run_id = q.run_id
         WHERE q.caller = $1 AND q.identity = ANY($2::text[])`,
        [principal, [...identities.values()]],
      );
      const records = new Map(result.rows.map(row => [row.lookup_identity, recordFromRow(row)]));
      return new Map([...identities].flatMap(([key, identity]) => {
        const record = records.get(identity);
        return record ? [[key, record] as const] : [];
      }));
    });
  }

  async findRequest(caller: string, key: string): Promise<JournalRecord | undefined> {
    this.assertHealthy();
    const principal = validateCaller(caller);
    validateIdempotencyKey(key);
    const identity = safeDigest(this.key, { caller: principal, key });
    return this.transaction(async client => {
      await this.lockAuthority(client);
      return this.findRequestWithIdentity(client, principal, identity);
    });
  }

  async lookup(caller: string, key: string, request: unknown): Promise<JournalLookup> {
    this.assertHealthy();
    const principal = validateCaller(caller);
    validateIdempotencyKey(key);
    const identity = safeDigest(this.key, { caller: principal, key });
    const digest = safeDigest(this.key, request);
    return this.transaction(async client => {
      await this.lockAuthority(client);
      const existing = await this.findRequestWithIdentity(client, principal, identity);
      if (existing && existing.request !== digest) throw requestConflict('Idempotency key already identifies another request');
      return { existing, identity, digest };
    });
  }

  async recover(caller: string, key: string, request: unknown): Promise<JournalRecoveryLookup> {
    this.assertHealthy();
    const principal = validateCaller(caller);
    validateIdempotencyKey(key);
    const identity = safeDigest(this.key, { caller: principal, key });
    const digest = journalRecoveryDigest(this.key, request);
    return this.transaction(async client => {
      await this.lockAuthority(client);
      const existing = await this.findRequestWithIdentity(client, principal, identity);
      return { existing, matches: existing?.recoveryRequest === digest, direct: existing?.identity === identity };
    });
  }

  async reserve(caller: string, key: string, capability: string, version: string, request: unknown,
    runKind: 'discovery' | 'replay' = 'replay', options?: ReservationOptions): Promise<JournalRecord> {
    this.assertHealthy();
    const principal = validateCaller(caller);
    validateIdempotencyKey(key);
    const name = validateCapability(capability);
    const release = validateVersion(version);
    const requestedKind = parse(kind, runKind, 'Invalid journal kind');
    const invocationScope = validateReservationScope(name, requestedKind, options);
    const identity = safeDigest(this.key, { caller: principal, key });
    const digest = safeDigest(this.key, request);
    const recoveryDigest = options?.recoveryRequest === undefined
      ? undefined : journalRecoveryDigest(this.key, options.recoveryRequest);
    return this.transaction(async client => {
      await this.lockAuthority(client);
      const existing = await this.findRequestWithIdentity(client, principal, identity);
      if (existing) {
        if (existing.request !== digest) throw requestConflict('Idempotency key already identifies another request');
        return existing;
      }
      const unknown = await client.query<{ present: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM meridian_runs WHERE capability = $1 AND state = 'POST_OUTCOME_UNKNOWN') AS present`,
        [name],
      );
      if (unknown.rows[0]?.present) throw requestConflict('This capability has an unknown posting outcome; use a new read-only inquiry');
      const active = await client.query<{ present: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM meridian_runs WHERE state IN ('reserved', 'running', 'dispatching')) AS present`,
      );
      if (active.rows[0]?.present) throw new RequestError(429, 'One run is active; retry with the same idempotency key');
      const runId = randomUUID();
      const createdAt = new Date();
      let inserted: { rows: RunRow[] };
      try {
        inserted = await client.query<RunRow>(
          `INSERT INTO meridian_runs
            (run_id, kind, caller, capability, version, request, recovery_request, identity, created_at, state, dispatch_intent, invocation_scope)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'reserved', false, $10)
           RETURNING run_id::text, kind, caller, capability, version, request, recovery_request, identity, created_at, invocation_scope, state, dispatch_intent`,
          [runId, requestedKind, principal, name, release, digest, recoveryDigest ?? null, identity, createdAt, invocationScope],
        );
        await client.query(
          `INSERT INTO meridian_run_requests (identity, caller, request, run_id, is_alias)
           VALUES ($1, $2, $3, $4, false)`,
          [identity, principal, digest, runId],
        );
      } catch (error) {
        if (isUnique(error, 'meridian_runs_one_active')) throw new RequestError(429, 'One run is active; retry with the same idempotency key');
        if (isUnique(error, 'meridian_runs_identity_key') || isUnique(error, 'meridian_run_requests_pkey')) {
          throw requestConflict('Idempotency key already identifies another request');
        }
        throw error;
      }
      return recordFromRow(inserted.rows[0]!);
    });
  }

  async bindReference(caller: string, key: string, runId: string): Promise<void> {
    this.assertHealthy();
    const principal = validateCaller(caller);
    validateIdempotencyKey(key);
    const id = validateRunId(runId);
    const identity = safeDigest(this.key, { caller: principal, key });
    await this.transaction(async client => {
      await this.lockAuthority(client);
      const target = await client.query<RunRow>(
        `SELECT run_id::text, kind, caller, capability, version, request, recovery_request, identity, created_at, invocation_scope, state, dispatch_intent
         FROM meridian_runs WHERE run_id = $1 FOR UPDATE`,
        [id],
      );
      if (!target.rows[0] || target.rows[0].caller !== principal) throw new RequestError(403, 'Run belongs to another principal');
      const existing = await client.query<{ identity: string; caller: string; request: string; run_id: string; is_alias: boolean }>(
        `SELECT identity, caller, request, run_id::text, is_alias FROM meridian_run_requests WHERE identity = $1`, [identity],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].is_alias && existing.rows[0].caller === principal
          && existing.rows[0].run_id === id && existing.rows[0].request === target.rows[0].request) return;
        throw requestConflict('Idempotency key already identifies another request');
      }
      try {
        await client.query(
          `INSERT INTO meridian_run_requests (identity, caller, request, run_id, is_alias)
           VALUES ($1, $2, $3, $4, true)`,
          [identity, principal, target.rows[0].request, id],
        );
      } catch (error) {
        if (isUnique(error, 'meridian_run_requests_pkey')) throw requestConflict('Idempotency key already identifies another request');
        throw error;
      }
    });
  }

  async update(runId: string, nextState: JournalRecord['state']): Promise<void> {
    this.assertHealthy();
    const id = validateRunId(runId);
    const requested = validateState(nextState);
    await this.transaction(async client => {
      await this.lockAuthority(client);
      const found = await client.query<RunRow>(
        `SELECT run_id::text, kind, caller, capability, version, request, recovery_request, identity, created_at, invocation_scope, state, dispatch_intent
         FROM meridian_runs WHERE run_id = $1 FOR UPDATE`,
        [id],
      );
      const current = found.rows[0];
      if (!current) throw new RequestError(404, 'Unknown journal run');
      if (!ACTIVE_STATES.includes(current.state as typeof ACTIVE_STATES[number])) {
        if (current.state === requested) return;
        throw requestConflict('Terminal journal state cannot be changed');
      }
      if (current.state === 'dispatching' && (requested === 'reserved' || requested === 'running')) {
        throw requestConflict('Dispatch intent cannot be cleared');
      }
      let stateToWrite = requested;
      if (current.state === 'dispatching' && (requested === 'failure' || requested === 'business_outcome' || requested === 'interrupted')) stateToWrite = 'POST_OUTCOME_UNKNOWN';
      if (current.dispatch_intent && (requested === 'failure' || requested === 'business_outcome' || requested === 'interrupted')) stateToWrite = 'POST_OUTCOME_UNKNOWN';
      await client.query(
        `UPDATE meridian_runs SET state = $1, dispatch_intent = CASE WHEN $1 = 'dispatching' THEN true ELSE dispatch_intent END WHERE run_id = $2`,
        [stateToWrite, id],
      );
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.assertHealthy();
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.closeInternal();
    try { await this.closePromise; }
    finally { this.closePromise = undefined; }
  }

  private async closeInternal(): Promise<void> {
    await this.transaction(async client => {
      await this.lockAuthority(client);
      const active = await client.query<{ present: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM meridian_runs WHERE state IN ('reserved', 'running', 'dispatching')) AS present`,
      );
      if (active.rows[0]?.present) throw requestConflict('Cannot close while a run is active');
      const released = await client.query(
        `UPDATE meridian_journal_authority SET owner_id = NULL WHERE singleton = true AND owner_id = $1`,
        [this.ownerId],
      );
      if (released.rowCount !== 1) throw requestConflict('Journal owner is no longer valid');
    });
    this.closed = true;
  }

  private async findRequestWithIdentity(client: PoolClient, caller: string, identity: string): Promise<JournalRecord | undefined> {
    const result = await client.query<RunRow>(
      `SELECT r.run_id::text, r.kind, r.caller, r.capability, r.version, r.request, r.recovery_request, r.identity, r.created_at, r.invocation_scope, r.state, r.dispatch_intent
       FROM meridian_run_requests q JOIN meridian_runs r ON r.run_id = q.run_id
       WHERE q.identity = $1 AND q.caller = $2`,
      [identity, caller],
    );
    return result.rows[0] ? recordFromRow(result.rows[0]) : undefined;
  }

  private async lockAuthority(client: PoolClient): Promise<AuthorityRow> {
    const result = await client.query<AuthorityRow>(
      `SELECT import_id::text, source_digest, owner_id::text
       FROM meridian_journal_authority WHERE singleton = true FOR UPDATE`,
    );
    const marker = result.rows[0];
    if (!marker || marker.import_id === null || marker.source_digest === null) throw requestConflict('Journal is not initialized');
    if (marker.owner_id !== this.ownerId) throw requestConflict('Journal owner is no longer valid');
    return marker;
  }

  private poison(): Error {
    return this.poisoned ??= new Error(POISON_MESSAGE);
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    this.assertHealthy();
    let client: PoolClient | undefined;
    let discard = false;
    try {
      try { client = await this.pool.connect(); }
      catch { throw this.poison(); }
      try {
        await client.query('BEGIN');
        await configureTransactionTimeouts(client);
      }
      catch { discard = true; throw this.poison(); }
      try {
        const result = await work(client);
        this.assertHealthy();
        try { await client.query('COMMIT'); }
        catch { discard = true; throw this.poison(); }
        return result;
      } catch (error) {
        if (error === this.poisoned) { discard = true; throw error; }
        if (error instanceof RequestError) {
          try { await client.query('ROLLBACK'); }
          catch { discard = true; throw this.poison(); }
          throw error;
        }
        try { await client.query('ROLLBACK'); }
        catch { discard = true; }
        discard = true;
        throw this.poison();
      }
    } finally { client?.release(discard); }
  }
}
