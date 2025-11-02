// src/worker.js
import BullMQ from 'bullmq';
const { Queue, Worker } = BullMQ;

import { getRedis } from './clients/redis.js';
import { logger } from './lib/logger.js';
import { getKnex } from './db/knex.js';
import { scheduleDependentReminders } from './services/jobs.js';
import { DateTime } from 'luxon';

import {
  ping10SentCounter,
  reminderSentCounter,
  reminderFailedCounter,
  workerJobsProcessedCounter,
} from './metrics.js';

const REV = process.env.AURUM_REV || 'dev';

const connection = getRedis();
if (!connection) {
  logger.warn('No Redis connection. Exiting worker.');
  process.exit(0);
}

// Queues
export const ping10Queue = new Queue('ping10', { connection });
export const remindersQueue = new Queue('reminders', { connection });
export const opsQueue = new Queue('ops', { connection }); // usado para resume (paused)

/** Clave compuesta conversación -> string */
function convKey({ user_id, telefono, instancia_evolution_api, dominio }) {
  return `${user_id}:${telefono}:${instancia_evolution_api}:${dominio}`;
}

/** Settings por usuario */
async function fetchUserSettings(knex, user_id) {
  const row = await knex('aurum_user_settings')
    .select('PING_URL', 'REMINDER_URL', 'timezone_default', 'working_window_default')
    .where({ user_id }).first();
  return row || {};
}

/** Lead desde Midas con payload parseado y estados (operacional/negocio) */
async function fetchLead(knex, conv) {
  const row = await knex('wa_bot_leads')
    .select(
      'lead_id',
      'user_id',
      'telefono',
      'instancia_evolution_api',
      'dominio',
      'nombre',
      'apellido',
      'zona_horaria',
      'payload',
      'lead_status',
      'lead_business_status_key'
    )
    .where(conv)
    .first();

  if (!row) return null;

  let payloadParsed = null;
  if (row.payload != null) {
    try {
      payloadParsed = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
    } catch {
      payloadParsed = row.payload;
    }
  }
  const nombreCompleto = [row.nombre, row.apellido].filter(Boolean).join(' ') || null;

  return {
    lead_id: row.lead_id ?? null,
    user_id: row.user_id,
    telefono: row.telefono,
    instancia_evolution_api: row.instancia_evolution_api,
    dominio: row.dominio,
    nombre: row.nombre ?? null,
    apellido: row.apellido ?? null,
    nombre_completo: nombreCompleto,
    zona_horaria: row.zona_horaria ?? null,
    payload: payloadParsed,
    lead_status: row.lead_status ?? null,                 // operacional (Midas)
    lead_business_status_key: row.lead_business_status_key ?? null, // negocio (Midas)
  };
}

/** Último estado vigente en Aurum (aurum_lead_state) */
async function fetchAurumState(knex, conv) {
  const row = await knex('aurum_lead_state')
    .select(
      'business_status_key',
      'operational_status_key',
      'reason_code',
      'note',
      'paused_until',
      'effective_at',
      'source',
      'created_at',
      'updated_at'
    )
    .where(conv)
    .orderBy([{ column: 'effective_at', order: 'desc' }, { column: 'updated_at', order: 'desc' }])
    .first();

  return row || null;
}

/* ---------------------------------- Worker: Ping10 ---------------------------------- */
new Worker('ping10', async (job) => {
  const knex = getKnex();
  const { conv } = job.data || {};
  if (!conv) {
    logger.warn({ jobId: job.id }, 'ping10: missing conv in job.data');
    workerJobsProcessedCounter.labels('ping10', 'error').inc();
    return;
  }
  const key = convKey(conv);

  const convRow = await knex('aurum_conversations').where(conv).first();
  if (!convRow) {
    logger.warn({ jobId: job.id, key }, 'ping10: conversation missing');
    workerJobsProcessedCounter.labels('ping10', 'error').inc();
    return;
  }

  const tz = convRow.timezone_effective || process.env.DEFAULT_TIMEZONE || 'America/La_Paz';
  const lastActivity = convRow.last_activity_at ? DateTime.fromJSDate(convRow.last_activity_at).setZone(tz) : null;
  const now = DateTime.now().setZone(tz);

  // Ejecuta solo si pasaron >= 10 min
  if (!lastActivity || now.diff(lastActivity, 'minutes').minutes < 9.99) {
    logger.info({ jobId: job.id, key }, 'ping10: skipped (activity within 10min)');
    workerJobsProcessedCounter.labels('ping10', 'skipped').inc();
    return;
  }

  // Enriquecer con lead + estados Midas + aurum (para webhook y para decidir scheduling)
  const leadInfo = await fetchLead(knex, conv);
  const aurumState = await fetchAurumState(knex, conv);

  const { PING_URL } = await fetchUserSettings(knex, conv.user_id);
  const summary = (convRow.window_msg_count || 0) >= 3;

  if (PING_URL) {
    try {
      const payload = {
        version: REV,
        conversation: conv,
        lead: leadInfo || null,
        midas_status: {
          operational: leadInfo?.lead_status ?? null,
          business: leadInfo?.lead_business_status_key ?? null
        },
        aurum_state: aurumState,
        summary,
        last_activity_at: convRow.last_activity_at,
        window_msg_count: convRow.window_msg_count,
        trace_id: `ping10-${job.id}`
      };

      const rsp = await fetch(PING_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-aurum-rev': REV },
        body: JSON.stringify(payload)
      });
      logger.info({ status: rsp.status, key }, 'ping10 webhook sent');
      ping10SentCounter.labels(String(rsp.status)).inc();
      workerJobsProcessedCounter.labels('ping10', 'success').inc();
    } catch (e) {
      logger.error({ err: e, key }, 'ping10 webhook failed');
      ping10SentCounter.labels('error').inc();
      workerJobsProcessedCounter.labels('ping10', 'error').inc();
    }
  } else {
    logger.warn({ key }, 'PING_URL missing; skipping webhook');
    workerJobsProcessedCounter.labels('ping10', 'error').inc();
  }

  // Reiniciar contador + last_ping_at
  await knex('aurum_conversations')
    .where(conv)
    .update({ window_msg_count: 0, last_ping_at: knex.fn.now(), updated_at: knex.fn.now() });

  // ---------------- Condición: sólo agendar 1d/3d/7d si el lead está "contactable" ----------------
  const leadStatus = String(leadInfo?.lead_status || '').toLowerCase();
  const canSchedule = leadStatus === 'contactable';

  if (canSchedule) {
    await scheduleDependentReminders(conv, now.toISO(), tz);

    // Marca operativa interna sólo si efectivamente agendamos
    await knex.raw(`
      INSERT INTO aurum_lead_state (user_id, telefono, instancia_evolution_api, dominio, operational_status_key, effective_at, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'reminder_scheduled', NOW(), 'ping10', NOW(), NOW())
      ON DUPLICATE KEY UPDATE operational_status_key='reminder_scheduled', effective_at=NOW(), source='ping10', updated_at=NOW()
    `, [conv.user_id, conv.telefono, conv.instancia_evolution_api, conv.dominio]);

    logger.info({ key, lead_status: leadStatus }, 'ping10: dependent reminders scheduled (1d/3d/7d)');
  } else {
    logger.info({ key, lead_status: leadStatus }, 'ping10: skip dependent reminders (lead not contactable)');
  }

}, { connection });

/* ------------------------------ Worker: Reminders ------------------------------ */
new Worker('reminders', async (job) => {
  const knex = getKnex();
  const { conv, kind, reminder_id, scheduled_at, cancel_on_new_ping } = job.data || {};
  if (!conv || !kind) {
    logger.warn({ jobId: job.id }, 'reminders: missing conv/kind in job.data');
    workerJobsProcessedCounter.labels('reminders', 'error').inc();
    return;
  }
  const key = convKey(conv);

  // slot/days/type
  let slot = null;
  if (typeof kind === 'string' && /^reminder_\d+d$/.test(kind)) {
    slot = kind.split('_')[1]; // "1d" | "3d" | "7d"
  }
  const days = slot ? Number(slot.replace('d', '')) : null;
  const type = reminder_id ? 'independent' : (cancel_on_new_ping ? 'dependent' : 'unknown');

  // Enriquecer con lead + estados Midas + aurum
  const leadInfo = await fetchLead(knex, conv);
  const aurumState = await fetchAurumState(knex, conv);

  // URL destino
  const usr = await knex('aurum_user_settings').select('REMINDER_URL').where({ user_id: conv.user_id }).first();
  const REMINDER_URL = usr?.REMINDER_URL;

  if (REMINDER_URL) {
    const payload = {
      version: REV,
      conversation: conv,
      lead: leadInfo || null,
      midas_status: {
        operational: leadInfo?.lead_status ?? null,
        business: leadInfo?.lead_business_status_key ?? null
      },
      aurum_state: aurumState,
      kind,
      slot,
      days,
      type,
      cancel_on_new_ping: !!cancel_on_new_ping,
      reminder_id: reminder_id ?? null,
      scheduled_at,
      trace_id: `rem-${job.id}`
    };

    try {
      const rsp = await fetch(REMINDER_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-aurum-rev': REV },
        body: JSON.stringify(payload)
      });
      logger.info({ status: rsp.status, key, kind, slot }, 'reminder webhook sent');
      reminderSentCounter.labels(String(rsp.status), kind || 'unknown', slot || 'none', type || 'unknown').inc();
      workerJobsProcessedCounter.labels('reminders', 'success').inc();
    } catch (e) {
      logger.error({ err: e, key, kind, slot }, 'reminder webhook failed');
      reminderFailedCounter.labels(kind || 'unknown', slot || 'none', type || 'unknown').inc();
      workerJobsProcessedCounter.labels('reminders', 'error').inc();
    }
  } else {
    logger.warn({ key, kind }, 'REMINDER_URL missing; skipping webhook');
    reminderFailedCounter.labels(kind || 'unknown', slot || 'none', type || 'unknown').inc();
    workerJobsProcessedCounter.labels('reminders', 'error').inc();
  }

  // Marcar done solo si es independiente (persistido)
  if (reminder_id) {
    await knex('aurum_followups_queue')
      .where({ id: reminder_id })
      .update({ status: 'done', updated_at: knex.fn.now() });
  }
}, { connection });

logger.info('aurum worker ready');
