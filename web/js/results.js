// Result + analysis + solutions for one paper (ranked or practice attempt).
import { api } from './api.js';
import { CONFIG } from './config.js';
import {
  h, icon, mountHeader, footer, renderRich, loadRich, param, fmtDate, fmtDur, fmtNum, fmtSigned, fmtCountdown,
  identityFields, rememberName, message, SUBJECTS, SUBJECT_LABEL, OPTION_KEYS, optionLabel, slotLabel, plainText, modal,
} from './ui.js';

const paperId = param('paper');
const practice = param('practice') === '1';
const { user } = await mountHeader('');
const main = h('main', { class: 'container page' });
document.body.append(main);
footer();

const enc = encodeURIComponent;
const items = new Map();   // question id → review item (for the time chart's click-through)

async function load(creds = null) {
  if (practice && !user) {
    main.replaceChildren(h('div', { class: 'card empty' }, 'No practice attempt on this device.'));
    return;
  }
  const r = await api.result(paperId, practice, creds?.name ?? null, creds?.pin ?? null);
  items.clear();
  main.replaceChildren();
  if (r.pending) renderPending(r); else render(r);
}

if (!paperId) {
  main.append(h('div', { class: 'card empty' }, 'No paper selected.'));
} else {
  main.append(h('div', { class: 'skeleton', style: { height: '240px' } }));
  await loadRich();
  try {
    await load();
  } catch (e) {
    main.replaceChildren(h('div', { class: 'card card-pad stack' },
      h('h1', { class: 'h3' }, 'Couldn’t load this result'),
      h('p', { class: 'muted' }, message(e)),
      e.code === 'attempt_in_progress' ? h('a', { class: 'btn btn-primary', href: `exam.html?paper=${enc(paperId)}&practice=1` }, 'Resume practice') : null));
  }
}

// Took the paper on another device (or cleared this browser)? Username + PIN finds it.
function lookupCard() {
  const idf = identityFields({ pinHint: 'The PIN you chose when you started this paper.' });
  const btn = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Show my result');
  const form = h('form', { class: 'card card-pad stack lookup-card' },
    h('h2', { class: 'h3' }, 'See your result'),
    h('p', { class: 'muted' }, 'This browser didn’t take the paper. Enter the Reddit username and PIN you used.'),
    idf.el, h('div', null, btn));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const creds = idf.read();
    if (!creds) return;
    btn.disabled = true;
    try {
      await load(creds);
      rememberName(creds.name);
    } catch (err) {
      idf.show(err);
      btn.disabled = false;
    }
  });
  return form;
}

function renderPending(r) {
  document.title = `${r.paper?.title || 'Result'} · ${CONFIG.SITE_NAME}`;
  const cd = h('strong', { class: 'mono' });
  const end = Date.parse(r.ends_at) + 30000;
  const skew = Date.parse(r.now) - Date.now();
  const tick = () => {
    const left = end - (Date.now() + skew);
    cd.textContent = left > 0 ? fmtCountdown(left) : 'any moment now';
    if (left < -5000) location.reload();
  };
  tick();
  setInterval(tick, 1000);
  main.append(h('div', { class: 'card card-pad stack center-text' },
    h('span', { class: 'crumb' }, r.paper?.title || ''),
    h('h1', { class: 'h3' }, 'Results aren’t out yet'),
    h('p', { class: 'muted' }, r.attempt
      ? `Your attempt is ${r.attempt.status === 'in_progress' ? 'in progress' : 'submitted'}. Scores, ranks and solutions are published when the paper closes.`
      : 'Scores, ranks and solutions are published when the paper closes.'),
    h('p', null, 'Results in ', cd),
    h('div', null, h('a', { class: 'btn', href: './' }, 'Back to mocks'))));
}

function render(r) {
  const p = r.paper;
  const a = r.attempt;
  document.title = `${p.title} · Result · ${CONFIG.SITE_NAME}`;
  const max = 75 * p.marks.scq.correct;

  main.append(h('div', { class: 'page-head' },
    h('div', null,
      h('span', { class: 'crumb' }, a ? (a.practice ? 'Practice result · unranked' : `Result for u/${a.name}`) : 'Solutions'),
      h('h1', null, p.title)),
    h('div', { class: 'row' },
      h('a', { class: 'btn', href: `leaderboard.html?paper=${enc(p.id)}` }, icon('trophy', 16), 'Leaderboard'),
      p.allow_practice ? h('a', { class: 'btn', href: `exam.html?paper=${enc(p.id)}&practice=1` }, a?.practice ? 'Practice again' : 'Practice this paper') : null)));

  if (r.practice_open) {
    main.append(h('div', { class: 'callout callout-info row', style: { marginBottom: '14px' } },
      h('span', { class: 'spacer' }, 'You have a practice attempt in progress.'),
      h('a', { class: 'btn btn-sm btn-primary', href: `exam.html?paper=${enc(p.id)}&practice=1` }, 'Resume practice')));
  }
  if (r.key_changed) {
    main.append(h('div', { class: 'callout callout-warn', style: { marginBottom: '14px' } },
      'The answer key was revised after results were published. The question review below uses the new key; scores and ranks update once the organisers re-score.'));
  }

  if (!a && r.flushed) {
    main.append(h('div', { class: 'callout callout-info' },
      'Personal data for this paper has been deleted. The leaderboard and the solutions below remain.'));
  } else if (!a && !practice) {
    main.append(lookupCard());
  } else if (!a) {
    main.append(h('div', { class: 'callout callout-info' }, 'No finished practice attempt on this device yet.'));
  } else {
    const attempted = a.correct + a.wrong;
    const used = Date.parse(a.submitted_at) - Date.parse(a.started_at);
    main.append(h('div', { class: 'result-hero' },
      tile('Score', `${a.score}`, `out of ${max}`, 'tile-main'),
      a.practice
        ? tile('Rank', '—', 'Practice attempts aren’t ranked')
        : tile('Rank', r.rank ? `#${fmtNum(r.rank)}` : '—', r.rank ? `of ${fmtNum(p.takers)} candidates` : 'Not ranked'),
      tile('Percentile', r.percentile != null ? Number(r.percentile).toFixed(2) : '—', a.practice ? 'Ranked attempts only' : 'NTA-style, among takers'),
      tile('Accuracy', attempted ? `${Math.round((a.correct / attempted) * 100)}%` : '—', `${a.correct} right · ${a.wrong} wrong · ${fmtDur(used)} used`)));

    const per = Object.fromEntries(SUBJECTS.map((s) => [s, { ok: 0, bad: 0, skip: 0, score: a[s] }]));
    for (const q of r.questions) {
      const m = q.mine;
      if (!m?.a) per[q.subject].skip++;
      else if (m.ok) per[q.subject].ok++;
      else per[q.subject].bad++;
    }
    main.append(h('div', { class: 'subj-cards' }, SUBJECTS.map((s) => h('div', { class: `card subj-card subj-${s}` },
      h('h3', null, SUBJECT_LABEL[s]),
      h('div', { class: 'subj-score' }, String(per[s].score), h('small', null, ` / ${25 * p.marks.scq.correct}`)),
      h('div', { class: 'mini-stats' },
        h('div', null, h('b', { class: 'c-ok' }, String(per[s].ok)), 'correct'),
        h('div', null, h('b', { class: 'c-bad' }, String(per[s].bad)), 'wrong'),
        h('div', null, h('b', { class: 'c-skip' }, String(per[s].skip)), 'skipped'))))));

    main.append(timeStrip(r.questions));
  }

  main.append(review(r));
}

function tile(label, value, sub, cls = '') {
  return h('div', { class: `card tile ${cls}` }, h('span', { class: 'tile-label' }, label), h('span', { class: 'tile-value' }, value), h('span', { class: 'tile-sub' }, sub));
}

function timeStrip(questions) {
  const max = Math.max(1, ...questions.map((q) => q.mine?.t || 0));
  let prev = null;
  const bars = questions.map((q) => {
    const m = q.mine;
    const cls = !m?.a ? '' : m.ok ? 'ok' : 'bad';
    const bar = h('div', {
      class: `tb ${cls} ${prev && prev !== q.subject ? 'sep' : ''}`,
      style: { height: `${Math.max(3, Math.round(((m?.t || 0) / max) * 100))}%` },
      title: `${slotLabel(q.subject, q.slot)} · ${fmtDur(m?.t || 0)}${!m?.a ? ' · skipped' : m.ok ? ' · correct' : ' · wrong'}`,
      onclick: () => openItem(q.id),
    });
    prev = q.subject;
    return bar;
  });
  return h('section', { class: 'block' },
    h('h2', { class: 'block-title' }, 'Time spent per question'),
    h('div', { class: 'card' },
      h('div', { class: 'time-strip' }, bars),
      h('div', { class: 'time-legend' },
        h('span', null, h('i', { style: { background: 'var(--success)' } }), 'Correct'),
        h('span', null, h('i', { style: { background: 'var(--danger)' } }), 'Wrong'),
        h('span', null, h('i', { style: { background: 'var(--surface-3)' } }), 'Skipped'),
        h('span', null, 'Physics → Chemistry → Mathematics. Click a bar to open the question.'))));
}

function openItem(id) {
  const it = items.get(id);
  if (!it) return;
  it.el.hidden = false;
  it.open();
  it.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function review(r) {
  const p = r.paper;
  const hasMine = !!r.attempt;
  let filter = 'all';
  let subject = 'all';
  const list = h('div', { class: 'review-list' });
  const outcome = (q) => (q.bonus ? 'bonus' : !q.mine?.a ? 'skip' : q.mine.ok ? 'ok' : 'bad');

  for (const q of r.questions) {
    const body = h('div', { class: 'ri-body', hidden: true });
    let built = false;
    const build = () => {
      if (built) return;
      built = true;
      const qb = h('div', { class: 'qbody' });
      renderRich(qb, q.body);
      body.append(qb);
      if (q.image) body.append(img(api.imageUrl(q.image)));
      if (q.kind === 'scq') {
        const opts = q.options || [];
        const imgs = q.option_images || [];
        body.append(h('div', { class: 'ri-opts' }, OPTION_KEYS.map((k, i) => {
          const isCorrect = q.correct_options.includes(k);
          const picked = q.mine?.a === k;
          const content = h('span', { class: 'opt-body' });
          renderRich(content, opts[i] || '');
          if (imgs[i]) content.append(img(api.imageUrl(imgs[i])));
          return h('div', { class: `ri-opt ${isCorrect ? 'correct' : picked ? 'picked-wrong' : ''}` },
            h('span', { class: 'opt-key' }, optionLabel(k)), content,
            picked || isCorrect ? h('span', { class: `ri-tag ${isCorrect ? 'c-ok' : 'c-bad'}` }, [picked ? 'Your answer' : '', picked && isCorrect ? ' · ' : '', isCorrect ? 'Correct' : ''].join('')) : null);
        })));
      } else {
        const key = Number(q.correct_min) === Number(q.correct_max) ? String(Number(q.correct_min)) : `${Number(q.correct_min)} to ${Number(q.correct_max)}`;
        body.append(h('div', { class: 'ri-answers' },
          hasMine ? h('div', null, 'Your answer: ', h('b', { class: q.mine?.a ? (q.mine.ok ? 'c-ok' : 'c-bad') : 'c-skip' }, q.mine?.a ?? '—')) : null,
          h('div', null, 'Correct answer: ', h('b', { class: 'c-ok' }, key))));
      }
      if (q.bonus) body.append(h('div', { class: 'callout callout-info' }, 'This question was dropped — everyone gets full marks for it.'));
      if (q.solution || q.solution_image) {
        const sol = h('div', { class: 'qbody' });
        renderRich(sol, q.solution);
        body.append(h('div', { class: 'solution' }, h('h4', null, 'Solution'), sol, q.solution_image ? img(api.imageUrl(q.solution_image)) : null));
      }
    };
    const toggle = () => { build(); body.hidden = !body.hidden; };
    const o = outcome(q);
    const statsText = q.attempted_by ? `${Math.round((q.correct_by / q.attempted_by) * 100)}% of takers got it` : null;
    const badge = {
      ok: h('span', { class: 'badge badge-success' }, 'Correct'),
      bad: h('span', { class: 'badge badge-danger-soft' }, 'Wrong'),
      skip: h('span', { class: 'badge' }, hasMine ? 'Skipped' : `Section ${q.slot <= 20 ? 'A' : 'B'}`),
      bonus: h('span', { class: 'badge badge-purple' }, 'Bonus'),
    }[o];
    const el = h('article', { class: `card ri subj-${q.subject}`, dataset: { outcome: o, subject: q.subject } },
      h('button', { class: 'ri-head', type: 'button', onclick: toggle, 'aria-expanded': 'false' },
        h('span', { class: 'ri-num' }, slotLabel(q.subject, q.slot)), badge,
        h('span', { class: 'ri-snip' }, plainText(q.body, 90) || (q.image ? '[figure]' : '')),
        statsText ? h('span', { class: 'fine' }, statsText) : null,
        q.mine?.t ? h('span', { class: 'fine mono' }, fmtDur(q.mine.t)) : null,
        hasMine ? h('span', { class: `ri-marks ${q.mine?.marks > 0 ? 'c-ok' : q.mine?.marks < 0 ? 'c-bad' : 'c-skip'}` }, fmtSigned(q.mine?.marks ?? 0)) : null),
      body);
    items.set(q.id, { el, open: () => { build(); body.hidden = false; } });
    list.append(el);
  }

  const apply = () => {
    for (const el of list.children) {
      el.hidden = (filter !== 'all' && el.dataset.outcome !== filter) || (subject !== 'all' && el.dataset.subject !== subject);
    }
  };
  const seg = (opts, set) => {
    const wrap = h('div', { class: 'segmented' });
    for (const [v, label] of opts) {
      wrap.append(h('button', {
        type: 'button', class: v === 'all' ? 'active' : null,
        onclick: (e) => { for (const b of wrap.children) b.classList.remove('active'); e.currentTarget.classList.add('active'); set(v); apply(); },
      }, label));
    }
    return wrap;
  };
  const outcomes = hasMine ? [['all', 'All'], ['ok', 'Correct'], ['bad', 'Wrong'], ['skip', 'Skipped'], ['bonus', 'Bonus']] : null;
  return h('section', { class: 'block' },
    h('h2', { class: 'block-title' }, 'Questions & solutions'),
    h('div', { class: 'review-filters' },
      seg([['all', 'All subjects'], ...SUBJECTS.map((s) => [s, SUBJECT_LABEL[s]])], (v) => { subject = v; }),
      outcomes ? seg(outcomes, (v) => { filter = v; }) : null),
    list);
}

function img(src) {
  if (!src) return h('div', { class: 'img-missing' }, 'Image unavailable.');
  const el = h('img', { src, alt: '', loading: 'lazy' });
  el.addEventListener('click', () => modal({ body: h('img', { src, alt: '', style: { maxWidth: '100%' } }), actions: [{ label: 'Close', value: null }], wide: true }));
  return el;
}
