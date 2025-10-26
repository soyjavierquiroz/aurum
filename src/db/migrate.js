import { createKnex } from './knex.js';
import { logger } from '../lib/logger.js';
import init from './migrations/0001_init.js';
import seedStatus from './seeds/0001_status_user5.js';
import seedOperational from './seeds/0002_operational.js';

export async function runMigrationsAndSeeds() {
  const knex = createKnex();
  try {
    await init.up(knex);
    await seedStatus.run(knex);
    await seedOperational.run(knex);
    logger.info('migrations and seeds completed');
  } finally {
    await knex.destroy();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrationsAndSeeds().catch((err) => {
    logger.error({ err }, 'migration/seed failed');
    process.exit(1);
  });
}
