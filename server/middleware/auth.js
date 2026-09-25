'use strict';

const P = require('../policy');
const { stmt } = require('../db');
const { errors } = require('../errors');
const { createSigner, randomToken, sha256 } = require('../lib/crypto');

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
    'SameSite=Lax',
    `Max-Age=${maxAgeSec}`,
    maxAgeSec === 0 ? 'Expires=Thu, 01 Jan 1970 00:00:00 GMT' : null,
    secure ? 'Secure' : null,
  ].filter(Boolean).join('; ');
}

function isRequestHttps(req, secure) {
  if (req.secure) return true;
  const proto = (req.headers && (req.headers['x-forwarded-proto'] || '')) || '';
  if (proto.split(',')[0].trim() === 'https') return true;
  const host = (req.headers && req.headers.host) || '';
  if (host.includes('localhost') || host.includes('127.0.0.1')) return false;
  return Boolean(secure);
}

/**
 * Server-side sessions with cryptographic signed fallback for serverless.
 * Sessions store a SHA-256 hash in DB and HMAC signature in the cookie so
 * state is retained seamlessly even across cold serverless containers.
 */
function createAuth({ db, secure, appSecret }) {
  const signer = appSecret ? createSigner(appSecret) : null;
  const q = (sql) => stmt(db, sql);

  const USER_COLS = `u.id, u.email, u.name, u.role, u.totp_enabled, u.google_sub,
    u.password_hash IS NOT NULL AS has_password, u.strikes, u.blocked_until, u.org_id`;

  function loadSession(req, _res, next) {
    req.auth = null;
    const cookies = parseCookies(req.headers.cookie);
    const sidVal = cookies['__Host-sq_sid'] || cookies['sq_sid'];
    if (sidVal && sidVal.length >= 32) {
      const parts = sidVal.split('.');
      const sid = parts[0];
      const idHash = sha256(sid);

      // 1. Check local database first
      const row = q(
        `SELECT s.id_hash, s.mfa_ok, ${USER_COLS} FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id_hash = ? AND s.expires_at > ?`,
      ).get(idHash, Date.now());

      if (row) {
        const { id_hash: sidHash, mfa_ok: mfaOk, ...user } = row;
        req.auth = { sidHash, mfaOk: mfaOk === 1, user };
      } else if (signer && parts.length === 3) {
        // 2. Cryptographic fallback for serverless lambdas that don't share /tmp
        const [, payloadB64, sig] = parts;
        if (signer.verify(`${sid}.${payloadB64}`, sig)) {
          try {
            const data = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
            if (data?.uid && data?.exp > Date.now()) {
              let user = q(`SELECT ${USER_COLS} FROM users u WHERE u.id=?`).get(data.uid);
              if (!user && data.email) {
                try {
                  q('INSERT INTO users (id, email, name, role, created_at) VALUES (?,?,?,?,?)')
                    .run(data.uid, data.email.toLowerCase(), data.name || data.email, data.role || 'user', Date.now());
                  user = q(`SELECT ${USER_COLS} FROM users u WHERE u.id=?`).get(data.uid);
                } catch {
                  user = q(`SELECT ${USER_COLS} FROM users u WHERE u.email=?`).get(data.email.toLowerCase());
                }
              }
              if (user) {
                req.auth = { sidHash: idHash, mfaOk: data.mfa === 1, user };
              }
            }
          } catch {
            // malformed payload
          }
        }
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

    let cookieVal = sid;
    if (signer) {
      const user = q('SELECT id, email, name, role FROM users WHERE id=?').get(userId);
      if (user) {
        const payload = Buffer.from(JSON.stringify({
          uid: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          mfa: mfaOk ? 1 : 0,
          exp: now + P.SESSION_TTL_MS,
        })).toString('base64url');
        const sig = signer.sign(`${sid}.${payload}`);
        cookieVal = `${sid}.${payload}.${sig}`;
      }
    }

    const isHttps = isRequestHttps(req, secure);
    const maxAgeSec = Math.floor(P.SESSION_TTL_MS / 1000);
    res.append('Set-Cookie', cookieString('sq_sid', cookieVal, { maxAgeSec, secure: isHttps }));
    if (isHttps) {
      res.append('Set-Cookie', cookieString('__Host-sq_sid', cookieVal, { maxAgeSec, secure: true }));
    }
  }

  function endSession(req, res) {
    if (req.auth) q('DELETE FROM sessions WHERE id_hash=?').run(req.auth.sidHash);
    const isHttps = isRequestHttps(req, secure);
    res.append('Set-Cookie', cookieString('sq_sid', '', { maxAgeSec: 0, secure: isHttps }));
    res.append('Set-Cookie', cookieString('__Host-sq_sid', '', { maxAgeSec: 0, secure: isHttps }));
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
