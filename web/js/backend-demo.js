// Offline demo backend. Same API surface and the same rules as the real
// database functions, but everything lives in this browser (localStorage for
// data, IndexedDB for images). It exists so the UI can be tried before
// Supabase is set up — it is NOT a security boundary.
import { ApiError } from './errors.js';

const KEY = 'jeemock_demo_v2';
const SESSION_KEY = 'jeemock_demo_session';
const SUBJECTS = ['physics', 'chemistry', 'mathematics'];
const GRACE = 30_000;
const M = 60_000;
const H = 60 * M;
const uuid = () => crypto.randomUUID();
const iso = (ms) => new Date(ms).toISOString();
const ms = (v) => (v ? Date.parse(v) : null);
const clone = (v) => JSON.parse(JSON.stringify(v));
const delay = (n = 120) => new Promise((r) => setTimeout(r, n + Math.random() * 120));
const fail = (code, detail) => { throw new ApiError(code, { error: code, ...detail }); };
const NUM_RE = /^-?[0-9]{1,7}(\.[0-9]{1,4})?$/;

// Stand-ins for the database's HMAC / bcrypt (demo only — not cryptographic).
function fnv(s) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (const c of s) { h1 = Math.imul(h1 ^ c.charCodeAt(0), 16777619) >>> 0; h2 = Math.imul(h2 ^ c.charCodeAt(0), 2246822519) >>> 0; }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
const nameHash = (name) => fnv(`name:${name.toLowerCase()}`);
const pinHash = (pin, salt = uuid().slice(0, 8)) => `${salt}$${fnv(`${salt}:${pin}`)}`;
const pinOk = (pin, stored) => !!stored && pinHash(pin, stored.split('$')[0]) === stored;
const cleanReddit = (s) => { const x = String(s ?? '').trim().replace(/^\/?u\//i, ''); return /^[A-Za-z0-9_-]{3,20}$/.test(x) ? x : null; };

let db = null;   // initialised below, once every helper is defined

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
}
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { console.warn('Demo storage is full', e); }
}
function uid() {
  try { return localStorage.getItem(SESSION_KEY); } catch { return null; }
}

// ── images: IndexedDB, so screenshots survive reloads (localStorage is ~5 MB) ─
const IDB = 'jeemock_demo_images';
const imageUrls = new Map();
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(IDB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('images');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idbPut(key, blob) {
  const d = await idb();
  await new Promise((res, rej) => {
    const tx = d.transaction('images', 'readwrite');
    tx.objectStore('images').put(blob, key);
    tx.oncomplete = res;
    tx.onerror = () => rej(tx.error);
  });
}
async function idbGet(key) {
  const d = await idb();
  return new Promise((res, rej) => {
    const r = d.transaction('images').objectStore('images').get(key);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function loadImages() {
  try {
    const d = await idb();
    await new Promise((res) => {
      const tx = d.transaction('images');
      const store = tx.objectStore('images');
      const keys = store.getAllKeys();
      const vals = store.getAll();
      tx.oncomplete = () => {
        keys.result.forEach((k, i) => imageUrls.set(k, URL.createObjectURL(vals.result[i])));
        res();
      };
      tx.onerror = () => res();
    });
  } catch (e) { console.warn('Demo image store unavailable', e); }
}

// ── seed data (placeholders only — real questions come from your editors) ──
function mkPaper(d, f) {
  const p = {
    id: uuid(), title: f.title, description: f.description || '', starts_at: iso(f.starts_at), ends_at: iso(f.ends_at),
    entry_window_min: f.entry_window_min ?? 30, duration_min: 180, scq_correct: 4, scq_wrong: -1, num_correct: 4, num_wrong: -1,
    allow_practice: true, status: f.status || 'draft', results_at: null, results_count: null, key_changed_at: null, flushed_at: null,
    created_by: 'u-demo', created_at: iso(Date.now()), updated_by: 'u-demo', updated_at: iso(Date.now()), version: 1,
  };
  d.papers.push(p);
  for (const s of SUBJECTS) for (let n = 1; n <= 25; n++) d.questions.push(blankQuestion(p.id, s, n));
  return p;
}
function blankQuestion(paperId, subject, slot) {
  return {
    id: uuid(), paper_id: paperId, subject, slot, kind: slot <= 20 ? 'scq' : 'numerical', body: '', image_path: null,
    options: ['', '', '', ''], option_images: [null, null, null, null], correct_options: [], correct_min: null, correct_max: null,
    solution: '', solution_image_path: null, bonus: false, note: '', verified: false, verified_by: null, verified_at: null,
    updated_by: null, updated_at: iso(Date.now()), version: 1,
  };
}
function fillPlaceholders(d, paper) {
  const name = { physics: 'Physics', chemistry: 'Chemistry', mathematics: 'Mathematics' };
  const sample = {
    physics: 'Inline maths renders like $v^2 = u^2 + 2as$.',
    chemistry: 'Chemistry notation renders like $\\ce{2H2 + O2 -> 2H2O}$.',
    mathematics: 'Display maths works too: $$\\int_0^1 x^2\\,dx = \\frac{1}{3}$$',
  };
  for (const q of d.questions.filter((x) => x.paper_id === paper.id)) {
    const L = q.subject[0].toUpperCase() + q.slot;
    if (q.slot <= 20) {
      q.body = `Placeholder ${name[q.subject]} question ${q.slot} (${L}). Replace it in the admin panel.\n${sample[q.subject]}`;
      q.options = ['A', 'B', 'C', 'D'].map((x) => `Placeholder option ${x}`);
      q.correct_options = [['A', 'B', 'C', 'D'][q.slot % 4]];
    } else {
      q.body = `Placeholder numerical question ${L}. The answer to this placeholder is ${q.slot}.`;
      q.correct_min = q.slot; q.correct_max = q.slot;
    }
    q.solution = `Placeholder solution for ${L}.`;
  }
}
function rng(seed) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
}
function fakeAttempts(d, paper, n) {
  const rand = rng(42);
  const qs = d.questions.filter((q) => q.paper_id === paper.id);
  for (let i = 1; i <= n; i++) {
    const name = `demo_student_${String(i).padStart(2, '0')}`;
    const skill = 0.25 + rand() * 0.7;
    const responses = {};
    for (const q of qs) {
      if (rand() < 0.2) continue;
      let a;
      if (q.kind === 'scq') a = rand() < skill ? q.correct_options[0] : ['A', 'B', 'C', 'D'][Math.floor(rand() * 4)];
      else a = String(rand() < skill ? q.correct_min : Math.floor(rand() * 50));
      responses[q.id] = { a, s: 'an', t: Math.floor(30000 + rand() * 200000) };
    }
    d.attempts.push(newAttempt({
      paper_id: paper.id, user_id: null, practice: false, status: 'submitted', name, name_hash: nameHash(name), pin_hash: pinHash('1234'),
      started_at: paper.starts_at, deadline_at: iso(ms(paper.starts_at) + 3 * H), submitted_at: iso(ms(paper.starts_at) + 2.5 * H), responses, seq: 1,
    }));
  }
}
function newAttempt(f) {
  return {
    id: uuid(), user_id: null, prev_users: [], practice: false, name: null, name_hash: null, pin_hash: null, pin_fails: 0, pin_locked_until: null,
    status: 'in_progress', started_at: iso(Date.now()), deadline_at: null, submitted_at: null, responses: {}, seq: 0,
    client_token: uuid(), sessions: 1, violations: {}, last_saved_at: null, ...f,
  };
}
function seed() {
  const t = Date.now();
  const d = {
    users: { 'u-demo': { id: 'u-demo', anonymous: false, email: 'you@demo.local', full_name: 'Demo Admin', handle: 'demo_admin', role: 'admin' } },
    papers: [], questions: [], attempts: [], leaderboard: {}, stats: {}, audit: [], banned: {},
  };
  const live = mkPaper(d, { title: 'Demo Mock 1 — live now', description: 'Placeholder questions so you can try the exam interface end to end.', starts_at: t - 5 * M, ends_at: t + 30 * H, entry_window_min: 1440, status: 'published' });
  fillPlaceholders(d, live);
  const ended = mkPaper(d, { title: 'Demo Mock 0 — finished', description: 'Already over: open the results, the leaderboard, or try practice mode. Every demo student’s PIN is 1234.', starts_at: t - 50 * H, ends_at: t - 47 * H, status: 'published' });
  fillPlaceholders(d, ended);
  fakeAttempts(d, ended, 40);
  db = d;
  buildResults(ended.id);
  mkPaper(d, { title: 'Draft paper — try the editor', starts_at: t + 48 * H, ends_at: t + 52 * H });
  return d;
}

// ── the same rules as the SQL functions ────────────────────────────────────
const paper = (id) => db.papers.find((p) => p.id === id);
const questionsOf = (pid) => db.questions.filter((q) => q.paper_id === pid)
  .sort((a, b) => SUBJECTS.indexOf(a.subject) - SUBJECTS.indexOf(b.subject) || a.slot - b.slot);
const me = () => { const id = uid(); return id ? db.users[id] : null; };
const isStaff = () => !!me()?.role;
const isAdmin = () => me()?.role === 'admin';
const complete = (q) => (q.body.trim() !== '' || q.image_path) &&
  (q.slot <= 20 ? q.correct_options.length > 0 : q.correct_min != null && q.correct_max != null);

function audit(action, paperId, questionId, detail) {
  db.audit.push({ id: db.audit.length + 1, at: iso(Date.now()), actor: uid(), action, paper_id: paperId, question_id: questionId, detail: detail || {} });
  if (db.audit.length > 2000) db.audit.splice(0, db.audit.length - 2000);
}

function payloadOf(p) {
  return {
    id: p.id, title: p.title, duration_min: p.duration_min,
    marks: { scq: { correct: p.scq_correct, wrong: p.scq_wrong }, numerical: { correct: p.num_correct, wrong: p.num_wrong } },
    questions: questionsOf(p.id).map((q) => ({
      id: q.id, subject: q.subject, slot: q.slot, kind: q.kind, body: q.body, image: q.image_path,
      options: q.kind === 'scq' ? q.options : null, option_images: q.kind === 'scq' ? q.option_images : null,
    })),
  };
}

function cleanResponses(pid, input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const q of questionsOf(pid)) {
    const e = input[q.id];
    if (!e || typeof e !== 'object' || Array.isArray(e)) continue;
    let a = null;
    if (q.slot <= 20 && ['A', 'B', 'C', 'D'].includes(e.a)) a = e.a;
    if (q.slot > 20 && typeof e.a === 'string' && NUM_RE.test(e.a)) a = e.a;
    const marked = e.s === 'ma' || e.s === 'mr';
    const t = typeof e.t === 'number' ? Math.min(Math.max(e.t, 0), 86400000) : 0;
    out[q.id] = { a, s: a ? (marked ? 'ma' : 'an') : (marked ? 'mr' : 'na'), t: Math.floor(t) };
  }
  return out;
}

function questionMarks(p, a) {
  return questionsOf(p.id).map((q) => {
    const raw = a.responses?.[q.id]?.a;
    const ans = raw === '' || raw == null ? null : raw;
    let ok;
    if (q.bonus) ok = true;
    else if (ans == null) ok = null;
    else if (q.slot <= 20) ok = q.correct_options.includes(ans);
    else ok = NUM_RE.test(ans) && Number(ans) >= Number(q.correct_min) && Number(ans) <= Number(q.correct_max);
    const marks = ok == null ? 0 : ok ? (q.slot <= 20 ? p.scq_correct : p.num_correct) : (q.slot <= 20 ? p.scq_wrong : p.num_wrong);
    return { question_id: q.id, subject: q.subject, tried: ans != null, ok, marks };
  });
}

function score(a) {
  const p = paper(a.paper_id);
  const m = questionMarks(p, a);
  const sum = (f) => m.filter(f).reduce((s, x) => s + x.marks, 0);
  Object.assign(a, {
    score: sum(() => true), score_physics: sum((x) => x.subject === 'physics'),
    score_chemistry: sum((x) => x.subject === 'chemistry'), score_mathematics: sum((x) => x.subject === 'mathematics'),
    n_correct: m.filter((x) => x.tried && x.ok).length, n_wrong: m.filter((x) => x.tried && x.ok === false).length,
    n_unattempted: m.filter((x) => !x.tried).length, scored_at: iso(Date.now()),
  });
}

function finalize(a, status) {
  if (a.status !== 'in_progress') return;
  a.status = status;
  a.submitted_at = status === 'expired' ? a.deadline_at : iso(Math.min(Date.now(), ms(a.deadline_at)));
  a.client_token = null;
  score(a);
}

function buildResults(pid) {
  const p = paper(pid);
  if (!p || p.status === 'draft' || p.flushed_at || Date.now() < ms(p.ends_at) + GRACE) return false;
  const ranked = db.attempts.filter((a) => a.paper_id === pid && !a.practice);
  if (ranked.some((a) => a.status === 'in_progress' && ms(a.deadline_at) + GRACE > Date.now())) return false;
  for (const a of ranked) if (a.status === 'in_progress') finalize(a, 'expired');
  for (const a of db.attempts.filter((x) => x.paper_id === pid && x.status !== 'in_progress')) score(a);
  const rows = ranked.filter((a) => a.status !== 'in_progress' && a.name && !db.banned[a.name_hash])
    .sort((x, y) => y.score - x.score || y.score_mathematics - x.score_mathematics || y.score_physics - x.score_physics
      || y.score_chemistry - x.score_chemistry || x.n_wrong - y.n_wrong);
  const n = rows.length;
  db.leaderboard[pid] = rows.map((a, i) => {
    let rank = i + 1;
    for (let j = i - 1; j >= 0; j--) {
      const b = rows[j];
      if (b.score === a.score && b.score_mathematics === a.score_mathematics && b.score_physics === a.score_physics
        && b.score_chemistry === a.score_chemistry && b.n_wrong === a.n_wrong) rank = j + 1; else break;
    }
    const atOrBelow = rows.filter((b) => b.score <= a.score).length;
    return {
      attempt_id: a.id, name_hash: a.name_hash, rank, handle: a.name, score: a.score,
      score_physics: a.score_physics, score_chemistry: a.score_chemistry, score_mathematics: a.score_mathematics,
      n_correct: a.n_correct, n_wrong: a.n_wrong, percentile: Math.round((atOrBelow / n) * 100000) / 1000,
    };
  });
  for (const q of questionsOf(pid)) db.stats[q.id] = { attempted: 0, correct: 0 };
  for (const a of ranked.filter((x) => x.status !== 'in_progress')) {
    for (const m of questionMarks(p, a)) {
      if (m.tried) db.stats[m.question_id].attempted++;
      if (m.tried && m.ok) db.stats[m.question_id].correct++;
    }
  }
  p.results_at = iso(Date.now()); p.results_count = n; p.key_changed_at = null;
  return true;
}

// What pg_cron does every minute; here it runs before each call.
function tick() {
  const t = Date.now();
  for (const a of db.attempts) if (a.status === 'in_progress' && ms(a.deadline_at) + GRACE < t) finalize(a, 'expired');
  for (const p of db.papers) if (p.status !== 'draft' && !p.results_at && !p.flushed_at && ms(p.ends_at) + GRACE < t) buildResults(p.id);
}

async function call(fn) {
  await delay();
  db = load() || db;
  tick();
  try {
    return clone(fn());
  } finally {
    persist();   // PIN-failure counters must stick even when the call fails
  }
}

const requireUser = () => me() || fail('not_authenticated');
const requireStaff = () => { requireUser(); if (!isStaff()) fail('forbidden'); };
const requireAdmin = () => { requireUser(); if (!isAdmin()) fail('forbidden'); };
const myRanked = (pid) => db.attempts.find((a) => a.paper_id === pid && a.user_id === uid() && !a.practice);
const practiceOpen = (pid) => db.attempts.some((a) => a.paper_id === pid && a.user_id === uid() && a.practice && a.status === 'in_progress' && ms(a.deadline_at) > Date.now());
const marksOf = (p) => ({ scq: { correct: p.scq_correct, wrong: p.scq_wrong }, numerical: { correct: p.num_correct, wrong: p.num_wrong } });

function checkPin(a, pin) {
  if (a.pin_locked_until && ms(a.pin_locked_until) > Date.now()) fail('pin_locked', { until: a.pin_locked_until });
  if (pinOk(pin, a.pin_hash)) { a.pin_fails = 0; a.pin_locked_until = null; return; }
  a.pin_fails++;
  if (a.pin_fails >= 5) { a.pin_fails = 0; a.pin_locked_until = iso(Date.now() + 15 * M); fail('pin_locked', { until: a.pin_locked_until }); }
  fail('pin_wrong', { tries_left: 5 - a.pin_fails });
}

function versioned(list, id, version, fields, before) {
  const row = list.find((r) => r.id === id);
  if (!row) fail('not_found');
  if (row.version !== version) return { conflict: true, row: clone(row) };
  const old = clone(row);
  before?.(row, fields);
  Object.assign(row, fields);
  row.version++; row.updated_at = iso(Date.now()); row.updated_by = uid();
  return { row: clone(row), old };
}

// ── cross-tab "realtime" for the collaboration demo ────────────────────────
const bc = 'BroadcastChannel' in window ? new BroadcastChannel('jeemock-demo') : null;
const tabId = uuid().slice(0, 4);
const subs = new Set();
bc?.addEventListener('message', async (e) => {
  if (e.data?.t === 'image' && !imageUrls.has(e.data.path)) {
    const blob = await idbGet(e.data.path).catch(() => null);
    if (blob) imageUrls.set(e.data.path, URL.createObjectURL(blob));
  }
  for (const s of subs) s(e.data);
});
const broadcast = (msg) => bc?.postMessage(msg);

db = load() || seed();
persist();
try { localStorage.removeItem('jeemock_demo_v1'); } catch { /* old demo format */ }
window.addEventListener('storage', (e) => { if (e.key === KEY) db = load() || db; });
await loadImages();

export const api = {
  demo: true,

  auth: {
    providers: ['demo'],
    async getUser() {
      const u = me();
      return u ? { id: u.id, anonymous: u.anonymous, email: u.email, name: u.full_name } : null;
    },
    async signIn() {
      localStorage.setItem(SESSION_KEY, 'u-demo');
      location.reload();
    },
    async signInAnonymously() {
      db = load() || db;
      const id = `anon-${uuid().slice(0, 8)}`;
      db.users[id] = { id, anonymous: true, email: null, full_name: '', handle: null, role: null };
      persist();
      localStorage.setItem(SESSION_KEY, id);
      return { id, anonymous: true };
    },
    async signOut() {
      localStorage.removeItem(SESSION_KEY);
    },
    onChange() {},
  },

  resetDemo() {
    localStorage.removeItem(KEY);
    localStorage.removeItem(SESSION_KEY);
    indexedDB.deleteDatabase(IDB);
    location.reload();
  },

  me: () => call(() => {
    const u = me();
    if (!u) return null;
    if (u.anonymous) return { id: u.id, anonymous: true };
    return { id: u.id, anonymous: false, handle: u.handle, full_name: u.full_name, banned: false, role: u.role };
  }),

  setHandle: (handle) => call(() => {
    const u = requireUser();
    if (u.anonymous) fail('forbidden');
    const h = String(handle || '').trim();
    if (!/^[A-Za-z0-9_]{3,20}$/.test(h)) fail('handle_invalid');
    if (['admin', 'administrator', 'staff', 'moderator', 'mod', 'support', 'system', 'root', 'null', 'undefined', 'anonymous', 'nta', 'official'].includes(h.toLowerCase())) fail('handle_reserved');
    if (Object.values(db.users).some((x) => x.id !== u.id && x.handle?.toLowerCase() === h.toLowerCase())) fail('handle_taken');
    u.handle = h;
    return { ok: true, handle: h };
  }),

  listPapers: () => call(() => ({
    now: iso(Date.now()),
    papers: db.papers.filter((p) => p.status === 'published').sort((a, b) => ms(b.starts_at) - ms(a.starts_at)).map((p) => {
      const a = myRanked(p.id);
      return {
        id: p.id, title: p.title, description: p.description, starts_at: p.starts_at, ends_at: p.ends_at,
        entry_window_min: p.entry_window_min, duration_min: p.duration_min, allow_practice: p.allow_practice,
        results_ready: !!p.results_at, results_count: p.results_count,
        mine: a ? { id: a.id, status: a.status, deadline_at: a.deadline_at } : null, practice_open: practiceOpen(p.id),
      };
    }),
  })),

  paperInfo: (paperId) => call(() => {
    const p = paper(paperId);
    if (!p || p.status !== 'published') return null;
    const a = myRanked(p.id);
    return {
      now: iso(Date.now()),
      paper: {
        id: p.id, title: p.title, description: p.description, starts_at: p.starts_at, ends_at: p.ends_at,
        entry_window_min: p.entry_window_min, duration_min: p.duration_min, allow_practice: p.allow_practice,
        results_ready: !!p.results_at, marks: marksOf(p),
      },
      mine: a ? { id: a.id, status: a.status, deadline_at: a.deadline_at } : null,
      practice_open: practiceOpen(p.id),
    };
  }),

  startAttempt: (paperId, practice = false, name = null, pin = null) => call(() => {
    const u = me();
    if (!u) fail('not_authenticated');
    const p = paper(paperId);
    if (!p || p.status !== 'published') fail('paper_not_found');
    const t = Date.now();
    let a;
    if (practice) {
      if (!p.allow_practice || !p.results_at) fail('practice_unavailable');
      a = db.attempts.find((x) => x.paper_id === p.id && x.user_id === u.id && x.practice && x.status === 'in_progress');
      if (a && t > ms(a.deadline_at) + GRACE) { finalize(a, 'expired'); a = null; }
      if (a) { a.client_token = uuid(); a.sessions++; } else {
        a = newAttempt({ paper_id: p.id, user_id: u.id, practice: true, started_at: iso(t), deadline_at: iso(t + p.duration_min * M) });
        db.attempts.push(a);
      }
    } else {
      a = myRanked(p.id);
      if (a) {
        if (a.status === 'in_progress' && t > ms(a.deadline_at) + GRACE) { finalize(a, 'expired'); fail('already_submitted'); }
        if (a.status !== 'in_progress') fail('already_submitted');
        a.client_token = uuid(); a.sessions++;
      } else {
        if (name == null) fail('name_required');
        const nm = cleanReddit(name);
        if (!nm) fail('name_invalid');
        if (!/^[0-9]{4,8}$/.test(pin || '')) fail('pin_invalid');
        const h = nameHash(nm);
        if (db.banned[h]) fail('banned');
        a = db.attempts.find((x) => x.paper_id === p.id && x.name_hash === h && !x.practice);
        if (a) {
          if (!a.pin_hash) { a.pin_hash = pinHash(pin); a.pin_fails = 0; a.pin_locked_until = null; } else checkPin(a, pin);
          if (a.status === 'in_progress' && t > ms(a.deadline_at) + GRACE) { finalize(a, 'expired'); fail('already_submitted'); }
          if (a.status !== 'in_progress') fail('already_submitted');
          if (a.user_id) a.prev_users.push(a.user_id);
          a.user_id = u.id; a.client_token = uuid(); a.sessions++;
        } else {
          if (t < ms(p.starts_at)) fail('not_started', { starts_at: p.starts_at });
          if (t > ms(p.starts_at) + p.entry_window_min * M || t >= ms(p.ends_at)) fail('entry_closed');
          a = newAttempt({
            paper_id: p.id, user_id: u.id, name: nm, name_hash: h, pin_hash: pinHash(pin), started_at: iso(t),
            deadline_at: iso(Math.min(t + p.duration_min * M, ms(p.ends_at))),
          });
          db.attempts.push(a);
        }
      }
    }
    return {
      now: iso(Date.now()),
      attempt: { id: a.id, token: a.client_token, practice: a.practice, started_at: a.started_at, deadline_at: a.deadline_at, seq: a.seq, responses: a.responses, name: a.name },
      paper: payloadOf(p),
    };
  }),

  saveProgress: (attemptId, token, seq, responses) => call(() => {
    requireUser();
    if (!responses || typeof responses !== 'object') fail('invalid');
    const a = db.attempts.find((x) => x.id === attemptId);
    if (!a) fail('attempt_not_found');
    if (a.user_id !== uid()) fail(a.prev_users.includes(uid()) ? 'superseded' : 'attempt_not_found');
    if (a.status !== 'in_progress') fail('closed', { status: a.status });
    if (a.client_token !== token) fail('superseded');
    if (Date.now() > ms(a.deadline_at) + GRACE) { finalize(a, 'expired'); fail('closed', { status: 'expired' }); }
    if (seq == null || seq <= a.seq) return { ok: true, stale: true, now: iso(Date.now()), deadline_at: a.deadline_at };
    if (a.last_saved_at && Date.now() - ms(a.last_saved_at) < 700) fail('slow_down');
    a.responses = cleanResponses(a.paper_id, responses); a.seq = seq; a.last_saved_at = iso(Date.now());
    return { ok: true, now: iso(Date.now()), deadline_at: a.deadline_at };
  }),

  submitAttempt: (attemptId, token, seq, responses) => call(() => {
    requireUser();
    const a = db.attempts.find((x) => x.id === attemptId);
    if (!a) fail('attempt_not_found');
    if (a.user_id !== uid()) fail(a.prev_users.includes(uid()) ? 'superseded' : 'attempt_not_found');
    const p = paper(a.paper_id);
    if (a.status !== 'in_progress') return { ok: true, status: a.status, practice: a.practice, ends_at: p.ends_at };
    if (a.client_token !== token) fail('superseded');
    const inTime = Date.now() <= ms(a.deadline_at) + GRACE;
    if (inTime && responses && (seq || 0) > a.seq) { a.responses = cleanResponses(a.paper_id, responses); a.seq = seq; }
    finalize(a, inTime ? 'submitted' : 'expired');
    return { ok: true, status: a.status, practice: a.practice, ends_at: p.ends_at };
  }),

  reportViolation: (attemptId, token, kind) => call(() => {
    const a = db.attempts.find((x) => x.id === attemptId && x.user_id === uid() && x.status === 'in_progress' && x.client_token === token);
    if (!a) return { ok: true };
    a.violations[kind] = (a.violations[kind] || 0) + 1;
    return { ok: true, violations: a.violations };
  }).catch(() => null),

  result: (paperId, practice = false, name = null, pin = null) => call(() => {
    const p = paper(paperId);
    if (!p || !['published', 'archived'].includes(p.status)) fail('paper_not_found');
    if (!p.results_at && Date.now() >= ms(p.ends_at) + GRACE) buildResults(p.id);
    let a = null;
    let openPractice = false;
    if (practice) {
      requireUser();
      const open = db.attempts.find((x) => x.paper_id === p.id && x.user_id === uid() && x.practice && x.status === 'in_progress');
      if (open && Date.now() > ms(open.deadline_at) + GRACE) finalize(open, 'expired'); else if (open) openPractice = true;
      a = db.attempts.filter((x) => x.paper_id === p.id && x.user_id === uid() && x.practice && x.status !== 'in_progress')
        .sort((x, y) => ms(y.submitted_at) - ms(x.submitted_at))[0] || null;
    } else if (uid()) a = myRanked(p.id) || null;
    if (!p.results_at) {
      return { pending: true, now: iso(Date.now()), ends_at: p.ends_at, paper: { id: p.id, title: p.title }, attempt: a ? { status: a.status, submitted_at: a.submitted_at } : null };
    }
    if (!a && !practice && name != null) {
      const nm = cleanReddit(name);
      if (!nm) fail('name_invalid');
      a = db.attempts.find((x) => x.paper_id === p.id && x.name_hash === nameHash(nm) && !x.practice);
      if (!a) fail(p.flushed_at ? 'flushed' : 'name_not_found');
      checkPin(a, pin);
    }
    if (a && a.status === 'in_progress') fail('attempt_in_progress');
    const lb = a && !a.practice ? (db.leaderboard[p.id] || []).find((r) => r.attempt_id === a.id) : null;
    const marks = a ? Object.fromEntries(questionMarks(p, a).map((m) => [m.question_id, m])) : {};
    return {
      paper: { id: p.id, title: p.title, starts_at: p.starts_at, ends_at: p.ends_at, duration_min: p.duration_min, allow_practice: p.allow_practice, takers: p.results_count, marks: marksOf(p) },
      attempt: a ? {
        id: a.id, practice: a.practice, status: a.status, name: a.name, started_at: a.started_at, submitted_at: a.submitted_at, score: a.score,
        physics: a.score_physics, chemistry: a.score_chemistry, mathematics: a.score_mathematics, correct: a.n_correct, wrong: a.n_wrong, unattempted: a.n_unattempted,
      } : null,
      rank: lb?.rank ?? null, percentile: lb?.percentile ?? null, key_changed: !!p.key_changed_at, flushed: !!p.flushed_at, practice_open: openPractice,
      questions: questionsOf(p.id).map((q) => ({
        id: q.id, subject: q.subject, slot: q.slot, kind: q.kind, body: q.body, image: q.image_path,
        options: q.kind === 'scq' ? q.options : null, option_images: q.kind === 'scq' ? q.option_images : null,
        correct_options: q.correct_options, correct_min: q.correct_min, correct_max: q.correct_max, solution: q.solution,
        solution_image: q.solution_image_path, bonus: q.bonus, attempted_by: db.stats[q.id]?.attempted ?? null, correct_by: db.stats[q.id]?.correct ?? null,
        mine: a ? { a: a.responses[q.id]?.a ?? null, s: a.responses[q.id]?.s ?? null, t: a.responses[q.id]?.t ?? 0, marks: marks[q.id].marks, ok: marks[q.id].ok } : null,
      })),
    };
  }),

  leaderboard: (paperId, offset = 0, limit = 50) => call(() => {
    const p = paper(paperId);
    if (!p || !['published', 'archived'].includes(p.status)) fail('paper_not_found');
    if (!p.results_at && Date.now() >= ms(p.ends_at) + GRACE) buildResults(p.id);
    if (!p.results_at) return { pending: true, ends_at: p.ends_at, paper: { id: p.id, title: p.title } };
    const all = db.leaderboard[p.id] || [];
    const lim = Math.min(Math.max(limit, 1), 100);
    const mineId = myRanked(p.id)?.id;
    const mine = all.find((r) => mineId && r.attempt_id === mineId);
    return {
      paper: { id: p.id, title: p.title }, total: p.results_count, offset,
      rows: all.slice(offset, offset + lim).map((r) => ({
        rank: r.rank, handle: r.handle, score: r.score, physics: r.score_physics, chemistry: r.score_chemistry,
        mathematics: r.score_mathematics, percentile: r.percentile, me: !!mineId && r.attempt_id === mineId,
      })),
      me: mine ? { rank: mine.rank, handle: mine.handle, score: mine.score, percentile: mine.percentile } : null,
    };
  }),

  overall: (limit = 100) => call(() => {
    const by = {};
    for (const [pid, rows] of Object.entries(db.leaderboard)) {
      if (!['published', 'archived'].includes(paper(pid)?.status)) continue;
      for (const r of rows) {
        if (db.banned[r.name_hash]) continue;
        const e = (by[r.handle.toLowerCase()] ||= { handle: r.handle, total: 0, papers: 0, pct: 0, me: false });
        e.total += r.score; e.papers++; e.pct += r.percentile;
        if (r.attempt_id && db.attempts.find((a) => a.id === r.attempt_id)?.user_id === uid()) e.me = true;
      }
    }
    const rows = Object.values(by).map((e) => ({ handle: e.handle, total: e.total, papers: e.papers, avg_percentile: Math.round((e.pct / e.papers) * 100) / 100, me: e.me }))
      .sort((a, b) => b.total - a.total || b.avg_percentile - a.avg_percentile).slice(0, limit);
    return { rows };
  }),

  imageUrl: (path) => (path ? imageUrls.get(path) || null : null),

  staff: {
    overview: () => call(() => {
      requireStaff();
      return db.papers.map((p) => {
        const qs = questionsOf(p.id);
        return {
          id: p.id, title: p.title, status: p.status, starts_at: p.starts_at, ends_at: p.ends_at, entry_window_min: p.entry_window_min,
          duration_min: p.duration_min, version: p.version, results_at: p.results_at, key_changed_at: p.key_changed_at, flushed_at: p.flushed_at, updated_at: p.updated_at,
          filled: qs.filter((q) => q.body.trim() || q.image_path).length, complete: qs.filter(complete).length,
          verified: qs.filter((q) => q.verified).length, attempts: db.attempts.filter((a) => a.paper_id === p.id && !a.practice).length,
        };
      }).sort((a, b) => ms(b.starts_at) - ms(a.starts_at));
    }),
    directory: () => call(() => {
      requireStaff();
      return Object.values(db.users).filter((u) => u.role).map((u) => ({ user_id: u.id, role: u.role, name: u.handle || u.full_name }));
    }),
    history: (paperId, questionId = null) => call(() => {
      requireStaff();
      return db.audit.filter((l) => l.paper_id === paperId && (!questionId || l.question_id === questionId)).slice(-200).reverse().map((l) => {
        const q = db.questions.find((x) => x.id === l.question_id);
        return { ...l, actor: db.users[l.actor]?.handle || db.users[l.actor]?.full_name || 'system', label: q ? q.subject[0].toUpperCase() + q.slot : null };
      });
    }),
    getPaper: (id) => call(() => { requireStaff(); return paper(id) || null; }),
    createPaper: (fields) => call(() => {
      requireStaff();
      const p = mkPaper(db, { ...fields, starts_at: ms(fields.starts_at), ends_at: ms(fields.ends_at) });
      Object.assign(p, fields, { status: 'draft' });
      audit('paper.create', p.id, null, { title: p.title });
      return p;
    }),
    updatePaper: (id, version, fields) => call(() => {
      requireStaff();
      const p = paper(id);
      if (p && p.status !== 'draft' && !isAdmin()) fail('paper_locked');
      const r = versioned(db.papers, id, version, fields);
      if (!r.conflict) { audit('paper.update', id, null, fields); broadcast({ t: 'paper', paperId: id, row: r.row }); }
      return { row: r.row, conflict: r.conflict };
    }),
    questions: (paperId) => call(() => { requireStaff(); return questionsOf(paperId); }),
    getQuestion: (id) => call(() => { requireStaff(); return db.questions.find((q) => q.id === id) || null; }),
    updateQuestion: (id, version, fields) => call(() => {
      requireStaff();
      const q0 = db.questions.find((q) => q.id === id);
      const p = q0 && paper(q0.paper_id);
      if (p && p.status !== 'draft' && !isAdmin()) fail('paper_locked');
      if (q0 && 'bonus' in fields && fields.bonus !== q0.bonus && !isAdmin()) fail('admin_only');
      const r = versioned(db.questions, id, version, fields, (row, f) => {
        const next = { ...row, ...f };
        if (next.slot <= 20) { f.correct_min = null; f.correct_max = null; } else f.correct_options = [];
        if (f.correct_options) f.correct_options = [...new Set(f.correct_options)].sort();
        const keys = ['body', 'image_path', 'options', 'option_images', 'correct_options', 'correct_min', 'correct_max', 'solution', 'solution_image_path'];
        const changed = keys.some((k) => k in f && JSON.stringify(f[k]) !== JSON.stringify(row[k]));
        if (changed) Object.assign(f, { verified: false, verified_by: null, verified_at: null });
        else if (f.verified && !row.verified) Object.assign(f, { verified_by: uid(), verified_at: iso(Date.now()) });
        else if (f.verified === false) Object.assign(f, { verified_by: null, verified_at: null });
      });
      if (!r.conflict) {
        const diff = {};
        for (const k of Object.keys(fields)) if (JSON.stringify(r.old[k]) !== JSON.stringify(r.row[k])) diff[k] = [r.old[k], r.row[k]];
        audit('question.update', r.row.paper_id, id, diff);
        if (p.results_at && ['correct_options', 'correct_min', 'correct_max', 'bonus'].some((k) => k in diff)) p.key_changed_at = iso(Date.now());
        broadcast({ t: 'question', paperId: r.row.paper_id, row: r.row });
      }
      return { row: r.row, conflict: r.conflict };
    }),
    async uploadImage(paperId, blob, ext) {
      requireStaff();
      const path = `${paperId}/${uuid()}.${ext}`;
      await idbPut(path, blob);
      imageUrls.set(path, URL.createObjectURL(blob));
      broadcast({ t: 'image', path });
      return path;
    },
    publish: (id) => call(() => {
      requireAdmin();
      const p = paper(id);
      if (!p) fail('paper_not_found');
      if (p.status !== 'draft') fail('invalid_state');
      if (ms(p.ends_at) <= Date.now()) fail('ends_in_past');
      const missing = questionsOf(id).filter((q) => !complete(q)).map((q) => q.subject[0].toUpperCase() + q.slot);
      if (missing.length) fail('incomplete', { missing });
      p.status = 'published'; p.version++;
      audit('paper.publish', id, null, {});
      return { ok: true };
    }),
    unpublish: (id) => call(() => {
      requireAdmin();
      if (db.attempts.some((a) => a.paper_id === id)) fail('has_attempts');
      const p = paper(id);
      if (p?.status !== 'published') fail('invalid_state');
      p.status = 'draft'; p.version++;
      return { ok: true };
    }),
    archive: (id, archived) => call(() => {
      requireAdmin();
      const p = paper(id);
      if (!p || p.status !== (archived ? 'published' : 'archived')) fail('invalid_state');
      p.status = archived ? 'archived' : 'published'; p.version++;
      return { ok: true };
    }),
    remove: (id) => call(() => {
      requireAdmin();
      if (db.attempts.some((a) => a.paper_id === id) || (db.leaderboard[id] || []).length) fail('has_attempts');
      db.papers = db.papers.filter((p) => p.id !== id);
      db.questions = db.questions.filter((q) => q.paper_id !== id);
      return { ok: true };
    }),
    rescore: (id) => call(() => {
      requireAdmin();
      if (paper(id)?.flushed_at) fail('flushed');
      for (const a of db.attempts.filter((x) => x.paper_id === id && x.status !== 'in_progress')) score(a);
      const built = paper(id)?.results_at ? buildResults(id) : false;
      return { ok: true, results_rebuilt: built };
    }),
    flush: (id) => call(() => {
      requireAdmin();
      const p = paper(id);
      if (!p) fail('paper_not_found');
      if (!p.results_at) fail('results_not_ready');
      const gone = db.attempts.filter((a) => a.paper_id === id);
      db.attempts = db.attempts.filter((a) => a.paper_id !== id);
      for (const r of db.leaderboard[id] || []) r.attempt_id = null;
      p.flushed_at = iso(Date.now());
      const sessions = new Set(gone.flatMap((a) => [a.user_id, ...a.prev_users]).filter(Boolean));
      let removed = 0;
      for (const s of sessions) {
        if (db.users[s]?.anonymous && !db.attempts.some((a) => a.user_id === s)) { delete db.users[s]; removed++; }
      }
      audit('paper.flush', id, null, { attempts: gone.length, sessions: removed });
      return { ok: true, attempts: gone.length, sessions: removed };
    }),
    monitor: (id, filter = 'all') => call(() => {
      requireAdmin();
      const all = db.attempts.filter((a) => a.paper_id === id && !a.practice);
      const flagged = (a) => Object.keys(a.violations || {}).length > 0 || a.sessions > 2;
      const pick = { in_progress: (a) => a.status === 'in_progress', submitted: (a) => a.status !== 'in_progress', flagged }[filter] || (() => true);
      return {
        now: iso(Date.now()),
        counts: { started: all.length, in_progress: all.filter((a) => a.status === 'in_progress').length, submitted: all.filter((a) => a.status === 'submitted').length, expired: all.filter((a) => a.status === 'expired').length, flagged: all.filter(flagged).length },
        attempts: all.filter(pick).slice(0, 200).map((a) => ({
          id: a.id, handle: a.name, banned: !!db.banned[a.name_hash], pin_locked: !!a.pin_locked_until && ms(a.pin_locked_until) > Date.now(), pin_reset: !a.pin_hash,
          status: a.status, started_at: a.started_at, deadline_at: a.deadline_at, submitted_at: a.submitted_at, last_saved_at: a.last_saved_at || null,
          sessions: a.sessions, violations: a.violations, score: a.score ?? null, answered: Object.values(a.responses || {}).filter((r) => r.a != null).length,
        })),
      };
    }),
    extend: (attemptId, minutes) => call(() => {
      requireAdmin();
      const a = db.attempts.find((x) => x.id === attemptId && x.status === 'in_progress');
      if (!a) fail('invalid_state');
      a.deadline_at = iso(ms(a.deadline_at) + minutes * M);
      return { ok: true, deadline_at: a.deadline_at };
    }),
    resetAttempt: (attemptId) => call(() => {
      requireAdmin();
      db.attempts = db.attempts.filter((a) => a.id !== attemptId);
      return { ok: true };
    }),
    resetPin: (attemptId) => call(() => {
      requireAdmin();
      const a = db.attempts.find((x) => x.id === attemptId && !x.practice);
      if (!a) fail('attempt_not_found');
      Object.assign(a, { pin_hash: null, pin_fails: 0, pin_locked_until: null });
      return { ok: true };
    }),
    banAttempt: (attemptId, banned) => call(() => {
      requireAdmin();
      const a = db.attempts.find((x) => x.id === attemptId);
      if (!a?.name_hash) fail('attempt_not_found');
      if (banned) db.banned[a.name_hash] = { name: a.name, at: iso(Date.now()) }; else delete db.banned[a.name_hash];
      return { ok: true };
    }),
    banName: (name, banned) => call(() => {
      requireAdmin();
      const nm = cleanReddit(name);
      if (!nm) fail('name_invalid');
      if (banned) db.banned[nameHash(nm)] = { name: nm, at: iso(Date.now()) }; else delete db.banned[nameHash(nm)];
      return { ok: true };
    }),
    listBanned: () => call(() => {
      requireAdmin();
      return Object.values(db.banned).map((b) => ({ name: b.name, banned_at: b.at }));
    }),
    listStaff: () => call(() => {
      requireAdmin();
      return Object.values(db.users).filter((u) => u.role).map((u) => ({ user_id: u.id, role: u.role, email: u.email, handle: u.handle, full_name: u.full_name, added_at: null }));
    }),
    setStaff: (email, role) => call(() => {
      requireAdmin();
      const u = Object.values(db.users).find((x) => !x.anonymous && x.email?.toLowerCase() === String(email).trim().toLowerCase());
      if (!u) fail('user_not_found');
      if (u.role === 'admin' && role !== 'admin' && Object.values(db.users).filter((x) => x.role === 'admin').length <= 1) fail('last_admin');
      u.role = role || null;
      return { ok: true };
    }),

    async subscribe(paperId, who, { onQuestion, onPaper, onPresence, onStatus } = {}) {
      const peers = new Map();
      let state = { user_id: who.id, name: `${who.name} · tab ${tabId}`, slot: null, at: Date.now() };
      const emit = () => {
        const now = Date.now();
        for (const [k, v] of peers) if (now - v.at > 15000) peers.delete(k);
        onPresence?.([{ ...state, key: tabId, self: true }, ...[...peers.entries()].map(([key, v]) => ({ ...v, key }))]);
      };
      const handler = (m) => {
        if (m.paperId !== paperId) return;
        if (m.t === 'question') { db = load() || db; onQuestion?.(m.row); }
        if (m.t === 'paper') { db = load() || db; onPaper?.(m.row); }
        if (m.t === 'presence') { peers.set(m.tab, m.state); emit(); }
        if (m.t === 'leave') { peers.delete(m.tab); emit(); }
      };
      subs.add(handler);
      const beat = () => broadcast({ t: 'presence', paperId, tab: tabId, state: { ...state, at: Date.now() } });
      const timer = setInterval(() => { beat(); emit(); }, 5000);
      const leave = () => broadcast({ t: 'leave', paperId, tab: tabId });
      window.addEventListener('pagehide', leave);
      setTimeout(() => { onStatus?.('SUBSCRIBED'); beat(); emit(); }, 50);
      return {
        track(patch) { state = { ...state, ...patch, at: Date.now() }; beat(); emit(); },
        close() { clearInterval(timer); subs.delete(handler); leave(); window.removeEventListener('pagehide', leave); },
      };
    },
  },
};
