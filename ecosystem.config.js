/**
 * PM2 Ecosystem Configuration — WebhookEngine
 *
 * Usage:
 *   npm run prod          → Start in cluster mode (all CPU cores)
 *   pm2 logs webhook-engine  → Tail structured logs
 *   pm2 monit             → Real-time process dashboard
 *   pm2 reload webhook-engine → Zero-downtime reload
 *   pm2 stop webhook-engine   → Graceful stop
 */

module.exports = {
  apps: [
    {
      name:         'webhook-engine',
      script:       'server.js',
      instances:    'max',          // one worker per CPU core
      exec_mode:    'cluster',      // Node.js cluster for zero-downtime reloads
      watch:        false,
      restart_delay: 1000,          // wait 1s before restart after crash
      max_restarts:  15,            // give up after 15 rapid crashes
      min_uptime:    '10s',         // must stay up 10s to count as stable start
      kill_timeout:  5000,          // wait 5s for graceful shutdown before SIGKILL

      env: {
        NODE_ENV:      'development',
        PORT:          4000,
        STORAGE_TYPE:  'json',
        LOG_LEVEL:     'debug',
      },

      env_production: {
        NODE_ENV:      'production',
        PORT:          4000,
        STORAGE_TYPE:  'redis',
        LOG_LEVEL:     'info',
      },

      // Structured log files (production)
      out_file:  './logs/out.log',
      error_file: './logs/error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
    },
  ],
};
