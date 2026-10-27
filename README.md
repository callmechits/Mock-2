# JEE Mains Mock

Full-length **JEE Main** mock tests (75 questions · 25 per subject · Section A 20 MCQ + Section B 5 numerical · +4/−1) in a CBT-style interface, with server-side timing and scoring, ranks and NTA-style percentiles, and a staff console where your team writes questions together in real time.

- **Students** don't make accounts. On the exam page they type their **Reddit username + a PIN** → take the paper fullscreen → when it closes, see score, rank, percentile, time per question and solutions (from any device, with the same username + PIN) → practise it again later (unranked).
- **Staff** (Google login): 75-slot editor with live preview, LaTeX (`$…$`) and chemistry (`\ce{…}`), paste-a-screenshot images, **bulk image upload by file name**, bulk text import, **full backups with images**, second-person verification, version history, live presence ("chits is on P14"), conflict-safe saving, preview-as-student, publishing, live exam monitor, extra time, PIN resets, username bans, re-scoring after answer-key changes, and a **Flush personal data** button.

---

## How students are identified (and forgotten)

| | |
|---|---|
| **Signing in** | The exam page quietly creates an *anonymous* Supabase session for the browser. No email, no Google, nothing to remember except the PIN. |
| **Identity** | Per paper, the student types a Reddit username and picks a 4–8 digit PIN. One ranked attempt per username per paper. |
| **What's stored** | A keyed hash of the lower-cased username (HMAC-SHA256), a bcrypt hash of the PIN, and the username **encrypted** (AES-256). The key lives in Supabase Vault — it never leaves the database and isn't in table dumps. The plain username is never stored. |
| **During the exam** | Nothing public. Only admins see names (decrypted) in the live monitor. |
| **After it closes** | Usernames are decrypted onto the public leaderboard with scores. Students see their own detailed result on the same browser, or anywhere with username + PIN. |
| **New device mid-exam** | Same username + PIN on the new device takes the attempt over; the old device is locked out. 5 wrong PINs lock the name for 15 minutes. |
| **Flush** (admin, per paper, manual) | Deletes every attempt of that paper — answers, timings, name hashes, encrypted names, PIN hashes, device tokens — plus the anonymous sessions used for it. The leaderboard (username + scores), question stats and solutions stay. |

**Honest limits.** Reddit doesn't offer a sign-in that Supabase supports out of the box, so nobody proves they *own* a Reddit username:

- Someone could take a paper as `u/someone_else` before the real person does. Once taken, the PIN protects it. If it happens, ban that username or **Reset attempt** from the monitor.
- One person can take a paper several times under different usernames, by using another browser for each. Scores are hidden until the paper closes, so extra attempts can't be used to find answers — they only add leaderboard noise. Ban those names.

---

## What changed from the old site

| Old site | Now |
|---|---|
| The anon key could read and write **every table**. | Students have **no table access at all**. They can only call a handful of database functions, each of which checks the session, the clock and ownership. |
| Correct answers were downloaded with the paper. | Answer keys and solutions **never leave the database** until results are published after the paper closes. |
| Scores were computed in the browser and uploaded. | Scores are computed **in the database**. The browser only sends answers. |
| Anyone could type any name, retake, or overwrite someone else. | **One attempt per Reddit username per paper**, protected by a PIN. Attempts are tied to the browser session; changing device needs the PIN. |
| Timer ran in the browser. | The **server owns the deadline**; late saves are rejected; unfinished attempts are closed automatically. |
| Admin password check via a public RPC. | **Role-based staff** (admin / editor) on real accounts; editors can't publish or escalate. |
| `innerHTML` with user data everywhere (XSS). | Everything user-supplied is escaped or sanitised (DOMPurify allow-list), plus a strict Content-Security-Policy. |
| Anyone could upload images. | Staff-only uploads, random unguessable file names, images only, 3 MB cap. |

Fullscreen, tab-switch logging, copy/print blocking and the `u/username` watermark only discourage cheating. They're recorded and shown in the live monitor, but they don't decide anything: scoring, timing and keeping answers secret never depend on the browser.

---

## Question images

- **One at a time:** in any slot, paste a screenshot (Ctrl+V), drop a file, or click the image box. Paste goes to whatever you're focused on: question text → question image, an option → that option's image, the solution → solution image.
- **Many at once:** **Bulk images** in the slot sidebar. Drop a folder's worth of screenshots named like `P1.png`, `phy 7.jpg`, `chem-12.png`, `Maths_Q25.png`; add `sol` for solution images (`P1 sol.png`). Or switch to "in order from the current slot". You see where each file goes before anything uploads.
- **Where they're stored:** compressed in the browser (WebP, max 1600 px wide, white background so transparent screenshots stay readable), then uploaded to the Supabase Storage bucket `qimg` under a random name. In the offline demo they're kept in the browser's IndexedDB.
- **Backups:** **Export → Full backup** downloads one JSON file with every image embedded. Importing it (Bulk import → paste the JSON) re-uploads the images into whichever paper you import into — so it also copies a paper between projects. "Questions only" exports are small and keep pointing at the stored images.

---

## Architecture

```
 Browser (static HTML/JS)  ──HTTPS──▶  Cloudflare Pages  (free, global CDN, DDoS-protected)
        │
        └──HTTPS/WSS──▶  Supabase
                          ├─ Auth      anonymous sessions (students) · Google / Discord (staff)
                          ├─ Postgres  tables + RLS + all logic (supabase/schema.sql)
                          │            pg_cron closes timed-out attempts & builds results every minute
                          ├─ Vault     the key for hashing/encrypting Reddit usernames
                          ├─ Realtime  staff-only: live edits + presence on private channels
                          └─ Storage   question images (bucket `qimg`)
```

No server code to run or maintain; `web/` is plain static files.

**Exam resilience:** every answer is written to the device first and synced in the background with retries, so a Wi-Fi drop or a refresh loses nothing; out-of-order requests can't overwrite newer answers; if the internet is down at 00:00 the server closes the attempt with the last synced answers.

---


### Make yourself admin
```
insert into public.staff (user_id, role)
select id, 'admin' from auth.users where email = 'you@example.com'
on conflict (user_id) do update set role = 'admin';
```
Add editors/admins from **Console → People → Team** (they must sign in once first).

---

## Writing questions (Console)

- A paper always has 75 slots: **P1–P25, C1–C25, M1–M25**. Slots 1–20 are single-correct, 21–25 numerical.
- **Fastest path:** paste a screenshot of the whole question, click the correct letter, press **Ctrl+Enter** (save & next). Empty option fields are fine when the options are in the image. Or bulk-upload all 75 screenshots by file name, then just set answers.
- Maths `$x^2$`, `$$\int_0^1 x\,dx$$`; chemistry `\ce{H2SO4}`; also `<b> <i> <sup> <sub>` and tables. Numerical answers take a value and optional tolerance (`12 ± 0.01`).
- **Bulk import (text):**

  ```
  1. A ball is thrown up with speed $u$. Its maximum height is
  (A) $u^2/g$   (B) $u^2/2g$   (C) $2u^2/g$   (D) $u/2g$
  Answer: B
  Solution: At the top $v = 0$, so $h = u^2/2g$.
  ```
  Options `(A)`, `A)`, `a.` or NTA-style `(1)…(4)`; answers `B`, `(2)` or a number. A preview shows each question's target slot before saving.
- **Verify:** a second person presses *Mark verified*; any later content change clears it. Grid: empty → amber (no answer) → light green (ready) → solid green (verified).
- **Together:** avatars show who's on which slot; saved edits appear instantly for others; if two people save the same slot, the second gets *Load theirs / Overwrite with mine*. Everything is in **History**.
- **Preview as student** shows the real exam UI with the draft and scores it against your key. Editors can only change **draft** papers; admins can fix published ones.

---

## Running an exam

**Day before:** all 75 slots ready and verified → *Preview as student* → **Publish**. Raise the anonymous sign-in rate limit.

**Timing:** *Opens at*, *Entry window* and *Duration*. With *Auto* on, the paper closes at opening + entry window + duration, so the latest starter still gets the full 3 hours. Each student's deadline is set by the server when they start.

**Exam morning:** raise compute to **Medium** (Project Settings → Compute and Disk) a couple of hours early — it restarts the database briefly, so never during an exam. Keep **Live monitor** open: usernames, last save, answered count, tab switches, device changes, PIN lockouts.
- **+ time** for a genuine problem (results wait for them).
- **Reset PIN** if someone forgot it — only after you've confirmed who they are (e.g. by Reddit DM). The next person to enter that username sets a new PIN.
- **Reset** lets someone restart. **Ban** blocks the username.

**After it closes:** within a minute the server closes open attempts, scores everything and builds the leaderboard, percentiles and per-question stats. Answer-key challenge: edit the key or tick *Drop this question* (full marks to all), then **Re-score & rebuild results**.

**When you're done with it:** Settings & publish → **Flush personal data**. Do re-scoring first; a flushed paper can't be re-scored. Scale compute back down.

---

## Capacity — 5,000 students at once

- **Static site** on Cloudflare's CDN: no practical limit.
- **Start:** one anonymous sign-in (best done on the instructions page before the countdown ends) and one `start_attempt` call per student; clients spread the 9:00:00 rush over ~2.5 s and retry with back-off.
- **During:** a save after each answer (debounced) + a 90 s heartbeat ≈ 50–100 small writes/second at 5,000 users, rate-limited per attempt.
- **Results:** computed once per paper, then served from a precomputed leaderboard.
- **Realtime** is staff-only.

Recommended: **Pro + Small compute** normally, **Medium** on exam days (billed hourly). Daily backups are included in Pro; add Point-in-Time Recovery for restore-to-any-second. Optional: Database → Network restrictions; turn off GraphQL if unused; vendor the three CDN libraries (supabase-js 2.94.0, KaTeX 0.16.22, DOMPurify 3.2.6) into `web/vendor/`.

---

## Files

```
supabase/
  schema.sql          tables, row-level security, every server function, crypto, storage, realtime, cron
  self_test.sql       security & logic checks — run after schema.sql
  tests/run_local.py  runs both against a throwaway local Postgres (needs Postgres binaries + psycopg)
web/                  deploy this folder
  index.html          paper list             js/home.js
  exam.html           gate + CBT exam        js/exam.js
  results.html        score & solutions      js/results.js
  leaderboard.html    per paper / overall    js/leaderboard.js
  admin.html          staff console          js/admin.js, js/importer.js
  js/config.js        ← the only file you edit
  js/api.js           picks backend-supabase.js (real) or backend-demo.js (offline demo)
  js/ui.js            shared UI, sign-in, username/PIN fields, maths renderer
  css/                base, site, exam, admin styles (light + dark)
  _headers            security headers (CSP etc.) for Cloudflare Pages / Netlify
tools/serve.py        local preview server
```
