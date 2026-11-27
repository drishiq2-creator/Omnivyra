select json_agg(json_build_object('table', relname, 'functions', fns)) as result from (
 select c.relname, (select json_agg(pn.nspname || '.' || p.proname order by pn.nspname, p.proname) from pg_proc p join pg_namespace pn on pn.oid = p.pronamespace
   where pn.nspname not in ('pg_catalog','information_schema') and p.prolang <> 12 and p.prosrc ~ ('\m' || c.relname || '\M')) as fns
 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p')
) z where fns is not null;
