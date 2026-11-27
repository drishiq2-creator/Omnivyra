select json_agg(json_build_object('name', a.attname, 'type', format_type(a.atttypid, a.atttypmod), 'not_null', a.attnotnull, 'default', pg_get_expr(d.adbin, d.adrelid)) order by a.attnum) as result
from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
where a.attrelid = 'public.api_idempotency_keys'::regclass and a.attnum > 0 and not a.attisdropped;
