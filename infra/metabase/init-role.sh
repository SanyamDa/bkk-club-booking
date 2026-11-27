#!/bin/sh
# B14: one-shot setup for Metabase, run by the `metabase-init` compose service after the app has
# migrated the database. Idempotent.
#   1. metabase_ro gets LOGIN and its password (the migration creates it NOLOGIN, with no secret).
#      It can read only the analytics and analytics_demo schemas, and every transaction is read-only.
#   2. A separate `metabase` database holds Metabase's own settings. It is owned by metabase_app, a
#      plain LOGIN role (no SUPERUSER, CREATEDB, CREATEROLE) that the Metabase container uses. Metabase
#      never gets the superuser's credentials, which stay in this one-shot container only.
# Needs: PGHOST, PGUSER, PGPASSWORD, PGDATABASE (the main superuser), METABASE_DB_PASSWORD and
# METABASE_APP_DB_PASSWORD.
set -eu
: "${METABASE_DB_PASSWORD:?set METABASE_DB_PASSWORD}"
: "${METABASE_APP_DB_PASSWORD:?set METABASE_APP_DB_PASSWORD}"

psql -v ON_ERROR_STOP=1 -v pw="$METABASE_DB_PASSWORD" -v apppw="$METABASE_APP_DB_PASSWORD" <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_ro') THEN CREATE ROLE metabase_ro NOLOGIN; END IF;
END $$;
ALTER ROLE metabase_ro WITH LOGIN PASSWORD :'pw';
ALTER ROLE metabase_ro SET default_transaction_read_only = on;
REVOKE ALL ON SCHEMA analytics_src FROM PUBLIC;
GRANT USAGE ON SCHEMA analytics, analytics_demo TO metabase_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA analytics, analytics_demo TO metabase_ro;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_app') THEN CREATE ROLE metabase_app NOLOGIN; END IF;
END $$;
ALTER ROLE metabase_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'apppw';
SELECT 'CREATE DATABASE metabase OWNER metabase_app' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'metabase') \gexec
ALTER DATABASE metabase OWNER TO metabase_app;
-- metabase_app may connect only to its own database, never to the club database.
REVOKE CONNECT ON DATABASE :"DBNAME" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"DBNAME" TO metabase_ro;
SQL
echo "metabase_ro and metabase_app ready"
