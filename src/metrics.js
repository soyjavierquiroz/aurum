// src/metrics.js
import client from 'prom-client';

// Registro propio
export const register = new client.Registry();

// Métricas de Node por defecto
client.collectDefaultMetrics({ register });

// ----------------- Métricas Aurum -----------------

// Ping10 enviados
export const ping10SentCounter = new client.Counter({
  name: 'aurum_ping10_sent_total',
  help: 'Total de webhooks ping10 enviados',
  labelNames: ['status'],
});

// Reminders enviados/erróneos
export const reminderSentCounter = new client.Counter({
  name: 'aurum_reminder_sent_total',
  help: 'Total de webhooks de reminders enviados',
  labelNames: ['status', 'kind', 'slot', 'type'],
});

export const reminderFailedCounter = new client.Counter({
  name: 'aurum_reminder_failed_total',
  help: 'Total de fallos al enviar webhooks de reminders',
  labelNames: ['kind', 'slot', 'type'],
});

// Procesados en worker
export const workerJobsProcessedCounter = new client.Counter({
  name: 'aurum_worker_jobs_processed_total',
  help: 'Total de jobs procesados por el worker',
  labelNames: ['queue', 'result'], // success | skipped | error
});

// --- NUEVAS ---
// Entradas a /webhooks/message
export const incomingMessageCounter = new client.Counter({
  name: 'aurum_webhook_message_total',
  help: 'Total de mensajes recibidos en /webhooks/message',
  labelNames: ['result'], // accepted | deduped | bad_request | error
});

// Updates a /leads/state
export const stateUpdateCounter = new client.Counter({
  name: 'aurum_state_update_total',
  help: 'Total de actualizaciones de estado en /leads/state',
  labelNames: ['result', 'op', 'biz'], // ok | blocked | error
});

// Registrar todas
register.registerMetric(ping10SentCounter);
register.registerMetric(reminderSentCounter);
register.registerMetric(reminderFailedCounter);
register.registerMetric(workerJobsProcessedCounter);
register.registerMetric(incomingMessageCounter);
register.registerMetric(stateUpdateCounter);

// Handler /metrics
export async function metricsHandler(req, res) {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).send(`# metrics error: ${String(err?.message || err)}`);
  }
}
