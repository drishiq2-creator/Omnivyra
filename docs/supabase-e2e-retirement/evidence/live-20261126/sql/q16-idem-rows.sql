select json_agg(json_build_object(
 'id', id, 'scope', scope, 'status', status, 'response_status', response_status,
 'idempotency_key_md5_prefix', left(md5(idempotency_key), 8), 'idempotency_key_length', length(idempotency_key),
 'request_hash_length', length(request_hash), 'request_id_present', request_id is not null,
 'caller_id_md5_prefix', left(md5(coalesce(caller_id, '')), 8), 'caller_id_present', caller_id is not null,
 'locked_at', locked_at, 'created_at', created_at, 'updated_at', updated_at,
 'last_error_present', last_error is not null, 'last_error_length', length(last_error),
 'response_body_type', jsonb_typeof(response_body),
 'response_body_top_level_keys', case when jsonb_typeof(response_body) = 'object' then (select json_agg(k order by k) from jsonb_object_keys(response_body) k) end
) order by created_at) as result from public.api_idempotency_keys;
