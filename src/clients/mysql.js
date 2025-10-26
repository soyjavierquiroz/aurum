import mysql from 'mysql2/promise';

export async function pingDB() {
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD } = process.env;
  const DB_NAME = process.env.DB_NAME || process.env.DB_DATABASE;

  if (!DB_HOST) return { configured: false, ok: true };

  try {
    const conn = await mysql.createConnection({
      host: DB_HOST,
      port: Number(DB_PORT || 3306),
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_NAME
    });
    await conn.query('SELECT 1');
    await conn.end();
    return { configured: true, ok: true };
  } catch (e) {
    return { configured: true, ok: false, error: e.message };
  }
}
