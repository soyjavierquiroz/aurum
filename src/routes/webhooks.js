import { Router } from 'express';
import crypto from 'node:crypto';
import { getKnex } from '../db/knex.js';
import { getRedis, msgOnce } from '../clients/redis.js';
import { schedulePing10, cancelPing10, cancelDependentReminders } from '../services/jobs.js';
import { DateTime } from 'luxon';

export function webhookRoutes({ logger }) {
  const router = Router();

  router.post('/webhooks/message', async (req, res) => {
    const { user_id, telefono, instancia_evolution_api, dominio, ts, msg_id } = req.body || {};
    if (!user_id || !telefono || !instancia_evolution_api || typeof dominio === 'undefined') {
      return res.status(400).json({ error: 'bad_request', details: 'missing conversation key', trace_id: req.traceId });
    }

    // Idempotencia por msg_id (o hash del body si falta)
    const bodyStr = JSON.stringify(req.body);
    const dedupeKey = `msg:${msg_id || crypto.createHash('sha1').update(bodyStr).digest('hex')}`;
    const firstTime = await msgOnce(dedupeKey, 86400);
    if (!firstTime) {
      return res.json({ ok: true, deduped: true, trace_id: req.traceId });
    }

    const knex = getKnex();
    // Verificar existencia en Midas (wa_bot_leads)
    const lead = await knex('wa_bot_leads')
      .select('lead_id', 'zona_horaria', 'lead_status', 'lead_business_status_key')
      .where({
        user_id,
        telefono,
        instancia_evolution_api,
        dominio
      }).first();

    if (!lead) {
      logger.warn({ user_id, telefono, instancia_evolution_api, dominio, trace_id: req.traceId }, 'lead_no_encontrado');
      return res.status(404).json({ error: 'lead_no_encontrado', trace_id: req.traceId });
    }

    // timestamps
    const now = DateTime.now();
    const eventTs = ts ? DateTime.fromMillis(Number(ts)) : now;
    let conv = { user_id, telefono, instancia_evolution_api, dominio };

    // Actualizar/crear aurum_conversations (UPSERT por PK compuesta)
    const tzEffective = lead.zona_horaria || process.env.DEFAULT_TIMEZONE || 'America/La_Paz';
    try {
      await knex.raw(`
        INSERT INTO aurum_conversations (user_id, telefono, instancia_evolution_api, dominio, last_activity_at, window_msg_count, timezone_effective, working_window, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 2, ?, NULL, NOW(), NOW())
        ON DUPLICATE KEY UPDATE
          last_activity_at = GREATEST(VALUES(last_activity_at), last_activity_at),
          window_msg_count = window_msg_count + 2,
          timezone_effective = VALUES(timezone_effective),
          updated_at = NOW()
      `, [user_id, telefono, instancia_evolution_api, dominio, eventTs.toSQL({ includeOffset: false }), tzEffective]);
    } catch (e) {
      logger.error({ err: e, trace_id: req.traceId }, 'update_conversation_failed');
      return res.status(500).json({ error: 'internal_error', trace_id: req.traceId });
    }

    // Cancelar Ping10 y dependientes previos y reprogramar
    await cancelPing10(conv);
    await cancelDependentReminders(conv);
    await schedulePing10(conv, eventTs.toISO(), tzEffective);

    // Estado operacional a contactable (Aurum + Midas)
    try {
      // Aurum_lead_state (UPSERT simple por PK compuesta)
      await knex.raw(`
        INSERT INTO aurum_lead_state (user_id, telefono, instancia_evolution_api, dominio, operational_status_key, effective_at, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'contactable', NOW(), 'webhook', NOW(), NOW())
        ON DUPLICATE KEY UPDATE
          operational_status_key = 'contactable',
          effective_at = NOW(),
          source = 'webhook',
          updated_at = NOW()
      `, [user_id, telefono, instancia_evolution_api, dominio]);

      // Midas lead_status
      await knex('wa_bot_leads')
        .where({ user_id, telefono, instancia_evolution_api, dominio })
        .update({ lead_status: 'contactable', lead_status_updated_at: knex.fn.now() });
    } catch (e) {
      logger.error({ err: e, trace_id: req.traceId }, 'update_status_failed');
    }

    return res.json({ ok: true, reprogrammed_ping10: true, trace_id: req.traceId });
  });

  return router;
}
