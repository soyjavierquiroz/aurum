import knexModule from 'knex';

let _knex = null;

export function createKnex() {
  const { DB_HOST, DB_PORT, DB_USER, DB_PASSWORD } = process.env;
  const DB_NAME = process.env.DB_NAME || process.env.DB_DATABASE;
  if (!DB_HOST || !DB_USER || !DB_NAME) {
    throw new Error('DB env incomplete: DB_HOST, DB_USER, DB_PASSWORD, DB_NAME required');
  }
  return knexModule({
    client: 'mysql2',
    connection: {
      host: DB_HOST,
      port: Number(DB_PORT || 3306),
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_NAME
    },
    pool: { min: 0, max: 10 }
  });
}

export function getKnex() {
  if (_knex) return _knex;
  _knex = createKnex();
  return _knex;
}
