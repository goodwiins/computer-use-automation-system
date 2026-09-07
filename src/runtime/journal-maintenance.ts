import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Pool } from 'pg';
import { journalDigest, readJournalSnapshot, readSignedEnvelope, AuthorityMarkerSchema, type AuthorityMarker } from './journal.js';
import { PostgresJournal } from './postgres-journal.js';

const MARKER = 'postgres-authority.json';

function markerPath(dir: string): string { return join(dir, MARKER); }

function parseMarker(dir: string, key: string): AuthorityMarker {
  return AuthorityMarkerSchema.parse(readSignedEnvelope(markerPath(dir), key));
}

function syncDir(dir: string): void {
  const fd = openSync(dir, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function writeMarker(dir: string, key: string, marker: AuthorityMarker): void {
  const path = markerPath(dir);
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(tmp, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ record: marker, signature: journalDigest(key, marker) }));
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    renameSync(tmp, path);
    syncDir(dirname(path));
  } catch (error) {
    try { unlinkSync(tmp); } catch { /* publication may have happened */ }
    throw error;
  }
}

/** Return the completed cutover marker for runtime PostgreSQL open. */
export function readAuthorityMarker(dir: string, key: string): { importId: string; digest: string } {
  const marker = parseMarker(dir, key);
  if (marker.phase !== 'complete') throw new Error('PostgreSQL journal import is pending');
  return { importId: marker.importId, digest: marker.digest };
}

/** Import an authenticated filesystem snapshot while fencing every local writer. */
export async function importJournal(dir: string, pool: Pool, key: string): Promise<void> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const startup = join(dir, 'startup.lock');
  let startupFd: number;
  try { startupFd = openSync(startup, 'wx', 0o600); }
  catch { throw new Error('Journal import is already in progress'); }
  try {
    if (existsSync(join(dir, 'server.lock'))) throw new Error('Filesystem journal is running');
    const snapshot = readJournalSnapshot(dir, key);
    const digest = journalDigest(key, snapshot);
    const path = markerPath(dir);
    const marker = existsSync(path)
      ? parseMarker(dir, key)
      : { importId: randomUUID(), digest, phase: 'pending' as const };
    if (marker.digest !== digest) throw new Error('Journal authority marker does not match snapshot');
    if (!existsSync(path)) writeMarker(dir, key, marker);
    await PostgresJournal.importSnapshot(pool, key, snapshot, marker.importId, marker.digest, marker.phase === 'pending');
    if (marker.phase === 'pending') writeMarker(dir, key, { ...marker, phase: 'complete' });
  } finally {
    closeSync(startupFd);
    try { unlinkSync(startup); } catch { /* release only our lock; preserve another owner */ }
  }
}
