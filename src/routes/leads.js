import { Router } from 'express';
import { getKnex } from '../db/knex.js';
import { scheduleResume, cancelAllForConversation } from '../services/jobs.js';

const BLOCKED = ['won', 'opt_out', 'invalid', 'stopped'];

export function leadsRoutes({ logger }) {
  const router = Router();

  // GET /leads/state
  router.get('/leads/state', async (req, res) => {
    const { user_id, telefono, instancia_evolution_api, dominio } = req.query;
    if (!user_id || !telefono || !instancia_evolution_api || typeof dominio === 'undefined') {
      return res.status(400).json({ error: 'bad_request', trace_id: req.traceId });
    }
    const knex = getKnex();
    const lead = await knex('wa_bot_leads')
      .where({ user_id, telefono, instancia_evolution_api, dominio })
      .first();
    const aurumConv = await knex('aurum_conversations').where({ user_id, telefono, instancia_evolution_api, dominio }).first();
    const aurumState = await knex('aurum_lead_state').where({ user_id, telefono, instancia_evolution_api, dominio }).first();

    return res.json({ midas: lead || null, aurum: { conversation: aurumConv || null, state: aurumState || null }, trace_id: req.traceId });
  });

  // POST /leads/state
  router.post('/leads/state', async (req, res) => {
    const { user_id, telefono, instancia_evolution_api, dominio, operational_status_key, business_status_key, paused_until, force_reopen } = req.body || {};
    if (!user_id || !telefono || !instancia_evolution_api || typeof dominio === 'undefined') {
      return res.status(400).json({ error: 'bad_request', trace_id: req.traceId });
    }
    const conv = { user_id, telefono, instancia_evolution_api, dominio };
    const knex = getKnex();
    const lead = await knex('wa_bot_leads')
      .select('lead_status', 'lead_business_status_key')
      .where(conv).first();
    if (!lead) return res.status(404).json({ error: 'lead_no_encontrado', trace_id: req.traceId });

    // Reglas de bloqueo
    if (!force_reopen && lead.lead_status && BLOCKED.includes(lead.lead_status)) {
      // permitir cambiar business_status_key aunque esté bloqueado (si lo envían), pero no cambiar operativo salvo force
      if (!operational_status_key || operational_status_key === lead.lead_status) {
        // seguimos con negocio más abajo
      } else {
        return res.status(409).json({ error: 'blocked_status', details: `lead_status=${lead.lead_status}`, trace_id: req.traceId });
      }
    }

    // Aurum state (UPSERT)
    await knex.raw(`
      INSERT INTO aurum_lead_state (user_id, telefono, instancia_evolution_api, dominio, business_status_key, operational_status_key, paused_until, effective_at, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), 'api', NOW(), NOW())
      ON DUPLICATE KEY UPDATE
        business_status_key = VALUES(business_status_key),
        operational_status_key = VALUES(operational_status_key),
        paused_until = VALUES(paused_until),
        effective_at = NOW(),
        source = 'api',
        updated_at = NOW()
    `, [user_id, telefono, instancia_evolution_api, dominio, business_status_key || null, operational_status_key || null, paused_until || null]);

    // Midas mirror
    const midasUpdate = {};
    if (operational_status_key) midasUpdate.lead_status = operational_status_key;
    if (business_status_key) midasUpdate.lead_business_status_key = business_status_key;
    if (Object.keys(midasUpdate).length) {
      midasUpdate.lead_status_updated_at = knex.fn.now();
      midasUpdate.lead_business_status_updated_at = knex.fn.now();
      await knex('wa_bot_leads').where(conv).update(midasUpdate);
    }

    // lógica Pause/Resume y bloqueos
    if (operational_status_key === 'paused') {
      if (!paused_until) {
        return res.status(400).json({ error: 'paused_requires_until', trace_id: req.traceId });
      }
      const tz = process.env.DEFAULT_TIMEZONE || 'America/La_Paz';
      await scheduleResume(conv, paused_until, tz);
    }

    if (operational_status_key && BLOCKED.includes(operational_status_key)) {
      // Cancela todo si está bloqueado manualmente
      await cancelAllForConversation(conv);
    }

    return res.json({ ok: true, trace_id: req.traceId });
  });

  return router;
}
