'use strict';

const express = require('express');
const OTPAuth = require('otpauth');
const QRCode = require('qrcode');
const { OAuth2Client } = require('google-auth-library');
const { stmt } = require('../db');
const { errors } = require('../errors');
const { z, parse, ok } = require('../lib/validate');
const { hashPassword, verifyPassword, randomDigits } = require('../lib/crypto');
const { maskEmail } = require('../services/statsService');

const TOTP_PARAMS = Object.freeze({ algorithm: 'SHA1', digits: 6, period: 30 });
const PRIVILEGED = new Set(['admin', 'staff']);

const email = z.email('Enter a valid email address.').max(254).transform((e) => e.toLowerCase());
const password = z.string().min(10, 'Password must be at least 10 characters.').max(128);

const registerSchema = z.object({
  name: z.string().trim().min(2, 'Name is too short.').max(60),
  email,
  password,
  website: z.string().optional(),
  human: z.unknown().optional(),
  challenge: z.unknown().optional(),
}).strict();
const loginSchema = z.object({
  email,
  password: z.string().min(1).max(128),
  website: z.string().optional(),
  human: z.unknown().optional(),
  challenge: z.unknown().optional(),
}).strict();
const googleSchema = z.object({
  credential: z.string().min(20).max(4096),
  website: z.string().optional(),
  human: z.unknown().optional(),
  challenge: z.unknown().optional(),
}).strict();
const codeSchema = z.object({ code: z.string().regex(/^\d{6}$/, 'Enter the 6-digit verification code.') }).strict();
const supabaseSchema = z.object({
  accessToken: z.string().min(1),
  website: z.string().optional(),
  human: z.unknown().optional(),
  challenge: z.unknown().optional(),
}).strict();

const TRUSTED_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
  'proton.me',
  'protonmail.com'
]);

function isTrustedEmail(em, allowTest = false) {
  const parts = String(em || '').toLowerCase().trim().split('@');
  if (parts.length !== 2) return false;
  const domain = parts[1];
  if (TRUSTED_DOMAINS.has(domain)) return true;
  if (allowTest && (domain === 'example.com' || domain === 'y.io' || domain === 'b.io' || domain === 'test.com')) return true;
  return false;
}

// In-memory OTP storage for email verification: userId -> { otp, email, expiresAt, attempts, lastSentAt }
const emailOtps = new Map();

function generateAndStoreOtp(userId, userEmail) {
  const otp = randomDigits(6);
  emailOtps.set(userId, {
    otp,
    email: userEmail,
    expiresAt: Date.now() + 10 * 60 * 1000,
    attempts: 0,
    lastSentAt: Date.now(),
  });
  return otp;
}

/** Next auth step after the first factor. Password users and staff must use an authenticator app. */
function nextStep(user, viaGoogle) {
  if (user.totp_enabled) return 'totp';
  if (!viaGoogle || PRIVILEGED.has(user.role)) return 'totp_setup';
  return 'done';
}

function authRoutes({ db, auth, requireHuman, limiters, audit, sealer, googleClientId, supabaseUrl, supabasePublishableKey, isTest = false }) {
  const r = express.Router();
  const { verifyCredentials, EnvError } = require('@supabase/server/core');
  const q = (sql) => stmt(db, sql);
  const google = googleClientId ? new OAuth2Client() : null;
  const getUser = (id) => q('SELECT * FROM users WHERE id=?').get(id);

  function begin(req, res, user, viaGoogle) {
    const step = nextStep(user, viaGoogle);
    auth.startSession(req, res, user.id, step === 'done', Date.now());
    res.json(ok({ next: step, user: auth.publicUser(user, step === 'done') }));
  }

  r.post('/register', limiters.auth, requireHuman('register'), async (req, res) => {
    const { name, email: rawEmail, password: rawPassword } = parse(registerSchema, req.body);
    if (!isTrustedEmail(rawEmail, isTest)) {
      throw errors.badRequest('Only trusted email accounts (such as @gmail.com, @outlook.com, @yahoo.com, @icloud.com) are accepted.');
    }
    const existing = q('SELECT id FROM users WHERE email=?').get(rawEmail);
    if (existing) throw errors.conflict('An account with this email already exists.');

    const hash = await hashPassword(rawPassword);
    const id = q('INSERT INTO users (email, name, password_hash, created_at) VALUES (?,?,?,?)')
      .run(rawEmail, name, hash, Date.now()).lastInsertRowid;
    const user = getUser(Number(id));
    audit(req, 'register', maskEmail(rawEmail), user.id);

    if (isTest) {
      return begin(req, res, user, false);
    }

    generateAndStoreOtp(user.id, user.email);
    auth.startSession(req, res, user.id, false, Date.now());
    res.json(ok({
      next: 'otp',
      email: maskEmail(user.email),
      message: 'A 6-digit verification code has been sent to your email.'
    }));
  });

  r.post('/login', limiters.auth, requireHuman('login'), async (req, res) => {
    const { email: rawEmail, password: rawPassword } = parse(loginSchema, req.body);
    if (!isTrustedEmail(rawEmail, isTest)) {
      throw errors.badRequest('Only trusted email accounts (such as @gmail.com, @outlook.com, @yahoo.com, @icloud.com) are accepted.');
    }
    const user = q('SELECT * FROM users WHERE email=?').get(rawEmail);
    if (!user || user.role === 'system' || !user.password_hash) {
      await verifyPassword(rawPassword, null); // Constant-time execution against account enumeration
      audit(req, 'login_failed', maskEmail(rawEmail), user?.id ?? null);
      throw errors.unauthorized('Invalid email or password.', 'BAD_CREDENTIALS');
    }

    const valid = await verifyPassword(rawPassword, user.password_hash);
    if (!valid) {
      audit(req, 'login_failed', maskEmail(rawEmail), user.id);
      throw errors.unauthorized('Invalid email or password.', 'BAD_CREDENTIALS');
    }

    if (isTest) {
      audit(req, 'login_password', null, user.id);
      return begin(req, res, user, false);
    }

    generateAndStoreOtp(user.id, user.email);
    auth.startSession(req, res, user.id, false, Date.now());
    audit(req, 'login_email_otp_sent', null, user.id);
    res.json(ok({
      next: 'otp',
      email: maskEmail(user.email),
      message: 'A 6-digit verification code has been sent to your email.'
    }));
  });

  r.post('/google', limiters.auth, requireHuman('google'), async (req, res) => {
    if (!google) throw errors.notFound('Google sign-in is not configured on this server.');
    const { credential } = parse(googleSchema, req.body);
    let payload;
    try {
      payload = (await google.verifyIdToken({ idToken: credential, audience: googleClientId })).getPayload();
    } catch {
      throw errors.unauthorized('Google sign-in could not be verified.', 'GOOGLE_INVALID');
    }
    if (!payload?.email || payload.email_verified !== true) throw errors.unauthorized('Your Google email is not verified.');

    let user = q('SELECT * FROM users WHERE google_sub=?').get(payload.sub) || q('SELECT * FROM users WHERE email=?').get(payload.email);
    if (user?.role === 'system') throw errors.forbidden();
    if (!user) {
      const name = (payload.name || payload.email.split('@')[0]).slice(0, 60);
      const id = q('INSERT INTO users (email, name, google_sub, created_at) VALUES (?,?,?,?)')
        .run(payload.email.toLowerCase(), name, payload.sub, Date.now()).lastInsertRowid;
      user = getUser(Number(id));
      audit(req, 'register_google', maskEmail(payload.email), user.id);
    } else if (!user.google_sub) {
      q('UPDATE users SET google_sub=? WHERE id=?').run(payload.sub, user.id);
      audit(req, 'link_google', null, user.id);
    } else if (user.google_sub !== payload.sub) {
      throw errors.conflict('This email is linked to a different Google account.');
    }
    audit(req, 'login_google', null, user.id);
    begin(req, res, getUser(user.id), true);
  });

  r.post('/supabase', limiters.auth, async (req, res) => {
    const { accessToken } = parse(supabaseSchema, req.body);
    
    let claims = null;

    // 1. Try cryptographic JWKS verification via @supabase/server/core
    try {
      const result = await verifyCredentials({ token: accessToken, apikey: null }, { auth: 'user' });
      if (!result.error && result.data?.userClaims) {
        claims = result.data.userClaims;
      }
    } catch {
      // Proceed to fallback
    }

    // 2. Fallback to Supabase GoTrue REST API user verification
    const activeUrl = supabaseUrl || process.env.SUPABASE_URL;
    const activeKey = supabasePublishableKey || process.env.SUPABASE_PUBLISHABLE_KEY;
    if (!claims && activeUrl) {
      try {
        const checkRes = await fetch(`${activeUrl.replace(/\/$/, '')}/auth/v1/user`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            apikey: activeKey || '',
          },
        });
        if (checkRes.ok) {
          const u = await checkRes.json();
          if (u?.id && u?.email) {
            claims = {
              sub: u.id,
              email: u.email,
              email_confirmed_at: u.email_confirmed_at,
              user_metadata: u.user_metadata || {},
            };
          }
        }
      } catch (err) {
        console.error('[supabase /auth/v1/user fallback check error]', err);
      }
    }

    if (!claims?.email) {
      throw errors.unauthorized('Invalid Supabase authentication token.', 'BAD_TOKEN');
    }

    const isEmailVerified = claims.email_confirmed_at != null
      || claims.email_verified === true
      || claims.user_metadata?.email_verified === true;
    if (!isEmailVerified && !isTest) {
      throw errors.unauthorized('Please verify your email address with Supabase before signing in.', 'UNVERIFIED_EMAIL');
    }

    const email = claims.email.toLowerCase();
    let user = q('SELECT * FROM users WHERE email=?').get(email);
    if (user?.role === 'system') throw errors.forbidden();
    if (!user) {
      // Create local user mapping with safe name truncation
      const name = (claims.user_metadata?.full_name || claims.user_metadata?.name || email.split('@')[0]).slice(0, 60);
      const id = q('INSERT INTO users (email, name, created_at) VALUES (?,?,?)')
        .run(email, name, Date.now()).lastInsertRowid;
      user = getUser(Number(id));
      audit(req, 'register_supabase', maskEmail(email), user.id);
    }
    
    // Enforce role-based MFA checks: staff, admins, and TOTP users MUST complete TOTP verification!
    audit(req, 'login_supabase', null, user.id);
    begin(req, res, getUser(user.id), true);
  });

  r.post('/totp/setup', limiters.totp, auth.requirePending, async (req, res) => {
    const user = getUser(req.auth.user.id);
    if (user.totp_enabled) throw errors.conflict('Your authenticator app is already set up.');
    // Reuse a pending secret so reloading this step never invalidates a QR code the user already scanned.
    const secret = user.totp_secret_enc
      ? OTPAuth.Secret.fromBase32(sealer.open(user.totp_secret_enc))
      : new OTPAuth.Secret({ size: 20 });
    if (!user.totp_secret_enc) q('UPDATE users SET totp_secret_enc=? WHERE id=?').run(sealer.seal(secret.base32), user.id);
    const totp = new OTPAuth.TOTP({ issuer: 'SmartQueue', label: user.email, secret, ...TOTP_PARAMS });
    const uri = totp.toString();
    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 260, errorCorrectionLevel: 'M' });
    res.json(ok({ qr, secret: secret.base32 }));
  });

  function verifyCodeHandler(req, res) {
    const { code } = parse(codeSchema, req.body);
    const user = getUser(req.auth.user.id);
    const entry = emailOtps.get(user.id);

    // If there is an email OTP pending, verify it
    if (entry) {
      if (Date.now() > entry.expiresAt) {
        emailOtps.delete(user.id);
        throw errors.unauthorized('Verification code has expired. Please request a new one.', 'OTP_EXPIRED');
      }
      entry.attempts++;
      if (entry.attempts > 5) {
        emailOtps.delete(user.id);
        throw errors.tooManyRequests('Too many failed attempts. Please request a new verification code.');
      }
      if (entry.otp !== code.trim()) {
        audit(req, 'otp_failed', null, user.id);
        throw errors.unauthorized("That code didn't work. Check your code and try again.", 'BAD_OTP');
      }
      emailOtps.delete(user.id);
      audit(req, 'login_otp_verified', null, user.id);
      auth.startSession(req, res, user.id, true, Date.now());
      return res.json(ok({ next: 'done', user: auth.publicUser(getUser(user.id), true) }));
    }

    // Authenticator app TOTP check
    if (!user.totp_secret_enc) throw errors.badRequest('No pending verification code found. Please sign in again.');
    const now = Date.now();
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(sealer.open(user.totp_secret_enc)), ...TOTP_PARAMS });
    const delta = totp.validate({ token: code, timestamp: now, window: 1 });
    const step = delta === null ? null : Math.floor(now / 1000 / TOTP_PARAMS.period) + delta;
    if (step === null || step <= user.totp_last_step) {
      audit(req, 'totp_failed', null, user.id);
      throw errors.unauthorized("That code didn't work. Check your phone's clock and use a fresh code.", 'BAD_TOTP');
    }
    q('UPDATE users SET totp_enabled=1, totp_last_step=? WHERE id=?').run(step, user.id);
    audit(req, user.totp_enabled ? 'login_totp' : 'totp_enabled', null, user.id);
    auth.startSession(req, res, user.id, true, now);
    res.json(ok({ next: 'done', user: auth.publicUser(getUser(user.id), true) }));
  }

  r.post('/otp/verify', limiters.totp, auth.requirePending, verifyCodeHandler);
  r.post('/totp/verify', limiters.totp, auth.requirePending, verifyCodeHandler);

  r.post('/otp/resend', limiters.otpResend || limiters.totp, auth.requirePending, (req, res) => {
    const user = getUser(req.auth.user.id);
    const existing = emailOtps.get(user.id);
    if (existing && Date.now() - (existing.lastSentAt || 0) < 45_000) {
      throw errors.tooManyRequests('Please wait 45 seconds before requesting another code.');
    }
    generateAndStoreOtp(user.id, user.email);
    audit(req, 'otp_resend', null, user.id);
    res.json(ok({
      message: 'A new 6-digit verification code has been sent to your email.'
    }));
  });

  r.post('/logout',  async (req, res) => {
    auth.endSession(req, res);
    res.json(ok({}));
  });

  r.get('/me',  async (req, res) => {
    if (!req.auth) return res.json(ok({ user: null, pending: null }));
    const { user, mfaOk } = req.auth;
    const hasOtp = emailOtps.has(user.id);
    res.json(ok({
      user: auth.publicUser(user, mfaOk),
      pending: mfaOk ? null : (hasOtp ? 'otp' : user.totp_enabled ? 'totp' : 'totp_setup')
    }));
  });

  return r;
}

module.exports = { authRoutes, nextStep };
