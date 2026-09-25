'use strict';

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const ROOT_DIR = path.resolve(__dirname, '..');
const IS_PROD = process.env.NODE_ENV === 'production';
const IS_VERCEL = Boolean(process.env.VERCEL);
const DATA_DIR = process.env.DATA_DIR 
  ? path.resolve(process.env.DATA_DIR) 
  : (IS_VERCEL ? path.join('/tmp', 'data') : path.join(ROOT_DIR, 'data'));

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${name} must be an integer`);
  return n;
}

/** Secret used for HMAC signing and encrypting TOTP secrets at rest. */
function resolveAppSecret() {
  const fromEnv = process.env.APP_SECRET;
  if (fromEnv && fromEnv.length >= 32) return fromEnv;
  if (IS_PROD && !IS_VERCEL) throw new Error('APP_SECRET (at least 32 characters) is required in production');
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const file = path.join(DATA_DIR, '.app-secret');
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
    const secret = crypto.randomBytes(48).toString('base64url');
    fs.writeFileSync(file, secret, { mode: 0o600 });
    return secret;
  } catch {
    return crypto.randomBytes(48).toString('base64url');
  }
}

const supabaseUrl = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://muoqwywbnklxquwnseao.supabase.co').trim();
const supabasePublishableKey = (
  process.env.SUPABASE_PUBLISHABLE_KEY || 
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || 
  process.env.SUPABASE_ANON_KEY || 
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || 
  'sb_publishable_q714PtFe6DYJ2qy64g5X1Q_ndbnsQPZ'
).trim();
const supabaseSecretKey = (process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const supabaseJwksUrl = (process.env.SUPABASE_JWKS_URL || (supabaseUrl ? `${supabaseUrl}/auth/v1/.well-known/jwks.json` : '')).trim();

// Ensure process.env has them set so @supabase/server/core finds them
if (!process.env.SUPABASE_URL && supabaseUrl) process.env.SUPABASE_URL = supabaseUrl;
if (!process.env.SUPABASE_PUBLISHABLE_KEY && supabasePublishableKey) process.env.SUPABASE_PUBLISHABLE_KEY = supabasePublishableKey;
if (!process.env.SUPABASE_JWKS_URL && supabaseJwksUrl) process.env.SUPABASE_JWKS_URL = supabaseJwksUrl;

module.exports = Object.freeze({
  ROOT_DIR,
  DATA_DIR,
  IS_PROD,
  IS_VERCEL,
  PORT: intEnv('PORT', 3000),
  DB_FILE: process.env.DB_FILE || path.join(DATA_DIR, 'queue.db'),
  APP_SECRET: resolveAppSecret(),
  GOOGLE_CLIENT_ID: (process.env.GOOGLE_CLIENT_ID || '').trim(),
  ADMIN_EMAIL: (process.env.ADMIN_EMAIL || '').trim(),
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',
  TRUST_PROXY: process.env.TRUST_PROXY === '1' || IS_VERCEL,
  SUPABASE_URL: supabaseUrl,
  SUPABASE_PUBLISHABLE_KEY: supabasePublishableKey,
  SUPABASE_SECRET_KEY: supabaseSecretKey,
  SUPABASE_JWKS_URL: supabaseJwksUrl,
  PUBLIC_ORIGIN: (process.env.PUBLIC_ORIGIN || '').trim().replace(/\/$/, ''),
  DEMO_MODE: process.env.DEMO_MODE ? process.env.DEMO_MODE === '1' : (!IS_PROD && !IS_VERCEL),
});
