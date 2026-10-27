// Shared helpers: DOM, dialogs, formatting, theme, rich text, site header.
import { CONFIG } from './config.js';
import { api, DEMO } from './api.js';
import { message } from './errors.js';

export const SUBJECTS = ['physics', 'chemistry', 'mathematics'];
export const SUBJECT_LABEL = { physics: 'Physics', chemistry: 'Chemistry', mathematics: 'Mathematics' };
export const OPTION_KEYS = ['A', 'B', 'C', 'D'];
export const optionLabel = (k) => (CONFIG.OPTION_STYLE === 'numbers' ? String(OPTION_KEYS.indexOf(k) + 1) : k);
export const slotLabel = (subject, slot) => subject[0].toUpperCase() + slot;
export const param = (name) => new URLSearchParams(location.search).get(name);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { message };

// ── DOM ────────────────────────────────────────────────────────────────────
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

export function icon(name, size = 18) {
  const paths = {
    sun: 'M12 4V2m0 20v-2m8-8h2M2 12h2m13.66-5.66 1.41-1.41M4.93 19.07l1.41-1.41m0-11.32L4.93 4.93m14.14 14.14-1.41-1.41M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10Z',
    moon: 'M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z',
    clock: 'M12 7v5l3 2m6-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
    check: 'm5 12 5 5L20 7',
    x: 'M6 6l12 12M18 6 6 18',
    grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
    image: 'M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M15 9.5a1 1 0 1 0 0-.01',
    wifi: 'M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19.5h.01M2 9a14 14 0 0 1 20 0',
    cloud: 'M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6 9.5 4.25 4.25 0 0 0 7 18Z',
    lock: 'M6 11h12v9H6zM8 11V8a4 4 0 1 1 8 0v3',
    expand: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
    users: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM22 19v-1a4 4 0 0 0-3-3.87M16 3.13a3.5 3.5 0 0 1 0 6.75',
    trophy: 'M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4ZM7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4',
    edit: 'M4 20h4L19 9l-4-4L4 16v4ZM14 6l4 4',
    eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
    history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
    upload: 'M12 16V4m0 0-4 4m4-4 4 4M4 16v4h16v-4',
    download: 'M12 4v12m0 0-4-4m4 4 4-4M4 16v4h16v-4',
    plus: 'M12 5v14M5 12h14',
    chevron: 'm9 6 6 6-6 6',
    flag: 'M5 21V4m0 0h11l-2 4 2 4H5',
    menu: 'M4 6h16M4 12h16M4 18h16',
  };
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', paths[name] || '');
  svg.append(p);
  return svg;
}

// ── feedback ───────────────────────────────────────────────────────────────
export function toast(text, kind = 'info', ms = 3500) {
  let host = $('#toasts');
  if (!host) {
    host = h('div', { id: 'toasts', 'aria-live': 'polite' });
    document.body.append(host);
  }
  const el = h('div', { class: `toast toast-${kind}` }, text);
  host.append(el);
  setTimeout(() => el.classList.add('out'), ms);
  setTimeout(() => el.remove(), ms + 400);
}

export function modal({ title, body, actions = [{ label: 'OK', value: true, kind: 'primary' }], dismissable = true, wide = false }) {
  return new Promise((resolve) => {
    const onKey = (e) => { if (e.key === 'Escape' && dismissable) close(null); };
    const close = (v) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const box = h('div', { class: 'modal' + (wide ? ' modal-wide' : ''), role: 'dialog', 'aria-modal': 'true' },
      title ? h('h2', { class: 'modal-title' }, title) : null,
      h('div', { class: 'modal-body' }, body),
      actions.length ? h('div', { class: 'modal-actions' }, actions.map((a) =>
        h('button', { class: `btn ${a.kind ? 'btn-' + a.kind : 'btn-ghost'}`, type: 'button', onclick: () => (a.onClick ? a.onClick(close) : close(a.value)) }, a.label))) : null);
    const backdrop = h('div', { class: 'modal-backdrop', onmousedown: (e) => { if (e.target === backdrop && dismissable) close(null); } }, box);
    document.body.append(backdrop);
    document.addEventListener('keydown', onKey, true);
    (box.querySelector('input, textarea, select') || box.querySelector('.btn-primary, .btn-danger') || box.querySelector('button'))?.focus();
  });
}

export const confirmDialog = (text, { title = 'Are you sure?', ok = 'Confirm', danger = false } = {}) =>
  modal({ title, body: h('p', null, text), actions: [{ label: 'Cancel', value: false }, { label: ok, value: true, kind: danger ? 'danger' : 'primary' }] })
    .then((v) => v === true);

// ── formatting ─────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
export const fmtDate = (v) => new Date(v).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
export const fmtDay = (v) => new Date(v).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' });
export const fmtTime = (v) => new Date(v).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
export function fmtClock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}
export function fmtCountdown(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400), hr = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (d) return `${d}d ${hr}h`;
  if (hr) return `${hr}h ${pad(m)}m`;
  return `${m}m ${pad(sec)}s`;
}
export function fmtDur(ms) {
  const s = Math.round((ms || 0) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${pad(s % 60)}s` : `${Math.floor(m / 60)}h ${pad(m % 60)}m`;
}
export const fmtNum = (n) => (n == null ? '—' : Number(n).toLocaleString('en-IN'));
export const fmtSigned = (n) => (n > 0 ? `+${n}` : String(n));

// ── theme ──────────────────────────────────────────────────────────────────
const THEME_KEY = 'jeemock_theme';
export function initTheme() {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t) document.documentElement.dataset.theme = t;
  } catch { /* storage blocked: follow the OS */ }
}
export function toggleTheme() {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === 'dark'
    : matchMedia('(prefers-color-scheme: dark)').matches;
  const next = dark ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
}

// ── rich text: sanitised HTML subset + LaTeX ($…$, $$…$$, \(…\), \[…\], \ce{}) ─
let rich = null;
let richReady = null;
export function loadRich() {
  richReady ||= (async () => {
    try {
      const [k, dp] = await Promise.all([
        import('https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/katex.mjs'),
        import('https://cdn.jsdelivr.net/npm/dompurify@3.2.6/dist/purify.es.mjs'),
      ]);
      await import('https://cdn.jsdelivr.net/npm/katex@0.16.22/dist/contrib/mhchem.mjs').catch(() => null);
      rich = { katex: k.default, purify: dp.default };
    } catch (e) {
      console.warn('Maths renderer unavailable; showing raw text.', e);
      rich = { katex: null, purify: null };
    }
    return rich;
  })();
  // Never block the page on a slow CDN.
  return Promise.race([richReady, sleep(6000)]);
}

const MATH_RE = /\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<!\\)\$((?:\\\$|[^$\n])+?)\$/g;
const SAFE_HTML = {
  ALLOWED_TAGS: ['b', 'i', 'u', 'strong', 'em', 'sup', 'sub', 'br', 'p', 'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'span', 'div', 'small', 'code', 'pre', 'hr'],
  ALLOWED_ATTR: ['colspan', 'rowspan'],
};
const MARK = '⁣';

export function renderRich(el, text) {
  el.textContent = '';
  if (!text) return el;
  const maths = [];
  let src = String(text).replace(MATH_RE, (_, a, b, c, d) => {
    maths.push({ tex: a ?? b ?? c ?? d, display: a != null || b != null });
    return `${MARK}M${maths.length - 1}${MARK}`;
  });
  src = src.replace(/\\\$/g, '$');
  if (rich?.purify) {
    el.innerHTML = rich.purify.sanitize(src.replace(/\r?\n/g, '<br>'), SAFE_HTML);
  } else {
    el.textContent = src;
    el.style.whiteSpace = 'pre-wrap';
  }
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  const splitter = new RegExp(`${MARK}M(\\d+)${MARK}`);
  for (const node of nodes) {
    const parts = node.nodeValue.split(splitter);
    if (parts.length === 1) continue;
    const frag = document.createDocumentFragment();
    parts.forEach((part, i) => {
      if (i % 2 === 0) { if (part) frag.append(part); return; }
      const m = maths[Number(part)];
      const span = document.createElement('span');
      if (rich?.katex) {
        try {
          span.innerHTML = rich.katex.renderToString(m.tex, { displayMode: m.display, throwOnError: false, strict: 'ignore', trust: false, maxSize: 20, maxExpand: 500 });
        } catch { span.textContent = m.tex; }
      } else {
        span.className = 'tex-raw';
        span.textContent = m.display ? `$$${m.tex}$$` : `$${m.tex}$`;
      }
      frag.append(span);
    });
    node.replaceWith(frag);
  }
  return el;
}

export function plainText(text, max = 120) {
  const t = String(text || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

// ── sign-in: staff use OAuth; students get an anonymous session ────────────
const PROVIDER_LABEL = { google: 'Google', discord: 'Discord', github: 'GitHub', twitter: 'X', apple: 'Apple', azure: 'Microsoft' };

export function signInDialog(reason) {
  const providers = api.auth.providers;
  const buttons = providers.map((p) => h('button', {
    class: 'btn btn-block btn-provider', type: 'button',
    onclick: async (e) => {
      e.currentTarget.disabled = true;
      try { await api.auth.signIn(p); } catch (err) { toast(message(err), 'error'); e.currentTarget.disabled = false; }
    },
  }, p === 'demo' ? 'Continue as demo admin' : `Continue with ${PROVIDER_LABEL[p] || p}`));
  return modal({
    title: 'Staff sign in',
    body: h('div', { class: 'stack' },
      reason ? h('p', { class: 'muted' }, reason) : null,
      ...buttons,
      h('p', { class: 'fine' }, DEMO
        ? 'Demo mode: nothing leaves this browser.'
        : 'For organisers and question editors. Students don’t need an account — they enter their Reddit username on the exam page.')),
    actions: [],
  });
}

// Cloudflare Turnstile (optional): a bot check before an anonymous session is made.
let turnstileScript = null;
export function captchaWidget() {
  if (DEMO || !CONFIG.TURNSTILE_SITE_KEY) return null;
  const el = h('div', { class: 'captcha' });
  let token = null;
  let waiting = [];
  let widgetId = null;
  turnstileScript ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.onload = resolve;
    s.onerror = reject;
    document.head.append(s);
  });
  turnstileScript.then(() => {
    widgetId = window.turnstile.render(el, {
      sitekey: CONFIG.TURNSTILE_SITE_KEY,
      callback: (t) => { token = t; waiting.forEach((r) => r(t)); waiting = []; },
      'expired-callback': () => { token = null; },
    });
  }).catch(() => toast('Couldn’t load the bot check. Check your connection.', 'error'));
  return {
    el,
    token: () => (token ? Promise.resolve(token) : new Promise((r) => waiting.push(r))),
    reset() { token = null; if (widgetId != null) window.turnstile?.reset(widgetId); },
  };
}

// Students: reuse this browser's session or quietly create an anonymous one.
export async function ensureStudentSession(widget) {
  const u = await api.auth.getUser().catch(() => null);
  if (u) return u;
  const token = widget ? await widget.token() : undefined;
  return api.auth.signInAnonymously(token);
}

const NAME_KEY = 'jeemock_reddit_name';
export const rememberedName = () => { try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; } };
export const rememberName = (n) => { try { localStorage.setItem(NAME_KEY, n); } catch { /* optional */ } };
export const cleanReddit = (s) => {
  const x = String(s ?? '').trim().replace(/^\/?u\//i, '');
  return /^[A-Za-z0-9_-]{3,20}$/.test(x) ? x : null;
};

// Reddit username + PIN fields, shared by the exam gate and the results lookup.
export function identityFields({ pinHint = 'First time on this paper? Choose any 4–8 digit PIN and remember it.' } = {}) {
  const name = h('input', {
    class: 'input', maxlength: 22, autocomplete: 'username', spellcheck: 'false', autocapitalize: 'off',
    placeholder: 'your_reddit_username', value: rememberedName(),
  });
  const pin = h('input', {
    class: 'input mono', type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: 8, placeholder: '••••',
    oninput: () => { pin.value = pin.value.replace(/\D/g, ''); },
  });
  const err = h('p', { class: 'field-error' });
  const el = h('div', { class: 'identity stack' },
    h('div', { class: 'grid-2 identity-row' },
      h('div', { class: 'field' }, h('label', null, 'Reddit username'), h('div', { class: 'prefix-input' }, h('span', null, 'u/'), name)),
      h('div', { class: 'field' }, h('label', null, 'PIN'), pin)),
    h('p', { class: 'fine' }, pinHint),
    err);
  return {
    el, name, pin, err,
    read() {
      err.textContent = '';
      const n = cleanReddit(name.value);
      if (!n) { err.textContent = message({ code: 'name_invalid' }); name.focus(); return null; }
      if (!/^[0-9]{4,8}$/.test(pin.value)) { err.textContent = message({ code: 'pin_invalid' }); pin.focus(); return null; }
      return { name: n, pin: pin.value };
    },
    show(e) {
      err.textContent = e.code === 'pin_wrong' && e.detail?.tries_left != null
        ? `${message(e)} ${e.detail.tries_left} ${e.detail.tries_left === 1 ? 'try' : 'tries'} left before a 15-minute lock.`
        : message(e);
    },
  };
}

export async function ensureHandle(me, { force = false } = {}) {
  if (me?.handle && !force) return me;
  const err = h('p', { class: 'field-error' });
  const input = h('input', {
    class: 'input', maxlength: 20, placeholder: 'e.g. photon_rider', autocomplete: 'off', spellcheck: 'false',
    value: me?.handle || '', oninput: () => { err.textContent = ''; },
  });
  const result = await modal({
    title: me?.handle ? 'Change username' : 'Pick a username',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted' }, 'Shown on leaderboards. 3–20 characters: letters, numbers, underscore.'),
      input, err),
    dismissable: !!me?.handle,
    actions: [
      ...(me?.handle ? [{ label: 'Cancel', value: null }] : []),
      {
        label: 'Save', kind: 'primary',
        onClick: async (close) => {
          const v = input.value.trim();
          if (!/^[A-Za-z0-9_]{3,20}$/.test(v)) { err.textContent = message({ code: 'handle_invalid' }); return; }
          try {
            await api.setHandle(v);
            close(v);
          } catch (e) { err.textContent = message(e); }
        },
      },
    ],
  });
  if (!result) return me;
  return api.me();
}

export async function mountHeader(active = '') {
  initTheme();
  const authSlot = h('div', { class: 'nav-auth' });
  const themeBtn = h('button', { class: 'icon-btn', type: 'button', title: 'Toggle theme', 'aria-label': 'Toggle theme', onclick: toggleTheme }, icon('moon'));
  const link = (href, label, key) => h('a', { href, class: active === key ? 'active' : null }, label);
  const header = h('header', { class: 'topnav' },
    h('div', { class: 'topnav-inner' },
      h('a', { class: 'brand', href: './' }, h('span', { class: 'brand-mark' }, 'J'), h('span', { class: 'brand-name' }, CONFIG.SITE_NAME)),
      h('nav', { class: 'nav-links' },
        link('./', 'Mocks', 'home'),
        link('leaderboard.html', 'Leaderboard', 'leaderboard'),
        CONFIG.COMMUNITY_URL ? h('a', { href: CONFIG.COMMUNITY_URL, target: '_blank', rel: 'noopener' }, CONFIG.COMMUNITY_LABEL || 'Community') : null),
      h('div', { class: 'nav-right' }, themeBtn, authSlot)));
  document.body.prepend(header);
  if (DEMO) {
    header.after(h('div', { class: 'demo-banner' },
      h('strong', null, 'Demo mode'), ' — Supabase isn’t configured yet, so everything runs in your browser. ',
      h('button', { class: 'linklike', type: 'button', onclick: () => api.resetDemo() }, 'Reset demo data')));
  }

  const user = await api.auth.getUser().catch(() => null);
  let me = user && !user.anonymous ? await api.me().catch(() => null) : null;

  const renderAuth = () => {
    authSlot.textContent = '';
    if (!user || user.anonymous) {
      // students never sign in; this is the way in for organisers
      authSlot.append(h('a', { class: 'btn btn-ghost btn-sm', href: 'admin.html' }, 'Staff'));
      return;
    }
    const name = me?.handle || user.name || 'Account';
    const menu = h('div', { class: 'menu', hidden: true },
      h('div', { class: 'menu-head' }, h('strong', null, name), h('span', { class: 'fine' }, user.email || '')),
      me?.role ? h('a', { class: 'menu-item', href: 'admin.html' }, me.role === 'admin' ? 'Admin console' : 'Editor console') : null,
      h('button', { class: 'menu-item', type: 'button', onclick: async () => { me = await ensureHandle(me, { force: true }); renderAuth(); } }, 'Change username'),
      h('button', { class: 'menu-item', type: 'button', onclick: () => api.auth.signOut().then(() => location.reload()) }, 'Sign out'));
    const btn = h('button', { class: 'avatar-btn', type: 'button', 'aria-haspopup': 'true', onclick: (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; } },
      h('span', { class: 'avatar' }, name[0].toUpperCase()), h('span', { class: 'avatar-name' }, name));
    document.addEventListener('click', () => { menu.hidden = true; });
    authSlot.append(h('div', { class: 'menu-wrap' }, btn, menu));
  };
  renderAuth();
  if (me?.role && !me.handle) {   // staff pick a display name for the console
    me = await ensureHandle(me);
    renderAuth();
  }
  return { user, me };
}

export function footer() {
  document.body.append(h('footer', { class: 'site-footer' },
    h('span', null, `${CONFIG.SITE_NAME} · Not affiliated with NTA.`),
    CONFIG.COMMUNITY_URL ? h('a', { href: CONFIG.COMMUNITY_URL, target: '_blank', rel: 'noopener' }, CONFIG.COMMUNITY_LABEL || 'Community') : null));
}
