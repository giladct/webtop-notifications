const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const SESSION_PATH = path.join(DIR, 'session.json');
const SUMMARY_TXT = path.join(DIR, 'notifications-summary.txt');
const PAGE_ALL = path.join(DIR, 'notifications-14days.html');
const PAGE_MSG_INBOX = path.join(DIR, 'messages-inbox.html');
const PAGE_INDEX = path.join(DIR, 'index.html');
const WINDOW_DAYS = 14;

// Messages (תיבת הודעות) are shared per SCHOOL, not per child — Ramat Aviv's
// messages are identical whether איתן or עלמה is the selected student, and
// the Alterman school currently sends none at all.
const MESSAGE_SOURCES = [
  { key: 'alterman', parentMatch: 'הורה בתיכונט ע"ש אלתרמן', studentMatch: null, children: ['אלה'] },
  { key: 'ramat-aviv', parentMatch: 'הורה ברמת אביב', studentMatch: 'כהן-טל איתן', children: ['איתן', 'עלמה'] },
];

// Each target is a child. `parentMatch` selects the top-right parent/school profile.
// `studentMatch`, if present, additionally selects a child from the nested student
// switcher that appears when a parent profile has more than one linked child
// (e.g. the Ramat Aviv profile covers both איתן and עלמה as siblings).
const TARGETS = [
  { key: 'ella-alterman', displayName: 'אלה', parentMatch: 'הורה בתיכונט ע"ש אלתרמן', studentMatch: null },
  { key: 'eitan-ramat-aviv', displayName: 'איתן', parentMatch: 'הורה ברמת אביב', studentMatch: 'כהן-טל איתן' },
  { key: 'alma-ramat-aviv', displayName: 'עלמה', parentMatch: 'הורה ברמת אביב', studentMatch: 'כהן-טל עלמה' },
];

function rowKey(row) {
  return row.content + '|' + row.date;
}

function parseRowDate(dateStr) {
  const m = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})\s*\((\d{2}):(\d{2})\)/);
  if (!m) return null;
  const [, dd, mm, yyyy, hh, min] = m;
  return new Date(`${yyyy}-${mm}-${dd}T${hh}:${min}:00`);
}

async function clickTopProfileSwitcher(page) {
  const selects = await page.$$('mat-select');
  for (const s of selects) {
    const box = await s.boundingBox();
    if (box && box.y < 50) {
      await s.click({ timeout: 5000, force: true });
      return true;
    }
  }
  return false;
}

async function switchToTarget(page, target) {
  await page.goto('https://webtop.smartschool.co.il/dashboard', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(800);
  await clickTopProfileSwitcher(page);
  await page.waitForTimeout(800);
  await page.locator('mat-option', { hasText: target.parentMatch }).click({ timeout: 5000 });
  await page.waitForTimeout(1500);
  await page.waitForLoadState('networkidle').catch(() => {});

  if (target.studentMatch) {
    const selects = await page.$$('mat-select');
    const studentSelect = selects[selects.length - 1];
    const currentText = (await studentSelect.textContent()).trim();
    if (currentText !== target.studentMatch) {
      await studentSelect.click({ timeout: 5000, force: true });
      await page.waitForTimeout(800);
      await page.locator('mat-option', { hasText: target.studentMatch }).click({ timeout: 5000 });
      await page.waitForTimeout(1500);
      await page.waitForLoadState('networkidle').catch(() => {});
    }
  }
}

async function scrapeNotifications(page) {
  await page.goto('https://webtop.smartschool.co.il/notification', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);

  if (new URL(page.url()).pathname.startsWith('/account/login')) {
    return { sessionExpired: true, rows: [] };
  }

  const rawRows = await page.evaluate(() => {
    const rowEls = Array.from(document.querySelectorAll('.card-content-row'))
      .filter(el => !el.className.includes('table-row-title'));
    return rowEls.map(row => {
      const cols = Array.from(row.querySelectorAll(':scope > span, :scope > div'))
        .map(c => c.textContent.trim())
        .filter(Boolean);
      return cols;
    });
  });

  const rows = rawRows
    .filter(cols => cols.length >= 3)
    .map(cols => ({
      content: cols[0],
      date: cols[1].replace(/^מועד ההתראה:\s*/, ''),
      category: cols[2],
    }));

  return { sessionExpired: false, rows };
}

function parseMsgDate(dateStr) {
  const m = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!m) return null;
  const [, dd, mm, yyyy] = m;
  return new Date(`${yyyy}-${mm}-${dd}T00:00:00`);
}

// A club/activity flyer from the school office — routine, low priority but still openable.
function isRoutineMessage(subject) {
  return subject.includes('חוג');
}

// Extractive summary: takes the first 2-3 substantive lines of a message body,
// skipping short greeting lines and stopping at the sign-off. No LLM is available
// inside this unattended script, so this is a deterministic heuristic, not true
// summarization — good enough to tell whether the full message is worth opening.
function summarizeBody(body, maxLen = 260) {
  if (!body) return '';
  const GREETING_RE = /^(שלום|שלום רב|שלום לכולם|שלום לכל|היי|הי[ ,])/;
  const SIGNOFF_RE = /^(בברכה|בכבוד רב|בברכת|תודה|בתודה|בברכות)/;
  const lines = body.split('\n').map(l => l.trim()).filter(Boolean);

  const substantive = [];
  for (const line of lines) {
    if (SIGNOFF_RE.test(line)) break;
    if (GREETING_RE.test(line) && line.length < 40) continue;
    substantive.push(line);
    if (substantive.length >= 4) break;
  }

  let text = (substantive.join(' ') || lines.join(' '));
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  let summary = sentences.slice(0, 3).join(' ');
  if (!summary) summary = text;
  if (summary.length > maxLen) summary = summary.slice(0, maxLen).trim() + '…';
  return summary;
}

// Flags messages that likely need a parent's action: an explicit signature/approval
// request, or a deadline mention whose date hasn't passed yet (relative to today,
// not the message's send date — an old deadline that already passed isn't "needs
// attention" anymore, e.g. a July book-order cutoff seen in September).
function messageNeedsAttention(msg) {
  const body = msg.body || '';

  if (/חתימה|לחתום/.test(body)) {
    return { flagged: true, reason: 'דורש חתימה/אישור מכם' };
  }

  const m = body.match(/עד\s*(?:ל-?)?(?:תאריך\s*)?(\d{1,2})\/(\d{1,2})/);
  if (m) {
    const msgDate = parseMsgDate(msg.date);
    const year = msgDate ? msgDate.getFullYear() : new Date().getFullYear();
    const [, dd, mm] = m;
    const deadline = new Date(`${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}T23:59:59`);
    if (deadline >= new Date()) {
      return { flagged: true, reason: `דדליין: ${dd}/${mm}` };
    }
  }

  return { flagged: false, reason: null };
}

function parseMessageRowText(text) {
  const lines = text.split('\n').filter(Boolean);
  // Locate the date line rather than assuming a fixed row shape — a message's
  // rendered line count changes once it's read (the initials avatar line can
  // disappear), which would otherwise shift fixed indices.
  const dateIdx = lines.findIndex(l => /^\d{2}\/\d{2}\/\d{4}$/.test(l.trim()));
  if (dateIdx < 1) return null;
  const sender = lines[dateIdx - 1];
  const date = lines[dateIdx];
  const subject = lines.slice(dateIdx + 1).join(' ');
  return { sender, date, subject, key: `${sender}|${date}|${subject}` };
}

// A persistent info toast ("messages before 30/06 are under a filter...") sits
// fixed near the bottom of the viewport and intercepts clicks meant for whichever
// row happens to render underneath it. Dismiss it via its own close button (a
// real DOM click, not coordinates) so it can't swallow later row clicks.
async function dismissMessagesBanner(page) {
  await page.evaluate(() => {
    const hint = Array.from(document.querySelectorAll('*')).find(
      el => el.children.length === 0 && el.textContent.includes('ניתן לראות')
    );
    let el = hint;
    for (let i = 0; i < 6 && el; i++) {
      const closeBtn = el.querySelector && el.querySelector('button, .close, [class*="close"]');
      if (closeBtn) { closeBtn.click(); return; }
      el = el.parentElement;
    }
  });
  await page.waitForTimeout(300);
}

async function scrollMessageList(page) {
  await page.evaluate(() => {
    const scrollables = Array.from(document.querySelectorAll('*')).filter(el => {
      const s = getComputedStyle(el);
      return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 5;
    });
    scrollables.forEach(el => { el.scrollTop += el.clientHeight * 0.7; });
  });
  await page.waitForTimeout(500);
}

// Opening a message on this viewport replaces the whole list with a single-message
// detail view (a responsive breakpoint) rather than showing it alongside the list,
// so there's no "back" action to return to browsing. Two-phase approach instead:
// first collect every message's metadata via scroll-accumulation (no clicking, so
// the list stays intact throughout), then reload the list fresh for each message
// and scroll-search it back into view just to click it once and grab its body.
async function scrapeMessages(page) {
  await page.goto('https://webtop.smartschool.co.il/Messages', { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(1500);

  if (new URL(page.url()).pathname.startsWith('/account/login')) {
    return { sessionExpired: true, messages: [] };
  }

  const bodyText = await page.evaluate(() => document.body.innerText);
  if (bodyText.includes('לא נמצאו הודעות')) {
    return { sessionExpired: false, messages: [] };
  }

  await dismissMessagesBanner(page);

  // Phase 1: metadata only.
  const metaByKey = new Map();
  for (let step = 0; step < 8; step++) {
    const items = await page.$$('.message-item');
    for (const item of items) {
      const parsed = parseMessageRowText((await item.innerText()).trim());
      if (!parsed) continue;
      if (!metaByKey.has(parsed.key)) {
        metaByKey.set(parsed.key, { ...parsed, routine: isRoutineMessage(parsed.subject) });
      }
    }
    await scrollMessageList(page);
  }

  // Phase 2: one fresh list load per message, scroll-search for it, click, extract body.
  for (const meta of metaByKey.values()) {
    await page.goto('https://webtop.smartschool.co.il/Messages', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(1000);
    await dismissMessagesBanner(page);

    let clicked = false;
    for (let attempt = 0; attempt < 10 && !clicked; attempt++) {
      const items = await page.$$('.message-item');
      for (const item of items) {
        const parsed = parseMessageRowText((await item.innerText()).trim());
        if (!parsed || parsed.key !== meta.key) continue;
        // A non-forced click matters here: force:true skips Playwright's actionability
        // waits (visible, stable, not covered by another element), which was letting
        // clicks silently land wrong — e.g. on the fixed info banner overlapping a row,
        // or on a row mid-reflow from virtual scrolling.
        await item.click({ timeout: 8000 }).catch(() => {});
        for (let wait = 0; wait < 3; wait++) {
          await page.waitForTimeout(700);
          meta.body = await page.evaluate(() => {
            const el = document.querySelector('app-message-view, .message-view, .message-content, .messageBody');
            return el ? el.innerText.trim() : null;
          });
          if (meta.body) break;
        }
        meta.summary = summarizeBody(meta.body);
        clicked = true;
        break;
      }
      if (!clicked) await scrollMessageList(page);
    }
  }

  return { sessionExpired: false, messages: [...metaByKey.values()] };
}

// Classifies a notification into a meaning bucket, independent of its raw category label.
// 'routine' (plain homework/lesson updates) is left out of the "important" page.
function classifyImportance(row) {
  const c = row.content;
  if (c.includes('ציון')) return 'grade';
  if (c.includes('הפרע')) return 'concern';
  if (c.includes('חיסור')) return 'concern';
  if (c.includes('אי הבאת ציוד')) return 'concern';
  if (c.includes('אי הכנ')) return 'concern';
  if (c.includes('נרשם לך אחר')) return 'concern';
  if (c.includes('מילה טובה')) return 'praise';
  return 'routine';
}

// Pulls the subject/lesson name out of a notification's free-text content, e.g.
// "...בשיעור לשון והבעה בתאריך 15/09/2026..." -> "לשון והבעה". The Hebrew-only
// character class deliberately excludes parens/Latin text so it doesn't grab
// across unrelated "ב..." fragments earlier in the sentence (e.g. an English
// assignment name in parentheses before the real subject). Tries the literal
// "בשיעור" anchor first — homework-update notifications wrap a free-text quote
// (e.g. "...שמניים ב'\" בשיעור...") that itself contains a space-preceded "ב",
// which the looser fallback pattern would otherwise latch onto as a false start.
function extractSubject(content) {
  const CHARS = `[א-ת'"׳״\`\\-\\s]`;
  let m = content.match(new RegExp(`בשיעור\\s+(${CHARS}+?)\\s*בתאריך`));
  if (m) return m[1].trim();
  m = content.match(new RegExp(`(?:^|\\s)ב(${CHARS}+?)\\s*בתאריך`));
  return m ? m[1].trim() : null;
}

// A finer-grained label than the raw Webtop category — e.g. "אירועי שיעור" covers
// both a disruption and a positive remark, so this pulls out the actual event type.
function extractSubcategory(content) {
  if (content.includes('מילה טובה')) return 'מילה טובה';
  if (content.includes('הפרע')) return 'הפרעה';
  if (content.includes('אי הבאת ציוד')) return 'ציוד';
  if (content.includes('חיסור')) return 'חיסור';
  if (content.includes('איחור')) return 'איחור';
  if (content.includes('אי הכנ')) return 'אי הכנת שיעורי בית';
  if (content.includes('ציון')) return 'ציון';
  if (content.includes('עודכנו עבורך שיעורי-בית')) return 'עדכון שיעורי בית';
  return 'אחר';
}

const SUBCATEGORY_COLORS = {
  'מילה טובה': '#3fa15e',
  'הפרעה': '#d64545',
  'ציוד': '#d64545',
  'חיסור': '#d64545',
  'איחור': '#d64545',
  'אי הכנת שיעורי בית': '#d64545',
  'ציון': '#2f6fed',
  'עדכון שיעורי בית': '#7a7f8a',
};
function subcategoryColor(s) {
  return SUBCATEGORY_COLORS[s] || '#7a7f8a';
}

// Cross-cutting statistical insights: which subject/lesson draws the most concern
// events, which concern type repeats most, and how children compare to each other.
function generateInsights(children) {
  const insights = [];
  const totals = children.map(({ name, rows }) => {
    const windowRows = withinWindow(rows, WINDOW_DAYS);
    const concerns = windowRows.filter(r => classifyImportance(r) === 'concern');
    return { name, concerns };
  });

  const withConcerns = totals.filter(t => t.concerns.length > 0);
  if (withConcerns.length >= 2) {
    const sorted = [...withConcerns].sort((a, b) => b.concerns.length - a.concerns.length);
    if (sorted[0].concerns.length > sorted[1].concerns.length) {
      insights.push(`ל${sorted[0].name} יש הכי הרבה אירועי משמעת/הפרעות ב-${WINDOW_DAYS} הימים האחרונים (${sorted[0].concerns.length}), לעומת ${sorted.slice(1).map(t => `${t.name} (${t.concerns.length})`).join(', ')}.`);
    }
  }

  for (const { name, concerns } of totals) {
    if (concerns.length === 0) continue;

    const bySubject = {};
    const byType = {};
    for (const r of concerns) {
      const subj = extractSubject(r.content) || 'לא ידוע';
      bySubject[subj] = (bySubject[subj] || 0) + 1;
      const type = extractSubcategory(r.content);
      byType[type] = (byType[type] || 0) + 1;
    }

    const [topSubject, topSubjectCount] = Object.entries(bySubject).sort((a, b) => b[1] - a[1])[0];
    if (topSubjectCount >= 2) {
      insights.push(`אצל ${name}, שיעור ${topSubject} בולט עם הכי הרבה אירועים לתשומת לב (${topSubjectCount} מתוך ${concerns.length}).`);
    }

    const [topType, topTypeCount] = Object.entries(byType).sort((a, b) => b[1] - a[1])[0];
    if (topTypeCount >= 3) {
      insights.push(`אצל ${name}, "${topType}" חוזר על עצמו ${topTypeCount} פעמים ב-${WINDOW_DAYS} הימים האחרונים.`);
    }
  }

  return insights;
}

const CATEGORY_COLORS = {
  'ציונים שוטפים': '#2f6fed',
  'אירועי שיעור': '#e0913f',
  'נושאי שיעור ושיעורי-בית': '#3fa15e',
};
function categoryColor(cat) {
  return CATEGORY_COLORS[cat] || '#7a7f8a';
}
function htmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

const NAV_PAGES = [
  { file: 'notifications-14days.html', label: 'כל ההתראות (14 יום)' },
  { file: 'messages-inbox.html', label: 'הודעות נכנסות' },
];

function pageShell(title, activeFile, bodyHtml) {
  const now = new Date();
  const nav = NAV_PAGES.map(p => `
    <a class="nav-link${p.file === activeFile ? ' active' : ''}" href="${p.file}">${htmlEscape(p.label)}</a>
  `).join('');

  return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${htmlEscape(title)} — Webtop</title>
<style>
  :root {
    --bg: #f5f6f8;
    --card-bg: #ffffff;
    --text: #1c1e21;
    --sub-text: #6b7280;
    --border: #e5e7eb;
    --accent: #2f6fed;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #16181c;
      --card-bg: #1f2227;
      --text: #eaecef;
      --sub-text: #9aa0a8;
      --border: #2c2f36;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 20px 16px 60px;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
  }
  .wrap { max-width: 940px; margin: 0 auto; }
  nav.pagenav {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;
    margin-bottom: 20px;
  }
  .nav-link {
    font-size: 13px;
    padding: 6px 14px;
    border-radius: 999px;
    border: 1px solid var(--border);
    color: var(--sub-text);
    text-decoration: none;
    background: var(--card-bg);
  }
  .nav-link.active { color: #fff; background: var(--accent); border-color: var(--accent); }
  header { margin-bottom: 20px; text-align: center; }
  header h1 { font-size: 22px; margin: 0 0 4px; }
  header p { color: var(--sub-text); margin: 0; font-size: 14px; }
  .card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px;
    margin-bottom: 20px;
  }
  .card h2 { margin: 0 0 4px; font-size: 19px; }
  .card h3 { margin: 0 0 10px; font-size: 15px; }
  .sub { color: var(--sub-text); margin: 0 0 14px; font-size: 14px; }
  .pills { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
  .pill {
    font-size: 13px;
    padding: 4px 10px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--c) 15%, transparent);
    color: var(--c);
    border: 1px solid color-mix(in srgb, var(--c) 35%, transparent);
    white-space: nowrap;
  }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th, td { text-align: right; padding: 8px 10px; border-bottom: 1px solid var(--border); vertical-align: top; word-break: break-word; }
  th { color: var(--sub-text); font-weight: 600; font-size: 12px; text-transform: uppercase; }
  th.sortable { cursor: pointer; user-select: none; white-space: nowrap; }
  th.sortable:hover { color: var(--text); }
  th.sortable::after { content: ''; display: inline-block; width: 0.6em; opacity: 0.4; }
  th.sort-asc::after { content: '▲'; opacity: 1; font-size: 9px; }
  th.sort-desc::after { content: '▼'; opacity: 1; font-size: 9px; }
  .date-cell { white-space: normal; word-break: break-word; color: var(--sub-text); font-size: 13px; max-width: 80px; }
  .child-cell { white-space: nowrap; font-weight: 600; width: 1%; }
  .cat-cell { max-width: 90px; }
  .subject-cell { max-width: 90px; color: var(--sub-text); font-size: 13px; }
  .cat-badge {
    display: inline-block;
    font-size: 12px;
    padding: 2px 8px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--c) 15%, transparent);
    color: var(--c);
    white-space: normal;
    word-break: break-word;
    line-height: 1.3;
  }
  @media (max-width: 640px) {
    .cat-cell { max-width: 64px; }
    .subject-cell { max-width: 64px; }
    .date-cell { max-width: 60px; }
    table { font-size: 13px; }
    th, td { padding: 6px; }
  }
  .empty { color: var(--sub-text); font-size: 14px; }
  ul.insights { margin: 0; padding-inline-start: 20px; font-size: 14px; line-height: 1.7; }
  ul.insights li { margin-bottom: 4px; }
  .filters { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
  .filters select {
    font-size: 13px;
    padding: 6px 10px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--card-bg);
    color: var(--text);
  }
  .msg-item { border-bottom: 1px solid var(--border); padding: 14px 0; }
  .msg-item:last-child { border-bottom: none; }
  .msg-item.needs-attention { border-inline-start: 3px solid #d64545; padding-inline-start: 11px; margin-inline-start: -14px; }
  .attn-badge {
    font-size: 12px;
    padding: 2px 8px;
    border-radius: 6px;
    background: color-mix(in srgb, #d64545 15%, transparent);
    color: #d64545;
    white-space: nowrap;
  }
  .msg-item > summary { cursor: pointer; list-style: none; }
  .msg-item > summary::-webkit-details-marker { display: none; }
  .msg-item > summary::before {
    content: '▸';
    display: inline-block;
    margin-inline-end: 6px;
    color: var(--sub-text);
    transition: transform .15s;
  }
  .msg-item[open] > summary::before { transform: rotate(90deg); }
  .msg-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin-bottom: 6px; }
  .msg-subject { font-weight: 600; font-size: 15px; }
  .msg-meta { color: var(--sub-text); font-size: 13px; }
  .msg-summary { font-size: 14px; margin: 4px 0 0; }
  .msg-body {
    white-space: pre-wrap;
    font-size: 14px;
    line-height: 1.5;
    margin: 10px 0 0;
    padding-top: 10px;
    border-top: 1px dashed var(--border);
  }
</style>
</head>
<body>
  <div class="wrap">
    <nav class="pagenav">${nav}</nav>
    <header>
      <h1>${htmlEscape(title)}</h1>
      <p>Generated ${now.toLocaleString('en-GB')}</p>
    </header>
    ${bodyHtml}
  </div>
  <script>
    document.querySelectorAll('table').forEach(function (table) {
      var headRow = table.tHead ? table.tHead.rows[0] : table.rows[0];
      if (!headRow) return;
      Array.from(headRow.cells).forEach(function (th, colIndex) {
        th.classList.add('sortable');
        th.addEventListener('click', function () {
          var tbody = table.tBodies[0];
          if (!tbody) return;
          var rows = Array.from(tbody.rows);
          var newDir = th.classList.contains('sort-asc') ? 'desc' : 'asc';
          Array.from(headRow.cells).forEach(function (c) { c.classList.remove('sort-asc', 'sort-desc'); });
          th.classList.add(newDir === 'asc' ? 'sort-asc' : 'sort-desc');

          function getValue(row) {
            var cell = row.cells[colIndex];
            if (!cell) return '';
            if (cell.dataset.sort !== undefined) return cell.dataset.sort;
            return cell.textContent.trim();
          }

          rows.sort(function (a, b) {
            var va = getValue(a), vb = getValue(b);
            var na = Number(va), nb = Number(vb);
            var cmp;
            if (va !== '' && vb !== '' && !isNaN(na) && !isNaN(nb)) {
              cmp = na - nb;
            } else {
              cmp = va.localeCompare(vb, 'he');
            }
            return newDir === 'asc' ? cmp : -cmp;
          });

          rows.forEach(function (row) { tbody.appendChild(row); });
        });
      });
    });

    (function () {
      var childSel = document.getElementById('filter-child');
      var catSel = document.getElementById('filter-category');
      var subcatSel = document.getElementById('filter-subcategory');
      if (!childSel && !catSel && !subcatSel) return;

      function applyFilters() {
        var childVal = childSel ? childSel.value : '';
        var catVal = catSel ? catSel.value : '';
        var subcatVal = subcatSel ? subcatSel.value : '';
        document.querySelectorAll('tbody tr[data-child]').forEach(function (row) {
          var show = (!childVal || row.dataset.child === childVal) &&
                     (!catVal || row.dataset.category === catVal) &&
                     (!subcatVal || row.dataset.subcategory === subcatVal);
          row.style.display = show ? '' : 'none';
        });
      }

      [childSel, catSel, subcatSel].forEach(function (sel) {
        if (sel) sel.addEventListener('change', applyFilters);
      });
    })();
  </script>
</body>
</html>`;
}

function withinWindow(rows, days) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return rows
    .map(r => ({ ...r, _d: parseRowDate(r.date) }))
    .filter(r => r._d && r._d >= cutoff)
    .sort((a, b) => b._d - a._d);
}

function generateAllNotificationsPage(children) {
  const all = [];
  for (const { name, rows } of children) {
    for (const r of withinWindow(rows, WINDOW_DAYS)) {
      all.push({
        ...r,
        child: name,
        subject: extractSubject(r.content) || '—',
        subcategory: extractSubcategory(r.content),
      });
    }
  }
  all.sort((a, b) => b._d - a._d);

  const insights = generateInsights(children);
  const insightsSection = insights.length ? `
    <section class="card">
      <h3>תובנות סטטיסטיות</h3>
      <ul class="insights">
        ${insights.map(i => `<li>${htmlEscape(i)}</li>`).join('')}
      </ul>
    </section>
  ` : '';

  const uniqueChildren = children.map(c => c.name);
  const uniqueCategories = [...new Set(all.map(r => r.category))];
  const uniqueSubcategories = [...new Set(all.map(r => r.subcategory))];

  const optionsFor = list => list.map(v => `<option value="${htmlEscape(v)}">${htmlEscape(v)}</option>`).join('');

  const filters = `
    <div class="filters">
      <select id="filter-child"><option value="">כל הילדים</option>${optionsFor(uniqueChildren)}</select>
      <select id="filter-category"><option value="">כל הקטגוריות</option>${optionsFor(uniqueCategories)}</select>
      <select id="filter-subcategory"><option value="">כל תתי-הקטגוריות</option>${optionsFor(uniqueSubcategories)}</select>
    </div>
  `;

  const tableRows = all.map(r => `
    <tr data-child="${htmlEscape(r.child)}" data-category="${htmlEscape(r.category)}" data-subcategory="${htmlEscape(r.subcategory)}">
      <td class="date-cell" data-sort="${r._d ? r._d.getTime() : 0}">${htmlEscape(r.date)}</td>
      <td class="child-cell">${htmlEscape(r.child)}</td>
      <td class="cat-cell"><span class="cat-badge" style="--c:${categoryColor(r.category)}">${htmlEscape(r.category)}</span></td>
      <td class="cat-cell"><span class="cat-badge" style="--c:${subcategoryColor(r.subcategory)}">${htmlEscape(r.subcategory)}</span></td>
      <td class="subject-cell">${htmlEscape(r.subject)}</td>
      <td>${htmlEscape(r.content)}</td>
    </tr>
  `).join('');

  const body = `
    ${insightsSection}
    <section class="card">
      <p class="sub" dir="ltr">${all.length} notifications across all children in the last ${WINDOW_DAYS} days</p>
      ${filters}
      ${all.length ? `
      <table>
        <thead><tr><th>Date</th><th>Child</th><th>Category</th><th>Subcategory</th><th>Subject</th><th>Notification</th></tr></thead>
        <tbody>${tableRows}</tbody>
      </table>` : '<p class="empty">No notifications in this window.</p>'}
    </section>
  `;
  return pageShell('כל ההתראות ב-14 יום האחרונים', 'notifications-14days.html', body);
}

function generateMessagesInboxPage(sources) {
  const all = [];
  for (const { children, messages } of sources) {
    for (const m of messages) all.push({ ...m, children, _d: parseMsgDate(m.date) });
  }
  all.sort((a, b) => (b._d || 0) - (a._d || 0));

  const items = all.map(m => {
    const attn = messageNeedsAttention(m);
    return `
    <details class="msg-item${attn.flagged ? ' needs-attention' : ''}">
      <summary>
        <div class="msg-head">
          <span class="msg-subject">${htmlEscape(m.subject)}</span>
          ${attn.flagged ? `<span class="attn-badge">דורש תשומת לב — ${htmlEscape(attn.reason)}</span>` : ''}
          <span class="msg-meta" dir="ltr">${htmlEscape(m.date)}</span>
        </div>
        <div class="msg-meta">${htmlEscape(m.sender)} · ${htmlEscape(m.children.join(', '))}</div>
        ${m.summary ? `<p class="msg-summary">${htmlEscape(m.summary)}</p>` : ''}
      </summary>
      ${m.body ? `<p class="msg-body">${htmlEscape(m.body)}</p>` : '<p class="empty">אין תוכן זמין.</p>'}
    </details>
  `;
  }).join('');

  const attnCount = all.filter(m => messageNeedsAttention(m).flagged).length;

  const body = `
    <section class="card">
      <p class="sub" dir="ltr">${all.length} messages${attnCount ? `, ${attnCount} need attention` : ''} — click to open</p>
      ${all.length ? items : '<p class="empty">No messages found.</p>'}
    </section>
  `;
  return pageShell('הודעות נכנסות', 'messages-inbox.html', body);
}

function generateIndexPage() {
  const body = `
    <section class="card">
      <p class="sub">בחרו דף מהתפריט למעלה.</p>
    </section>
  `;
  return pageShell('סיכום התראות Webtop', '', body);
}

(async () => {
  if (!fs.existsSync(SESSION_PATH)) {
    fs.writeFileSync(SUMMARY_TXT, `[${new Date().toISOString()}] No saved session found. Run login-setup.js first.\n`);
    process.exit(2);
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ storageState: SESSION_PATH });
  const page = await context.newPage();

  const summaryLines = [];
  const htmlChildren = [];
  let anySessionExpired = false;

  for (const target of TARGETS) {
    await switchToTarget(page, target);
    const { sessionExpired, rows } = await scrapeNotifications(page);

    if (sessionExpired) {
      anySessionExpired = true;
      summaryLines.push(`[${target.key}] SESSION EXPIRED — could not reach notifications.`);
      continue;
    }

    const latestJson = path.join(DIR, `notifications-latest-${target.key}.json`);
    let previous = [];
    if (fs.existsSync(latestJson)) {
      try { previous = JSON.parse(fs.readFileSync(latestJson, 'utf8')); } catch (e) {}
    }
    const previousKeys = new Set(previous.map(rowKey));
    const newRows = rows.filter(r => !previousKeys.has(rowKey(r)));
    fs.writeFileSync(latestJson, JSON.stringify(rows, null, 2));

    const childName = target.displayName;

    summaryLines.push(`== ${childName} (${target.key}) ==`);
    summaryLines.push(`Total notifications on page: ${rows.length}`);
    if (!previous.length) {
      summaryLines.push(`(First run for this child — nothing to diff against yet.)`);
    } else if (newRows.length) {
      summaryLines.push(`NEW since last check (${newRows.length}):`);
      for (const r of newRows) summaryLines.push(`  [${r.category}] ${r.date} — ${r.content}`);
    } else {
      summaryLines.push('No new notifications since last check.');
    }
    summaryLines.push('');

    htmlChildren.push({ name: childName, rows });
  }

  const messageSources = [];
  for (const source of MESSAGE_SOURCES) {
    await switchToTarget(page, source);
    const { sessionExpired, messages } = await scrapeMessages(page);
    if (sessionExpired) {
      anySessionExpired = true;
      summaryLines.push(`[messages:${source.key}] SESSION EXPIRED — could not reach messages.`);
      continue;
    }
    messageSources.push({ children: source.children, messages });
  }

  await browser.close();

  fs.writeFileSync(SUMMARY_TXT, summaryLines.join('\n'), { encoding: 'utf8' });
  fs.writeFileSync(PAGE_ALL, generateAllNotificationsPage(htmlChildren), { encoding: 'utf8' });
  fs.writeFileSync(PAGE_MSG_INBOX, generateMessagesInboxPage(messageSources), { encoding: 'utf8' });
  fs.writeFileSync(PAGE_INDEX, generateIndexPage(), { encoding: 'utf8' });

  console.log(`Wrote ${SUMMARY_TXT}, ${PAGE_ALL}, ${PAGE_MSG_INBOX}, ${PAGE_INDEX}`);
  if (anySessionExpired) process.exit(2);
})().catch(e => {
  fs.writeFileSync(SUMMARY_TXT, `[${new Date().toISOString()}] ERROR: ${e.message}\n`);
  console.error('ERROR:', e.message);
  process.exit(1);
});
