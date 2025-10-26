import BullMQ from 'bullmq';
const { Queue } = BullMQ;

import { getRedis } from '../clients/redis.js';
import { nextWorkingMoment } from '../lib/time.js';
import { DateTime } from 'luxon';
import { getKnex } from '../db/knex.js';

const connection = getRedis();
export const ping10Queue = connection ? new Queue('ping10', { connection }) : null;
export const remindersQueue = connection ? new Queue('reminders', { connection }) : null;

export function convKey({ user_id, telefono, instancia_evolution_api, dominio }) {
  return `${user_id}:${telefono}:${instancia_evolution_api}:${dominio}`;
}

async function removeJobIfExists(queue, jobId) {
  if (!queue) return;
  const job = await queue.getJob(jobId);
  if (job) await job.remove();
}

export async function schedulePing10(conv, lastActivityISO, tz) {
  if (!ping10Queue) return;
  const key = convKey(conv);
  const jobId = `ping10:${key}`;
  const lastActivity = lastActivityISO ? DateTime.fromISO(lastActivityISO) : DateTime.now();
  const scheduled = nextWorkingMoment(lastActivity.plus({ minutes: 10 }).toJSDate(), tz).toJSDate();
  await removeJobIfExists(ping10Queue, jobId);
  await ping10Queue.add('ping10', { conv, scheduled_at: scheduled.toISOString() }, {
    jobId,
    delay: Math.max(0, scheduled.getTime() - Date.now()),
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: true,
    removeOnFail: false
  });
}

export async function cancelPing10(conv) {
  if (!ping10Queue) return;
  const jobId = `ping10:${convKey(conv)}`;
  await removeJobIfExists(ping10Queue, jobId);
}

export async function scheduleDependentReminders(conv, baseISO, tz) {
  if (!remindersQueue) return;
  const base = DateTime.fromISO(baseISO);
  const kinds = [
    ['reminder_1d', { days: 1 }, '1d'],
    ['reminder_3d', { days: 3 }, '3d'],
    ['reminder_7d', { days: 7 }, '7d']
  ];
  for (const [kind, delta, slot] of kinds) {
    const at = nextWorkingMoment(base.plus(delta).toJSDate(), tz).toJSDate();
    const jobId = `reminder:dep:${kind}:${convKey(conv)}:${slot}`;
    await removeJobIfExists(remindersQueue, jobId);
    await remindersQueue.add('reminder', { conv, kind, scheduled_at: at.toISOString(), cancel_on_new_ping: true }, {
      jobId,
      delay: Math.max(0, at.getTime() - Date.now()),
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
      kind,
      scheduled_at: at.toISOString().slice(0, 19).replace('T', ' '),
      status: 'scheduled',
      cancel_on_new_ping: 1
    });
  }
}

export async function cancelDependentReminders(conv) {
  if (!remindersQueue) return;
  const key = convKey(conv);
  const patterns = [
    `reminder:dep:reminder_1d:${key}:1d`,
    `reminder:dep:reminder_3d:${key}:3d`,
    `reminder:dep:reminder_7d:${key}:7d`
  ];
  for (const jobId of patterns) {
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
    scheduled_at: when.toISO({ suppressMilliseconds: true }).replace('T', ' ').slice(0, 19),
    status: 'scheduled',
    cancel_on_new_ping: 0
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
  const jobId = `reminder:ind:${convKey(conv)}:${id}`;
  await removeJobIfExists(remindersQueue, jobId);
  const knex = getKnex();
  const affected = await knex('aurum_followups_queue')
    .where({ id, user_id: conv.user_id })
    .update({ status: 'cancelled', updated_at: knex.fn.now() });
  return affected > 0;
}
