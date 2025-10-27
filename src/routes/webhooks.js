// src/routes/webhooks.js
import { Router } from 'express';
import { getKnex } from '../db/knex.js';
import { logger as defaultLogger } from '../lib/logger.js';
import { msgOnce } from '../clients/redis.js';
import { ping10Queue } from '../services/jobs.js';
import { incomingMessageCounter } from '../metrics.js';

function buildConv({ user_id, telefono, instancia_evolution_api, dominio }) {
  return {
    user_id: Number(user_id),
    telefono: String(telefono || '').trim(),
    instancia_evolution_api: String(instancia_evolution_api || '').trim(),
    dominio: String(dominio || '').trim(),
  };
}

function normalizeTelefono(raw) {
  if (!raw) return '';
  return String(raw).replace(/\D/g, '');
}

/**
 * Rutas de webhooks (MVP):
 *  - POST /webhooks/message
 *      Body: { user_id, telefono | telefono_raw, instancia_evolution_api|instance|instanceId, dominio, msg_id?, ts?(epoch ms) }
 *      Idempotencia por msg_id; crea/actualiza conversación; reprograma ping10 para +10min desde ts.
 */
export function webhookRoutes({ logger } = {}) {
  const log = logger || defaultLogger;
  const router = Router();

  router.post('/webhooks/message', async (req, res) => {
    try {
      const b = req.body || {};

      // Permitir telefono_raw; permitir instance|instanceId como alias
      const telefono = b.telefono ? b.telefono : normalizeTelefono(b.telefono_raw);
      const instancia = b.instancia_evolution_api || b.instance || b.instanceId;

      const conv = buildConv({
        user_id: b.user_id,
        telefono,
        instancia_evolution_api: instancia,
        dominio: b.dominio,
      });

      // Validación mínima
      if (!conv.user_id || !conv.telefono || !conv.instancia_evolution_api || !conv.dominio) {
        incomingMessageCounter.labels('bad_request').inc();
        return res.status(400).json({ error: 'bad_request', trace_id: req.traceId });
      }

      // Idempotencia por msg_id (si hay)
      if (b.msg_id) {
        const first = await msgOnce(b.msg_id);
        if (!first) {
          incomingMessageCounter.labels('deduped').inc();
          return res.json({ ok: true, deduped: true, trace_id: req.traceId });
        }
      }

      // Timestamp (epoch ms) con fallback a ahora
      const tsMs = Number.isFinite(Number(b.ts)) ? Number(b.ts) : Date.now();

      const knex = getKnex();

      // Asegurar conversación y last_activity_at
      const tzEff = process.env.DEFAULT_TIMEZONE || 'America/La_Paz';
      const existing = await knex('aurum_conversations').where(conv).first();

      if (!existing) {
        await knex('aurum_conversations').insert({
          ...conv,
          last_activity_at: new Date(tsMs),
          window_msg_count: 1,
          timezone_effective: tzEff,
          created_at: knex.fn.now(),
          updated_at: knex.fn.now()
        });
      } else {
        await knex('aurum_conversations')
          .where(conv)
          .update({
            last_activity_at: new Date(tsMs),
            window_msg_count: (existing.window_msg_count || 0) + 1,
            updated_at: knex.fn.now()
          });
      }

      // Reprogramar ping10 para +10 minutos desde ts
      const delayMs = Math.max(0, (tsMs + 10 * 60 * 1000) - Date.now());
      const key = `${conv.user_id}:${conv.telefono}:${conv.instancia_evolution_api}:${conv.dominio}`;

      await ping10Queue.add('ping10', { conv }, {
        jobId: `ping10:${key}`,
        delay: delayMs,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: false
      });

      incomingMessageCounter.labels('accepted').inc();
      return res.json({ ok: true, reprogrammed_ping10: true, trace_id: req.traceId });
    } catch (err) {
      log.error({ err, trace_id: req.traceId }, 'webhooks.message failed');
      incomingMessageCounter.labels('error').inc();
      return res.status(500).json({ error: 'internal_error', trace_id: req.traceId });
    }
  });

  return router;
}

// Export alias para compatibilidad: singular y plural
export { webhookRoutes as webhooksRoutes };
