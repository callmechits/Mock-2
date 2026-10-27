// ─────────────────────────────────────────────────────────────────────────────
//  Site configuration — the only file you need to edit before deploying.
//
//  SUPABASE_URL / SUPABASE_KEY come from Supabase → Project Settings → API.
//  Use the "publishable" (or legacy "anon") key. Both values are PUBLIC by
//  design: every rule is enforced inside the database, not in this code.
//  NEVER put the service_role / secret key here.
//
//  Leave SUPABASE_URL empty to run the built-in offline demo (data stays in
//  your browser) — handy for trying the UI before you set anything up.
// ─────────────────────────────────────────────────────────────────────────────
export const CONFIG = {
  SITE_NAME: 'JEE Mains Mock',
  TAGLINE: 'Full-length JEE Main mocks in a real CBT-style interface.',

  SUPABASE_URL: 'https://kslzkbuymqkcolbpmvay.supabase.co',
  SUPABASE_KEY: 'sb_publishable_R520lh-4aV7OaX6CbTxaHQ_Mt3faJIZ',

  // Students never create accounts: they type their Reddit username + PIN on
  // the exam page (Supabase anonymous sign-in). These are for STAFF only —
  // enable the same ones in Supabase → Authentication → Sign In / Providers.
  STAFF_AUTH_PROVIDERS: ['google'],

  // Optional but recommended: Cloudflare Turnstile site key. When set, students
  // solve an invisible bot check before their anonymous session is created.
  // Also enable CAPTCHA (Turnstile) in Supabase → Authentication → Attack Protection.
  TURNSTILE_SITE_KEY: '0x4AAAAAAFoLNCtf5cABSiIo',

  // 'letters' shows options as A B C D, 'numbers' as 1 2 3 4 (NTA style).
  OPTION_STYLE: 'letters',

  // Optional link in the header, e.g. your subreddit or Discord server.
  COMMUNITY_URL: '',
  COMMUNITY_LABEL: '',
};
