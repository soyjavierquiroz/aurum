import express from 'express';
import pinoHttp from 'pino-http';
import { logger } from './lib/logger.js';
import { observabilityRoutes } from './routes/observability.js';
import { requestContext } from './middleware/requestContext.js';
import { webhookRoutes } from './routes/webhooks.js';
import { leadsRoutes } from './routes/leads.js';
import { remindersRoutes } from './routes/reminders.js';
import { adminRoutes } from './routes/admin.js';

export function buildApp() {
  const app = express();

  if (String(process.env.APP_TRUST_PROXY || '0') === '1') {
    app.set('trust proxy', true);
  }

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  app.use(requestContext());
  app.use(pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          method: req.method, url: req.url, trace_id: req.traceId,
          remoteAddress: req.ip, userAgent: req.headers['user-agent']
        };
      },
      res(res) { return { statusCode: res.statusCode }; }
    },
    customSuccessMessage(req, res) { return `${req.method} ${req.url} -> ${res.statusCode}`; }
  }));

  app.use(observabilityRoutes({ logger }));
  app.use(webhookRoutes({ logger }));
  app.use(leadsRoutes({ logger }));
  app.use(remindersRoutes({ logger }));
  app.use(adminRoutes({ logger }));

  app.use((req, res) => res.status(404).json({ error: 'not_found', trace_id: req.traceId }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    logger.error({ err, trace_id: req.traceId }, 'unhandled_error');
    res.status(500).json({ error: 'internal_error', trace_id: req.traceId });
  });

  return app;
}
