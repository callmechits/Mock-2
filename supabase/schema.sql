-- ════════════════════════════════════════════════════════════════════════════
--  JEE Mains Mock — database, security rules and all server logic
--
--  Paste this whole file into Supabase → SQL Editor → Run.
--  It is idempotent: re-running it upgrades functions/policies in place.
--
--  SECURITY MODEL
--   • Students never read or write tables. Everything a student can do is one
--     of the functions in section 7, and each one checks identity, timing and
--     ownership itself. The browser is treated as hostile.
--   • Students sign in anonymously and identify with a Reddit username + PIN,
--     per paper. The database keeps only a keyed hash of the name (one attempt
--     per name), a bcrypt hash of the PIN, and the name encrypted with a key
--     that never leaves the database. Names are decrypted onto the leaderboard
--     when results publish; "Flush personal data" deletes everything else.
--   • Answer keys and solutions stay in the database until a paper's results
--     are published (after the paper ends). Scores are computed here.
--   • Staff (editor / admin) sign in with Google/Discord and edit papers and
--     questions through row-level security. Every edit is versioned and
--     written to an audit log.
--   • Nothing in this file trusts the client clock.
-- ════════════════════════════════════════════════════════════════════════════


-- ─── 0. Schemas, extensions and secure defaults ─────────────────────────────
-- `private` is NOT exposed through the REST API, so nothing in it can be
-- called or read from a browser, even by staff.
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;   -- needed by RLS policies only

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- New functions are not executable by everyone by default; new tables are not
-- auto-granted to the API roles. Every grant in this file is explicit.
alter default privileges for role postgres revoke execute on functions from public;
alter default privileges for role postgres in schema public revoke all on tables    from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;


-- ─── 1. Small pure helpers ──────────────────────────────────────────────────
create or replace function private.valid_img(p text) returns boolean
language sql immutable set search_path = '' as $$
  -- images live at  <paper uuid>/<random uuid>.<ext>  in the `qimg` bucket
  select p is null or p ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|png|jpg)$'
$$;

create or replace function private.valid_img_array(p text[]) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(bool_and(private.valid_img(x)), true) from unnest(p) as x
$$;

create or replace function private.grace() returns interval
language sql immutable set search_path = '' as $$
  select interval '30 seconds'   -- network slack after a deadline
$$;

create or replace function private.subject_rank(s text) returns int
language sql immutable set search_path = '' as $$
  select array_position(array['physics','chemistry','mathematics'], s)
$$;

create or replace function private.slot_label(s text, n int) returns text
language sql immutable set search_path = '' as $$
  select upper(left(s, 1)) || n
$$;

create or replace function private.q_complete(body text, image text, slot int, opts text[], cmin numeric, cmax numeric)
returns boolean language sql immutable set search_path = '' as $$
  select (btrim(coalesce(body, '')) <> '' or image is not null)
     and case when slot <= 20 then cardinality(opts) > 0
              else cmin is not null and cmax is not null end
$$;

-- "u/Some_Name" → "Some_Name"; null when it isn't a valid Reddit username.
create or replace function private.clean_reddit(p text) returns text
language sql immutable set search_path = '' as $$
  select case when x ~ '^[A-Za-z0-9_-]{3,20}$' then x end
  from (select regexp_replace(btrim(coalesce(p, '')), '^/?u/', '', 'i') as x) s
$$;


-- ─── 2. Tables ──────────────────────────────────────────────────────────────
-- Profiles exist only for real (staff) accounts — never for anonymous students.
create table if not exists public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  handle            text check (handle ~ '^[A-Za-z0-9_]{3,20}$'),
  full_name         text not null default '' check (char_length(full_name) <= 80),
  banned            boolean not null default false,
  handle_changed_at timestamptz,
  created_at        timestamptz not null default now()
);
create unique index if not exists profiles_handle_lower on public.profiles (lower(handle));

create table if not exists public.staff (
  user_id  uuid primary key references auth.users(id) on delete cascade,
  role     text not null check (role in ('admin', 'editor')),
  added_by uuid references auth.users(id) on delete set null,
  added_at timestamptz not null default now()
);

create table if not exists public.papers (
  id               uuid primary key default gen_random_uuid(),
  title            text not null check (char_length(title) between 1 and 120),
  description      text not null default '' check (char_length(description) <= 2000),
  starts_at        timestamptz not null,
  ends_at          timestamptz not null,
  entry_window_min int not null default 30  check (entry_window_min between 1 and 1440),
  duration_min     int not null default 180 check (duration_min between 10 and 600),
  -- JEE Main (2024+): both sections +4 / −1
  scq_correct      int not null default 4  check (scq_correct between 0 and 10),
  scq_wrong        int not null default -1 check (scq_wrong between -10 and 0),
  num_correct      int not null default 4  check (num_correct between 0 and 10),
  num_wrong        int not null default -1 check (num_wrong between -10 and 0),
  allow_practice   boolean not null default true,
  status           text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  results_at       timestamptz,          -- set when the leaderboard is built
  results_count    int,
  key_changed_at   timestamptz,          -- answer key edited after results → rescore needed
  flushed_at       timestamptz,          -- personal data (attempts, name hashes, PINs) deleted
  created_by       uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_by       uuid references auth.users(id) on delete set null,
  updated_at       timestamptz not null default now(),
  version          int not null default 1,
  constraint papers_time_order check (ends_at > starts_at)
);
alter table public.papers add column if not exists flushed_at timestamptz;

-- Every paper has exactly 75 fixed slots: 25 per subject; slots 1–20 are
-- Section A (single correct), 21–25 are Section B (numerical value).
create table if not exists public.questions (
  id                  uuid primary key default gen_random_uuid(),
  paper_id            uuid not null references public.papers(id) on delete cascade,
  subject             text not null check (subject in ('physics', 'chemistry', 'mathematics')),
  slot                int  not null check (slot between 1 and 25),
  kind                text generated always as (case when slot <= 20 then 'scq' else 'numerical' end) stored,
  body                text not null default '' check (char_length(body) <= 20000),
  image_path          text check (private.valid_img(image_path)),
  options             text[] not null default array['', '', '', '']
                        check (cardinality(options) = 4 and char_length(array_to_string(options, '')) <= 8000),
  option_images       text[] not null default array[null, null, null, null]::text[]
                        check (cardinality(option_images) = 4 and private.valid_img_array(option_images)),
  correct_options     text[] not null default '{}' check (correct_options <@ array['A', 'B', 'C', 'D']),
  correct_min         numeric,
  correct_max         numeric,
  solution            text not null default '' check (char_length(solution) <= 20000),
  solution_image_path text check (private.valid_img(solution_image_path)),
  bonus               boolean not null default false,   -- dropped question: full marks to everyone
  note                text not null default '' check (char_length(note) <= 2000),  -- staff-only
  verified            boolean not null default false,
  verified_by         uuid references auth.users(id) on delete set null,
  verified_at         timestamptz,
  updated_by          uuid references auth.users(id) on delete set null,
  updated_at          timestamptz not null default now(),
  version             int not null default 1,
  unique (paper_id, subject, slot),
  check (correct_min is null or correct_max is null or correct_min <= correct_max),
  check ((slot <= 20 and correct_min is null and correct_max is null)
      or (slot >  20 and cardinality(correct_options) = 0))
);

create table if not exists public.attempts (
  id                uuid primary key default gen_random_uuid(),
  paper_id          uuid not null references public.papers(id) on delete cascade,
  user_id           uuid references auth.users(id) on delete set null,   -- session currently holding it
  prev_users        uuid[] not null default '{}',                        -- sessions it was taken over from
  practice          boolean not null default false,
  name_hash         bytea,          -- HMAC of the lower-cased Reddit username (ranked attempts)
  name_enc          bytea,          -- the username, encrypted; decrypted only for results / admins
  pin_hash          text,           -- bcrypt
  pin_fails         int not null default 0,
  pin_locked_until  timestamptz,
  status            text not null default 'in_progress' check (status in ('in_progress', 'submitted', 'expired')),
  started_at        timestamptz not null default now(),
  deadline_at       timestamptz not null,
  submitted_at      timestamptz,
  responses         jsonb not null default '{}'::jsonb,   -- { question_id: { a, s, t } } (server-cleaned)
  seq               bigint not null default 0,            -- last applied client save
  client_token      uuid,                                 -- the one tab/device allowed to write
  sessions          int not null default 1,
  violations        jsonb not null default '{}'::jsonb,
  last_saved_at     timestamptz,
  last_violation_at timestamptz,
  score             int, score_physics int, score_chemistry int, score_mathematics int,
  n_correct         int, n_wrong int, n_unattempted int,
  scored_at         timestamptz
);
-- upgrades from the first version (Google-login students)
alter table public.attempts add column if not exists prev_users uuid[] not null default '{}';
alter table public.attempts add column if not exists name_hash bytea;
alter table public.attempts add column if not exists name_enc bytea;
alter table public.attempts add column if not exists pin_hash text;
alter table public.attempts add column if not exists pin_fails int not null default 0;
alter table public.attempts add column if not exists pin_locked_until timestamptz;
alter table public.attempts alter column user_id drop not null;
alter table public.attempts drop constraint if exists attempts_user_id_fkey;
alter table public.attempts add constraint attempts_user_id_fkey foreign key (user_id) references auth.users(id) on delete set null;

create unique index if not exists attempts_one_ranked        on public.attempts (paper_id, user_id) where not practice;
create unique index if not exists attempts_one_ranked_name   on public.attempts (paper_id, name_hash) where not practice;
create unique index if not exists attempts_one_open_practice on public.attempts (paper_id, user_id) where practice and status = 'in_progress';
create index if not exists attempts_user          on public.attempts (user_id);
create index if not exists attempts_paper_status  on public.attempts (paper_id, status);
create index if not exists attempts_open_deadline on public.attempts (deadline_at) where status = 'in_progress';

-- Server-only tables (not reachable through the API at all)
create table if not exists private.settings (
  key   text primary key,
  value text not null
);

create table if not exists private.banned_names (
  name_hash bytea primary key,
  name_enc  bytea,
  banned_by uuid,
  banned_at timestamptz not null default now()
);

create table if not exists private.paper_payloads (
  paper_id uuid primary key references public.papers(id) on delete cascade,
  payload  jsonb not null,
  built_at timestamptz not null default now()
);

-- The first version keyed the leaderboard by account; it's derived data, so the
-- old layout is simply dropped (Settings → "Re-score & rebuild results" rebuilds it).
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'private' and table_name = 'leaderboard' and column_name = 'user_id') then
    drop table private.leaderboard;
  end if;
end $$;

create table if not exists private.leaderboard (
  id                bigint generated always as identity primary key,
  paper_id          uuid not null references public.papers(id) on delete cascade,
  attempt_id        uuid references public.attempts(id) on delete set null,   -- null once flushed
  name_hash         bytea not null,
  rank              int not null,
  handle            text not null,     -- the Reddit username, public once results are out
  score             int not null,
  score_physics     int not null,
  score_chemistry   int not null,
  score_mathematics int not null,
  n_correct         int not null,
  n_wrong           int not null,
  percentile        numeric(6, 3) not null
);
create unique index if not exists leaderboard_paper_handle on private.leaderboard (paper_id, lower(handle));
create index if not exists leaderboard_rank    on private.leaderboard (paper_id, rank);
create index if not exists leaderboard_attempt on private.leaderboard (attempt_id);
create index if not exists leaderboard_name    on private.leaderboard (name_hash);

create table if not exists private.question_stats (
  question_id uuid primary key references public.questions(id) on delete cascade,
  attempted   int not null,
  correct     int not null
);

create table if not exists private.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor       uuid,
  action      text not null,
  paper_id    uuid,
  question_id uuid,
  detail      jsonb not null default '{}'::jsonb
);
create index if not exists audit_paper    on private.audit_log (paper_id, at desc);
create index if not exists audit_question on private.audit_log (question_id, at desc);


-- ─── 3. Role checks ─────────────────────────────────────────────────────────
create or replace function private.is_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff where user_id = auth.uid())
$$;

create or replace function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.staff where user_id = auth.uid() and role = 'admin')
$$;

create or replace function private.audit(p_action text, p_paper uuid, p_question uuid, p_detail jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into private.audit_log (actor, action, paper_id, question_id, detail)
  values (auth.uid(), p_action, p_paper, p_question, coalesce(p_detail, '{}'::jsonb))
$$;


-- ─── 3b. Reddit-name crypto ─────────────────────────────────────────────────
-- One random 256-bit key: kept in Supabase Vault when available (encrypted at
-- rest, outside table dumps), otherwise in private.settings. It is created once
-- and must never be deleted or changed — names could no longer be matched or
-- decrypted for results.
do $$
begin
  if exists (select 1 from private.settings where key = 'identity_key') then return; end if;
  if exists (select 1 from pg_extension where extname = 'supabase_vault') then
    begin
      if not exists (select 1 from vault.secrets where name = 'jeemock_identity_key') then
        perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'jeemock_identity_key',
                                    'JEE mock: key for hashing/encrypting Reddit usernames. Never delete or change.');
      end if;
      return;
    exception when others then
      raise notice 'Vault unavailable (%), storing the identity key in private.settings', sqlerrm;
    end;
  end if;
  insert into private.settings (key, value) values ('identity_key', encode(extensions.gen_random_bytes(32), 'hex'))
  on conflict (key) do nothing;
end $$;

create or replace function private.identity_key() returns text
language plpgsql stable security definer set search_path = '' as $$
declare k text;
begin
  select value into k from private.settings where key = 'identity_key';
  if k is null then
    begin
      execute 'select decrypted_secret from vault.decrypted_secrets where name = $1 limit 1' into k using 'jeemock_identity_key';
    exception when others then
      k := null;
    end;
  end if;
  if k is null then raise exception 'identity key missing — run schema.sql again'; end if;
  return k;
end $$;

create or replace function private.name_hash(p_name text, p_key text) returns bytea
language sql immutable set search_path = '' as $$
  select extensions.hmac(lower(p_name), p_key, 'sha256')
$$;

create or replace function private.name_enc(p_name text, p_key text) returns bytea
language sql volatile set search_path = '' as $$
  select extensions.pgp_sym_encrypt(p_name, p_key, 'cipher-algo=aes256, s2k-mode=1')
$$;

create or replace function private.name_dec(p_enc bytea, p_key text) returns text
language sql immutable set search_path = '' as $$
  select case when p_enc is null then null else extensions.pgp_sym_decrypt(p_enc, p_key) end
$$;

-- Checks a PIN against an attempt; 5 wrong tries lock it for 15 minutes.
-- Returns null when the PIN is right, otherwise an error object.
create or replace function private.check_pin(p_attempt uuid, p_pin text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.attempts; n timestamptz := now(); fails int;
begin
  select * into a from public.attempts where id = p_attempt for update;
  if a.pin_locked_until > n then
    return jsonb_build_object('error', 'pin_locked', 'until', a.pin_locked_until);
  end if;
  if a.pin_hash is not null and extensions.crypt(coalesce(p_pin, ''), a.pin_hash) = a.pin_hash then
    update public.attempts set pin_fails = 0, pin_locked_until = null where id = a.id;
    return null;
  end if;
  fails := a.pin_fails + 1;
  if fails >= 5 then
    update public.attempts set pin_fails = 0, pin_locked_until = n + interval '15 minutes' where id = a.id;
    return jsonb_build_object('error', 'pin_locked', 'until', n + interval '15 minutes');
  end if;
  update public.attempts set pin_fails = fails where id = a.id;
  return jsonb_build_object('error', 'pin_wrong', 'tries_left', 5 - fails);
end $$;


-- ─── 4. Exam payload (what a student receives — never answers) ──────────────
create or replace function private.build_payload(p_paper uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id, 'title', p.title, 'duration_min', p.duration_min,
    'marks', jsonb_build_object(
      'scq',       jsonb_build_object('correct', p.scq_correct, 'wrong', p.scq_wrong),
      'numerical', jsonb_build_object('correct', p.num_correct, 'wrong', p.num_wrong)),
    'questions', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', q.id, 'subject', q.subject, 'slot', q.slot, 'kind', q.kind,
               'body', q.body, 'image', q.image_path,
               'options',       case when q.slot <= 20 then to_jsonb(q.options) end,
               'option_images', case when q.slot <= 20 then to_jsonb(q.option_images) end)
             order by private.subject_rank(q.subject), q.slot)
      from public.questions q where q.paper_id = p.id), '[]'::jsonb))
  from public.papers p where p.id = p_paper
$$;

create or replace function private.refresh_payload(p_paper uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pl jsonb := private.build_payload(p_paper);
begin
  if pl is null then return null; end if;
  insert into private.paper_payloads (paper_id, payload, built_at) values (p_paper, pl, now())
  on conflict (paper_id) do update set payload = excluded.payload, built_at = excluded.built_at;
  return pl;
end $$;


-- ─── 5. Scoring ─────────────────────────────────────────────────────────────
-- Keeps only known question ids and well-formed answers. Anything else the
-- client sends is dropped.
create or replace function private.clean_responses(p_paper uuid, p_in jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_object_agg(q.id::text, jsonb_build_object(
           'a', v.a,
           's', case when v.a is not null then (case when v.s in ('ma', 'mr') then 'ma' else 'an' end)
                     else (case when v.s in ('ma', 'mr') then 'mr' else 'na' end) end,
           't', v.t)), '{}'::jsonb)
  from public.questions q
  cross join lateral (select p_in -> q.id::text as e) r
  cross join lateral (select
      case when q.slot <= 20 and (r.e ->> 'a') in ('A', 'B', 'C', 'D') then r.e ->> 'a'
           when q.slot >  20 and (r.e ->> 'a') ~ '^-?[0-9]{1,7}(\.[0-9]{1,4})?$' then r.e ->> 'a'
      end as a,
      r.e ->> 's' as s,
      case when jsonb_typeof(r.e -> 't') = 'number'
           then least(greatest((r.e ->> 't')::numeric, 0), 86400000)::bigint else 0 end as t) v
  where q.paper_id = p_paper and jsonb_typeof(r.e) = 'object'
$$;

-- Per-question marks for attempts of one paper (current answer key).
create or replace function private.question_marks(p_paper uuid, p_ids uuid[] default null)
returns table (attempt_id uuid, practice boolean, question_id uuid, subject text, tried boolean, ok boolean, marks int)
language sql stable security definer set search_path = '' as $$
  select a.id, a.practice, q.id, q.subject, r.ans is not null, k.ok,
         case when k.ok is null then 0
              when k.ok then (case when q.slot <= 20 then p.scq_correct else p.num_correct end)
              else           (case when q.slot <= 20 then p.scq_wrong   else p.num_wrong   end) end
  from public.papers p
  join public.questions q on q.paper_id = p.id
  join public.attempts  a on a.paper_id = p.id
  cross join lateral (select nullif(a.responses -> q.id::text ->> 'a', '') as ans) r
  cross join lateral (select case
      when q.bonus then true
      when r.ans is null then null
      when q.slot <= 20 then coalesce(r.ans = any(q.correct_options), false)
      when r.ans ~ '^-?[0-9]{1,7}(\.[0-9]{1,4})?$'
        then coalesce(r.ans::numeric between q.correct_min and q.correct_max, false)
      else false end as ok) k
  where p.id = p_paper and (p_ids is null or a.id = any(p_ids))
$$;

create or replace function private.score_attempts(p_paper uuid, p_ids uuid[] default null) returns void
language sql security definer set search_path = '' as $$
  with agg as (
    select m.attempt_id,
           sum(m.marks)::int as total,
           coalesce(sum(m.marks) filter (where m.subject = 'physics'), 0)::int     as phy,
           coalesce(sum(m.marks) filter (where m.subject = 'chemistry'), 0)::int   as chem,
           coalesce(sum(m.marks) filter (where m.subject = 'mathematics'), 0)::int as math,
           (count(*) filter (where m.tried and m.ok))::int     as nc,
           (count(*) filter (where m.tried and not m.ok))::int as nw,
           (count(*) filter (where not m.tried))::int          as nu
    from private.question_marks(p_paper, p_ids) m
    group by m.attempt_id)
  update public.attempts a
     set score = agg.total, score_physics = agg.phy, score_chemistry = agg.chem, score_mathematics = agg.math,
         n_correct = agg.nc, n_wrong = agg.nw, n_unattempted = agg.nu, scored_at = now()
    from agg
   where a.id = agg.attempt_id and a.status <> 'in_progress'
$$;

create or replace function private.finalize_attempt(p_attempt uuid, p_status text) returns void
language plpgsql security definer set search_path = '' as $$
declare pid uuid;
begin
  update public.attempts
     set status = p_status,
         submitted_at = case when p_status = 'expired' then deadline_at else least(now(), deadline_at) end,
         client_token = null
   where id = p_attempt and status = 'in_progress'
  returning paper_id into pid;
  if pid is not null then
    perform private.score_attempts(pid, array[p_attempt]);
  end if;
end $$;

-- Builds the leaderboard + per-question stats once a paper is over. This is the
-- moment Reddit usernames are decrypted and become public.
create or replace function private.build_results(p_paper uuid) returns boolean
language plpgsql security definer set search_path = '' as $$
declare p public.papers; cnt int; k text;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('results:' || p_paper::text, 0)) then
    return false;   -- someone else is building right now
  end if;
  select * into p from public.papers where id = p_paper;
  if not found or p.status = 'draft' or p.flushed_at is not null or now() < p.ends_at + private.grace() then
    return false;
  end if;
  -- an admin gave someone extra time: wait until they are done
  if exists (select 1 from public.attempts
              where paper_id = p_paper and not practice and status = 'in_progress'
                and deadline_at + private.grace() > now()) then
    return false;
  end if;

  update public.attempts set status = 'expired', submitted_at = deadline_at, client_token = null
   where paper_id = p_paper and not practice and status = 'in_progress';
  perform private.score_attempts(p_paper, null);

  k := private.identity_key();
  delete from private.leaderboard where paper_id = p_paper;
  insert into private.leaderboard (paper_id, attempt_id, name_hash, rank, handle, score, score_physics,
                                   score_chemistry, score_mathematics, n_correct, n_wrong, percentile)
  select a.paper_id, a.id, a.name_hash, rank() over w, private.name_dec(a.name_enc, k), a.score, a.score_physics,
         a.score_chemistry, a.score_mathematics, a.n_correct, a.n_wrong,
         round((cume_dist() over (order by a.score) * 100)::numeric, 3)   -- NTA-style percentile
    from public.attempts a
   where a.paper_id = p_paper and not a.practice and a.status <> 'in_progress' and a.name_enc is not null
     and not exists (select 1 from private.banned_names b where b.name_hash = a.name_hash)
  window w as (order by a.score desc, a.score_mathematics desc, a.score_physics desc,
                        a.score_chemistry desc, a.n_wrong asc);           -- NTA tie-break order
  get diagnostics cnt = row_count;

  delete from private.question_stats s using public.questions q
   where s.question_id = q.id and q.paper_id = p_paper;
  insert into private.question_stats (question_id, attempted, correct)
  select m.question_id,
         (count(*) filter (where m.tried))::int,
         (count(*) filter (where m.tried and m.ok))::int
    from private.question_marks(p_paper, null) m
   where not m.practice
   group by m.question_id;

  update public.papers set results_at = now(), results_count = cnt, key_changed_at = null where id = p_paper;
  return true;
end $$;

-- Called every minute by pg_cron (section 13). Also safe to call by hand.
create or replace function private.tick() returns void
language plpgsql security definer set search_path = '' as $$
declare ids uuid[]; pids uuid[]; pid uuid; r record;
begin
  with closed as (
    update public.attempts set status = 'expired', submitted_at = deadline_at, client_token = null
     where id in (select id from public.attempts
                   where status = 'in_progress' and deadline_at + private.grace() < now()
                   limit 5000 for update skip locked)
    returning id, paper_id)
  select array_agg(id), array_agg(distinct paper_id) into ids, pids from closed;

  foreach pid in array coalesce(pids, '{}'::uuid[]) loop
    perform private.score_attempts(pid, ids);
  end loop;

  for r in select id from public.papers
            where status in ('published', 'archived') and results_at is null and flushed_at is null
              and ends_at + private.grace() < now() loop
    perform private.build_results(r.id);
  end loop;
end $$;


-- ─── 6. Triggers ────────────────────────────────────────────────────────────
-- New staff sign-up → profile row. Anonymous student sessions get none.
create or replace function private.on_auth_user_created() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(new.is_anonymous, false) then return new; end if;
  insert into public.profiles (id, full_name)
  values (new.id, left(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', ''), 80))
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.on_auth_user_created();

-- Papers: only drafts are editable by editors; versions always bump.
create or replace function private.papers_before() returns trigger
language plpgsql set search_path = '' as $$
declare api boolean := current_user in ('authenticated', 'anon');
begin
  if tg_op = 'INSERT' then
    new.status := 'draft';
    new.results_at := null; new.results_count := null; new.key_changed_at := null; new.flushed_at := null;
    new.version := 1;
    if api then new.created_by := auth.uid(); new.updated_by := auth.uid(); end if;
    return new;
  end if;
  if api then
    if old.status <> 'draft' and not private.is_admin() then
      raise exception 'paper_locked' using hint = 'Only admins can change a published paper.';
    end if;
    new.updated_by := auth.uid();
  end if;
  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists papers_before on public.papers;
create trigger papers_before before insert or update on public.papers
  for each row execute function private.papers_before();

create or replace function private.papers_after() returns trigger
language plpgsql security definer set search_path = '' as $$
declare diff jsonb;
begin
  if tg_op = 'INSERT' then
    insert into public.questions (paper_id, subject, slot)
    select new.id, s, n
      from unnest(array['physics', 'chemistry', 'mathematics']) s cross join generate_series(1, 25) n
    on conflict do nothing;
    perform private.audit('paper.create', new.id, null, jsonb_build_object('title', new.title));
    return null;
  elsif tg_op = 'DELETE' then
    perform private.audit('paper.delete', old.id, null, jsonb_build_object('title', old.title));
    return null;
  end if;
  select jsonb_object_agg(n.key, jsonb_build_array(o.value, n.value)) into diff
    from jsonb_each(to_jsonb(new)) n join jsonb_each(to_jsonb(old)) o using (key)
   where n.value is distinct from o.value
     and n.key not in ('version', 'updated_at', 'updated_by', 'results_at', 'results_count', 'key_changed_at', 'flushed_at');
  if diff is not null then
    perform private.audit('paper.update', new.id, null, diff);
  end if;
  if new.status <> 'draft' then
    perform private.refresh_payload(new.id);
  end if;
  return null;
end $$;
drop trigger if exists papers_after on public.papers;
create trigger papers_after after insert or update or delete on public.papers
  for each row execute function private.papers_after();

-- Questions: lock after publish (admins excepted), versioning, verification.
create or replace function private.questions_before_update() returns trigger
language plpgsql set search_path = '' as $$
declare
  api boolean := current_user in ('authenticated', 'anon');
  st  text;
  content_changed boolean;
begin
  if api then
    select status into st from public.papers where id = new.paper_id;
    if st is distinct from 'draft' and not private.is_admin() then
      raise exception 'paper_locked' using hint = 'Only admins can change questions of a published paper.';
    end if;
    if new.bonus is distinct from old.bonus and not private.is_admin() then
      raise exception 'admin_only' using hint = 'Only admins can drop (bonus) a question.';
    end if;
    new.updated_by := auth.uid();
  end if;

  if new.slot <= 20 then
    new.correct_min := null; new.correct_max := null;
  else
    new.correct_options := '{}';
  end if;
  new.correct_options := array(select distinct x from unnest(new.correct_options) x order by x);

  content_changed := (new.body, new.image_path, new.options, new.option_images, new.correct_options,
                      new.correct_min, new.correct_max, new.solution, new.solution_image_path)
       is distinct from (old.body, old.image_path, old.options, old.option_images, old.correct_options,
                         old.correct_min, old.correct_max, old.solution, old.solution_image_path);
  if content_changed then
    -- any content change needs a fresh second pair of eyes
    new.verified := false; new.verified_by := null; new.verified_at := null;
  elsif new.verified and not old.verified then
    new.verified_by := auth.uid(); new.verified_at := now();
  elsif not new.verified then
    new.verified_by := null; new.verified_at := null;
  end if;

  new.version := old.version + 1;
  new.updated_at := now();
  return new;
end $$;
drop trigger if exists questions_before_update on public.questions;
create trigger questions_before_update before update on public.questions
  for each row execute function private.questions_before_update();

create or replace function private.questions_after_update() returns trigger
language plpgsql security definer set search_path = '' as $$
declare diff jsonb; p public.papers;
begin
  select jsonb_object_agg(n.key, jsonb_build_array(o.value, n.value)) into diff
    from jsonb_each(to_jsonb(new)) n join jsonb_each(to_jsonb(old)) o using (key)
   where n.value is distinct from o.value and n.key not in ('version', 'updated_at', 'updated_by');
  if diff is null then return null; end if;
  perform private.audit('question.update', new.paper_id, new.id, diff);

  select * into p from public.papers where id = new.paper_id;
  if p.status <> 'draft' then
    perform private.refresh_payload(new.paper_id);
  end if;
  if p.results_at is not null and (diff ? 'correct_options' or diff ? 'correct_min'
                                   or diff ? 'correct_max' or diff ? 'bonus') then
    update public.papers set key_changed_at = now() where id = new.paper_id;
  end if;
  return null;
end $$;
drop trigger if exists questions_after_update on public.questions;
create trigger questions_after_update after update on public.questions
  for each row execute function private.questions_after_update();


-- ─── 7. Student-facing API (the ONLY things a student can call) ─────────────
create or replace function public.list_papers() returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('now', now(), 'papers', coalesce(jsonb_agg(to_jsonb(x) order by x.starts_at desc), '[]'::jsonb))
  from (
    select p.id, p.title, p.description, p.starts_at, p.ends_at, p.entry_window_min, p.duration_min,
           p.allow_practice, p.results_at is not null as results_ready, p.results_count,
           (select jsonb_build_object('id', a.id, 'status', a.status, 'deadline_at', a.deadline_at)
              from public.attempts a
             where a.paper_id = p.id and a.user_id = auth.uid() and not a.practice) as mine,
           exists (select 1 from public.attempts a
                    where a.paper_id = p.id and a.user_id = auth.uid() and a.practice
                      and a.status = 'in_progress' and a.deadline_at > now()) as practice_open
      from public.papers p
     where p.status = 'published'
  ) x
$$;

create or replace function public.get_paper_info(p_paper uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'now', now(),
    'paper', jsonb_build_object(
      'id', p.id, 'title', p.title, 'description', p.description,
      'starts_at', p.starts_at, 'ends_at', p.ends_at, 'entry_window_min', p.entry_window_min,
      'duration_min', p.duration_min, 'allow_practice', p.allow_practice,
      'results_ready', p.results_at is not null,
      'marks', jsonb_build_object(
        'scq',       jsonb_build_object('correct', p.scq_correct, 'wrong', p.scq_wrong),
        'numerical', jsonb_build_object('correct', p.num_correct, 'wrong', p.num_wrong))),
    'mine', (select jsonb_build_object('id', a.id, 'status', a.status, 'deadline_at', a.deadline_at)
               from public.attempts a
              where a.paper_id = p.id and a.user_id = auth.uid() and not a.practice),
    'practice_open', exists (select 1 from public.attempts a
                              where a.paper_id = p.id and a.user_id = auth.uid() and a.practice
                                and a.status = 'in_progress' and a.deadline_at > now()))
  from public.papers p
  where p.id = p_paper and p.status = 'published'
$$;

create or replace function public.get_me() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); anon boolean; r jsonb;
begin
  if uid is null then return null; end if;
  select coalesce(is_anonymous, false) into anon from auth.users where id = uid;
  if not found then return null; end if;                          -- session of a deleted user
  if anon then return jsonb_build_object('id', uid, 'anonymous', true); end if;
  insert into public.profiles (id) values (uid) on conflict (id) do nothing;
  select jsonb_build_object('id', p.id, 'anonymous', false, 'handle', p.handle, 'full_name', p.full_name,
                            'banned', p.banned, 'handle_changed_at', p.handle_changed_at,
                            'role', (select s.role from public.staff s where s.user_id = p.id))
    into r from public.profiles p where p.id = uid;
  return r;
end $$;

-- Display name for staff accounts (students use their Reddit username per paper).
create or replace function public.set_handle(p_handle text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); h text := btrim(coalesce(p_handle, '')); prof public.profiles;
begin
  if uid is null then return jsonb_build_object('error', 'not_authenticated'); end if;
  if exists (select 1 from auth.users where id = uid and coalesce(is_anonymous, false)) then
    return jsonb_build_object('error', 'forbidden');
  end if;
  if h !~ '^[A-Za-z0-9_]{3,20}$' then return jsonb_build_object('error', 'handle_invalid'); end if;
  if lower(h) = any (array['admin', 'administrator', 'staff', 'moderator', 'mod', 'support', 'system',
                           'root', 'null', 'undefined', 'anonymous', 'nta', 'official']) then
    return jsonb_build_object('error', 'handle_reserved');
  end if;
  insert into public.profiles (id) values (uid) on conflict (id) do nothing;
  select * into prof from public.profiles where id = uid for update;
  if prof.handle = h then return jsonb_build_object('ok', true, 'handle', h); end if;
  if prof.handle is not null and prof.handle_changed_at > now() - interval '7 days' then
    return jsonb_build_object('error', 'handle_cooldown', 'until', prof.handle_changed_at + interval '7 days');
  end if;
  if exists (select 1 from public.profiles where lower(handle) = lower(h) and id <> uid) then
    return jsonb_build_object('error', 'handle_taken');
  end if;
  update public.profiles set handle = h, handle_changed_at = now() where id = uid;
  return jsonb_build_object('ok', true, 'handle', h);
exception when unique_violation then
  return jsonb_build_object('error', 'handle_taken');
end $$;

drop function if exists public.start_attempt(uuid, boolean);
create or replace function public.start_attempt(p_paper uuid, p_practice boolean default false,
                                                p_name text default null, p_pin text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid  uuid := auth.uid();
  n    timestamptz := now();
  p    public.papers;
  a    public.attempts;
  have boolean;
  k    text;
  nm   text;
  h    bytea;
  r    jsonb;
  pl   jsonb;
begin
  if uid is null then return jsonb_build_object('error', 'not_authenticated'); end if;
  -- a flushed anonymous session can still carry a valid token for a while
  if not exists (select 1 from auth.users where id = uid) then
    return jsonb_build_object('error', 'session_expired');
  end if;

  select * into p from public.papers where id = p_paper and status = 'published';
  if not found then return jsonb_build_object('error', 'paper_not_found'); end if;

  if p_practice then
    -- practice: only after official results are out (solutions are public by then); no name needed
    if not p.allow_practice or p.results_at is null then
      return jsonb_build_object('error', 'practice_unavailable');
    end if;
    perform pg_advisory_xact_lock(hashtextextended(uid::text || ':' || p.id::text, 0));
    select * into a from public.attempts
     where paper_id = p.id and user_id = uid and practice and status = 'in_progress' for update;
    have := found;
    if have and n > a.deadline_at + private.grace() then
      perform private.finalize_attempt(a.id, 'expired');
      have := false;
    end if;
    if have then
      update public.attempts set client_token = gen_random_uuid(), sessions = sessions + 1
       where id = a.id returning * into a;
    else
      insert into public.attempts (paper_id, user_id, practice, started_at, deadline_at, client_token)
      values (p.id, uid, true, n, n + make_interval(mins => p.duration_min), gen_random_uuid())
      returning * into a;
    end if;
  else
    -- 1. this browser already holds an attempt → resume without asking for the PIN
    select * into a from public.attempts where paper_id = p.id and user_id = uid and not practice for update;
    have := found;
    if have then
      if a.status = 'in_progress' and n > a.deadline_at + private.grace() then
        perform private.finalize_attempt(a.id, 'expired');
        return jsonb_build_object('error', 'already_submitted');
      elsif a.status <> 'in_progress' then
        return jsonb_build_object('error', 'already_submitted');
      end if;
      update public.attempts set client_token = gen_random_uuid(), sessions = sessions + 1
       where id = a.id returning * into a;
    else
      if p_name is null then return jsonb_build_object('error', 'name_required'); end if;
      nm := private.clean_reddit(p_name);
      if nm is null then return jsonb_build_object('error', 'name_invalid'); end if;
      if coalesce(p_pin, '') !~ '^[0-9]{4,8}$' then return jsonb_build_object('error', 'pin_invalid'); end if;
      k := private.identity_key();
      h := private.name_hash(nm, k);
      if exists (select 1 from private.banned_names where name_hash = h) then
        return jsonb_build_object('error', 'banned');
      end if;
      perform pg_advisory_xact_lock(hashtextextended(encode(h, 'hex') || ':' || p.id::text, 0));
      select * into a from public.attempts where paper_id = p.id and name_hash = h and not practice for update;
      have := found;
      if have then
        -- 2. this name already has an attempt: the PIN proves it's the same person on a new device
        if a.pin_hash is null then        -- an admin reset the PIN; this claim sets the new one
          update public.attempts set pin_hash = extensions.crypt(p_pin, extensions.gen_salt('bf', 6)),
                                     pin_fails = 0, pin_locked_until = null
           where id = a.id;
        else
          r := private.check_pin(a.id, p_pin);
          if r is not null then return r; end if;
        end if;
        if a.status = 'in_progress' and n > a.deadline_at + private.grace() then
          perform private.finalize_attempt(a.id, 'expired');
          return jsonb_build_object('error', 'already_submitted');
        elsif a.status <> 'in_progress' then
          return jsonb_build_object('error', 'already_submitted');
        end if;
        begin
          update public.attempts
             set prev_users = case when user_id is null then prev_users else array_append(prev_users, user_id) end,
                 user_id = uid, client_token = gen_random_uuid(), sessions = sessions + 1
           where id = a.id returning * into a;
        exception when unique_violation then
          return jsonb_build_object('error', 'session_has_attempt');
        end;
      else
        -- 3. new attempt
        if n < p.starts_at then
          return jsonb_build_object('error', 'not_started', 'starts_at', p.starts_at, 'now', n);
        end if;
        if n > p.starts_at + make_interval(mins => p.entry_window_min) or n >= p.ends_at then
          return jsonb_build_object('error', 'entry_closed');
        end if;
        begin
          insert into public.attempts (paper_id, user_id, practice, name_hash, name_enc, pin_hash,
                                       started_at, deadline_at, client_token)
          values (p.id, uid, false, h, private.name_enc(nm, k), extensions.crypt(p_pin, extensions.gen_salt('bf', 6)),
                  n, least(n + make_interval(mins => p.duration_min), p.ends_at), gen_random_uuid())
          returning * into a;
        exception when unique_violation then
          return jsonb_build_object('error', 'session_has_attempt');
        end;
      end if;
    end if;
  end if;

  select payload into pl from private.paper_payloads where paper_id = p.id;
  if pl is null then pl := private.refresh_payload(p.id); end if;

  return jsonb_build_object(
    'now', clock_timestamp(),
    'attempt', jsonb_build_object('id', a.id, 'token', a.client_token, 'practice', a.practice,
                                  'started_at', a.started_at, 'deadline_at', a.deadline_at,
                                  'seq', a.seq, 'responses', a.responses,
                                  'name', case when a.name_enc is not null
                                               then private.name_dec(a.name_enc, coalesce(k, private.identity_key())) end),
    'paper', pl);
end $$;

create or replace function public.save_progress(p_attempt uuid, p_token uuid, p_seq bigint, p_responses jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.attempts; n timestamptz := now();
begin
  if auth.uid() is null then return jsonb_build_object('error', 'not_authenticated'); end if;
  if p_responses is null or jsonb_typeof(p_responses) <> 'object' or pg_column_size(p_responses) > 100000 then
    return jsonb_build_object('error', 'invalid');
  end if;
  select * into a from public.attempts where id = p_attempt for update;
  if not found then return jsonb_build_object('error', 'attempt_not_found'); end if;
  if a.user_id is distinct from auth.uid() then
    return jsonb_build_object('error', case when auth.uid() = any(a.prev_users) then 'superseded' else 'attempt_not_found' end);
  end if;
  if a.status <> 'in_progress' then return jsonb_build_object('error', 'closed', 'status', a.status); end if;
  if a.client_token is distinct from p_token then return jsonb_build_object('error', 'superseded'); end if;
  if n > a.deadline_at + private.grace() then
    perform private.finalize_attempt(a.id, 'expired');
    return jsonb_build_object('error', 'closed', 'status', 'expired');
  end if;
  if p_seq is null or p_seq <= a.seq then
    return jsonb_build_object('ok', true, 'stale', true, 'now', clock_timestamp(), 'deadline_at', a.deadline_at);
  end if;
  if a.last_saved_at is not null and a.last_saved_at > n - interval '700 milliseconds' then
    return jsonb_build_object('error', 'slow_down');
  end if;
  update public.attempts
     set responses = private.clean_responses(a.paper_id, p_responses), seq = p_seq, last_saved_at = n
   where id = a.id;
  return jsonb_build_object('ok', true, 'now', clock_timestamp(), 'deadline_at', a.deadline_at);
end $$;

create or replace function public.submit_attempt(p_attempt uuid, p_token uuid, p_seq bigint, p_responses jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare a public.attempts; p public.papers; in_time boolean;
begin
  if auth.uid() is null then return jsonb_build_object('error', 'not_authenticated'); end if;
  select * into a from public.attempts where id = p_attempt for update;
  if not found then return jsonb_build_object('error', 'attempt_not_found'); end if;
  if a.user_id is distinct from auth.uid() then
    return jsonb_build_object('error', case when auth.uid() = any(a.prev_users) then 'superseded' else 'attempt_not_found' end);
  end if;
  select * into p from public.papers where id = a.paper_id;
  if a.status <> 'in_progress' then   -- idempotent: a retried submit just reports success
    return jsonb_build_object('ok', true, 'status', a.status, 'practice', a.practice, 'ends_at', p.ends_at);
  end if;
  if a.client_token is distinct from p_token then return jsonb_build_object('error', 'superseded'); end if;
  in_time := now() <= a.deadline_at + private.grace();
  if in_time and p_responses is not null and jsonb_typeof(p_responses) = 'object'
     and pg_column_size(p_responses) <= 100000 and coalesce(p_seq, 0) > a.seq then
    update public.attempts set responses = private.clean_responses(a.paper_id, p_responses), seq = p_seq,
                               last_saved_at = now()
     where id = a.id;
  end if;
  perform private.finalize_attempt(a.id, case when in_time then 'submitted' else 'expired' end);
  return jsonb_build_object('ok', true, 'status', case when in_time then 'submitted' else 'expired' end,
                            'practice', a.practice, 'ends_at', p.ends_at);
end $$;

create or replace function public.report_violation(p_attempt uuid, p_token uuid, p_kind text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare v jsonb;
begin
  if p_kind not in ('fullscreen_exit', 'tab_hidden', 'window_blur', 'copy', 'context_menu', 'print') then
    return jsonb_build_object('error', 'invalid');
  end if;
  update public.attempts
     set violations = jsonb_set(violations, array[p_kind], to_jsonb(coalesce((violations ->> p_kind)::int, 0) + 1)),
         last_violation_at = now()
   where id = p_attempt and user_id = auth.uid() and status = 'in_progress' and client_token = p_token
     and (last_violation_at is null or last_violation_at < now() - interval '1 second')
  returning violations into v;
  return jsonb_build_object('ok', true, 'violations', v);
end $$;

-- Result + solutions. Finds the attempt held by this browser, or — after the
-- paper is over — by Reddit username + PIN (from any device, even signed out).
drop function if exists public.get_my_result(uuid, boolean);
create or replace function public.get_my_result(p_paper uuid, p_practice boolean default false,
                                                p_name text default null, p_pin text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  uid uuid := auth.uid();
  p   public.papers;
  a   public.attempts;
  lb  private.leaderboard;
  qs  jsonb;
  r   jsonb;
  k   text;
  nm  text;
  open_practice boolean := false;
begin
  select * into p from public.papers where id = p_paper and status in ('published', 'archived');
  if not found then return jsonb_build_object('error', 'paper_not_found'); end if;

  if p.results_at is null and now() >= p.ends_at + private.grace() and private.build_results(p.id) then
    select * into p from public.papers where id = p.id;
  end if;

  if p_practice then
    if uid is null then return jsonb_build_object('error', 'not_authenticated'); end if;
    select * into a from public.attempts
     where paper_id = p.id and user_id = uid and practice and status = 'in_progress' for update;
    if found then
      if now() > a.deadline_at + private.grace() then perform private.finalize_attempt(a.id, 'expired');
      else open_practice := true;
      end if;
    end if;
    -- show the most recent finished practice attempt
    select * into a from public.attempts
     where paper_id = p.id and user_id = uid and practice and status <> 'in_progress'
     order by submitted_at desc nulls last limit 1;
  elsif uid is not null then
    select * into a from public.attempts where paper_id = p.id and user_id = uid and not practice;
  end if;

  -- Nothing about answers leaves the database before results are published.
  if p.results_at is null then
    return jsonb_build_object('pending', true, 'now', now(), 'ends_at', p.ends_at,
      'paper', jsonb_build_object('id', p.id, 'title', p.title),
      'attempt', case when a.id is null then null
                      else jsonb_build_object('status', a.status, 'submitted_at', a.submitted_at) end);
  end if;

  if a.id is null and not p_practice and p_name is not null then
    nm := private.clean_reddit(p_name);
    if nm is null then return jsonb_build_object('error', 'name_invalid'); end if;
    k := private.identity_key();
    select * into a from public.attempts
     where paper_id = p.id and name_hash = private.name_hash(nm, k) and not practice;
    if not found then
      return jsonb_build_object('error', case when p.flushed_at is not null then 'flushed' else 'name_not_found' end);
    end if;
    r := private.check_pin(a.id, p_pin);
    if r is not null then return r; end if;
  end if;

  if a.id is not null and a.status = 'in_progress' then
    return jsonb_build_object('error', 'attempt_in_progress');
  end if;

  if a.id is not null and not a.practice then
    select * into lb from private.leaderboard where attempt_id = a.id;
  end if;

  select jsonb_agg(jsonb_build_object(
           'id', q.id, 'subject', q.subject, 'slot', q.slot, 'kind', q.kind,
           'body', q.body, 'image', q.image_path,
           'options',       case when q.slot <= 20 then to_jsonb(q.options) end,
           'option_images', case when q.slot <= 20 then to_jsonb(q.option_images) end,
           'correct_options', to_jsonb(q.correct_options), 'correct_min', q.correct_min, 'correct_max', q.correct_max,
           'solution', q.solution, 'solution_image', q.solution_image_path, 'bonus', q.bonus,
           'attempted_by', s.attempted, 'correct_by', s.correct,
           'mine', case when a.id is null then null else jsonb_build_object(
                     'a', a.responses -> q.id::text ->> 'a',
                     's', a.responses -> q.id::text ->> 's',
                     't', coalesce((a.responses -> q.id::text ->> 't')::bigint, 0),
                     'marks', m.marks, 'ok', m.ok) end)
         order by private.subject_rank(q.subject), q.slot)
    into qs
    from public.questions q
    left join private.question_stats s on s.question_id = q.id
    left join private.question_marks(p.id, array[a.id]) m on m.question_id = q.id
   where q.paper_id = p.id;

  return jsonb_build_object(
    'paper', jsonb_build_object(
      'id', p.id, 'title', p.title, 'starts_at', p.starts_at, 'ends_at', p.ends_at,
      'duration_min', p.duration_min, 'allow_practice', p.allow_practice, 'takers', p.results_count,
      'marks', jsonb_build_object(
        'scq',       jsonb_build_object('correct', p.scq_correct, 'wrong', p.scq_wrong),
        'numerical', jsonb_build_object('correct', p.num_correct, 'wrong', p.num_wrong))),
    'attempt', case when a.id is null then null else jsonb_build_object(
      'id', a.id, 'practice', a.practice, 'status', a.status,
      'name', case when a.name_enc is not null then private.name_dec(a.name_enc, coalesce(k, private.identity_key())) end,
      'started_at', a.started_at, 'submitted_at', a.submitted_at,
      'score', a.score, 'physics', a.score_physics, 'chemistry', a.score_chemistry,
      'mathematics', a.score_mathematics, 'correct', a.n_correct, 'wrong', a.n_wrong,
      'unattempted', a.n_unattempted) end,
    'rank', lb.rank,
    'percentile', lb.percentile,
    'key_changed', p.key_changed_at is not null,
    'flushed', p.flushed_at is not null,
    'practice_open', open_practice,
    'questions', coalesce(qs, '[]'::jsonb));
end $$;

create or replace function public.get_leaderboard(p_paper uuid, p_offset int default 0, p_limit int default 50)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  p   public.papers;
  lim int := least(greatest(coalesce(p_limit, 50), 1), 100);
  off int := least(greatest(coalesce(p_offset, 0), 0), 1000000);
  lb_rows jsonb; me jsonb;
begin
  select * into p from public.papers where id = p_paper and status in ('published', 'archived');
  if not found then return jsonb_build_object('error', 'paper_not_found'); end if;
  if p.results_at is null and now() >= p.ends_at + private.grace() and private.build_results(p.id) then
    select * into p from public.papers where id = p.id;
  end if;
  if p.results_at is null then
    return jsonb_build_object('pending', true, 'ends_at', p.ends_at, 'paper', jsonb_build_object('id', p.id, 'title', p.title));
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'rank', l.rank, 'handle', l.handle, 'score', l.score, 'physics', l.score_physics,
           'chemistry', l.score_chemistry, 'mathematics', l.score_mathematics,
           'percentile', l.percentile, 'me', coalesce(a.user_id = auth.uid(), false)) order by l.rank, l.handle), '[]'::jsonb)
    into lb_rows
    from (select * from private.leaderboard where paper_id = p.id order by rank, handle offset off limit lim) l
    left join public.attempts a on a.id = l.attempt_id;
  if auth.uid() is not null then
    select jsonb_build_object('rank', l.rank, 'handle', l.handle, 'score', l.score, 'percentile', l.percentile)
      into me
      from private.leaderboard l join public.attempts a on a.id = l.attempt_id
     where l.paper_id = p.id and a.user_id = auth.uid();
  end if;
  return jsonb_build_object('paper', jsonb_build_object('id', p.id, 'title', p.title),
                            'total', p.results_count, 'offset', off, 'rows', lb_rows, 'me', me);
end $$;

create or replace function public.get_overall_leaderboard(p_limit int default 100) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('rows', coalesce(jsonb_agg(to_jsonb(t) order by t.total desc, t.avg_percentile desc), '[]'::jsonb))
  from (
    select max(l.handle) as handle, sum(l.score)::int as total, count(*)::int as papers,
           round(avg(l.percentile), 2) as avg_percentile, coalesce(bool_or(a.user_id = auth.uid()), false) as me
      from private.leaderboard l
      join public.papers p on p.id = l.paper_id and p.status in ('published', 'archived')
      left join public.attempts a on a.id = l.attempt_id
     where not exists (select 1 from private.banned_names b where b.name_hash = l.name_hash)
     group by lower(l.handle)
     order by total desc, avg_percentile desc
     limit least(greatest(coalesce(p_limit, 100), 1), 200)
  ) t
$$;


-- ─── 8. Staff API (editors + admins) ────────────────────────────────────────
create or replace function public.staff_paper_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  if not private.is_staff() then return jsonb_build_object('error', 'forbidden'); end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.starts_at desc), '[]'::jsonb) into r
  from (
    select p.id, p.title, p.status, p.starts_at, p.ends_at, p.entry_window_min, p.duration_min,
           p.version, p.results_at, p.key_changed_at, p.flushed_at, p.updated_at,
           count(q.id) filter (where btrim(q.body) <> '' or q.image_path is not null) as filled,
           count(q.id) filter (where private.q_complete(q.body, q.image_path, q.slot, q.correct_options,
                                                        q.correct_min, q.correct_max)) as complete,
           count(q.id) filter (where q.verified) as verified,
           (select count(*) from public.attempts a where a.paper_id = p.id and not a.practice) as attempts
      from public.papers p
      left join public.questions q on q.paper_id = p.id
     group by p.id
  ) x;
  return jsonb_build_object('papers', r);
end $$;

create or replace function public.staff_directory() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  if not private.is_staff() then return jsonb_build_object('error', 'forbidden'); end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', s.user_id, 'role', s.role,
           'name', coalesce(pr.handle, nullif(pr.full_name, ''), 'Staff'))), '[]'::jsonb)
    into r from public.staff s left join public.profiles pr on pr.id = s.user_id;
  return jsonb_build_object('staff', r);
end $$;

create or replace function public.staff_history(p_paper uuid, p_question uuid default null, p_limit int default 200)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  if not private.is_staff() then return jsonb_build_object('error', 'forbidden'); end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.at desc), '[]'::jsonb) into r
  from (
    select l.id, l.at, l.action, l.question_id, l.detail,
           coalesce(pr.handle, nullif(pr.full_name, ''), 'system') as actor,
           (select private.slot_label(q.subject, q.slot) from public.questions q where q.id = l.question_id) as label
      from private.audit_log l
      left join public.profiles pr on pr.id = l.actor
     where l.paper_id = p_paper and (p_question is null or l.question_id = p_question)
     order by l.at desc
     limit least(greatest(coalesce(p_limit, 200), 1), 500)
  ) x;
  return jsonb_build_object('rows', r);
end $$;


-- ─── 9. Admin API ───────────────────────────────────────────────────────────
create or replace function public.admin_publish_paper(p_paper uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.papers; missing jsonb;
begin
  if not private.is_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  select * into p from public.papers where id = p_paper for update;
  if not found then return jsonb_build_object('error', 'paper_not_found'); end if;
  if p.status <> 'draft' then return jsonb_build_object('error', 'invalid_state'); end if;
  if p.ends_at <= now() then return jsonb_build_object('error', 'ends_in_past'); end if;
  select jsonb_agg(private.slot_label(q.subject, q.slot) order by private.subject_rank(q.subject), q.slot)
    into missing
    from public.questions q
   where q.paper_id = p_paper
     and not private.q_complete(q.body, q.image_path, q.slot, q.correct_options, q.correct_min, q.correct_max);
  if missing is not null then return jsonb_build_object('error', 'incomplete', 'missing', missing); end if;
  update public.papers set status = 'published' where id = p_paper;
  perform private.audit('paper.publish', p_paper, null, '{}');
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_unpublish_paper(p_paper uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  if exists (select 1 from public.attempts where paper_id = p_paper) then
    return jsonb_build_object('error', 'has_attempts');
  end if;
  update public.papers set status = 'draft' where id = p_paper and status = 'published';
  if not found then return jsonb_build_object('error', 'invalid_state'); end if;
  delete from private.paper_payloads where paper_id = p_paper;
  perform private.audit('paper.unpublish', p_paper, null, '{}');
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_archive_paper(p_paper uuid, p_archived boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  update public.papers set status = case when p_archived then 'archived' else 'published' end
   where id = p_paper and status = case when p_archived then 'published' else 'archived' end;
  if not found then return jsonb_build_object('error', 'invalid_state'); end if;
  perform private.audit(case when p_archived then 'paper.archive' else 'paper.unarchive' end, p_paper, null, '{}');
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_delete_paper(p_paper uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  if not private.is_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  -- results are never destroyed by accident: papers that were taken can only be archived
  if exists (select 1 from public.attempts where paper_id = p_paper)
     or exists (select 1 from private.leaderboard where paper_id = p_paper) then
    return jsonb_build_object('error', 'has_attempts');
  end if;
  delete from public.papers where id = p_paper;
  if not found then return jsonb_build_object('error', 'paper_not_found'); end if;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_rescore_paper(p_paper uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare built boolean := false;
begin
  if not private.is_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  if exists (select 1 from public.papers where id = p_paper and flushed_at is not null) then
    return jsonb_build_object('error', 'flushed');   -- the answers needed to re-score are gone
  end if;
  perform private.score_attempts(p_paper, null);
  if exists (select 1 from public.papers where id = p_paper and results_at is not null) then
    built := private.build_results(p_paper);
  end if;
  perform private.audit('paper.rescore', p_paper, null, jsonb_build_object('results_rebuilt', built));
  return jsonb_build_object('ok', true, 'results_rebuilt', built);
end $$;

-- Deletes the personal data of a finished paper: every attempt (answers,
-- timings, name hashes, encrypted names, PIN hashes, device tokens) and the
-- anonymous sessions left with nothing. The public leaderboard and the
-- per-question stats stay.
create or replace function public.admin_flush_paper(p_paper uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare p public.papers; n_att int; n_users int := 0; sess_ids uuid[];
begin
  if not private.is_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  select * into p from public.papers where id = p_paper for update;
  if not found then return jsonb_build_object('error', 'paper_not_found'); end if;
  if p.results_at is null then return jsonb_build_object('error', 'results_not_ready'); end if;
  select array_agg(distinct x) into sess_ids
    from (select user_id as x from public.attempts where paper_id = p_paper
          union select unnest(prev_users) from public.attempts where paper_id = p_paper) s
   where x is not null;
  delete from public.attempts where paper_id = p_paper;   -- leaderboard rows keep the name, lose the link
  get diagnostics n_att = row_count;
  update public.papers set flushed_at = now() where id = p_paper;
  -- the anonymous sessions used for this paper, unless they still hold another paper's attempt
  begin
    delete from auth.users u
     where u.id = any(coalesce(sess_ids, '{}'::uuid[]))
       and coalesce(u.is_anonymous, false)
       and not exists (select 1 from public.attempts a where a.user_id = u.id);
    get diagnostics n_users = row_count;
  exception when others then
    raise notice 'Could not remove anonymous sessions: %', sqlerrm;
  end;
  perform private.audit('paper.flush', p_paper, null, jsonb_build_object('attempts', n_att, 'sessions', n_users));
  return jsonb_build_object('ok', true, 'attempts', n_att, 'sessions', n_users);
end $$;

create or replace function public.admin_list_staff() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r jsonb;
begin
  if not private.is_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', s.user_id, 'role', s.role, 'added_at', s.added_at, 'email', u.email,
           'handle', pr.handle, 'full_name', pr.full_name) order by s.role, u.email), '[]'::jsonb)
    into r
    from public.staff s join auth.users u on u.id = s.user_id left join public.profiles pr on pr.id = s.user_id;
  return jsonb_build_object('staff', r);
end $$;

create or replace function public.admin_set_staff(p_email text, p_role text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare target uuid; cur text;
begin
  if not private.is_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  if p_role is not null and p_role not in ('admin', 'editor') then return jsonb_build_object('error', 'invalid'); end if;
  select id into target from auth.users
   where lower(email) = lower(btrim(p_email)) and not coalesce(is_anonymous, false) limit 1;
  if target is null then return jsonb_build_object('error', 'user_not_found'); end if;
  select role into cur from public.staff where user_id = target;
  if cur = 'admin' and p_role is distinct from 'admin'
     and (select count(*) from public.staff where role = 'admin') <= 1 then
    return jsonb_build_object('error', 'last_admin');
  end if;
  if p_role is null then
    delete from public.staff where user_id = target;
  else
    insert into public.staff (user_id, role, added_by) values (target, p_role, auth.uid())
    on conflict (user_id) do update set role = excluded.role;
  end if;
  perform private.audit('staff.set', null, null, jsonb_build_object('user', target, 'from', cur, 'to', p_role));
  return jsonb_build_object('ok', true);
end $$;

drop function if exists public.admin_set_ban(uuid, boolean);
drop function if exists public.admin_find_users(text);

create or replace function public.admin_monitor(p_paper uuid, p_filter text default 'all', p_offset int default 0, p_limit int default 200)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare counts jsonb; att_rows jsonb; k text;
begin
  if not private.is_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  k := private.identity_key();
  select jsonb_build_object(
           'started',     count(*),
           'in_progress', count(*) filter (where status = 'in_progress'),
           'submitted',   count(*) filter (where status = 'submitted'),
           'expired',     count(*) filter (where status = 'expired'),
           'flagged',     count(*) filter (where violations <> '{}'::jsonb or sessions > 2))
    into counts from public.attempts where paper_id = p_paper and not practice;
  select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) into att_rows
  from (
    select a.id, private.name_dec(a.name_enc, k) as handle,
           exists (select 1 from private.banned_names b where b.name_hash = a.name_hash) as banned,
           coalesce(a.pin_locked_until > now(), false) as pin_locked, a.pin_hash is null as pin_reset,
           a.status, a.started_at, a.deadline_at, a.submitted_at, a.last_saved_at, a.sessions, a.violations, a.score,
           (select count(*) from jsonb_each(a.responses) e where e.value ->> 'a' is not null) as answered
      from public.attempts a
     where a.paper_id = p_paper and not a.practice
       and case coalesce(p_filter, 'all')
             when 'in_progress' then a.status = 'in_progress'
             when 'submitted'   then a.status <> 'in_progress'
             when 'flagged'     then a.violations <> '{}'::jsonb or a.sessions > 2
             else true end
     order by (a.violations <> '{}'::jsonb) desc, a.started_at
     offset least(greatest(coalesce(p_offset, 0), 0), 1000000)
     limit least(greatest(coalesce(p_limit, 200), 1), 500)
  ) x;
  return jsonb_build_object('now', now(), 'counts', counts, 'attempts', att_rows);
end $$;

create or replace function public.admin_extend_attempt(p_attempt uuid, p_minutes int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d timestamptz; pid uuid;
begin
  if not private.is_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  if p_minutes is null or p_minutes not between 1 and 180 then return jsonb_build_object('error', 'invalid'); end if;
  update public.attempts set deadline_at = deadline_at + make_interval(mins => p_minutes)
   where id = p_attempt and status = 'in_progress' returning deadline_at, paper_id into d, pid;
  if d is null then return jsonb_build_object('error', 'invalid_state'); end if;
  perform private.audit('attempt.extend', pid, null, jsonb_build_object('attempt', p_attempt, 'minutes', p_minutes));
  return jsonb_build_object('ok', true, 'deadline_at', d);
end $$;

create or replace function public.admin_reset_attempt(p_attempt uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare a public.attempts;
begin
  if not private.is_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  delete from public.attempts where id = p_attempt returning * into a;
  if a.id is null then return jsonb_build_object('error', 'attempt_not_found'); end if;
  perform private.audit('attempt.reset', a.paper_id, null,
    jsonb_build_object('attempt', a.id, 'status', a.status, 'score', a.score));
  return jsonb_build_object('ok', true);
end $$;

-- A student forgot their PIN: the next person to enter this username sets a new one.
create or replace function public.admin_reset_pin(p_attempt uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare pid uuid;
begin
  if not private.is_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  update public.attempts set pin_hash = null, pin_fails = 0, pin_locked_until = null
   where id = p_attempt and not practice returning paper_id into pid;
  if pid is null then return jsonb_build_object('error', 'attempt_not_found'); end if;
  perform private.audit('attempt.reset_pin', pid, null, jsonb_build_object('attempt', p_attempt));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_ban_attempt(p_attempt uuid, p_banned boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare h bytea; e bytea; pid uuid;
begin
  if not private.is_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  select name_hash, name_enc, paper_id into h, e, pid from public.attempts where id = p_attempt;
  if h is null then return jsonb_build_object('error', 'attempt_not_found'); end if;
  if p_banned then
    insert into private.banned_names (name_hash, name_enc, banned_by) values (h, e, auth.uid()) on conflict do nothing;
  else
    delete from private.banned_names where name_hash = h;
  end if;
  perform private.audit(case when p_banned then 'name.ban' else 'name.unban' end, pid, null, jsonb_build_object('attempt', p_attempt));
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_ban_name(p_name text, p_banned boolean) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare nm text := private.clean_reddit(p_name); k text;
begin
  if not private.is_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  if nm is null then return jsonb_build_object('error', 'name_invalid'); end if;
  k := private.identity_key();
  if p_banned then
    insert into private.banned_names (name_hash, name_enc, banned_by)
    values (private.name_hash(nm, k), private.name_enc(nm, k), auth.uid()) on conflict do nothing;
  else
    delete from private.banned_names where name_hash = private.name_hash(nm, k);
  end if;
  perform private.audit(case when p_banned then 'name.ban' else 'name.unban' end, null, null, '{}');
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.admin_list_banned() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare r jsonb; k text;
begin
  if not private.is_admin() then return jsonb_build_object('error', 'forbidden'); end if;
  k := private.identity_key();
  select coalesce(jsonb_agg(jsonb_build_object('name', private.name_dec(b.name_enc, k), 'banned_at', b.banned_at)
                            order by b.banned_at desc), '[]'::jsonb)
    into r from private.banned_names b;
  return jsonb_build_object('names', r);
end $$;


-- ─── 10. Row-level security & grants ────────────────────────────────────────
alter table public.profiles        enable row level security;
alter table public.staff           enable row level security;
alter table public.papers          enable row level security;
alter table public.questions       enable row level security;
alter table public.attempts        enable row level security;
alter table private.settings       enable row level security;
alter table private.banned_names   enable row level security;
alter table private.paper_payloads enable row level security;
alter table private.leaderboard    enable row level security;
alter table private.question_stats enable row level security;
alter table private.audit_log      enable row level security;

revoke all on all tables    in schema public  from anon, authenticated;
revoke all on all sequences in schema public  from anon, authenticated;
revoke all on all tables    in schema private from public, anon, authenticated;

-- Staff edit papers/questions directly (this is what makes realtime collab work).
-- Students get zero rows: every policy below requires staff membership.
grant select on public.papers, public.questions to authenticated;
grant insert (title, description, starts_at, ends_at, entry_window_min, duration_min,
              scq_correct, scq_wrong, num_correct, num_wrong, allow_practice) on public.papers to authenticated;
grant update (title, description, starts_at, ends_at, entry_window_min, duration_min,
              scq_correct, scq_wrong, num_correct, num_wrong, allow_practice) on public.papers to authenticated;
grant update (body, image_path, options, option_images, correct_options, correct_min, correct_max,
              solution, solution_image_path, bonus, note, verified) on public.questions to authenticated;

drop policy if exists papers_staff_read   on public.papers;
drop policy if exists papers_staff_insert on public.papers;
drop policy if exists papers_staff_update on public.papers;
create policy papers_staff_read   on public.papers for select to authenticated using ((select private.is_staff()));
create policy papers_staff_insert on public.papers for insert to authenticated with check ((select private.is_staff()));
create policy papers_staff_update on public.papers for update to authenticated
  using ((select private.is_staff())) with check ((select private.is_staff()));

drop policy if exists questions_staff_read   on public.questions;
drop policy if exists questions_staff_update on public.questions;
create policy questions_staff_read   on public.questions for select to authenticated using ((select private.is_staff()));
create policy questions_staff_update on public.questions for update to authenticated
  using ((select private.is_staff())) with check ((select private.is_staff()));

-- Lock every function down, then open exactly what each role needs.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname in ('public', 'private') and p.prokind = 'f'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;

-- Used inside RLS policies and CHECK constraints only (`private` is not reachable over the API).
grant execute on function private.is_staff(), private.is_admin(),
                          private.valid_img(text), private.valid_img_array(text[]) to authenticated;

grant execute on function
  public.list_papers(), public.get_paper_info(uuid),
  public.get_leaderboard(uuid, int, int), public.get_overall_leaderboard(int),
  public.get_my_result(uuid, boolean, text, text)
to anon, authenticated;

grant execute on function
  public.get_me(), public.set_handle(text),
  public.start_attempt(uuid, boolean, text, text),
  public.save_progress(uuid, uuid, bigint, jsonb),
  public.submit_attempt(uuid, uuid, bigint, jsonb),
  public.report_violation(uuid, uuid, text),
  public.staff_paper_overview(), public.staff_directory(), public.staff_history(uuid, uuid, int),
  public.admin_publish_paper(uuid), public.admin_unpublish_paper(uuid),
  public.admin_archive_paper(uuid, boolean), public.admin_delete_paper(uuid),
  public.admin_rescore_paper(uuid), public.admin_flush_paper(uuid),
  public.admin_list_staff(), public.admin_set_staff(text, text),
  public.admin_monitor(uuid, text, int, int), public.admin_extend_attempt(uuid, int),
  public.admin_reset_attempt(uuid), public.admin_reset_pin(uuid),
  public.admin_ban_attempt(uuid, boolean), public.admin_ban_name(text, boolean), public.admin_list_banned()
to authenticated;


-- ─── 11. Storage (question images) ──────────────────────────────────────────
-- Public bucket, but file names are random UUIDs and listing is staff-only, so
-- an image URL cannot be guessed before the exam. Only staff can upload.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('qimg', 'qimg', true, 3145728, array['image/webp', 'image/png', 'image/jpeg'])
on conflict (id) do update
  set public = excluded.public, file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "qimg staff upload" on storage.objects;
drop policy if exists "qimg staff list"   on storage.objects;
drop policy if exists "qimg admin delete" on storage.objects;
create policy "qimg staff upload" on storage.objects for insert to authenticated
  with check (bucket_id = 'qimg' and (select private.is_staff()) and private.valid_img(name));
create policy "qimg staff list" on storage.objects for select to authenticated
  using (bucket_id = 'qimg' and (select private.is_staff()));
create policy "qimg admin delete" on storage.objects for delete to authenticated
  using (bucket_id = 'qimg' and (select private.is_admin()));


-- ─── 12. Realtime (staff collaboration) ─────────────────────────────────────
-- Row changes respect the RLS above, so only staff ever receive them.
do $$
begin
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'questions') then
    alter publication supabase_realtime add table public.questions;
  end if;
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'papers') then
    alter publication supabase_realtime add table public.papers;
  end if;
end $$;

-- Presence ("who is editing what") runs on private channels named paper:<id>.
drop policy if exists "staff paper channels read"  on realtime.messages;
drop policy if exists "staff paper channels write" on realtime.messages;
create policy "staff paper channels read" on realtime.messages for select to authenticated
  using ((select private.is_staff()) and (select realtime.topic()) like 'paper:%');
create policy "staff paper channels write" on realtime.messages for insert to authenticated
  with check ((select private.is_staff()) and (select realtime.topic()) like 'paper:%');


-- ─── 13. Scheduler ──────────────────────────────────────────────────────────
-- Closes timed-out attempts and publishes results every minute. If pg_cron is
-- unavailable, results are still built on first request after a paper ends.
-- Personal data is NOT flushed automatically — use the console's Flush button.
do $$
begin
  create extension if not exists pg_cron;
exception when others then
  raise notice 'pg_cron is not enabled: enable it under Database → Extensions, then run this file again.';
end $$;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'jee-mock-tick';
    perform cron.schedule('jee-mock-tick', '* * * * *', 'select private.tick()');
  end if;
end $$;


-- ─── 14. Existing staff accounts (if you re-run after people signed up) ─────
insert into public.profiles (id, full_name)
select id, left(coalesce(raw_user_meta_data ->> 'full_name', raw_user_meta_data ->> 'name', ''), 80)
  from auth.users
 where not coalesce(is_anonymous, false)
on conflict (id) do nothing;

notify pgrst, 'reload schema';

-- ════════════════════════════════════════════════════════════════════════════
--  LAST STEP (once): sign in to the console (admin.html) with Google/Discord,
--  then make yourself admin:
--
--    insert into public.staff (user_id, role)
--    select id, 'admin' from auth.users where email = 'you@example.com'
--    on conflict (user_id) do update set role = 'admin';
-- ════════════════════════════════════════════════════════════════════════════
