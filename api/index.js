'use strict';

const config = require('../server/config');
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');
const { seedOrganisations, ensureSystemUser, ensureAdmin } = require('../server/seed');

let appInstance = null;

function getApp() {
  if (!appInstance) {
    const db = openDb(config.DB_FILE);
    try {
      seedOrganisations(db);
      ensureSystemUser(db);
      ensureAdmin(db, {
        email: config.ADMIN_EMAIL,
        password: config.ADMIN_PASSWORD,
        isProd: config.IS_PROD,
      }).catch((err) => console.error('[seed admin error]', err));
    } catch (err) {
      console.error('[db init error]', err);
    }

    const { app } = createApp({ db, config });
    appInstance = app;
  }
  return appInstance;
}

module.exports = (req, res) => {
  const app = getApp();
  return app(req, res);
};
