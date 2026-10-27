"""Run schema.sql + self_test.sql against a throwaway local PostgreSQL.

Usage:  python run_local.py <path-to-postgres-bin-dir>
Needs:  pip install "psycopg[binary]"

Creates minimal stand-ins for the parts of Supabase the schema touches
(auth.users / auth.uid(), storage, realtime, the API roles), applies the
schema twice (to prove it is re-runnable), then prints the self-test table.
Nothing touches your real Supabase project. The Postgres install needs the
pgcrypto extension (Supabase has it built in; some minimal builds do not).
"""
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time

import psycopg

HERE = pathlib.Path(__file__).resolve().parent
SCHEMA = (HERE.parent / "schema.sql").read_text(encoding="utf-8")
SELF_TEST = (HERE.parent / "self_test.sql").read_text(encoding="utf-8")

SUPABASE_STUBS = r"""
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;
grant anon, authenticated, service_role to postgres;

create schema auth;
create table auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  is_anonymous boolean not null default false,
  created_at timestamptz not null default now()
);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
grant usage on schema auth to anon, authenticated;
grant execute on function auth.uid() to anon, authenticated;

create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;

create schema realtime;
create table realtime.messages (id bigserial primary key, topic text, extension text);
alter table realtime.messages enable row level security;
create function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
grant usage on schema realtime to authenticated;
grant execute on function realtime.topic() to authenticated;

create publication supabase_realtime;
"""


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    bindir = pathlib.Path(sys.argv[1])
    exe = ".exe" if sys.platform == "win32" else ""
    data = pathlib.Path(tempfile.mkdtemp(prefix="jeemock-pg-"))
    port = free_port()
    log = data / "server.log"
    try:
        subprocess.run([str(bindir / f"initdb{exe}"), "-D", str(data / "db"), "-U", "postgres", "--auth=trust", "-E", "UTF8"],
                       check=True, stdout=subprocess.DEVNULL)
        subprocess.run([str(bindir / f"pg_ctl{exe}"), "-D", str(data / "db"), "-l", str(log), "-o", f"-p {port} -h 127.0.0.1", "-w", "start"],
                       check=True, stdout=subprocess.DEVNULL)
        dsn = f"host=127.0.0.1 port={port} user=postgres dbname=postgres"
        for _ in range(30):
            try:
                psycopg.connect(dsn).close()
                break
            except psycopg.OperationalError:
                time.sleep(0.5)

        with psycopg.connect(dsn, autocommit=True) as conn:
            conn.execute(SUPABASE_STUBS)
            for run in (1, 2):
                conn.execute(SCHEMA)
                print(f"schema.sql applied (run {run}) OK")

        with psycopg.connect(dsn, autocommit=True) as conn:
            body, report = SELF_TEST.rsplit("select n as", 1)
            conn.execute(body)
            rows = conn.execute("select n as" + report).fetchall()
            failed = 0
            for n, result, test, detail in rows:
                mark = "PASS" if result == "PASS" else "FAIL"
                failed += mark == "FAIL"
                print(f"{n:>3}  {mark}  {test}" + (f"   [{detail}]" if mark == "FAIL" else ""))
            print(f"\n{len(rows) - failed}/{len(rows)} checks passed")
            leftovers = conn.execute("select count(*) from public.papers where title like '[selftest]%'").fetchone()[0]
            print("fixtures cleaned up OK" if leftovers == 0 else f"{leftovers} test papers left behind FAILED")
            sys.exit(1 if failed or leftovers else 0)
    finally:
        subprocess.run([str(bindir / f"pg_ctl{exe}"), "-D", str(data / "db"), "-m", "immediate", "stop"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        shutil.rmtree(data, ignore_errors=True)


if __name__ == "__main__":
    main()
