// Picks the real backend when Supabase is configured, otherwise the demo.
import { CONFIG } from './config.js';

export const DEMO = !CONFIG.SUPABASE_URL;
const mod = DEMO ? await import('./backend-demo.js') : await import('./backend-supabase.js');
export const api = mod.api;
