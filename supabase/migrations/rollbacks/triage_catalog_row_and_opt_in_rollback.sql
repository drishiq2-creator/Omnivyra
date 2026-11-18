-- Rollback of 20270217000056_triage_catalog_row_and_opt_in.sql (c6). Restores the column default to true and deletes ONLY
-- the catalog row 056 wrote (description marker). It does NOT switch any company's triage back ON: which rows were
-- genuine opt-ins cannot be known, and leaving billed triage off is the safe direction (owner ruling: opt-in).
ALTER TABLE public.engagement_system_controls ALTER COLUMN triage_engine_enabled SET DEFAULT true;
DELETE FROM public.credit_cost_config
 WHERE action_type = 'conversation_triage'
   AND description = 'Conversation triage, per classified conversation (20270217000056)';
