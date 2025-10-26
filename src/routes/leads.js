import { Router } from 'express';
import { getKnex } from '../db/knex.js';

export function leadsRoutes({ logger }) {
  const router = Router();

  // GET /leads/state?user_id=&telefono=&instancia_evolution_api=&dominio=&fresh=1
  router.get('/leads/state', async (req, res) => {
    const { user_id, telefono, instancia_evolution_api, dominio } = req.query;
    if (!user_id || !telefono || !instancia_evolution_api || typeof dominio === 'undefined') {
      return res.status(400).json({ error: 'bad_request', trace_id: req.traceId });
    }
    const knex = getKnex();
    const lead = await knex('wa_bot_leads')
      .where({ user_id, telefono, instancia_evolution_api, dominio })
      .first();
    const aurumConv = await knex('aurum_conversations')
      .where({ user_id, telefono, instancia_evolution_api, dominio })
      .first();
    const aurumState = await knex('aurum_lead_state')
      .where({ user_id, telefono, instancia_evolution_api, dominio })
      .first();

    return res.json({
      midas: lead || null,
      aurum: {
        conversation: aurumConv || null,
        state: aurumState || null
      },
      trace_id: req.traceId
    });
  });

  // POST /leads/state  -> actualiza estado operativo/negocio (Aurum + reflejo en Midas)
  router.post('/leads/state', async (req, res) => {
    const { user_id, telefono, instancia_evolution_api, dominio, operational_status_key, business_status_key, force_reopen } = req.body || {};
    if (!user_id || !telefono || !instancia_evolution_api || typeof dominio === 'undefined') {
      return res.status(400).json({ error: 'bad_request', trace_id: req.traceId });
    }
    const knex = getKnex();
    const lead = await knex('wa_bot_leads')
      .select('lead_status', 'lead_business_status_key')
      .where({ user_id, telefono, instancia_evolution_api, dominio })
      .first();
    if (!lead) {
      return res.status(404).json({ error: 'lead_no_encontrado', trace_id: req.traceId });
    }

    const blocked = ['won', 'opt_out', 'invalid', 'stopped'];
    if (!force_reopen && lead.lead_status && blocked.includes(lead.lead_status)) {
      return res.status(409).json({ error: 'blocked_status', details: `lead_status=${lead.lead_status}`, trace_id: req.traceId });
    }

    // Aurum
    await knex.raw(`
      INSERT INTO aurum_lead_state (user_id, telefono, instancia_evolution_api, dominio, business_status_key, operational_status_key, effective_at, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, NOW(), 'api', NOW(), NOW())
      ON DUPLICATE KEY UPDATE
        business_status_key = VALUES(business_status_key),
        operational_status_key = VALUES(operational_status_key),
        effective_at = NOW(),
        source = 'api',
        updated_at = NOW()
    `, [user_id, telefono, instancia_evolution_api, dominio, business_status_key || null, operational_status_key || null]);

    // Midas
    const midasUpdate = {};
    if (operational_status_key) midasUpdate.lead_status = operational_status_key;
    if (business_status_key) midasUpdate.lead_business_status_key = business_status_key;
    if (Object.keys(midasUpdate).length) {
      midasUpdate.lead_status_updated_at = knex.fn.now();
      midasUpdate.lead_business_status_updated_at = knex.fn.now();
      await knex('wa_bot_leads')
        .where({ user_id, telefono, instancia_evolution_api, dominio })
        .update(midasUpdate);
    }

    return res.json({ ok: true, trace_id: req.traceId });
  });

  return router;
}
