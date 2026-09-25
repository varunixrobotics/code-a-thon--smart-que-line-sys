'use strict';

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { AppError, errors } = require('../errors');
const { stmt } = require('../db');

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF defence in depth (cookies are already SameSite=Strict):
 *  - state-changing requests must be JSON (HTML forms cannot send JSON cross-site
 *    without a CORS preflight, which we never grant);
 *  - Origin / Sec-Fetch-Site must be same-origin.
 */
function createSameOriginGuard(publicOrigin) {
  return function sameOriginGuard(req, _res, next) {
    if (!MUTATING.has(req.method)) return next();
    if (!(req.headers['content-type'] || '').startsWith('application/json')) {
      throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Requests must be JSON.');
    }
    const origin = req.headers.origin;
    // The effective origin to match against: explicit env var > request-derived (Vercel) > null
    const effectiveOrigin = publicOrigin || req._derivedOrigin || null;
    if (origin) {
      let allowed = false;
      try {
        if (effectiveOrigin) {
          allowed = origin === effectiveOrigin;
        } else {
          // Fallback: compare parsed host headers
          const originHost = new URL(origin).host;
          const reqHost = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
          allowed = originHost === reqHost;
        }
      } catch {
        allowed = false;
      }
      if (!allowed) throw errors.forbidden('Cross-site request blocked.', 'CSRF');
    } else {
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') throw errors.forbidden('Cross-site request blocked.', 'CSRF');
    }
    next();
  };
}

function createCorsGuard(publicOrigin) {
  return function corsGuard(req, res, next) {
    const origin = req.headers.origin;
    if (!origin) return next();

    let allowed = false;
    try {
      if (publicOrigin) {
        allowed = origin === publicOrigin;
      } else {
        // When no PUBLIC_ORIGIN set (Vercel dynamic URLs), compare origin host to request host
        const originHost = new URL(origin).host;
        const reqHost = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
        allowed = originHost === reqHost;
      }
    } catch {
      allowed = false;
    }

    if (allowed) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
      res.setHeader('Vary', 'Origin');
    }

    if (req.method === 'OPTIONS') {
      if (!allowed) {
        return res.status(403).json({ success: false, data: null, error: { code: 'FORBIDDEN', message: 'CORS request blocked.' } });
      }
      return res.status(204).end();
    }
    next();
  };
}

function limiter(windowMs, limit, message, keyGenerator, auditFn = null, actionName = 'rate_limit') {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ...(keyGenerator ? { keyGenerator } : {}),
    handler: (req, res) => {
      if (auditFn) {
        try {
          auditFn(req, `${actionName}_exceeded`, `${req.method} ${req.originalUrl}`);
        } catch {
          // ignore audit write failure
        }
      }
      return res.status(429).json({ success: false, data: null, error: { code: 'RATE_LIMITED', message } });
    },
  });
}

const byUser = (req) => (req.auth?.user?.id ? `u:${req.auth.user.id}` : `ip:${ipKeyGenerator(req)}`);

function createLimiters(audit = null) {
  return Object.freeze({
    api: limiter(60_000, 240, 'Too many requests. Please slow down.', null, audit, 'api_rate_limit'),
    auth: limiter(15 * 60_000, 20, 'Too many sign-in attempts. Try again in 15 minutes.', null, audit, 'auth_rate_limit'),
    totp: limiter(5 * 60_000, 10, 'Too many code attempts. Wait 5 minutes and try again.', byUser, audit, 'totp_rate_limit'),
    otpResend: limiter(10 * 60_000, 5, 'Too many verification code requests. Wait 10 minutes and try again.', byUser, audit, 'otp_resend_rate_limit'),
    booking: limiter(10 * 60_000, 20, 'Too many booking changes. Try again in a few minutes.', byUser, audit, 'booking_rate_limit'),
    location: limiter(60_000, 12, 'Location updates are too frequent.', byUser, audit, 'location_rate_limit'),
    admin: limiter(60_000, 60, 'Too many administrative requests. Please slow down.', byUser, audit, 'admin_rate_limit'),
  });
}

function createAudit(db) {
  return function audit(req, action, detail = null, userId = req.auth?.user?.id ?? null) {
    try {
      stmt(db, 'INSERT INTO audit_log (user_id, action, detail, ip, created_at) VALUES (?,?,?,?,?)').run(
        userId,
        String(action).slice(0, 80),
        detail === null ? null : String(detail).slice(0, 300),
        (req?.ip ? String(req.ip).slice(0, 45) : null),
        Date.now(),
      );
    } catch (err) {
      console.error('[audit] failed to record audit entry:', err.message);
    }
  };
}

module.exports = { createSameOriginGuard, createCorsGuard, createLimiters, createAudit };
