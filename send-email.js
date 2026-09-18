// Emails the day's digest (written by check-notifications.js to
// digests/daily-digest.txt) via the Resend API (resend.com). Needs
// RESEND_API_KEY in .env. Sends from Resend's shared "onboarding@resend.dev"
// address, which needs no domain verification as long as EMAIL_TO is the same
// address you signed up to Resend with (their free-tier test-mode rule).
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const DIGEST_TXT = path.join(DIR, 'digests', 'daily-digest.txt');

function loadEnv() {
  const envPath = path.join(DIR, '.env');
  const out = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^=]+)=(.*)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

(async () => {
  if (!fs.existsSync(DIGEST_TXT)) {
    console.error(`No digest text found at ${DIGEST_TXT} — run check-notifications.js first.`);
    process.exit(1);
  }
  const text = fs.readFileSync(DIGEST_TXT, 'utf8').trim();
  if (!text) {
    console.error('Digest text is empty, nothing to send.');
    process.exit(1);
  }

  const env = loadEnv();
  if (!env.RESEND_API_KEY) {
    console.error('RESEND_API_KEY is not set in .env');
    process.exit(1);
  }
  if (!env.EMAIL_TO) {
    console.error('EMAIL_TO is not set in .env');
    process.exit(1);
  }

  const todayDisplay = new Date().toLocaleDateString('he-IL');
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'School HQ <onboarding@resend.dev>',
      to: [env.EMAIL_TO],
      subject: `📚 סיכום משפחתי – ${todayDisplay}`,
      text,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`Failed to send email: ${res.status} ${res.statusText} — ${body}`);
    process.exit(1);
  }
  console.log(`Sent today's digest to ${env.EMAIL_TO}`);
})();
