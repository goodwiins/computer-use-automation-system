import type { Pool } from 'pg';
import { Journal, type RunJournal } from './journal.js';
import { readAuthorityMarker } from './journal-maintenance.js';
import { PostgresJournal } from './postgres-journal.js';

/** Open the configured authoritative journal; PostgreSQL never falls back to filesystem state. */
export async function openRunJournal(dir: string, key: string, pool?: Pool): Promise<RunJournal> {
  const mode = process.env.RUN_JOURNAL ?? 'filesystem';
  if (mode === 'filesystem') return new Journal(dir, key);
  if (mode !== 'postgres') throw new Error('RUN_JOURNAL must be filesystem or postgres');
  if (!pool) throw new Error('PostgreSQL journal requires a configured pool');
  await PostgresJournal.migrate(pool);
  const marker = readAuthorityMarker(dir, key);
  return PostgresJournal.open(pool, key, marker.importId, marker.digest);
}
