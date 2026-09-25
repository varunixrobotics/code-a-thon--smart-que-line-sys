'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb, stmt } = require('../server/db');
const { seedOrganisations } = require('../server/seed');
const { createApp } = require('../server/app');
const { humanTelemetry } = require('./helpers');
const { maskEmail } = require('../server/services/statsService');

const config = Object.freeze({
  IS_PROD: false,
  APP_SECRET: 'test-secret-'.repeat(4),
  GOOGLE_CLIENT_ID: '',
  SUPABASE_URL: 'https://muoqwywbnklxquwnseao.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_q714PtFe6DYJ2qy64g5X1Q_ndbnsQPZ',
  TRUST_PROXY: false,
  PUBLIC_ORIGIN: 'http://127.0.0.1:3000',
  DEMO_MODE: false,
});

let server;
let base;
let db;

test.before(async () => {
  db = openDb(':memory:');
  seedOrganisations(db);
  const { app } = createApp({ db, config });
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

function client() {
  const jar = new Map();
  return async function call(method, path, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    let responseBody = null;
    try {
      responseBody = await res.json();
    } catch {
      // non-JSON response
    }
    return { status: res.status, headers: res.headers, body: responseBody };
  };
}

test('SECURITY: Registration and login responses never leak raw OTP secrets', async () => {
  // Use non-test secret to test production-like behavior
  const prodDb = openDb(':memory:');
  seedOrganisations(prodDb);
  const prodApp = createApp({
    db: prodDb,
    config: {
      IS_PROD: false,
      APP_SECRET: 'a-non-test-super-secret-key-32-chars-long!',
      GOOGLE_CLIENT_ID: '',
      TRUST_PROXY: false,
      PUBLIC_ORIGIN: '',
      DEMO_MODE: false,
    },
  }).app;
  const prodServer = await new Promise((r) => {
    const s = prodApp.listen(0, '127.0.0.1', () => r(s));
  });
  const prodBase = `http://127.0.0.1:${prodServer.address().port}`;

  try {
    const res = await fetch(`${prodBase}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Secure User',
        email: 'secure@gmail.com',
        password: 'a-long-password-123',
        human: humanTelemetry(1),
      }),
    });
    const json = await res.json();
    assert.equal(res.status, 200);
    assert.equal(json.data.otp, undefined, 'Raw OTP must NEVER be leaked in registration response');
    assert.match(json.data.email, /\*{3}@/, 'Email in response must be masked');

    // Attempt login
    const loginRes = await fetch(`${prodBase}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'secure@gmail.com',
        password: 'a-long-password-123',
        human: humanTelemetry(2),
      }),
    });
    const loginJson = await loginRes.json();
    assert.equal(loginRes.status, 200);
    assert.equal(loginJson.data.otp, undefined, 'Raw OTP must NEVER be leaked in login response');
  } finally {
    prodServer.close();
  }
});

test('SECURITY: Invalid credentials on non-existent account consume constant work (no user enumeration)', async () => {
  const call = client();
  const start = Date.now();
  const res = await call('POST', '/api/auth/login', {
    email: 'nonexistent-user-123@gmail.com',
    password: 'wrong-password-attempt',
    human: humanTelemetry(3),
  });
  const elapsed = Date.now() - start;
  assert.equal(res.status, 401);
  assert.equal(res.body.error.code, 'BAD_CREDENTIALS');
  assert.equal(res.body.error.message, 'Invalid email or password.');
  // Scrypt work should be performed, taking non-trivial time (>20ms)
  assert.ok(elapsed >= 20, `Execution took ${elapsed}ms, expected constant-time scrypt delay`);
});

test('SECURITY: Parameter tampering / mass assignment is rejected with 400 Bad Request', async () => {
  const call = client();
  const res = await call('POST', '/api/auth/register', {
    name: 'Attacker',
    email: 'attacker@y.io',
    password: 'password-12345',
    role: 'admin', // Injected unauthorized field
    org_id: 1,     // Injected unauthorized field
    human: humanTelemetry(4),
  });
  assert.equal(res.status, 400, 'Tampered / unexpected fields must be rejected');
});

test('SECURITY: Prototype pollution on admin actions is strictly rejected', async () => {
  const call = client();
  // Register user and promote to admin with verified session
  await call('POST', '/api/auth/register', { name: 'Admin', email: 'admin@y.io', password: 'password-12345', human: humanTelemetry(5) });
  stmt(db, "UPDATE users SET role='admin' WHERE email='admin@y.io'").run();
  stmt(db, "UPDATE sessions SET mfa_ok=1 WHERE user_id=(SELECT id FROM users WHERE email='admin@y.io')").run();

  // Call proto methods
  const res1 = await call('POST', '/api/admin/orgs/1/counters/1/toString', {});
  assert.equal(res1.status, 404);

  const res2 = await call('POST', '/api/admin/orgs/1/counters/1/constructor', {});
  assert.equal(res2.status, 404);

  const res3 = await call('POST', '/api/admin/orgs/1/counters/1/__proto__', {});
  assert.equal(res3.status, 404);
});

test('SECURITY: CORS preflight blocks unauthorized origins without wildcard credentials', async () => {
  // Preflight from unauthorized origin
  const res = await fetch(`${base}/api/bookings`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'https://malicious-attacker.com',
      'Access-Control-Request-Method': 'POST',
    },
  });
  assert.equal(res.status, 403, 'Unauthorized CORS origin must be rejected');
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});

test('SECURITY: Database unique constraint prevents concurrent duplicate live bookings for same place', async () => {
  const call = client();
  await call('POST', '/api/auth/register', { name: 'Dupe Test', email: 'dupe@y.io', password: 'password-12345', human: humanTelemetry(6) });
  const user = stmt(db, "SELECT id FROM users WHERE email='dupe@y.io'").get();

  // First booking in DB
  stmt(db, `
    INSERT INTO bookings (user_id, org_id, service_id, date, slot_index, seat, token_no, token_code, kind, status, created_at)
    VALUES (?, 1, 1, '2026-03-10', 0, 0, 1, 'P-001', 'walkin', 'booked', 1000)
  `).run(user.id);

  // Attempt second concurrent booking for the same user and organisation:
  // Must fail database-level UNIQUE constraint ux_bookings_user_org_live
  assert.throws(() => {
    stmt(db, `
      INSERT INTO bookings (user_id, org_id, service_id, date, slot_index, seat, token_no, token_code, kind, status, created_at)
      VALUES (?, 1, 2, '2026-03-10', 1, 0, 2, 'V-002', 'walkin', 'booked', 1000)
    `).run(user.id);
  }, /UNIQUE constraint failed: bookings\.user_id, bookings\.org_id/);
});

test('SECURITY: Email masking helper never crashes and never leaks full username', () => {
  assert.equal(maskEmail(null), '***');
  assert.equal(maskEmail(undefined), '***');
  assert.equal(maskEmail(''), '***');
  assert.equal(maskEmail('invalid-no-at-sign'), '***');
  assert.equal(maskEmail('a@gmail.com'), 'a***@gmail.com');
  assert.equal(maskEmail('alexander@example.com'), 'al***@example.com');
});

test('SECURITY: OTP resend enforces cooldown and prevents rapid spam', async () => {
  const prodDb = openDb(':memory:');
  seedOrganisations(prodDb);
  const prodApp = createApp({
    db: prodDb,
    config: {
      IS_PROD: false,
      APP_SECRET: 'production-secret-must-be-32-chars-long!',
      GOOGLE_CLIENT_ID: '',
      TRUST_PROXY: false,
      PUBLIC_ORIGIN: '',
      DEMO_MODE: false,
    },
  }).app;
  const prodServer = await new Promise((r) => {
    const s = prodApp.listen(0, '127.0.0.1', () => r(s));
  });
  const prodBase = `http://127.0.0.1:${prodServer.address().port}`;

  try {
    // Register to get a pending session
    const regRes = await fetch(`${prodBase}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Cooldown Tester',
        email: 'cooldown@gmail.com',
        password: 'password-12345',
        human: humanTelemetry(7),
      }),
    });
    const cookie = regRes.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

    // Immediate resend should be blocked by 45s cooldown
    const resendRes = await fetch(`${prodBase}/api/auth/otp/resend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(resendRes.status, 429);
    const json = await resendRes.json();
    assert.match(json.error.message, /wait 45 seconds/i);
  } finally {
    prodServer.close();
  }
});

test('CONFIG: /api/config returns Supabase details without leaking secret keys', async () => {
  const req = client();
  const res = await req('GET', '/api/config');
  assert.equal(res.status, 200);
  assert.equal(res.body.success, true);
  assert.ok(res.body.data.supabaseUrl);
  assert.ok(res.body.data.supabaseAnonKey);
  // Ensure secret keys are NEVER exposed in config
  assert.equal(res.body.data.supabaseSecretKey, undefined);
  assert.equal(res.body.data.SUPABASE_SECRET_KEY, undefined);
});

test('SUPABASE AUTH: Malformed or invalid Supabase token is rejected with 401 BAD_TOKEN', async () => {
  const req = client();
  const res = await req('POST', '/api/auth/supabase', {
    accessToken: 'invalid-token-12345',
    human: humanTelemetry(8),
  });
  assert.equal(res.status, 401);
  assert.equal(res.body.success, false);
  assert.equal(res.body.error.code, 'BAD_TOKEN');
});


