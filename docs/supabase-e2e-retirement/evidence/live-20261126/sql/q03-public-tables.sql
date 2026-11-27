select json_agg(json_build_object(
 'table', c.relname, 'owner', pg_get_userbyid(c.relowner), 'kind', c.relkind, 'rls', c.relrowsecurity, 'rls_forced', c.relforcerowsecurity, 'est_rows', c.reltuples::bigint,
 'exact_rows', (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', c.relname), false, true, '')))[1]::text::bigint,
 'size_bytes', pg_total_relation_size(c.oid),
 'n_tup_ins', s.n_tup_ins, 'n_tup_upd', s.n_tup_upd, 'n_tup_del', s.n_tup_del, 'n_live_tup', s.n_live_tup, 'seq_scan', s.seq_scan, 'idx_scan', s.idx_scan,
 'last_vacuum', s.last_vacuum, 'last_autovacuum', s.last_autovacuum, 'last_analyze', s.last_analyze, 'last_autoanalyze', s.last_autoanalyze,
 'pk', (select string_agg(a.attname, ', ' order by a.attnum) from pg_constraint k join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any(k.conkey) where k.conrelid = c.oid and k.contype = 'p'),
 'columns', (select count(*) from pg_attribute a where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped),
 'grants', (select string_agg(distinct g.grantee || ':' || g.privilege_type, ';') from information_schema.role_table_grants g where g.table_schema = 'public' and g.table_name = c.relname)
) order by c.relname) as result
from pg_class c join pg_namespace n on n.oid = c.relnamespace left join pg_stat_user_tables s on s.relid = c.oid
where n.nspname = 'public' and c.relkind in ('r','p');
