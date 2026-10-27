// The exam: pre-exam gate → fullscreen CBT interface → submitted screen.
//
// Failsafe design:
//  • The server owns the clock, the deadline and the answer key.
//  • Every change is written to localStorage first, then synced in the
//    background with retries; a dropped connection never loses answers.
//  • Saves carry a monotonically increasing sequence number so a late,
//    out-of-order request can never overwrite newer answers.
//  • Only one tab/device holds the write token; opening the exam elsewhere
//    hands it over. On a different device the Reddit username + PIN proves
//    it's the same student.
import { api } from './api.js';
import { CONFIG } from './config.js';
import {
  $, h, icon, toast, modal, renderRich, loadRich, fmtClock, fmtDate, fmtCountdown, initTheme, toggleTheme,
  signInDialog, ensureStudentSession, captchaWidget, identityFields, rememberName,
  message, SUBJECTS, SUBJECT_LABEL, OPTION_KEYS, optionLabel, sleep, param,
} from './ui.js';

const IDENTITY_ERRORS = ['name_required', 'name_invalid', 'pin_invalid', 'pin_wrong', 'pin_locked', 'banned', 'session_has_attempt', 'captcha', 'rate_limited'];

const paperId = param('paper');
const practice = param('practice') === '1';
const previewId = param('preview');
const root = $('#root');
const NUM_RE = /^-?\d{1,7}(\.\d{1,4})?$/;
const GRACE = 30_000;

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};
const K = {
  att: (id) => `jeemock_att_${id}`,
  last: () => `jeemock_last_${paperId}_${practice ? 'p' : 'r'}`,
};

const S = {
  offset: 0, user: null, me: null, info: null,
  attempt: null, paper: null, questions: [], bySubject: {},
  resp: {}, draft: {}, cur: 0,
  seq: 0, dirtySeq: 0, syncedSeq: 0,
  running: false, finished: false, preview: false, submitting: false, offline: false,
  keys: null, violations: 0, warned: new Set(), lastDraftWarn: 0,
  name: null, creds: null, widget: null,   // creds (username + PIN) live in memory only
};
const serverNow = () => Date.now() + S.offset;
const ui = {};

function syncClock(serverIso, t0, t1) {
  const server = Date.parse(serverIso);
  if (!Number.isNaN(server)) S.offset = server - (t0 + t1) / 2;
}
async function timed(fn) {
  const t0 = Date.now();
  const res = await fn();
  if (res?.now) syncClock(res.now, t0, Date.now());
  return res;
}

// ── fullscreen ─────────────────────────────────────────────────────────────
const fsSupported = () => !!document.fullscreenEnabled;
function goFullscreen() {
  if (!fsSupported() || document.fullscreenElement) return Promise.resolve();
  return document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
}
function exitFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

// ── boot ───────────────────────────────────────────────────────────────────
async function boot() {
  initTheme();
  loadRich();
  if (previewId) return bootPreview();
  if (!paperId) return fatal('No paper was selected.');

  S.user = await api.auth.getUser().catch(() => null);
  let info;
  try {
    info = await timed(() => api.paperInfo(paperId));
  } catch (e) {
    const cached = store.get(K.last());
    if (e.code === 'network' && cached && cached.deadline > Date.now() + (cached.offset || 0)) return offlineGate(cached);
    return fatal(message(e), true);
  }
  if (!info) return fatal('This paper doesn’t exist or isn’t open.');
  S.info = info;
  document.title = `${info.paper.title} · ${CONFIG.SITE_NAME}`;
  renderGate();
}

function fatal(text, retry = false) {
  root.replaceChildren(h('div', { class: 'gate-center' },
    h('div', { class: 'card card-pad stack center-card' },
      h('h1', { class: 'h2' }, 'Can’t open the exam'),
      h('p', { class: 'muted' }, text),
      h('div', { class: 'row' },
        retry ? h('button', { class: 'btn btn-primary', onclick: () => location.reload() }, 'Try again') : null,
        h('a', { class: 'btn', href: './' }, 'Back to mocks')))));
}

// ── gate (instructions + start) ────────────────────────────────────────────
function gateState() {
  const p = S.info.paper;
  const now = serverNow();
  const start = Date.parse(p.starts_at);
  const end = Date.parse(p.ends_at);
  const entryEnd = Math.min(start + p.entry_window_min * 60000, end);
  if (practice) {
    if (!p.results_ready || !p.allow_practice) return { kind: 'blocked', text: message({ code: 'practice_unavailable' }) };
    return { kind: S.info.practice_open ? 'resume' : 'ready' };
  }
  const mine = S.info.mine;
  if (mine && (mine.status !== 'in_progress' || Date.parse(mine.deadline_at) + GRACE < now)) return { kind: 'done' };
  if (mine) return { kind: 'resume', deadline: Date.parse(mine.deadline_at) };
  if (now < start) return { kind: 'wait', until: start };
  if (now >= entryEnd) return { kind: 'closed', canClaim: now < end };   // a started attempt can still move here
  return { kind: 'ready', entryEnd };
}

function renderGate() {
  const p = S.info.paper;
  const marks = p.marks;
  const neg = (n) => (n === 0 ? '0' : `−${Math.abs(n)}`);
  const agree = h('input', { type: 'checkbox', id: 'agree' });
  const startBtn = h('button', { class: 'btn btn-primary btn-lg btn-block', type: 'button', disabled: true }, 'Start exam');
  const statusLine = h('div', { class: 'gate-status' });
  const note = h('p', { class: 'fine center' });

  const legend = (cls, label) => h('li', null, h('span', { class: `pq pq-demo ${cls}` }, ''), label);
  const instructions = h('section', { class: 'card card-pad instructions' },
    h('h2', null, 'Instructions'),
    h('ol', { class: 'inst-list' },
      h('li', null, `Duration ${p.duration_min} minutes. 75 questions: Physics, Chemistry and Mathematics, 25 each.`),
      h('li', null, 'Each subject has Section A (20 multiple-choice questions, one correct option) and Section B (5 numerical-value questions). All questions are compulsory.'),
      h('li', null, `Marking: Section A +${marks.scq.correct} / ${neg(marks.scq.wrong)}; Section B +${marks.numerical.correct} / ${neg(marks.numerical.wrong)}. Unanswered questions get 0.`),
      h('li', null, h('strong', null, 'An answer is saved only when you click “Save & Next” or “Save & Mark for Review”.'), ' Moving away without saving discards the selection, as in the real exam.'),
      h('li', null, 'Questions that are “Answered & Marked for Review” are evaluated.'),
      h('li', null, 'Numerical answers: type with the keyboard or the on-screen keypad. Negative numbers and up to 4 decimal places are allowed.'),
      h('li', null, 'The timer runs on the server. The paper submits itself when it reaches 00:00.'),
      h('li', null, 'The exam runs in full screen. Leaving full screen or switching tabs/windows is recorded and visible to the organisers.'),
      h('li', null, 'If your internet drops, keep going — answers are kept on this device and sync automatically when you reconnect. Opening the exam on another device moves it there.')),
    h('h3', { class: 'legend-title' }, 'Question palette'),
    h('ul', { class: 'legend-list' },
      legend('st-nv', 'Not visited'), legend('st-na', 'Not answered'), legend('st-an', 'Answered'),
      legend('st-mr', 'Marked for review'), legend('st-ma', 'Answered & marked (evaluated)')),
    h('label', { class: 'check agree' }, agree, h('span', null, 'I have read and understood the instructions.')));

  const facts = h('dl', { class: 'facts' },
    fact('Starts', fmtDate(p.starts_at)),
    fact('Entry closes', fmtDate(Math.min(Date.parse(p.starts_at) + p.entry_window_min * 60000, Date.parse(p.ends_at)))),
    fact('Closes', fmtDate(p.ends_at)),
    fact('Duration', `${p.duration_min} min`),
    fact('Questions', '75'),
    fact('Maximum', `${75 * marks.scq.correct}`));

  // Ranked attempts: Reddit username + PIN. Practice attempts need neither.
  const idf = identityFields();
  S.widget = practice ? null : captchaWidget();
  let claimOpen = false;   // after the entry window: "started on another device?"
  const claimLink = h('button', {
    class: 'linklike', type: 'button', hidden: true,
    onclick: () => { claimOpen = true; update(); idf.name.focus(); },
  }, 'Started on another device? Continue here');
  const identityBox = h('div', { class: 'stack', hidden: true }, idf.el, S.widget?.el);

  const card = h('section', { class: 'card card-pad gate-card' },
    h('div', { class: 'row' },
      h('span', { class: `badge ${practice ? 'badge-purple' : 'badge-upcoming'}` }, practice ? 'Practice attempt · unranked' : 'Ranked mock')),
    h('h1', { class: 'gate-title' }, p.title),
    p.description ? h('p', { class: 'muted' }, p.description) : null,
    facts, statusLine, identityBox, startBtn, claimLink, note);

  root.replaceChildren(h('div', { class: 'gate' },
    h('header', { class: 'gate-top' },
      h('a', { class: 'brand', href: './' }, h('span', { class: 'brand-mark' }, 'J'), h('span', { class: 'brand-name' }, CONFIG.SITE_NAME)),
      h('button', { class: 'icon-btn', onclick: toggleTheme, 'aria-label': 'Toggle theme' }, icon('moon'))),
    h('main', { class: 'gate-grid' }, card, instructions)));

  let st = null;
  let needIdentity = false;   // set when the server asks who you are (attempt moved devices)
  function update() {
    st = gateState();
    statusLine.className = 'gate-status';
    note.textContent = '';
    startBtn.hidden = false;
    claimLink.hidden = !(st.kind === 'closed' && st.canClaim && !practice && !claimOpen);
    identityBox.hidden = practice || !(['ready', 'wait'].includes(st.kind) || (st.kind === 'closed' && claimOpen) || (st.kind === 'resume' && needIdentity));
    if (st.kind === 'closed' && claimOpen && st.canClaim) {
      statusLine.textContent = 'Entry is closed for new attempts, but you can move an attempt you already started to this device.';
      startBtn.textContent = 'Continue here';
      startBtn.disabled = false;
      return;
    }
    if (st.kind === 'blocked') {
      statusLine.textContent = st.text;
      statusLine.classList.add('is-bad');
      startBtn.hidden = true;
    } else if (st.kind === 'done') {
      statusLine.textContent = 'You have already submitted this paper.';
      statusLine.classList.add('is-good');
      startBtn.textContent = p.results_ready ? 'View your result' : 'Back to mocks';
      startBtn.disabled = false;
    } else if (st.kind === 'wait') {
      statusLine.replaceChildren('Starts in ', h('span', { class: 'mono big' }, fmtCountdown(st.until - serverNow())));
      startBtn.textContent = 'Start exam';
      startBtn.disabled = true;
      note.textContent = 'The button unlocks automatically at the start time. Keep this page open.';
    } else if (st.kind === 'closed') {
      statusLine.textContent = 'The entry window for this paper has closed.';
      statusLine.classList.add('is-bad');
      startBtn.textContent = p.results_ready ? 'View results' : 'Back to mocks';
      startBtn.disabled = false;
    } else if (st.kind === 'ready' || st.kind === 'resume') {
      if (st.kind === 'resume' && needIdentity) statusLine.textContent = 'This attempt is open on another device. Enter your username and PIN to continue here.';
      else if (st.kind === 'resume') statusLine.textContent = 'Your attempt is in progress. Resume where you left off.';
      else if (st.entryEnd) statusLine.replaceChildren('Open now — entry closes in ', h('span', { class: 'mono' }, fmtCountdown(st.entryEnd - serverNow())));
      else statusLine.textContent = 'Ready when you are.';
      startBtn.textContent = st.kind === 'resume' ? 'Resume exam' : 'Start exam';
      startBtn.disabled = !agree.checked && st.kind !== 'resume';
      if (st.kind === 'resume') agree.checked = true;
    }
  }
  update();
  const timer = setInterval(update, 1000);
  agree.addEventListener('change', update);

  startBtn.addEventListener('click', async () => {
    if (!st) return;
    const claiming = st.kind === 'closed' && claimOpen && st.canClaim;
    if (st.kind === 'done' || (st.kind === 'closed' && !claiming)) {
      location.href = p.results_ready ? `results.html?paper=${encodeURIComponent(p.id)}` : './';
      return;
    }
    if (st.kind !== 'ready' && st.kind !== 'resume' && !claiming) return;
    let creds = null;
    if (!practice && (st.kind === 'ready' || claiming || needIdentity)) {
      creds = idf.read();
      if (!creds) return;
    }
    startBtn.disabled = true;
    goFullscreen();   // must run synchronously inside the click
    const fail = (e) => {
      exitFullscreen();
      startBtn.disabled = false;
      if (e?.code === 'name_required') { needIdentity = true; update(); }
      if (e) idf.show(e);
      S.widget?.reset();
      update();
    };
    try {
      statusLine.textContent = 'Connecting…';
      await ensureStudentSession(S.widget);
    } catch (e) { fail(e); return; }
    const res = await startWithRetry((text) => { statusLine.textContent = text; }, creds, fail);
    if (!res) { if (startBtn.disabled) fail(null); return; }
    if (creds) { rememberName(creds.name); S.creds = creds; }
    clearInterval(timer);
    enterExam(res);
  });
}

function fact(k, v) {
  return h('div', { class: 'fact' }, h('dt', null, k), h('dd', null, v));
}

async function startWithRetry(onStatus, creds = null, onIdentityError = null) {
  // Spread the 9:00:00 thundering herd over a couple of seconds.
  const sinceStart = serverNow() - Date.parse(S.info?.paper.starts_at || 0);
  if (!practice && sinceStart >= 0 && sinceStart < 60000) {
    onStatus('Connecting…');
    await sleep(Math.random() * 2500);
  }
  let renewed = false;
  for (let i = 0; i < 8; i++) {
    try {
      onStatus('Connecting…');
      return await timed(() => api.startAttempt(paperId, practice, creds?.name ?? null, creds?.pin ?? null));
    } catch (e) {
      if (e.code === 'network' || e.code === 'server') {
        onStatus(`Server busy or unreachable — retrying (${i + 1}/8)…`);
        await sleep(Math.min(1000 * 2 ** i, 15000) + Math.random() * 1000);
        continue;
      }
      if ((e.code === 'session_expired' || e.code === 'not_authenticated') && !renewed) {
        renewed = true;   // this browser's anonymous session was removed: get a fresh one
        await api.auth.signOut().catch(() => {});
        try { await ensureStudentSession(S.widget); } catch (err) { onIdentityError?.(err); return null; }
        continue;
      }
      if (IDENTITY_ERRORS.includes(e.code) && onIdentityError) { onIdentityError(e); return null; }
      toast(message(e), 'error', 6000);
      if (e.code === 'already_submitted') setTimeout(() => location.reload(), 1500);
      return null;
    }
  }
  toast('Could not reach the server. Check your connection and try again.', 'error', 6000);
  return null;
}

function offlineGate(cached) {
  S.offset = cached.offset || 0;
  root.replaceChildren(h('div', { class: 'gate-center' },
    h('div', { class: 'card card-pad stack center-card' },
      h('h1', { class: 'h2' }, 'You’re offline'),
      h('p', { class: 'muted' }, 'Your exam is saved on this device. Continue offline — answers will sync as soon as the connection returns.'),
      h('button', { class: 'btn btn-primary btn-lg', onclick: () => { goFullscreen(); enterExam(cached.res, true); } }, 'Continue exam offline'))));
}

// ── preview (staff) ────────────────────────────────────────────────────────
async function bootPreview() {
  S.preview = true;
  S.user = await api.auth.getUser().catch(() => null);
  if (!S.user) { fatal('Sign in as staff to preview papers.'); return signInDialog(); }
  let p, rows;
  try {
    [p, rows] = await Promise.all([api.staff.getPaper(previewId), api.staff.questions(previewId)]);
  } catch (e) { return fatal(message(e)); }
  if (!p) return fatal('Paper not found, or you are not staff.');
  S.me = await api.me().catch(() => null);
  rows.sort((a, b) => SUBJECTS.indexOf(a.subject) - SUBJECTS.indexOf(b.subject) || a.slot - b.slot);
  S.keys = new Map(rows.map((r) => [r.id, r]));
  const now = Date.now();
  enterExam({
    now: new Date(now).toISOString(),
    attempt: { id: `preview-${p.id.slice(0, 8)}`, token: null, practice: true, started_at: new Date(now).toISOString(), deadline_at: new Date(now + p.duration_min * 60000).toISOString(), seq: 0, responses: {} },
    paper: {
      id: p.id, title: p.title, duration_min: p.duration_min,
      marks: { scq: { correct: p.scq_correct, wrong: p.scq_wrong }, numerical: { correct: p.num_correct, wrong: p.num_wrong } },
      questions: rows.map((q) => ({ id: q.id, subject: q.subject, slot: q.slot, kind: q.kind, body: q.body, image: q.image_path, options: q.kind === 'scq' ? q.options : null, option_images: q.kind === 'scq' ? q.option_images : null })),
    },
  });
}

// ── entering the exam ──────────────────────────────────────────────────────
function enterExam(res, offline = false) {
  const a = res.attempt;
  S.name = a.name || S.name || (S.preview ? S.me?.handle : null) || null;
  S.attempt = { id: a.id, token: offline ? null : a.token, practice: a.practice, deadline: Date.parse(a.deadline_at) };
  S.paper = res.paper;
  S.questions = res.paper.questions;
  S.bySubject = Object.fromEntries(SUBJECTS.map((s) => [s, S.questions.filter((q) => q.subject === s)]));
  S.offline = offline;

  const local = S.preview ? null : store.get(K.att(a.id));
  const serverSeq = a.seq || 0;
  if (local && local.seq > serverSeq) {
    S.resp = local.resp || {};
    S.seq = S.dirtySeq = local.seq;
    S.syncedSeq = serverSeq;
  } else {
    S.resp = a.responses || {};
    S.seq = S.dirtySeq = S.syncedSeq = serverSeq;
  }
  S.cur = Math.max(0, Math.min(local?.cur ?? 0, S.questions.length - 1));

  if (!S.preview) {
    store.set(K.last(), { res: { attempt: { ...a, token: null, responses: {} }, paper: res.paper }, deadline: S.attempt.deadline, offset: S.offset });
    saveLocal();
  }
  // Warm the browser cache so figures still show if the connection drops later.
  for (const q of S.questions) {
    for (const path of [q.image, ...(q.option_images || [])]) {
      const url = path && api.imageUrl(path);
      if (url) new Image().src = url;
    }
  }

  document.body.classList.add('in-exam');
  buildExamUI();
  S.running = true;
  installGuards();
  show(S.cur);
  startTicker();
  if (S.dirtySeq > S.syncedSeq) scheduleSync(400);
  if (offline) { setNet('offline'); reclaim(true); }
}

// ── exam UI ────────────────────────────────────────────────────────────────
function buildExamUI() {
  ui.timer = h('span', { class: 'mono' }, '--:--:--');
  ui.timerBox = h('div', { class: 'xtimer', title: 'Time left' }, icon('clock', 16), ui.timer);
  ui.net = h('span', { class: 'xnet' });
  ui.tabs = h('div', { class: 'xsubjects', role: 'tablist' });
  ui.qnum = h('span', { class: 'qnum' });
  ui.qsec = h('span', { class: 'badge' });
  ui.qmarks = h('span', { class: 'badge badge-success' });
  ui.qneg = h('span', { class: 'badge badge-danger-soft' });
  ui.qbody = h('div', { class: 'qbody' });
  ui.qimg = h('div', { class: 'qimg' });
  ui.answer = h('div', { class: 'qanswer' });
  ui.savedHint = h('div', { class: 'saved-hint' });
  ui.palette = h('div', { class: 'palette-body' });
  ui.legend = h('ul', { class: 'legend-list compact' });
  ui.paletteWrap = h('aside', { class: 'palette' },
    h('div', { class: 'cand' },
      h('span', { class: 'avatar avatar-lg' }, (S.name || '?')[0].toUpperCase()),
      h('div', null, h('div', { class: 'cand-name' }, S.name ? (S.preview ? S.name : `u/${S.name}`) : 'Candidate'), h('div', { class: 'fine' }, S.preview ? 'Staff preview' : S.attempt.practice ? 'Practice attempt' : 'Ranked attempt'))),
    ui.legend, ui.palette,
    h('button', { class: 'btn btn-block palette-close', onclick: () => ui.paletteWrap.classList.remove('open') }, 'Close'));

  const btn = (label, cls, fn, title) => h('button', { class: `btn ${cls}`, type: 'button', onclick: fn, title }, label);
  ui.qpane = h('article', { class: 'qpane' },
    h('div', { class: 'wm', style: S.preview ? null : { backgroundImage: watermark() } }),
    h('div', { class: 'qhead' }, ui.qnum, ui.qsec, h('span', { class: 'spacer' }), ui.qmarks, ui.qneg),
    ui.qbody, ui.qimg, ui.answer, ui.savedHint);

  const shell = h('div', { class: 'xshell' },
    h('header', { class: 'xbar' },
      h('div', { class: 'xbar-left' },
        h('span', { class: 'brand-mark small' }, 'J'),
        h('div', { class: 'xtitle' }, h('strong', null, S.paper.title), h('span', null, S.preview ? 'PREVIEW — nothing is saved' : (S.name ? `u/${S.name}` : 'Practice')))),
      ui.net, ui.timerBox),
    h('nav', { class: 'xtabs' }, ui.tabs, h('div', { class: 'xtools' },
      h('button', { class: 'icon-btn', title: 'Smaller text', onclick: () => zoom(-1) }, 'A−'),
      h('button', { class: 'icon-btn', title: 'Larger text', onclick: () => zoom(1) }, 'A+'),
      h('button', { class: 'icon-btn', title: 'Theme', onclick: toggleTheme }, icon('moon', 16)),
      fsSupported() ? h('button', { class: 'icon-btn', title: 'Full screen', onclick: goFullscreen }, icon('expand', 16)) : null,
      h('button', { class: 'btn btn-sm palette-toggle', onclick: () => ui.paletteWrap.classList.add('open') }, icon('grid', 16), 'Palette'))),
    h('main', { class: 'xmain' }, ui.qpane, ui.paletteWrap),
    h('footer', { class: 'xactions' },
      h('div', { class: 'xact-group' },
        btn('Save & Next', 'btn-success', () => act('save'), 'Enter'),
        btn('Save & Mark for Review', 'btn-warn', () => act('savemark'), 'Shift+Enter'),
        btn('Clear Response', '', () => act('clear')),
        btn('Mark for Review & Next', 'btn-purple', () => act('mark'))),
      h('div', { class: 'xact-group' },
        btn('◀ Back', '', () => go(S.cur - 1), 'Left arrow'),
        btn('Next ▶', '', () => go(S.cur + 1), 'Right arrow'),
        btn('Submit', 'btn-danger', openSubmit))));

  ui.fsOverlay = h('div', { class: 'blocker', hidden: true },
    h('div', { class: 'card card-pad stack center-card' },
      icon('expand', 28),
      h('h2', null, 'Return to full screen'),
      h('p', { class: 'muted' }, 'The exam runs in full screen. Leaving it is recorded. Your timer keeps running.'),
      h('button', { class: 'btn btn-primary btn-lg', onclick: goFullscreen }, 'Return to full screen')));
  root.replaceChildren(shell, ui.fsOverlay);
  setNet(S.preview ? 'preview' : 'saved');
  applyZoom();
}

function watermark() {
  const text = `${S.name ? `u/${S.name}` : 'practice'} · ${S.attempt.id.slice(0, 8)}`;
  const esc = text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="340" height="200"><text x="20" y="120" transform="rotate(-18 170 100)" font-family="Inter, sans-serif" font-size="15" fill="rgba(110,120,140,0.09)">${esc}</text></svg>`;
  return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
}

let fontScale = Number(store.get('jeemock_font')) || 1;
function zoom(dir) {
  fontScale = Math.min(1.5, Math.max(0.85, Math.round((fontScale + dir * 0.1) * 10) / 10));
  store.set('jeemock_font', fontScale);
  applyZoom();
}
function applyZoom() {
  ui.qpane?.style.setProperty('--qscale', fontScale);
}

// ── state helpers ──────────────────────────────────────────────────────────
const ensureResp = (qid) => (S.resp[qid] ||= { a: null, s: 'na', t: 0 });
function stateOf(qid) {
  const r = S.resp[qid];
  if (!r) return 'nv';
  if (r.a != null) return r.s === 'ma' || r.s === 'mr' ? 'ma' : 'an';
  return r.s === 'mr' || r.s === 'ma' ? 'mr' : 'na';
}
function normalizeNum(v) {
  let s = String(v ?? '').trim();
  if (!s || s === '-' || s === '.' || s === '-.') return null;
  if (s.startsWith('.')) s = '0' + s;
  if (s.startsWith('-.')) s = '-0' + s.slice(1);
  if (s.endsWith('.')) s = s.slice(0, -1);
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
  if (s === '-0') s = '0';
  return s;
}
function currentDraft() {
  const q = S.questions[S.cur];
  if (q.kind === 'numerical') return normalizeNum(ui.numInput?.value);
  return S.draft[q.id] ?? null;
}

// ── navigation & actions ───────────────────────────────────────────────────
function show(i) {
  S.cur = i;
  const q = S.questions[i];
  if (!S.resp[q.id]) { ensureResp(q.id); markDirty(); }
  S.draft[q.id] = S.resp[q.id].a ?? null;
  renderTabs();
  renderQuestion();
  renderPalette();
  ui.paletteWrap.classList.remove('open');
  ui.qpane.scrollTop = 0;
  saveLocal();
}

function go(i, saved = false) {
  if (i < 0) return;
  if (i >= S.questions.length) {
    toast('That was the last question. Review the palette, then submit.', 'info');
    renderPalette();
    return;
  }
  const q = S.questions[S.cur];
  const savedA = S.resp[q.id]?.a ?? null;
  if (!saved && currentDraft() !== savedA && Date.now() - S.lastDraftWarn > 4000) {
    S.lastDraftWarn = Date.now();
    toast('Your selection wasn’t saved. Use “Save & Next” to save an answer.', 'warn', 4500);
  }
  delete S.draft[q.id];
  show(i);
}

function act(kind) {
  if (!S.running) return;
  const q = S.questions[S.cur];
  const r = ensureResp(q.id);
  if (kind === 'save' || kind === 'savemark') {
    const d = currentDraft();
    if (q.kind === 'numerical' && d != null && !NUM_RE.test(d)) {
      toast('Enter a number: up to 7 digits, optional minus sign and up to 4 decimals.', 'warn');
      return;
    }
    r.a = d;
    r.s = kind === 'savemark' ? (d != null ? 'ma' : 'mr') : (d != null ? 'an' : 'na');
    markDirty(true);
    go(S.cur + 1, true);
  } else if (kind === 'mark') {
    r.s = r.a != null ? 'ma' : 'mr';
    markDirty(true);
    go(S.cur + 1, true);
  } else if (kind === 'clear') {
    r.a = null;
    r.s = 'na';
    S.draft[q.id] = null;
    markDirty(true);
    renderQuestion();
    renderPalette();
    renderTabs();
  }
}

function selectOption(key) {
  const q = S.questions[S.cur];
  if (q.kind !== 'scq') return;
  S.draft[q.id] = S.draft[q.id] === key ? null : key;
  renderAnswer();
}

// ── rendering ──────────────────────────────────────────────────────────────
function renderTabs() {
  const curSubj = S.questions[S.cur].subject;
  ui.tabs.replaceChildren(...SUBJECTS.map((s) => {
    const qs = S.bySubject[s];
    const answered = qs.filter((q) => ['an', 'ma'].includes(stateOf(q.id))).length;
    return h('button', {
      class: `xsubj subj-${s} ${s === curSubj ? 'active' : ''}`, role: 'tab', 'aria-selected': String(s === curSubj),
      onclick: () => { if (s !== curSubj) go(S.questions.indexOf(qs[0])); },
    }, SUBJECT_LABEL[s], h('span', { class: 'xsubj-count' }, `${answered}/${qs.length}`));
  }));
}

function renderQuestion() {
  const q = S.questions[S.cur];
  const mk = S.paper.marks[q.kind === 'scq' ? 'scq' : 'numerical'];
  ui.qnum.textContent = `Question ${q.slot}`;
  ui.qsec.textContent = q.kind === 'scq' ? 'Section A · Single correct' : 'Section B · Numerical value';
  ui.qmarks.textContent = `+${mk.correct}`;
  ui.qneg.textContent = mk.wrong === 0 ? 'No negative' : `−${Math.abs(mk.wrong)}`;
  ui.qpane.className = `qpane subj-${q.subject}`;
  renderRich(ui.qbody, q.body);
  ui.qimg.replaceChildren();
  if (q.image) ui.qimg.append(zoomableImg(api.imageUrl(q.image), `Figure for question ${q.slot}`));
  renderAnswer(true);
}

function zoomableImg(src, alt) {
  if (!src) return h('div', { class: 'img-missing' }, 'Image unavailable.');
  const img = h('img', { src, alt, draggable: 'false', loading: 'eager' });
  img.addEventListener('click', () => modal({ body: h('img', { src, alt, class: 'zoomed', draggable: 'false' }), actions: [{ label: 'Close', value: null }], wide: true }));
  img.addEventListener('error', () => img.replaceWith(h('div', { class: 'img-missing' }, 'Image failed to load. ', h('button', { class: 'linklike', onclick: () => renderQuestion() }, 'Retry'))));
  return img;
}

function renderAnswer(rebuild = false) {
  const q = S.questions[S.cur];
  const draft = S.draft[q.id] ?? null;
  if (q.kind === 'scq') {
    const opts = q.options || ['', '', '', ''];
    const imgs = q.option_images || [null, null, null, null];
    const bare = opts.every((o) => !String(o || '').trim()) && imgs.every((x) => !x);
    ui.answer.replaceChildren(h('div', { class: `options ${bare ? 'options-bare' : ''}`, role: 'radiogroup' },
      OPTION_KEYS.map((k, i) => {
        const body = h('span', { class: 'opt-body' });
        if (!bare) {
          renderRich(body, opts[i]);
          if (imgs[i]) body.append(zoomableImg(api.imageUrl(imgs[i]), `Option ${optionLabel(k)}`));
        }
        return h('button', {
          class: `opt ${draft === k ? 'selected' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(draft === k),
          onclick: () => selectOption(k),
        }, h('span', { class: 'opt-key' }, optionLabel(k)), bare ? null : body);
      })));
  } else if (rebuild || !ui.numInput) {
    ui.numInput = h('input', {
      class: 'input num-input mono', inputmode: 'decimal', autocomplete: 'off', spellcheck: 'false', maxlength: 14,
      placeholder: 'Your answer', 'aria-label': 'Numerical answer', value: draft ?? '',
    });
    ui.numInput.addEventListener('input', () => {
      const clean = ui.numInput.value.replace(/[^0-9.\-]/g, '').replace(/(?!^)-/g, '').replace(/(\..*)\./g, '$1');
      if (clean !== ui.numInput.value) ui.numInput.value = clean;
      S.draft[q.id] = normalizeNum(clean);
      renderSavedHint();
    });
    ui.numInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); act(e.shiftKey ? 'savemark' : 'save'); } });
    const key = (label, fn) => h('button', { class: 'key', type: 'button', onclick: () => { fn(); ui.numInput.dispatchEvent(new Event('input')); ui.numInput.focus(); } }, label);
    const add = (c) => () => { ui.numInput.value += c; };
    ui.answer.replaceChildren(h('div', { class: 'numeric' }, ui.numInput,
      h('div', { class: 'keypad' },
        ...['7', '8', '9', '4', '5', '6', '1', '2', '3', '0'].map((d) => key(d, add(d))),
        key('.', () => { if (!ui.numInput.value.includes('.')) ui.numInput.value += ui.numInput.value === '' || ui.numInput.value === '-' ? '0.' : '.'; }),
        key('−', () => { const v = ui.numInput.value; ui.numInput.value = v.startsWith('-') ? v.slice(1) : '-' + v; }),
        key('⌫', () => { ui.numInput.value = ui.numInput.value.slice(0, -1); }),
        key('Clear', () => { ui.numInput.value = ''; }))));
  }
  renderSavedHint();
}

function renderSavedHint() {
  const q = S.questions[S.cur];
  const saved = S.resp[q.id]?.a ?? null;
  const d = currentDraft();
  ui.savedHint.className = 'saved-hint';
  if (d !== saved) {
    ui.savedHint.classList.add('is-unsaved');
    ui.savedHint.textContent = d == null ? 'Selection cleared — not saved yet.' : 'Not saved yet — press “Save & Next”.';
  } else if (saved != null) {
    ui.savedHint.classList.add('is-saved');
    ui.savedHint.textContent = `Saved answer: ${q.kind === 'scq' ? optionLabel(saved) : saved}`;
  } else ui.savedHint.textContent = '';
}

function renderPalette() {
  const q0 = S.questions[S.cur];
  const qs = S.bySubject[q0.subject];
  const counts = { nv: 0, na: 0, an: 0, mr: 0, ma: 0 };
  for (const q of qs) counts[stateOf(q.id)]++;
  const li = (cls, label, n) => h('li', null, h('span', { class: `pq pq-demo ${cls}` }, String(n)), label);
  ui.legend.replaceChildren(li('st-nv', 'Not visited', counts.nv), li('st-na', 'Not answered', counts.na), li('st-an', 'Answered', counts.an),
    li('st-mr', 'Marked', counts.mr), li('st-ma', 'Answered & marked', counts.ma));
  const cell = (q) => h('button', {
    class: `pq st-${stateOf(q.id)} ${q === q0 ? 'current' : ''}`, type: 'button', title: `Question ${q.slot}`,
    onclick: () => go(S.questions.indexOf(q)),
  }, String(q.slot));
  ui.palette.replaceChildren(
    h('div', { class: 'pal-title' }, `${SUBJECT_LABEL[q0.subject]} · Section A`),
    h('div', { class: 'pal-grid' }, qs.filter((q) => q.slot <= 20).map(cell)),
    h('div', { class: 'pal-title' }, `${SUBJECT_LABEL[q0.subject]} · Section B`),
    h('div', { class: 'pal-grid' }, qs.filter((q) => q.slot > 20).map(cell)));
}

function setNet(kind, extra = '') {
  const map = {
    saved: ['ok', 'All answers saved'], saving: ['busy', 'Saving…'], pending: ['busy', 'Unsaved changes'],
    offline: ['bad', 'Offline — answers kept on this device'], auth: ['bad', 'Signed out — answers kept on this device'],
    preview: ['busy', 'Preview mode'], moved: ['bad', 'Active on another device'],
  };
  const [cls, text] = map[kind] || map.pending;
  ui.net.className = `xnet net-${cls}`;
  ui.net.replaceChildren(icon(kind === 'offline' ? 'wifi' : 'cloud', 15), h('span', null, text + extra));
}

// ── timer ──────────────────────────────────────────────────────────────────
let ticker = null;
function startTicker() {
  let last = performance.now();
  let n = 0;
  let timeDirty = false;
  const marks = [30, 10, 5, 1];
  ticker = setInterval(() => {
    const t = performance.now();
    const dt = Math.min(t - last, 5000);
    last = t;
    if (!S.running) return;
    if (!document.hidden) {
      const r = ensureResp(S.questions[S.cur].id);
      r.t = Math.round((r.t || 0) + dt);
      timeDirty = true;
    }
    const left = S.attempt.deadline - serverNow();
    ui.timer.textContent = fmtClock(left);
    ui.timerBox.className = `xtimer ${left < 5 * 60000 ? 'crit' : left < 30 * 60000 ? 'warn' : ''}`;
    for (const m of marks) {
      if (left <= m * 60000 && left > (m * 60000 - 5000) && !S.warned.has(m)) {
        S.warned.add(m);
        toast(m === 1 ? 'One minute left.' : `${m} minutes left.`, m <= 5 ? 'warn' : 'info', 5000);
      }
    }
    if (left <= 0 && !S.submitting) { submit(true); return; }
    n++;
    if (n % 10 === 0) saveLocal();
    if (n % 90 === 0 && timeDirty) { timeDirty = false; markDirty(); }
  }, 1000);
}

// ── persistence & sync ─────────────────────────────────────────────────────
function nextSeq() {
  S.seq = Math.max(S.seq + 1, Math.floor(serverNow()));
  return S.seq;
}
function saveLocal() {
  if (S.preview || !S.attempt) return;
  store.set(K.att(S.attempt.id), { seq: S.dirtySeq, resp: S.resp, cur: S.cur });
}
function markDirty(soon = false) {
  if (S.preview) return;
  S.dirtySeq = nextSeq();
  saveLocal();
  if (!S.offline) setNet('pending');
  scheduleSync(soon ? 600 : 2500);
}

let syncTimer = null;
let inflight = false;
let backoff = 0;
function scheduleSync(ms) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(sync, ms);
}
async function sync() {
  syncTimer = null;
  if (inflight || S.preview || S.finished || S.submitting) return;
  if (S.dirtySeq <= S.syncedSeq) { if (!S.offline) setNet('saved'); return; }
  if (!S.attempt.token) return;          // offline resume: reclaim() will get a token first
  inflight = true;
  const seq = S.dirtySeq;
  setNet('saving');
  try {
    const r = await timed(() => api.saveProgress(S.attempt.id, S.attempt.token, seq, S.resp));
    S.syncedSeq = Math.max(S.syncedSeq, seq);
    backoff = 0;
    S.offline = false;
    if (r?.deadline_at) S.attempt.deadline = Date.parse(r.deadline_at);
    setNet(S.dirtySeq > S.syncedSeq ? 'pending' : 'saved');
  } catch (e) {
    if (e.code === 'slow_down') scheduleSync(1200);
    else if (e.code === 'superseded') onSuperseded();
    else if (e.code === 'closed') finish({ status: e.detail?.status || 'expired', practice: S.attempt.practice });
    else if (e.code === 'not_authenticated' || e.code === 'session_expired') { setNet('auth'); backoff = 30000; scheduleSync(backoff); }
    else {
      backoff = Math.min(backoff ? backoff * 2 : 2000, 30000);
      S.offline = true;
      setNet('offline');
      scheduleSync(backoff);
    }
  } finally {
    inflight = false;
    if (!syncTimer && S.dirtySeq > S.syncedSeq && !S.finished && !S.offline) scheduleSync(800);
  }
}

// Get (back) the write token: after an offline start, or "continue here".
// If another device took the attempt over, the username + PIN take it back.
async function reclaim(loop = false, onError = (e) => toast(message(e), 'error')) {
  for (let i = 0; S.running && !S.finished; i++) {
    try {
      const res = await timed(() => api.startAttempt(paperId, practice, S.creds?.name ?? null, S.creds?.pin ?? null));
      const a = res.attempt;
      S.attempt.token = a.token;
      S.attempt.deadline = Date.parse(a.deadline_at);
      if ((a.seq || 0) >= S.dirtySeq) {
        S.resp = a.responses || {};
        S.seq = S.dirtySeq = S.syncedSeq = a.seq || 0;
        show(S.cur);
      } else S.syncedSeq = a.seq || 0;
      S.offline = false;
      ui.superseded?.remove();
      setNet('pending');
      scheduleSync(100);
      return true;
    } catch (e) {
      if (e.code === 'already_submitted') { finish({ status: 'submitted', practice: S.attempt.practice }); return false; }
      if (!loop || (e.code !== 'network' && e.code !== 'server')) { onError(e); return false; }
      await sleep(Math.min(5000 * (i + 1), 30000));
    }
  }
  return false;
}

function onSuperseded() {
  if (ui.superseded) return;
  S.attempt.token = null;
  setNet('moved');
  // Same browser (another tab): one click. Another device took over: needs the PIN.
  const idf = !practice ? identityFields({ pinHint: 'Your PIN proves it’s you.' }) : null;
  if (idf) { idf.name.value = S.name || idf.name.value; idf.el.hidden = !!S.creds; }
  const btn = h('button', {
    class: 'btn btn-primary btn-lg',
    onclick: async () => {
      if (idf && !idf.el.hidden) {
        const creds = idf.read();
        if (!creds) return;
        S.creds = creds;
      }
      btn.disabled = true;
      const ok = await reclaim(false, (e) => {
        if (idf && (IDENTITY_ERRORS.includes(e.code))) { idf.el.hidden = false; if (e.code !== 'name_required') idf.show(e); else idf.pin.focus(); }
        else toast(message(e), 'error');
      });
      if (ok) ui.superseded = null; else btn.disabled = false;
    },
  }, 'Continue here');
  ui.superseded = h('div', { class: 'blocker' },
    h('div', { class: 'card card-pad stack center-card' },
      h('h2', null, 'Exam opened somewhere else'),
      h('p', { class: 'muted' }, 'This exam is now active in another tab or device. Only one can be used at a time. Your timer keeps running.'),
      idf?.el, btn));
  root.append(ui.superseded);
}

// ── submit ─────────────────────────────────────────────────────────────────
function summaryTable() {
  const head = h('tr', null, h('th', null, ''), ...['Answered', 'Not answered', 'Marked', 'Ans. & marked', 'Not visited'].map((t) => h('th', { class: 'num' }, t)));
  const rows = SUBJECTS.map((s) => {
    const c = { an: 0, na: 0, mr: 0, ma: 0, nv: 0 };
    for (const q of S.bySubject[s]) c[stateOf(q.id)]++;
    return h('tr', null, h('td', null, SUBJECT_LABEL[s]), ...['an', 'na', 'mr', 'ma', 'nv'].map((k) => h('td', { class: 'num' }, String(c[k]))));
  });
  return h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('thead', null, head), h('tbody', null, rows)));
}

async function openSubmit() {
  if (!S.running) return;
  const q = S.questions[S.cur];
  const unsaved = currentDraft() !== (S.resp[q.id]?.a ?? null);
  const ok = await modal({
    title: 'Submit the paper?',
    wide: true,
    body: h('div', { class: 'stack' },
      summaryTable(),
      unsaved ? h('div', { class: 'callout callout-warn' }, `Question ${q.slot} (${SUBJECT_LABEL[q.subject]}) has an unsaved selection. It will not be counted unless you save it.`) : null,
      h('p', null, 'After submitting you can’t change any answer.')),
    actions: [{ label: 'Back to exam', value: false }, { label: 'Submit paper', value: true, kind: 'danger' }],
  });
  if (ok) submit(false);
}

async function submit(auto) {
  if (S.submitting || S.finished) return;
  S.submitting = true;
  clearTimeout(syncTimer);
  if (S.preview) return previewScore();
  const overlay = h('div', { class: 'blocker' },
    h('div', { class: 'card card-pad stack center-card' },
      h('div', { class: 'spinner' }),
      h('h2', null, auto ? 'Time’s up — submitting…' : 'Submitting…'),
      h('p', { class: 'muted submit-msg' }, 'Don’t close this window.')));
  root.append(overlay);
  const msg = overlay.querySelector('.submit-msg');
  const seq = nextSeq();
  S.dirtySeq = seq;
  saveLocal();
  for (let i = 0; ; i++) {
    if (!S.attempt.token) {
      msg.textContent = 'Reconnecting to submit…';
      if (!(await reclaim(true))) { overlay.remove(); S.submitting = false; return; }
      clearTimeout(syncTimer);
    }
    try {
      const r = await api.submitAttempt(S.attempt.id, S.attempt.token, seq, S.resp);
      overlay.remove();
      return finish(r);
    } catch (e) {
      if (e.code === 'superseded') { overlay.remove(); S.submitting = false; onSuperseded(); return; }
      if (e.code === 'attempt_not_found') { overlay.remove(); return fatal('This attempt no longer exists. Contact the organisers.'); }
      const late = serverNow() > S.attempt.deadline + GRACE;
      msg.textContent = late
        ? 'Still can’t reach the server. Your last synced answers are already recorded and will be submitted automatically. Keep this window open to send the rest.'
        : 'Connection problem — retrying. Your answers are safe on this device.';
      await sleep(Math.min(2000 * (i + 1), 15000));
    }
  }
}

function finish(res) {
  if (S.finished) return;
  S.finished = true;
  S.running = false;
  clearInterval(ticker);
  clearTimeout(syncTimer);
  removeGuards();
  exitFullscreen();
  document.body.classList.remove('in-exam');
  store.del(K.att(S.attempt.id));
  store.del(K.last());
  const isPractice = res.practice ?? S.attempt.practice;
  const endsAt = res.ends_at || S.info?.paper.ends_at;
  const countdown = h('span', { class: 'mono' });
  const card = h('div', { class: 'card card-pad stack center-card done-card' },
    h('div', { class: 'done-icon' }, icon('check', 30)),
    h('h1', { class: 'h2' }, res.status === 'expired' ? 'Time’s up — your answers were submitted' : 'Paper submitted'),
    isPractice
      ? h('p', { class: 'muted' }, 'Practice attempts are scored straight away.')
      : h('p', { class: 'muted' }, 'Scores, ranks and solutions are published after the paper closes', endsAt ? [' at ', h('strong', null, fmtDate(endsAt))] : '', '.'),
    !isPractice && endsAt ? h('p', null, 'Results in ', countdown) : null,
    h('div', { class: 'row center' },
      isPractice ? h('a', { class: 'btn btn-primary', href: `results.html?paper=${encodeURIComponent(paperId)}&practice=1` }, 'See your result') : null,
      h('a', { class: isPractice ? 'btn' : 'btn btn-primary', href: './' }, 'Back to mocks')));
  root.replaceChildren(h('div', { class: 'gate-center' }, card));
  if (!isPractice && endsAt) {
    const tick = () => {
      const left = Date.parse(endsAt) + GRACE - serverNow();
      if (left <= 0) {
        countdown.replaceWith(h('a', { href: `results.html?paper=${encodeURIComponent(paperId)}` }, 'View results now'));
        clearInterval(tm);
      } else countdown.textContent = fmtCountdown(left);
    };
    const tm = setInterval(tick, 1000);
    tick();
  }
}

function previewScore() {
  let total = 0;
  const per = { physics: 0, chemistry: 0, mathematics: 0 };
  for (const q of S.questions) {
    const key = S.keys.get(q.id);
    const a = S.resp[q.id]?.a;
    if (a == null && !key.bonus) continue;
    const mk = S.paper.marks[q.kind === 'scq' ? 'scq' : 'numerical'];
    const ok = key.bonus || (q.kind === 'scq' ? key.correct_options.includes(a) : Number(a) >= Number(key.correct_min) && Number(a) <= Number(key.correct_max));
    const m = ok ? mk.correct : mk.wrong;
    total += m;
    per[q.subject] += m;
  }
  S.running = false;
  removeGuards();
  exitFullscreen();
  modal({
    title: 'Preview result',
    body: h('div', { class: 'stack' },
      h('p', null, 'Scored locally with the current answer key. Nothing was saved.'),
      h('p', { class: 'mono big' }, `${total} / ${75 * S.paper.marks.scq.correct}`),
      h('p', { class: 'muted' }, SUBJECTS.map((s) => `${SUBJECT_LABEL[s]} ${per[s]}`).join(' · '))),
    actions: [{ label: 'Close preview', value: true, kind: 'primary' }],
    dismissable: false,
  }).then(() => { location.href = `admin.html#/paper/${encodeURIComponent(previewId)}`; });
}

// ── integrity guards (deterrence; real enforcement is on the server) ───────
function violation(kind) {
  if (S.preview || !S.running) return;
  S.violations++;
  if (S.attempt.token) api.reportViolation(S.attempt.id, S.attempt.token, kind);
}
const guards = {
  fullscreenchange: () => {
    if (!S.running || S.preview || !fsSupported()) return;
    if (!document.fullscreenElement) { ui.fsOverlay.hidden = false; violation('fullscreen_exit'); } else ui.fsOverlay.hidden = true;
  },
  visibilitychange: () => {
    if (!S.running || S.preview) return;
    if (document.hidden) violation('tab_hidden');
    else toast('Leaving the exam window is recorded.', 'warn', 4000);
  },
  blur: () => {
    if (!S.running || S.preview) return;
    setTimeout(() => { if (!document.hidden && !document.hasFocus() && S.running) violation('window_blur'); }, 400);
  },
  contextmenu: (e) => { if (S.running) e.preventDefault(); },
  copy: (e) => {
    if (!S.running || e.target?.closest?.('input')) return;
    e.preventDefault();
    violation('copy');
  },
  keydown: (e) => {
    if (!S.running) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && ['p', 's', 'u'].includes(e.key.toLowerCase())) {
      e.preventDefault();
      if (e.key.toLowerCase() === 'p') violation('print');
      return;
    }
    if (document.querySelector('.modal-backdrop') || ui.superseded) return;
    const typing = e.target?.matches?.('input, textarea');
    if (typing) return;
    const q = S.questions[S.cur];
    const k = e.key.toUpperCase();
    if (q.kind === 'scq' && !mod && (OPTION_KEYS.includes(k) || ['1', '2', '3', '4'].includes(k))) {
      e.preventDefault();
      selectOption(OPTION_KEYS.includes(k) ? k : OPTION_KEYS[Number(k) - 1]);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      act(e.shiftKey ? 'savemark' : 'save');
    } else if (e.key === 'ArrowRight') go(S.cur + 1);
    else if (e.key === 'ArrowLeft') go(S.cur - 1);
  },
  beforeunload: (e) => { if (S.running && !S.preview) { saveLocal(); e.preventDefault(); e.returnValue = ''; } },
  online: () => { if (S.running) { backoff = 0; S.attempt.token ? scheduleSync(200) : reclaim(true); } },
  offline: () => { if (S.running && !S.preview) setNet('offline'); },
};
const targets = { blur: window, beforeunload: window, online: window, offline: window };
function installGuards() {
  for (const [ev, fn] of Object.entries(guards)) (targets[ev] || document).addEventListener(ev, fn, ev === 'keydown');
  document.addEventListener('cut', guards.copy);
}
function removeGuards() {
  for (const [ev, fn] of Object.entries(guards)) (targets[ev] || document).removeEventListener(ev, fn, ev === 'keydown');
  document.removeEventListener('cut', guards.copy);
}

boot();
