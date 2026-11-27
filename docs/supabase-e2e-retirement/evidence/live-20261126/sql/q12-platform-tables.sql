select json_agg(json_build_object('schema', n.nspname, 'table', c.relname, 'owner', pg_get_userbyid(c.relowner), 'est_rows', c.reltuples::bigint, 'n_live_tup', s.n_live_tup, 'n_tup_ins', s.n_tup_ins, 'n_tup_upd', s.n_tup_upd, 'n_tup_del', s.n_tup_del) order by n.nspname, c.relname) as result
from pg_class c join pg_namespace n on n.oid = c.relnamespace left join pg_stat_all_tables s on s.relid = c.oid
where c.relkind in ('r','p') and n.nspname not in ('public','pg_catalog','information_schema','pg_toast') and n.nspname !~ '^pg_';
