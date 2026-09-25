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
let initError = null;

function getVercelOrigin(req) {
  // Reconstruct origin from Host header (Vercel provides x-forwarded-host or host)
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  const proto = req.headers['x-forwarded-proto'] || 'https';
  return host ? `${proto}://${host.split(',')[0].trim()}` : '';
}

function getApp(req) {
  if (initError) throw initError;
  if (appInstance) return appInstance;

  try {
    const db = openDb(config.DB_FILE);
    seedOrganisations(db);
    ensureSystemUser(db);

    // Derive PUBLIC_ORIGIN from the first real request if not explicitly set via env
    const origin = config.PUBLIC_ORIGIN || getVercelOrigin(req);

    const { app } = createApp({
      db,
      config: Object.freeze({ ...config, PUBLIC_ORIGIN: origin }),
    });
    appInstance = app;
    return app;
  } catch (err) {
    initError = err;
    throw err;
  }
}

module.exports = (req, res) => {
  // Strip the /api prefix that Vercel routes prepend so Express sees /auth/..., /config, etc.
  const originalUrl = req.url || '/';
  req.url = originalUrl.replace(/^\/api/, '') || '/';

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
        message: 'The server is temporarily unavailable. Please try again shortly.',
      },
    });
  }
};
