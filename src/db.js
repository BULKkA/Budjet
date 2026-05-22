const { Pool } = require('pg');

let pool;

function getPool() {
  if (pool) return pool;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set');
  }

  pool = new Pool({
    connectionString: databaseUrl,
    // keep resource usage low
    max: Number(process.env.PG_POOL_MAX || 5),
    idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
    connectionTimeoutMillis: Number(process.env.PG_CONN_TIMEOUT_MS || 10000),
  });

  return pool;
}

async function ensureSchema() {
  const db = getPool();
  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Current canonical entity state (versioned)
    await client.query(`
      CREATE TABLE IF NOT EXISTS sync_entities (
        user_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        version BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at TIMESTAMPTZ NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        PRIMARY KEY (user_id, entity_type, entity_id)
      );
    `);

    // Change feed (append-only)
    await client.query(`
      CREATE TABLE IF NOT EXISTS sync_change_events (
        event_id BIGSERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('UPSERT','DELETE')),
        version BIGINT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        deleted_at TIMESTAMPTZ NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Indexes for cursor-based pagination and lookup efficiency
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sync_change_events_user_event
      ON sync_change_events (user_id, event_id);
    `);

    // Idempotency: applied mutations cache
    await client.query(`
      CREATE TABLE IF NOT EXISTS sync_applied_mutations (
        user_id TEXT NOT NULL,
        mutation_id TEXT NOT NULL,
        status TEXT NOT NULL,
        conflict_type TEXT NULL,
        applied_version BIGINT NULL,
        current_version BIGINT NULL,
        remote_updated_at TIMESTAMPTZ NULL,
        result_payload JSONB NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, mutation_id)
      );
    `);

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

function getDb() {
  return getPool();
}

module.exports = {
  getDb,
  ensureSchema,
};
