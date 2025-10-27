// src/routes/reminders.js
import { Router } from 'express';
import { getKnex } from '../db/knex.js';
import {
  scheduleIndependentReminder,
  cancelReminderById,
} from '../services/jobs.js';

function buildConv(src) {
  return {
    user_id: Number(src.user_id),
    telefono: String(src.telefono || '').trim(),
    instancia_evolution_api: String(src.instancia_evolution_api || '').trim(),
    dominio: String(src.dominio || '').trim(),
  };
}

function parseCsv(val) {
  if (!val) return null;
  return String(val)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

export function remindersRoutes({ logger }) {
  const router = Router();

  /**
   * GET /reminders
   * Query (requerido): user_id, telefono, instancia_evolution_api, dominio
   * Filtros opcionales:
   *  - status=scheduled|done|cancelled (puede ser CSV)
   *  - kind=reminder_1d|reminder_3d|reminder_7d|reminder_custom (CSV)
   *  - limit (default 50, máx 200)
   */
  router.get('/reminders', async (req, res) => {
    try {
      const { user_id, telefono, instancia_evolution_api, dominio } = req.query || {};
      if (!user_id || !telefono || !instancia_evolution_api || !dominio) {
        return res.status(400).json({ error: 'bad_request', details: 'missing conversation key', trace_id: req.traceId });
      }
      const conv = buildConv(req.query);
      const statusList = parseCsv(req.query.status);
      const kindList = parseCsv(req.query.kind);
      let limit = Number(req.query.limit || 50);
      if (!Number.isFinite(limit) || limit <= 0) limit = 50;
      if (limit > 200) limit = 200;

      const knex = getKnex();
      let q = knex('aurum_followups_queue').select(
        'id',
        'user_id',
        'telefono',
        'instancia_evolution_api',
        'dominio',
        'kind',
        'status',
        'scheduled_at',
        'cancel_on_new_ping',
        'trace_id',
        'generation_id',
        'created_at',
        'updated_at'
      ).where(conv);

      if (statusList && statusList.length) {
        q = q.whereIn('status', statusList);
      }
      if (kindList && kindList.length) {
        q = q.whereIn('kind', kindList);
      }

      const rows = await q.orderBy('scheduled_at', 'desc').limit(limit);
      return res.json({ data: rows, trace_id: req.traceId });
    } catch (err) {
      logger?.error({ err, trace_id: req.traceId }, 'GET /reminders failed');
      return res.status(500).json({ error: 'internal_error', trace_id: req.traceId });
    }
  });

  /**
   * POST /reminders
   * Body:
   *  - (clave conv) user_id, telefono, instancia_evolution_api, dominio
   *  - O bien scheduled_at (ISO UTC) o days_offset (número)
   *  - kind? (default: reminder_custom)
   *
   * Crea un recordatorio **independiente** (persistido) y programa el job.
   * Respuesta: { ok: true, reminder_id }
   */
  router.post('/reminders', async (req, res) => {
    try {
      const { user_id, telefono, instancia_evolution_api, dominio, scheduled_at, days_offset, kind } = req.body || {};
      if (!user_id || !telefono || !instancia_evolution_api || !dominio) {
        return res.status(400).json({ error: 'bad_request', details: 'missing conversation key', trace_id: req.traceId });
      }
      const conv = buildConv(req.body);
      const tz = process.env.DEFAULT_TIMEZONE || 'America/La_Paz';

      const id = await scheduleIndependentReminder(conv, {
        scheduled_at,
        days_offset,
        kind: kind || 'reminder_custom',
      }, tz);

      return res.json({ ok: true, reminder_id: id, trace_id: req.traceId });
    } catch (err) {
      return res.status(500).json({ error: 'create_failed', details: String(err?.message || err), trace_id: req.traceId });
    }
  });

  /**
   * PATCH /reminders/:id/cancel
   * Body (clave conv requerida): user_id, telefono, instancia_evolution_api, dominio
   * Cancela un recordatorio **independiente** por ID (cola + DB)
   */
  router.patch('/reminders/:id/cancel', async (req, res) => {
    try {
      const { id } = req.params || {};
      const { user_id, telefono, instancia_evolution_api, dominio } = req.body || {};
      if (!id || !user_id || !telefono || !instancia_evolution_api || !dominio) {
        return res.status(400).json({ error: 'bad_request', details: 'missing id or conversation key', trace_id: req.traceId });
      }
      const conv = buildConv(req.body);
      const ok = await cancelReminderById(conv, Number(id));
      return res.json({ ok, reminder_id: Number(id), trace_id: req.traceId });
    } catch (err) {
      return res.status(500).json({ error: 'cancel_failed', details: String(err?.message || err), trace_id: req.traceId });
    }
  });

  return router;
}
