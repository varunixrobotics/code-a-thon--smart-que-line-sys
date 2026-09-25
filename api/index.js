'use strict';

/**
 * Vercel Serverless Entrypoint for SmartQueue
 *
 * On Vercel, `node:sqlite` (DatabaseSync) is available from Node 22.5+.
 * We pin to Node 22 via vercel.json.
 * 
 * The PUBLIC_ORIGIN is set dynamically from the Vercel host header so that
 * createSameOriginGuard and createCorsGuard always match the actual deployment URL.
 */

const config = require('../server/config');
const { openDb } = require('../server/db');
const { createApp } = require('../server/app');
const { seedOrganisations, ensureSystemUser } = require('../server/seed');

let appInstance = null;

function getVercelOrigin(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return host ? `${proto}://${host.split(',')[0].trim()}` : '';
}

function getApp(req) {
  if (appInstance) return appInstance;

  const dbPath = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
    ? '/tmp/queue.db'
    : (config.DB_FILE || ':memory:');

  const db = openDb(dbPath);

  try {
    seedOrganisations(db);
  } catch (seedErr) {
    console.warn('[seed] seedOrganisations non-fatal error:', seedErr.message);
  }

  try {
    ensureSystemUser(db);
  } catch (userErr) {
    console.warn('[seed] ensureSystemUser non-fatal error:', userErr.message);
  }

  const origin = config.PUBLIC_ORIGIN || getVercelOrigin(req);

  const { app } = createApp({
    db,
    config: Object.freeze({ ...config, PUBLIC_ORIGIN: origin }),
  });

  appInstance = app;
  return app;
}

module.exports = (req, res) => {
  // Ensure the request URL starts with /api so Express routes it to the /api router
  const originalUrl = req.url || '/';
  if (!originalUrl.startsWith('/api')) {
    req.url = '/api' + (originalUrl.startsWith('/') ? originalUrl : '/' + originalUrl);
  }

  try {
    const app = getApp(req);
    return app(req, res);
  } catch (err) {
    console.error('[vercel handler] startup failed:', err);
    res.status(503).json({
      success: false,
      data: null,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: `The server is temporarily unavailable: ${err.message || 'initialization error'}`,
      },
    });
  }
};
