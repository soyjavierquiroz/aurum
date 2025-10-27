// src/routes/observability.js
import { Router } from 'express';
import { pingRedis } from '../clients/redis.js';
import { getKnex } from '../db/knex.js';
import { metricsHandler } from '../metrics.js';

const REV = process.env.AURUM_REV || 'dev';

export function observabilityRoutes({ logger }) {
  const router = Router();

  // --- /healthz: liveness ---
  router.get('/healthz', async (req, res) => {
    const startedAt = Number(process.uptime());
    return res.json({
      status: 'ok',
      uptime: startedAt,
      now: new Date().toISOString(),
      version: REV,
      trace_id: req.traceId,
    });
  });

  // --- /readyz: readiness con chequeos básicos ---
  router.get('/readyz', async (req, res) => {
    const deps = {
      db: { configured: false, ok: false },
      redis: { configured: false, ok: false },
    };

    // Redis
    const r = await pingRedis();
    deps.redis.configured = r.error !== 'no_redis';
    deps.redis.ok = !!r.ok;

    // DB (Knex)
    try {
      const knex = getKnex();
      if (knex) {
        deps.db.configured = true;
        await knex.raw('SELECT 1'); // ping
        deps.db.ok = true;
      }
    } catch {
      deps.db.ok = false;
    }

    const ready = deps.db.ok && deps.redis.ok;
    res.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'not_ready',
      version: REV,
      dependencies: deps,
      trace_id: req.traceId,
    });
  });

  // --- /metrics: Prometheus ---
  router.get('/metrics', metricsHandler);

  return router;
}
