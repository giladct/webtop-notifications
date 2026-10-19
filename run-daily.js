// Wraps the daily Task Scheduler job (16:00): scrape Webtop first, and only if
// that run succeeded (exit code 0) send the email digest and publish the site to
// GitHub Pages — a session expiry or scrape error (exit 2/1) should never push a
// stale/broken digest or overwrite the live pages.
const { spawnSync } = require('child_process');
const path = require('path');

const run = (file) => spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });
const git = (...args) => spawnSync('git', args, { cwd: __dirname, stdio: 'inherit' });

// Commits only the generated pages (never .env / session.json, which are gitignored anyway)
// and pushes; a day with no new data produces no diff and therefore no commit.
function publish() {
  git('add', '--', '*.html', 'digests/*.html');
  const staged = spawnSync('git', ['diff', '--cached', '--quiet'], { cwd: __dirname });
  if (staged.status === 0) {
    console.log('Nothing changed on the site — skipping publish.');
    return;
  }
  const today = new Date().toISOString().slice(0, 10);
  git('commit', '-q', '-m', `Daily update ${today}`);
  git('push');
}

let scrape = run('check-notifications.js');

// Exit 2 = the Webtop session expired (its token only lasts ~9 hours and login needs a
// CAPTCHA). Open the login window so whoever is at the PC can solve it (login-setup.js
// waits up to 8 minutes), then retry the scrape once. If nobody logs in, fall through
// to the skip branch below and the live site stays as it was.
if (scrape.status === 2) {
  console.error('Session expired — opening the login window.');
  const login = run('login-setup.js');
  if (login.status === 0) scrape = run('check-notifications.js');
}

if (scrape.status === 0) {
  run('send-email.js');
  publish();
} else {
  console.error(`Skipping email send and publish — check-notifications.js exited with code ${scrape.status}`);
}
process.exit(scrape.status ?? 1);
