¡Vamos con el **Paso 5: transiciones operacionales avanzadas**!
Implementamos:

* **No reabrir** `won`, `opt_out`, `invalid`, `stopped` por actividad automática.
* **Pause/Resume**: al poner `operational_status_key="paused"` con `paused_until`, se agenda un **resume** automático a `contactable` en `paused_until` (respetando horario laboral).
* Nueva actividad **cancela** `Ping10`, **dependientes 1d/3d/7d** y **resume programado**.
* Si seteas `won/opt_out/invalid/stopped`, se cancelan **todos** los jobs pendientes de esa conversación.

Abajo tienes los **archivos completos** para copiar/pegar y luego los **comandos** para redeploy y probar.

---

# 1) `src/services/jobs.js` (REEMPLAZA COMPLETO)

```js
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

// ================ Ping10 =================
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

// ================ Dependientes (1d/3d/7d) =================
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
    // Persist
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

// ================ Independientes =================
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

// ================ Pause / Resume =================
export async function scheduleResume(conv, pausedUntilISO, tz) {
  if (!opsQueue) return;
  const until = nextWorkingMoment(DateTime.fromISO(pausedUntilISO).toJSDate(), tz).toJSDate();
  const jobId = `ops:resume:${convKey(conv)}`;
  await removeJobIfExists(opsQueue, jobId);
  await opsQueue.add('ops_resume', { conv, paused_until: until.toISOString() }, {
    jobId,
    delay: Math.max(0, until.getTime() - Date.now()),
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: true,
    removeOnFail: false
  });
  // Registra en cola DB (para observabilidad)
  const knex = getKnex();
  await knex('aurum_followups_queue').insert({
    user_id: conv.user_id,
    telefono: conv.telefono,
    instancia_evolution_api: conv.instancia_evolution_api,
    dominio: conv.dominio,
    kind: 'ops_resume',
    scheduled_at: until.toISOString().slice(0, 19).replace('T', ' '),
    status: 'scheduled',
    cancel_on_new_ping: 1
  });
}

export async function cancelResume(conv) {
  if (!opsQueue) return;
  const jobId = `ops:resume:${convKey(conv)}`;
  await removeJobIfExists(opsQueue, jobId);
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

// ================ Cancelar todo (cuando se bloquea) =================
export async function cancelAllForConversation(conv) {
  await cancelPing10(conv);
  await cancelDependentReminders(conv);
  await cancelResume(conv);
}
```

---

# 2) `src/worker.js` (REEMPLAZA COMPLETO — añade `ops` y respeta reglas)

```js
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
export const opsQueue = new Queue('ops', { connection });

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
    .select('lead_id','user_id','telefono','instancia_evolution_api','dominio','nombre','apellido','zona_horaria','payload','lead_status')
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
    payload: payloadParsed,
    lead_status: row.lead_status ?? null
  };
}

// ---------------- Worker Ping10 ----------------
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

  const settings = await fetchUserSettings(knex, conv.user_id);
  const PING_URL = settings.PING_URL;
  const summary = (convRow.window_msg_count || 0) >= 3;
  const leadInfo = await fetchLead(knex, conv);

  if (PING_URL) {
    const payload = {
      version: REV,
      conversation: conv,
      lead: leadInfo, // incluye nombre/apellido/payload/lead_status
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

// ---------------- Worker Reminders ----------------
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
    await knex('aurum_followups_queue')
      .where({ id: reminder_id })
      .update({ status: 'done', updated_at: knex.fn.now() });
  }
}, { connection });

// ---------------- Worker Ops (resume) ----------------
new Worker('ops', async (job) => {
  const knex = getKnex();
  const { name } = job;
  if (name !== 'ops_resume') return;

  const { conv } = job.data;

  // Set contactable en Aurum y Midas
  await knex.raw(`
    INSERT INTO aurum_lead_state (user_id, telefono, instancia_evolution_api, dominio, operational_status_key, effective_at, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'contactable', NOW(), 'ops_resume', NOW(), NOW())
    ON DUPLICATE KEY UPDATE operational_status_key='contactable', effective_at=NOW(), source='ops_resume', updated_at=NOW()
  `, [conv.user_id, conv.telefono, conv.instancia_evolution_api, conv.dominio]);

  await knex('wa_bot_leads')
    .where(conv)
    .update({ lead_status: 'contactable', lead_status_updated_at: knex.fn.now() });

  // Marcar registro en cola DB como done
  await knex('aurum_followups_queue')
    .where({
      user_id: conv.user_id,
      telefono: conv.telefono,
      instancia_evolution_api: conv.instancia_evolution_api,
      dominio: conv.dominio,
      kind: 'ops_resume',
      status: 'scheduled'
    })
    .update({ status: 'done', updated_at: knex.fn.now() });

  logger.info({ conv }, 'ops_resume executed -> contactable');
}, { connection });

logger.info({ rev: REV }, 'aurum worker ready');
```

---

# 3) `src/routes/webhooks.js` (REEMPLAZA COMPLETO — no reabrir bloqueados; cancelar resume)

```js
import { Router } from 'express';
import crypto from 'node:crypto';
import { getKnex } from '../db/knex.js';
import { msgOnce } from '../clients/redis.js';
import { schedulePing10, cancelPing10, cancelDependentReminders, cancelResume } from '../services/jobs.js';
import { DateTime } from 'luxon';

const BLOCKED = ['won', 'opt_out', 'invalid', 'stopped'];

export function webhookRoutes({ logger }) {
  const router = Router();

  router.post('/webhooks/message', async (req, res) => {
    const { user_id, telefono, instancia_evolution_api, dominio, ts, msg_id } = req.body || {};
    if (!user_id || !telefono || !instancia_evolution_api || typeof dominio === 'undefined') {
      return res.status(400).json({ error: 'bad_request', details: 'missing conversation key', trace_id: req.traceId });
    }

    // Idempotencia por msg_id (o hash del body si falta)
    const bodyStr = JSON.stringify(req.body);
    const dedupeKey = `msg:${msg_id || crypto.createHash('sha1').update(bodyStr).digest('hex')}`;
    const firstTime = await msgOnce(dedupeKey, 86400);
    if (!firstTime) {
      return res.json({ ok: true, deduped: true, trace_id: req.traceId });
    }

    const knex = getKnex();
    // Verificar existencia en Midas
    const lead = await knex('wa_bot_leads')
      .select('lead_id', 'zona_horaria', 'lead_status', 'lead_business_status_key')
      .where({ user_id, telefono, instancia_evolution_api, dominio })
      .first();

    if (!lead) {
      logger.warn({ user_id, telefono, instancia_evolution_api, dominio, trace_id: req.traceId }, 'lead_no_encontrado');
      return res.status(404).json({ error: 'lead_no_encontrado', trace_id: req.traceId });
    }

    const now = DateTime.now();
    const eventTs = ts ? DateTime.fromMillis(Number(ts)) : now;
    const conv = { user_id, telefono, instancia_evolution_api, dominio };
    const tzEffective = lead.zona_horaria || process.env.DEFAULT_TIMEZONE || 'America/La_Paz';

    // UPSERT conversación (+2 mensajes)
    try {
      await knex.raw(`
        INSERT INTO aurum_conversations (user_id, telefono, instancia_evolution_api, dominio, last_activity_at, window_msg_count, timezone_effective, working_window, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 2, ?, NULL, NOW(), NOW())
        ON DUPLICATE KEY UPDATE
          last_activity_at = GREATEST(VALUES(last_activity_at), last_activity_at),
          window_msg_count = window_msg_count + 2,
          timezone_effective = VALUES(timezone_effective),
          updated_at = NOW()
      `, [user_id, telefono, instancia_evolution_api, dominio, eventTs.toSQL({ includeOffset: false }), tzEffective]);
    } catch (e) {
      logger.error({ err: e, trace_id: req.traceId }, 'update_conversation_failed');
      return res.status(500).json({ error: 'internal_error', trace_id: req.traceId });
    }

    // Cancelar jobs previos relevantes y reprogramar Ping10
    await cancelPing10(conv);
    await cancelDependentReminders(conv);
    await cancelResume(conv); // <--- NUEVO
    await schedulePing10(conv, eventTs.toISO(), tzEffective);

    // NO reabrir bloqueados automáticamente
    if (!lead.lead_status || !BLOCKED.includes(lead.lead_status)) {
      try {
        // Aurum
        await knex.raw(`
          INSERT INTO aurum_lead_state (user_id, telefono, instancia_evolution_api, dominio, operational_status_key, effective_at, source, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'contactable', NOW(), 'webhook', NOW(), NOW())
          ON DUPLICATE KEY UPDATE operational_status_key='contactable', effective_at=NOW(), source='webhook', updated_at=NOW()
        `, [user_id, telefono, instancia_evolution_api, dominio]);
        // Midas
        await knex('wa_bot_leads')
          .where({ user_id, telefono, instancia_evolution_api, dominio })
          .update({ lead_status: 'contactable', lead_status_updated_at: knex.fn.now() });
      } catch (e) {
        logger.error({ err: e, trace_id: req.traceId }, 'update_status_failed');
      }
    } else {
      logger.info({ user_id, telefono, instancia_evolution_api, dominio, lead_status: lead.lead_status }, 'webhook: status blocked, not reopening');
    }

    return res.json({ ok: true, reprogrammed_ping10: true, trace_id: req.traceId });
  });

  return router;
}
```

---

# 4) `src/routes/leads.js` (REEMPLAZA COMPLETO — pause/resume y bloqueos)

```js
import { Router } from 'express';
import { getKnex } from '../db/knex.js';
import { scheduleResume, cancelAllForConversation } from '../services/jobs.js';

const BLOCKED = ['won', 'opt_out', 'invalid', 'stopped'];

export function leadsRoutes({ logger }) {
  const router = Router();

  // GET /leads/state
  router.get('/leads/state', async (req, res) => {
    const { user_id, telefono, instancia_evolution_api, dominio } = req.query;
    if (!user_id || !telefono || !instancia_evolution_api || typeof dominio === 'undefined') {
      return res.status(400).json({ error: 'bad_request', trace_id: req.traceId });
    }
    const knex = getKnex();
    const lead = await knex('wa_bot_leads')
      .where({ user_id, telefono, instancia_evolution_api, dominio })
      .first();
    const aurumConv = await knex('aurum_conversations').where({ user_id, telefono, instancia_evolution_api, dominio }).first();
    const aurumState = await knex('aurum_lead_state').where({ user_id, telefono, instancia_evolution_api, dominio }).first();

    return res.json({ midas: lead || null, aurum: { conversation: aurumConv || null, state: aurumState || null }, trace_id: req.traceId });
  });

  // POST /leads/state
  router.post('/leads/state', async (req, res) => {
    const { user_id, telefono, instancia_evolution_api, dominio, operational_status_key, business_status_key, paused_until, force_reopen } = req.body || {};
    if (!user_id || !telefono || !instancia_evolution_api || typeof dominio === 'undefined') {
      return res.status(400).json({ error: 'bad_request', trace_id: req.traceId });
    }
    const conv = { user_id, telefono, instancia_evolution_api, dominio };
    const knex = getKnex();
    const lead = await knex('wa_bot_leads')
      .select('lead_status', 'lead_business_status_key')
      .where(conv).first();
    if (!lead) return res.status(404).json({ error: 'lead_no_encontrado', trace_id: req.traceId });

    // Reglas de bloqueo
    if (!force_reopen && lead.lead_status && BLOCKED.includes(lead.lead_status)) {
      // permitir cambiar business_status_key aunque esté bloqueado (si lo envían), pero no cambiar operativo salvo force
      if (!operational_status_key || operational_status_key === lead.lead_status) {
        // seguimos con negocio más abajo
      } else {
        return res.status(409).json({ error: 'blocked_status', details: `lead_status=${lead.lead_status}`, trace_id: req.traceId });
      }
    }

    // Aurum state (UPSERT)
    await knex.raw(`
      INSERT INTO aurum_lead_state (user_id, telefono, instancia_evolution_api, dominio, business_status_key, operational_status_key, paused_until, effective_at, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), 'api', NOW(), NOW())
      ON DUPLICATE KEY UPDATE
        business_status_key = VALUES(business_status_key),
        operational_status_key = VALUES(operational_status_key),
        paused_until = VALUES(paused_until),
        effective_at = NOW(),
        source = 'api',
        updated_at = NOW()
    `, [user_id, telefono, instancia_evolution_api, dominio, business_status_key || null, operational_status_key || null, paused_until || null]);

    // Midas mirror
    const midasUpdate = {};
    if (operational_status_key) midasUpdate.lead_status = operational_status_key;
    if (business_status_key) midasUpdate.lead_business_status_key = business_status_key;
    if (Object.keys(midasUpdate).length) {
      midasUpdate.lead_status_updated_at = knex.fn.now();
      midasUpdate.lead_business_status_updated_at = knex.fn.now();
      await knex('wa_bot_leads').where(conv).update(midasUpdate);
    }

    // lógica Pause/Resume y bloqueos
    if (operational_status_key === 'paused') {
      if (!paused_until) {
        return res.status(400).json({ error: 'paused_requires_until', trace_id: req.traceId });
      }
      const tz = process.env.DEFAULT_TIMEZONE || 'America/La_Paz';
      await scheduleResume(conv, paused_until, tz);
    }

    if (operational_status_key && BLOCKED.includes(operational_status_key)) {
      // Cancela todo si está bloqueado manualmente
      await cancelAllForConversation(conv);
    }

    return res.json({ ok: true, trace_id: req.traceId });
  });

  return router;
}
```

---

# 5) **Redeploy** (comandos exactos)

```bash
# 1) instala deps por si BullMQ/otros cambiaron (montas volumen)
cd /opt/projects/aurum
npm install --omit=dev

# 2) fuerza redeploy de servicios del stack 'aurum'
docker service update --force aurum_aurum-bot
docker service update --force aurum_aurum-worker

# (opcional) añade marca de versión para verificar headers en webhooks
export AURUM_REV="rev-$(date +%Y%m%d-%H%M%S)"
docker service update --env-add AURUM_REV=$AURUM_REV --force aurum_aurum-worker

# 3) logs
docker service logs -f aurum_aurum-bot
# en otra terminal:
docker service logs -f aurum_aurum-worker
```

---

# 6) 🧪 Pruebas rápidas

## A) Nueva actividad **NO** reabre bloqueados

1. Marca el lead como `won`:

```bash
curl -s https://aurum.kurukin.com/leads/state \
  -H 'content-type: application/json' \
  -d '{
    "user_id": 5, "telefono": "59179790873",
    "instancia_evolution_api": "tbs-santacruz",
    "dominio": "inscripciones.tbs.edu.bo",
    "operational_status_key": "won"
  }'
```

2. Envía mensaje (ts actual), debe **NO** cambiar a contactable:

```bash
curl -s https://aurum.kurukin.com/webhooks/message \
  -H 'content-type: application/json' \
  -d '{
    "user_id": 5,"telefono": "59179790873",
    "instancia_evolution_api": "tbs-santacruz",
    "dominio": "inscripciones.tbs.edu.bo",
    "msg_id": "act-'"$(date +%s)'" , "ts": '"$(date +%s000)"'
  }'
```

3. Ver estado:

```bash
curl -s 'https://aurum.kurukin.com/leads/state?user_id=5&telefono=59179790873&instancia_evolution_api=tbs-santacruz&dominio=inscripciones.tbs.edu.bo' | jq '.midas.lead_status'
# Debe seguir "won"
```

## B) **Pause/Resume** automático

1. Pausa 1 minuto (resume automático luego; respeta horario laboral):

```bash
UNTIL=$(date -u -d '+1 minute' +%Y-%m-%dT%H:%M:%SZ)
curl -s https://aurum.kurukin.com/leads/state \
  -H 'content-type: application/json' \
  -d '{
    "user_id": 5,"telefono": "59179790873",
    "instancia_evolution_api": "tbs-santacruz",
    "dominio": "inscripciones.tbs.edu.bo",
    "operational_status_key": "paused",
    "paused_until": "'"$UNTIL"'"
  }'
```

2. Revisa en DB/endpoint la cola `ops_resume`:

```bash
curl -s 'https://aurum.kurukin.com/reminders?user_id=5&telefono=59179790873&instancia_evolution_api=tbs-santacruz&dominio=inscripciones.tbs.edu.bo' | jq '.data[] | select(.kind=="ops_resume")'
```

3. Luego de ~1 min, el worker debe ejecutar `ops_resume`:

```bash
docker service logs -f aurum_aurum-worker | grep ops_resume
```

4. Estado vuelve a `contactable`:

```bash
curl -s 'https://aurum.kurukin.com/leads/state?user_id=5&telefono=59179790873&instancia_evolution_api=tbs-santacruz&dominio=inscripciones.tbs.edu.bo' | jq '.midas.lead_status'
```

## C) Nueva actividad cancela todo lo programado

```bash
TS=$(( $(date +%s) - 660 ))000
MSGID="t-$(date +%s)"
curl -s https://aurum.kurukin.com/webhooks/message \
  -H 'content-type: application/json' \
  -d '{
    "user_id": 5,"telefono": "59179790873",
    "instancia_evolution_api": "tbs-santacruz",
    "dominio": "inscripciones.tbs.edu.bo",
    "msg_id": "'"$MSGID"'","ts": '"$TS"'
  }'
# Dependientes re-agendados, resume cancelado.
```

---

¿Listo este paso? Si todo se ve bien (resume automático, bloqueos respetados, cancelaciones correctas), en el siguiente cerramos **README** + **payloads de ejemplo** y toques finales.


¡Listo el **Paso 5** quedó implementado (bloqueos + pausa/resume + cancelaciones)!
Para seguir **paso a paso**, haz este mini-check y me confirmas resultados.

---

# ✅ Qué cambió

* **/webhooks/message** ya **no reabre** `won|opt_out|invalid|stopped`.
* **Pausa** (`operational_status_key=paused` + `paused_until`) agenda **ops_resume** → vuelve a `contactable` en `paused_until` (respetando 09:00–22:00).
* Nueva actividad **cancela**: Ping10, 1d/3d/7d y **ops_resume**.
* `cancelAllForConversation()` desprograma todo si pasas a un estado bloqueado.

Archivos que **debiste reemplazar**:

* `src/services/jobs.js`
* `src/worker.js`
* `src/routes/webhooks.js`
* `src/routes/leads.js`

---

# 🚀 Despliegue (exacto)

```bash
cd /opt/projects/aurum
npm install --omit=dev

# Fuerza redeploy (stack "aurum"; ajusta si tu stack se llama distinto)
docker service update --force aurum_aurum-bot
docker service update --force aurum_aurum-worker

# (opcional) marca de versión visible en headers x-aurum-rev
export AURUM_REV="rev-$(date +%Y%m%d-%H%M%S)"
docker service update --env-add AURUM_REV=$AURUM_REV --force aurum_aurum-worker

# Logs
docker service logs -f aurum_aurum-bot
# en otra terminal
docker service logs -f aurum_aurum-worker
```

---

# 🧪 Pruebas rápidas (copia/pega)

### A) Bloqueados no se reabren por actividad

```bash
# 1) marca won
curl -s https://aurum.kurukin.com/leads/state \
  -H 'content-type: application/json' \
  -d '{"user_id":5,"telefono":"59179790873","instancia_evolution_api":"tbs-santacruz","dominio":"inscripciones.tbs.edu.bo","operational_status_key":"won"}'

# 2) actividad (no debe volver a contactable)
curl -s https://aurum.kurukin.com/webhooks/message \
  -H 'content-type: application/json' \
  -d '{"user_id":5,"telefono":"59179790873","instancia_evolution_api":"tbs-santacruz","dominio":"inscripciones.tbs.edu.bo","msg_id":"act-'$(date +%s)'","ts":'$(date +%s000)'}'

# 3) verifica estado midas
curl -s 'https://aurum.kurukin.com/leads/state?user_id=5&telefono=59179790873&instancia_evolution_api=tbs-santacruz&dominio=inscripciones.tbs.edu.bo' | jq '.midas.lead_status'
```

### B) Pausa → Resume automático

```bash
# pausa por 1 minuto
UNTIL=$(date -u -d '+1 minute' +%Y-%m-%dT%H:%M:%SZ)
curl -s https://aurum.kurukin.com/leads/state \
  -H 'content-type: application/json' \
  -d '{"user_id":5,"telefono":"59179790873","instancia_evolution_api":"tbs-santacruz","dominio":"inscripciones.tbs.edu.bo","operational_status_key":"paused","paused_until":"'"$UNTIL"'"}'

# se agenda ops_resume (lo ves en la lista)
curl -s 'https://aurum.kurukin.com/reminders?user_id=5&telefono=59179790873&instancia_evolution_api=tbs-santacruz&dominio=inscripciones.tbs.edu.bo' | jq '.data[] | select(.kind=="ops_resume")'
# tras ~1min, worker loguea "ops_resume executed -> contactable" y estado vuelve a "contactable"
```

### C) Nueva actividad cancela TODO lo programado

```bash
# fuerza un ping10 inmediato (ts hace 11 min)
TS=$(( $(date +%s) - 660 ))000
curl -s https://aurum.kurukin.com/webhooks/message \
  -H 'content-type: application/json' \
  -d '{"user_id":5,"telefono":"59179790873","instancia_evolution_api":"tbs-santacruz","dominio":"inscripciones.tbs.edu.bo","msg_id":"t-'$(date +%s)'","ts":'"$TS"'}'

# ahora manda actividad actual (cancela 1d/3d/7d y ops_resume)
curl -s https://aurum.kurukin.com/webhooks/message \
  -H 'content-type: application/json' \
  -d '{"user_id":5,"telefono":"59179790873","instancia_evolution_api":"tbs-santacruz","dominio":"inscripciones.tbs.edu.bo","msg_id":"t2-'$(date +%s)'","ts":'$(date +%s000)'}'

# lista pendientes: los dependientes scheduled->cancelled; no debe haber ops_resume scheduled
curl -s 'https://aurum.kurukin.com/reminders?user_id=5&telefono=59179790873&instancia_evolution_api=tbs-santacruz&dominio=inscripciones.tbs.edu.bo' | jq
```

---

# 📌 Siguiente paso (cuando confirmes estas pruebas)

* Redondeo **README** (deploy en Portainer, ejemplos `curl`, payloads, troubleshooting).
* Agrego ejemplos de **/reminders** (independientes) y **/admin**.
* Si quieres, agregamos contador de **summary** y métrica en `/metrics` (prom-client) para Ping10/Reminders.

Dime cómo te fue con A/B/C y seguimos.


¡Perfecto! Cerramos el MVP con **documentación lista para producción**. Te dejo **README.md**, **.env.example** y el **stack de ejemplo** (por si quieres versionarlo). Todo respeta lo que ya desplegaste.

---

# ✅ Archivos nuevos

## 1) `README.md` (cópialo en `/opt/projects/aurum/README.md`)

```md
# Aurum (MVP)

Microservicio **Node.js (ESM)** que actúa como puente entre **n8n**, **Midas (MySQL)** y **WhatsApp**.  
Comparte infraestructura con Midas (Swarm/Traefik/Portainer). Mantiene estado por conversación, dispara **Ping10** a los 10 min de inactividad, agenda **recordatorios dependientes (1d/3d/7d)**, y soporta **recordatorios independientes**.

---

## Tabla de contenido
- [Arquitectura](#arquitectura)
- [Requisitos](#requisitos)
- [Variables de entorno](#variables-de-entorno)
- [Despliegue (Portainer/Swarm)](#despliegue-portainerswarm)
- [Migraciones y Seeds](#migraciones-y-seeds)
- [Endpoints](#endpoints)
- [Flujos y reglas](#flujos-y-reglas)
- [Pruebas rápidas](#pruebas-rápidas)
- [Observabilidad](#observabilidad)
- [Troubleshooting](#troubleshooting)
- [Licencia](#licencia)

---

## Arquitectura

- **API** (Express) y **Worker** (BullMQ) como **dos servicios** en el mismo stack.
- **DB única = Midas (MySQL 5.7)**. Aurum crea sus tablas en el **mismo** schema.
- **Redis** para colas (**BullMQ**) e idempotencia (claves `msg:<msg_id>`).
- **Traefik**: expone solo el servicio **API** por `aurum.kurukin.com`.
- **Portainer**: gestiona el stack Swarm.

```

n8n <-> Aurum API <-> MySQL (Midas)
|
+-> Redis (colas Ping10/Reminders/Ops)
|
+-> Aurum Worker -> llama webhooks (PING_URL/REMINDER_URL)

````

---

## Requisitos
- Node.js 20+
- Docker 24+ / Docker Swarm
- MySQL 5.7 (schema de Midas)
- Redis (ya tienes stack de Redis)

---

## Variables de entorno

Usa **una sola DB (Midas)**:

| Variable            | Ejemplo/Default        | Descripción |
|---------------------|------------------------|-------------|
| `DB_HOST`           | `wordpress_db`         | Host MySQL |
| `DB_USER`           | `bot_kurukin_user`     | Usuario MySQL |
| `DB_PASSWORD`       | `***`                  | Password |
| `DB_NAME`           | `bot_kurukin_wp`       | Base de datos (Midas) |
| `REDIS_HOST`        | `redis`                | Host Redis |
| `REDIS_PORT`        | `6379`                 | Puerto Redis |
| `REDIS_DB`          | `0`                    | DB index |
| `REDIS_PASSWORD`    | *(vacío)*              | Password si aplica |
| `APP_PORT`          | `4001`                 | Puerto interno API |
| `DEFAULT_TIMEZONE`  | `America/La_Paz`       | TZ por defecto |
| `APP_TRUST_PROXY`   | `1`                    | Respeta X-Forwarded-* |
| `AURUM_REV`         | `rev-YYYYMMDD-HHMMSS`  | Marca de versión (headers) |

> Los webhooks por usuario se configuran en **DB**: tabla `aurum_user_settings` (`PING_URL`, `REMINDER_URL`).

---

## Despliegue (Portainer/Swarm)

1. **Build local** (opcional si ya lo hiciste; recuerdas que montamos volumen):
   ```bash
   cd /opt/projects/aurum
   npm install --omit=dev
   docker build -t aurum-bot:latest .
````

2. **Stack en Portainer**
   Usa `docker-stack.example.yml` como referencia. Debe tener **dos servicios**: `aurum-bot` (API) y `aurum-worker` (Worker), misma red `general_network` y labels Traefik:

   * Router: `aurum.kurukin.com`
   * EntryPoint: `websecure`
   * TLS resolver: `le`
   * Service port: `4001`

3. **Re-deploy rápido** desde CLI:

   ```bash
   docker service update --force aurum_aurum-bot
   docker service update --force aurum_aurum-worker
   # (opcional) marca de versión visible en headers x-aurum-rev
   export AURUM_REV="rev-$(date +%Y%m%d-%H%M%S)"
   docker service update --env-add AURUM_REV=$AURUM_REV --force aurum_aurum-worker
   ```

---

## Migraciones y Seeds

Las migraciones y seeds **corren automáticamente** al iniciar la API (`src/server.js` llama `runMigrationsAndSeeds()`).

Tablas Aurum en **DB Midas**:

* `aurum_conversations`
* `aurum_user_settings`
* `aurum_followups_queue`
* `aurum_status_catalog` *(negocio, por usuario)*
* `aurum_operational_status_catalog` *(operacional global)*
* `aurum_lead_state` *(estado actual de la conversación)*

Seeds incluidos:

* **Estados de negocio user_id=5** (curioso/interesado/…)
* **Catálogo operacional** global (contactable/paused/opt_out/won/…).

---

## Endpoints

### Observabilidad

* `GET /healthz` → `{ status: "ok" }`
* `GET /readyz` → `{ status: "ready", dependencies: { db, redis } }`
* `GET /metrics` → Prometheus (HTTP request duration, etc.)

### Webhook de actividad

* `POST /webhooks/message`
  **Body**:

  ```json
  {
    "user_id": 5,
    "telefono": "59179790873",
    "instancia_evolution_api": "tbs-santacruz",
    "dominio": "inscripciones.tbs.edu.bo",
    "msg_id": "unico-por-evento",
    "ts": 1730000000000
  }
  ```

  **Efecto**:

  * +2 mensajes (`window_msg_count += 2`)
  * Reprograma **Ping10**
  * Cancela Ping10 anterior, dependientes 1d/3d/7d, y `ops_resume`
  * Estado operacional pasa a `contactable` **salvo** si el lead está bloqueado (`won|opt_out|invalid|stopped`)

### Estado Lead

* `GET /leads/state?user_id=&telefono=&instancia_evolution_api=&dominio=`
  Retorna `midas` + `aurum.conversation` + `aurum.state`.

* `POST /leads/state`
  **Body**:

  ```json
  {
    "user_id": 5,
    "telefono": "59179790873",
    "instancia_evolution_api": "tbs-santacruz",
    "dominio": "inscripciones.tbs.edu.bo",
    "operational_status_key": "paused",
    "paused_until": "2025-10-26T20:15:00Z",
    "business_status_key": "interesado_avanzado",
    "force_reopen": false
  }
  ```

  **Notas**:

  * `paused` **requiere** `paused_until` y agenda **ops_resume** a `contactable` (respetando 09:00–22:00).
  * Si `operational_status_key` es `won|opt_out|invalid|stopped`, se **cancela todo** lo agendado.
  * `force_reopen` permite cambiar estados operativos incluso si estaba bloqueado.

### Recordatorios independientes

* `POST /reminders`:

  ```json
  { "user_id":5, "telefono":"...", "instancia_evolution_api":"...", "dominio":"...", "days_offset":2 }
  ```

  Retorna `reminder_id`. **No** se cancelan por Ping10.

* `GET /reminders` (filtros por query)

* `POST /reminders/:id/cancel` (requiere conversación en body)

### Admin

* `POST /admin/cancel` → `{ queue, jobId }`
* `POST /admin/requeue` → `{ queue, jobId }`

---

## Flujos y reglas

**Identidad conversación**: `(user_id, telefono, instancia_evolution_api, dominio)`

* **Idempotencia**: Redis `SETNX msg:<msg_id>` con TTL 1 día.

* **Ping10**:

  * Ejecuta si han pasado **≥10 min** desde `last_activity_at`.
  * Si `window_msg_count ≥ 3` → `summary = true`.
  * Webhook a `PING_URL` con:

    ```json
    {
      "version": "rev-...",
      "conversation": { ... },
      "lead": { lead_id, nombre, apellido, nombre_completo, zona_horaria, payload, lead_status },
      "summary": false,
      "last_activity_at": "...",
      "window_msg_count": 2,
      "trace_id": "ping10-<jobId>"
    }
    ```
  * Reinicia contador y agenda **1d/3d/7d** (`reminder_scheduled` en Aurum).

* **Nueva actividad**:

  * Cancela Ping10 y dependientes 1d/3d/7d y `ops_resume`.
  * **NO** reabre bloqueados (`won|opt_out|invalid|stopped`) salvo `force_reopen`.

* **Pausa**:

  * `paused_until` → programa `ops_resume` (cambia a `contactable` en Midas + Aurum cuando llegue la hora, movida a horario hábil si cae fuera de ventana).

* **Ventana laboral y TZ**:

  * Por defecto: **Lun–Dom 09:00–22:00**, TZ del lead si existe, si no `America/La_Paz`.
  * Envíos fuera de horario → se posponen al siguiente hábil a las 09:00.

---

## Pruebas rápidas

**Health/Ready**

```bash
curl -s https://aurum.kurukin.com/healthz
curl -s https://aurum.kurukin.com/readyz | jq
```

**Forzar Ping10 ya (ts hace 11 min, msg_id único)**

```bash
TS=$(( $(date +%s) - 660 ))000
MSGID="ping10-$(date +%s)-$RANDOM"
curl -s https://aurum.kurukin.com/webhooks/message \
  -H 'content-type: application/json' \
  -d '{"user_id":5,"telefono":"59179790873","instancia_evolution_api":"tbs-santacruz","dominio":"inscripciones.tbs.edu.bo","msg_id":"'"$MSGID"'","ts":'"$TS"'}'
```

**Ver recordatorios**

```bash
curl -s 'https://aurum.kurukin.com/reminders?user_id=5&telefono=59179790873&instancia_evolution_api=tbs-santacruz&dominio=inscripciones.tbs.edu.bo' | jq
```

**Pausa 1 min y espera resume**

```bash
UNTIL=$(date -u -d '+1 minute' +%Y-%m-%dT%H:%M:%SZ)
curl -s https://aurum.kurukin.com/leads/state \
  -H 'content-type: application/json' \
  -d '{"user_id":5,"telefono":"59179790873","instancia_evolution_api":"tbs-santacruz","dominio":"inscripciones.tbs.edu.bo","operational_status_key":"paused","paused_until":"'"$UNTIL"'"}'
```

---

## Observabilidad

* Logs JSON con `pino` (API) y logs del Worker.
* `/metrics`: Prometheus (latencias HTTP y contadores básicos).
* Headers `x-aurum-rev` en webhooks para trazar versión activa del worker.

---

## Troubleshooting

* **`deduped:true`** en `/webhooks/message` → `msg_id` repetido. Usa uno nuevo o limpia en Redis.
* **Lead no encontrado** → la conversación debe existir en `wa_bot_leads` (no se crean leads en Aurum).
* **No llega `lead` en Ping10** → verifica que el Worker tenga el archivo `src/worker.js` con `lead: leadInfo` y reinicia servicio; usa `AURUM_REV` para confirmar versión en headers.
* **Jobs que no corren** → revisa Redis y que el Worker esté “ready”. Para Swarm, usa `docker service logs -f aurum_aurum-worker`.

---

## Licencia

MVP interno Kurukin. Todos los derechos reservados.

````

---

## 2) `.env.example` (cópialo en `/opt/projects/aurum/.env.example`)
```dotenv
# App
NODE_ENV=development
APP_NAME=aurum
APP_PORT=4001
APP_TRUST_PROXY=1
DEFAULT_TIMEZONE=America/La_Paz

# DB única (Midas)
DB_HOST=wordpress_db
DB_PORT=3306
DB_USER=bot_kurukin_user
DB_PASSWORD=REEMPLAZAR
DB_NAME=bot_kurukin_wp

# Redis
REDIS_HOST=redis
REDIS_PORT=6379
REDIS_DB=0
REDIS_PASSWORD=

# Observabilidad
METRICS_ENABLED=true

# Marca de build (opcional, el worker la envía en headers)
AURUM_REV=dev
````

---

## 3) `docker-stack.example.yml` (ya te lo di antes, pero repito)

> Guarda una copia en el repo y usa el de Portainer con credenciales reales.

```yaml
version: '3.8'

services:
  aurum-bot:
    image: aurum-bot:latest
    working_dir: /opt/projects/aurum
    volumes:
      - /opt/projects/aurum:/opt/projects/aurum
    command: npm start
    environment:
      DB_HOST: "wordpress_db"
      DB_USER: "<DB_USER>"
      DB_PASSWORD: "<DB_PASSWORD>"
      DB_NAME: "bot_kurukin_wp"

      REDIS_HOST: "redis"
      REDIS_PORT: "6379"
      REDIS_DB: "0"
      REDIS_PASSWORD: ""

      NODE_ENV: "production"
      APP_NAME: "aurum"
      APP_PORT: "4001"
      APP_TRUST_PROXY: "1"
      DEFAULT_TIMEZONE: "America/La_Paz"
    deploy:
      labels:
        - "traefik.enable=true"
        - "traefik.http.routers.kurukinaurum.rule=Host(`aurum.kurukin.com`)"
        - "traefik.http.routers.kurukinaurum.entrypoints=websecure"
        - "traefik.http.routers.kurukinaurum.tls.certresolver=le"
        - "traefik.http.routers.kurukinaurum.tls=true"
        - "traefik.http.services.kurukinaurum.loadbalancer.server.port=4001"
    networks:
      - general_network
      - traefik_public

  aurum-worker:
    image: aurum-bot:latest
    working_dir: /opt/projects/aurum
    volumes:
      - /opt/projects/aurum:/opt/projects/aurum
    command: npm run worker
    environment:
      DB_HOST: "wordpress_db"
      DB_USER: "<DB_USER>"
      DB_PASSWORD: "<DB_PASSWORD>"
      DB_NAME: "bot_kurukin_wp"

      REDIS_HOST: "redis"
      REDIS_PORT: "6379"
      REDIS_DB: "0"
      REDIS_PASSWORD: ""

      NODE_ENV: "production"
      APP_NAME: "aurum"
      DEFAULT_TIMEZONE: "America/La_Paz"
    deploy:
      labels:
        - "traefik.enable=false"
    networks:
      - general_network

networks:
  general_network:
    external: true
  traefik_public:
    external: true
```

