// Bulk question import.
//
// Plain-text format (forgiving — copy straight out of a doc or PDF):
//
//   1. A ball is thrown up with speed $u$. Max height is
//   (A) $u^2/g$   (B) $u^2/2g$
//   (C) $2u^2/g$  (D) $u/2g$
//   Answer: B
//   Solution: Use $v^2 = u^2 - 2gh$ with $v = 0$.
//
//   2. ...
//
// Options may be written (A) / A) / A. / (a) / (1). The answer line may say
// Ans / Answer / Key, with a letter, an option number or (for Section B) a
// number. Everything after "Solution:" until the next question is the solution.
// JSON exported from this console can be pasted too.

const Q_START = /^[ \t]*(?:Q(?:uestion)?[ \t]*\.?[ \t]*)?(\d{1,3})[ \t]*[.):][ \t]+/gm;
const ANSWER = /^[ \t]*(?:ans(?:wer)?|key|correct(?:[ \t]+answer)?)[ \t]*[:.\-–][ \t]*(.+)$/im;
const SOLUTION = /^[ \t]*(?:sol(?:ution)?|explanation)[ \t]*[:.\-–][ \t]*/im;
const OPT = /\(([A-Da-d1-4])\)|(?:^|\n)[ \t]*([A-Da-d])[.)][ \t]+/g;
const KEY_INDEX = { a: 0, b: 1, c: 2, d: 3, 1: 0, 2: 1, 3: 2, 4: 3 };

export function parseText(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!src) return [];
  const starts = [...src.matchAll(Q_START)];
  const blocks = starts.length
    ? starts.map((m, i) => ({ num: Number(m[1]), text: src.slice(m.index + m[0].length, i + 1 < starts.length ? starts[i + 1].index : src.length) }))
    : [{ num: 1, text: src }];
  return blocks.map(({ num, text }) => parseBlock(num, text));
}

function parseBlock(num, text) {
  let rest = text;
  let solution = '';
  const sol = rest.match(SOLUTION);
  if (sol) {
    solution = rest.slice(sol.index + sol[0].length).trim();
    rest = rest.slice(0, sol.index);
  }
  let answerRaw = null;
  const ans = rest.match(ANSWER) || solution.match(ANSWER);
  if (ans) {
    answerRaw = ans[1].trim();
    if (rest.includes(ans[0])) rest = rest.replace(ans[0], '');
    else solution = solution.replace(ans[0], '').trim();
  }

  // find markers A, B, C, D in order
  const marks = [...rest.matchAll(OPT)].map((m) => ({
    idx: KEY_INDEX[(m[1] || m[2]).toLowerCase()],
    start: m.index + (m[0].startsWith('\n') ? 1 : 0),
    end: m.index + m[0].length,
  }));
  let seq = null;
  for (let i = 0; i < marks.length && !seq; i++) {
    if (marks[i].idx !== 0) continue;
    const found = [marks[i]];
    for (let j = i + 1; j < marks.length && found.length < 4; j++) if (marks[j].idx === found.length) found.push(marks[j]);
    if (found.length === 4) seq = found;
  }

  let body = rest.trim();
  let options = null;
  if (seq) {
    body = rest.slice(0, seq[0].start).trim();
    options = seq.map((m, i) => rest.slice(m.end, i < 3 ? seq[i + 1].start : rest.length).trim());
  }

  const letters = [];
  let number = null;
  if (answerRaw) {
    for (const m of answerRaw.matchAll(/\(?\b([A-Da-d1-4])\b\)?/g)) {
      const k = 'ABCD'[KEY_INDEX[m[1].toLowerCase()]];
      if (!letters.includes(k)) letters.push(k);
    }
    const n = answerRaw.match(/-?\d+(?:\.\d+)?/);
    if (n) number = n[0];
  }
  return { num, body, options, letters, number, answerRaw, solution };
}

// A console export. `images` (present in "with images" backups) maps each
// image path to a data: URL so the paper can be restored anywhere.
export function parseJson(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : data.questions;
  if (!Array.isArray(list)) throw new Error('JSON must be an export from this console (with a "questions" list).');
  return {
    questions: list.filter((q) => ['physics', 'chemistry', 'mathematics'].includes(q.subject) && q.slot >= 1 && q.slot <= 25),
    images: data && typeof data.images === 'object' && !Array.isArray(data.images) ? data.images : {},
  };
}

// "P7.png", "chem_12.jpg", "Maths-Q25 solution.webp" → { subject, slot, field }
export function slotFromFilename(filename) {
  const base = String(filename).replace(/\.[a-z0-9]+$/i, '').toLowerCase();
  const m = base.match(/(?:^|[^a-z])(physics|phy|p|chemistry|chem|c|mathematics|maths|math|m)[\s._-]*(?:q[\s._-]*)?0*(\d{1,2})(?!\d)/);
  if (!m) return null;
  const slot = Number(m[2]);
  if (slot < 1 || slot > 25) return null;
  const subject = m[1][0] === 'p' ? 'physics' : m[1][0] === 'c' ? 'chemistry' : 'mathematics';
  const rest = base.slice(0, m.index) + ' ' + base.slice(m.index + m[0].length);
  const solution = /(^|[^a-z])(sol|soln|solution|ans|answer)([^a-z]|$)/.test(rest);
  return { subject, slot, field: solution ? 'solution_image_path' : 'image_path' };
}

// Turns a parsed text question into update fields for a given slot.
export function toFields(p, slot) {
  const warnings = [];
  const f = { body: p.body, solution: p.solution || '' };
  if (slot <= 20) {
    f.options = p.options || ['', '', '', ''];
    if (!p.options) warnings.push('no options found (fine if they are in the image)');
    f.correct_options = p.letters.slice(0, 4);
    if (!p.letters.length) warnings.push('no answer');
    if (p.letters.length > 1) warnings.push(`multiple answers accepted: ${p.letters.join(', ')}`);
  } else {
    if (p.options) warnings.push('has options but this is a numerical slot');
    if (p.number == null) warnings.push('no numerical answer');
    else { f.correct_min = Number(p.number); f.correct_max = Number(p.number); }
  }
  if (!p.body) warnings.push('empty question text');
  return { fields: f, warnings };
}

export function exportJson(paper, rows, images = null) {
  return JSON.stringify({
    format: 'jee-mains-mock/v1',
    exported_at: new Date().toISOString(),
    paper: { title: paper.title, description: paper.description },
    questions: rows.map((r) => ({
      subject: r.subject, slot: r.slot, body: r.body, image_path: r.image_path, options: r.options, option_images: r.option_images,
      correct_options: r.correct_options, correct_min: r.correct_min, correct_max: r.correct_max,
      solution: r.solution, solution_image_path: r.solution_image_path, note: r.note,
    })),
    ...(images ? { images } : {}),
  }, null, images ? 0 : 2);
}

export const imagePathsOf = (rows) => [...new Set(rows.flatMap((r) => [r.image_path, r.solution_image_path, ...(r.option_images || [])]).filter(Boolean))];
