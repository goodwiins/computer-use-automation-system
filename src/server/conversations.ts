import { readFile } from 'node:fs/promises';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { RequestError } from '../runtime/journal.js';

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
  id: string; conversation_id: string; sequence: string;
  kind: ConversationEvent['kind']; role: ConversationEvent['role'];
  run_id: string | null; created_at: Date;
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
    const inserted = await this.pool.query<ConversationRow>(
      `INSERT INTO meridian_conversations (id, owner_id) VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING RETURNING *`,
      [id, owner],
    );
    if (inserted.rows[0]) return conversation(inserted.rows[0]);
    const existing = await this.pool.query<ConversationRow>('SELECT * FROM meridian_conversations WHERE id = $1', [id]);
    const row = existing.rows[0];
    if (row?.owner_id === owner && row.deleted_at === null) return conversation(row);
    throw new RequestError(409, 'Conversation ID is unavailable');
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
      const row = await this.lock(client, owner, id);
      if (Number(row.revision) !== expectedRevision) throw new RequestError(409, 'Conversation revision conflict');
      const updated = await client.query<ConversationRow>(
        `UPDATE meridian_conversations
         SET archived = $1, revision = revision + 1, updated_at = clock_timestamp()
         WHERE id = $2 RETURNING *`,
        [archived, id],
      );
      return conversation(updated.rows[0]!);
    });
  }

  async delete(owner: string, id: string, expectedRevision: number): Promise<void> {
    [owner, id, expectedRevision] = parse(z.tuple([uuid, uuid, revision]), [owner, id, expectedRevision]);
    await this.transaction(async client => {
      const row = await this.lock(client, owner, id);
      if (Number(row.revision) !== expectedRevision) throw new RequestError(409, 'Conversation revision conflict');
      await client.query('DELETE FROM meridian_conversation_events WHERE conversation_id = $1', [id]);
      await client.query(
        `UPDATE meridian_conversations
         SET deleted_at = clock_timestamp(), revision = revision + 1, updated_at = clock_timestamp()
         WHERE id = $1`,
        [id],
      );
    });
  }

  async append(owner: string, id: string, value: AppendEvent): Promise<ConversationEvent> {
    [owner, id] = parse(identity, [owner, id]);
    const pending = parse(appendEvent, value);
    return this.transaction(async client => {
      const row = await this.lock(client, owner, id);
      const found = await client.query<EventRow>('SELECT * FROM meridian_conversation_events WHERE id = $1', [pending.id]);
      const existing = found.rows[0];
      if (existing) {
        if (existing.conversation_id === id && existing.kind === pending.kind && existing.role === pending.role
            && existing.run_id === (pending.runId ?? null)) return event(existing);
        throw new RequestError(409, 'Conversation event conflicts with an existing event');
      }
      if (row.archived) throw new RequestError(409, 'Conversation is archived');
      if (Number(row.revision) !== pending.expectedRevision) throw new RequestError(409, 'Conversation revision conflict');

      const sequence = pending.expectedRevision + 1;
      await client.query(
        `UPDATE meridian_conversations
         SET revision = $1, updated_at = clock_timestamp()
         WHERE id = $2`,
        [sequence, id],
      );
      const inserted = await client.query<EventRow>(
        `INSERT INTO meridian_conversation_events (id, conversation_id, sequence, kind, role, run_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO NOTHING RETURNING *`,
        [pending.id, id, sequence, pending.kind, pending.role, pending.runId ?? null],
      );
      if (!inserted.rows[0]) throw new RequestError(409, 'Conversation event conflicts with an existing event');
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
         WHERE conversation_id = $1 AND sequence > $2
         ORDER BY sequence LIMIT $3`,
        [id, parsed.after, parsed.limit + 1],
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
