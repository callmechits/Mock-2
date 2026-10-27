// Every backend failure is an ApiError with a short machine code.
// `network` means the request never got a reply — always safe to retry.
export class ApiError extends Error {
  constructor(code, detail) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

export const MESSAGES = {
  network: 'Can’t reach the server. Check your connection — we’ll keep retrying.',
  server: 'The server had a problem. Please try again in a moment.',
  forbidden: 'You don’t have permission to do that.',
  not_authenticated: 'Please sign in first.',
  session_expired: 'Your session expired. Please sign in again.',
  banned: 'This username has been banned by the organisers.',
  name_required: 'Enter your Reddit username.',
  name_invalid: 'That isn’t a valid Reddit username (3–20 letters, numbers, _ or -).',
  name_not_found: 'No attempt with that username on this paper.',
  pin_invalid: 'The PIN must be 4–8 digits.',
  pin_wrong: 'Wrong PIN for that username.',
  pin_locked: 'Too many wrong PINs. This username is locked for 15 minutes.',
  session_has_attempt: 'This browser already took this paper under another username.',
  captcha: 'The bot check failed. Please try again.',
  rate_limited: 'Too many sign-ins from your network right now. Wait a minute and try again.',
  results_not_ready: 'Results aren’t published yet.',
  flushed: 'Personal data for this paper has been deleted, so individual results are no longer available.',
  handle_required: 'Choose a username first.',
  handle_invalid: 'Usernames are 3–20 characters: letters, numbers and _ only.',
  handle_reserved: 'That username is reserved.',
  handle_taken: 'That username is taken.',
  handle_cooldown: 'You can change your username once every 7 days.',
  paper_not_found: 'This paper doesn’t exist or isn’t available.',
  not_started: 'This paper hasn’t started yet.',
  entry_closed: 'The entry window for this paper has closed.',
  already_submitted: 'You have already submitted this paper.',
  practice_unavailable: 'Practice mode opens after official results are published.',
  attempt_not_found: 'Attempt not found.',
  attempt_in_progress: 'You have a practice attempt in progress.',
  superseded: 'This exam was opened in another tab or device.',
  closed: 'Time is over for this attempt.',
  invalid: 'Invalid request.',
  invalid_state: 'That isn’t possible in the paper’s current state.',
  incomplete: 'Some questions are incomplete.',
  ends_in_past: 'The end time is in the past.',
  has_attempts: 'Students have already taken this paper — archive it instead.',
  last_admin: 'You can’t remove the last admin.',
  user_not_found: 'No account with that email. They must sign in once first.',
  paper_locked: 'This paper is published — only admins can change it now.',
  admin_only: 'Only admins can do that.',
  conflict: 'Someone else saved a newer version.',
};

export const message = (e) => MESSAGES[e?.code] || e?.message || MESSAGES.server;
