DO $cleanup$
DECLARE
  t text;
  n bigint;
  tbls text[] := ARRAY['activity_class_economics', 'ai_model_versions', 'attribution_summary_cache', 'content_generation_budget', 'credential_rotation_attempts', 'expected_event_definitions', 'external_api_usage_logs', 'incident_events', 'ip_org_creations', 'job_idempotency_keys', 'orchestration_attempts', 'pending_invite_unlocks', 'sync_jobs', 'webhook_events'];
BEGIN
  SET LOCAL lock_timeout = '10s';
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('LOCK TABLE public.%I IN ACCESS EXCLUSIVE MODE', t);
    EXECUTE format('SELECT count(*) FROM public.%I', t) INTO n;
    IF n <> 0 THEN
      RAISE EXCEPTION 'table % is not empty (% rows); aborting, nothing dropped', t, n;
    END IF;
  END LOOP;
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format('DROP TABLE public.%I RESTRICT', t);
  END LOOP;
END
$cleanup$;
select json_build_object('still_present', (select coalesce(json_agg(c.relname), '[]'::json) from pg_class c join pg_namespace ns on ns.oid = c.relnamespace where ns.nspname = 'public' and c.relname = any(ARRAY['activity_class_economics', 'ai_model_versions', 'attribution_summary_cache', 'content_generation_budget', 'credential_rotation_attempts', 'expected_event_definitions', 'external_api_usage_logs', 'incident_events', 'ip_org_creations', 'job_idempotency_keys', 'orchestration_attempts', 'pending_invite_unlocks', 'sync_jobs', 'webhook_events']::text[])), 'public_tables_now', (select count(*) from pg_class c join pg_namespace ns on ns.oid = c.relnamespace where ns.nspname = 'public' and c.relkind in ('r','p'))) as result;
