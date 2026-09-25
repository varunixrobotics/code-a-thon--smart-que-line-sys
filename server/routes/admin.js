'use strict';

const express = require('express');
const { stmt } = require('../db');
const { errors } = require('../errors');
const { z, parse, id, ok } = require('../lib/validate');

const ACTIONS = Object.freeze({
  call: 'callNext',
  complete: 'complete',
  'no-show': 'noShow',
  recall: 'recall',
});

const statusSchema = z.object({ status: z.enum(['open', 'paused', 'closed']) });
const settingsSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  radiusM: z.number().int().min(30).max(2000),
});

function adminRoutes({ db, services, auth, audit }) {
  const r = express.Router();
  const staff = auth.requireRole('staff', 'admin');
  const admin = auth.requireRole('admin');

  /** Admins may act on any organisation; staff only on the one they are assigned to. */
  function orgIdFrom(req) {
    const orgId = parse(id, req.params.orgId);
    if (!stmt(db, 'SELECT 1 AS x FROM organizations WHERE id=?').get(orgId)) throw errors.notFound('Organisation not found.');
    const { role, org_id: staffOrg } = req.auth.user;
    if (role !== 'admin' && staffOrg !== orgId) throw errors.forbidden('You can only manage your own service centre.');
    return orgId;
  }

  r.get('/orgs/:orgId/overview', staff, (req, res) => {
    const orgId = orgIdFrom(req);
    const now = Date.now();
    res.json(ok({
      overview: services.stats.overview(orgId, now),
      snapshot: services.stats.snapshot(orgId, now),
      queue: services.stats.queueTable(orgId, now),
    }));
  });

  r.post('/orgs/:orgId/counters/:counterId/:action', staff, (req, res) => {
    const orgId = orgIdFrom(req);
    const counterId = parse(id, req.params.counterId);
    const method = ACTIONS[req.params.action];
    if (!method) throw errors.notFound('Unknown counter action.');
    const result = services.counters[method]({ orgId, counterId, now: Date.now() });
    audit(req, `counter_${req.params.action}`, `org ${orgId} counter ${counterId} ${result?.tokenCode || 'none'}`);
    res.json(ok({ result }));
  });

  r.post('/orgs/:orgId/counters/:counterId', staff, (req, res) => {
    const orgId = orgIdFrom(req);
    const counterId = parse(id, req.params.counterId);
    const { status } = parse(statusSchema, req.body);
    const result = services.counters.setStatus({ orgId, counterId, status });
    audit(req, 'counter_status', `org ${orgId} counter ${counterId} → ${status}`);
    res.json(ok({ result }));
  });

  r.post('/orgs/:orgId/auto-assign', staff, (req, res) => {
    const orgId = orgIdFrom(req);
    const result = services.counters.autoAssign({ orgId, now: Date.now() });
    audit(req, 'auto_assign', `org ${orgId} assigned ${result.assigned.length}`);
    res.json(ok(result));
  });

  r.post('/orgs/:orgId/bookings/:bookingId/check-in', staff, (req, res) => {
    const orgId = orgIdFrom(req);
    const bookingId = parse(id, req.params.bookingId);
    const result = services.counters.manualCheckIn({ orgId, bookingId, now: Date.now() });
    audit(req, 'desk_check_in', result.tokenCode);
    res.json(ok({ result }));
  });

  r.post('/orgs/:orgId/settings', admin, (req, res) => {
    const orgId = orgIdFrom(req);
    const body = parse(settingsSchema, req.body);
    stmt(db, 'UPDATE organizations SET lat=?, lng=?, radius_m=? WHERE id=?').run(body.lat, body.lng, body.radiusM, orgId);
    audit(req, 'geofence_update', `org ${orgId} ${body.lat.toFixed(5)},${body.lng.toFixed(5)} r=${body.radiusM}`);
    res.json(ok({ orgId, ...body }));
  });

  r.post('/monitor/run', admin, (req, res) => {
    res.json(ok(services.presence.runMonitor(Date.now())));
  });

  r.get('/risk', admin, (_req, res) => res.json(ok({ events: services.stats.riskEvents() })));
  r.get('/audit', admin, (_req, res) => res.json(ok({ entries: services.stats.auditLog() })));

  return r;
}

module.exports = { adminRoutes };
