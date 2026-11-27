select json_build_object(
 'schemas', (select json_agg(json_build_object('schema', n.nspname, 'owner', pg_get_userbyid(n.nspowner), 'tables', (select count(*) from pg_class c where c.relnamespace = n.oid and c.relkind in ('r','p')), 'views', (select count(*) from pg_class c where c.relnamespace = n.oid and c.relkind in ('v','m')), 'functions', (select count(*) from pg_proc p where p.pronamespace = n.oid)) order by n.nspname) from pg_namespace n where n.nspname !~ '^pg_' and n.nspname <> 'information_schema'),
 'extensions', (select json_agg(json_build_object('name', e.extname, 'version', e.extversion, 'schema', n.nspname) order by e.extname) from pg_extension e join pg_namespace n on n.oid = e.extnamespace),
 'publications', (select json_agg(json_build_object('pub', p.pubname, 'schema', t.schemaname, 'table', t.tablename)) from pg_publication p left join pg_publication_tables t on t.pubname = p.pubname),
 'event_triggers', (select json_agg(json_build_object('name', evtname, 'event', evtevent, 'fn', evtfoid::regproc::text)) from pg_event_trigger),
 'migrations_schema', (select count(*) from pg_namespace where nspname = 'supabase_migrations')
) as result;
