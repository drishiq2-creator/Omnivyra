# Phase C browser execution: deploy order

Applies to the release that ships the durable RPA claim (worker) and the Postgres extension handshake (web). Two migrations belong to that release. **Neither has been applied anywhere yet.** Apply each one only with explicit authorization, using `psql -v ON_ERROR_STOP=1 -f <file>` as `docs/migration-discipline.md` describes. Never use `supabase db push`.

| Migration | Needed by | Rule |
|---|---|---|
| `supabase/migrations/20270314000001_rpa_retry_queue_claim.sql` | the RPA worker (Railway) | Apply it **together with** the release. Old and new workers must **never overlap**. |
| `supabase/migrations/20270314000010_extension_handshake_store.sql` | the web app (Vercel) | Apply it **before** the web deploy. |

## 1. Extension handshake store (20270314000010): before the web deploy

The new web code keeps claim codes and request nonces in Postgres. It calls `extension_claim_code_issue`, `extension_claim_code_peek`, `extension_claim_code_redeem` and `extension_request_nonce_record`. If a web deploy goes out before this migration, every extension route fails closed with a 503. That covers bootstrap, redeem and every signed request, so the extension is down until the migration is applied.

1. Apply `20270314000010_extension_handshake_store.sql`. The postcondition block prints `EHS: ... verified`.
2. Deploy the web app.
3. Rollback: roll the web app back first, then apply `supabase/migrations/rollbacks/extension_handshake_store_rollback.sql`.

## 2. RPA retry-queue claim (20270314000001): with the release, no worker overlap

The new worker claims each `rpa_retry_queue` row with a token, renews the lease right before it runs the row, and finalises the row only while the token still matches. The **old** worker's flush reads due rows with a plain SELECT and ignores `claim_token`. An old worker running next to a new one can therefore execute a row the new worker has claimed. The result is a **double post or a double like**.

1. Stop the old RPA worker, every replica. Confirm that none is running. Railway's default rolling deploy starts the new container before it stops the old one, so do not rely on it. Scale the worker to 0 first, or use a stop-then-start deploy.
2. Apply `20270314000001_rpa_retry_queue_claim.sql`. Its postcondition block raises if any of its six functions is missing, is not SECURITY INVOKER, or is executable by anyone except service_role.
3. Start the new worker.
4. The first flush parks every claim whose lease has expired as `RPA_OUTCOME_UNKNOWN:CLAIM_EXPIRED` and never re-runs it. A row that was claimed but never attempted is released as `RPA_CLAIM_RELEASED_NOT_ATTEMPTED:*` with its attempts unchanged.

Rollback: stop the new worker first (again with no overlap), deploy the old code, then apply `supabase/migrations/rollbacks/rpa_retry_queue_claim_rollback.sql`. The rollback refuses to run while any row is still claimed.

## 3. Web vs worker order for this release

- The web app accepts RPA work into `rpa_retry_queue` through `rpa_retry_queue_accept`, so 20270314000001 must also be in place before a web deploy that queues RPA. Applying both migrations before either deploy satisfies every rule above.
- An RPA execute without an approval of record gets an approval-required answer. It is never queued, because the worker gate would refuse it.
