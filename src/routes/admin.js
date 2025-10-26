import { Router } from 'express';
import { ping10Queue, remindersQueue } from '../services/jobs.js';

export function adminRoutes({ logger }) {
  const router = Router();

  // Cancelar un job por ID
  router.post('/admin/cancel', async (req, res) => {
    const { queue, jobId } = req.body || {};
    const q = queue === 'ping10' ? ping10Queue : queue === 'reminders' ? remindersQueue : null;
    if (!q) return res.status(400).json({ error: 'bad_request', trace_id: req.traceId });
    const j = await q.getJob(jobId);
    if (j) await j.remove();
    return res.json({ ok: !!j, trace_id: req.traceId });
  });

  // Reintentar (requeue) un job existente
  router.post('/admin/requeue', async (req, res) => {
    const { queue, jobId } = req.body || {};
    const q = queue === 'ping10' ? ping10Queue : queue === 'reminders' ? remindersQueue : null;
    if (!q) return res.status(400).json({ error: 'bad_request', trace_id: req.traceId });
    const j = await q.getJob(jobId);
    if (!j) return res.status(404).json({ error: 'job_not_found', trace_id: req.traceId });
    const data = j.data;
    await q.add(j.name, data, { jobId: j.id, attempts: 3 });
    return res.json({ ok: true, trace_id: req.traceId });
  });

  return router;
}
