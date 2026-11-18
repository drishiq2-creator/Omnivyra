-- Rollback of 20270217000061_billed_result_recovery.sql (c6). REFUSES while any refund is still OWED: dropping the table
-- would erase a debt to a customer. Granted rows are history only (the grants themselves live in credit_transactions).
DO $r061$
BEGIN
  IF to_regclass('public.billing_owed_refunds') IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.billing_owed_refunds WHERE status = 'owed') THEN
    RAISE EXCEPTION '061 rollback refused: billing_owed_refunds has OWED rows - pay or record them first';
  END IF;
END
$r061$;
DROP FUNCTION IF EXISTS public.record_billed_result_replay_failure(text, text, text, text);
DROP TABLE IF EXISTS public.billed_result_replay_failures;
DROP TABLE IF EXISTS public.billing_owed_refunds;
