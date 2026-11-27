select json_build_object(
 'auth_counts', (select json_object_agg(t, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from auth.%I', t), false, true, '')))[1]::text::bigint) from unnest(array(select c.relname::text from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'auth' and c.relkind = 'r' order by 1)) t),
 'storage_buckets', (select coalesce(json_agg(json_build_object('id', id, 'public', public)), '[]'::json) from storage.buckets),
 'storage_objects', (select count(*) from storage.objects),
 'cron_schema', (select count(*) from pg_namespace where nspname = 'cron'),
 'auth_storage_triggers', (select coalesce(json_agg(json_build_object('schema', n.nspname, 'table', c.relname, 'trigger', t.tgname, 'fn', pn.nspname || '.' || p.proname)), '[]'::json) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace join pg_proc p on p.oid = t.tgfoid join pg_namespace pn on pn.oid = p.pronamespace where n.nspname in ('auth','storage') and not t.tgisinternal),
 'public_fks_to_auth', (select count(*) from pg_constraint k join pg_class f on f.oid = k.conrelid join pg_namespace fn on fn.oid = f.relnamespace join pg_class t on t.oid = k.confrelid join pg_namespace tn on tn.oid = t.relnamespace where k.contype = 'f' and fn.nspname = 'public' and tn.nspname = 'auth')
) as result;
