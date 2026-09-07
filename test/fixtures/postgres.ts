import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

export async function createPostgresFixture() {
  const configuredUrl = process.env.TEST_DATABASE_URL;
  if (!configuredUrl) throw new Error('TEST_DATABASE_URL is required for PostgreSQL conversation tests');
  const databaseUrl = new URL(configuredUrl);
  databaseUrl.searchParams.delete('options');
  const isolatedConnectionString = databaseUrl.toString();

  const schema = `test_conversations_${randomUUID().replaceAll('-', '')}`;
  const schemaUrl = new URL(isolatedConnectionString);
  schemaUrl.searchParams.set('options', `-c search_path=${schema}`);
  schemaUrl.searchParams.set('application_name', schema);
  const connectionString = schemaUrl.toString();
  const controller = new Pool({ connectionString: isolatedConnectionString, max: 1 });
  try { await controller.query(`CREATE SCHEMA "${schema}"`); }
  finally { await controller.end(); }

  const pools = new Set<Pool>();
  const openPool = () => {
    const pool = new Pool({ connectionString });
    pools.add(pool);
    return pool;
  };
  const closePool = async (pool: Pool) => {
    if (!pools.delete(pool)) return;
    await pool.end();
  };
  const close = async () => {
    await Promise.all([...pools].map(closePool));
    const cleanup = new Pool({ connectionString: isolatedConnectionString, max: 1 });
    try { await cleanup.query(`DROP SCHEMA "${schema}" CASCADE`); }
    finally { await cleanup.end(); }
  };

  return { connectionString, pool: openPool(), openPool, closePool, close };
}
