// Production backend: thin wrappers around the database functions in
// supabase/schema.sql. No rule is enforced here — the database does that.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.94.0/+esm';
import { CONFIG } from './config.js';
import { ApiError } from './errors.js';

// Requests that hang are worse than requests that fail: cap them so the
// exam's retry logic can take over.
function fetchWithTimeout(input, init = {}) {
  const url = typeof input === 'string' ? input : input.url;
  const ms = url.includes('/storage/') ? 60000 : 20000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  if (init.signal) init.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  return fetch(input, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

const sb = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
  global: { fetch: fetchWithTimeout },
});

function toError(error) {
  const msg = String(error?.message || '');
  if (!error?.code && /fetch|network|load failed|abort/i.test(msg)) return new ApiError('network', msg);
  if (/^[a-z_]+$/.test(msg)) return new ApiError(msg, error);            // raised by our triggers
  if (error?.code === '42501') return new ApiError('forbidden', msg);
  if (error?.code === 'PGRST301' || /jwt/i.test(msg)) return new ApiError('session_expired', msg);
  return new ApiError('server', msg);
}

async function rpc(name, args = {}) {
  let res;
  try {
    res = await sb.rpc(name, args);
  } catch (e) {
    throw new ApiError('network', String(e));
  }
  if (res.error) throw toError(res.error);
  const data = res.data;
  if (data && typeof data === 'object' && !Array.isArray(data) && data.error) throw new ApiError(data.error, data);
  return data;
}

async function table(promise) {
  let res;
  try {
    res = await promise;
  } catch (e) {
    throw new ApiError('network', String(e));
  }
  if (res.error) throw toError(res.error);
  return res.data;
}

// Optimistic concurrency: the update only applies if nobody saved in between.
async function versionedUpdate(tbl, id, version, fields) {
  const row = await table(sb.from(tbl).update(fields).eq('id', id).eq('version', version).select().maybeSingle());
  if (row) return { row };
  const current = await table(sb.from(tbl).select('*').eq('id', id).maybeSingle());
  return { conflict: true, row: current };
}

function flattenPresence(state) {
  const out = [];
  for (const [key, metas] of Object.entries(state)) {
    const last = metas[metas.length - 1];
    if (last) out.push({ ...last, key });
  }
  return out;
}

export const api = {
  demo: false,

  auth: {
    // OAuth is for staff only; students get an anonymous session on the exam page.
    providers: CONFIG.STAFF_AUTH_PROVIDERS,
    async getUser() {
      const { data } = await sb.auth.getSession();
      const u = data.session?.user;
      if (!u) return null;
      return { id: u.id, anonymous: !!u.is_anonymous, email: u.email, name: u.user_metadata?.full_name || u.user_metadata?.name || u.email };
    },
    async signIn(provider) {
      const redirectTo = location.origin + location.pathname + location.search + location.hash;
      const { error } = await sb.auth.signInWithOAuth({ provider, options: { redirectTo } });
      if (error) throw new ApiError('server', error.message);
    },
    async signInAnonymously(captchaToken) {
      let res;
      try {
        res = await sb.auth.signInAnonymously(captchaToken ? { options: { captchaToken } } : undefined);
      } catch (e) {
        throw new ApiError('network', String(e));
      }
      if (res.error) {
        const msg = String(res.error.message || '');
        throw new ApiError(/captcha/i.test(msg) ? 'captcha' : /rate|too many/i.test(msg) ? 'rate_limited' : 'server', msg);
      }
      return { id: res.data.user.id, anonymous: true };
    },
    async signOut() {
      await sb.auth.signOut();
    },
    onChange(cb) {
      sb.auth.onAuthStateChange((event) => cb(event));
    },
  },

  me: () => rpc('get_me'),
  setHandle: (handle) => rpc('set_handle', { p_handle: handle }),
  listPapers: () => rpc('list_papers'),
  paperInfo: (paperId) => rpc('get_paper_info', { p_paper: paperId }),
  startAttempt: (paperId, practice = false, name = null, pin = null) =>
    rpc('start_attempt', { p_paper: paperId, p_practice: practice, p_name: name, p_pin: pin }),
  saveProgress: (attemptId, token, seq, responses) =>
    rpc('save_progress', { p_attempt: attemptId, p_token: token, p_seq: seq, p_responses: responses }),
  submitAttempt: (attemptId, token, seq, responses) =>
    rpc('submit_attempt', { p_attempt: attemptId, p_token: token, p_seq: seq, p_responses: responses }),
  reportViolation: (attemptId, token, kind) =>
    rpc('report_violation', { p_attempt: attemptId, p_token: token, p_kind: kind }).catch(() => null),
  result: (paperId, practice = false, name = null, pin = null) =>
    rpc('get_my_result', { p_paper: paperId, p_practice: practice, p_name: name, p_pin: pin }),
  leaderboard: (paperId, offset = 0, limit = 50) =>
    rpc('get_leaderboard', { p_paper: paperId, p_offset: offset, p_limit: limit }),
  overall: (limit = 100) => rpc('get_overall_leaderboard', { p_limit: limit }),
  imageUrl: (path) => (path ? `${CONFIG.SUPABASE_URL}/storage/v1/object/public/qimg/${path}` : null),

  staff: {
    overview: () => rpc('staff_paper_overview').then((d) => d.papers),
    directory: () => rpc('staff_directory').then((d) => d.staff),
    history: (paperId, questionId = null) =>
      rpc('staff_history', { p_paper: paperId, p_question: questionId, p_limit: 200 }).then((d) => d.rows),
    getPaper: (id) => table(sb.from('papers').select('*').eq('id', id).maybeSingle()),
    createPaper: (fields) => table(sb.from('papers').insert(fields).select().single()),
    updatePaper: (id, version, fields) => versionedUpdate('papers', id, version, fields),
    questions: (paperId) => table(sb.from('questions').select('*').eq('paper_id', paperId)),
    getQuestion: (id) => table(sb.from('questions').select('*').eq('id', id).maybeSingle()),
    updateQuestion: (id, version, fields) => versionedUpdate('questions', id, version, fields),
    async uploadImage(paperId, blob, ext) {
      const path = `${paperId}/${crypto.randomUUID()}.${ext}`;
      await table(sb.storage.from('qimg').upload(path, blob, { contentType: blob.type, cacheControl: '31536000', upsert: false }));
      return path;
    },
    publish: (id) => rpc('admin_publish_paper', { p_paper: id }),
    unpublish: (id) => rpc('admin_unpublish_paper', { p_paper: id }),
    archive: (id, archived) => rpc('admin_archive_paper', { p_paper: id, p_archived: archived }),
    remove: (id) => rpc('admin_delete_paper', { p_paper: id }),
    rescore: (id) => rpc('admin_rescore_paper', { p_paper: id }),
    flush: (id) => rpc('admin_flush_paper', { p_paper: id }),
    monitor: (id, filter = 'all', offset = 0, limit = 200) =>
      rpc('admin_monitor', { p_paper: id, p_filter: filter, p_offset: offset, p_limit: limit }),
    extend: (attemptId, minutes) => rpc('admin_extend_attempt', { p_attempt: attemptId, p_minutes: minutes }),
    resetAttempt: (attemptId) => rpc('admin_reset_attempt', { p_attempt: attemptId }),
    resetPin: (attemptId) => rpc('admin_reset_pin', { p_attempt: attemptId }),
    banAttempt: (attemptId, banned) => rpc('admin_ban_attempt', { p_attempt: attemptId, p_banned: banned }),
    banName: (name, banned) => rpc('admin_ban_name', { p_name: name, p_banned: banned }),
    listBanned: () => rpc('admin_list_banned').then((d) => d.names),
    listStaff: () => rpc('admin_list_staff').then((d) => d.staff),
    setStaff: (email, role) => rpc('admin_set_staff', { p_email: email, p_role: role }),

    // Live collaboration: row changes (RLS-filtered to staff) + presence.
    async subscribe(paperId, me, { onQuestion, onPaper, onPresence, onStatus } = {}) {
      await sb.realtime.setAuth();
      let state = { user_id: me.id, name: me.name, slot: null, at: Date.now() };
      const ch = sb.channel(`paper:${paperId}`, { config: { private: true, presence: { key: me.id } } });
      ch.on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'questions', filter: `paper_id=eq.${paperId}` },
        (p) => onQuestion?.(p.new))
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'papers', filter: `id=eq.${paperId}` },
          (p) => onPaper?.(p.new))
        .on('presence', { event: 'sync' }, () => onPresence?.(flattenPresence(ch.presenceState())))
        .subscribe((status) => {
          onStatus?.(status);
          if (status === 'SUBSCRIBED') ch.track(state);
        });
      return {
        track(patch) {
          state = { ...state, ...patch, at: Date.now() };
          ch.track(state);
        },
        close() {
          sb.removeChannel(ch);
        },
      };
    },
  },
};
