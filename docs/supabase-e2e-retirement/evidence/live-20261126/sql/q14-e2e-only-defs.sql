select json_agg(json_build_object(
 'table', c.relname, 'owner', pg_get_userbyid(c.relowner), 'comment', obj_description(c.oid, 'pg_class'), 'rls', c.relrowsecurity,
 'exact_rows', (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', c.relname), false, true, '')))[1]::text::bigint,
 'columns', (select json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'not_null', a.attnotnull, 'default', pg_get_expr(d.adbin, d.adrelid)) order by a.attnum) from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped),
 'constraints', (select json_agg(json_build_object('name', k.conname, 'type', k.contype, 'def', pg_get_constraintdef(k.oid)) order by k.conname) from pg_constraint k where k.conrelid = c.oid),
 'inbound_fks', (select json_agg(f.relname || '.' || k.conname) from pg_constraint k join pg_class f on f.oid = k.conrelid where k.confrelid = c.oid and k.contype = 'f'),
 'indexes', (select json_agg(pg_get_indexdef(i.indexrelid)) from pg_index i where i.indrelid = c.oid),
 'triggers', (select json_agg(pg_get_triggerdef(t.oid)) from pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal),
 'policies', (select json_agg(json_build_object('name', p.policyname, 'cmd', p.cmd, 'roles', p.roles, 'qual', p.qual, 'with_check', p.with_check)) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname),
 'grants', (select json_agg(distinct g.grantee || ':' || g.privilege_type) from information_schema.role_table_grants g where g.table_schema = 'public' and g.table_name = c.relname),
 'views_depending', (select json_agg(distinct v.relname) from pg_depend dd join pg_rewrite rw on rw.oid = dd.objid join pg_class v on v.oid = rw.ev_class where dd.refobjid = c.oid and v.oid <> c.oid),
 'functions_mentioning', (select json_agg(pn.nspname || '.' || p.proname) from pg_proc p join pg_namespace pn on pn.oid = p.pronamespace where pn.nspname not in ('pg_catalog','information_schema') and p.prolang <> 12 and p.prosrc ~ ('\m' || c.relname || '\M')),
 'stats', (select json_build_object('n_tup_ins', s.n_tup_ins, 'n_tup_upd', s.n_tup_upd, 'n_tup_del', s.n_tup_del, 'seq_scan', s.seq_scan, 'idx_scan', s.idx_scan) from pg_stat_user_tables s where s.relid = c.oid)
) order by c.relname) as result
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relname = any(array['content_performance','content_prediction','learning_intelligence','learning_memory','prospect_list_members','prospect_lists']::text[]);
