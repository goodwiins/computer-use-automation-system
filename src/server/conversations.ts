import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { RequestError } from '../runtime/journal.js';

export const CONVERSATION_LIMIT = 128;
export const CONVERSATION_EVENT_LIMIT = 512;
export const SUBJECT_EVENT_LIMIT = 4096;
export const WRITE_RATE_BURST = 20;
export const WRITE_RATE_REFILL_PER_SECOND = 1;

export type Conversation = { id: string; archived: boolean; revision: number; createdAt: string; updatedAt: string };
export type ConversationEvent = { id: string; sequence: number; kind: 'message_omitted' | 'run_linked'; role: 'user' | 'assistant'; runId?: string; createdAt: string };
export type AppendEvent = { id: string; kind: 'message_omitted' | 'run_linked'; role: 'user' | 'assistant'; runId?: string; expectedRevision: number };

const uuid = z.string().uuid().refine(value => value === value.toLowerCase());
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const limit = z.number().int().min(1).max(100).default(50);
const identity = z.tuple([uuid, uuid]);
const listOptions = z.object({ archived: z.boolean().default(false), after: uuid.optional(), limit }).strict();
const eventOptions = z.object({ after: revision.default(0), limit }).strict();
const appendEvent = z.object({
  id: uuid,
  kind: z.enum(['message_omitted', 'run_linked']),
  role: z.enum(['user', 'assistant']),
  runId: uuid.optional(),
  expectedRevision: revision,
}).strict().superRefine((event, context) => {
  if ((event.kind === 'run_linked') !== (event.runId !== undefined))
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'runId does not match kind' });
});

function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new RequestError(400, 'Conversation request does not match the contract');
  return result.data;
}

type ConversationRow = {
  id: string; owner_id: string; archived: boolean; revision: string;
  created_at: Date; updated_at: Date; deleted_at: Date | null;
};
type EventRow = {
  id: string; owner_id: string; conversation_id: string; sequence: string;
  kind: ConversationEvent['kind']; role: ConversationEvent['role'];
  run_id: string | null; created_at: Date;
};
type SubjectQuotaRow = {
  owner_id: string;
  conversation_count: string;
  event_count: string;
  rate_tokens: number;
  rate_refilled_at: Date;
};
type LockedSubjectQuota = {
  conversationCount: number;
  eventCount: number;
  rateTokens: number;
  rateRefilledAt: string;
};
const conversation = (row: ConversationRow): Conversation => ({
  id: row.id,
  archived: row.archived,
  revision: Number(row.revision),
  createdAt: row.created_at.toISOString(),
  updatedAt: row.updated_at.toISOString(),
});
const event = (row: EventRow): ConversationEvent => ({
  id: row.id,
  sequence: Number(row.sequence),
  kind: row.kind,
  role: row.role,
  ...(row.run_id === null ? {} : { runId: row.run_id }),
  createdAt: row.created_at.toISOString(),
});

export class ConversationStore {
  constructor(private readonly pool: Pool) {}

  async migrate(): Promise<void> {
    const sql = await readFile(new URL('./conversations.sql', import.meta.url), 'utf8');
    await this.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('meridian_conversations_migration'))");
      await client.query(sql);
    });
  }

  async create(owner: string, id: string): Promise<Conversation> {
    [owner, id] = parse(identity, [owner, id]);
    return this.transaction(async client => {
      const quota = await this.lockQuota(client, owner);
      const existing = await client.query<ConversationRow>('SELECT * FROM meridian_conversations WHERE id = $1 AND owner_id = $2', [id, owner]);
      const row = existing.rows[0];
      if (row) {
        if (row.deleted_at === null) return conversation(row);
        throw new RequestError(409, 'Conversation ID is unavailable');
      }
      if (quota.conversationCount >= CONVERSATION_LIMIT) throw new RequestError(507, 'Conversation quota exceeded');
      await this.consumeRate(client, owner);
      const inserted = await client.query<ConversationRow>(
        `INSERT INTO meridian_conversations (id, owner_id) VALUES ($1, $2)
         ON CONFLICT (owner_id, id) DO NOTHING RETURNING *`,
        [id, owner],
      );
      if (!inserted.rows[0]) throw new RequestError(409, 'Conversation ID is unavailable');
      await client.query(
        `UPDATE meridian_conversation_subject_quotas
         SET conversation_count = conversation_count + 1
         WHERE owner_id = $1`,
        [owner],
      );
      return conversation(inserted.rows[0]);
    });
  }

  async list(owner: string, options: { archived?: boolean; after?: string; limit?: number } = {}): Promise<{ conversations: Conversation[]; nextCursor?: string }> {
    owner = parse(uuid, owner);
    const parsed = parse(listOptions, options);
    const result = await this.pool.query<ConversationRow>(
      `SELECT * FROM meridian_conversations
       WHERE owner_id = $1 AND archived = $2 AND deleted_at IS NULL
         AND ($3::uuid IS NULL OR id > $3)
       ORDER BY id LIMIT $4`,
      [owner, parsed.archived, parsed.after ?? null, parsed.limit + 1],
    );
    const rows = result.rows.slice(0, parsed.limit);
    return {
      conversations: rows.map(conversation),
      ...(result.rows.length > parsed.limit ? { nextCursor: rows.at(-1)!.id } : {}),
    };
  }

  async get(owner: string, id: string): Promise<Conversation> {
    [owner, id] = parse(identity, [owner, id]);
    const result = await this.pool.query<ConversationRow>(
      'SELECT * FROM meridian_conversations WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL',
      [id, owner],
    );
    if (!result.rows[0]) throw new RequestError(404, 'Conversation not found');
    return conversation(result.rows[0]);
  }

  async archive(owner: string, id: string, archived: boolean, expectedRevision: number): Promise<Conversation> {
    [owner, id, archived, expectedRevision] = parse(z.tuple([uuid, uuid, z.boolean(), revision]), [owner, id, archived, expectedRevision]);
    return this.transaction(async client => {
      await this.lockQuota(client, owner);
      const row = await this.lock(client, owner, id);
      if (Number(row.revision) !== expectedRevision) throw new RequestError(409, 'Conversation revision conflict');
      await this.consumeRate(client, owner);
      const updated = await client.query<ConversationRow>(
        `UPDATE meridian_conversations
         SET archived = $1, revision = revision + 1, updated_at = clock_timestamp()
         WHERE id = $2 AND owner_id = $3 RETURNING *`,
        [archived, id, owner],
      );
      return conversation(updated.rows[0]!);
    });
  }

  async delete(owner: string, id: string, expectedRevision: number): Promise<void> {
    [owner, id, expectedRevision] = parse(z.tuple([uuid, uuid, revision]), [owner, id, expectedRevision]);
    await this.transaction(async client => {
      await this.lockQuota(client, owner);
      const row = await this.lock(client, owner, id);
      if (Number(row.revision) !== expectedRevision) throw new RequestError(409, 'Conversation revision conflict');
      const retained = await client.query<{ count: string }>(
        'SELECT count(*)::bigint AS count FROM meridian_conversation_events WHERE conversation_id = $1 AND owner_id = $2',
        [id, owner],
      );
      await this.consumeRate(client, owner);
      await client.query('DELETE FROM meridian_conversation_events WHERE conversation_id = $1 AND owner_id = $2', [id, owner]);
      await client.query(
        `UPDATE meridian_conversations
         SET deleted_at = clock_timestamp(), revision = revision + 1, updated_at = clock_timestamp()
         WHERE id = $1 AND owner_id = $2`,
        [id, owner],
      );
      await client.query(
        `UPDATE meridian_conversation_subject_quotas
         SET event_count = event_count - $2::bigint
         WHERE owner_id = $1`,
        [owner, retained.rows[0]?.count ?? '0'],
      );
    });
  }

  async append(owner: string, id: string, value: AppendEvent): Promise<ConversationEvent> {
    [owner, id] = parse(identity, [owner, id]);
    const pending = parse(appendEvent, value);
    return this.transaction(async client => {
      const quota = await this.lockQuota(client, owner);
      const found = await client.query<EventRow>(
        `SELECT * FROM meridian_conversation_events WHERE id = $1 AND owner_id = $2`,
        [pending.id, owner],
      );
      const existing = found.rows[0];
      if (existing) {
        if (existing.conversation_id === id) {
          if (existing.kind === pending.kind && existing.role === pending.role && existing.run_id === (pending.runId ?? null)) return event(existing);
          throw new RequestError(409, 'Conversation event conflicts with an existing event');
        }
        const target = await client.query<{ id: string }>(
          `SELECT id FROM meridian_conversations
           WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL`,
          [id, owner],
        );
        if (!target.rows[0]) throw new RequestError(404, 'Conversation not found');
        throw new RequestError(409, 'Conversation event conflicts with an existing event');
      }
      const row = await this.lock(client, owner, id);
      if (row.archived) throw new RequestError(409, 'Conversation is archived');
      if (Number(row.revision) !== pending.expectedRevision) throw new RequestError(409, 'Conversation revision conflict');

      const conversationEvents = await client.query<{ count: string }>(
        'SELECT count(*)::bigint AS count FROM meridian_conversation_events WHERE conversation_id = $1 AND owner_id = $2',
        [id, owner],
      );
      if (Number(conversationEvents.rows[0]?.count ?? '0') >= CONVERSATION_EVENT_LIMIT
          || quota.eventCount >= SUBJECT_EVENT_LIMIT) {
        throw new RequestError(507, 'Conversation quota exceeded');
      }

      const sequence = pending.expectedRevision + 1;
      await this.consumeRate(client, owner);
      await client.query(
        `UPDATE meridian_conversations
         SET revision = $1, updated_at = clock_timestamp()
         WHERE id = $2 AND owner_id = $3`,
        [sequence, id, owner],
      );
      const inserted = await client.query<EventRow>(
        `INSERT INTO meridian_conversation_events (id, owner_id, conversation_id, sequence, kind, role, run_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (owner_id, id) DO NOTHING RETURNING *`,
        [pending.id, owner, id, sequence, pending.kind, pending.role, pending.runId ?? null],
      );
      if (!inserted.rows[0]) throw new RequestError(409, 'Conversation event conflicts with an existing event');
      await client.query(
        `UPDATE meridian_conversation_subject_quotas
         SET event_count = event_count + 1
         WHERE owner_id = $1`,
        [owner],
      );
      return event(inserted.rows[0]);
    });
  }

  async events(owner: string, id: string, options: { after?: number; limit?: number } = {}): Promise<{ events: ConversationEvent[]; nextCursor?: number }> {
    [owner, id] = parse(identity, [owner, id]);
    const parsed = parse(eventOptions, options);
    return this.transaction(async client => {
      await this.lock(client, owner, id, 'FOR SHARE');
      const result = await client.query<EventRow>(
        `SELECT * FROM meridian_conversation_events
         WHERE conversation_id = $1 AND owner_id = $2 AND sequence > $3
         ORDER BY sequence LIMIT $4`,
        [id, owner, parsed.after, parsed.limit + 1],
      );
      const rows = result.rows.slice(0, parsed.limit);
      return {
        events: rows.map(event),
        ...(result.rows.length > parsed.limit ? { nextCursor: Number(rows.at(-1)!.sequence) } : {}),
      };
    });
  }

  private async lock(client: PoolClient, owner: string, id: string, mode = 'FOR UPDATE'): Promise<ConversationRow> {
    const result = await client.query<ConversationRow>(
      `SELECT * FROM meridian_conversations
       WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL ${mode}`,
      [id, owner],
    );
    if (!result.rows[0]) throw new RequestError(404, 'Conversation not found');
    return result.rows[0];
  }

  private async lockQuota(client: PoolClient, owner: string): Promise<LockedSubjectQuota> {
    await client.query(
      `INSERT INTO meridian_conversation_subject_quotas (owner_id)
       VALUES ($1) ON CONFLICT (owner_id) DO NOTHING`,
      [owner],
    );
    const result = await client.query<SubjectQuotaRow>(
      `SELECT owner_id, conversation_count, event_count, rate_tokens, rate_refilled_at
       FROM meridian_conversation_subject_quotas
       WHERE owner_id = $1 FOR UPDATE`,
      [owner],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Conversation subject quota row disappeared');
    return {
      conversationCount: Number(row.conversation_count),
      eventCount: Number(row.event_count),
      rateTokens: Number(row.rate_tokens),
      rateRefilledAt: row.rate_refilled_at.toISOString(),
    };
  }

  private async consumeRate(client: PoolClient, owner: string): Promise<void> {
    const result = await client.query<{ available: number; consumed: boolean }>(
      `WITH quota_clock AS MATERIALIZED (
         SELECT clock_timestamp() AS value
       ), calculated AS MATERIALIZED (
         SELECT quota.owner_id,
                LEAST($2::double precision,
                      quota.rate_tokens
                      + EXTRACT(EPOCH FROM (quota_clock.value - quota.rate_refilled_at))
                        * $3::double precision) AS available,
                quota_clock.value AS refill_time
         FROM meridian_conversation_subject_quotas quota
         CROSS JOIN quota_clock
         WHERE quota.owner_id = $1
       ), updated AS (
         UPDATE meridian_conversation_subject_quotas quota
         SET rate_tokens = calculated.available - 1,
             rate_refilled_at = calculated.refill_time
         FROM calculated
         WHERE quota.owner_id = calculated.owner_id
           AND calculated.available >= 1
         RETURNING quota.owner_id
       )
       SELECT calculated.available, updated.owner_id IS NOT NULL AS consumed
       FROM calculated
       LEFT JOIN updated ON updated.owner_id = calculated.owner_id`,
      [owner, WRITE_RATE_BURST, WRITE_RATE_REFILL_PER_SECOND],
    );
    const row = result.rows[0];
    if (!row || !row.consumed || Number(row.available) < 1) {
      throw new RequestError(429, 'Conversation write rate limit exceeded', { 'Retry-After': '1' });
    }
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let discard = false;
    try {
      await client.query('BEGIN');
      try {
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try { await client.query('ROLLBACK'); }
        catch { discard = true; }
        throw error;
      }
    } finally { client.release(discard); }
  }
}
