// src/services/jobs.js
import BullMQ from 'bullmq';
const { Queue } = BullMQ;

import { getRedis } from '../clients/redis.js';
import { nextWorkingMoment } from '../lib/time.js';
import { DateTime } from 'luxon';
import { getKnex } from '../db/knex.js';

const connection = getRedis();
export const ping10Queue   = connection ? new Queue('ping10',   { connection }) : null;
export const remindersQueue= connection ? new Queue('reminders',{ connection }) : null;
export const opsQueue      = connection ? new Queue('ops',      { connection }) : null;

/** Clave compuesta conversación -> string */
export function convKey({ user_id, telefono, instancia_evolution_api, dominio }) {
  return `${user_id}:${telefono}:${instancia_evolution_api}:${dominio}`;
}

async function removeJobIfExists(queue, jobId) {
  if (!queue) return;
  const job = await queue.getJob(jobId);
  if (job) await job.remove();
}

/* ----------------------------- Helpers de tiempo ----------------------------- */

/**
 * Intenta parsear una fecha/hora en forma tolerante:
 *  - ISO con o sin zona (e.g. 2025-11-03T09:00:00, 2025-11-03T09:00:00Z, 2025-11-03T09:00:00-04:00)
 *  - MySQL DATETIME (YYYY-MM-DD HH:mm:ss)
 *  - Solo fecha (YYYY-MM-DD) -> asume 09:00:00 en tz
 *
 * Retorna un DateTime en la zona tz (si se pasó) o conservando la zona de origen si venía con offset.
 */
function parseFlexibleDateTime(input, tz = 'America/La_Paz') {
  if (!input) return null;

  const s = String(input).trim();

  // Solo fecha -> fija 09:00:00 en tz
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return DateTime.fromISO(`${s}T09:00:00`, { zone: tz });
  }

  // ISO (con o sin offset)
  let dt = DateTime.fromISO(s, { setZone: true });
  if (dt.isValid) return dt;

  // MySQL DATETIME
  dt = DateTime.fromSQL(s, { zone: tz });
  if (dt.isValid) return dt;

  // Fallback: Date nativa
  const d = new Date(s.replace(' ', 'T'));
  if (!isNaN(d)) {
    return DateTime.fromJSDate(d, { zone: tz });
  }

  throw new Error(`invalid_datetime: ${input}`);
}

/** Convierte DateTime -> 'YYYY-MM-DD HH:mm:ss' (MySQL) */
function toMySQL(dt) {
  return dt.toFormat('yyyy-LL-dd HH:mm:ss');
}

/* --------------------------------- Ping10 ---------------------------------- */
export async function schedulePing10(conv, lastActivityISO, tz) {
  if (!ping10Queue) return;
  const key = convKey(conv);
  const jobId = `ping10:${key}`;

  const base = lastActivityISO
    ? DateTime.fromISO(lastActivityISO, { setZone: true })
    : DateTime.now();

  const whenDT = nextWorkingMoment(base.plus({ minutes: 10 }).toJSDate(), tz); // -> DateTime
  const when   = whenDT.toJSDate();

  await removeJobIfExists(ping10Queue, jobId);
  await ping10Queue.add('ping10', { conv, scheduled_at: whenDT.toISO() }, {
    jobId,
    delay: Math.max(0, when.getTime() - Date.now()),
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: true,
    removeOnFail: false
  });
}

export async function cancelPing10(conv) {
  if (!ping10Queue) return;
  await removeJobIfExists(ping10Queue, `ping10:${convKey(conv)}`);
}

/* ------------------------- Dependientes 1d/3d/7d --------------------------- */
export async function scheduleDependentReminders(conv, baseWhen, tz) {
  if (!remindersQueue) return;

  // baseWhen puede venir ISO o SQL; parseamos flexible
  const base =
    typeof baseWhen === 'string'
      ? (parseFlexibleDateTime(baseWhen, tz) || DateTime.now())
      : DateTime.now();

  const kinds = [
    ['reminder_1d', { days: 1 }, '1d'],
    ['reminder_3d', { days: 3 }, '3d'],
    ['reminder_7d', { days: 7 }, '7d']
  ];

  const knex = getKnex();

  for (const [kind, delta, slot] of kinds) {
    const atDT = nextWorkingMoment(base.plus(delta).toJSDate(), tz); // DateTime
    const at   = atDT.toJSDate();
    const jobId = `reminder:dep:${kind}:${convKey(conv)}:${slot}`;

    // (1) En cola BullMQ
    await removeJobIfExists(remindersQueue, jobId);
    await remindersQueue.add('reminder', {
      conv, kind, scheduled_at: atDT.toISO(), cancel_on_new_ping: true
    }, {
      jobId,
      delay: Math.max(0, at.getTime() - Date.now()),
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: true,
      removeOnFail: false
    });

    // (2) Persistencia en DB (lo que lista /reminders)
    await knex('aurum_followups_queue').insert({
      user_id: conv.user_id,
      telefono: conv.telefono,
      instancia_evolution_api: conv.instancia_evolution_api,
      dominio: conv.dominio,
      kind,
      scheduled_at: toMySQL(atDT),
      status: 'scheduled',
      cancel_on_new_ping: 1,
      created_at: knex.fn.now(),
      updated_at: knex.fn.now()
    });
  }
}

export async function cancelDependentReminders(conv) {
  if (!remindersQueue) return;
  const key = convKey(conv);
  for (const jobId of [
    `reminder:dep:reminder_1d:${key}:1d`,
    `reminder:dep:reminder_3d:${key}:3d`,
    `reminder:dep:reminder_7d:${key}:7d`
  ]) {
    await removeJobIfExists(remindersQueue, jobId);
  }
  const knex = getKnex();
  await knex('aurum_followups_queue')
    .where({
      user_id: conv.user_id,
      telefono: conv.telefono,
      instancia_evolution_api: conv.instancia_evolution_api,
      dominio: conv.dominio,
      status: 'scheduled'
    })
    .andWhere('cancel_on_new_ping', 1)
    .update({ status: 'cancelled', updated_at: knex.fn.now() });
}

/* ---------------------------- Independientes ------------------------------- */
export async function scheduleIndependentReminder(conv, { scheduled_at, days_offset, kind = 'reminder_custom' }, tz) {
  if (!remindersQueue) return null;

  // scheduled_at puede venir ISO/SQL/solo fecha; si no hay, days_offset
  let whenDT;
  if (scheduled_at) {
    whenDT = parseFlexibleDateTime(scheduled_at, tz);
  } else {
    whenDT = DateTime.now().plus({ days: Number(days_offset || 0) });
  }
  whenDT = nextWorkingMoment(whenDT.toJSDate(), tz); // -> DateTime

  const knex = getKnex();
  const [id] = await knex('aurum_followups_queue').insert({
    user_id: conv.user_id,
    telefono: conv.telefono,
    instancia_evolution_api: conv.instancia_evolution_api,
    dominio: conv.dominio,
    kind,
    scheduled_at: toMySQL(whenDT),
    status: 'scheduled',
    cancel_on_new_ping: 0,
    created_at: knex.fn.now(),
    updated_at: knex.fn.now()
  });

  const jobId = `reminder:ind:${convKey(conv)}:${id}`;
  const when = whenDT.toJSDate();
  await remindersQueue.add('reminder', {
    conv, kind, reminder_id: id, scheduled_at: whenDT.toISO(), cancel_on_new_ping: false
  }, {
    jobId,
    delay: Math.max(0, when.getTime() - Date.now()),
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: true,
    removeOnFail: false
  });

  return id;
}

export async function cancelReminderById(conv, id) {
  if (!remindersQueue) return false;
  await removeJobIfExists(remindersQueue, `reminder:ind:${convKey(conv)}:${id}`);
  const knex = getKnex();
  const affected = await knex('aurum_followups_queue')
    .where({ id, user_id: conv.user_id })
    .update({ status: 'cancelled', updated_at: knex.fn.now() });
  return affected > 0;
}

/* ----------------------- Pausa/Resume + Cancel all ------------------------- */
export async function scheduleResume(conv, pausedUntilAny, tz) {
  if (!opsQueue) return;

  // Acepta ISO/SQL/fecha sola; tira error si es basura
  const dt = parseFlexibleDateTime(pausedUntilAny, tz);
  if (!dt || !dt.isValid) {
    throw new Error(`invalid_paused_until: ${pausedUntilAny}`);
  }

  const whenDT = nextWorkingMoment(dt.toJSDate(), tz); // -> DateTime
  const when   = whenDT.toJSDate();

  const jobId = `ops:resume:${convKey(conv)}`;
  await removeJobIfExists(opsQueue, jobId);
  await opsQueue.add('ops_resume', { conv, paused_until: whenDT.toISO() }, {
    jobId,
    delay: Math.max(0, when.getTime() - Date.now()),
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: true,
    removeOnFail: false
  });

  const knex = getKnex();
  await knex('aurum_followups_queue').insert({
    user_id: conv.user_id,
    telefono: conv.telefono,
    instancia_evolution_api: conv.instancia_evolution_api,
    dominio: conv.dominio,
    kind: 'ops_resume',
    scheduled_at: toMySQL(whenDT),
    status: 'scheduled',
    cancel_on_new_ping: 1,
    created_at: knex.fn.now(),
    updated_at: knex.fn.now()
  });
}

export async function cancelResume(conv) {
  if (!opsQueue) return;
  await removeJobIfExists(opsQueue, `ops:resume:${convKey(conv)}`);
  const knex = getKnex();
  await knex('aurum_followups_queue')
    .where({
      user_id: conv.user_id,
      telefono: conv.telefono,
      instancia_evolution_api: conv.instancia_evolution_api,
      dominio: conv.dominio,
      kind: 'ops_resume',
      status: 'scheduled'
    })
    .update({ status: 'cancelled', updated_at: knex.fn.now() });
}

export async function cancelAllForConversation(conv) {
  await cancelPing10(conv);
  await cancelDependentReminders(conv);
  await cancelResume(conv);
}
