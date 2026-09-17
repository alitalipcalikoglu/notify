// PM2 process file for this service. CommonJS on purpose: PM2 loads config files with require().
//   pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup     # persist across reboots
// Environment comes from ./.env via Node's --env-file, so secrets never sit in this file.
const path = require('node:path');

// kill_timeout must safely exceed the internal force-exit timer, which (Stage 6.1 fix) is now
// `max(SMTP_WORST_CASE_MS=50_000, WEBHOOK_TIMEOUT_MS) + 10_000` — the worst-case CALL duration,
// not LOCK_TTL_MS (the lease TTL; the heartbeat decouples how long a call may run from how long
// its lease lasts without one, so sizing shutdown timers off the lease TTL was itself a bug fixed
// in Stage 6.1 — see application.js). WEBHOOK_TIMEOUT_MS's own ceiling is 120_000ms (config.js),
// so the worst case here is max(50_000, 120_000) + 10_000 = 130_000. This file is loaded by PM2
// with plain require(), before .env is ever read, so it cannot see the operator's actual
// WEBHOOK_TIMEOUT_MS; it has to assume the worst case that config validation still allows.
// 150_000 = 130_000 + 20_000 (drain/flush/close headroom on top of the force-exit timer itself).
const KILL_TIMEOUT_MS = 150_000;

module.exports = {
  apps: [
    {
      name: 'notify',
      cwd: __dirname,
      script: 'src/index.js',
      node_args: ['--disable-warning=ExperimentalWarning', `--env-file=${path.join(__dirname, '.env')}`],
      exec_mode: 'fork',
      instances: 1,             // one process per SQLite file; combined API+worker runtime (default)
      autorestart: true,
      exp_backoff_restart_delay: 200,
      max_restarts: 20,
      max_memory_restart: '300M',
      wait_ready: true,         // process.send('ready') after listen() (or, worker-only, after start())
      listen_timeout: 10000,
      kill_timeout: KILL_TIMEOUT_MS, // SIGTERM → stop claiming → stop HTTP intake → drain in-flight
                                     // (up to the worst-case call duration) → close channels →
                                     // flush audit → close DB → exit (internal force-exit at
                                     // max(50_000, WEBHOOK_TIMEOUT_MS) + 10s)
      merge_logs: true,
      env: { NODE_ENV: 'production' },
    },

    // ---- Split deployment (Stage 6), disabled by default -----------------------------------
    // Two processes instead of one: an API replica takes HTTP traffic without ever claiming a
    // message, and a worker replica claims and sends messages without listening on a port. Both
    // share the same DB_PATH and the same Config. To use this topology instead of the combined
    // one: remove the 'notify' app above and uncomment these two.
    //
    // {
    //   name: 'notify-api',
    //   cwd: __dirname,
    //   script: 'src/api-main.js',
    //   node_args: ['--disable-warning=ExperimentalWarning', `--env-file=${path.join(__dirname, '.env')}`],
    //   exec_mode: 'fork',
    //   instances: 1,
    //   autorestart: true,
    //   exp_backoff_restart_delay: 200,
    //   max_restarts: 20,
    //   max_memory_restart: '300M',
    //   wait_ready: true,
    //   listen_timeout: 10000,
    //   kill_timeout: 15000,   // HTTP-only: draining in-flight requests is fast, no send in progress here
    //   merge_logs: true,
    //   env: { NODE_ENV: 'production' },
    // },
    // {
    //   name: 'notify-worker',
    //   cwd: __dirname,
    //   script: 'src/worker-main.js',
    //   node_args: ['--disable-warning=ExperimentalWarning', `--env-file=${path.join(__dirname, '.env')}`],
    //   exec_mode: 'fork',
    //   instances: 1,          // raise for more than one worker process against the same DB_PATH;
    //                          // the lease model (docs/READINESS.md) makes that safe, not just tolerated
    //   autorestart: true,
    //   exp_backoff_restart_delay: 200,
    //   max_restarts: 20,
    //   max_memory_restart: '300M',
    //   wait_ready: true,      // process.send('ready') right after the worker loop starts, no listen()
    //   kill_timeout: KILL_TIMEOUT_MS,
    //   merge_logs: true,
    //   env: { NODE_ENV: 'production' },
    // },
  ],
};
