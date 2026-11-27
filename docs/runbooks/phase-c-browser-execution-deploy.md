# Phase C browser execution: deploy order

Applies to the release that ships the durable RPA claim (worker) and the Postgres extension handshake (web). Two migrations belong to that release. **Neither has been applied anywhere yet.** Apply each one only with explicit authorization, using `psql -v ON_ERROR_STOP=1 -f <file>` as `docs/migration-discipline.md` describes. Never use `supabase db push`.

| Migration | Needed by | Rule |
|---|---|---|
| `supabase/migrations/20270314000001_rpa_retry_queue_claim.sql` | the RPA worker (Railway) | Apply it **together with** the release. Old and new workers must **never overlap**. |
| `supabase/migrations/20270314000010_extension_handshake_store.sql` | the web app (Vercel) | Apply it **before** the web deploy. |

## 0. Before merging: scale the worker to 0

A merge to `main` triggers the Railway worker deploy by itself, and that deploy is rolling (the new container starts before the old one stops). Merging first would therefore start the new worker next to the old one, which is the overlap that can double-execute a row (section 2).

1. Before merging, scale the RPA worker service to 0 replicas in Railway.
2. Verify that 0 replicas are running (Railway service view or `railway status`). Do not merge until this is confirmed.
3. Merge. The deploy the merge triggers then starts the new worker alone. Apply 20270314000001 before you scale the worker back up (section 2).

## 1. Extension handshake store (20270314000010): before the web deploy

The new web code keeps claim codes and request nonces in Postgres. It calls `extension_claim_code_issue`, `extension_claim_code_peek`, `extension_claim_code_redeem` and `extension_request_nonce_record`. If a web deploy goes out before this migration, every extension route fails closed with a 503. That covers bootstrap, redeem and every signed request, so the extension is down until the migration is applied.

1. Apply `20270314000010_extension_handshake_store.sql`. The postcondition block prints `EHS: ... verified`.
2. Deploy the web app.
3. Rollback: roll the web app back first, then apply `supabase/migrations/rollbacks/extension_handshake_store_rollback.sql`.

## 2. RPA retry-queue claim (20270314000001): with the release, no worker overlap

The new worker claims each `rpa_retry_queue` row with a token, renews the lease right before it runs the row, and finalises the row only while the token still matches. The **old** worker's flush reads due rows with a plain SELECT and ignores `claim_token`. An old worker running next to a new one can therefore execute a row the new worker has claimed. The result is a **double post or a double like**.

1. Stop the old RPA worker, every replica, BEFORE the merge (section 0). Confirm that none is running. Railway's default rolling deploy starts the new container before it stops the old one, so do not rely on it.
2. Apply `20270314000001_rpa_retry_queue_claim.sql`. Its postcondition block raises if any of its six functions is missing, is not SECURITY INVOKER, or is executable by anyone except service_role.
3. Start the new worker.
4. The first flush parks every claim whose lease has expired as `RPA_OUTCOME_UNKNOWN:CLAIM_EXPIRED` and never re-runs it. A row that was claimed but never attempted is released as `RPA_CLAIM_RELEASED_NOT_ATTEMPTED:*` with its attempts unchanged.

Rollback: stop the new worker first (again with no overlap), deploy the old code, then apply `supabase/migrations/rollbacks/rpa_retry_queue_claim_rollback.sql`. The rollback refuses to run while any row is still claimed.

## 3. Web vs worker order for this release

- The web app accepts RPA work into `rpa_retry_queue` through `rpa_retry_queue_accept`, so 20270314000001 must also be in place before a web deploy that queues RPA. Applying both migrations before either deploy satisfies every rule above.
- An RPA execute without an approval of record gets an approval-required answer. It is never queued, because the worker gate would refuse it.

## 4. Existing playbooks after deploy (browser default, item D)

New playbooks are created with `execution_modes.browser_allowed = false`
("Not allowed": no requested browser execution and no API -> browser
fallback). Both the editor default and the server create path
(`playbookService.createPlaybook`) write it; a create payload with the flag
absent or null is stored as `false`. Only a company admin (or platform super
admin) can save playbooks (`/api/community-ai/playbooks`, MANAGE_PLAYBOOKS), so
only that role can switch a playbook to "Allowed".

Existing playbooks are NOT migrated. A playbook saved before this release has
the key absent ("Not set"); after deploy it behaves exactly as before:
requested browser refused, system API -> browser fallback allowed. Editing such
a playbook and leaving the select on "Not set" keeps the key absent. Nothing is
silently disabled; an admin who wants it off picks "Not allowed".

Before deploy, count what is out there (read-only, prod via the Mgmt API query
path):

```sql
SELECT CASE
         WHEN execution_modes IS NULL                         THEN 'no_block'
         WHEN NOT (execution_modes ? 'browser_allowed')       THEN 'key_absent'
         WHEN execution_modes->'browser_allowed' = 'null'::jsonb THEN 'null'
         ELSE execution_modes->>'browser_allowed'
       END                                   AS browser_allowed,
       status,
       count(*)                              AS playbooks
FROM public.community_ai_playbooks
GROUP BY 1, 2
ORDER BY 1, 2;

-- actions in the last 90 days that took the API -> browser fallback,
-- split by the playbook's flag (no_playbook = playbook-less manual dispatch)
SELECT CASE
         WHEN a.playbook_id IS NULL                              THEN 'no_playbook'
         WHEN p.id IS NULL                                       THEN 'playbook_missing'
         WHEN p.execution_modes IS NULL                          THEN 'no_block'
         WHEN NOT (p.execution_modes ? 'browser_allowed')        THEN 'key_absent'
         ELSE p.execution_modes->>'browser_allowed'
       END                                   AS browser_allowed,
       count(DISTINCT m.action_id)           AS actions,
       count(DISTINCT m.organization_id)     AS companies
FROM public.community_ai_execution_metric_events m
LEFT JOIN public.community_ai_actions   a ON a.id = m.action_id
LEFT JOIN public.community_ai_playbooks p ON p.id = a.playbook_id
WHERE m.event_type = 'fallback_triggered'
  AND m.created_at >= now() - interval '90 days'
GROUP BY 1
ORDER BY 1;
```

`key_absent` / `no_block` rows in the second query are the workflows that keep
working only because existing playbooks were not migrated.

## 5. Extension sessions after a company is suspended or a member removed (items E/F)

Every signed extension route (`requireExtensionAuth`: validate, commands,
action-result, dispatch/renew, events ingest, health, capabilities and the
Sales Navigator extension routes) now re-applies the extension membership rule
on each request: an active `user_company_roles` row for the session's user in
the session's pinned company AND `companies.status = 'active'`. No platform
super-admin bypass. One membership + one company read per signed request, no
cache.

- Suspended company / removed or deactivated member: `403 { error: 'Access
  denied to organization', code: 'EXTENSION_MEMBERSHIP_INACTIVE', reason }`.
  On /validate the extension maps that body to ORG_ACCESS_REVOKED and signs
  out; on other routes it keeps the session until its next validate (about
  60 s), which then signs it out.
- Lookup outage: `503 TENANT_LOOKUP_ERROR` (no access; the extension keeps the
  session and retries).
- Pairing while suspended: bootstrap and redeem refuse
  (`EXTENSION_MEMBERSHIP_REQUIRED`); a platform super admin with no active role
  in the company gets `EXTENSION_PLATFORM_ADMIN_NOT_MEMBER` (a Company Admin of
  that company must pair, or the admin needs a real role there).
- Reactivation: new pairings work. An unexpired old token (12 h TTL) is
  accepted again: there is no per-session revocation list. In practice the
  extension already signed itself out at its first validate during the
  suspension and must be paired again.
- A lease handed out BEFORE the suspension: the extension's action-result and
  dispatch/renew are refused, so the outcome is not recorded. The row stays
  `pending` with a claimed, then lapsed, lease: delivery state unknown. Clients
  that send `X-Omnivyra-Dispatch-Renewal: 1` are never re-offered a claimed row;
  it shows in `listClaimedUnknownDispatches` for an operator decision. Legacy
  (v1.3.9) clients are re-offered lapsed leases by /api/extension/commands
  after reactivation, which can resend (pre-existing path, see
  engagementDispatchRecoveryService.ts). Check before reactivating a company:

```sql
SELECT id, platform, action_type, dispatch_lease_expires_at, dispatch_acknowledged_at
FROM public.community_ai_actions
WHERE organization_id = '<company id>'
  AND status = 'pending' AND execution_mode = 'browser'
  AND dispatch_lease_id IS NOT NULL;
```
