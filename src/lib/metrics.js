import client from 'prom-client';

const METRICS_ENABLED = String(process.env.METRICS_ENABLED || 'true') === 'true';

if (METRICS_ENABLED) {
  client.collectDefaultMetrics();
}

export const register = client.register;

// Métricas que usaremos más adelante; las exponemos desde ahora
export const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duración de requests HTTP en segundos',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 3, 5]
});

export const webhooksTotal = new client.Counter({
  name: 'aurum_webhooks_total',
  help: 'Cantidad de webhook entrantes procesados'
});

export const ping10SentTotal = new client.Counter({
  name: 'aurum_ping10_sent_total',
  help: 'Cantidad de Ping10 enviados'
});

export const remindersScheduledTotal = new client.Counter({
  name: 'aurum_reminders_scheduled_total',
  help: 'Cantidad de recordatorios agendados (dependientes + independientes)'
});
