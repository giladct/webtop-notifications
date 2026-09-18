// Wraps the daily Task Scheduler job: scrape Webtop first, and only send the
// email digest if that run actually succeeded (exit code 0) — a session
// expiry or scrape error (exit 2/1) should never push a stale/broken digest.
const { spawnSync } = require('child_process');
const path = require('path');

const run = (file) => spawnSync(process.execPath, [path.join(__dirname, file)], { stdio: 'inherit' });

const scrape = run('check-notifications.js');
if (scrape.status === 0) {
  run('send-email.js');
} else {
  console.error(`Skipping email send — check-notifications.js exited with code ${scrape.status}`);
}
process.exit(scrape.status ?? 1);
