'use strict';

const pino = require('pino');

/**
 * Structured production logger using Pino.
 *
 * - In development (NODE_ENV !== 'production'): pretty-prints with color
 * - In production: outputs raw newline-delimited JSON for log aggregators
 *   (Datadog, Logflare, CloudWatch, Sentry, etc.)
 *
 * Log levels (set via LOG_LEVEL env var):
 *   trace | debug | info | warn | error | fatal
 */
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: 'webhook-engine', version: '1.0' },
  timestamp: pino.stdTimeFunctions.isoTime,
  transport: process.env.NODE_ENV !== 'production'
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss',
          ignore: 'pid,hostname,service,version',
        },
      }
    : undefined,
});

module.exports = logger;
