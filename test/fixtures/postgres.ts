import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

export async function createPostgresFixture() {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('TEST_DATABASE_URL is required for PostgreSQL conversation tests');

  const schema = `test_conversations_${randomUUID().replaceAll('-', '')}`;
  const controller = new Pool({ connectionString, max: 1 });
  try { await controller.query(`CREATE SCHEMA "${schema}"`); }
  finally { await controller.end(); }

  const pools = new Set<Pool>();
  const openPool = () => {
    const pool = new Pool({ connectionString, options: `-c search_path=${schema}` });
    pools.add(pool);
    return pool;
  };
  const closePool = async (pool: Pool) => {
    if (!pools.delete(pool)) return;
    await pool.end();
  };
  const close = async () => {
    await Promise.all([...pools].map(closePool));
    const cleanup = new Pool({ connectionString, max: 1 });
    try { await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await cleanup.end(); }
  };

  return { pool: openPool(), openPool, closePool, close };
}
