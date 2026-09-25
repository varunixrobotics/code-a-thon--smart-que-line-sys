'use strict';

const config = require('./config');
const P = require('./policy');
const { openDb } = require('./db');
const { createApp } = require('./app');
const { seedOrganisations, ensureSystemUser, ensureAdmin } = require('./seed');
const { startDemoSimulator } = require('./demo');

async function main() {
  const db = openDb(config.DB_FILE);
  if (seedOrganisations(db)) console.log('[seed] Sample organisations created.');
  const systemUserId = ensureSystemUser(db);
  const admin = await ensureAdmin(db, { email: config.ADMIN_EMAIL, password: config.ADMIN_PASSWORD, isProd: config.IS_PROD });
  if (admin?.password) {
    console.log('\n[seed] Admin account created (shown once — change it or set ADMIN_EMAIL/ADMIN_PASSWORD):');
    console.log(`       email:    ${admin.email}\n       password: ${admin.password}\n`);
  }

  const { app, services, auth } = createApp({ db, config });

  const monitor = setInterval(() => {
    try {
      services.presence.runMonitor(Date.now());
      auth.purgeExpired(Date.now());
    } catch (err) {
      console.error('[monitor] run failed', err);
    }
  }, P.MONITOR_INTERVAL_MS);
  const stopDemo = config.DEMO_MODE ? startDemoSimulator({ db, services, systemUserId }) : () => {};

  const server = app.listen(config.PORT, '0.0.0.0', () => {
    console.log(`SmartQueue running at http://localhost:${config.PORT}`);
    if (!config.GOOGLE_CLIENT_ID) console.log('Google sign-in disabled (set GOOGLE_CLIENT_ID to enable). Authenticator-app sign-in is active.');
    if (config.DEMO_MODE) console.log('Demo traffic simulator is ON (DEMO_MODE=0 to disable).');
  });

  const shutdown = (signal) => {
    console.log(`\n${signal} received — shutting down.`);
    clearInterval(monitor);
    stopDemo();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    server.closeAllConnections?.();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
