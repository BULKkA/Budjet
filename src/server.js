require('dotenv').config();

const fastify = require('fastify')({
  logger: true
});

const jwt = require('jsonwebtoken');
const { getDb, ensureSchema } = require('./db');

const PORT = Number(process.env.PORT || 3000);

function requireAuth(req, reply) {
  const header = req.headers['authorization'];

  if (!header) {
    req.log.warn('auth failed: missing Authorization header');
    reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Missing Authorization header' });
    return;
  }

  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    req.log.warn({ authHeaderLen: String(header).length }, 'auth failed: invalid Authorization header format');
    reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Invalid Authorization header format' });
    return;
  }

  const token = m[1];
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    req.log.error('auth failed: JWT_SECRET is not set');
    reply.code(500).send({ error: 'SERVER_MISCONFIG', message: 'JWT_SECRET is not set' });
    return;
  }

  req.log.info({ tokenLen: token.length }, 'auth: token received');

  try {
    const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
    const userId = decoded.sub || decoded.userId;
    if (!userId) throw new Error('Missing userId in token');
    req.userId = String(userId);
    req.log.info({ userId: req.userId, tokenLen: token.length }, 'auth success');
  } catch (e) {
    req.log.warn({ tokenLen: token.length, err: e?.message }, 'auth failed: invalid token');
    reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Invalid token' });
  }
}

function normalizeCatalogItem(entityType, entityId, payload) {
  if (entityType !== 'CATALOG_ITEM') return { entityId, payload };

  if (!payload || typeof payload !== 'object') return { entityId, payload };

  const kind = payload.kind;
  if (kind === 'STANDARD') {
    const standardId = payload.standardId;
    if (typeof standardId !== 'string' || standardId.length === 0) return { entityId, payload };
    // Canonical entityId is the standardId
    const canonicalEntityId = standardId;
    return {
      entityId: canonicalEntityId,
      payload: {
        ...payload,
        kind: 'STANDARD',
        standardId
      }
    };
  }

  if (kind === 'USER_CREATED') {
    return { entityId, payload };
  }

  return { entityId, payload };
}

fastify.get('/health', async () => ({ ok: true }));

fastify.route({
  method: 'POST',
  url: '/v1/sync/push',
  preHandler: [requireAuth],
  schema: {
    body: {
      type: 'object',
      required: ['mutations'],
      properties: {
        mutations: {
          type: 'array',
          minItems: 1,
          // resource-limits: keep batches small
          maxItems: 100,
          items: {
            type: 'object',
            required: ['mutationId', 'entityType', 'entityId', 'action'],
            properties: {
              mutationId: { type: 'string' },
              entityType: { type: 'string' },
              entityId: { type: 'string' },
              action: { type: 'string', enum: ['UPSERT', 'DELETE'] },
              baseVersion: { type: ['integer', 'null'] },
              payload: { type: ['object', 'null'] }
            },
            additionalProperties: false
          }
        }
      },
      additionalProperties: false
    },
    response: {
      200: {
        type: 'object',
        properties: {
          results: { type: 'array' },
          nextCursor: { type: ['string', 'null'] }
        }
      }
    }
  },
  handler: async (req, reply) => {
    const userId = req.userId;
    const mutations = req.body.mutations;

    req.log.info({ userId, mutationsCount: mutations?.length ?? 0 }, 'sync push start');

    // extra guard (in case schema maxItems is bypassed by custom serializers)
    const MAX_MUTATIONS = Number(process.env.MAX_MUTATIONS_PER_REQUEST || 100);
    if (mutations.length > MAX_MUTATIONS) {
      return reply.code(400).send({
        error: 'MUTATIONS_TOO_LARGE',
        message: `Max mutations per request is ${MAX_MUTATIONS}`,
      });
    }

    const db = getDb();
    const client = await db.connect();

    let nextCursor = null;

    try {
      await client.query('BEGIN');

      const results = [];

      for (const mutation of mutations) {
        const mutationId = mutation.mutationId;
        const entityType = mutation.entityType;
        let entityId = mutation.entityId;
        const action = mutation.action;
        const baseVersion = mutation.baseVersion === null ? null : Number(mutation.baseVersion);
        const rawPayload = mutation.payload;

        // Normalize catalog standard/user-created mapping
        let payload = rawPayload;
        const normalized = normalizeCatalogItem(entityType, entityId, payload);
        entityId = normalized.entityId;
        payload = normalized.payload;

        // 1) Idempotency check
        const appliedRes = await client.query(
          `
          SELECT mutation_id, status, conflict_type, applied_version, current_version, remote_updated_at, result_payload
          FROM sync_applied_mutations
          WHERE user_id = $1 AND mutation_id = $2
          `,
          [userId, mutationId]
        );

        if (appliedRes.rowCount === 1) {
          const row = appliedRes.rows[0];
          results.push({
            mutationId,
            status: row.status,
            appliedVersion: row.applied_version ?? undefined,
            ...(row.status === 'CONFLICT'
              ? {
                  currentVersion: row.current_version,
                  remoteUpdatedAt: row.remote_updated_at ? row.remote_updated_at.toISOString() : undefined,
                  conflictType: row.conflict_type
                }
              : {})
          });
          continue;
        }

        // 2) Validate mutation payload
        if (action === 'UPSERT') {
          if (!payload || typeof payload !== 'object') {
            await client.query(
              `
              INSERT INTO sync_applied_mutations (user_id, mutation_id, status, conflict_type, result_payload)
              VALUES ($1, $2, 'INVALID', 'MISSING_PAYLOAD', $3::jsonb)
              `,
              [userId, mutationId, JSON.stringify({})]
            );

            results.push({ mutationId, status: 'INVALID' });
            continue;
          }

          if (entityType === 'CATALOG_ITEM' && payload.kind === 'STANDARD') {
            if (typeof payload.standardId !== 'string' || payload.standardId.length === 0) {
              await client.query(
                `
                INSERT INTO sync_applied_mutations (user_id, mutation_id, status, conflict_type, result_payload)
                VALUES ($1, $2, 'INVALID', 'MISSING_STANDARD_ID', $3::jsonb)
                `,
                [userId, mutationId, JSON.stringify({})]
              );
              results.push({ mutationId, status: 'INVALID' });
              continue;
            }
          }
        }

        // 3) Load current entity state (for version conflict checks)
        const currentRes = await client.query(
          `
          SELECT version, updated_at, deleted_at
          FROM sync_entities
          WHERE user_id = $1 AND entity_type = $2 AND entity_id = $3
          FOR UPDATE
          `,
          [userId, entityType, entityId]
        );

        const exists = currentRes.rowCount === 1;
        const currentVersion = exists ? Number(currentRes.rows[0].version) : 0;
        const currentUpdatedAt = exists ? currentRes.rows[0].updated_at : null;

        // 4) Conflict check
        if (baseVersion !== null && baseVersion !== currentVersion) {
          await client.query(
            `
            INSERT INTO sync_applied_mutations (
              user_id, mutation_id, status, conflict_type,
              applied_version, current_version, remote_updated_at
            )
            VALUES ($1,$2,'CONFLICT','VERSION_MISMATCH',NULL,$3,$4)
            `,
            [userId, mutationId, currentVersion, currentUpdatedAt]
          );

          results.push({
            mutationId,
            status: 'CONFLICT',
            currentVersion,
            remoteUpdatedAt: currentUpdatedAt ? currentUpdatedAt.toISOString() : undefined,
            conflictType: 'VERSION_MISMATCH'
          });
          continue;
        }

        // 5) Apply mutation: update sync_entities and append change event
        const newVersion = currentVersion + 1;
        const now = new Date();

        if (action === 'UPSERT') {
          const upPayload = payload ?? {};

          await client.query(
            `
            INSERT INTO sync_entities (user_id, entity_type, entity_id, version, updated_at, deleted_at, payload)
            VALUES ($1,$2,$3,$4,$5,NULL,$6::jsonb)
            ON CONFLICT (user_id, entity_type, entity_id)
            DO UPDATE SET
              version = EXCLUDED.version,
              updated_at = EXCLUDED.updated_at,
              deleted_at = EXCLUDED.deleted_at,
              payload = EXCLUDED.payload
            `,
            [userId, entityType, entityId, newVersion, now, JSON.stringify(upPayload)]
          );
        } else if (action === 'DELETE') {
          await client.query(
            `
            INSERT INTO sync_entities (user_id, entity_type, entity_id, version, updated_at, deleted_at, payload)
            VALUES ($1,$2,$3,$4,$5,$5,'{}'::jsonb)
            ON CONFLICT (user_id, entity_type, entity_id)
            DO UPDATE SET
              version = EXCLUDED.version,
              updated_at = EXCLUDED.updated_at,
              deleted_at = EXCLUDED.deleted_at
            `,
            [userId, entityType, entityId, newVersion, now]
          );
        } else {
          // should never happen because schema validates action
          await client.query(
            `
            INSERT INTO sync_applied_mutations (user_id, mutation_id, status, conflict_type, result_payload)
            VALUES ($1, $2, 'INVALID', 'UNKNOWN_ACTION', '{}'::jsonb)
            `,
            [userId, mutationId]
          );
          results.push({ mutationId, status: 'INVALID' });
          continue;
        }

        const entityRow = await client.query(
          `
          SELECT payload, deleted_at
          FROM sync_entities
          WHERE user_id=$1 AND entity_type=$2 AND entity_id=$3
          `,
          [userId, entityType, entityId]
        );

        const storedPayload = entityRow.rows[0]?.payload ?? {};
        const deletedAtValue = action === 'DELETE' ? now : null;

        const changeInsertRes = await client.query(
          `
          INSERT INTO sync_change_events (
            user_id, entity_type, entity_id, action, version, updated_at, deleted_at, payload
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
          RETURNING event_id
          `,
          [
            userId,
            entityType,
            entityId,
            action,
            newVersion,
            now,
            deletedAtValue,
            JSON.stringify(action === 'DELETE' ? {} : storedPayload)
          ]
        );

        const eventId = changeInsertRes.rows[0].event_id;
        nextCursor = String(eventId);

        await client.query(
          `
          INSERT INTO sync_applied_mutations (
            user_id, mutation_id, status, conflict_type,
            applied_version, current_version, remote_updated_at, result_payload
          )
          VALUES ($1,$2,'APPLIED',NULL,$3,$4,$5,NULL)
          `,
          [userId, mutationId, newVersion, currentVersion, currentUpdatedAt]
        );

        results.push({
          mutationId,
          status: 'APPLIED',
          appliedVersion: newVersion
        });
      }

      await client.query('COMMIT');

      return reply.send({
        results,
        nextCursor
      });
    } catch (e) {
      await client.query('ROLLBACK');
      req.log.error(e, 'push failed');
      return reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'push failed' });
    } finally {
      client.release();
    }
  }
});

fastify.route({
  method: 'GET',
  url: '/v1/sync/changes',
  preHandler: [requireAuth],
  schema: {
    querystring: {
      type: 'object',
      properties: {
        cursor: { type: ['string', 'null'] },
        limit: { type: 'integer', minimum: 1, maximum: 500 }
      },
      additionalProperties: false
    },
    response: {
      200: {
        type: 'object',
        properties: {
          changes: { type: 'array' },
          nextCursor: { type: ['string', 'null'] }
        }
      }
    }
  },
  handler: async (req, reply) => {
    const userId = req.userId;

    const cursorRaw = req.query.cursor;
    const limit = Number(req.query.limit || 100);

    req.log.info({ userId, cursorRaw, limit }, 'sync changes start');

    const cursorValue = cursorRaw === null || cursorRaw === undefined ? -1n : BigInt(cursorRaw);

    const db = getDb();
    const client = await db.connect();

    try {
      const res = await client.query(
        `
        SELECT
          event_id,
          entity_type,
          entity_id,
          action,
          version,
          updated_at,
          deleted_at,
          payload
        FROM sync_change_events
        WHERE user_id = $1 AND event_id > $2
        ORDER BY event_id ASC
        LIMIT $3
        `,
        [userId, cursorValue, limit]
      );

      const changes = res.rows.map((row) => {
        const payload = row.action === 'DELETE' ? null : row.payload;
        return {
          cursorEventId: String(row.event_id),
          entityType: row.entity_type,
          entityId: row.entity_id,
          action: row.action,
          version: Number(row.version),
          updatedAt: row.updated_at ? row.updated_at.toISOString() : null,
          deletedAt: row.deleted_at ? row.deleted_at.toISOString() : null,
          payload
        };
      });

      const nextCursor = changes.length > 0 ? changes[changes.length - 1].cursorEventId : null;

      return reply.send({ changes, nextCursor });
    } catch (e) {
      req.log.error(e, 'pull failed');
      return reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'pull failed' });
    } finally {
      client.release();
    }
  }
});

async function start() {
  await ensureSchema();

  fastify.listen({ port: PORT, host: '0.0.0.0' }, (err) => {
    if (err) {
      fastify.log.error(err);
      process.exit(1);
    }
    fastify.log.info(`expensebackend listening on ${PORT}`);
  });
}

start();
