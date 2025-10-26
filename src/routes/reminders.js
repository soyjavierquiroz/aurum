import { Router } from 'express';
import { getKnex } from '../db/knex.js';
import { scheduleIndependentReminder, cancelReminderById } from '../services/jobs.js';

export function remindersRoutes({ logger }) {
  const router = Router();

  router.post('/reminders', async (req, res) => {
    const { user_id, telefono, instancia_evolution_api, dominio, scheduled_at, days_offset, kind } = req.body || {};
    if (!user_id || !telefono || !instancia_evolution_api || typeof dominio === 'undefined') {
      return res.status(400).json({ error: 'bad_request', trace_id: req.traceId });
    }
    // tz efectiva
    const knex = getKnex();
    const conv = { user_id, telefono, instancia_evolution_api, dominio };
    const c = await knex('aurum_conversations')
      .select('timezone_effective')
      .where(conv).first();
    const tz = c?.timezone_effective || process.env.DEFAULT_TIMEZONE || 'America/La_Paz';

    const id = await scheduleIndependentReminder(conv, { scheduled_at, days_offset, kind: kind || 'reminder_custom' }, tz);
    return res.json({ ok: true, reminder_id: id, trace_id: req.traceId });
  });

  router.get('/reminders', async (req, res) => {
    const { user_id, telefono, instancia_evolution_api, dominio } = req.query;
    const knex = getKnex();
    const q = knex('aurum_followups_queue').orderBy('scheduled_at', 'asc');
    if (user_id) q.where('user_id', user_id);
    if (telefono) q.where('telefono', telefono);
    if (instancia_evolution_api) q.where('instancia_evolution_api', instancia_evolution_api);
    if (typeof dominio !== 'undefined') q.where('dominio', dominio);
    const rows = await q.select('*');
    return res.json({ data: rows, trace_id: req.traceId });
  });

  router.post('/reminders/:id/cancel', async (req, res) => {
    const id = Number(req.params.id);
    const { user_id, telefono, instancia_evolution_api, dominio } = req.body || {};
    if (!user_id) return res.status(400).json({ error: 'bad_request', trace_id: req.traceId });
    const ok = await cancelReminderById({ user_id, telefono, instancia_evolution_api, dominio }, id);
    return res.json({ ok, trace_id: req.traceId });
  });

  return router;
}
