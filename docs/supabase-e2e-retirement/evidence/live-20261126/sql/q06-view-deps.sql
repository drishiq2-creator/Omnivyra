select json_agg(x) as result from (
 select distinct vn.nspname as view_schema, v.relname as view, v.relkind as kind, tn.nspname as table_schema, t.relname as table
 from pg_depend d join pg_rewrite r on r.oid = d.objid join pg_class v on v.oid = r.ev_class join pg_namespace vn on vn.oid = v.relnamespace join pg_class t on t.oid = d.refobjid join pg_namespace tn on tn.oid = t.relnamespace
 where d.classid = 'pg_rewrite'::regclass and d.refclassid = 'pg_class'::regclass and v.oid <> t.oid and tn.nspname = 'public' and t.relkind in ('r','p')
) x;
