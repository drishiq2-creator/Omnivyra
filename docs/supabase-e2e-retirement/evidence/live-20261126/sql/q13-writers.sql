select json_build_object(
 'pss_info', (select row_to_json(i) from pg_stat_statements_info i),
 'statements', (select coalesce(json_agg(x order by x.calls desc), '[]'::json) from (
   select r.rolname as role, s.calls, s.rows, left(regexp_replace(s.query, '\s+', ' ', 'g'), 400) as query
   from pg_stat_statements s join pg_roles r on r.oid = s.userid
   where s.query ~* '\m(insert\s+into|update|delete\s+from|merge\s+into)\M'
     and s.query ~* '\m(companies|user_company_roles|engagement_threads|engagement_messages|api_idempotency_keys|attested_engagement_identities|audit_export_jobs|author_identity_links|campaign_versions|campaigns|canonical_leads|canonical_users|daily_content_plans|investigation_workspace_items|investigation_workspaces|lead_intelligence_profiles|lead_signals|opportunity_feed_items|opportunity_items|outreach_tasks|prospect_accounts|reports|unified_persons)\M'
     and s.query !~* 'pg_stat_statements'
 ) x)
) as result;
