'use strict';

const P = require('../policy');
const { stmt } = require('../db');
const { errors } = require('../errors');
const { randomToken, sha256 } = require('../lib/crypto');

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      // malformed cookie value — ignore it rather than failing the request
    }
  }
  return out;
}

function cookieString(name, value, { maxAgeSec, secure }) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`,
    maxAgeSec === 0 ? 'Expires=Thu, 01 Jan 1970 00:00:00 GMT' : null,
    secure ? 'Secure' : null,
  ].filter(Boolean).join('; ');
}

/**
 * Opaque server-side sessions. The cookie holds a random 256-bit id; the DB
 * stores only its SHA-256, so a leaked DB cannot be replayed as cookies.
 * Sessions start "pending" (mfa_ok=0) until the second factor passes.
 */
function createAuth({ db, secure }) {
  const COOKIE = secure ? '__Host-sq_sid' : 'sq_sid';
  const q = (sql) => stmt(db, sql);

  const USER_COLS = `u.id, u.email, u.name, u.role, u.totp_enabled, u.google_sub,
    u.password_hash IS NOT NULL AS has_password, u.strikes, u.blocked_until, u.org_id`;

  function loadSession(req, _res, next) {
    req.auth = null;
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    if (sid && sid.length >= 32 && sid.length <= 64) {
      const idHash = sha256(sid);
      const row = q(
        `SELECT s.id_hash, s.mfa_ok, ${USER_COLS} FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id_hash = ? AND s.expires_at > ?`,
      ).get(idHash, Date.now());
      if (row) {
        const { id_hash: sidHash, mfa_ok: mfaOk, ...user } = row;
        req.auth = { sidHash, mfaOk: mfaOk === 1, user };
      }
    }
    next();
  }

  function startSession(req, res, userId, mfaOk, now) {
    if (req.auth) q('DELETE FROM sessions WHERE id_hash=?').run(req.auth.sidHash);
    const sid = randomToken(32);
    q('INSERT INTO sessions (id_hash, user_id, mfa_ok, created_at, expires_at) VALUES (?,?,?,?,?)').run(
      sha256(sid),
      userId,
      mfaOk ? 1 : 0,
      now,
      now + P.SESSION_TTL_MS,
    );
    res.append('Set-Cookie', cookieString(COOKIE, sid, { maxAgeSec: Math.floor(P.SESSION_TTL_MS / 1000), secure }));
  }

  function endSession(req, res) {
    if (req.auth) q('DELETE FROM sessions WHERE id_hash=?').run(req.auth.sidHash);
    res.append('Set-Cookie', cookieString(COOKIE, '', { maxAgeSec: 0, secure }));
  }

  const purgeExpired = (now) => q('DELETE FROM sessions WHERE expires_at <= ?').run(now);

  function requireUser(req, _res, next) {
    if (!req.auth) throw errors.unauthorized();
    if (!req.auth.mfaOk) throw errors.unauthorized('Finish verifying with your authenticator app.', 'MFA_REQUIRED');
    next();
  }

  function requirePending(req, _res, next) {
    if (!req.auth) throw errors.unauthorized();
    next();
  }

  const requireRole = (...roles) => (req, res, next) =>
    requireUser(req, res, () => {
      if (!roles.includes(req.auth.user.role)) throw errors.forbidden();
      next();
    });

  function publicUser(user, mfaOk) {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      totpEnabled: user.totp_enabled === 1,
      hasGoogle: Boolean(user.google_sub),
      hasPassword: Boolean(user.has_password ?? user.password_hash),
      verified: Boolean(mfaOk),
      strikes: user.strikes,
      blockedUntil: user.blocked_until,
      orgId: user.org_id ?? null,
    };
  }

  return Object.freeze({ loadSession, startSession, endSession, purgeExpired, requireUser, requirePending, requireRole, publicUser });
}

module.exports = { createAuth, parseCookies, cookieString };
