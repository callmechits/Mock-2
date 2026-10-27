// Staff console: papers, the collaborative question editor, publishing,
// live exam monitoring and team management.
//
// Nothing here is trusted by the server: every action is re-checked by RLS
// policies and database functions (see supabase/schema.sql). Hiding a button
// from an editor is convenience, not security.
import { api } from './api.js';
import { CONFIG } from './config.js';
import {
  h, icon, toast, modal, confirmDialog, renderRich, loadRich, mountHeader, message, fmtDate, fmtNum, signInDialog,
  SUBJECTS, SUBJECT_LABEL, OPTION_KEYS, optionLabel, slotLabel, plainText,
} from './ui.js';
import { parseText, parseJson, toFields, exportJson, slotFromFilename, imagePathsOf } from './importer.js';

const A = { user: null, me: null, isAdmin: false, dir: new Map(), cleanup: null, sub: null, subPaper: null, presence: [], onPresence: null, onQuestion: null, onPaper: null };
const W = { paper: null, rows: new Map(), cur: null, form: null, baseVersion: 0, dirty: false, saving: false, zones: new Map(), locked: false };
let content = null;

const enc = encodeURIComponent;
const round6 = (x) => Math.round(x * 1e6) / 1e6;
const hue = (id) => { let x = 7; for (const c of String(id)) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x % 360; };
const colorOf = (id) => `hsl(${hue(id)} 65% 48%)`;
const hasContent = (q) => !!(q.body.trim() || q.image_path);
const isComplete = (q) => hasContent(q) && (q.slot <= 20 ? q.correct_options.length > 0 : q.correct_min != null && q.correct_max != null);
const cellState = (q) => (isComplete(q) ? (q.verified ? 's-verified' : 's-complete') : hasContent(q) ? 's-partial' : '');
const who = (uid) => (uid ? A.dir.get(uid) || 'a teammate' : 'system');
const isOther = (p) => !p.self && p.key !== A.user.id;
const pad2 = (n) => String(n).padStart(2, '0');
const toLocalInput = (v) => { const d = new Date(v); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const ago = (iso) => {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return fmtDate(iso);
};
const ordered = () => [...W.rows.values()].sort((a, b) => SUBJECTS.indexOf(a.subject) - SUBJECTS.indexOf(b.subject) || a.slot - b.slot);

function statusBadge(p) {
  const now = Date.now();
  if (p.status === 'draft') return h('span', { class: 'badge' }, 'Draft');
  if (p.status === 'archived') return h('span', { class: 'badge badge-done' }, 'Archived');
  if (now < Date.parse(p.starts_at)) return h('span', { class: 'badge badge-upcoming' }, 'Scheduled');
  if (now < Date.parse(p.ends_at)) return h('span', { class: 'badge badge-live' }, 'Live');
  return h('span', { class: 'badge badge-success' }, p.results_at ? 'Results out' : 'Ended');
}

// ── boot & routing ─────────────────────────────────────────────────────────
async function start() {
  const { user, me } = await mountHeader('');
  A.user = user;
  A.me = me;
  A.isAdmin = me?.role === 'admin';
  document.title = `Console · ${CONFIG.SITE_NAME}`;
  if (!user || !me?.role) {
    const staffAccount = user && !user.anonymous;
    document.body.append(h('main', { class: 'container page' }, h('div', { class: 'card card-pad stack' },
      h('h1', { class: 'h3' }, 'Staff only'),
      h('p', { class: 'muted' }, staffAccount
        ? 'Your account isn’t on the team. An admin can add you from People → Team (sign in once first so your account exists).'
        : 'Sign in with a staff account to continue.'),
      h('div', { class: 'row' },
        staffAccount ? null : h('button', { class: 'btn btn-primary', onclick: () => signInDialog() }, 'Staff sign in'),
        h('a', { class: 'btn', href: './' }, 'Back to site')))));
    return;
  }
  await loadRich();
  try { for (const s of await api.staff.directory()) A.dir.set(s.user_id, s.name); } catch { /* names are cosmetic */ }
  const link = (href, label, key, ic) => h('a', { href, dataset: { nav: key } }, icon(ic, 17), label);
  const side = h('nav', { class: 'side' },
    link('#/', 'Papers', 'papers', 'grid'),
    link('#/new', 'New paper', 'new', 'plus'),
    A.isAdmin ? link('#/people', 'People', 'people', 'users') : null,
    h('span', { class: `role-tag badge ${A.isAdmin ? 'badge-purple' : 'badge-upcoming'}` }, A.isAdmin ? 'Admin' : 'Editor'));
  content = h('section', { class: 'content' });
  document.body.append(h('div', { class: 'console' }, side, content));
  window.addEventListener('hashchange', route);
  window.addEventListener('beforeunload', (e) => { if (W.dirty) { e.preventDefault(); e.returnValue = ''; } });
  route();
}

async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  if (W.dirty && W.cur && !(await saveQuestion())) {
    toast(`Unsaved changes to ${slotLabel(W.rows.get(W.cur).subject, W.rows.get(W.cur).slot)} couldn’t be saved and were discarded.`, 'warn', 6000);
  }
  W.dirty = false;
  A.cleanup?.();
  A.cleanup = null;
  if (!(parts[0] === 'paper' && parts[1] === A.subPaper)) closeSub();
  const navKey = parts[0] === 'paper' || !parts[0] ? 'papers' : parts[0];
  for (const a of document.querySelectorAll('.side a')) a.classList.toggle('active', a.dataset.nav === navKey);
  content.replaceChildren(h('div', { class: 'skeleton', style: { height: '220px' } }));
  try {
    if (!parts.length) return await viewPapers();
    if (parts[0] === 'new') return viewNew();
    if (parts[0] === 'people' && A.isAdmin) return await viewPeople();
    if (parts[0] === 'paper' && parts[1]) return await viewPaper(parts[1], parts[2] || 'questions');
    location.hash = '#/';
  } catch (e) {
    content.replaceChildren(h('div', { class: 'card card-pad stack' }, h('h2', { class: 'h3' }, 'Something went wrong'), h('p', { class: 'muted' }, message(e))));
  }
}

// ── realtime subscription (one per open paper) ────────────────────────────
async function ensureSub(paperId) {
  if (A.subPaper === paperId) return;
  closeSub();
  A.subPaper = paperId;
  try {
    A.sub = await api.staff.subscribe(paperId, { id: A.user.id, name: A.me.handle || A.user.name }, {
      onQuestion: (row) => A.onQuestion?.(row),
      onPaper: (row) => A.onPaper?.(row),
      onPresence: (list) => { A.presence = list; A.onPresence?.(list); },
      onStatus: (s) => { const dot = document.querySelector('.live-dot'); if (dot) { dot.classList.toggle('on', s === 'SUBSCRIBED'); dot.title = s === 'SUBSCRIBED' ? 'Live sync on' : `Live sync: ${s}`; } },
    });
  } catch (e) {
    console.warn('Realtime unavailable', e);
  }
}
function closeSub() {
  A.sub?.close();
  A.sub = null;
  A.subPaper = null;
  A.presence = [];
}
function presenceEl() {
  const el = h('div', { class: 'presence' });
  const draw = (list) => {
    const seen = new Map();
    for (const p of list) seen.set(p.key, p);
    el.replaceChildren(...[...seen.values()].map((p) => {
      const q = p.slot && W.rows.get(p.slot);
      return h('span', { class: 'pav', style: { background: colorOf(p.key) }, title: `${p.name}${q ? ` · editing ${slotLabel(q.subject, q.slot)}` : ''}` }, (p.name || '?')[0].toUpperCase());
    }));
  };
  draw(A.presence);
  return { el, draw };
}

// ── papers list ────────────────────────────────────────────────────────────
async function viewPapers() {
  const papers = await api.staff.overview();
  const rows = papers.map((p) => h('tr', { class: 'paper-row', onclick: () => { location.hash = `#/paper/${p.id}`; } },
    h('td', null, h('strong', null, p.title), p.key_changed_at ? h('div', { class: 'fine c-bad' }, 'Answer key changed — rescore needed') : null),
    h('td', null, statusBadge(p)),
    h('td', null, fmtDate(p.starts_at)),
    h('td', null, h('div', { class: 'row' }, h('div', { class: 'progress', style: { width: '90px' } }, h('span', { style: { width: `${(p.complete / 75) * 100}%` } })), h('span', { class: 'fine mono' }, `${p.complete}/75`))),
    h('td', { class: 'num' }, `${p.verified}/75`),
    h('td', { class: 'num' }, fmtNum(p.attempts))));
  content.replaceChildren(
    h('div', { class: 'view-head' }, h('h1', { class: 'grow' }, 'Papers'), h('a', { class: 'btn btn-primary', href: '#/new' }, icon('plus', 16), 'New paper')),
    papers.length
      ? h('div', { class: 'card table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, h('th', null, 'Title'), h('th', null, 'Status'), h('th', null, 'Starts'), h('th', null, 'Ready'), h('th', { class: 'num' }, 'Verified'), h('th', { class: 'num' }, 'Attempts'))),
        h('tbody', null, rows)))
      : h('div', { class: 'card empty' }, 'No papers yet. Create the first one.'));
}

// ── paper form (new + settings) ────────────────────────────────────────────
function paperForm(p, { submitLabel, onSubmit, disabled = false }) {
  const now = new Date();
  const defStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7, 9, 0);
  const inp = (attrs) => h('input', { class: 'input', disabled, ...attrs });
  const f = {
    title: inp({ value: p?.title || '', maxlength: 120, placeholder: 'e.g. Full Syllabus Mock #3' }),
    description: h('textarea', { class: 'textarea', rows: 3, maxlength: 2000, disabled, placeholder: 'Syllabus, difficulty, anything students should know' }),
    starts: inp({ type: 'datetime-local', value: toLocalInput(p?.starts_at || defStart) }),
    entry: inp({ type: 'number', min: 1, max: 1440, value: p?.entry_window_min ?? 30 }),
    duration: inp({ type: 'number', min: 10, max: 600, value: p?.duration_min ?? 180 }),
    ends: inp({ type: 'datetime-local', value: p ? toLocalInput(p.ends_at) : '' }),
    auto: h('input', { type: 'checkbox', checked: !p, disabled }),
    scqC: inp({ type: 'number', min: 0, max: 10, value: p?.scq_correct ?? 4 }),
    scqW: inp({ type: 'number', min: -10, max: 0, value: p?.scq_wrong ?? -1 }),
    numC: inp({ type: 'number', min: 0, max: 10, value: p?.num_correct ?? 4 }),
    numW: inp({ type: 'number', min: -10, max: 0, value: p?.num_wrong ?? -1 }),
    practice: h('input', { type: 'checkbox', checked: p ? p.allow_practice : true, disabled }),
  };
  f.description.value = p?.description || '';
  const err = h('p', { class: 'field-error' });
  const recalc = () => {
    if (!f.auto.checked || !f.starts.value) return;
    const end = new Date(new Date(f.starts.value).getTime() + (Number(f.entry.value) + Number(f.duration.value)) * 60000);
    f.ends.value = toLocalInput(end);
  };
  for (const k of ['starts', 'entry', 'duration']) f[k].addEventListener('input', recalc);
  f.auto.addEventListener('change', () => { f.ends.disabled = disabled || f.auto.checked; recalc(); });
  f.ends.disabled = disabled || f.auto.checked;
  recalc();
  const submit = h('button', { class: 'btn btn-primary', type: 'submit', disabled }, submitLabel);
  const field = (label, el, hint) => h('div', { class: 'field' }, h('label', null, label), el, hint ? h('span', { class: 'field-hint' }, hint) : null);
  const form = h('form', { class: 'card form-card' },
    field('Title', f.title),
    field('Description', f.description),
    h('div', { class: 'grid-3' },
      field('Opens at', f.starts, 'Your local time'),
      field('Entry window (minutes)', f.entry, 'How long after opening a student may start'),
      field('Duration (minutes)', f.duration, 'JEE Main: 180')),
    h('div', { class: 'grid-2' },
      field('Closes at', f.ends, 'Results publish automatically after this'),
      h('label', { class: 'check', style: { alignSelf: 'center' } }, f.auto, h('span', null, 'Auto: opening + entry window + duration (latest starter still gets full time)'))),
    h('details', { class: 'adv' }, h('summary', null, 'Marking scheme & practice'),
      h('div', { class: 'stack', style: { marginTop: '12px' } },
        h('div', { class: 'grid-2' },
          field('Section A: correct / wrong', h('div', { class: 'row' }, f.scqC, f.scqW)),
          field('Section B: correct / wrong', h('div', { class: 'row' }, f.numC, f.numW), 'Since 2024 NTA uses −1 for Section B too')),
        h('label', { class: 'check' }, f.practice, h('span', null, 'Allow unranked practice attempts after results are out')))),
    err, h('div', { class: 'row' }, submit));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    const fields = {
      title: f.title.value.trim(), description: f.description.value.trim(),
      starts_at: new Date(f.starts.value).toISOString(), ends_at: new Date(f.ends.value).toISOString(),
      entry_window_min: Number(f.entry.value), duration_min: Number(f.duration.value),
      scq_correct: Number(f.scqC.value), scq_wrong: Number(f.scqW.value), num_correct: Number(f.numC.value), num_wrong: Number(f.numW.value),
      allow_practice: f.practice.checked,
    };
    if (!fields.title) { err.textContent = 'Give the paper a title.'; return; }
    if (!f.starts.value || !f.ends.value || Date.parse(fields.ends_at) <= Date.parse(fields.starts_at)) { err.textContent = 'Closing time must be after opening time.'; return; }
    if (Date.parse(fields.ends_at) < Date.parse(fields.starts_at) + fields.duration_min * 60000) {
      if (!(await confirmDialog('The paper closes before a full duration has passed, so students get less time. Continue?'))) return;
    }
    submit.disabled = true;
    try { await onSubmit(fields); } catch (ex) { err.textContent = message(ex); } finally { submit.disabled = disabled; }
  });
  return form;
}

function viewNew() {
  content.replaceChildren(
    h('div', { class: 'view-head' }, h('h1', { class: 'grow' }, 'New paper')),
    h('p', { class: 'muted', style: { marginBottom: '14px' } }, 'A paper always has 75 slots: 25 per subject, Section A (1–20, single correct) and Section B (21–25, numerical).'),
    paperForm(null, {
      submitLabel: 'Create paper',
      onSubmit: async (fields) => {
        const p = await api.staff.createPaper(fields);
        toast('Paper created', 'success');
        location.hash = `#/paper/${p.id}`;
      },
    }));
}

// ── paper workspace ────────────────────────────────────────────────────────
async function viewPaper(paperId, tab) {
  const paper = await api.staff.getPaper(paperId);
  if (!paper) { content.replaceChildren(h('div', { class: 'card empty' }, 'Paper not found.')); return; }
  W.paper = paper;
  W.locked = paper.status !== 'draft' && !A.isAdmin;
  ensureSub(paperId);
  const pres = presenceEl();
  A.onPresence = (list) => { pres.draw(list); if (tab === 'questions') { renderSlots(); renderPresenceBanner(); } };
  A.onPaper = (row) => {
    if (row.version <= W.paper.version) return;
    const statusChanged = row.status !== W.paper.status;
    W.paper = { ...W.paper, ...row };
    if (statusChanged) { toast('Paper status changed — reloading', 'info'); route(); }
  };
  const tabs = [['questions', 'Questions'], ['settings', 'Settings & publish'], ...(A.isAdmin ? [['monitor', 'Live monitor']] : []), ['history', 'History']];
  const actions = h('div', { class: 'row' },
    h('a', { class: 'btn btn-sm', href: `exam.html?preview=${enc(paperId)}`, target: '_blank', rel: 'noopener' }, icon('eye', 15), 'Preview as student'),
    h('button', { class: 'btn btn-sm', onclick: () => downloadExport() }, icon('download', 15), 'Export'));
  content.replaceChildren(
    h('div', { class: 'view-head' },
      h('a', { class: 'btn btn-ghost btn-sm', href: '#/' }, '← Papers'),
      h('div', { class: 'grow' }, h('h1', null, paper.title)),
      statusBadge(paper), h('span', { class: 'live-dot', title: 'Live sync' }), pres.el, actions),
    h('nav', { class: 'subtabs' }, tabs.map(([k, label]) => h('a', { href: `#/paper/${paperId}/${k}`, class: k === tab ? 'active' : null }, label))));
  if (W.locked) content.append(h('div', { class: 'banner banner-info', style: { marginBottom: '14px' } }, icon('lock', 16), 'This paper is published. Only admins can change it now.'));
  if (tab === 'questions') return viewQuestions();
  if (tab === 'settings') return viewSettings();
  if (tab === 'monitor' && A.isAdmin) return viewMonitor();
  if (tab === 'history') return viewHistory();
}

// ── questions: slot grid + editor ──────────────────────────────────────────
const slotsEl = h('div', { class: 'card slots' });
const editorEl = h('div', { class: 'editor' });
let presenceBanner = null;

async function viewQuestions() {
  const rows = await api.staff.questions(W.paper.id);
  W.rows = new Map(rows.map((r) => [r.id, r]));
  const firstOpen = ordered().find((q) => !isComplete(q)) || ordered()[0];
  const keep = W.cur && W.rows.has(W.cur) ? W.cur : firstOpen.id;
  W.cur = null;
  content.append(h('div', { class: 'workspace' }, slotsEl, editorEl));
  loadSlot(keep);
  A.onQuestion = onRemoteQuestion;
  const onKey = (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveQuestion(); }
    else if (mod && e.key === 'Enter') { e.preventDefault(); saveQuestion({ next: true }); }
    else if (e.altKey && !mod && W.rows.get(W.cur)?.slot <= 20) {
      const i = ['1', '2', '3', '4'].indexOf(e.key) >= 0 ? ['1', '2', '3', '4'].indexOf(e.key) : OPTION_KEYS.indexOf(e.key.toUpperCase());
      if (i >= 0) { e.preventDefault(); toggleCorrect(OPTION_KEYS[i]); }
    }
  };
  const onPaste = (e) => {
    const item = [...(e.clipboardData?.items || [])].find((it) => it.kind === 'file' && it.type.startsWith('image/'));
    if (!item || W.locked) return;
    e.preventDefault();
    uploadTo(document.activeElement?.dataset?.img || 'image_path', item.getAsFile());
  };
  document.addEventListener('keydown', onKey);
  document.addEventListener('paste', onPaste);
  A.cleanup = () => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('paste', onPaste);
    A.onQuestion = null;
  };
}

function renderSlots() {
  if (!slotsEl.isConnected) return;
  const others = new Map();
  for (const p of A.presence) if (isOther(p) && p.slot) others.set(p.slot, p);
  const blocks = SUBJECTS.map((s) => {
    const qs = ordered().filter((q) => q.subject === s);
    const done = qs.filter(isComplete).length;
    return h('div', { class: `slot-subj subj-${s}` },
      h('h3', null, h('span', null, SUBJECT_LABEL[s]), h('span', { class: 'mono' }, `${done}/25`)),
      h('div', { class: 'slot-grid' }, qs.map((q) => {
        const o = others.get(q.id);
        return h('button', {
          type: 'button', class: `slot ${cellState(q)} ${q.id === W.cur ? 'current' : ''} ${q.slot === 21 ? 'b-start' : ''}`,
          title: `${slotLabel(q.subject, q.slot)} · ${q.slot <= 20 ? 'Section A' : 'Section B'}${o ? ` · ${o.name} is here` : ''}`,
          onclick: () => loadSlot(q.id),
        }, String(q.slot), o ? h('span', { class: 'who', style: { background: colorOf(o.key) } }) : null);
      })));
  });
  slotsEl.replaceChildren(...blocks,
    h('div', { class: 'slot-legend' },
      h('span', null, h('i'), 'Empty'), h('span', null, h('i', { style: { background: 'var(--warn-soft)' } }), 'No answer'),
      h('span', null, h('i', { style: { background: 'var(--success-soft)' } }), 'Ready'), h('span', null, h('i', { style: { background: 'var(--success)' } }), 'Verified')),
    h('div', { class: 'stack', style: { marginTop: '14px' } },
      h('button', { class: 'btn btn-sm btn-block', disabled: W.locked, onclick: openImport }, icon('upload', 15), 'Bulk import (text / JSON)'),
      h('button', { class: 'btn btn-sm btn-block', disabled: W.locked, onclick: openBulkImages }, icon('image', 15), 'Bulk images'),
      h('p', { class: 'fine' }, 'Section B (21–25) starts on a new row.')));
}

async function loadSlot(id) {
  if (W.cur === id) return;
  if (W.dirty && !(await saveQuestion())) return;
  const row = W.rows.get(id);
  W.cur = id;
  W.form = toForm(row);
  W.baseVersion = row.version;
  W.dirty = false;
  renderSlots();
  renderEditor();
  A.sub?.track({ slot: id });
}

function toForm(r) {
  const has = r.correct_min != null && r.correct_max != null;
  return {
    body: r.body, image_path: r.image_path, options: [...r.options], option_images: [...r.option_images],
    correct_options: [...r.correct_options],
    num_value: has ? String(round6((Number(r.correct_min) + Number(r.correct_max)) / 2)) : '',
    num_tol: has ? String(round6((Number(r.correct_max) - Number(r.correct_min)) / 2)) : '0',
    solution: r.solution, solution_image_path: r.solution_image_path, note: r.note, bonus: r.bonus,
  };
}

function fromForm(f, row) {
  const out = { body: f.body, image_path: f.image_path, solution: f.solution, solution_image_path: f.solution_image_path, note: f.note };
  if (row.slot <= 20) {
    Object.assign(out, { options: f.options, option_images: f.option_images, correct_options: [...f.correct_options].sort() });
  } else {
    const v = String(f.num_value).trim();
    if (v === '') Object.assign(out, { correct_min: null, correct_max: null });
    else {
      const n = Number(v);
      const t = Math.abs(Number(f.num_tol) || 0);
      if (!Number.isFinite(n)) throw new Error('The answer must be a number.');
      Object.assign(out, { correct_min: round6(n - t), correct_max: round6(n + t) });
    }
  }
  if (A.isAdmin && W.paper.status !== 'draft') out.bonus = !!f.bonus;
  return out;
}

function changedFields(row, fields) {
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    const cur = k === 'correct_min' || k === 'correct_max' ? (row[k] == null ? null : Number(row[k])) : row[k];
    if (JSON.stringify(cur) !== JSON.stringify(v)) out[k] = v;
  }
  return out;
}

function markChanged() {
  const row = W.rows.get(W.cur);
  let dirty = true;
  try { dirty = Object.keys(changedFields(row, fromForm(W.form, row))).length > 0; } catch { dirty = true; }
  W.dirty = dirty;
  setSaveState(dirty ? 'dirty' : 'clean');
  schedulePreview();
}

let saveStateEl = null;
function setSaveState(state, text) {
  if (!saveStateEl) return;
  const map = { dirty: ['dirty', 'Unsaved changes'], clean: ['', 'All changes saved'], saving: ['', 'Saving…'], ok: ['ok', 'Saved'], error: ['dirty', text || 'Not saved'] };
  const [cls, label] = map[state];
  saveStateEl.className = `save-state ${cls}`;
  saveStateEl.textContent = text || label;
}

async function saveQuestion({ next = false, force = false } = {}) {
  const row = W.rows.get(W.cur);
  if (!row || W.saving) return false;
  if (!W.dirty && !force) { if (next) gotoNext(); return true; }
  let fields;
  try { fields = changedFields(row, fromForm(W.form, row)); } catch (e) { toast(e.message, 'error'); return false; }
  if (!Object.keys(fields).length) { W.dirty = false; setSaveState('clean'); if (next) gotoNext(); return true; }
  W.saving = true;
  setSaveState('saving');
  try {
    const res = await api.staff.updateQuestion(row.id, W.baseVersion, fields);
    if (res.conflict) { W.rows.set(row.id, res.row); showConflict(res.row); setSaveState('error', 'Conflict — see above'); return false; }
    W.rows.set(row.id, res.row);
    W.baseVersion = res.row.version;
    W.dirty = false;
    setSaveState('ok');
    renderSlots();
    renderMeta();
    hideConflict();
    if (next) gotoNext();
    return true;
  } catch (e) {
    toast(message(e), 'error');
    setSaveState('error');
    return false;
  } finally {
    W.saving = false;
  }
}

function gotoNext() {
  const list = ordered();
  const i = list.findIndex((q) => q.id === W.cur);
  if (i >= 0 && i < list.length - 1) loadSlot(list[i + 1].id);
}

function toggleCorrect(k, multi = false) {
  if (W.locked) return;
  const set = new Set(W.form.correct_options);
  if (set.has(k)) set.delete(k);
  else if (set.size && !multi) { set.clear(); set.add(k); } else set.add(k);
  W.form.correct_options = [...set].sort();
  for (const b of editorEl.querySelectorAll('[data-key]')) b.classList.toggle('on', W.form.correct_options.includes(b.dataset.key));
  markChanged();
}

let conflictEl = null;
let metaEl = null;
function showConflict(theirs) {
  if (!conflictEl) return;
  conflictEl.hidden = false;
  conflictEl.replaceChildren(icon('users', 16),
    h('span', null, h('strong', null, who(theirs.updated_by)), ' saved a newer version of this question while you were editing.'),
    h('button', { class: 'btn btn-sm', onclick: () => { W.form = toForm(theirs); W.baseVersion = theirs.version; W.dirty = false; renderEditor(); } }, 'Load theirs'),
    h('button', { class: 'btn btn-sm btn-danger', onclick: () => { W.baseVersion = theirs.version; hideConflict(); saveQuestion({ force: true }); } }, 'Overwrite with mine'));
}
function hideConflict() { if (conflictEl) conflictEl.hidden = true; }

function onRemoteQuestion(row) {
  const old = W.rows.get(row.id);
  if (old && old.version >= row.version) return;
  W.rows.set(row.id, row);
  renderSlots();
  if (row.id !== W.cur) return;
  if (!W.dirty) {
    W.form = toForm(row);
    W.baseVersion = row.version;
    renderEditor();
    toast(`${who(row.updated_by)} updated ${slotLabel(row.subject, row.slot)}`, 'info', 2500);
  } else showConflict(row);
}

function renderPresenceBanner() {
  if (!presenceBanner) return;
  const here = A.presence.filter((p) => isOther(p) && p.slot === W.cur);
  presenceBanner.hidden = !here.length;
  if (here.length) presenceBanner.replaceChildren(icon('users', 16), `${here.map((p) => p.name).join(', ')} ${here.length > 1 ? 'are' : 'is'} also on this question. Coordinate before saving — edits are versioned, so nobody's work is silently lost.`);
}

function renderMeta() {
  if (!metaEl) return;
  const row = W.rows.get(W.cur);
  const complete = isComplete(row);
  metaEl.replaceChildren(...[
    h('span', { class: 'fine' }, `v${row.version}`, row.updated_by ? ` · last edit by ${who(row.updated_by)} ${ago(row.updated_at)}` : ''),
    row.verified
      ? h('span', { class: 'badge badge-success' }, icon('check', 13), `Verified by ${who(row.verified_by)}`)
      : null,
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn btn-sm btn-ghost', onclick: () => questionHistory(row) }, icon('history', 15), 'History'),
    !W.locked && complete
      ? h('button', {
        class: `btn btn-sm ${row.verified ? 'btn-ghost' : 'btn-success'}`,
        title: 'A second person checking the question and key',
        onclick: async () => {
          if (W.dirty) { toast('Save your changes first.', 'warn'); return; }
          try {
            const res = await api.staff.updateQuestion(row.id, row.version, { verified: !row.verified });
            if (res.conflict) { W.rows.set(row.id, res.row); onRemoteQuestion(res.row); toast('Someone changed it first — check again.', 'warn'); return; }
            W.rows.set(row.id, res.row); W.baseVersion = res.row.version; renderSlots(); renderMeta();
          } catch (e) { toast(message(e), 'error'); }
        },
      }, row.verified ? 'Unverify' : 'Mark verified')
      : null].filter(Boolean));
}

let previewEl = null;
let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(renderPreview, 200);
}
function renderPreview() {
  if (!previewEl) return;
  const row = W.rows.get(W.cur);
  const f = W.form;
  const body = h('div', { class: 'qbody' });
  renderRich(body, f.body);
  const parts = [h('div', { class: 'row', style: { marginBottom: '10px' } }, h('strong', null, 'Student view'), h('span', { class: 'fine' }, 'live preview'))];
  parts.push(body);
  if (f.image_path) parts.push(h('div', { class: 'qimg' }, h('img', { src: api.imageUrl(f.image_path) || '', alt: '' })));
  if (row.slot <= 20) {
    parts.push(h('div', { class: 'options' }, OPTION_KEYS.map((k, i) => {
      const ob = h('span', { class: 'opt-body' });
      renderRich(ob, f.options[i]);
      if (f.option_images[i]) ob.append(h('img', { src: api.imageUrl(f.option_images[i]) || '', alt: '' }));
      return h('div', { class: `opt ${f.correct_options.includes(k) ? 'correct' : ''}` }, h('span', { class: 'opt-key' }, optionLabel(k)), ob);
    })));
  } else {
    parts.push(h('div', { class: 'callout', style: { marginTop: '12px' } }, 'Numerical answer accepted: ',
      h('strong', { class: 'mono' }, f.num_value === '' ? '—' : Number(f.num_tol) ? `${f.num_value} ± ${f.num_tol}` : f.num_value)));
  }
  if (f.solution || f.solution_image_path) {
    const sol = h('div', { class: 'qbody' });
    renderRich(sol, f.solution);
    parts.push(h('div', { class: 'solution', style: { marginTop: '14px' } }, h('h4', null, 'Solution'), sol,
      f.solution_image_path ? h('img', { src: api.imageUrl(f.solution_image_path) || '', alt: '', style: { maxWidth: '100%' } }) : null));
  }
  previewEl.replaceChildren(...parts);
}

function renderEditor() {
  const row = W.rows.get(W.cur);
  const f = W.form;
  const scq = row.slot <= 20;
  const dis = W.locked;
  W.zones = new Map();
  const field = (label, el, hint) => h('div', { class: 'field' }, h('label', null, label), el, hint ? h('span', { class: 'field-hint' }, hint) : null);
  const area = (key, rows, imgTarget, placeholder) => {
    const el = h('textarea', { class: 'textarea', rows, disabled: dis, placeholder, dataset: imgTarget ? { img: imgTarget } : null, spellcheck: 'false' });
    el.value = f[key] || '';
    el.addEventListener('input', () => { f[key] = el.value; markChanged(); });
    return el;
  };

  conflictEl = h('div', { class: 'banner banner-danger', hidden: true });
  presenceBanner = h('div', { class: 'banner banner-warn', hidden: true });
  metaEl = h('div', { class: 'row' });
  saveStateEl = h('span', { class: 'save-state' });
  previewEl = h('div', { class: 'card preview-pane qpane' });

  const answerBlock = scq
    ? field('Options & correct answer', h('div', { class: 'stack' },
      OPTION_KEYS.map((k, i) => {
        const inp = h('input', { class: 'input', disabled: dis, value: f.options[i] || '', placeholder: `Option ${optionLabel(k)} (leave empty if the options are in the image)`, dataset: { img: `opt:${i}` } });
        inp.addEventListener('input', () => { f.options[i] = inp.value; markChanged(); });
        return h('div', { class: 'opt-row' },
          h('button', { type: 'button', class: `opt-key ${f.correct_options.includes(k) ? 'on' : ''}`, dataset: { key: k }, title: `Mark ${optionLabel(k)} correct (Alt+${i + 1})`, disabled: dis, onclick: (e) => toggleCorrect(k, e.shiftKey) }, optionLabel(k)),
          inp, zone(`opt:${i}`, true));
      }),
      h('span', { class: 'field-hint' }, 'Click a letter to set the answer (Alt+1…4). Shift-click to accept more than one option — only if the official key does.')))
    : field('Correct answer', h('div', { class: 'row' },
      (() => { const el = h('input', { class: 'input mono', style: { maxWidth: '180px' }, inputmode: 'decimal', disabled: dis, value: f.num_value, placeholder: 'e.g. 12 or -3.25' }); el.addEventListener('input', () => { f.num_value = el.value; markChanged(); }); return el; })(),
      h('span', { class: 'muted' }, '±'),
      (() => { const el = h('input', { class: 'input mono', style: { maxWidth: '110px' }, inputmode: 'decimal', disabled: dis, value: f.num_tol, title: 'Tolerance' }); el.addEventListener('input', () => { f.num_tol = el.value; markChanged(); }); return el; })()),
    'Tolerance 0 means exact. Students may enter up to 4 decimal places.');

  const bonus = A.isAdmin && W.paper.status !== 'draft'
    ? h('label', { class: 'check banner banner-warn' },
      (() => { const c = h('input', { type: 'checkbox', checked: !!f.bonus }); c.addEventListener('change', () => { f.bonus = c.checked; markChanged(); }); return c; })(),
      h('span', null, h('strong', null, 'Drop this question (bonus). '), 'Everyone gets full marks for it. Re-score the paper afterwards.'))
    : null;

  const left = h('div', { class: 'card ecard' },
    field('Question', area('body', 6, 'image_path', 'Type or paste the question. $x^2$ for maths, \\ce{H2O} for chemistry.')),
    h('div', { class: 'hint-bar' },
      h('span', null, h('code', null, '$…$'), ' inline maths'), h('span', null, h('code', null, '$$…$$'), ' display'),
      h('span', null, h('code', null, '\\ce{…}'), ' chemistry'), h('span', null, h('code', null, '<b> <i> <sup> <sub>')),
      h('span', null, h('kbd', null, 'Ctrl'), '+', h('kbd', null, 'V'), ' pastes a screenshot into the focused field')),
    field('Question image', zone('image_path')),
    answerBlock,
    field('Solution', area('solution', 4, 'solution_image_path', 'Shown to students after results are published.')),
    field('Solution image', zone('solution_image_path')),
    field('Staff note', (() => { const el = h('input', { class: 'input', disabled: dis, value: f.note, placeholder: 'Only staff see this (source, doubts, who should check…)', maxlength: 2000 }); el.addEventListener('input', () => { f.note = el.value; markChanged(); }); return el; })()),
    bonus);

  const saveBar = h('div', { class: 'save-bar' },
    h('button', { class: 'btn btn-primary', disabled: dis, onclick: () => saveQuestion() }, 'Save', h('kbd', null, 'Ctrl+S')),
    h('button', { class: 'btn', disabled: dis, onclick: () => saveQuestion({ next: true }) }, 'Save & next', h('kbd', null, 'Ctrl+↵')),
    h('button', { class: 'btn btn-ghost', disabled: dis, onclick: clearSlot }, 'Clear slot'),
    h('span', { class: 'spacer' }), saveStateEl);

  editorEl.replaceChildren(
    h('div', { class: `editor-head subj-${row.subject}` },
      h('span', { class: 'slot-name' }, slotLabel(row.subject, row.slot)),
      h('span', { class: 'badge' }, `${SUBJECT_LABEL[row.subject]} · ${scq ? 'Section A · single correct' : 'Section B · numerical'}`)),
    metaEl, conflictEl, presenceBanner,
    h('div', { class: 'editor-grid' }, h('div', { class: 'stack' }, left, saveBar), previewEl));
  renderMeta();
  renderPresenceBanner();
  renderPreview();
  setSaveState(W.dirty ? 'dirty' : 'clean');
}

async function clearSlot() {
  if (!(await confirmDialog('Clear everything in this slot? (The old version stays in History.)', { danger: true, ok: 'Clear' }))) return;
  W.form = { ...W.form, body: '', image_path: null, options: ['', '', '', ''], option_images: [null, null, null, null], correct_options: [], num_value: '', num_tol: '0', solution: '', solution_image_path: null };
  renderEditor();
  markChanged();
}

// ── images ─────────────────────────────────────────────────────────────────
function getImg(t) {
  if (t.startsWith('opt:')) return W.form.option_images[Number(t.slice(4))];
  return W.form[t];
}
function setImg(t, path) {
  if (t.startsWith('opt:')) W.form.option_images[Number(t.slice(4))] = path;
  else W.form[t] = path;
  W.zones.get(t)?.draw();
  markChanged();
}

function zone(target, mini = false) {
  const el = h('div', { class: `zone ${mini ? 'mini' : ''}`, tabindex: '0', dataset: { img: target } });
  const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true });
  input.addEventListener('change', () => { if (input.files[0]) uploadTo(target, input.files[0]); input.value = ''; });
  const draw = () => {
    const path = getImg(target);
    el.classList.toggle('has', !!path);
    el.replaceChildren(input);
    if (path) {
      el.append(h('img', { src: api.imageUrl(path) || '', alt: '' }),
        h('div', { class: 'zone-actions' },
          mini ? null : h('button', { class: 'btn btn-sm', type: 'button', disabled: W.locked, onclick: (e) => { e.stopPropagation(); input.click(); } }, 'Replace'),
          h('button', { class: 'btn btn-sm btn-ghost', type: 'button', disabled: W.locked, title: 'Remove image', onclick: (e) => { e.stopPropagation(); setImg(target, null); } }, mini ? '✕' : 'Remove')));
    } else {
      el.append(icon('image', mini ? 15 : 18), h('span', null, mini ? 'Image' : 'Paste a screenshot (Ctrl+V), drop a file, or click'));
    }
  };
  el.addEventListener('click', () => { if (!getImg(target) && !W.locked) input.click(); });
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drag'); });
  el.addEventListener('dragleave', () => el.classList.remove('drag'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drag');
    const file = [...(e.dataTransfer?.files || [])].find((x) => x.type.startsWith('image/'));
    if (file && !W.locked) uploadTo(target, file);
  });
  W.zones.set(target, { el, draw });
  draw();
  return el;
}

async function compressImage(file, maxW = 1600) {
  const bmp = await createImageBitmap(file);
  let w = bmp.width;
  let ht = bmp.height;
  if (w > maxW) { ht = Math.round((ht * maxW) / w); w = maxW; }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = ht;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';   // transparent screenshots stay readable in dark mode
  ctx.fillRect(0, 0, w, ht);
  ctx.drawImage(bmp, 0, 0, w, ht);
  let blob = await new Promise((r) => canvas.toBlob(r, 'image/webp', 0.86));
  let ext = 'webp';
  if (!blob || blob.type !== 'image/webp') { blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9)); ext = 'jpg'; }
  if (!blob || blob.size > 3 * 1024 * 1024) throw new Error('That image is too large (over 3 MB even after compression).');
  return { blob, ext };
}

async function uploadTo(target, file) {
  if (!file) return;
  const row = W.rows.get(W.cur);
  if (target.startsWith('opt:') && row.slot > 20) target = 'image_path';
  const z = W.zones.get(target);
  z?.el.classList.add('busy');
  try {
    const { blob, ext } = await compressImage(file);
    const path = await api.staff.uploadImage(W.paper.id, blob, ext);
    setImg(target, path);
  } catch (e) {
    toast(e.code ? message(e) : e.message, 'error');
  } finally {
    z?.el.classList.remove('busy');
  }
}

// ── import / export ────────────────────────────────────────────────────────
const blobToDataUrl = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });

async function downloadExport() {
  const withImages = await modal({
    title: 'Export paper',
    body: h('div', { class: 'stack' },
      h('p', null, h('strong', null, 'Questions only'), ' — small file; images stay referenced in storage.'),
      h('p', null, h('strong', null, 'Full backup with images'), ' — every image is embedded, so the file alone can restore the paper (here or in another project).')),
    actions: [{ label: 'Cancel', value: null }, { label: 'Questions only', value: false }, { label: 'Full backup', value: true, kind: 'primary' }],
  });
  if (withImages == null) return;
  try {
    const rows = await api.staff.questions(W.paper.id);
    rows.sort((a, b) => SUBJECTS.indexOf(a.subject) - SUBJECTS.indexOf(b.subject) || a.slot - b.slot);
    let images = null;
    if (withImages) {
      images = {};
      const paths = imagePathsOf(rows);
      let done = 0;
      for (const path of paths) {
        const url = api.imageUrl(path);
        if (url) {
          const res = await fetch(url);
          if (res.ok) images[path] = await blobToDataUrl(await res.blob());
        }
        if (++done % 5 === 0) toast(`Packing images… ${done}/${paths.length}`, 'info', 1200);
      }
    }
    const blob = new Blob([exportJson(W.paper, rows, images)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${W.paper.title.replace(/[^\w-]+/g, '_')}${withImages ? '-backup' : ''}.json` });
    document.body.append(a);
    a.click();
    a.remove();
  } catch (e) {
    toast(e.code ? message(e) : `Export failed: ${e.message}`, 'error');
  }
}

// Re-uploads images embedded in a backup and swaps in their new paths.
async function materializeImages(fields, images, cache) {
  const swap = async (path) => {
    if (!path || !images[path]) return path;
    if (!cache.has(path)) {
      cache.set(path, (async () => {
        const blob = await (await fetch(images[path])).blob();
        const ext = blob.type === 'image/png' ? 'png' : blob.type === 'image/jpeg' ? 'jpg' : 'webp';
        return api.staff.uploadImage(W.paper.id, blob, ext);
      })());
    }
    return cache.get(path);
  };
  if ('image_path' in fields) fields.image_path = await swap(fields.image_path);
  if ('solution_image_path' in fields) fields.solution_image_path = await swap(fields.solution_image_path);
  if (fields.option_images) fields.option_images = await Promise.all(fields.option_images.map(swap));
}

// Many screenshots at once: matched to slots by file name, or in order.
async function openBulkImages() {
  const cur = W.rows.get(W.cur);
  let files = [];
  let mode = 'names';
  const input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', multiple: true, hidden: true });
  const drop = h('div', { class: 'zone bulk-zone' }, input, icon('upload', 18),
    h('span', null, 'Drop screenshots here or click to choose. Name them like ', h('code', null, 'P1.png'), ', ', h('code', null, 'chem-12.jpg'), ', ', h('code', null, 'M25 sol.png'), ' (sol = solution image).'));
  const modeSeg = h('div', { class: 'segmented' },
    h('button', { type: 'button', class: 'active', onclick: (e) => setMode('names', e) }, 'Match file names'),
    h('button', { type: 'button', onclick: (e) => setMode('order', e) }, `In order from ${slotLabel(cur.subject, cur.slot)}`));
  const out = h('div', { class: 'import-preview' });
  let plan = [];
  const thumbs = new Map();
  function setMode(m, e) {
    mode = m;
    for (const b of modeSeg.children) b.classList.toggle('active', b === e.currentTarget);
    build();
  }
  function build() {
    const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    const subjectRows = ordered().filter((r) => r.subject === cur.subject);
    plan = sorted.map((f, i) => {
      let target = null;
      if (mode === 'names') {
        const m = slotFromFilename(f.name);
        const row = m && ordered().find((r) => r.subject === m.subject && r.slot === m.slot);
        if (row) target = { row, field: m.field };
      } else {
        const row = subjectRows.find((r) => r.slot === cur.slot + i);
        if (row) target = { row, field: 'image_path' };
      }
      return { file: f, ...target };
    });
    const seen = new Set();
    out.replaceChildren(!plan.length ? h('p', { class: 'fine' }, 'No files yet.') : h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', null, ''), h('th', null, 'File'), h('th', null, 'Goes to'), h('th', null, 'Notes'))),
      h('tbody', null, plan.map((x) => {
        if (!thumbs.has(x.file)) thumbs.set(x.file, URL.createObjectURL(x.file));
        const key = x.row && `${x.row.id}:${x.field}`;
        const dup = key && seen.has(key);
        if (key) seen.add(key);
        if (dup) x.row = null;
        const existing = x.row && (x.field === 'image_path' ? x.row.image_path : x.row.solution_image_path);
        return h('tr', null,
          h('td', null, h('img', { src: thumbs.get(x.file), alt: '', style: { height: '36px', borderRadius: '4px' } })),
          h('td', { class: 'fine' }, x.file.name),
          h('td', { class: 'mono' }, x.row ? `${slotLabel(x.row.subject, x.row.slot)} ${x.field === 'image_path' ? 'question' : 'solution'}` : '—'),
          h('td', { class: x.row ? 'c-ok' : 'c-bad' }, !x.row ? (dup ? 'duplicate target — skipped' : mode === 'names' ? 'no slot in the name — skipped' : 'beyond slot 25 — skipped') : existing ? 'replaces current image' : 'ok'));
      }))));
  }
  const add = (list) => { files = [...files, ...[...list].filter((f) => f.type.startsWith('image/'))]; build(); };
  input.addEventListener('change', () => { add(input.files); input.value = ''; });
  drop.addEventListener('click', () => input.click());
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('drag'); add(e.dataTransfer?.files || []); });
  build();
  const go = await modal({
    title: 'Bulk images',
    wide: true,
    body: h('div', { class: 'stack' },
      h('p', { class: 'fine' }, 'Each image is compressed in your browser, uploaded to storage and set as that slot’s question (or solution) image. Text and answers are untouched.'),
      modeSeg, drop, out),
    actions: [{ label: 'Cancel', value: false }, { label: 'Upload', value: true, kind: 'primary' }],
  });
  for (const u of thumbs.values()) URL.revokeObjectURL(u);
  const todo = plan.filter((x) => x.row);
  if (!go || !todo.length) return;
  if (W.dirty) await saveQuestion();
  let ok = 0;
  const failed = [];
  const uploaded = [];
  let next = 0;
  const worker = async () => {   // uploads run 3 at a time…
    while (next < todo.length) {
      const x = todo[next++];
      try {
        const { blob, ext } = await compressImage(x.file);
        uploaded.push({ x, path: await api.staff.uploadImage(W.paper.id, blob, ext) });
        if (uploaded.length % 5 === 0) toast(`Uploaded ${uploaded.length}/${todo.length}…`, 'info', 1200);
      } catch (e) {
        failed.push(`${x.file.name} (${e.code ? message(e) : e.message})`);
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  for (const { x, path } of uploaded) {   // …slot updates one by one, so versions never clash
    const row = W.rows.get(x.row.id);
    try {
      const res = await api.staff.updateQuestion(row.id, row.version, { [x.field]: path });
      W.rows.set(row.id, res.row);
      if (res.conflict) failed.push(slotLabel(row.subject, row.slot)); else ok++;
    } catch (e) {
      failed.push(`${slotLabel(row.subject, row.slot)} (${message(e)})`);
    }
  }
  const curRow = W.rows.get(W.cur);
  W.form = toForm(curRow);
  W.baseVersion = curRow.version;
  W.dirty = false;
  renderSlots();
  renderEditor();
  toast(`Added ${ok} image${ok === 1 ? '' : 's'}${failed.length ? ` · failed: ${failed.join(', ')}` : ''}`, failed.length ? 'warn' : 'success', 6000);
}

async function openImport() {
  const cur = W.rows.get(W.cur);
  const subj = h('select', { class: 'select' }, SUBJECTS.map((s) => h('option', { value: s }, SUBJECT_LABEL[s])));
  subj.value = cur.subject;
  const startAt = h('input', { class: 'input', type: 'number', min: 1, max: 25, value: cur.slot, style: { maxWidth: '90px' } });
  const ta = h('textarea', {
    class: 'textarea mono', rows: 10, spellcheck: 'false',
    placeholder: '1. A ball is thrown up with speed $u$. Its maximum height is\n(A) $u^2/g$  (B) $u^2/2g$  (C) $2u^2/g$  (D) $u/2g$\nAnswer: B\nSolution: At the top $v = 0$, so $h = u^2/2g$.\n\n2. ...\n\n(or paste a JSON export from this console)',
  });
  const out = h('div', { class: 'import-preview' });
  let plan = [];
  let images = {};
  const build = () => {
    plan = [];
    images = {};
    const text = ta.value.trim();
    if (!text) { out.replaceChildren(h('p', { class: 'fine' }, 'Paste questions above to see what will be imported.')); return; }
    try {
      if (text.startsWith('{') || text.startsWith('[')) {
        const parsed = parseJson(text);
        images = parsed.images;
        for (const q of parsed.questions) {
          const row = ordered().find((r) => r.subject === q.subject && r.slot === q.slot);
          const fields = { body: q.body || '', image_path: q.image_path || null, solution: q.solution || '', solution_image_path: q.solution_image_path || null, note: q.note || '' };
          if (q.slot <= 20) Object.assign(fields, { options: q.options || ['', '', '', ''], option_images: q.option_images || [null, null, null, null], correct_options: q.correct_options || [] });
          else Object.assign(fields, { correct_min: q.correct_min ?? null, correct_max: q.correct_max ?? null });
          plan.push({ row, fields, warnings: [], snippet: plainText(q.body, 70), answer: q.slot <= 20 ? (q.correct_options || []).join(', ') : q.correct_min ?? '' });
        }
      } else {
        const parsed = parseText(text);
        const s = subj.value;
        let slot = Number(startAt.value) || 1;
        for (const p of parsed) {
          const row = ordered().find((r) => r.subject === s && r.slot === slot);
          if (!row) { plan.push({ row: null, warnings: ['beyond slot 25 — skipped'], snippet: plainText(p.body, 70) }); slot++; continue; }
          const { fields, warnings } = toFields(p, slot);
          plan.push({ row, fields, warnings, snippet: plainText(p.body, 70), answer: slot <= 20 ? p.letters.join(', ') : p.number ?? '' });
          slot++;
        }
      }
    } catch (e) {
      out.replaceChildren(h('p', { class: 'field-error' }, e.message));
      return;
    }
    out.replaceChildren(h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', null, 'Slot'), h('th', null, 'Question'), h('th', null, 'Answer'), h('th', null, 'Notes'))),
      h('tbody', null, plan.map((x) => h('tr', null,
        h('td', { class: 'mono' }, x.row ? slotLabel(x.row.subject, x.row.slot) : '—'),
        h('td', null, x.snippet || h('span', { class: 'muted' }, '(empty)')),
        h('td', { class: 'mono' }, String(x.answer ?? '')),
        h('td', { class: x.warnings.length ? 'c-bad' : 'c-ok' }, [x.row && hasContent(x.row) ? 'overwrites existing · ' : '', x.warnings.join('; ') || 'ok'].join('')))))));
  };
  ta.addEventListener('input', build);
  subj.addEventListener('change', build);
  startAt.addEventListener('input', build);
  build();
  const go = await modal({
    title: 'Bulk import',
    wide: true,
    body: h('div', { class: 'stack' },
      h('p', { class: 'fine' }, 'Questions are numbered “1.”, “Q2.”…, options (A)–(D) or (1)–(4), then “Answer:” and optional “Solution:”. Images can be added per slot afterwards — or paste a whole question as one screenshot and just set the answer.'),
      h('div', { class: 'row' }, h('span', { class: 'label' }, 'Into'), subj, h('span', { class: 'label' }, 'starting at slot'), startAt),
      ta, out),
    actions: [{ label: 'Cancel', value: false }, { label: 'Import', value: true, kind: 'primary' }],
  });
  if (!go) return;
  const todo = plan.filter((x) => x.row && x.fields);
  if (!todo.length) return;
  const overwriting = todo.filter((x) => hasContent(x.row)).length;
  if (overwriting && !(await confirmDialog(`${overwriting} slot(s) already have content and will be overwritten (old versions stay in History).`, { ok: 'Overwrite' }))) return;
  if (W.dirty) await saveQuestion();
  let ok = 0;
  const failed = [];
  const uploaded = new Map();
  for (const x of todo) {
    const row = W.rows.get(x.row.id);
    try {
      if (Object.keys(images).length) await materializeImages(x.fields, images, uploaded);
      const fields = changedFields(row, x.fields);
      if (!Object.keys(fields).length) { ok++; continue; }
      const res = await api.staff.updateQuestion(row.id, row.version, fields);
      if (res.conflict) { failed.push(slotLabel(row.subject, row.slot)); W.rows.set(row.id, res.row); continue; }
      W.rows.set(row.id, res.row);
      ok++;
    } catch (e) {
      failed.push(`${slotLabel(row.subject, row.slot)} (${message(e)})`);
    }
  }
  const curRow = W.rows.get(W.cur);
  W.form = toForm(curRow);
  W.baseVersion = curRow.version;
  W.dirty = false;
  renderSlots();
  renderEditor();
  toast(`Imported ${ok} question${ok === 1 ? '' : 's'}${failed.length ? ` · failed: ${failed.join(', ')}` : ''}`, failed.length ? 'warn' : 'success', 6000);
}

async function questionHistory(row) {
  const list = await api.staff.history(W.paper.id, row.id).catch((e) => { toast(message(e), 'error'); return null; });
  if (!list) return;
  modal({ title: `History · ${slotLabel(row.subject, row.slot)}`, wide: true, body: historyList(list), actions: [{ label: 'Close', value: null }] });
}

function historyList(list) {
  if (!list.length) return h('p', { class: 'muted' }, 'No changes recorded yet.');
  const short = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s == null ? '∅' : s.length > 600 ? s.slice(0, 600) + '…' : s; };
  return h('div', { class: 'stack' }, list.map((l) => h('details', { class: 'card card-pad' },
    h('summary', { class: 'row', style: { cursor: 'pointer' } },
      h('strong', null, l.label || l.action.replace('.', ' ')), h('span', { class: 'fine' }, `${l.actor} · ${fmtDate(l.at)}`),
      h('span', { class: 'fine' }, Object.keys(l.detail || {}).join(', '))),
    h('div', { class: 'stack', style: { marginTop: '10px' } }, Object.entries(l.detail || {}).map(([k, v]) => (Array.isArray(v) && v.length === 2
      ? h('div', null, h('div', { class: 'label' }, k), h('div', { class: 'grid-2' }, h('div', { class: 'diff-block diff-old' }, short(v[0])), h('div', { class: 'diff-block diff-new' }, short(v[1]))))
      : h('div', null, h('div', { class: 'label' }, k), h('div', { class: 'diff-block' }, short(v)))))))));
}

// ── settings & publishing ──────────────────────────────────────────────────
async function viewSettings() {
  const p = W.paper;
  const canEdit = A.isAdmin || p.status === 'draft';
  const form = paperForm(p, {
    submitLabel: 'Save settings',
    disabled: !canEdit,
    onSubmit: async (fields) => {
      const res = await api.staff.updatePaper(p.id, W.paper.version, fields);
      if (res.conflict) { toast('Someone else changed the settings — reloading.', 'warn'); route(); return; }
      W.paper = res.row;
      toast('Settings saved', 'success');
      route();
    },
  });
  const overview = (await api.staff.overview()).find((x) => x.id === p.id) || { complete: 0, verified: 0, attempts: 0 };
  const missingBox = h('div');
  const act = (label, kind, fn, confirmText) => h('button', {
    class: `btn ${kind}`,
    onclick: async () => {
      if (confirmText && !(await confirmDialog(confirmText, { danger: kind === 'btn-danger', ok: label }))) return;
      try { await fn(); } catch (e) {
        if (e.code === 'incomplete') {
          missingBox.replaceChildren(h('div', { class: 'banner banner-warn' }, `Not ready: ${e.detail.missing.length} slot(s) incomplete — `, h('span', { class: 'mono' }, e.detail.missing.join(' '))));
        } else toast(message(e), 'error');
      }
    },
  }, label);
  const now = Date.now();
  const adminActions = A.isAdmin ? h('div', { class: 'row' },
    p.status === 'draft' ? act('Publish', 'btn-success', async () => { await api.staff.publish(p.id); toast('Published — students can see it now', 'success'); route(); }, 'Publish this paper? Students will see it in the list (questions stay hidden until it opens).') : null,
    p.status === 'published' && overview.attempts === 0 ? act('Unpublish', '', async () => { await api.staff.unpublish(p.id); route(); }) : null,
    p.status === 'published' ? act('Archive', '', async () => { await api.staff.archive(p.id, true); route(); }, 'Archive hides the paper from the list. Results stay available to those who took it.') : null,
    p.status === 'archived' ? act('Unarchive', '', async () => { await api.staff.archive(p.id, false); route(); }) : null,
    (p.results_at || p.key_changed_at) && !p.flushed_at ? act('Re-score & rebuild results', p.key_changed_at ? 'btn-primary' : '', async () => { const r = await api.staff.rescore(p.id); toast(r.results_rebuilt ? 'Scores and leaderboard rebuilt' : 'Scores recomputed', 'success'); route(); }, 'Recompute every score with the current answer key and rebuild the leaderboard?') : null,
    p.results_at ? act(p.flushed_at ? 'Flush again' : 'Flush personal data', 'btn-danger', async () => {
      const r = await api.staff.flush(p.id);
      toast(`Deleted ${r.attempts} attempt${r.attempts === 1 ? '' : 's'} and ${r.sessions} anonymous session${r.sessions === 1 ? '' : 's'}`, 'success', 6000);
      route();
    }, 'Permanently delete this paper’s personal data: every attempt (answers, timings), the hashed usernames, PINs and the anonymous sessions used for it. The leaderboard (usernames + scores) and the solutions stay. Students lose their personal answer-by-answer review, and the paper can no longer be re-scored. This can’t be undone.') : null,
    overview.attempts === 0 && !p.results_at ? act('Delete paper', 'btn-danger', async () => { await api.staff.remove(p.id); toast('Deleted'); location.hash = '#/'; }, 'Delete this paper and all its questions permanently?') : null)
    : h('p', { class: 'muted' }, 'Only admins can publish, archive, flush or delete papers.');
  content.append(
    h('div', { class: 'card card-pad stack', style: { maxWidth: '820px', marginBottom: '16px' } },
      h('h2', { class: 'h3' }, 'Publishing'),
      h('div', { class: 'row' },
        h('span', null, 'Ready: ', h('strong', { class: 'mono' }, `${overview.complete}/75`)),
        h('span', null, 'Verified: ', h('strong', { class: 'mono' }, `${overview.verified}/75`)),
        h('span', null, 'Ranked attempts: ', h('strong', { class: 'mono' }, fmtNum(overview.attempts))),
        p.results_at ? h('span', null, 'Results built ', fmtDate(p.results_at)) : null),
      p.flushed_at ? h('div', { class: 'banner banner-info' }, `Personal data flushed ${fmtDate(p.flushed_at)}. Only the leaderboard and question stats remain.`) : null,
      p.key_changed_at && !p.flushed_at ? h('div', { class: 'banner banner-warn' }, 'The answer key changed after results were published. Re-score to update ranks.') : null,
      p.status === 'draft' && now > Date.parse(p.starts_at) ? h('div', { class: 'banner banner-warn' }, 'The opening time has passed. Publishing now opens the paper immediately.') : null,
      missingBox, adminActions),
    form);
}

// ── live monitor (admin) ───────────────────────────────────────────────────
async function viewMonitor() {
  let filter = 'all';
  const stats = h('div', { class: 'stat-row' });
  const table = h('div', { class: 'card table-wrap' });
  const seg = h('div', { class: 'segmented' }, [['all', 'All'], ['in_progress', 'In progress'], ['submitted', 'Finished'], ['flagged', 'Flagged']].map(([v, l]) =>
    h('button', { type: 'button', class: v === 'all' ? 'active' : null, onclick: (e) => { filter = v; for (const b of seg.children) b.classList.remove('active'); e.currentTarget.classList.add('active'); load(); } }, l)));
  const updated = h('span', { class: 'fine' });
  content.append(h('div', { class: 'row', style: { marginBottom: '12px' } }, seg, h('span', { class: 'spacer' }), updated), stats, table);
  const stat = (label, n) => h('div', { class: 'card stat' }, h('b', null, fmtNum(n)), h('span', null, label));
  const flagText = (a) => [...Object.entries(a.violations || {}).map(([k, n]) => `${k.replace('_', ' ')} ×${n}`), a.sessions > 2 ? `${a.sessions} sessions` : null].filter(Boolean).join(', ');
  async function load() {
    try {
      const d = await api.staff.monitor(W.paper.id, filter);
      const c = d.counts;
      stats.replaceChildren(stat('Started', c.started), stat('In progress', c.in_progress), stat('Submitted', c.submitted), stat('Timed out', c.expired), stat('Flagged', c.flagged));
      table.replaceChildren(h('table', { class: 'table' },
        h('thead', null, h('tr', null, ...['Candidate', 'Status', 'Started', 'Last save', 'Answered', 'Flags', 'Score', ''].map((t) => h('th', null, t)))),
        h('tbody', null, d.attempts.length ? d.attempts.map((a) => h('tr', null,
          h('td', null, h('strong', null, a.handle ? `u/${a.handle}` : '—'),
            a.banned ? h('span', { class: 'badge badge-danger-soft', style: { marginLeft: '6px' } }, 'banned') : null,
            a.pin_locked ? h('span', { class: 'badge badge-warn', style: { marginLeft: '6px' } }, 'PIN locked') : null,
            a.pin_reset ? h('span', { class: 'badge', style: { marginLeft: '6px' } }, 'PIN reset') : null),
          h('td', null, a.status === 'in_progress' ? h('span', { class: 'badge badge-live' }, 'Writing') : h('span', { class: 'badge' }, a.status)),
          h('td', { class: 'fine' }, fmtDate(a.started_at)),
          h('td', { class: 'fine' }, a.last_saved_at ? ago(a.last_saved_at) : '—'),
          h('td', { class: 'mono' }, `${a.answered}/75`),
          h('td', { class: flagText(a) ? 'c-bad fine' : 'fine' }, flagText(a) || '—'),
          h('td', { class: 'mono' }, a.score ?? '—'),
          h('td', null, h('div', { class: 'row' },
            a.status === 'in_progress' ? h('button', { class: 'btn btn-sm', onclick: () => extend(a) }, '+ time') : null,
            h('button', { class: 'btn btn-sm btn-ghost', onclick: () => resetPin(a) }, 'Reset PIN'),
            h('button', { class: 'btn btn-sm btn-ghost', onclick: () => reset(a) }, 'Reset'),
            h('button', { class: 'btn btn-sm btn-ghost', onclick: () => ban(a) }, a.banned ? 'Unban' : 'Ban')))))
          : h('tr', null, h('td', { colspan: 8, class: 'empty' }, 'No attempts yet.')))));
      updated.textContent = `Updated ${new Date().toLocaleTimeString()} · refreshes every 10 s`;
    } catch (e) { updated.textContent = message(e); }
  }
  async function extend(a) {
    const input = h('input', { class: 'input', type: 'number', min: 1, max: 180, value: 10 });
    const ok = await modal({ title: `Extra time for ${a.handle}`, body: h('div', { class: 'stack' }, h('p', null, 'For technical problems (power cut, crash). The leaderboard waits for them.'), input), actions: [{ label: 'Cancel', value: false }, { label: 'Add time', value: true, kind: 'primary' }] });
    if (!ok) return;
    try { await api.staff.extend(a.id, Number(input.value)); toast('Time added', 'success'); load(); } catch (e) { toast(message(e), 'error'); }
  }
  async function reset(a) {
    if (!(await confirmDialog(`Delete ${a.handle}'s attempt so they can start again (if the entry window is still open)? This can’t be undone.`, { danger: true, ok: 'Reset attempt' }))) return;
    try { await api.staff.resetAttempt(a.id); load(); } catch (e) { toast(message(e), 'error'); }
  }
  async function resetPin(a) {
    if (!(await confirmDialog(`Clear the PIN of u/${a.handle}? The next person who enters this username sets a new PIN and takes the attempt — only do this once you’ve confirmed who they are (e.g. by Reddit DM).`, { ok: 'Reset PIN' }))) return;
    try { await api.staff.resetPin(a.id); toast('PIN cleared', 'success'); load(); } catch (e) { toast(message(e), 'error'); }
  }
  async function ban(a) {
    if (!(await confirmDialog(a.banned ? `Unban u/${a.handle}?` : `Ban u/${a.handle}? The username can’t start papers and is left off leaderboards (re-score to remove it from this one).`, { danger: !a.banned, ok: a.banned ? 'Unban' : 'Ban' }))) return;
    try { await api.staff.banAttempt(a.id, !a.banned); load(); } catch (e) { toast(message(e), 'error'); }
  }
  await load();
  const t = setInterval(() => { if (!document.hidden) load(); }, 10000);
  A.cleanup = () => clearInterval(t);
}

// ── history ────────────────────────────────────────────────────────────────
async function viewHistory() {
  const list = await api.staff.history(W.paper.id);
  content.append(historyList(list));
}

// ── people (admin) ─────────────────────────────────────────────────────────
async function viewPeople() {
  const staff = await api.staff.listStaff();
  const email = h('input', { class: 'input', type: 'email', placeholder: 'their.email@gmail.com' });
  const role = h('select', { class: 'select', style: { maxWidth: '140px' } }, h('option', { value: 'editor' }, 'Editor'), h('option', { value: 'admin' }, 'Admin'));
  const setRole = async (mail, r) => {
    try { await api.staff.setStaff(mail, r); toast('Team updated', 'success'); route(); } catch (e) { toast(message(e), 'error'); }
  };
  const banned = await api.staff.listBanned().catch(() => []);
  const banInput = h('input', { class: 'input', placeholder: 'u/username', maxlength: 22, spellcheck: 'false' });
  const setBan = async (name, on) => {
    try { await api.staff.banName(name, on); toast(on ? `u/${name.replace(/^\/?u\//i, '')} banned` : 'Unbanned', 'success'); route(); } catch (e) { toast(message(e), 'error'); }
  };
  content.replaceChildren(
    h('div', { class: 'view-head' }, h('h1', { class: 'grow' }, 'People')),
    h('div', { class: 'card card-pad stack', style: { marginBottom: '16px' } },
      h('h2', { class: 'h3' }, 'Team'),
      h('p', { class: 'fine' }, 'Editors write and verify questions in draft papers, together in real time. Admins also publish, fix live papers, re-score, monitor exams and manage people. Someone must sign in once before you can add them.'),
      h('div', { class: 'table-wrap' }, h('table', { class: 'table' },
        h('thead', null, h('tr', null, h('th', null, 'Member'), h('th', null, 'Role'), h('th', null, ''))),
        h('tbody', null, staff.map((s) => {
          const sel = h('select', { class: 'select', style: { maxWidth: '130px' } }, h('option', { value: 'editor' }, 'Editor'), h('option', { value: 'admin' }, 'Admin'));
          sel.value = s.role;
          sel.addEventListener('change', () => setRole(s.email, sel.value));
          return h('tr', null,
            h('td', null, h('strong', null, s.handle || s.full_name || '—'), h('div', { class: 'fine' }, s.email)),
            h('td', null, sel),
            h('td', null, h('button', { class: 'btn btn-sm btn-ghost', onclick: async () => { if (await confirmDialog(`Remove ${s.email} from the team?`, { danger: true, ok: 'Remove' })) setRole(s.email, null); } }, 'Remove')));
        })))),
      h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); if (email.value.trim()) setRole(email.value.trim(), role.value); } },
        email, role, h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add to team'))),
    h('div', { class: 'card card-pad stack' },
      h('h2', { class: 'h3' }, 'Banned Reddit usernames'),
      h('p', { class: 'fine' }, 'Students have no accounts, so bans apply to usernames. Stored as a keyed hash plus an encrypted copy (shown only here). A banned name can’t start papers and is left off leaderboards.'),
      banned.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'table' }, h('tbody', null, banned.map((b) => h('tr', null,
          h('td', null, h('strong', null, `u/${b.name}`)), h('td', { class: 'fine' }, b.banned_at ? fmtDate(b.banned_at) : ''),
          h('td', null, h('button', { class: 'btn btn-sm btn-ghost', onclick: () => setBan(b.name, false) }, 'Unban')))))))
        : h('p', { class: 'muted' }, 'Nobody is banned.'),
      h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); if (banInput.value.trim()) setBan(banInput.value.trim(), true); } },
        banInput, h('button', { class: 'btn btn-danger', type: 'submit' }, 'Ban username'))));
}

start();
