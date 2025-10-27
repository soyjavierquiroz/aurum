// src/clients/redis.js (ESM)
import IORedis from 'ioredis';
import { logger } from '../lib/logger.js';

let client = null;

/**
 * Singleton de IORedis configurado para BullMQ.
 * - maxRetriesPerRequest: null -> elimina el warning de BullMQ
 * - enableReadyCheck: true     -> espera a que Redis esté listo
 * - TLS opcional vía REDIS_TLS=true
 */
export function getRedis() {
  if (client) return client;

  const {
    REDIS_HOST,
    REDIS_PORT = '6379',
    REDIS_PASSWORD,
    REDIS_DB = '0',
    REDIS_TLS = 'false',
  } = process.env;

  if (!REDIS_HOST) {
    logger?.warn('getRedis: REDIS_HOST no está configurado. Redis/colas deshabilitados.');
    return null;
  }

  const opts = {
    host: REDIS_HOST,
    port: Number(REDIS_PORT),
    password: REDIS_PASSWORD || undefined,
    db: Number(REDIS_DB),
    maxRetriesPerRequest: null, // <- clave para BullMQ
    enableReadyCheck: true,
    autoResubscribe: true,
    enableOfflineQueue: true,
    reconnectOnError: (err) => {
      if (err && err.message && err.message.includes('READONLY')) return true;
      return false;
    },
  };

  if (String(REDIS_TLS).toLowerCase() === 'true') {
    opts.tls = {}; // usa TLS por defecto
  }

  client = new IORedis(opts);

  client.on('ready', () => {
    logger?.info(
      { host: opts.host, port: opts.port, db: opts.db },
      'redis ready'
    );
  });

  client.on('error', (err) => {
    logger?.error({ err }, 'redis error');
  });

  return client;
}

/**
 * Ping de salud para /healthz /readyz.
 * Devuelve { ok, pong, latency_ms } o { ok:false, error }
 */
export async function pingRedis() {
  const r = getRedis();
  if (!r) return { ok: false, error: 'no_redis' };
  try {
    const t0 = Date.now();
    const pong = await r.ping();
    const latency_ms = Date.now() - t0;
    return { ok: pong === 'PONG', pong, latency_ms };
  } catch (err) {
    logger?.error({ err }, 'redis ping failed');
    return { ok: false, error: String(err?.message || err) };
  }
}

/**
 * msgOnce: idempotencia por msg_id.
 * Retorna true si es la primera vez (se guardó), false si ya existía (duplicado).
 *
 * @param {string} id - identificador único (msg_id)
 * @param {number} ttlSeconds - TTL del dedupe en segundos (default 24h)
 * @returns {Promise<boolean>} true=primera vez, false=duplicado
 */
export async function msgOnce(id, ttlSeconds = 24 * 60 * 60) {
  const r = getRedis();
  if (!r) return true; // sin Redis, deja pasar (mejor que romper)
  const safe = String(id ?? '').trim();
  if (!safe) return true;

  const key = `aurum:msg:${safe}`;
  try {
    // SET key NX EX ttl => solo setea si no existe
    const resp = await r.set(key, '1', 'EX', ttlSeconds, 'NX');
    return resp === 'OK'; // OK => primera vez; null => duplicado
  } catch (err) {
    logger?.error({ err, key }, 'msgOnce failed');
    // En error, comportarse como primera vez para no bloquear flujo
    return true;
  }
}
