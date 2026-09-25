'use strict';

const { stmt } = require('./db');
const { AppError } = require('./errors');

const TICK_MS = 6000;
const MAX_DEMO_WAITING = 10;
const ARRIVAL_PROBABILITY = 0.6;
const MIN_DEMO_SERVICE_MS = 45_000;
const DEMO_SERVICE_JITTER_MS = 60_000;

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * Development-only traffic simulator so the live queue, counters and charts
 * have motion during a demo. Kiosk walk-ins arrive at open organisations and
 * counters serve them. Real users' tokens are called by the simulator too
 * (so you receive the "your turn" notification) but are only completed by staff.
 */
function startDemoSimulator({ db, services, systemUserId }) {
  const tick = () => {
    const now = Date.now();
    for (const org of services.stats.listOrgs(now)) {
      if (!org.openNow) continue;
      try {
        if (org.waiting < MAX_DEMO_WAITING && Math.random() < ARRIVAL_PROBABILITY) {
          services.bookings.create({
            userId: systemUserId,
            serviceId: pick(org.services).id,
            kind: 'walkin',
            now,
            system: true,
            status: 'checked_in',
          });
        }
        advanceCounters(org.id, now);
      } catch (err) {
        if (!(err instanceof AppError)) console.error('[demo] tick failed', err);
      }
    }
  };

  function advanceCounters(orgId, now) {
    const counters = stmt(db,
      `SELECT c.id, c.status, b.user_id, b.called_at FROM counters c
       LEFT JOIN bookings b ON b.id=c.current_booking_id AND b.status='called' WHERE c.org_id=?`).all(orgId);
    for (const c of counters) {
      if (c.status !== 'open') continue;
      if (c.called_at === null) {
        services.counters.callNext({ orgId, counterId: c.id, now });
      } else if (c.user_id === systemUserId && now - c.called_at > MIN_DEMO_SERVICE_MS + Math.random() * DEMO_SERVICE_JITTER_MS) {
        services.counters.complete({ orgId, counterId: c.id, now });
      }
    }
  }

  const timer = setInterval(tick, TICK_MS);
  timer.unref();
  tick();
  return () => clearInterval(timer);
}

module.exports = { startDemoSimulator };
