-- 20270217000069 - notification_delivery_failures: a durable record of each UNDELIVERABLE notification (a9; version
-- reserved by cb, rc-attest 342474813; b3 ruling (B), 2026-11-20).
--
-- WHY. notification_undeliverable is an in-memory, per-process counter. Credit alerts and company events are raised on
--   Vercel too, where each serverless instance keeps its own registry and is usually recycled before any scrape
--   reaches it, so the alert rules in monitoring/notifications-alerts.yml could not see most events. No existing table
--   fits (checked, b3 accepted): notifications.user_id is NOT NULL and an undeliverable event has no recipient;
--   credit_alert_log is credit-only and records the decision to alert, not the delivery outcome;
--   report_notification_events is report-domain only.
--
-- WHAT. A new table (EXPAND only; no existing object changes):
--   - written by backend/services/notificationFailureRecord.ts (service_role, via notifyCompanyEvent and
--     reportNotificationInsertFailure), at most one row per (company, type, reason) per minute per process;
--   - read by the WORKER's exporter (backend/observability/notificationFailureExporter.ts), which publishes
--     windowed counts the alert rules read, and pruned by the worker after 90 days.
--   reason is CHECKed to the four values the writer emits. type is free text up to 60 characters (the writer truncates;
--   the CHECK refuses longer). company_id is nullable: invalid input and per-user writers have no company. It is for
--   diagnosis only; the exporter never puts it in a metric label.
--   company_id references companies(id) ON DELETE CASCADE: a deleted company's diagnostic rows go with it.
--
-- PRIVILEGES. RLS enabled with NO policy, and every privilege revoked from anon and authenticated: clients can neither
--   read nor write it. service_role (which bypasses RLS) keeps SELECT, INSERT and DELETE - the writer inserts, the
--   exporter selects, the prune deletes. Nothing UPDATEs a row.
--
-- LOCKS. A new, empty table: CREATE TABLE / INDEX take locks on the new objects only.
--
-- ROLLBACK: rollbacks/notification_delivery_failures_rollback.sql (drops the table; the rows are diagnostics only).

CREATE TABLE IF NOT EXISTS public.notification_delivery_failures (
  id         uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  reason     text        NOT NULL,
  type       text        NOT NULL,
  company_id uuid        NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  CONSTRAINT notification_delivery_failures_reason_known
    CHECK (reason IN ('no_active_recipient', 'membership_unreadable', 'insert_failed', 'invalid_input')),
  CONSTRAINT notification_delivery_failures_type_bounded
    CHECK (length(type) BETWEEN 1 AND 60)
);

CREATE INDEX IF NOT EXISTS idx_notification_delivery_failures_created_at
  ON public.notification_delivery_failures (created_at);
CREATE INDEX IF NOT EXISTS idx_notification_delivery_failures_company
  ON public.notification_delivery_failures (company_id) WHERE company_id IS NOT NULL;

ALTER TABLE public.notification_delivery_failures ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.notification_delivery_failures FROM PUBLIC;
REVOKE ALL ON TABLE public.notification_delivery_failures FROM anon;
REVOKE ALL ON TABLE public.notification_delivery_failures FROM authenticated;
REVOKE ALL ON TABLE public.notification_delivery_failures FROM service_role;
GRANT SELECT, INSERT, DELETE ON TABLE public.notification_delivery_failures TO service_role;

-- POSTCONDITION: the shape this file promises, read back from the catalog.
DO $postcondition$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid = 'public.notification_delivery_failures'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION '20270217000069 postcondition: RLS is not enabled';
  END IF;
  IF has_table_privilege('anon', 'public.notification_delivery_failures', 'SELECT,INSERT,UPDATE,DELETE')
     OR has_table_privilege('authenticated', 'public.notification_delivery_failures', 'SELECT,INSERT,UPDATE,DELETE') THEN
    RAISE EXCEPTION '20270217000069 postcondition: a client role holds a privilege';
  END IF;
  IF has_table_privilege('service_role', 'public.notification_delivery_failures', 'UPDATE') THEN
    RAISE EXCEPTION '20270217000069 postcondition: service_role holds UPDATE';
  END IF;
  IF NOT (has_table_privilege('service_role', 'public.notification_delivery_failures', 'SELECT')
          AND has_table_privilege('service_role', 'public.notification_delivery_failures', 'INSERT')
          AND has_table_privilege('service_role', 'public.notification_delivery_failures', 'DELETE')) THEN
    RAISE EXCEPTION '20270217000069 postcondition: service_role lacks SELECT/INSERT/DELETE';
  END IF;
END
$postcondition$;
