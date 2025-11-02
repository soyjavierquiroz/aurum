// src/routes/turns.js
import { Router } from 'express';
import { DateTime } from 'luxon';
import { getKnex } from '../db/knex.js';

/** Conv key helper */
function buildConv({ user_id, telefono, instancia_evolution_api, dominio }) {
  return {
    user_id: Number(user_id),
    telefono: String(telefono).trim(),
    instancia_evolution_api: String(instancia_evolution_api).trim(),
    dominio: String(dominio).trim(),
  };
}

/** Normaliza cualquier fecha/hora a DATETIME MySQL "YYYY-MM-DD HH:mm:ss"
 *  Acepta:
 *  - "YYYY-MM-DD"
 *  - "YYYY-MM-DD HH:mm" / "YYYY-MM-DD HH:mm:ss"
 *  - "YYYY-MM-DDTHH:mm" / "YYYY-MM-DDTHH:mm:ss"
 *  - ISO con Z u offset (p.ej. "2025-11-03T09:00:00-04:00")
 *  Si solo viene fecha, fija 09:00:00 en la zona tz.
 */
function toMySQLDateTime(input, tz = 'America/La_Paz') {
  if (!input) return null;
  let v = String(input).trim();

  // YYYY-MM-DD → set 09:00:00
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) {
    return `${v} 09:00:00`;
  }
  // MySQL ya completo
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(v)) return `${v}:00`;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(v)) return v;

  // ISO sin zona → reemplaza T por espacio
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return v.replace('T', ' ') + ':00';
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(v)) return v.replace('T', ' ');

  // ISO con Z u offset → usa Luxon y convierte a tz, luego a MySQL
  const dt = DateTime.fromISO(v, { setZone: true });
  if (dt.isValid) {
    return dt.setZone(tz).toFormat('yyyy-LL-dd HH:mm:ss');
  }

  // Fallback: intenta parse genérico con Luxon
  const dt2 = DateTime.fromJSDate(new Date(v));
  if (dt2.isValid) {
    return dt2.setZone(tz).toFormat('yyyy-LL-dd HH:mm:ss');
  }

  throw new Error('bad_datetime');
}

/** Normaliza un timestamp cualquiera a DATETIME MySQL (o null) */
function toMySQLFromTs(ts, tz = 'America/La_Paz') {
  if (ts == null) return null;
  if (typeof ts === 'number') {
    // si parece segundos, multiplica
    const ms = ts < 1e12 ? ts * 1000 : ts;
    return DateTime.fromMillis(ms, { zone: tz }).toFormat('yyyy-LL-dd HH:mm:ss');
  }
  return toMySQLDateTime(ts, tz);
}

/** Aplica propuesta de estado (Midas + Aurum) dentro de una transacción */
async function applyStateProposal(trx, conv, proposal, tzEff, logger) {
  if (!proposal?.should_update) return null;

  // Normaliza claves
  let op = (proposal.operational_status_key || '').trim().toLowerCase();
  const biz = (proposal.business_status_key || '').trim().toLowerCase();

  // "open" lo mapeamos a "contactable" en nuestro modelo
  if (op === 'open') op = 'contactable';

  // Normaliza paused_until a DATETIME MySQL en la zona efectiva
  let pausedUntil = null;
  if (proposal.paused_until) {
    pausedUntil = toMySQLDateTime(proposal.paused_until, tzEff);
  }

  // Reglas de reapertura
  const midas = await trx('wa_bot_leads').where(conv).first();
  const blocked = ['won', 'opt_out', 'invalid', 'stopped'].includes(String(midas?.lead_status || '').toLowerCase());
  const forceReopen = !!proposal.force_reopen;

  if (op && blocked && !forceReopen) {
    // No aplicamos cambios si está bloqueado y no se fuerza
    return { skipped: true, reason: `blocked_status=${midas?.lead_status || 'unknown'}` };
  }

  // 1) Reflejo en Midas
  const midasUpdate = {};
  if (op) {
    midasUpdate.lead_status = op === 'paused' ? 'paused' : op;
  }
  if (biz) {
    midasUpdate.lead_business_status_key = biz;
  }
  if (Object.keys(midasUpdate).length) {
    midasUpdate.updated_at = trx.fn.now();
    await trx('wa_bot_leads').where(conv).update(midasUpdate);
  }

  // 2) Upsert en aurum_lead_state
  const reason_code = proposal.reason_code || null;
  const note = proposal.note || null;

  await trx.raw(
    `
    INSERT INTO aurum_lead_state
      (user_id, telefono, instancia_evolution_api, dominio,
       operational_status_key, business_status_key, reason_code, note, paused_until,
       effective_at, source, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), 'turn', NOW(), NOW())
    ON DUPLICATE KEY UPDATE
      operational_status_key = VALUES(operational_status_key),
      business_status_key    = VALUES(business_status_key),
      reason_code            = VALUES(reason_code),
      note                   = VALUES(note),
      paused_until           = VALUES(paused_until),
      effective_at           = NOW(),
      source                 = 'turn',
      updated_at             = NOW()
    `,
    [
      conv.user_id, conv.telefono, conv.instancia_evolution_api, conv.dominio,
      op || null, biz || null, reason_code, note, pausedUntil
    ]
  );

  return {
    applied: {
      operational_status_key: op || null,
      business_status_key: biz || null,
      paused_until: pausedUntil
    }
  };
}

export function turnRoutes({ logger }) {
  const router = Router();

  /**
   * POST /leads/turn
   * Body:
   *  - conv key: user_id, telefono, instancia_evolution_api, dominio
   *  - msg_id (idempotencia por conv+msg_id)
   *  - direction? ("in" | "out"), text?
   *  - blocks? (JSON) y marketing_state? (JSON)
   *  - ts?  (number ms/seg o string fecha) -> se normaliza a DATETIME MySQL
   *  - state_proposal? -> aplica actualización de estado (Midas + Aurum)
   */
  router.post('/leads/turn', async (req, res) => {
    const knex = getKnex();
    try {
      const {
        user_id, telefono, instancia_evolution_api, dominio,
        msg_id,
        direction = null,
        text = null,
        blocks = null,
        marketing_state = null,
        ts = null,
        state_proposal = null,
      } = req.body || {};

      if (!user_id || !telefono || !instancia_evolution_api || !dominio || !msg_id) {
        return res.status(400).json({ error: 'bad_request', trace_id: req.traceId });
      }

      const conv = buildConv({ user_id, telefono, instancia_evolution_api, dominio });

      // Determinar zona efectiva
      const midas = await knex('wa_bot_leads').where(conv).first();
      const tzEff = midas?.zona_horaria || process.env.DEFAULT_TIMEZONE || 'America/La_Paz';

      // Asegurar conversación y actualizar timezone_effective
      await knex.transaction(async (trx) => {
        const exists = await trx('aurum_conversations').where(conv).first();
        if (!exists) {
          await trx('aurum_conversations').insert({
            ...conv,
            last_activity_at: trx.fn.now(),
            timezone_effective: tzEff,
            created_at: trx.fn.now(),
            updated_at: trx.fn.now()
          });
        } else if (exists.timezone_effective !== tzEff) {
          await trx('aurum_conversations').where(conv).update({
            timezone_effective: tzEff,
            updated_at: trx.fn.now()
          });
        }
      });

      // 1) Persistir el turno con idempotencia por msg_id
      const tsMySQL = toMySQLFromTs(ts, tzEff); // puede ser null y está bien
      const directionNorm = direction ? String(direction).toLowerCase() : null;
      let idempotent = false;

      try {
        await knex.raw(
          `
          INSERT INTO aurum_turns
            (user_id, telefono, instancia_evolution_api, dominio,
             msg_id, direction, text, blocks_json, marketing_state_json, ts,
             created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
          ON DUPLICATE KEY UPDATE updated_at = VALUES(updated_at)
          `,
          [
            conv.user_id,
            conv.telefono,
            conv.instancia_evolution_api,
            conv.dominio,
            String(msg_id),
            directionNorm,
            text,
            blocks ? JSON.stringify(blocks) : null,
            marketing_state ? JSON.stringify(marketing_state) : null,
            tsMySQL
          ]
        );
      } catch (e) {
        // Si fuera un error de formato inesperado
        if (String(e?.message || '').includes('ER_DUP_ENTRY')) {
          idempotent = true;
        } else {
          throw e;
        }
      }

      // 2) Aplicar propuesta de estado (si viene)
      let applied = null;
      if (state_proposal?.should_update) {
        await knex.transaction(async (trx) => {
          const resApplied = await applyStateProposal(trx, conv, state_proposal, tzEff, logger);
          if (resApplied?.applied) applied = resApplied.applied;
        });
      }

      return res.json({
        ok: true,
        idempotent,
        applied,
        trace_id: req.traceId
      });
    } catch (err) {
      const details = err?.message || String(err);
      // Si el problema fue la fecha: devolvemos mensaje claro
      if (details === 'bad_datetime') {
        return res.status(400).json({ error: 'bad_datetime', details: 'paused_until no tiene un formato válido', trace_id: req.traceId });
      }
      return res.status(500).json({ error: 'turn_failed', details, trace_id: req.traceId });
    }
  });

  return router;
}
