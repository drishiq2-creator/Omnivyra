-- Extensions the governed schema baseline expects, installed into the `extensions`
-- schema exactly as scripts/ci/schema-bootstrap.sql does for real-schema-ci.
--
-- ONLY the extension lines are taken from schema-bootstrap.sql. The rest of that file
-- (role creation, auth.* helper functions, a stub auth.users table) is a plain-Postgres
-- scaffold and MUST NOT be applied to a real Supabase stack: it would REPLACE GoTrue's
-- own auth.uid()/auth.role()/auth.email()/auth.jwt() functions. The Supabase stack
-- already provides those roles, schemas and functions natively.
--
-- Applied by tests/supabase-local/bootstrap.sh with ON_ERROR_STOP=1, against the
-- disposable local stack only.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS btree_gin WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
