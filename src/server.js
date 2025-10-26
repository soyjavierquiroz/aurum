import { buildApp } from './app.js';
import { logger } from './lib/logger.js';
import { runMigrationsAndSeeds } from './db/migrate.js';

const PORT = Number(process.env.APP_PORT || 4001);

async function main() {
  // Migraciones + seeds (una sola DB — Midas)
  try {
    await runMigrationsAndSeeds();
  } catch (e) {
    logger.error({ err: e }, 'migrations/seeds failed (continuing startup)');
    // MVP: continuamos el arranque, /readyz te indicará si hay problemas
  }

  const app = buildApp();
  const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, 'aurum api listening');
  });

  const shutdown = (signal) => {
    logger.info({ signal }, 'shutting down');
    server.close(() => {
      logger.info('http server closed');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 8000).unref();
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  // last resort
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
