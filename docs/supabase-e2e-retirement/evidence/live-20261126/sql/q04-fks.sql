select json_agg(json_build_object('name', k.conname, 'from_schema', fn.nspname, 'from_table', f.relname, 'to_schema', tn.nspname, 'to_table', t.relname, 'on_delete', k.confdeltype, 'def', pg_get_constraintdef(k.oid))) as result
from pg_constraint k join pg_class f on f.oid = k.conrelid join pg_namespace fn on fn.oid = f.relnamespace join pg_class t on t.oid = k.confrelid join pg_namespace tn on tn.oid = t.relnamespace
where k.contype = 'f' and (fn.nspname = 'public' or tn.nspname = 'public');
