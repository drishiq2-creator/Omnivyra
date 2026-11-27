select json_agg(json_build_object('schema', n.nspname, 'table', c.relname, 'trigger', t.tgname, 'enabled', t.tgenabled, 'fn_schema', pn.nspname, 'fn', p.proname)) as result
from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace join pg_proc p on p.oid = t.tgfoid join pg_namespace pn on pn.oid = p.pronamespace
where not t.tgisinternal and n.nspname not in ('pg_catalog','information_schema');
