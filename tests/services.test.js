'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { setupServices } = require('./helpers');

// Org 1 = Regional Passport Office (09:00–17:00, 15-min slots). Service 1 = Passport Application (code P, 6 seats/slot).
const ORG = 1;
const SVC = 1;
const OFFICE = { lat: 17.4399, lng: 78.4636 };
const FAR = { lat: 17.5, lng: 78.5 };
const DATE = '2026-03-10';
const at = (h, m) => new Date(2026, 2, 10, h, m).getTime();

const book = (services, userId, slotIndex, now = at(8, 0)) =>
  services.bookings.create({ userId, serviceId: SVC, date: DATE, slotIndex, kind: 'appointment', now });

const checkIn = (services, userId, bookingId, now) =>
  services.presence.updateLocation({ userId, bookingId, ...OFFICE, accuracy: 15, now });

test('token number is derived from the chosen slot and seat', () => {
  const { services, addUser } = setupServices();
  const b = book(services, addUser('a@x.io'), 4);
  assert.equal(b.tokenCode, 'P-025');
  assert.equal(b.slotTime, '10:00');
});

test('a full slot rejects further bookings (capacity enforced)', () => {
  const { services, addUser } = setupServices();
  for (let i = 0; i < 6; i++) book(services, addUser(`u${i}@x.io`), 4);
  assert.throws(() => book(services, addUser('late@x.io'), 4), { code: 'SLOT_FULL' });
});

test('rescheduling changes only the rescheduling user\'s token', () => {
  const { services, addUser } = setupServices();
  const a = addUser('a@x.io');
  const b = addUser('b@x.io');
  const tokenA = book(services, a, 4);
  const tokenB = book(services, b, 4);
  assert.equal(tokenB.tokenCode, 'P-026');
  const moved = services.bookings.reschedule({ userId: a, bookingId: tokenA.id, date: DATE, slotIndex: 8, now: at(8, 5) });
  assert.equal(moved.tokenCode, 'P-049');
  assert.equal(moved.slotTime, '11:00');
  assert.equal(services.bookings.viewById(tokenB.id, at(8, 5)).tokenCode, 'P-026');
  // the vacated seat is reusable
  assert.equal(book(services, addUser('c@x.io'), 4).tokenCode, 'P-025');
});

test('reschedule limit is enforced', () => {
  const { services, addUser } = setupServices();
  const u = addUser('a@x.io');
  const t = book(services, u, 4);
  for (const slot of [5, 6, 7]) services.bookings.reschedule({ userId: u, bookingId: t.id, date: DATE, slotIndex: slot, now: at(8, 0) });
  assert.throws(
    () => services.bookings.reschedule({ userId: u, bookingId: t.id, date: DATE, slotIndex: 9, now: at(8, 0) }),
    { code: 'LIMIT_RESCHEDULE' },
  );
});

test('walk-in token lands in the current slot', () => {
  const { services, addUser } = setupServices();
  const t = services.bookings.create({ userId: addUser('w@x.io'), serviceId: SVC, kind: 'walkin', now: at(10, 5) });
  assert.equal(t.slotTime, '10:00');
  assert.equal(t.date, DATE);
});

test('one live token per user per place per day; past slots rejected', () => {
  const { services, addUser } = setupServices();
  const u = addUser('a@x.io');
  book(services, u, 4);
  assert.throws(() => book(services, u, 6), { code: 'DUPLICATE_BOOKING' });
  assert.throws(() => book(services, addUser('b@x.io'), 1, at(10, 0)), /already passed/);
});

test('cannot book two different slots at the same time across places', () => {
  const { services, addUser } = setupServices();
  const u = addUser('simultaneous@x.io');
  book(services, u, 4); // Org 1 at 10:00
  // Org 2, slot 8 is also at 10:00
  assert.throws(
    () => services.bookings.create({ userId: u, serviceId: 4, date: DATE, slotIndex: 8, kind: 'appointment', now: at(8, 0) }),
    { code: 'TIME_CONFLICT' },
  );
});

test('cannot book multiple active tokens for the same organisation across days', () => {
  const { services, addUser } = setupServices();
  const u = addUser('multiday@x.io');
  book(services, u, 4); // Booked for DATE
  assert.throws(
    () => services.bookings.create({ userId: u, serviceId: 1, date: '2026-03-11', slotIndex: 4, kind: 'appointment', now: at(8, 0) }),
    { code: 'DUPLICATE_BOOKING' },
  );
});

test('user paused after no-shows cannot book', () => {
  const { db, services, addUser } = setupServices();
  const u = addUser('a@x.io');
  db.prepare('UPDATE users SET blocked_until=? WHERE id=?').run(at(23, 0), u);
  assert.throws(() => book(services, u, 4), { code: 'BOOKING_SUSPENDED' });
});

test('location inside the geofence checks in; far away does not', () => {
  const { services, addUser } = setupServices();
  const u = addUser('a@x.io');
  const t = book(services, u, 4);
  const far = services.presence.updateLocation({ userId: u, bookingId: t.id, ...FAR, accuracy: 20, now: at(9, 50) });
  assert.equal(far.inside, false);
  assert.equal(far.status, 'booked');
  const near = checkIn(services, u, t.id, at(9, 50));
  assert.equal(near.inside, true);
  assert.equal(near.status, 'checked_in');
});

test('imprecise GPS fixes are rejected', () => {
  const { services, addUser } = setupServices();
  const u = addUser('a@x.io');
  const t = book(services, u, 4);
  assert.throws(
    () => services.presence.updateLocation({ userId: u, bookingId: t.id, ...OFFICE, accuracy: 900, now: at(9, 50) }),
    { code: 'LOW_ACCURACY' },
  );
});

test('leaving the premises puts a checked-in token on hold', () => {
  const { services, addUser } = setupServices();
  const u = addUser('a@x.io');
  const t = book(services, u, 4);
  checkIn(services, u, t.id, at(9, 50));
  const left = services.presence.updateLocation({ userId: u, bookingId: t.id, ...FAR, accuracy: 20, now: at(9, 55) });
  assert.equal(left.status, 'booked');
  assert.equal(services.notifier.list(u)[0].type, 'left_premises');
});

test('reminder is sent once before the slot when the user is not checked in', () => {
  const { services, addUser } = setupServices();
  const u = addUser('a@x.io');
  book(services, u, 4);
  services.presence.runMonitor(at(9, 46));
  services.presence.runMonitor(at(9, 47));
  assert.equal(services.notifier.list(u).filter((n) => n.type === 'reminder').length, 1);
});

test('absent user is moved to a later slot; other users keep their tokens', () => {
  const { services, addUser } = setupServices();
  const a = addUser('a@x.io');
  const b = addUser('b@x.io');
  const tA = book(services, a, 4);
  const tB = book(services, b, 4);
  checkIn(services, b, tB.id, at(9, 55));

  services.presence.runMonitor(at(10, 11));

  const movedA = services.bookings.viewById(tA.id, at(10, 11));
  assert.equal(movedA.status, 'booked');
  assert.equal(movedA.deferrals, 1);
  assert.equal(movedA.slotTime, '10:15');
  assert.equal(movedA.tokenCode, 'P-031');
  assert.equal(services.bookings.viewById(tB.id, at(10, 11)).tokenCode, 'P-026');
  assert.equal(services.notifier.list(a)[0].type, 'token_moved');
});

test('counter calls the earliest *present* token, skipping absent ones', () => {
  const { services, addUser } = setupServices();
  const absent = addUser('absent@x.io');
  const present = addUser('present@x.io');
  book(services, absent, 3);
  const tP = book(services, present, 4);
  checkIn(services, present, tP.id, at(9, 40));
  const r = services.counters.callNext({ orgId: ORG, counterId: 1, now: at(9, 45) });
  assert.equal(r.tokenCode, tP.tokenCode);
  assert.equal(services.notifier.list(present)[0].type, 'called');
  assert.throws(() => services.counters.callNext({ orgId: ORG, counterId: 1, now: at(9, 46) }), { code: 'COUNTER_BUSY' });
  services.counters.complete({ orgId: ORG, counterId: 1, now: at(9, 50) });
  assert.equal(services.bookings.viewById(tP.id, at(9, 50)).status, 'done');
});

test('auto-assign fills idle counters, least-loaded first', () => {
  const { services, addUser } = setupServices();
  for (let i = 0; i < 3; i++) {
    const u = addUser(`p${i}@x.io`);
    const t = book(services, u, 4);
    checkIn(services, u, t.id, at(9, 40));
  }
  const { assigned } = services.counters.autoAssign({ orgId: ORG, now: at(9, 45) });
  assert.equal(assigned.length, 3);
  assert.deepEqual(assigned.map((a) => a.tokenCode), ['P-025', 'P-026', 'P-027']);
});

test('missed calls move the token, then expire it with a strike', () => {
  const { db, services, addUser } = setupServices();
  const u = addUser('a@x.io');
  const t = book(services, u, 4);
  const cycle = (minute) => {
    checkIn(services, u, t.id, at(10, minute));
    services.counters.callNext({ orgId: ORG, counterId: 1, now: at(10, minute) });
    return services.counters.noShow({ orgId: ORG, counterId: 1, now: at(10, minute + 1) });
  };
  assert.ok(cycle(0).movedTo);
  assert.ok(cycle(5).movedTo);
  assert.equal(cycle(10).movedTo, null);
  assert.equal(services.bookings.viewById(t.id, at(10, 20)).status, 'no_show');
  assert.equal(db.prepare('SELECT strikes FROM users WHERE id=?').get(u).strikes, 1);
});

test('24-hour centre keeps serving across midnight; stale tokens expire later with a notice', () => {
  const { services, addUser } = setupServices();
  const HOSPITAL = 4;
  const u = addUser('night@x.io');
  const t = services.bookings.create({ userId: u, serviceId: 9, date: DATE, slotIndex: 143, kind: 'appointment', now: at(23, 0) });
  assert.equal(t.slotTime, '23:50');
  services.presence.updateLocation({ userId: u, bookingId: t.id, lat: 17.4239, lng: 78.4575, accuracy: 10, now: at(23, 45) });
  services.counters.callNext({ orgId: HOSPITAL, counterId: services.stats.snapshot(HOSPITAL, at(23, 50)).counters[0].id, now: at(23, 55) });

  const afterMidnight = new Date(2026, 2, 11, 0, 5).getTime();
  services.presence.runMonitor(afterMidnight);
  assert.equal(services.bookings.viewById(t.id, afterMidnight).status, 'called', 'must not be expired mid-service');

  const later = new Date(2026, 2, 11, 2, 30).getTime();
  services.presence.runMonitor(later);
  assert.equal(services.bookings.viewById(t.id, later).status, 'no_show');
  assert.equal(services.notifier.list(u)[0].type, 'no_show');
});

test('location check-in without fresh fixes goes back on hold', () => {
  const { services, addUser } = setupServices();
  const u = addUser('a@x.io');
  const t = book(services, u, 4);
  checkIn(services, u, t.id, at(9, 50));
  services.presence.runMonitor(at(10, 5));
  assert.equal(services.bookings.viewById(t.id, at(10, 5)).status, 'checked_in');
  services.presence.runMonitor(at(10, 15));
  assert.equal(services.bookings.viewById(t.id, at(10, 15)).status, 'booked');
  assert.equal(services.notifier.list(u)[0].type, 'left_premises');
});

test('a checked-in visitor is not counted behind people who have not arrived', () => {
  const { services, addUser } = setupServices();
  book(services, addUser('late@x.io'), 3);
  const u = addUser('here@x.io');
  const t = book(services, u, 4);
  checkIn(services, u, t.id, at(9, 40));
  assert.equal(services.bookings.viewById(t.id, at(9, 41)).ahead, 0);
});

test('database unique index blocks double-issuing a seat', () => {
  const { db, addUser } = setupServices();
  const u = addUser('a@x.io');
  const insert = db.prepare(
    `INSERT INTO bookings (user_id, org_id, service_id, date, slot_index, seat, token_no, token_code, kind, status, created_at)
     VALUES (?, 1, 1, '2026-03-10', 4, 0, 25, 'P-025', 'appointment', 'booked', 0)`,
  );
  insert.run(u);
  assert.throws(() => insert.run(u), /UNIQUE/);
});

test('live snapshot exposes no personal data', () => {
  const { services, addUser } = setupServices();
  const u = addUser('secret.person@x.io');
  const t = book(services, u, 4);
  checkIn(services, u, t.id, at(9, 50));
  const snap = services.stats.snapshot(ORG, at(9, 50));
  assert.equal(snap.totals.present, 1);
  assert.ok(!JSON.stringify(snap).includes('secret.person'));
});
