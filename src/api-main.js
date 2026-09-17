import { Application } from './application.js';

// HTTP only: message submission, listing and retry, no Worker — never claims a message. See
// Application's "role" doc for what this changes (nothing about readiness/stats, which were
// already DB-backed; adds the worker_heartbeat presence signal).
await Application.fromEnv({ role: 'api' }).start();
