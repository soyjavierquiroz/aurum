import BullMQ from 'bullmq';
const { Queue, Worker } = BullMQ;

import { getRedis } from './clients/redis.js';
import { logger } from './lib/logger.js';
import { getKnex } from './db/knex.js';
import { scheduleDependentReminders } from './services/jobs.js';
import { DateTime } from 'luxon';

const connection = getRedis();
if (!connection) {
  logger.warn('No Redis connection. Exiting worker.');
  process.exit(0);
}

const REV = process.env.AURUM_REV || 'dev';

export const ping10Queue = new Queue('ping10', { connection });
export const remindersQueue = new Queue('reminders', { connection });

function convKey({ user_id, telefono, instancia_evolution_api, dominio }) {
  return `${user_id}:${telefono}:${instancia_evolution_api}:${dominio}`;
}

async function fetchUserSettings(knex, user_id) {
  const row = await knex('aurum_user_settings')
    .select('PING_URL', 'REMINDER_URL', 'timezone_default', 'working_window_default')
    .where({ user_id }).first();
  return row || {};
}

async function fetchLead(knex, conv) {
  const row = await knex('wa_bot_leads')
    .select(
      'lead_id','user_id','telefono','instancia_evolution_api','dominio',
      'nombre','apellido','zona_horaria','payload'
    )
    .where(conv).first();

  if (!row) return null;

  let payloadParsed = null;
  if (row.payload != null) {
    try { payloadParsed = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload; }
    catch { payloadParsed = row.payload; }
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
    payload: payloadParsed
  };
}

new Worker('ping10', async (job) => {
  const knex = getKnex();
  const { conv } = job.data;
  const key = convKey(conv);

  const convRow = await knex('aurum_conversations').where(conv).first();
  if (!convRow) {
    logger.warn({ jobId: job.id, key }, 'ping10: conversation missing');
    return;
  }

  const tz = convRow.timezone_effective || process.env.DEFAULT_TIMEZONE || 'America/La_Paz';
  const lastActivity = convRow.last_activity_at ? DateTime.fromJSDate(convRow.last_activity_at).setZone(tz) : null;
  const now = DateTime.now().setZone(tz);

  if (!lastActivity || now.diff(lastActivity, 'minutes').minutes < 9.99) {
    logger.info({ jobId: job.id, key }, 'ping10: skipped (activity within 10min)');
    return;
  }

  const { PING_URL } = await fetchUserSettings(knex, conv.user_id);
  const summary = (convRow.window_msg_count || 0) >= 3;
  const leadInfo = await fetchLead(knex, conv); // <-- incluir en payload

  if (PING_URL) {
    const payload = {
      version: REV,
      conversation: conv,
      lead: leadInfo, // <-- aquí va
      summary,
      last_activity_at: convRow.last_activity_at,
      window_msg_count: convRow.window_msg_count,
      trace_id: `ping10-${job.id}`
    };
    try {
      const rsp = await fetch(PING_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-aurum-rev': REV },
        body: JSON.stringify(payload)
      });
      logger.info({ status: rsp.status, key }, 'ping10 webhook sent');
    } catch (e) {
      logger.error({ err: e, key }, 'ping10 webhook failed');
    }
  } else {
    logger.warn({ key }, 'PING_URL missing; skipping webhook');
  }

  await knex('aurum_conversations')
    .where(conv)
    .update({ window_msg_count: 0, last_ping_at: knex.fn.now(), updated_at: knex.fn.now() });

  await scheduleDependentReminders(conv, now.toISO(), tz);
  await knex.raw(`
    INSERT INTO aurum_lead_state (user_id, telefono, instancia_evolution_api, dominio, operational_status_key, effective_at, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'reminder_scheduled', NOW(), 'ping10', NOW(), NOW())
    ON DUPLICATE KEY UPDATE operational_status_key='reminder_scheduled', effective_at=NOW(), source='ping10', updated_at=NOW()
  `, [conv.user_id, conv.telefono, conv.instancia_evolution_api, conv.dominio]);
}, { connection });

new Worker('reminders', async (job) => {
  const knex = getKnex();
  const { conv, kind, reminder_id, scheduled_at } = job.data;

  const row = await knex('aurum_user_settings').select('REMINDER_URL').where({ user_id: conv.user_id }).first();
  const REMINDER_URL = row?.REMINDER_URL;

  if (REMINDER_URL) {
    const payload = { version: REV, conversation: conv, kind, reminder_id, scheduled_at, trace_id: `rem-${job.id}` };
    try {
      const rsp = await fetch(REMINDER_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-aurum-rev': REV },
        body: JSON.stringify(payload)
      });
      logger.info({ status: rsp.status, key: convKey(conv), kind }, 'reminder webhook sent');
    } catch (e) {
      logger.error({ err: e, key: convKey(conv), kind }, 'reminder webhook failed');
    }
  }

  if (reminder_id) {
    await knex('aurum_followups_queue').where({ id: reminder_id })
      .update({ status: 'done', updated_at: knex.fn.now() });
  }
}, { connection });

logger.info({ rev: REV }, 'aurum worker ready');
