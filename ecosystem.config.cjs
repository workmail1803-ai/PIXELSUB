// PM2 process definition — local hosting on this machine.
// CommonJS (.cjs) on purpose: package.json sets "type": "module", so a plain
// .js ecosystem file would be loaded as ESM and PM2 could not require() it.
//
//   pm2 start ecosystem.config.cjs     start
//   pm2 logs telebot-shop              tail logs
//   pm2 restart telebot-shop           apply code changes
//   pm2 save                           persist for auto-start at logon

module.exports = {
  apps: [
    {
      name: 'telebot-shop',
      script: 'src/index.js',
      cwd: __dirname,

      // Exactly one instance, always. Telegram long polling allows a single
      // getUpdates consumer per token — a second instance causes 409 conflicts.
      instances: 1,
      exec_mode: 'fork',

      autorestart: true,
      // Back off instead of hammering Telegram/Cryptomus in a crash loop.
      exp_backoff_restart_delay: 2000,
      max_restarts: 20,
      min_uptime: '30s',
      max_memory_restart: '500M',

      env: {
        // Deliberately NOT 'production': src/web/auth.js sets the admin session
        // cookie to secure-only when isProd, which would break login on plain
        // http://localhost. Everything else reads config from .env.
        NODE_ENV: 'development',
        LOG_LEVEL: 'info',
      },

      error_file: 'logs/error.log',
      out_file: 'logs/out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
