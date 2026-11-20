-- Rollback for 20270217000069_notification_delivery_failures.sql (a9).
-- Drops the table, its indexes and constraints. The rows are diagnostics only (undeliverable-notification records the
-- worker's exporter counts); nothing else references the table. Run only with the code that writes it reverted, or the
-- writer's inserts fail - which it tolerates (fail-open, logged NOTIFICATION_FAILURE_RECORD_FAILED and counted).
DROP TABLE IF EXISTS public.notification_delivery_failures;
