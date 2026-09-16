// PM2 process file for this service. CommonJS on purpose: PM2 loads config files with require().
//   pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup     # persist across reboots
// Environment comes from ./.env via Node's --env-file, so secrets never sit in this file.
const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'notify',
      cwd: __dirname,
      script: 'src/index.js',
      node_args: ['--disable-warning=ExperimentalWarning', `--env-file=${path.join(__dirname, '.env')}`],
      exec_mode: 'fork',
      instances: 1,             // one process per SQLite file; the delivery worker runs in-process
      autorestart: true,
      exp_backoff_restart_delay: 200,
      max_restarts: 20,
      max_memory_restart: '300M',
      wait_ready: true,         // process.send('ready') after listen()
      listen_timeout: 10000,
      kill_timeout: 60000,      // SIGTERM → drain in-flight deliveries (SMTP socket timeout is 30s) → exit
      merge_logs: true,
      env: { NODE_ENV: 'production' },
    },
  ],
};
