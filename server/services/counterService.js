'use strict';

const S = require('../lib/slots');
const { errors } = require('../errors');
const { stmt, tx } = require('../db');

/**
 * Counter assignment. The next person called is always the earliest
 * *checked-in* token (by slot, then seat), so people who are physically
 * present are never blocked by people who haven't arrived.
 */
function createCounterService({ db, notifier, presence }) {
  const q = (sql) => stmt(db, sql);

  function requireCounter(orgId, counterId) {
    const counter = q('SELECT * FROM counters WHERE id=? AND org_id=?').get(counterId, orgId);
    if (!counter) throw errors.notFound('Counter not found.');
    return counter;
  }

  function servingAt(counter) {
    if (!counter.current_booking_id) return null;
    const b = q('SELECT * FROM bookings WHERE id=?').get(counter.current_booking_id);
    return b && b.status === 'called' ? b : null;
  }

  function requireServing(counter) {
    const b = servingAt(counter);
    if (!b) throw errors.conflict(`No token is being served at ${counter.name}.`);
    return b;
  }

  function callNextInTx(orgId, counter, now, outbox) {
    if (counter.status !== 'open') throw errors.conflict(`${counter.name} is ${counter.status}.`);
    const current = servingAt(counter);
    if (current) throw errors.conflict(`Finish ${current.token_code} at ${counter.name} first.`, 'COUNTER_BUSY');
    const next = q(
      `SELECT * FROM bookings WHERE org_id=? AND date=? AND status='checked_in'
       ORDER BY slot_index, seat, service_id LIMIT 1`,
    ).get(orgId, S.toDateStr(now));
    if (!next) {
      q('UPDATE counters SET current_booking_id=NULL WHERE id=?').run(counter.id);
      return null;
    }
    q("UPDATE bookings SET status='called', counter_id=?, called_at=? WHERE id=?").run(counter.id, now, next.id);
    q('UPDATE counters SET current_booking_id=? WHERE id=?').run(next.id, counter.id);
    outbox.push([next.user_id, {
      bookingId: next.id,
      type: 'called',
      level: 'success',
      title: `It's your turn — ${next.token_code}`,
      body: `Please proceed to ${counter.name} now.`,
    }]);
    return { counterId: counter.id, counter: counter.name, tokenCode: next.token_code, bookingId: next.id };
  }

  function run(orgId, fn) {
    const outbox = [];
    const result = tx(db, () => fn(outbox));
    notifier.flush(outbox, [orgId]);
    return result;
  }

  const callNext = ({ orgId, counterId, now }) =>
    run(orgId, (outbox) => callNextInTx(orgId, requireCounter(orgId, counterId), now, outbox));

  const complete = ({ orgId, counterId, now }) =>
    run(orgId, (outbox) => {
      const counter = requireCounter(orgId, counterId);
      const b = requireServing(counter);
      q("UPDATE bookings SET status='done', completed_at=? WHERE id=?").run(now, b.id);
      q('UPDATE counters SET current_booking_id=NULL WHERE id=?').run(counter.id);
      outbox.push([b.user_id, {
        bookingId: b.id,
        type: 'done',
        level: 'success',
        title: `Served: ${b.token_code}`,
        body: 'Thanks for your visit. We hope it was quick!',
      }]);
      return { tokenCode: b.token_code };
    });

  const noShow = ({ orgId, counterId, now }) =>
    run(orgId, (outbox) => {
      const counter = requireCounter(orgId, counterId);
      const b = requireServing(counter);
      q('UPDATE counters SET current_booking_id=NULL WHERE id=?').run(counter.id);
      const movedTo = presence.deferInTx(b, now, 'missed_call', outbox);
      return { tokenCode: b.token_code, movedTo };
    });

  const recall = ({ orgId, counterId }) =>
    run(orgId, (outbox) => {
      const counter = requireCounter(orgId, counterId);
      const b = requireServing(counter);
      outbox.push([b.user_id, {
        bookingId: b.id,
        type: 'recall',
        level: 'warning',
        title: `Final call — ${b.token_code}`,
        body: `${counter.name} is waiting for you. Please come now or your token will move.`,
      }]);
      return { tokenCode: b.token_code };
    });

  const setStatus = ({ orgId, counterId, status }) =>
    run(orgId, () => {
      const counter = requireCounter(orgId, counterId);
      if (status !== 'open' && servingAt(counter)) throw errors.conflict('Complete or release the current token first.');
      q('UPDATE counters SET status=? WHERE id=?').run(status, counter.id);
      return { counterId: counter.id, status };
    });

  /** Fill every idle open counter, least-loaded (fewest served today) first. */
  const autoAssign = ({ orgId, now }) =>
    run(orgId, (outbox) => {
      const idle = q(
        `SELECT c.*, (SELECT COUNT(*) FROM bookings b WHERE b.counter_id=c.id AND b.date=? AND b.status='done') AS served
         FROM counters c WHERE c.org_id=? AND c.status='open'
         AND (c.current_booking_id IS NULL OR c.current_booking_id NOT IN (SELECT id FROM bookings WHERE status='called'))
         ORDER BY served ASC, c.id ASC`,
      ).all(S.toDateStr(now), orgId);
      const assigned = [];
      for (const counter of idle) {
        const r = callNextInTx(orgId, counter, now, outbox);
        if (!r) break;
        assigned.push(r);
      }
      return { assigned };
    });

  /** Desk staff verified the visitor in person (e.g. no GPS on their phone). */
  const manualCheckIn = ({ orgId, bookingId, now }) =>
    run(orgId, (outbox) => {
      const b = q('SELECT * FROM bookings WHERE id=? AND org_id=?').get(bookingId, orgId);
      if (!b) throw errors.notFound('Token not found.');
      if (b.status !== 'booked' || b.date !== S.toDateStr(now)) throw errors.conflict('Only today\'s pending tokens can be checked in.');
      q("UPDATE bookings SET status='checked_in', checked_in_at=?, away_since=NULL WHERE id=?").run(now, b.id);
      outbox.push([b.user_id, {
        bookingId: b.id,
        type: 'checked_in',
        level: 'success',
        title: `Checked in at the desk: ${b.token_code}`,
        body: "You're in the live queue. We'll call you to a counter.",
      }]);
      return { tokenCode: b.token_code };
    });

  return Object.freeze({ callNext, complete, noShow, recall, setStatus, autoAssign, manualCheckIn });
}

module.exports = { createCounterService };
