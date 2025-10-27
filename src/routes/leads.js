// src/routes/leads.js
import { Router } from 'express';
import { getKnex } from '../db/knex.js';
import { scheduleResume, cancelResume } from '../services/jobs.js';
import { stateUpdateCounter } from '../metrics.js';

/**
 * Conv key helpers
 */
function buildConv({ user_id, telefono, instancia_evolution_api, dominio }) {
  return {
    user_id: Number(user_id),
    telefono: String(telefono).trim(),
    instancia_evolution_api: String(instancia_evolution_api).trim(),
    dominio: String(dominio).trim(),
  };
}

function isBlockedMidas(lead_status) {
  // Estados que NO se reabren a menos que se especifique force_reopen
  return ['won', 'opt_out', 'invalid', 'stopped'].includes(String(lead_status || '').toLowerCase());
}

/**
 * GET /leads/state
 * Query: user_id, telefono, instancia_evolution_api, dominio
 * Devuelve: estado actual en Midas + conversación y último estado en Aurum
 */
export function leadsRoutes({ logger }) {
  const router = Router();

  router.get('/leads/state', async (req, res) => {
    try {
      const { user_id, telefono, instancia_evolution_api, dominio } = req.query || {};
      if (!user_id || !telefono || !instancia_evolution_api || !dominio) {
        return res.status(400).json({ error: 'bad_request', trace_id: req.traceId });
      }
      const conv = buildConv({ user_id, telefono, instancia_evolution_api, dominio });
      const knex = getKnex();

      const midas = await knex('wa_bot_leads').where(conv).first();
      const conversation = await knex('aurum_conversations').where(conv).first();
      const state = await knex('aurum_lead_state')
        .where(conv)
        .orderBy([{ column: 'effective_at', order: 'desc' }, { column: 'updated_at', order: 'desc' }])
        .first();

      return res.json({ midas: midas || null, aurum: { conversation: conversation || null, state: state || null }, trace_id: req.traceId });
    } catch (err) {
      logger?.error({ err, trace_id: req.traceId }, 'GET /leads/state failed');
      return res.status(500).json({ error: 'internal_error', trace_id: req.traceId });
    }
  });

  /**
   * POST /leads/state
   * Body:
   *  - (clave conv) user_id, telefono, instancia_evolution_api, dominio
   *  - operational_status_key? : contactable | paused | won | opt_out | invalid | stopped
   *  - business_status_key?    : cualquier clave de negocio válida para el usuario
   *  - paused_until? (ISO)     : requerido si operational_status_key = "paused"
   *  - reason_code?, note?
   *  - force_reopen? (bool)    : para reabrir si Midas está bloqueado (won/opt_out/invalid/stopped)
   */
  router.post('/leads/state', async (req, res) => {
    const knex = getKnex();

    // Labels para métricas (seguras aunque falle antes)
    const opLabel = String(req.body?.operational_status_key || 'none').trim().toLowerCase();
    const bizLabel = String(req.body?.business_status_key || 'none').trim().toLowerCase();

    try {
      const {
        user_id, telefono, instancia_evolution_api, dominio,
        operational_status_key,
        business_status_key,
        paused_until,
        reason_code,
        note,
        force_reopen = false,
      } = req.body || {};

      if (!user_id || !telefono || !instancia_evolution_api || !dominio) {
        stateUpdateCounter.labels('error', opLabel || 'none', bizLabel || 'none').inc();
        return res.status(400).json({ error: 'bad_request', details: 'missing conv key', trace_id: req.traceId });
      }
      const conv = buildConv({ user_id, telefono, instancia_evolution_api, dominio });

      // Validar existencia del lead en Midas
      const midas = await knex('wa_bot_leads').where(conv).first();
      if (!midas) {
        stateUpdateCounter.labels('error', opLabel || 'none', bizLabel || 'none').inc();
        return res.status(404).json({ error: 'lead_no_encontrado', trace_id: req.traceId });
      }

      const blocked = isBlockedMidas(midas.lead_status);
      const op = (operational_status_key || '').trim().toLowerCase();
      const biz = (business_status_key || '').trim().toLowerCase();

      // Reglas de bloqueo
      if (op && blocked && !force_reopen) {
        stateUpdateCounter.labels('blocked', op || 'none', biz || 'none').inc();
        return res.status(409).json({ error: 'blocked_status', details: `lead_status=${midas.lead_status}`, trace_id: req.traceId });
      }

      // Transacción para consistencia
      await knex.transaction(async (trx) => {
        // 1) Reflejo en Midas
        const midasUpdate = {};
        if (op) {
          if (op === 'paused') {
            if (!paused_until) {
              const e = new Error('paused_requires_until');
              e.http = 400;
              throw e;
            }
            // Guardamos 'paused' como lead_status en Midas
            midasUpdate.lead_status = 'paused';
          } else {
            // Para MVP: reflejamos el valor textual si es distinto
            midasUpdate.lead_status = op;
          }
        }
        if (biz) {
          midasUpdate.lead_business_status_key = biz;
        }
        if (Object.keys(midasUpdate).length > 0) {
          midasUpdate.updated_at = trx.fn.now();
          await trx('wa_bot_leads').where(conv).update(midasUpdate);
        }

        // 2) Estado en Aurum (UPSERT técnico)
        if (op || biz || reason_code || note || paused_until) {
          await trx.raw(`
            INSERT INTO aurum_lead_state
              (user_id, telefono, instancia_evolution_api, dominio,
               operational_status_key, business_status_key, reason_code, note, paused_until,
               effective_at, source, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'api', NOW(), NOW())
            ON DUPLICATE KEY UPDATE
              operational_status_key = VALUES(operational_status_key),
              business_status_key    = VALUES(business_status_key),
              reason_code            = VALUES(reason_code),
              note                   = VALUES(note),
              paused_until           = VALUES(paused_until),
              effective_at           = NOW(),
              source                 = 'api',
              updated_at             = NOW()
          `, [
            conv.user_id, conv.telefono, conv.instancia_evolution_api, conv.dominio,
            op || null, biz || null, reason_code || null, note || null, paused_until || null
          ]);
        }

        // 3) Control de pausa/reanudación (jobs)
        if (op === 'paused') {
          // programa reanudación
          await scheduleResume(conv, paused_until, midas.zona_horaria || process.env.DEFAULT_TIMEZONE || 'America/La_Paz');
        } else if (op === 'contactable') {
          // cancelar resume si existía
          await cancelResume(conv);
        }

        // 4) Asegurar conversación creada/actualizada
        const tzEff = midas.zona_horaria || process.env.DEFAULT_TIMEZONE || 'America/La_Paz';
        const convRow = await trx('aurum_conversations').where(conv).first();
        if (!convRow) {
          await trx('aurum_conversations').insert({
            ...conv,
            last_activity_at: trx.fn.now(),
            timezone_effective: tzEff,
            created_at: trx.fn.now(),
            updated_at: trx.fn.now()
          });
        } else {
          await trx('aurum_conversations').where(conv).update({
            timezone_effective: tzEff,
            updated_at: trx.fn.now()
          });
        }
      });

      // Responder estado actualizado
      const newMidas = await knex('wa_bot_leads').where(conv).first();
      const newAurum = await knex('aurum_lead_state')
        .where(conv)
        .orderBy([{ column: 'effective_at', order: 'desc' }, { column: 'updated_at', order: 'desc' }])
        .first();

      stateUpdateCounter.labels('ok', op || 'none', biz || 'none').inc();
      return res.json({
        ok: true,
        midas: {
          lead_status: newMidas?.lead_status ?? null,
          lead_business_status_key: newMidas?.lead_business_status_key ?? null,
        },
        aurum_state: newAurum || null,
        trace_id: req.traceId,
      });
    } catch (err) {
      const code = err?.http || 500;
      const details = err?.message || String(err);
      // Usa los labels precomputados (opLabel/bizLabel) para no “romper” en errores tempranos
      stateUpdateCounter.labels('error', opLabel || 'none', bizLabel || 'none').inc();
      return res.status(code).json({ error: 'update_failed', details, trace_id: req.traceId });
    }
  });

  return router;
}
