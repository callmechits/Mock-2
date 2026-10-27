-- ════════════════════════════════════════════════════════════════════════════
--  Security & logic self-test.  Run in Supabase → SQL Editor AFTER schema.sql.
--
--  Creates throw-away accounts and papers (titles start with "[selftest]"), then
--  acts as an anonymous visitor, anonymous students on different devices, an
--  editor and an admin, and tries things that must work and things that must be
--  refused. Everything it created is deleted at the end. Every row should PASS.
-- ════════════════════════════════════════════════════════════════════════════
create temp table if not exists _results (n int, test text, pass boolean, detail text);
truncate _results;

do $test$
declare
  u_admin  uuid := '00000000-0000-4000-8000-00000000a001';
  u_editor uuid := '00000000-0000-4000-8000-00000000e001';
  u_s1     uuid := '00000000-0000-4000-8000-000000005001';
  u_s2     uuid := '00000000-0000-4000-8000-000000005002';
  u_s3     uuid := '00000000-0000-4000-8000-000000005003';
  u_ghost  uuid := '00000000-0000-4000-8000-00000000dead';
  p_live uuid; p_future uuid; p_draft uuid; p_ended uuid; p_new uuid;
  q1 uuid; q2 uuid; q21 uuid; dq uuid; lq uuid; eq uuid;
  names text[] := '{}'; passes boolean[] := '{}'; details text[] := '{}';
  t text; r jsonb; r2 jsonb; c bigint; v int; k text;
  att uuid; tok uuid; tok2 uuid; tok3 uuid; vatt uuid; patt uuid; ptok uuid;
begin
  -- ── fixtures (as the database owner) ──────────────────────────────────────
  k := private.identity_key();
  delete from public.papers where title like '[selftest]%';
  delete from auth.users where id in (u_admin, u_editor, u_s1, u_s2, u_s3);
  delete from private.banned_names where name_hash = private.name_hash('Banned_Guy', k);

  insert into auth.users (id, email, raw_user_meta_data, is_anonymous) values
    (u_admin,  'selftest-admin@example.invalid',  '{"full_name":"Test Admin"}',  false),
    (u_editor, 'selftest-editor@example.invalid', '{"full_name":"Test Editor"}', false),
    (u_s1, null, '{}', true),
    (u_s2, null, '{}', true),
    (u_s3, null, '{}', true);
  update public.profiles set handle = 'selftest_admin'  where id = u_admin;
  update public.profiles set handle = 'selftest_editor' where id = u_editor;
  insert into public.staff (user_id, role) values (u_admin, 'admin'), (u_editor, 'editor');

  select count(*) into c from public.profiles where id in (u_s1, u_s2, u_s3);
  names := names || 'anonymous students get no profile row'::text; passes := passes || (c = 0); details := details || (c || ' rows');

  insert into public.papers (title, starts_at, ends_at) values ('[selftest] live',   now() - interval '10 minutes', now() + interval '3 hours')  returning id into p_live;
  insert into public.papers (title, starts_at, ends_at) values ('[selftest] future', now() + interval '1 day',      now() + interval '2 days')   returning id into p_future;
  insert into public.papers (title, starts_at, ends_at) values ('[selftest] draft',  now() + interval '1 day',      now() + interval '2 days')   returning id into p_draft;
  insert into public.papers (title, starts_at, ends_at) values ('[selftest] ended',  now() - interval '5 hours',    now() - interval '1 hour')   returning id into p_ended;

  update public.questions
     set body = 'Body ' || slot, solution = 'SECRET_SOLUTION',
         correct_options = case when slot <= 20 then array['A'] else '{}'::text[] end,
         correct_min = case when slot > 20 then 4.99 end,
         correct_max = case when slot > 20 then 5.01 end
   where paper_id in (p_live, p_future, p_ended);
  update public.papers set status = 'published' where id in (p_live, p_future, p_ended);

  select id into q1  from public.questions where paper_id = p_live  and subject = 'physics' and slot = 1;
  select id into q2  from public.questions where paper_id = p_live  and subject = 'physics' and slot = 2;
  select id into q21 from public.questions where paper_id = p_live  and subject = 'physics' and slot = 21;
  select id into lq  from public.questions where paper_id = p_live  and subject = 'chemistry' and slot = 5;
  select id into eq  from public.questions where paper_id = p_ended and subject = 'physics' and slot = 1;
  select id, version into dq, v from public.questions where paper_id = p_draft and subject = 'physics' and slot = 1;

  -- Finished paper: Top_Student (held by s1's browser) answers everything right (300);
  -- Last_Place (no live session any more) gets all of Section A wrong (−60).
  insert into public.attempts (paper_id, user_id, name_hash, name_enc, pin_hash, status, started_at, deadline_at, submitted_at, responses, seq)
  select p_ended, u_s1, private.name_hash('Top_Student', k), private.name_enc('Top_Student', k), extensions.crypt('1357', extensions.gen_salt('bf', 6)),
         'submitted', now() - interval '5 hours', now() - interval '2 hours', now() - interval '2 hours',
         jsonb_object_agg(id::text, jsonb_build_object('a', case when slot <= 20 then 'A' else '5' end, 's', 'an', 't', 1000)), 1
    from public.questions where paper_id = p_ended;
  insert into public.attempts (paper_id, user_id, name_hash, name_enc, pin_hash, status, started_at, deadline_at, submitted_at, responses, seq)
  select p_ended, null, private.name_hash('Last_Place', k), private.name_enc('Last_Place', k), extensions.crypt('8642', extensions.gen_salt('bf', 6)),
         'submitted', now() - interval '5 hours', now() - interval '2 hours', now() - interval '2 hours',
         jsonb_object_agg(id::text, jsonb_build_object('a', 'B', 's', 'an', 't', 1000)), 1
    from public.questions where paper_id = p_ended and slot <= 20;

  -- ── anonymous visitor (no session at all) ─────────────────────────────────
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);

  t := 'visitor cannot read papers table';
  begin
    select count(*) into c from public.papers;
    names := names || t; passes := passes || false; details := details || ('read ' || c || ' rows');
  exception when insufficient_privilege then
    names := names || t; passes := passes || true; details := details || 'permission denied'::text;
  end;

  t := 'visitor cannot read server-only schema';
  begin
    select count(*) into c from private.leaderboard;
    names := names || t; passes := passes || false; details := details || 'read succeeded'::text;
  exception when insufficient_privilege then
    names := names || t; passes := passes || true; details := details || 'permission denied'::text;
  end;

  t := 'visitor cannot start an exam without a session';
  begin
    r := public.start_attempt(p_live, false, 'Someone', '1234');
    names := names || t; passes := passes || false; details := details || r::text;
  exception when insufficient_privilege then
    names := names || t; passes := passes || true; details := details || 'permission denied'::text;
  end;

  r := public.list_papers();
  names := names || 'paper list shows published, hides drafts'::text;
  passes := passes || (r::text like '%' || p_live || '%' and r::text not like '%' || p_draft || '%');
  details := details || ''::text;

  names := names || 'a draft paper is invisible by id'::text;
  passes := passes || (public.get_paper_info(p_draft) is null);
  details := details || ''::text;

  -- ── student 1 (anonymous session, browser A) ──────────────────────────────
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_s1, 'role', 'authenticated', 'is_anonymous', true)::text, true);

  select count(*) into c from public.questions;
  names := names || 'student sees zero question rows (answer keys hidden)'::text; passes := passes || (c = 0); details := details || (c || ' rows');

  select count(*) into c from public.papers;
  names := names || 'student sees zero paper rows'::text; passes := passes || (c = 0); details := details || (c || ' rows');

  t := 'student cannot read attempts table';
  begin
    select count(*) into c from public.attempts;
    names := names || t; passes := passes || false; details := details || ('read ' || c || ' rows');
  exception when insufficient_privilege then
    names := names || t; passes := passes || true; details := details || 'permission denied'::text;
  end;

  update public.questions set body = 'hacked' where paper_id = p_live;
  get diagnostics c = row_count;
  names := names || 'student cannot edit questions'::text; passes := passes || (c = 0); details := details || (c || ' rows changed');

  t := 'student cannot create papers';
  begin
    insert into public.papers (title, starts_at, ends_at) values ('[selftest] hack', now(), now() + interval '1 hour');
    names := names || t; passes := passes || false; details := details || 'insert succeeded'::text;
  exception when insufficient_privilege then
    names := names || t; passes := passes || true; details := details || 'blocked by row-level security'::text;
  end;

  t := 'student cannot call internal functions';
  begin
    perform private.identity_key();
    names := names || t; passes := passes || false; details := details || 'call succeeded'::text;
  exception when insufficient_privilege then
    names := names || t; passes := passes || true; details := details || 'permission denied'::text;
  end;

  r := public.admin_publish_paper(p_draft);
  names := names || 'student cannot use admin functions'::text; passes := passes || (r ->> 'error' = 'forbidden'); details := details || r::text;

  r := public.set_handle('sneaky_name');
  names := names || 'anonymous sessions cannot set staff handles'::text; passes := passes || (r ->> 'error' = 'forbidden'); details := details || (r ->> 'error');

  r := public.start_attempt(p_live, false);
  names := names || 'starting requires a Reddit username'::text; passes := passes || (r ->> 'error' = 'name_required'); details := details || (r ->> 'error');
  r := public.start_attempt(p_live, false, 'not a name!', '1234');
  names := names || 'invalid usernames are refused'::text; passes := passes || (r ->> 'error' = 'name_invalid'); details := details || (r ->> 'error');
  r := public.start_attempt(p_live, false, 'Reddit_One', '12');
  names := names || 'PIN must be 4–8 digits'::text; passes := passes || (r ->> 'error' = 'pin_invalid'); details := details || (r ->> 'error');

  r := public.start_attempt(p_future, false, 'Reddit_One', '2468');
  names := names || 'cannot start before the start time'::text; passes := passes || (r ->> 'error' = 'not_started'); details := details || (r ->> 'error');
  r := public.start_attempt(p_draft, false, 'Reddit_One', '2468');
  names := names || 'cannot start a draft paper'::text; passes := passes || (r ->> 'error' = 'paper_not_found'); details := details || (r ->> 'error');
  r := public.start_attempt(p_live, true);
  names := names || 'no practice mode while a paper is live'::text; passes := passes || (r ->> 'error' = 'practice_unavailable'); details := details || (r ->> 'error');

  r := public.start_attempt(p_live, false, 'u/Reddit_One', '2468');
  att := (r -> 'attempt' ->> 'id')::uuid; tok := (r -> 'attempt' ->> 'token')::uuid;
  names := names || 'student can start with username + PIN ("u/" is stripped)'::text;
  passes := passes || (att is not null and r -> 'attempt' ->> 'name' = 'Reddit_One'); details := details || coalesce(r ->> 'error', r -> 'attempt' ->> 'name');
  names := names || 'exam payload has all 75 questions'::text; passes := passes || (jsonb_array_length(r -> 'paper' -> 'questions') = 75); details := details || (jsonb_array_length(r -> 'paper' -> 'questions'))::text;
  names := names || 'exam payload contains no answers or solutions'::text;
  passes := passes || (r::text not like '%SECRET_SOLUTION%' and r::text not like '%correct_options%' and r::text not like '%correct_min%');
  details := details || ''::text;

  r := public.start_attempt(p_live, false);
  tok2 := (r -> 'attempt' ->> 'token')::uuid;
  names := names || 'same browser resumes without the PIN (new tab takes over)'::text; passes := passes || (tok2 is not null and tok2 <> tok); details := details || coalesce(r ->> 'error', 'ok');

  r := public.save_progress(att, tok, 10, '{}'::jsonb);
  names := names || 'old tab can no longer write'::text; passes := passes || (r ->> 'error' = 'superseded'); details := details || r::text;

  r := public.save_progress(att, tok2, 10, jsonb_build_object(
         q1::text,  jsonb_build_object('a', 'E'),
         q2::text,  jsonb_build_object('a', 'A', 's', 'an', 't', 5000),
         q21::text, jsonb_build_object('a', '12abc'),
         'not-a-question', jsonb_build_object('a', 'A')));
  names := names || 'valid save accepted'::text; passes := passes || coalesce((r ->> 'ok')::boolean, false); details := details || r::text;

  r := public.save_progress(att, tok2, 11, '{}'::jsonb);
  names := names || 'save flood is rate-limited'::text; passes := passes || (r ->> 'error' = 'slow_down'); details := details || r::text;

  r := public.save_progress(att, tok2, 5, '{}'::jsonb);
  names := names || 'out-of-order (older) save is ignored'::text; passes := passes || coalesce((r ->> 'stale')::boolean, false); details := details || r::text;

  -- ── student 2: same person, laptop died, continues on a phone ─────────────
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_s2, 'role', 'authenticated', 'is_anonymous', true)::text, true);

  r := public.save_progress(att, tok2, 99, '{}'::jsonb);
  names := names || 'another session cannot write someone''s attempt'::text; passes := passes || (r ->> 'error' = 'attempt_not_found'); details := details || (r ->> 'error');

  r := public.start_attempt(p_live, false, 'reddit_one', '0000');
  names := names || 'wrong PIN cannot take over a username'::text;
  passes := passes || (r ->> 'error' = 'pin_wrong' and (r ->> 'tries_left')::int = 4); details := details || r::text;

  r := public.start_attempt(p_live, false, 'REDDIT_ONE', '2468');
  tok3 := (r -> 'attempt' ->> 'token')::uuid;
  names := names || 'right PIN resumes the same attempt on a new device'::text;
  passes := passes || ((r -> 'attempt' ->> 'id')::uuid = att and r -> 'attempt' -> 'responses' ? q2::text); details := details || coalesce(r ->> 'error', 'ok');

  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_s1, 'role', 'authenticated', 'is_anonymous', true)::text, true);
  r := public.save_progress(att, tok2, 50, '{}'::jsonb);
  names := names || 'the old device is told it moved'::text; passes := passes || (r ->> 'error' = 'superseded'); details := details || (r ->> 'error');

  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_s2, 'role', 'authenticated', 'is_anonymous', true)::text, true);
  r := public.submit_attempt(att, tok3, 12, jsonb_build_object(
         q1::text,  jsonb_build_object('a', 'E'),
         q2::text,  jsonb_build_object('a', 'A', 's', 'an', 't', 5000),
         q21::text, jsonb_build_object('a', '12abc'),
         'not-a-question', jsonb_build_object('a', 'A')));
  names := names || 'submit works'::text; passes := passes || (r ->> 'status' = 'submitted'); details := details || r::text;

  r := public.start_attempt(p_live, false, 'Reddit_One', '2468');
  names := names || 'cannot retake after submitting'::text; passes := passes || (r ->> 'error' = 'already_submitted'); details := details || (r ->> 'error');

  r := public.get_my_result(p_live, false);
  names := names || 'no score/answers/solutions before the paper ends'::text;
  passes := passes || (coalesce((r ->> 'pending')::boolean, false) and not (r ? 'questions') and r::text not like '%SECRET%');
  details := details || r::text;

  r := public.get_leaderboard(p_live, 0, 50);
  names := names || 'no leaderboard before the paper ends'::text; passes := passes || coalesce((r ->> 'pending')::boolean, false); details := details || r::text;

  -- ── student 3 claims a name; student 1 tries to guess its PIN ─────────────
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_s3, 'role', 'authenticated', 'is_anonymous', true)::text, true);
  r := public.start_attempt(p_live, false, 'Victim_Name', '1111');
  vatt := (r -> 'attempt' ->> 'id')::uuid;

  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_s1, 'role', 'authenticated', 'is_anonymous', true)::text, true);
  for i in 1..4 loop r := public.start_attempt(p_live, false, 'Victim_Name', '000' || i); end loop;
  r := public.start_attempt(p_live, false, 'Victim_Name', '0005');
  r2 := public.start_attempt(p_live, false, 'Victim_Name', '1111');
  names := names || '5 wrong PINs lock the name (even the right PIN waits)'::text;
  passes := passes || (r ->> 'error' = 'pin_locked' and r2 ->> 'error' = 'pin_locked'); details := details || (r2 ->> 'error');

  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_ghost, 'role', 'authenticated', 'is_anonymous', true)::text, true);
  r := public.start_attempt(p_live, false, 'Ghost_User', '1234');
  names := names || 'a deleted session is told to sign in again'::text; passes := passes || (r ->> 'error' = 'session_expired'); details := details || (r ->> 'error');

  -- ── editor ────────────────────────────────────────────────────────────────
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_editor, 'role', 'authenticated')::text, true);

  select count(*) into c from public.questions where paper_id = p_draft;
  names := names || 'editor sees the 75 question slots'::text; passes := passes || (c = 75); details := details || (c || ' rows');

  update public.questions set body = 'edited by editor' where id = dq and version = v;
  get diagnostics c = row_count;
  names := names || 'editor can edit a draft question'::text; passes := passes || (c = 1); details := details || (c || ' rows');

  update public.questions set body = 'stale overwrite' where id = dq and version = v;
  get diagnostics c = row_count;
  names := names || 'stale version cannot overwrite a newer edit'::text; passes := passes || (c = 0); details := details || (c || ' rows');

  update public.questions set verified = true where id = dq;
  select count(*) into c from public.questions where id = dq and verified and verified_by = u_editor;
  names := names || 'verification records who verified'::text; passes := passes || (c = 1); details := details || ''::text;

  update public.questions set body = 'changed after verify' where id = dq;
  select count(*) into c from public.questions where id = dq and not verified;
  names := names || 'content change clears verification'::text; passes := passes || (c = 1); details := details || ''::text;

  t := 'editor cannot drop (bonus) a question';
  begin
    update public.questions set bonus = true where id = dq;
    names := names || t; passes := passes || false; details := details || 'update succeeded'::text;
  exception when raise_exception then
    names := names || t; passes := passes || (sqlerrm = 'admin_only'); details := details || sqlerrm;
  end;

  t := 'editor cannot edit a published paper';
  begin
    update public.questions set body = 'mid-exam edit' where id = lq;
    names := names || t; passes := passes || false; details := details || 'update succeeded'::text;
  exception when raise_exception then
    names := names || t; passes := passes || (sqlerrm = 'paper_locked'); details := details || sqlerrm;
  end;

  t := 'editor cannot change paper status directly';
  begin
    update public.papers set status = 'published' where id = p_draft;
    names := names || t; passes := passes || false; details := details || 'update succeeded'::text;
  exception when insufficient_privilege then
    names := names || t; passes := passes || true; details := details || 'permission denied'::text;
  end;

  insert into public.papers (title, starts_at, ends_at) values ('[selftest] editor paper', now() + interval '1 day', now() + interval '2 days')
  returning id into p_new;
  select count(*) into c from public.questions where paper_id = p_new;
  names := names || 'editor can create a paper (75 slots appear)'::text; passes := passes || (c = 75); details := details || (c || ' slots');

  r := public.admin_publish_paper(p_new);
  names := names || 'editor cannot publish'::text; passes := passes || (r ->> 'error' = 'forbidden'); details := details || (r ->> 'error');

  r := public.admin_set_staff('selftest-editor@example.invalid', 'admin');
  names := names || 'editor cannot promote themselves'::text; passes := passes || (r ->> 'error' = 'forbidden'); details := details || (r ->> 'error');

  -- ── admin ─────────────────────────────────────────────────────────────────
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_admin, 'role', 'authenticated')::text, true);

  r := public.admin_publish_paper(p_draft);
  names := names || 'publishing an incomplete paper is refused'::text;
  passes := passes || (r ->> 'error' = 'incomplete' and jsonb_array_length(r -> 'missing') = 75);
  details := details || coalesce(r ->> 'error', 'ok');

  update public.questions set note = 'admin fix during exam' where id = lq;
  get diagnostics c = row_count;
  names := names || 'admin can fix a live paper'::text; passes := passes || (c = 1); details := details || (c || ' rows');

  r := public.admin_monitor(p_live, 'all', 0, 50);
  names := names || 'admin monitor shows decrypted usernames'::text;
  passes := passes || ((r -> 'counts' ->> 'started')::int = 2 and r -> 'attempts' @> '[{"handle":"Reddit_One"}]'::jsonb);
  details := details || (r -> 'counts')::text;

  r := public.admin_reset_pin(vatt);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_s1, 'role', 'authenticated', 'is_anonymous', true)::text, true);
  r := public.start_attempt(p_live, false, 'Victim_Name', '9999');
  names := names || 'after an admin PIN reset, the next claim sets a new PIN'::text;
  passes := passes || ((r -> 'attempt' ->> 'id')::uuid = vatt); details := details || coalesce(r ->> 'error', 'ok');

  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  r := public.admin_ban_name('u/Banned_Guy', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_s3, 'role', 'authenticated', 'is_anonymous', true)::text, true);
  r := public.start_attempt(p_live, false, 'banned_guy', '4321');
  names := names || 'banned usernames cannot start'::text; passes := passes || (r ->> 'error' = 'banned'); details := details || (r ->> 'error');

  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  r := public.admin_list_staff();
  select count(*) into c from jsonb_array_elements(r -> 'staff') e where e ->> 'role' = 'admin';
  if c = 1 then
    r := public.admin_set_staff('selftest-admin@example.invalid', 'editor');
    names := names || 'cannot demote the last admin'::text; passes := passes || (r ->> 'error' = 'last_admin'); details := details || coalesce(r ->> 'error', 'ok');
  else
    names := names || 'cannot demote the last admin'::text; passes := passes || true; details := details || 'skipped: you already have other admins'::text;
  end if;

  -- ── results of the finished paper ─────────────────────────────────────────
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_s1, 'role', 'authenticated', 'is_anonymous', true)::text, true);
  r := public.get_my_result(p_ended, false);
  names := names || 'scoring: all correct = 300'::text; passes := passes || ((r -> 'attempt' ->> 'score')::int = 300); details := details || coalesce(r -> 'attempt' ->> 'score', r::text);
  names := names || 'rank 1, percentile 100'::text; passes := passes || ((r ->> 'rank')::int = 1 and (r ->> 'percentile')::numeric = 100); details := details || (coalesce(r ->> 'rank', '?') || ' / ' || coalesce(r ->> 'percentile', '?'));
  names := names || 'solutions visible after results'::text; passes := passes || (r::text like '%SECRET_SOLUTION%'); details := details || ''::text;

  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  r := public.get_my_result(p_ended, false, 'last_place', '0000');
  names := names || 'result lookup by name needs the right PIN'::text; passes := passes || (r ->> 'error' = 'pin_wrong'); details := details || (r ->> 'error');
  r := public.get_my_result(p_ended, false, 'u/Last_Place', '8642');
  names := names || 'username + PIN finds a result from any device'::text;
  passes := passes || ((r -> 'attempt' ->> 'score')::int = -60 and (r ->> 'percentile')::numeric = 50); details := details || coalesce(r -> 'attempt' ->> 'score', r::text);
  r := public.get_my_result(p_ended, false);
  names := names || 'anyone can read solutions after results (no personal data)'::text;
  passes := passes || (r -> 'attempt' = 'null'::jsonb and jsonb_array_length(r -> 'questions') = 75); details := details || ''::text;

  r := public.get_leaderboard(p_ended, 0, 50);
  names := names || 'public leaderboard shows Reddit usernames'::text;
  passes := passes || ((r ->> 'total')::int = 2 and r -> 'rows' -> 0 ->> 'handle' = 'Top_Student'); details := details || coalesce(r ->> 'total', r::text);

  -- answer key change + rescore (admin)
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  update public.questions set correct_options = array['B'] where id = eq;
  r := public.admin_rescore_paper(p_ended);
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_s1, 'role', 'authenticated', 'is_anonymous', true)::text, true);
  r := public.get_my_result(p_ended, false);
  r2 := public.get_leaderboard(p_ended, 0, 50);
  names := names || 'answer-key change + rescore updates scores'::text;
  passes := passes || ((r -> 'attempt' ->> 'score')::int = 295 and (r2 -> 'rows' -> 1 ->> 'score')::int = -55);
  details := details || (coalesce(r -> 'attempt' ->> 'score', '?') || ' / ' || coalesce(r2 -> 'rows' -> 1 ->> 'score', '?'));

  -- practice after results (no name needed)
  r := public.start_attempt(p_ended, true);
  patt := (r -> 'attempt' ->> 'id')::uuid; ptok := (r -> 'attempt' ->> 'token')::uuid;
  names := names || 'practice mode opens after results'::text; passes := passes || (patt is not null); details := details || coalesce(r ->> 'error', 'ok');
  r := public.submit_attempt(patt, ptok, 1, '{}'::jsonb);
  r := public.get_my_result(p_ended, true);
  names := names || 'practice attempt is scored immediately, not ranked'::text;
  passes := passes || ((r -> 'attempt' ->> 'practice')::boolean and r -> 'attempt' ->> 'score' = '0' and r ->> 'rank' is null);
  details := details || coalesce(r -> 'attempt' ->> 'score', r::text);

  -- flush personal data
  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  r := public.admin_flush_paper(p_live);
  names := names || 'cannot flush before results exist'::text; passes := passes || (r ->> 'error' = 'results_not_ready'); details := details || (r ->> 'error');
  r := public.admin_flush_paper(p_ended);
  names := names || 'flush deletes every attempt of the paper'::text; passes := passes || ((r ->> 'attempts')::int = 3); details := details || r::text;

  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_s1, 'role', 'authenticated', 'is_anonymous', true)::text, true);
  r := public.get_leaderboard(p_ended, 0, 50);
  names := names || 'leaderboard (names + scores) survives the flush'::text;
  passes := passes || ((r ->> 'total')::int = 2 and r -> 'rows' -> 0 ->> 'handle' = 'Top_Student'); details := details || coalesce(r ->> 'total', r::text);
  r := public.get_my_result(p_ended, false);
  names := names || 'after the flush nothing personal is left to show'::text;
  passes := passes || ((r ->> 'flushed')::boolean and r -> 'attempt' = 'null'::jsonb); details := details || ''::text;
  r := public.get_my_result(p_ended, false, 'Top_Student', '1357');
  names := names || 'after the flush the name + PIN no longer match anything'::text; passes := passes || (r ->> 'error' = 'flushed'); details := details || (r ->> 'error');
  r := public.get_overall_leaderboard(100);
  names := names || 'overall leaderboard still counts the flushed paper'::text; passes := passes || (r -> 'rows' @> '[{"handle":"Top_Student"}]'::jsonb); details := details || ''::text;

  perform set_config('request.jwt.claims', jsonb_build_object('sub', u_admin, 'role', 'authenticated')::text, true);
  r := public.admin_rescore_paper(p_ended);
  names := names || 'a flushed paper cannot be re-scored into an empty board'::text; passes := passes || (r ->> 'error' = 'flushed'); details := details || (r ->> 'error');

  -- ── back to owner: check what was stored, then clean up ───────────────────
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);

  select responses into r from public.attempts where id = att;
  names := names || 'server drops malformed answers and unknown keys'::text;
  passes := passes || (r -> q1::text ->> 'a' is null and r -> q2::text ->> 'a' = 'A'
                       and r -> q21::text ->> 'a' is null and not (r ? 'not-a-question'));
  details := details || r::text;

  select count(*) into c from public.attempts
   where id = att and (encode(name_hash, 'escape') like '%Reddit%' or encode(name_enc, 'escape') ilike '%reddit_one%'
                       or pin_hash like '%2468%' or responses::text ilike '%reddit_one%');
  names := names || 'the stored attempt has no plaintext username or PIN'::text; passes := passes || (c = 0); details := details || ''::text;

  select count(*) into c from public.attempts where paper_id = p_ended;
  names := names || 'no hashes or PINs remain for the flushed paper'::text; passes := passes || (c = 0); details := details || (c || ' attempts');

  delete from private.audit_log
   where paper_id in (select id from public.papers where title like '[selftest]%')
      or actor in (u_admin, u_editor, u_s1, u_s2, u_s3);
  delete from private.banned_names where name_hash = private.name_hash('Banned_Guy', k);
  delete from public.papers where title like '[selftest]%';
  delete from auth.users where id in (u_admin, u_editor, u_s1, u_s2, u_s3);

  insert into _results select i, names[i], passes[i], details[i] from generate_subscripts(names, 1) as i;
end $test$;

select n as "#", case when pass then 'PASS' else 'FAIL' end as result, test, detail
  from _results order by n;
