const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  const out = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^=]+)=(.*)$/);
    if (m) out[m[1].trim()] = m[2].trim();
  }
  return out;
}

(async () => {
  const env = loadEnv();
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('https://webtop.smartschool.co.il', { waitUntil: 'networkidle', timeout: 30000 });

  // Accept cookies if the banner shows up
  try {
    await page.click('text=אשר cookies', { timeout: 3000 });
  } catch (e) {}

  // Pre-fill username/password so the user only needs to handle the CAPTCHA + submit
  const inputs = await page.$$('input');
  if (inputs.length >= 2) {
    await inputs[0].fill(env.WEBTOP_USER);
    await inputs[1].fill(env.WEBTOP_PASS);
  }

  console.log('Browser window opened. Please solve the CAPTCHA and click the login button (כניסה).');
  console.log('Waiting up to 8 minutes for login to complete...');

  // Wait until we're navigated away from the login page, taking periodic
  // screenshots so progress can be inspected even if it times out.
  const deadline = Date.now() + 8 * 60 * 1000;
  let loggedIn = false;
  let shot = 0;
  while (Date.now() < deadline) {
    const url = page.url();
    if (!new URL(url).pathname.startsWith('/account/login')) {
      loggedIn = true;
      break;
    }
    shot++;
    await page.screenshot({ path: `progress-${shot}.png` }).catch(() => {});
    console.log(`[${new Date().toISOString()}] still on login page (url: ${url})`);
    await page.waitForTimeout(15000);
  }

  if (!loggedIn) {
    console.error('Timed out waiting for login. Run this script again when ready.');
    await page.screenshot({ path: 'timeout-final.png' }).catch(() => {});
    await browser.close();
    process.exit(1);
  }

  await page.waitForLoadState('networkidle').catch(() => {});
  await page.screenshot({ path: 'after-login.png', fullPage: true });
  console.log('Logged in. Landing URL:', page.url());

  await context.storageState({ path: 'session.json' });
  console.log('Session saved to session.json');

  await browser.close();
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
