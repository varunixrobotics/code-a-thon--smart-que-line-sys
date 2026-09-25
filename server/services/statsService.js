'use strict';

const S = require('../lib/slots');
const { errors } = require('../errors');
const { stmt } = require('../db');

const toMin = (ms) => (ms === null || ms === undefined ? null : Math.round((ms / 60_000) * 10) / 10);

function maskEmail(email) {
  const [local, domain] = String(email).split('@');
  if (!domain) return '***';
  return `${local.slice(0, 2)}***@${domain}`;
}

function isOpenNow(org, now) {
  const m = S.minuteOfDay(now);
  return m >= org.open_min && m < org.close_min;
}

/** Read models: public live queue, organisation catalogue, admin analytics. */
function createStatsService({ db }) {
  const q = (sql) => stmt(db, sql);

  function listOrgs(now) {
    const today = S.toDateStr(now);
    const services = q('SELECT id, org_id, name, code, slot_capacity, avg_service_min FROM services ORDER BY id').all();
    const orgs = q(
      `SELECT o.*,
         (SELECT COUNT(*) FROM bookings b WHERE b.org_id=o.id AND b.date=? AND b.status IN ('booked','checked_in')) AS waiting,
         (SELECT COUNT(*) FROM counters c WHERE c.org_id=o.id AND c.status='open') AS open_counters
       FROM organizations o ORDER BY o.category, o.name`,
    ).all(today);
    return orgs.map((o) => {
      const svc = services.filter((s) => s.org_id === o.id);
      const avg = svc.length ? svc.reduce((a, s) => a + s.avg_service_min, 0) / svc.length : 6;
      return {
        id: o.id,
        name: o.name,
        category: o.category,
        address: o.address,
        lat: o.lat,
        lng: o.lng,
        radiusM: o.radius_m,
        hours: `${S.minutesLabel(o.open_min)}–${o.close_min >= 1440 ? '24:00' : S.minutesLabel(o.close_min)}`,
        slotMinutes: o.slot_minutes,
        openNow: isOpenNow(o, now),
        waiting: o.waiting,
        openCounters: o.open_counters,
        estWaitMin: Math.ceil((o.waiting * avg) / Math.max(1, o.open_counters)),
        services: svc.map((s) => ({ id: s.id, name: s.name, code: s.code, capacity: s.slot_capacity, avgServiceMin: s.avg_service_min })),
      };
    });
  }

  function snapshot(orgId, now) {
    const org = q('SELECT id, name, category, address, open_min, close_min, slot_minutes FROM organizations WHERE id=?').get(orgId);
    if (!org) throw errors.notFound('Organisation not found.');
    const today = S.toDateStr(now);
    const counters = q(
      `SELECT c.id, c.name, c.status, b.token_code, b.called_at, s.name AS service_name
       FROM counters c
       LEFT JOIN bookings b ON b.id = c.current_booking_id AND b.status='called'
       LEFT JOIN services s ON s.id = b.service_id
       WHERE c.org_id=? ORDER BY c.id`,
    ).all(orgId);
    const waiting = q(
      `SELECT b.token_code, b.status, b.slot_index, s.code, s.name
       FROM bookings b JOIN services s ON s.id = b.service_id
       WHERE b.org_id=? AND b.date=? AND b.status IN ('booked','checked_in')
       ORDER BY b.slot_index, b.seat, b.service_id LIMIT 40`,
    ).all(orgId, today);
    const t = q(
      `SELECT SUM(status IN ('booked','checked_in')) AS waiting, SUM(status='checked_in') AS present,
              SUM(status='called') AS serving, SUM(status='done') AS served, SUM(status='no_show') AS no_show,
              AVG(CASE WHEN called_at IS NOT NULL THEN called_at - COALESCE(checked_in_at, created_at) END) AS avg_wait,
              AVG(CASE WHEN completed_at IS NOT NULL THEN completed_at - called_at END) AS avg_service
       FROM bookings WHERE org_id=? AND date=?`,
    ).get(orgId, today);
    const recent = q(
      "SELECT token_code FROM bookings WHERE org_id=? AND date=? AND status='done' ORDER BY completed_at DESC LIMIT 6",
    ).all(orgId, today);
    const avgSvcMin = q('SELECT AVG(avg_service_min) AS a FROM services WHERE org_id=?').get(orgId).a || 6;
    const openCounters = counters.filter((c) => c.status === 'open').length;
    const waitingCount = t.waiting || 0;

    return {
      org: { id: org.id, name: org.name, category: org.category, address: org.address, openNow: isOpenNow(org, now) },
      updatedAt: now,
      counters: counters.map((c) => ({
        id: c.id,
        name: c.name,
        status: c.status,
        serving: c.token_code ? { tokenCode: c.token_code, service: c.service_name, sinceMs: c.called_at } : null,
      })),
      waiting: waiting.map((w) => ({
        tokenCode: w.token_code,
        serviceCode: w.code,
        service: w.name,
        slotTime: S.slotLabel(org, w.slot_index),
        present: w.status === 'checked_in',
      })),
      recent: recent.map((r) => r.token_code),
      totals: {
        waiting: waitingCount,
        present: t.present || 0,
        serving: t.serving || 0,
        served: t.served || 0,
        noShow: t.no_show || 0,
        openCounters,
        avgWaitMin: toMin(t.avg_wait),
        avgServiceMin: toMin(t.avg_service),
        estClearMin: Math.ceil((waitingCount * avgSvcMin) / Math.max(1, openCounters)),
      },
    };
  }

  function overview(orgId, now) {
    const today = S.toDateStr(now);
    const byStatus = Object.fromEntries(
      q('SELECT status, COUNT(*) AS c FROM bookings WHERE org_id=? AND date=? GROUP BY status').all(orgId, today).map((r) => [r.status, r.c]),
    );
    const hourly = q(
      `SELECT (o.open_min + b.slot_index * o.slot_minutes) / 60 AS hour,
              SUM(b.status NOT IN ('cancelled')) AS booked, SUM(b.status='done') AS served
       FROM bookings b JOIN organizations o ON o.id=b.org_id
       WHERE b.org_id=? AND b.date=? GROUP BY hour ORDER BY hour`,
    ).all(orgId, today);
    const counters = q(
      `SELECT c.id, c.name, c.status, COUNT(b.id) AS served, AVG(b.completed_at - b.called_at) AS avg_handle
       FROM counters c LEFT JOIN bookings b ON b.counter_id=c.id AND b.date=? AND b.status='done'
       WHERE c.org_id=? GROUP BY c.id ORDER BY c.id`,
    ).all(today, orgId);
    const risk = q(
      'SELECT verdict, outcome, COUNT(*) AS c FROM risk_events WHERE created_at > ? GROUP BY verdict, outcome',
    ).all(now - 24 * 3600_000);
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);
    const finished = (byStatus.done || 0) + (byStatus.no_show || 0);
    return {
      date: today,
      byStatus,
      total,
      noShowRate: finished ? Math.round(((byStatus.no_show || 0) / finished) * 100) : 0,
      hourly: hourly.map((h) => ({ hour: h.hour, booked: h.booked, served: h.served })),
      counters: counters.map((c) => ({ id: c.id, name: c.name, status: c.status, served: c.served, avgHandleMin: toMin(c.avg_handle) })),
      risk: risk.map((r) => ({ verdict: r.verdict, outcome: r.outcome, count: r.c })),
    };
  }

  function queueTable(orgId, now) {
    return q(
      `SELECT b.id, b.token_code, b.status, b.kind, b.slot_index, b.deferrals, b.last_distance_m, b.last_seen_at,
              u.name, u.email, u.role, s.name AS service, c.name AS counter, o.open_min, o.slot_minutes
       FROM bookings b JOIN users u ON u.id=b.user_id JOIN services s ON s.id=b.service_id
       JOIN organizations o ON o.id=b.org_id LEFT JOIN counters c ON c.id=b.counter_id
       WHERE b.org_id=? AND b.date=? AND b.status IN ('booked','checked_in','called')
       ORDER BY b.slot_index, b.seat, b.service_id LIMIT 200`,
    )
      .all(orgId, S.toDateStr(now))
      .map((r) => ({
        id: r.id,
        tokenCode: r.token_code,
        status: r.status,
        kind: r.kind,
        slotTime: S.slotLabel(r, r.slot_index),
        deferrals: r.deferrals,
        distanceM: r.last_distance_m,
        lastSeenAt: r.last_seen_at,
        name: r.role === 'system' ? 'Walk-in (kiosk)' : r.name,
        email: r.role === 'system' ? '' : maskEmail(r.email),
        service: r.service,
        counter: r.counter,
      }));
  }

  const riskEvents = (limit = 40) =>
    q('SELECT * FROM risk_events ORDER BY id DESC LIMIT ?').all(limit).map((r) => ({
      id: r.id,
      action: r.action,
      score: r.score,
      verdict: r.verdict,
      outcome: r.outcome,
      reasons: r.reasons ? r.reasons.split(',') : [],
      createdAt: r.created_at,
    }));

  const auditLog = (limit = 40) =>
    q(
      `SELECT a.*, u.email FROM audit_log a LEFT JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT ?`,
    ).all(limit).map((a) => ({
      id: a.id,
      action: a.action,
      detail: a.detail,
      who: a.email ? maskEmail(a.email) : 'system',
      createdAt: a.created_at,
    }));

  return Object.freeze({ listOrgs, snapshot, overview, queueTable, riskEvents, auditLog });
}

module.exports = { createStatsService, maskEmail };
