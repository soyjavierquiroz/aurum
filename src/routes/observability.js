import { Router } from 'express';
import { register, httpRequestDuration } from '../lib/metrics.js';
import { pingDB } from '../clients/mysql.js';
import { pingRedis } from '../clients/redis.js';

export function observabilityRoutes({ logger }) {
  const router = Router();

  router.get('/healthz', async (req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      now: new Date().toISOString(),
      trace_id: req.traceId
    });
  });

  router.get('/readyz', async (req, res) => {
    const start = process.hrtime.bigint();

    const [db, redis] = await Promise.all([
      pingDB(), pingRedis()
    ]);

    const allConfigured = [db, redis].every(x => x.configured);
    const allOk = [db, redis].every(x => x.ok);

    const statusCode = allConfigured ? (allOk ? 200 : 503) : 200;

    const body = {
      status: statusCode === 200 ? 'ready' : 'not_ready',
      dependencies: { db, redis },
      trace_id: req.traceId
    };

    const end = process.hrtime.bigint();
    const duration = Number(end - start) / 1e9;
    httpRequestDuration.labels('GET', '/readyz', String(statusCode)).observe(duration);

    if (statusCode !== 200) logger.warn({ ...body }, 'readiness check not ready');

    res.status(statusCode).json(body);
  });

  router.get('/metrics', async (req, res) => {
    res.setHeader('Content-Type', register.contentType);
    res.end(await register.metrics());
  });

  return router;
}
