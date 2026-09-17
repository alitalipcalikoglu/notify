// PM2 process file for this service. CommonJS on purpose: PM2 loads config files with require().
//   pm2 start ecosystem.config.cjs
//   pm2 save && pm2 startup     # persist across reboots
// Environment comes from ./.env via Node's --env-file, so secrets never sit in this file.
const path = require('node:path');

// kill_timeout must safely exceed the internal force-exit timer (`LOCK_TTL_MS + 10s`,
// application.js), which is itself bounded by LOCK_TTL_MS's own config-validation ceiling
// (600_000ms, config.js) — this file is loaded by PM2 with plain require(), before .env is ever
// read, so it cannot see the operator's actual LOCK_TTL_MS; it has to assume the worst case that
// config validation still allows. 630_000 = 600_000 + 10_000 (the force-exit margin) + 20_000
// (drain/flush/close headroom on top of the force-exit timer itself). Note this is now a ceiling,
// not a sizing to SMTP/webhook worst-case timeouts directly — the heartbeat (HEARTBEAT_MS)
// protects a long send regardless of how LOCK_TTL_MS itself is set; see README's "Clock model".
const KILL_TIMEOUT_MS = 630_000;

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
                                     // (up to LOCK_TTL_MS) → close channels → flush audit → close DB
                                     // → exit (internal force-exit at LOCK_TTL_MS + 10s)
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
