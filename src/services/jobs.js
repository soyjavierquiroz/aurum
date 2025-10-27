import BullMQ from 'bullmq';
const { Queue } = BullMQ;

import { getRedis } from '../clients/redis.js';
import { nextWorkingMoment } from '../lib/time.js';
import { DateTime } from 'luxon';
import { getKnex } from '../db/knex.js';

const connection = getRedis();
export const ping10Queue = connection ? new Queue('ping10', { connection }) : null;
export const remindersQueue = connection ? new Queue('reminders', { connection }) : null;
export const opsQueue = connection ? new Queue('ops', { connection }) : null;

export function convKey({ user_id, telefono, instancia_evolution_api, dominio }) {
  return `${user_id}:${telefono}:${instancia_evolution_api}:${dominio}`;
}

async function removeJobIfExists(queue, jobId) {
  if (!queue) return;
  const job = await queue.getJob(jobId);
  if (job) await job.remove();
}

// ------------ Ping10 ------------
export async function schedulePing10(conv, lastActivityISO, tz) {
  if (!ping10Queue) return;
  const key = convKey(conv);
  const jobId = `ping10:${key}`;
  const base = lastActivityISO ? DateTime.fromISO(lastActivityISO) : DateTime.now();
  const when = nextWorkingMoment(base.plus({ minutes: 10 }).toJSDate(), tz).toJSDate();
  await removeJobIfExists(ping10Queue, jobId);
  await ping10Queue.add('ping10', { conv, scheduled_at: when.toISOString() }, {
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

// ------------ Dependientes 1d/3d/7d ------------
export async function scheduleDependentReminders(conv, baseISO, tz) {
  if (!remindersQueue) return;
  const base = DateTime.fromISO(baseISO);
  const kinds = [
    ['reminder_1d', { days: 1 }, '1d'],
    ['reminder_3d', { days: 3 }, '3d'],
    ['reminder_7d', { days: 7 }, '7d']
  ];
  const knex = getKnex();

  for (const [kind, delta, slot] of kinds) {
    const at = nextWorkingMoment(base.plus(delta).toJSDate(), tz).toJSDate();
    const jobId = `reminder:dep:${kind}:${convKey(conv)}:${slot}`;

    // (1) En cola BullMQ
    await removeJobIfExists(remindersQueue, jobId);
    await remindersQueue.add('reminder', {
      conv, kind, scheduled_at: at.toISOString(), cancel_on_new_ping: true
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
      scheduled_at: at.toISOString().slice(0, 19).replace('T', ' '),
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

// ------------ Independientes ------------
export async function scheduleIndependentReminder(conv, { scheduled_at, days_offset, kind = 'reminder_custom' }, tz) {
  if (!remindersQueue) return null;
  let when = scheduled_at ? DateTime.fromISO(scheduled_at) : DateTime.now().plus({ days: Number(days_offset || 0) });
  when = nextWorkingMoment(when.toJSDate(), tz);

  const knex = getKnex();
  const [id] = await knex('aurum_followups_queue').insert({
    user_id: conv.user_id,
    telefono: conv.telefono,
    instancia_evolution_api: conv.instancia_evolution_api,
    dominio: conv.dominio,
    kind,
    scheduled_at: when.toISO({ suppressMilliseconds: true }).replace('T', ' ').slice(0,19),
    status: 'scheduled',
    cancel_on_new_ping: 0,
    created_at: knex.fn.now(),
    updated_at: knex.fn.now()
  });

  const jobId = `reminder:ind:${convKey(conv)}:${id}`;
  await remindersQueue.add('reminder', { conv, kind, reminder_id: id, scheduled_at: when.toISO(), cancel_on_new_ping: false }, {
    jobId,
    delay: Math.max(0, when.toMillis() - Date.now()),
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

// ------------ Pausa/Resume + Cancel all ------------
export async function scheduleResume(conv, pausedUntilISO, tz) {
  if (!opsQueue) return;
  const jobId = `ops:resume:${convKey(conv)}`;
  const when = nextWorkingMoment(DateTime.fromISO(pausedUntilISO).toJSDate(), tz).toJSDate();
  await removeJobIfExists(opsQueue, jobId);
  await opsQueue.add('ops_resume', { conv, paused_until: when.toISOString() }, {
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
    scheduled_at: when.toISOString().slice(0, 19).replace('T', ' '),
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
