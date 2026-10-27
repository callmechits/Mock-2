// Per-paper and overall leaderboards (public, computed server-side after a paper ends).
import { api } from './api.js';
import { CONFIG } from './config.js';
import { h, mountHeader, footer, param, fmtNum, message } from './ui.js';

await mountHeader('leaderboard');
document.title = `Leaderboard · ${CONFIG.SITE_NAME}`;
const PAGE = 50;
const main = h('main', { class: 'container page' });
document.body.append(main);
footer();

let tab = param('tab') === 'overall' ? 'overall' : 'paper';
let paperId = param('paper');
let offset = 0;

const tabs = h('div', { class: 'segmented' });
const select = h('select', { class: 'select', 'aria-label': 'Paper' });
const body = h('div');
main.append(h('div', { class: 'page-head' }, h('h1', null, 'Leaderboard'), tabs), h('div', { class: 'lb-controls' }, select), body);

for (const [v, label] of [['paper', 'By paper'], ['overall', 'Overall']]) {
  tabs.append(h('button', { type: 'button', class: tab === v ? 'active' : null, onclick: () => { tab = v; syncUrl(); draw(); } }, label));
}

const papers = await api.listPapers().then((d) => d.papers.filter((p) => p.results_ready)).catch(() => []);
for (const p of papers) select.append(h('option', { value: p.id }, p.title));
if (!paperId && papers[0]) paperId = papers[0].id;
if (paperId) select.value = paperId;
select.addEventListener('change', () => { paperId = select.value; offset = 0; syncUrl(); draw(); });

function syncUrl() {
  const u = new URL(location.href);
  u.searchParams.set('tab', tab);
  if (paperId) u.searchParams.set('paper', paperId); else u.searchParams.delete('paper');
  history.replaceState(null, '', u);
  for (const b of tabs.children) b.classList.toggle('active', b.textContent === (tab === 'paper' ? 'By paper' : 'Overall'));
}

async function draw() {
  select.hidden = tab !== 'paper' || !papers.length;
  body.replaceChildren(h('div', { class: 'skeleton', style: { height: '320px' } }));
  try {
    if (tab === 'overall') return drawOverall(await api.overall(100));
    if (!paperId) { body.replaceChildren(h('div', { class: 'card empty' }, 'No results have been published yet.')); return; }
    drawPaper(await api.leaderboard(paperId, offset, PAGE));
  } catch (e) {
    body.replaceChildren(h('div', { class: 'card empty' }, message(e)));
  }
}

function drawPaper(d) {
  if (d.pending) { body.replaceChildren(h('div', { class: 'card empty' }, 'Results for this paper aren’t published yet.')); return; }
  const out = [];
  if (offset === 0 && d.rows.length) {
    const top = d.rows.slice(0, 3);
    const order = [top[1], top[0], top[2]].filter(Boolean);
    out.push(h('div', { class: 'podium' }, order.map((r) => h('div', { class: `card pod p${r.rank}` },
      h('div', { class: `rank r${Math.min(r.rank, 3)}` }, String(r.rank)),
      h('div', { class: 'pod-name' }, r.handle),
      h('div', { class: 'pod-score' }, String(r.score)),
      h('div', { class: 'fine' }, `${Number(r.percentile).toFixed(2)} %ile`)))));
  }
  if (d.me) {
    out.push(h('div', { class: 'callout callout-info lb-me' },
      'You: ', h('strong', null, `#${fmtNum(d.me.rank)}`), ` of ${fmtNum(d.total)} · ${d.me.score} marks · ${Number(d.me.percentile).toFixed(2)} percentile`));
  }
  out.push(h('div', { class: 'card table-wrap' }, h('table', { class: 'table' },
    h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Candidate'), h('th', { class: 'num' }, 'Phy'), h('th', { class: 'num' }, 'Chem'), h('th', { class: 'num' }, 'Math'), h('th', { class: 'num' }, 'Total'), h('th', { class: 'num' }, 'Percentile'))),
    h('tbody', null, d.rows.length ? d.rows.map((r) => h('tr', { class: r.me ? 'me' : null },
      h('td', { class: 'mono' }, String(r.rank)), h('td', null, h('strong', null, r.handle)),
      h('td', { class: 'num' }, String(r.physics)), h('td', { class: 'num' }, String(r.chemistry)), h('td', { class: 'num' }, String(r.mathematics)),
      h('td', { class: 'num' }, h('strong', null, String(r.score))), h('td', { class: 'num' }, Number(r.percentile).toFixed(2))))
      : h('tr', null, h('td', { colspan: 7, class: 'empty' }, 'No ranked attempts.'))))));
  const pages = Math.ceil((d.total || 0) / PAGE);
  if (pages > 1) {
    const pageNo = Math.floor(offset / PAGE) + 1;
    out.push(h('div', { class: 'pager' },
      h('button', { class: 'btn btn-sm', disabled: offset === 0, onclick: () => { offset -= PAGE; draw(); } }, '← Prev'),
      h('span', { class: 'fine' }, `Page ${pageNo} of ${pages}`),
      h('button', { class: 'btn btn-sm', disabled: pageNo >= pages, onclick: () => { offset += PAGE; draw(); } }, 'Next →')));
  }
  body.replaceChildren(...out);
}

function drawOverall(d) {
  body.replaceChildren(
    h('p', { class: 'fine', style: { marginBottom: '10px' } }, 'Total marks across every ranked paper. Average percentile breaks ties.'),
    h('div', { class: 'card table-wrap' }, h('table', { class: 'table' },
      h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'Candidate'), h('th', { class: 'num' }, 'Papers'), h('th', { class: 'num' }, 'Avg %ile'), h('th', { class: 'num' }, 'Total'))),
      h('tbody', null, d.rows.length ? d.rows.map((r, i) => h('tr', { class: r.me ? 'me' : null },
        h('td', { class: 'mono' }, String(i + 1)), h('td', null, h('strong', null, r.handle)), h('td', { class: 'num' }, String(r.papers)),
        h('td', { class: 'num' }, Number(r.avg_percentile).toFixed(2)), h('td', { class: 'num' }, h('strong', null, fmtNum(r.total)))))
        : h('tr', null, h('td', { colspan: 5, class: 'empty' }, 'Nothing here yet.'))))));
}

syncUrl();
draw();
