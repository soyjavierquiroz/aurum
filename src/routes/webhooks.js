// src/routes/webhooks.js
import { Router } from 'express';
import { DateTime } from 'luxon';
import { getKnex } from '../db/knex.js';
import { getRedis } from '../clients/redis.js';
import { schedulePing10, cancelDependentReminders } from '../services/jobs.js';

function buildConv({ user_id, telefono, instancia_evolution_api, dominio }) {
  return {
    user_id: Number(user_id),
    telefono: String(telefono || '').trim(),
    instancia_evolution_api: String(instancia_evolution_api || '').trim(),
    dominio: String(dominio || '').trim(),
  };
}

function parseTs(ts) {
  // admite epoch ms/seg o ISO string; devuelve ISO miliseg
  if (ts == null) return new Date().toISOString();
  if (typeof ts === 'number') {
    // si parece segundos (10 dígitos), multiplica a ms
    const ms = ts < 1e12 ? ts * 1000 : ts;
    return new Date(ms).toISOString();
  }
  const d = new Date(ts);
  return isNaN(d) ? new Date().toISOString() : d.toISOString();
}

export function webhookRoutes({ logger }) {
  const router = Router();
  const redis = getRedis();

  // Sencillos healthz/readyz si no los tienes en otro archivo
  router.get('/healthz', (_req, res) => res.status(200).send('ok'));
  router.get('/readyz', (_req, res) => res.status(200).send('ok'));

  /**
   * POST /webhooks/message
   * Body: { user_id, telefono, instancia_evolution_api, dominio, msg_id, ts }
   * - Dedupe por conv+msg_id (Redis)
   * - Upsert conversación
   * - Cancela D+1/3/7 (cancel_on_new_ping=1)
   * - Reprograma ping10
   */
  router.post('/webhooks/message', async (req, res) => {
    const trace_id = req.traceId;
    try {
      const { user_id, telefono, instancia_evolution_api, dominio, msg_id, ts } = req.body || {};

      if (!user_id || !telefono || !instancia_evolution_api || !dominio) {
        return res.status(400).json({ error: 'bad_request', trace_id });
      }
      const conv = buildConv({ user_id, telefono, instancia_evolution_api, dominio });
      const knex = getKnex();

      // --- DEDUPE (conv + msg_id) ---
      if (redis && msg_id) {
        const dedupeKey = `aurum:dedupe:webhook:${conv.user_id}:${conv.telefono}:${conv.instancia_evolution_api}:${conv.dominio}:${msg_id}`;
        // 2 días de TTL
        const ok = await redis.set(dedupeKey, '1', 'NX', 'EX', 172800);
        if (ok === null) {
          // ya existe
          return res.json({ ok: true, deduped: true, trace_id });
        }
      }

      // --- Upsert conversación ---
      // intenta obtener zona del lead (Midas) para fijar tz
      const lead = await knex('wa_bot_leads')
        .select('zona_horaria')
        .where(conv)
        .first();

      const tzEff = lead?.zona_horaria || process.env.DEFAULT_TIMEZONE || 'America/La_Paz';
      const tsISO = parseTs(ts);

      const existing = await knex('aurum_conversations').where(conv).first();
      if (!existing) {
        await knex('aurum_conversations').insert({
          ...conv,
          last_activity_at: new Date(tsISO),
          last_ping_at: null,
          window_msg_count: 1,
          timezone_effective: tzEff,
          created_at: knex.fn.now(),
          updated_at: knex.fn.now()
        });
      } else {
        // si el mensaje es nuevo respecto a last_activity_at, incrementa; si no, deja en 1
        let incTo = 1;
        try {
          const last = existing.last_activity_at ? DateTime.fromJSDate(existing.last_activity_at) : null;
          const nowD = DateTime.fromISO(tsISO);
          incTo = last && nowD <= last ? (existing.window_msg_count || 0) : (existing.window_msg_count || 0) + 1;
        } catch {
          incTo = (existing.window_msg_count || 0) + 1;
        }

        await knex('aurum_conversations')
          .where(conv)
          .update({
            last_activity_at: new Date(tsISO),
            window_msg_count: incTo,
            timezone_effective: tzEff,
            updated_at: knex.fn.now()
          });
      }

      // --- CANCELA recordatorios dependientes inmediatamente ---
      await cancelDependentReminders(conv);

      // --- Reprograma ping10 desde este ts ---
      await schedulePing10(conv, tsISO, tzEff);

      return res.json({ ok: true, reprogrammed_ping10: true, trace_id });
    } catch (err) {
      logger?.error({ err, trace_id: req.traceId }, 'POST /webhooks/message failed');
      return res.status(500).json({ error: 'internal_error', trace_id: req.traceId });
    }
  });

  return router;
}
