// src/routes/admin.js
import { Router } from 'express';
import { ping10Queue, remindersQueue } from '../services/jobs.js';

export function adminRoutes({ logger }) {
  const router = Router();

  function resolveQueue(name) {
    if (name === 'ping10') return ping10Queue;
    if (name === 'reminders') return remindersQueue;
    return null;
  }

  // ------------------------------------------------------------
  // Cancelar un job por ID
  // body: { queue: "ping10" | "reminders", jobId: string }
  // ------------------------------------------------------------
  router.post('/admin/cancel', async (req, res) => {
    try {
      const { queue, jobId } = req.body || {};
      if (!queue || !jobId) {
        return res.status(400).json({ error: 'bad_request', details: 'queue and jobId are required', trace_id: req.traceId });
      }
      const q = resolveQueue(queue);
      if (!q) {
        return res.status(400).json({ error: 'bad_request', details: 'unknown queue', trace_id: req.traceId });
      }
      const j = await q.getJob(jobId);
      if (!j) {
        return res.status(404).json({ error: 'job_not_found', trace_id: req.traceId });
      }
      await j.remove();
      return res.json({ ok: true, jobId, trace_id: req.traceId });
    } catch (err) {
      logger?.error({ err, trace_id: req.traceId }, 'admin.cancel failed');
      return res.status(500).json({ error: 'cancel_failed', details: String(err?.message || err), trace_id: req.traceId });
    }
  });

  // ------------------------------------------------------------
  // Reintentar (requeue) un job. Si existe, reinyecta su data original.
  // Si NO existe y se pasa "data", lo crea y ejecuta de inmediato.
  // body:
  //  {
  //    queue: "ping10" | "reminders",
  //    jobId: string,
  //    data?: object   // requerido si el job ya no existe
  //  }
  // ------------------------------------------------------------
  router.post('/admin/requeue', async (req, res) => {
    try {
      const { queue, jobId, data } = req.body || {};
      if (!queue || !jobId) {
        return res.status(400).json({ error: 'bad_request', details: 'queue and jobId are required', trace_id: req.traceId });
      }
      const q = resolveQueue(queue);
      if (!q) {
        return res.status(400).json({ error: 'bad_request', details: 'unknown queue', trace_id: req.traceId });
      }

      const defaultName =
        queue === 'reminders' ? 'reminder' :
        queue === 'ping10'    ? 'ping10'   :
        'job';

      // 1) Si existe el job → usar su data + name, quitarlo y re-agregarlo sin delay
      const existing = await q.getJob(jobId);
      if (existing) {
        const jobName = existing.name || defaultName;
        const payload = existing.data || {};
        await existing.remove();
        await q.add(jobName, payload, {
          jobId,
          delay: 0,
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: false
        });
        return res.json({ ok: true, jobId, mode: 'requeued_from_existing', trace_id: req.traceId });
      }

      // 2) Si no existe → requiere "data" para recrearlo y ejecutarlo ya
      if (!data || typeof data !== 'object') {
        return res.status(404).json({
          error: 'job_not_found',
          details: 'pass {data} to create and run immediately',
          trace_id: req.traceId
        });
      }
      const jobName = (typeof data.name === 'string' && data.name) ? data.name : defaultName;
      await q.add(jobName, data, {
        jobId,
        delay: 0,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: false
      });
      return res.json({ ok: true, jobId, mode: 'added_with_body_data', trace_id: req.traceId });
    } catch (err) {
      logger?.error({ err, trace_id: req.traceId }, 'admin.requeue failed');
      return res.status(500).json({ error: 'requeue_failed', details: String(err?.message || err), trace_id: req.traceId });
    }
  });

  return router;
}
