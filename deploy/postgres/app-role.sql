-- Creates or updates the role the API connects as. Run by the db-roles service with the
-- PostgreSQL superuser on every start, so existing volumes are upgraded too.
--
-- The application role is not a superuser and cannot bypass row-level security, so the
-- tenant isolation policies on aspectenant_* tables apply to every API query. It owns the
-- tables so the API can run its own migrations; FORCE ROW LEVEL SECURITY makes the
-- policies apply to the owner as well.
--
-- Usage: psql -v ON_ERROR_STOP=1 -v app_password=... -f app-role.sql

SELECT format('CREATE ROLE aspectenant_app LOGIN PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'aspectenant_app')\gexec

ALTER ROLE aspectenant_app WITH LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE
  PASSWORD :'app_password';

SELECT format('GRANT CONNECT ON DATABASE %I TO aspectenant_app', current_database())\gexec
GRANT USAGE, CREATE ON SCHEMA public TO aspectenant_app;

-- Tables created by earlier releases belong to the superuser. Hand them to the application role.
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN
    SELECT c.relname, c.relkind
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'S', 'v', 'm')
      AND pg_get_userbyid(c.relowner) <> 'aspectenant_app'
      -- Sequences owned by a column move with their table.
      AND NOT (
        c.relkind = 'S'
        AND EXISTS (
          SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.deptype IN ('a', 'i')
        )
      )
  LOOP
    EXECUTE format(
      'ALTER %s public.%I OWNER TO aspectenant_app',
      CASE r.relkind
        WHEN 'S' THEN 'SEQUENCE'
        WHEN 'v' THEN 'VIEW'
        WHEN 'm' THEN 'MATERIALIZED VIEW'
        ELSE 'TABLE'
      END,
      r.relname
    );
  END LOOP;
END
$$;
