-- ==============================================================================
-- SUPABASE POSTGRESQL PRODUCTION SECURITY HARDENING & RLS ARCHITECTURE
-- Compliant with Supabase Security Best Practices & OWASP ASVS
-- ==============================================================================

-- 1. Private helper schema for security definer routines
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO authenticated, service_role;

-- 2. Organizations table
CREATE TABLE IF NOT EXISTS public.organizations (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         TEXT NOT NULL,
  category     TEXT NOT NULL CHECK (category IN ('government','hospital','corporate','bank')),
  address      TEXT NOT NULL,
  lat          DOUBLE PRECISION NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng          DOUBLE PRECISION NOT NULL CHECK (lng BETWEEN -180 AND 180),
  radius_m     INTEGER NOT NULL DEFAULT 150 CHECK (radius_m BETWEEN 30 AND 5000),
  open_min     INTEGER NOT NULL CHECK (open_min BETWEEN 0 AND 1440),
  close_min    INTEGER NOT NULL CHECK (close_min BETWEEN 0 AND 1440),
  slot_minutes INTEGER NOT NULL DEFAULT 15 CHECK (slot_minutes BETWEEN 5 AND 120),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT timezone('utc'::text, now())
);
CREATE INDEX IF NOT EXISTS ix_organizations_category ON public.organizations(category);

-- 3. Users table (mirrored / linked to auth.users if Supabase Auth is used)
CREATE TABLE IF NOT EXISTS public.users (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  auth_user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  email           TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  password_hash   TEXT,
  google_sub      TEXT UNIQUE,
  totp_secret_enc TEXT,
  totp_enabled    BOOLEAN NOT NULL DEFAULT false,
  totp_last_step  BIGINT NOT NULL DEFAULT 0,
  role            TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','staff','admin','system')),
  strikes         INTEGER NOT NULL DEFAULT 0 CHECK (strikes >= 0),
  blocked_until   BIGINT,
  org_id          BIGINT REFERENCES public.organizations(id) ON DELETE SET NULL,
  created_at      BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_users_auth_id ON public.users(auth_user_id);
CREATE INDEX IF NOT EXISTS ix_users_role_org ON public.users(role, org_id);

-- 4. Sessions table
CREATE TABLE IF NOT EXISTS public.sessions (
  id_hash    TEXT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  mfa_ok     BOOLEAN NOT NULL DEFAULT false,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sessions_user_exp ON public.sessions(user_id, expires_at);

-- 5. Services table
CREATE TABLE IF NOT EXISTS public.services (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id          BIGINT NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  code            TEXT NOT NULL,
  slot_capacity   INTEGER NOT NULL DEFAULT 4 CHECK (slot_capacity BETWEEN 1 AND 100),
  avg_service_min INTEGER NOT NULL DEFAULT 6 CHECK (avg_service_min BETWEEN 1 AND 120)
);
CREATE INDEX IF NOT EXISTS ix_services_org ON public.services(org_id);

-- 6. Counters table
CREATE TABLE IF NOT EXISTS public.counters (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  org_id             BIGINT NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','paused','closed')),
  current_booking_id BIGINT
);
CREATE INDEX IF NOT EXISTS ix_counters_org_status ON public.counters(org_id, status);

-- 7. Bookings table
CREATE TABLE IF NOT EXISTS public.bookings (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  org_id          BIGINT NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  service_id      BIGINT NOT NULL REFERENCES public.services(id) ON DELETE RESTRICT,
  date            DATE NOT NULL,
  slot_index      INTEGER NOT NULL CHECK (slot_index >= 0),
  seat            INTEGER NOT NULL CHECK (seat >= 0),
  token_no        INTEGER NOT NULL CHECK (token_no > 0),
  token_code      TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('appointment','walkin')),
  status          TEXT NOT NULL CHECK (status IN ('booked','checked_in','called','done','no_show','cancelled')),
  counter_id      BIGINT REFERENCES public.counters(id) ON DELETE SET NULL,
  deferrals       INTEGER NOT NULL DEFAULT 0 CHECK (deferrals >= 0),
  reschedules     INTEGER NOT NULL DEFAULT 0 CHECK (reschedules >= 0),
  reminder_sent   BOOLEAN NOT NULL DEFAULT false,
  away_since      BIGINT,
  last_distance_m DOUBLE PRECISION,
  last_seen_at    BIGINT,
  created_at      BIGINT NOT NULL,
  checked_in_at   BIGINT,
  called_at       BIGINT,
  completed_at    BIGINT
);

-- Concurrency Protection & Race-Condition Prevention:
-- Guarantees seat uniqueness under concurrent slot bookings
CREATE UNIQUE INDEX IF NOT EXISTS ux_bookings_seat
  ON public.bookings(service_id, date, slot_index, seat)
  WHERE status NOT IN ('cancelled','no_show');

-- Guarantees single active booking per user per organization under concurrency
CREATE UNIQUE INDEX IF NOT EXISTS ux_bookings_user_org_live
  ON public.bookings(user_id, org_id)
  WHERE status IN ('booked','checked_in','called');

CREATE INDEX IF NOT EXISTS ix_bookings_day ON public.bookings(org_id, date, status);
CREATE INDEX IF NOT EXISTS ix_bookings_user ON public.bookings(user_id, status);

-- 8. Notifications table
CREATE TABLE IF NOT EXISTS public.notifications (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  booking_id BIGINT REFERENCES public.bookings(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  level      TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('info','success','warning','danger')),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  read_at    BIGINT
);
CREATE INDEX IF NOT EXISTS ix_notifications_user ON public.notifications(user_id, created_at DESC);

-- 9. Audit Log table (Tamper-Resistant & Append-Only)
CREATE TABLE IF NOT EXISTS public.audit_log (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    BIGINT REFERENCES public.users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  detail     TEXT,
  ip         TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_user_time ON public.audit_log(user_id, created_at DESC);

-- 10. Risk Events table (Security Telemetry)
CREATE TABLE IF NOT EXISTS public.risk_events (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  action     TEXT NOT NULL,
  ip         TEXT,
  score      DOUBLE PRECISION,
  verdict    TEXT NOT NULL,
  outcome    TEXT NOT NULL,
  reasons    TEXT,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_risk_created ON public.risk_events(created_at DESC);

-- ==============================================================================
-- SECURITY DEFINER CONTEXT FUNCTIONS (Fixed search_path against hijacking)
-- ==============================================================================

CREATE OR REPLACE FUNCTION private.get_calling_user_id()
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT id FROM public.users WHERE auth_user_id = (SELECT auth.uid()) LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION private.get_calling_user_role()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT role FROM public.users WHERE auth_user_id = (SELECT auth.uid()) LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION private.get_calling_user_org_id()
RETURNS BIGINT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT org_id FROM public.users WHERE auth_user_id = (SELECT auth.uid()) LIMIT 1;
$$;

REVOKE ALL ON FUNCTION private.get_calling_user_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.get_calling_user_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.get_calling_user_org_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.get_calling_user_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.get_calling_user_role() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.get_calling_user_org_id() TO authenticated, service_role;

-- ==============================================================================
-- ROW-LEVEL SECURITY (RLS) ENFORCEMENT
-- ==============================================================================

ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations FORCE ROW LEVEL SECURITY;

ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.services FORCE ROW LEVEL SECURITY;

ALTER TABLE public.counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.counters FORCE ROW LEVEL SECURITY;

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions FORCE ROW LEVEL SECURITY;

ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings FORCE ROW LEVEL SECURITY;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications FORCE ROW LEVEL SECURITY;

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log FORCE ROW LEVEL SECURITY;

ALTER TABLE public.risk_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.risk_events FORCE ROW LEVEL SECURITY;

-- ------------------------------------------------------------------------------
-- POLICIES: Organizations & Services (Public Read, Admin Write)
-- ------------------------------------------------------------------------------

CREATE POLICY rls_orgs_read_policy ON public.organizations
  FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY rls_orgs_admin_write ON public.organizations
  FOR ALL TO authenticated
  USING ((SELECT private.get_calling_user_role()) = 'admin')
  WITH CHECK ((SELECT private.get_calling_user_role()) = 'admin');

CREATE POLICY rls_services_read_policy ON public.services
  FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY rls_services_admin_write ON public.services
  FOR ALL TO authenticated
  USING (
    (SELECT private.get_calling_user_role()) = 'admin' OR
    ((SELECT private.get_calling_user_role()) = 'staff' AND org_id = (SELECT private.get_calling_user_org_id()))
  );

-- ------------------------------------------------------------------------------
-- POLICIES: Counters (Public Read, Staff/Admin Update)
-- ------------------------------------------------------------------------------

CREATE POLICY rls_counters_read ON public.counters
  FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY rls_counters_staff_update ON public.counters
  FOR UPDATE TO authenticated
  USING (
    (SELECT private.get_calling_user_role()) = 'admin' OR
    ((SELECT private.get_calling_user_role()) = 'staff' AND org_id = (SELECT private.get_calling_user_org_id()))
  )
  WITH CHECK (
    (SELECT private.get_calling_user_role()) = 'admin' OR
    ((SELECT private.get_calling_user_role()) = 'staff' AND org_id = (SELECT private.get_calling_user_org_id()))
  );

-- ------------------------------------------------------------------------------
-- POLICIES: Users (Self Read/Update, Admin Full)
-- ------------------------------------------------------------------------------

CREATE POLICY rls_users_self_read ON public.users
  FOR SELECT TO authenticated
  USING (
    id = (SELECT private.get_calling_user_id()) OR
    (SELECT private.get_calling_user_role()) IN ('admin', 'staff')
  );

CREATE POLICY rls_users_self_update ON public.users
  FOR UPDATE TO authenticated
  USING (id = (SELECT private.get_calling_user_id()))
  WITH CHECK (
    id = (SELECT private.get_calling_user_id()) AND
    role = (SELECT role FROM public.users WHERE id = (SELECT private.get_calling_user_id())) -- Prevents privilege escalation
  );

-- ------------------------------------------------------------------------------
-- POLICIES: Bookings (Owner Isolation, Staff Queue Access, Admin View)
-- ------------------------------------------------------------------------------

CREATE POLICY rls_bookings_owner_select ON public.bookings
  FOR SELECT TO authenticated
  USING (
    user_id = (SELECT private.get_calling_user_id()) OR
    (SELECT private.get_calling_user_role()) = 'admin' OR
    ((SELECT private.get_calling_user_role()) = 'staff' AND org_id = (SELECT private.get_calling_user_org_id()))
  );

CREATE POLICY rls_bookings_owner_insert ON public.bookings
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT private.get_calling_user_id())
  );

CREATE POLICY rls_bookings_owner_update ON public.bookings
  FOR UPDATE TO authenticated
  USING (
    user_id = (SELECT private.get_calling_user_id()) OR
    (SELECT private.get_calling_user_role()) = 'admin' OR
    ((SELECT private.get_calling_user_role()) = 'staff' AND org_id = (SELECT private.get_calling_user_org_id()))
  );

-- Prevent unauthorized DELETE on bookings (must maintain audit trail, cancel via status update)
CREATE POLICY rls_bookings_no_delete ON public.bookings
  FOR DELETE TO authenticated
  USING (false);

-- ------------------------------------------------------------------------------
-- POLICIES: Notifications (User Isolation)
-- ------------------------------------------------------------------------------

CREATE POLICY rls_notifications_user ON public.notifications
  FOR SELECT TO authenticated
  USING (user_id = (SELECT private.get_calling_user_id()));

CREATE POLICY rls_notifications_update_read ON public.notifications
  FOR UPDATE TO authenticated
  USING (user_id = (SELECT private.get_calling_user_id()))
  WITH CHECK (user_id = (SELECT private.get_calling_user_id()));

-- ------------------------------------------------------------------------------
-- POLICIES: Audit Log & Risk Events (Append-Only, Admin-Only Read, No Mutation)
-- ------------------------------------------------------------------------------

CREATE POLICY rls_audit_admin_read ON public.audit_log
  FOR SELECT TO authenticated
  USING ((SELECT private.get_calling_user_role()) = 'admin');

CREATE POLICY rls_audit_insert ON public.audit_log
  FOR INSERT TO authenticated, anon
  WITH CHECK (true);

CREATE POLICY rls_audit_no_update_delete ON public.audit_log
  FOR UPDATE TO authenticated, anon
  USING (false);

CREATE POLICY rls_risk_admin_read ON public.risk_events
  FOR SELECT TO authenticated
  USING ((SELECT private.get_calling_user_role()) = 'admin');

CREATE POLICY rls_risk_insert ON public.risk_events
  FOR INSERT TO authenticated, anon
  WITH CHECK (true);

-- ==============================================================================
-- END OF SUPABASE POSTGRESQL SECURITY HARDENING
-- ==============================================================================
