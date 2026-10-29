// About page: the text lives in about.html; this adds the header, footer and donate button.
import { CONFIG } from './config.js';
import { $, h, mountHeader, footer } from './ui.js';

const main = $('#about');
await mountHeader('about');
document.title = `About · ${CONFIG.SITE_NAME}`;

$('[data-cost]', main).textContent = CONFIG.HOSTING_COST;
if (CONFIG.DONATE_URL) {
  const row = $('[data-donate-row]', main);
  row.append(h('a', { class: 'btn btn-primary', href: CONFIG.DONATE_URL, target: '_blank', rel: 'noopener' }, CONFIG.DONATE_LABEL));
  row.hidden = false;
}

document.body.append(main);   // keep it below the header
main.hidden = false;
footer();
