import IORedis from 'ioredis';

let _redis = null;

export function getRedis() {
  if (_redis) return _redis;
  const { REDIS_HOST, REDIS_PORT, REDIS_PASSWORD, REDIS_DB } = process.env;
  if (!REDIS_HOST) return null;
  _redis = new IORedis({
    host: REDIS_HOST,
    port: Number(REDIS_PORT || 6379),
    password: REDIS_PASSWORD || undefined,
    db: Number(REDIS_DB || 0)
  });
  return _redis;
}

export async function pingRedis() {
  const redis = getRedis();
  if (!redis) return { configured: false, ok: true };
  try {
    const pong = await redis.ping();
    return { configured: true, ok: pong === 'PONG' };
  } catch (e) {
    return { configured: true, ok: false, error: e.message };
  }
}

// Idempotencia simple por msg_id: SETNX con TTL
export async function msgOnce(key, ttlSeconds = 86400) {
  const redis = getRedis();
  if (!redis) return true; // si no hay Redis, seguimos (MVP)
  const ok = await redis.set(key, '1', 'NX', 'EX', ttlSeconds);
  return ok === 'OK';
}
