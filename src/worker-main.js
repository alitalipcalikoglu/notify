import { Application } from './application.js';

// Worker only: no HTTP listener at all, not even for health checks — PM2's own process state is
// the liveness signal for this role. See Application's "role" doc.
await Application.fromEnv({ role: 'worker' }).start();
