// Home: every published paper, grouped by phase, with live countdowns.
import { api } from './api.js';
import { CONFIG } from './config.js';
import { h, icon, mountHeader, footer, fmtDate, fmtCountdown, fmtNum, toast, message, sleep } from './ui.js';

await mountHeader('home');
document.title = CONFIG.SITE_NAME;

const lists = { live: h('div', { class: 'paper-grid' }), upcoming: h('div', { class: 'paper-grid' }), past: h('div', { class: 'paper-grid' }) };
const sections = {
  live: h('section', { class: 'home-section', hidden: true }, h('h2', { class: 'section-title' }, h('span', { class: 'dot-live' }), 'Live now'), lists.live),
  upcoming: h('section', { class: 'home-section', hidden: true }, h('h2', { class: 'section-title' }, 'Upcoming'), lists.upcoming),
  past: h('section', { class: 'home-section', hidden: true }, h('h2', { class: 'section-title' }, 'Past papers'), lists.past),
};
const empty = h('div', { class: 'card empty', hidden: true }, 'No papers have been published yet. Check back soon.');
const loading = h('div', { class: 'paper-grid' }, [1, 2, 3].map(() => h('div', { class: 'skeleton', style: { height: '190px' } })));
const topList = h('ol', { class: 'top-list' });
const topCard = h('aside', { class: 'card card-pad top-card', hidden: true },
  h('div', { class: 'row' }, icon('trophy'), h('h2', { class: 'h3' }, 'Top performers'), h('a', { class: 'spacer-left fine', href: 'leaderboard.html?tab=overall' }, 'Full board →')),
  topList);

document.body.append(
  h('main', { class: 'container home' },
    h('section', { class: 'hero' },
      h('h1', null, 'JEE Main mocks that feel like ', h('em', null, 'the real thing.')),
      h('p', { class: 'hero-sub' }, CONFIG.TAGLINE),
      h('div', { class: 'hero-chips' },
        chip('75 questions · 3 hours'), chip('+4 / −1 marking'), chip('Server-timed & auto-saved'), chip('Ranks & NTA-style percentiles'))),
    loading, empty, sections.live, sections.upcoming,
    h('div', { class: 'home-split' }, sections.past, topCard)));
footer();

function chip(text) {
  return h('span', { class: 'chip' }, icon('check', 14), text);
}

let data = null;
let offset = 0;
const now = () => Date.now() + offset;

async function load() {
  for (let i = 0; ; i++) {
    try {
      const t0 = Date.now();
      data = await api.listPapers();
      offset = Date.parse(data.now) - (t0 + Date.now()) / 2;
      break;
    } catch (e) {
      if (i === 0) toast(message(e), 'error');
      await sleep(Math.min(2000 * (i + 1), 15000));
    }
  }
  loading.remove();
  render();
}

function phaseOf(p) {
  const t = now();
  const start = Date.parse(p.starts_at);
  const end = Date.parse(p.ends_at);
  const entryEnd = Math.min(start + p.entry_window_min * 60000, end);
  if (t < start) return { phase: 'upcoming', start, end, entryEnd };
  if (t < entryEnd) return { phase: 'open', start, end, entryEnd };
  if (t < end) return { phase: 'running', start, end, entryEnd };
  return { phase: 'ended', start, end, entryEnd };
}

const timers = [];
const lastPhase = new Map();
function render() {
  timers.length = 0;
  for (const l of Object.values(lists)) l.replaceChildren();
  const papers = data.papers;
  empty.hidden = papers.length > 0;
  for (const p of papers) {
    const ph = phaseOf(p);
    lastPhase.set(p.id, ph.phase);
    const target = ph.phase === 'upcoming' ? 'upcoming' : ph.phase === 'ended' ? 'past' : 'live';
    lists[target].append(card(p, ph));
  }
  lists.upcoming.replaceChildren(...[...lists.upcoming.children].reverse());
  for (const [k, s] of Object.entries(sections)) s.hidden = lists[k].children.length === 0;
}

function card(p, ph) {
  const href = (extra = '') => `exam.html?paper=${encodeURIComponent(p.id)}${extra}`;
  const resultsHref = (extra = '') => `results.html?paper=${encodeURIComponent(p.id)}${extra}`;
  const status = h('div', { class: 'paper-status' });
  const actions = h('div', { class: 'paper-actions' });
  const mine = p.mine;
  let badge;

  const live = (el, fn) => { timers.push(() => { el.textContent = fn(); }); el.textContent = fn(); return el; };

  if (ph.phase === 'upcoming') {
    badge = h('span', { class: 'badge badge-upcoming' }, 'Upcoming');
    status.append('Opens in ', live(h('strong', { class: 'mono' }), () => fmtCountdown(ph.start - now())));
    actions.append(h('a', { class: 'btn', href: href() }, 'Instructions'));
  } else if (ph.phase === 'open' || ph.phase === 'running') {
    badge = h('span', { class: 'badge badge-live' }, 'Live');
    if (mine && mine.status !== 'in_progress') {
      status.append(h('span', { class: 'ok' }, icon('check', 15), ' Submitted'), ' · results in ', live(h('strong', { class: 'mono' }), () => fmtCountdown(ph.end - now())));
    } else if (mine) {
      status.append('In progress — your time is running');
      actions.append(h('a', { class: 'btn btn-primary', href: href() }, 'Resume'));
    } else if (ph.phase === 'open') {
      status.append('Entry closes in ', live(h('strong', { class: 'mono' }), () => fmtCountdown(ph.entryEnd - now())));
      actions.append(h('a', { class: 'btn btn-primary', href: href() }, 'Start paper'));
    } else {
      status.append('Entry closed · results in ', live(h('strong', { class: 'mono' }), () => fmtCountdown(ph.end - now())));
    }
  } else {
    badge = h('span', { class: 'badge badge-done' }, 'Completed');
    if (!p.results_ready) status.append('Results are being prepared…');
    else {
      status.append(fmtNum(p.results_count), ' ranked attempts');
      actions.append(h('a', { class: 'btn btn-primary', href: resultsHref() }, mine ? 'Your result' : 'Result & solutions'));
      actions.append(h('a', { class: 'btn', href: `leaderboard.html?paper=${encodeURIComponent(p.id)}` }, 'Leaderboard'));
      if (p.allow_practice) actions.append(h('a', { class: 'btn', href: href('&practice=1') }, p.practice_open ? 'Resume practice' : 'Practice'));
    }
  }

  return h('article', { class: `card paper-card phase-${ph.phase}` },
    h('div', { class: 'paper-top' }, badge, h('span', { class: 'fine' }, `${p.duration_min} min · 75 Qs`)),
    h('h3', { class: 'paper-title' }, p.title),
    p.description ? h('p', { class: 'paper-desc' }, p.description) : null,
    h('div', { class: 'paper-when' }, icon('clock', 15), fmtDate(p.starts_at)),
    status, actions);
}

async function loadTop() {
  try {
    const { rows } = await api.overall(5);
    if (!rows.length) return;
    topList.replaceChildren(...rows.map((r, i) => h('li', { class: r.me ? 'me' : null },
      h('span', { class: `rank r${i + 1}` }, String(i + 1)), h('span', { class: 'top-name' }, r.handle),
      h('span', { class: 'mono' }, fmtNum(r.total)))));
    topCard.hidden = false;
  } catch { /* optional */ }
}

await load();
loadTop();
setInterval(() => {
  // re-group when a paper changes phase, otherwise just tick the countdowns
  const changed = data.papers.some((p) => lastPhase.get(p.id) !== phaseOf(p).phase);
  if (changed) render(); else for (const t of timers) t();
}, 1000);
setInterval(() => { if (!document.hidden) api.listPapers().then((d) => { data = d; render(); }).catch(() => {}); }, 60000);
