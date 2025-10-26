import pino from 'pino';

const level = process.env.NODE_ENV === 'production' ? 'info' : 'debug';

export const logger = pino({
  level,
  base: {
    app: process.env.APP_NAME || 'aurum',
    env: process.env.NODE_ENV || 'development'
  },
  timestamp: pino.stdTimeFunctions.isoTime
});
