const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const SESSION_PATH = path.join(DIR, 'session.json');
const SUMMARY_TXT = path.join(DIR, 'notifications-summary.txt');
const PAGE_ALL = path.join(DIR, 'notifications-14days.html');
const PAGE_MSG_INBOX = path.join(DIR, 'messages-inbox.html');
const PAGE_INDEX = path.join(DIR, 'index.html');
const PAGE_DIGEST = path.join(DIR, 'digest.html');
const PAGE_DIGEST_HISTORY = path.join(DIR, 'digest-history.html');
const DIGESTS_DIR = path.join(DIR, 'digests');
const DIGEST_TXT = path.join(DIGESTS_DIR, 'daily-digest.txt');
const WINDOW_DAYS = 14;
const UNKNOWN_CHILD = 'לא ברור למי';

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

// ---- Family Digest intelligence layer ----
// Classifies notifications/messages into parent-facing categories (chips),
// extracts an event date/time when the text has one (for calendar buttons),
// and groups everything per child. Nothing here invents information — it only
// reclassifies and dates text that was already scraped from Webtop.
const CATEGORY_META = {
  action:   { icon: '🔴', label: 'צריך לעשות',  color: '#d64545' },
  bring:    { icon: '🎒', label: 'להביא',        color: '#3fa15e' },
  payment:  { icon: '💰', label: 'תשלום',        color: '#c98a1c' },
  test:     { icon: '🧪', label: 'מבחן',         color: '#8a4fd6' },
  homework: { icon: '📝', label: 'שיעורי בית',   color: '#2f8fd6' },
  school:   { icon: '📚', label: 'בית ספר',      color: '#2f6fed' },
  event:    { icon: '📅', label: 'אירוע',        color: '#e0913f' },
  update:   { icon: '📢', label: 'עדכון',        color: '#7a7f8a' },
};

// Order matters — checked top to bottom, first match wins (e.g. a form that
// mentions both a signature AND a fee is filed as a payment, the stronger ask).
const CATEGORY_RULES = [
  { key: 'payment', re: /(לשלם|תשלום|עלות|₪)/ },
  { key: 'action', re: /(לחתום|חתימה|יש לאשר|נדרש אישור|למלא\s*טופס|נא\s*למלא)/ },
  { key: 'bring', re: /(יש\s*להביא|נא\s*להביא|יש\s*להצטייד|להביא)/ },
  { key: 'test', re: /(מבחן|בוחן)/ },
  { key: 'homework', re: /(שיעורי[\s-]?בית|אי הכנ|עודכנו עבורך שיעורי-בית)/ },
  { key: 'event', re: /(טיול|מסיבה|טקס|יום\s*הורים|יום\s*ספורט|יום\s*גיבוש|חגיג|נשף|אירוע)/ },
  { key: 'update', re: /(בוטל|התבטל|מבוטל|נדחה|נדחית|שינוי\s*בשעות|שינוי\s*במערכת|ציון|מילה טובה|הפרע|חיסור|איחור)/ },
];

function classifyItemCategory(text) {
  for (const { key, re } of CATEGORY_RULES) {
    if (re.test(text)) return key;
  }
  return null;
}

// Section grouping + order for the full Today's Digest page.
const DIGEST_SECTIONS = [
  { key: 'need', label: 'צריך לעשות', icon: '🔴', categories: ['action', 'payment'] },
  { key: 'bring', label: 'להביא', icon: '🎒', categories: ['bring'] },
  { key: 'school', label: 'בית ספר', icon: '📚', categories: ['homework', 'test', 'school'] },
  { key: 'upcoming', label: 'בקרוב', icon: '📅', categories: ['event'] },
  { key: 'update', label: 'כדאי לדעת', icon: '📢', categories: ['update'] },
];

// Condensed grouping for the Home Dashboard child cards (4 fixed rows).
const HOME_SECTIONS = [
  { key: 'need', label: 'דרוש טיפול', icon: '🔴', categories: ['action', 'payment', 'bring'] },
  { key: 'school', label: 'שיעורי בית ומבחנים', icon: '📚', categories: ['homework', 'test', 'school'] },
  { key: 'upcoming', label: 'אירועים קרובים', icon: '📅', categories: ['event'] },
  { key: 'update', label: 'עדכונים חשובים', icon: '📢', categories: ['update'] },
];

// Categories worth a calendar entry. 'update' (grades, disruptions, absences,
// cancellations) is deliberately excluded even when a date happens to parse out
// of its text — that date is usually just when the event happened, not
// something to add to a calendar. 'homework'/'school' are excluded too, to
// avoid cluttering the calendar with routine postings.
const CALENDAR_CATEGORIES = ['event', 'test', 'bring', 'action', 'payment'];

const CHILD_META = {
  'אלה': { icon: '👧', color: '#e0577f' },
  'איתן': { icon: '👦', color: '#2f8fd6' },
  'עלמה': { icon: '👧', color: '#8a4fd6' },
};
function childMeta(name) {
  return CHILD_META[name] || { icon: '🧒', color: '#7a7f8a' };
}

const WEEKDAYS_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

function nextWeekday(fromDate, targetDow) {
  const d = new Date(fromDate);
  d.setHours(0, 0, 0, 0);
  let diff = (targetDow - d.getDay() + 7) % 7;
  if (diff === 0) diff = 7;
  d.setDate(d.getDate() + diff);
  return d;
}

// Best-effort date/time extraction from free Hebrew text: an explicit dd/mm(/yyyy),
// מחר/היום, or a named weekday ("ביום שלישי"). Consistent with the rest of this
// script's regex-based Hebrew parsing rather than true NLP.
function extractEventDateTime(text, refDate) {
  const ref = refDate || new Date();
  let date = null;

  const dm = text.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (dm) {
    const dd = parseInt(dm[1], 10), mm = parseInt(dm[2], 10);
    let yyyy = dm[3] ? parseInt(dm[3], 10) : ref.getFullYear();
    if (yyyy < 100) yyyy += 2000;
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      const candidate = new Date(yyyy, mm - 1, dd);
      if (!isNaN(candidate)) date = candidate;
    }
  }
  if (!date && /מחר/.test(text)) {
    date = new Date(ref);
    date.setDate(date.getDate() + 1);
  }
  if (!date && /\bהיום\b/.test(text)) {
    date = new Date(ref);
  }
  if (!date) {
    const wm = text.match(/יום\s*(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)/);
    if (wm) {
      const idx = WEEKDAYS_HE.indexOf(wm[1]);
      if (idx >= 0) date = nextWeekday(ref, idx);
    }
  }

  let time = null;
  const tm = text.match(/(\d{1,2}):(\d{2})\b/);
  if (tm) {
    const hh = parseInt(tm[1], 10), min = parseInt(tm[2], 10);
    if (hh <= 23 && min <= 59) time = `${String(hh).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }

  if (date) {
    if (time) {
      const [hh, min] = time.split(':').map(Number);
      date.setHours(hh, min, 0, 0);
    } else {
      date.setHours(0, 0, 0, 0);
    }
  }
  return { date, time };
}

function isToday(d) {
  if (!d) return false;
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

function formatDateDisplay(d) {
  if (!d) return null;
  return d.toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });
}

// A school-wide message doesn't name a specific child, but if only one of the
// several children covered by that school appears by name in the text, it's
// clearly meant for that child alone rather than all of them.
function attributeMessageChildren(msg, candidateChildren) {
  if (candidateChildren.length <= 1) return candidateChildren;
  const text = `${msg.subject} ${msg.body || ''}`;
  const named = candidateChildren.filter(name => text.includes(name));
  return named.length ? named : candidateChildren;
}

function buildItemFromNotification(row, refDate) {
  const category = classifyItemCategory(row.content);
  if (!category) return null;
  const subcategory = extractSubcategory(row.content);
  const subject = extractSubject(row.content);
  const title = subcategory !== 'אחר' ? subcategory : (subject || 'עדכון');
  const { date, time } = extractEventDateTime(row.content, refDate);
  return {
    category,
    title,
    detail: row.content,
    date, time,
    dateDisplay: formatDateDisplay(date),
    source: { type: 'notification', date: row.date, category: row.category, content: row.content },
  };
}

function buildItemFromMessage(msg, refDate) {
  const combined = `${msg.subject} ${msg.summary || msg.body || ''}`;
  let category = classifyItemCategory(combined);
  if (!category) {
    if (isRoutineMessage(msg.subject)) return null;
    category = 'school';
  }
  const { date, time } = extractEventDateTime(combined, refDate);
  return {
    category,
    title: msg.subject,
    detail: msg.summary || msg.subject,
    date, time,
    dateDisplay: formatDateDisplay(date),
    source: { type: 'message', date: msg.date, sender: msg.sender, subject: msg.subject, body: msg.body },
  };
}

function itemKey(item) {
  return `${item.category}|${item.title}|${item.detail}`;
}

function pushItem(byChild, child, item) {
  if (!byChild[child]) byChild[child] = [];
  const list = byChild[child];
  const existing = list.find(i => itemKey(i) === itemKey(item));
  if (existing) existing.count = (existing.count || 1) + 1;
  else list.push({ ...item, count: 1 });
}

// Today's items only (arrival date == today) — powers both the Home Dashboard
// condensed cards and the full Today's Digest screen.
function buildTodayItems(children, messageSources) {
  const byChild = {};
  const childOrder = children.map(c => c.name);

  for (const { name, rows } of children) {
    for (const r of rows) {
      const d = parseRowDate(r.date);
      if (!isToday(d)) continue;
      const item = buildItemFromNotification(r, d);
      if (item) pushItem(byChild, name, item);
    }
  }

  for (const { children: candidateChildren, messages } of messageSources) {
    for (const m of messages) {
      const d = parseMsgDate(m.date);
      if (!isToday(d)) continue;
      const item = buildItemFromMessage(m, d);
      if (!item) continue;
      const targets = attributeMessageChildren(m, candidateChildren.length ? candidateChildren : [UNKNOWN_CHILD]);
      for (const child of targets) pushItem(byChild, child, item);
    }
  }

  const allChildren = [...new Set([...childOrder, ...Object.keys(byChild)])];
  return allChildren
    .map(name => ({ name, items: byChild[name] || [] }))
    .filter(c => c.name !== UNKNOWN_CHILD || c.items.length > 0);
}

// All currently-open dated items across the full notification window — powers
// per-item "Add to Calendar" buttons and the "Add All Upcoming Events" file,
// independent of when the notification/message arrived (unlike buildTodayItems).
function buildUpcomingEvents(children, messageSources) {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const byChild = {};
  const childOrder = children.map(c => c.name);

  for (const { name, rows } of children) {
    for (const r of withinWindow(rows, WINDOW_DAYS)) {
      const item = buildItemFromNotification(r, r._d);
      if (!item || !item.date || item.date < startOfToday || !CALENDAR_CATEGORIES.includes(item.category)) continue;
      pushItem(byChild, name, item);
    }
  }

  for (const { children: candidateChildren, messages } of messageSources) {
    for (const m of messages) {
      const d = parseMsgDate(m.date);
      if (!d || d < cutoff) continue;
      const item = buildItemFromMessage(m, d);
      if (!item || !item.date || item.date < startOfToday || !CALENDAR_CATEGORIES.includes(item.category)) continue;
      const targets = attributeMessageChildren(m, candidateChildren.length ? candidateChildren : [UNKNOWN_CHILD]);
      for (const child of targets) pushItem(byChild, child, item);
    }
  }

  const allChildren = [...new Set([...childOrder, ...Object.keys(byChild)])];
  const flat = [];
  for (const name of allChildren) {
    for (const item of (byChild[name] || [])) flat.push({ ...item, child: name });
  }
  flat.sort((a, b) => a.date - b.date);
  return flat;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }

function googleCalendarUrl(item, child) {
  const title = `${child} – ${item.title}`;
  let dates;
  if (item.time) {
    const start = item.date;
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    dates = `${start.getFullYear()}${pad2(start.getMonth() + 1)}${pad2(start.getDate())}T${pad2(start.getHours())}${pad2(start.getMinutes())}00/`
      + `${end.getFullYear()}${pad2(end.getMonth() + 1)}${pad2(end.getDate())}T${pad2(end.getHours())}${pad2(end.getMinutes())}00`;
  } else {
    const start = item.date;
    const end = addDays(start, 1);
    dates = `${start.getFullYear()}${pad2(start.getMonth() + 1)}${pad2(start.getDate())}/${end.getFullYear()}${pad2(end.getMonth() + 1)}${pad2(end.getDate())}`;
  }
  const params = new URLSearchParams({ action: 'TEMPLATE', text: title, dates, details: item.detail });
  return `https://www.google.com/calendar/render?${params.toString()}`;
}

function icsEscape(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
}

// A stable UID (hashed from child+category+title+date) means re-downloading the
// same day's "add all" file and importing it again updates the existing calendar
// entry in apps that dedupe by UID, instead of creating a second copy.
function stableUid(item) {
  const raw = `${item.child}|${item.category}|${item.title}|${item.date.toISOString().slice(0, 10)}`;
  let hash = 0;
  for (let i = 0; i < raw.length; i++) hash = (hash * 31 + raw.charCodeAt(i)) | 0;
  return `webtop-${Math.abs(hash)}@family-school-hq`;
}

function buildIcsForEvents(events) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//School HQ//Webtop Digest//HE'];
  for (const item of events) {
    const start = item.date;
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${stableUid(item)}`);
    lines.push(`SUMMARY:${icsEscape(`${item.child} – ${item.title}`)}`);
    if (item.time) {
      const end = new Date(start.getTime() + 60 * 60 * 1000);
      lines.push(`DTSTART:${start.getFullYear()}${pad2(start.getMonth() + 1)}${pad2(start.getDate())}T${pad2(start.getHours())}${pad2(start.getMinutes())}00`);
      lines.push(`DTEND:${end.getFullYear()}${pad2(end.getMonth() + 1)}${pad2(end.getDate())}T${pad2(end.getHours())}${pad2(end.getMinutes())}00`);
    } else {
      const end = addDays(start, 1);
      lines.push(`DTSTART;VALUE=DATE:${start.getFullYear()}${pad2(start.getMonth() + 1)}${pad2(start.getDate())}`);
      lines.push(`DTEND;VALUE=DATE:${end.getFullYear()}${pad2(end.getMonth() + 1)}${pad2(end.getDate())}`);
    }
    lines.push(`DESCRIPTION:${icsEscape(item.detail)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function itemWhatsAppText(child, item) {
  const meta = CATEGORY_META[item.category];
  const dateStr = item.dateDisplay ? ` ${item.dateDisplay}${item.time ? ' ' + item.time : ''}` : '';
  return `${child} – ${item.title} ${meta.icon}${dateStr}\n${item.detail}`;
}

function todayDigestWhatsAppText(todayChildren) {
  const todayDisplay = new Date().toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric' });
  const lines = [`📚 סיכום משפחתי – ${todayDisplay}`];
  for (const { name, items } of todayChildren) {
    lines.push('');
    lines.push(`${childMeta(name).icon} ${name}`);
    if (!items.length) { lines.push('הכל תקין היום ✨'); continue; }
    for (const { label, icon, categories } of DIGEST_SECTIONS) {
      const list = items.filter(i => categories.includes(i.category));
      if (!list.length) continue;
      lines.push(`${icon} ${label}`);
      for (const i of list) lines.push(`• ${i.title}${i.count > 1 ? ` (×${i.count})` : ''}`);
    }
  }
  return lines.join('\n');
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

function htmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

const NAV_PAGES = [
  { file: 'index.html', label: '🎒 School HQ' },
  { file: 'digest.html', label: '✨ סיכום היום' },
  { file: 'notifications-14days.html', label: 'כל ההתראות', secondary: true },
  { file: 'messages-inbox.html', label: 'הודעות נכנסות', secondary: true },
];

function pageShell(title, activeFile, bodyHtml) {
  const now = new Date();
  const nav = NAV_PAGES.map(p => `
    <a class="nav-link${p.secondary ? ' secondary' : ''}${p.file === activeFile ? ' active' : ''}" href="${p.file}">${htmlEscape(p.label)}</a>
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
  .nav-link.secondary { opacity: 0.65; font-size: 12px; }
  header { margin-bottom: 20px; text-align: center; }
  header h1 { font-size: 22px; margin: 0 0 4px; }
  header p { color: var(--sub-text); margin: 0; font-size: 14px; }
  .card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: 18px;
    padding: 20px;
    margin-bottom: 20px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.05);
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
  .cat-cell { width: 90px; max-width: 90px; }
  .subject-cell { max-width: 90px; color: var(--sub-text); font-size: 13px; }
  .cat-badge {
    display: inline-block;
    max-width: 100%;
    box-sizing: border-box;
    font-size: 12px;
    padding: 2px 8px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--c) 15%, transparent);
    color: var(--c);
    white-space: normal;
    overflow-wrap: break-word;
    word-break: break-word;
    line-height: 1.3;
  }
  @media (max-width: 640px) {
    .cat-cell { width: 64px; max-width: 64px; }
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
  .digest-original {
    white-space: pre-wrap;
    font-size: 13px;
    color: var(--sub-text);
    margin: 8px 0 0;
    padding-top: 8px;
    border-top: 1px dashed var(--border);
  }
  .gen-btn, .cal-all-btn, .wa-all-btn {
    display: inline-block;
    font-size: 13px;
    font-weight: 600;
    padding: 9px 18px;
    border-radius: 999px;
    border: 1px solid var(--accent);
    background: var(--accent);
    color: #fff;
    cursor: pointer;
    text-decoration: none;
  }
  .cal-all-btn, .wa-all-btn { background: var(--card-bg); color: var(--text); border-color: var(--border); }
  .gen-btn:disabled { opacity: 0.6; cursor: default; }
  .history-list { display: flex; flex-wrap: wrap; gap: 8px; }
  .history-list a {
    font-size: 13px;
    padding: 6px 12px;
    border-radius: 8px;
    border: 1px solid var(--border);
    background: var(--card-bg);
    color: var(--text);
    text-decoration: none;
  }

  /* ---- School HQ home dashboard ---- */
  .today-banner { text-align: center; }
  .today-banner h2 { margin: 0 0 2px; font-size: 20px; }
  .child-cards-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
    gap: 14px;
    margin-bottom: 20px;
  }
  .child-card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-top: 4px solid var(--child-c, var(--accent));
    border-radius: 18px;
    padding: 16px;
    box-shadow: 0 1px 3px rgba(0,0,0,0.05);
  }
  .child-card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
  .child-avatar {
    width: 40px; height: 40px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 20px; flex-shrink: 0;
    background: color-mix(in srgb, var(--child-c, var(--accent)) 18%, transparent);
  }
  .child-card-head h3 { margin: 0; font-size: 17px; }
  .home-section { margin-bottom: 10px; }
  .home-section:last-child { margin-bottom: 0; }
  .home-section h4 { margin: 0 0 4px; font-size: 12px; color: var(--sub-text); }
  .home-item-list { margin: 0; padding-inline-start: 18px; font-size: 13px; line-height: 1.5; }
  .more-link { font-size: 12px; color: var(--accent); text-decoration: none; }
  .all-clear { color: var(--sub-text); font-size: 14px; margin: 0; }

  /* ---- Today's Digest ---- */
  .digest-toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
  .child-digest { border-top: 4px solid var(--child-c, var(--accent)); }
  .child-digest h3 { margin: 0 0 12px; font-size: 18px; }
  .digest-section { margin-bottom: 14px; }
  .digest-section:last-child { margin-bottom: 0; }
  .digest-section h4 { margin: 0 0 8px; font-size: 13px; color: var(--sub-text); }
  .item-card {
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 12px 14px;
    margin-bottom: 8px;
  }
  .item-card:last-child { margin-bottom: 0; }
  .item-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 6px; }
  .chip {
    font-size: 12px;
    padding: 3px 10px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--c) 18%, transparent);
    color: var(--c);
    font-weight: 600;
    white-space: nowrap;
  }
  .item-date { font-size: 12px; color: var(--sub-text); white-space: nowrap; }
  .item-title { font-weight: 600; font-size: 15px; margin-bottom: 2px; }
  .item-detail { font-size: 13px; color: var(--sub-text); margin: 2px 0 8px; }
  .item-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .btn-mini {
    font-size: 12px;
    padding: 6px 12px;
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--card-bg);
    color: var(--text);
    text-decoration: none;
    white-space: nowrap;
  }
  .original-toggle { margin-top: 8px; font-size: 12px; }
  .original-toggle summary { cursor: pointer; color: var(--sub-text); list-style: none; }
  .original-toggle summary::-webkit-details-marker { display: none; }
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

    (function () {
      var btn = document.getElementById('gen-digest-btn');
      if (!btn) return;
      btn.addEventListener('click', function () {
        btn.disabled = true;
        var original = btn.textContent;
        btn.textContent = 'מייצר סיכום… (עד דקה)';
        fetch('/api/generate-digest', { method: 'POST' })
          .then(function (res) { if (!res.ok) throw new Error('failed'); return res.json(); })
          .then(function () { window.location.href = 'digest.html'; })
          .catch(function () {
            btn.textContent = 'זמין רק כשמריצים node server.js מקומית';
            setTimeout(function () { btn.textContent = original; btn.disabled = false; }, 3000);
          });
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
        <thead><tr><th>Date</th><th>Child</th><th>Topic</th><th>Subject</th><th>Notification</th></tr></thead>
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

function digestOriginalHtml(source) {
  if (source.type === 'notification') {
    return `<div class="digest-original">[${htmlEscape(source.category)}] ${htmlEscape(source.date)}<br>${htmlEscape(source.content)}</div>`;
  }
  return `<div class="digest-original">${htmlEscape(source.sender)} · ${htmlEscape(source.date)}<br><strong>${htmlEscape(source.subject)}</strong><br>${htmlEscape(source.body || 'אין תוכן זמין.')}</div>`;
}

// A single item card: chip + title + detail, an "Add to Calendar" link when a
// date was detected, a "WhatsApp" link with a pre-filled message, and a
// collapsed "View original" toggle showing the raw Webtop text it came from.
function renderItemCard(item, child) {
  const meta = CATEGORY_META[item.category];
  const waHref = `https://wa.me/?text=${encodeURIComponent(itemWhatsAppText(child, item))}`;
  const calBtn = item.date && CALENDAR_CATEGORIES.includes(item.category)
    ? `<a class="btn-mini" href="${googleCalendarUrl(item, child)}" target="_blank" rel="noopener">📅 הוסף ליומן</a>` : '';
  const detailHtml = item.detail && item.detail !== item.title ? `<p class="item-detail">${htmlEscape(item.detail)}</p>` : '';
  return `
    <div class="item-card">
      <div class="item-head">
        <span class="chip" style="--c:${meta.color}">${meta.icon} ${htmlEscape(meta.label)}</span>
        ${item.dateDisplay ? `<span class="item-date">${htmlEscape(item.dateDisplay)}${item.time ? ' · ' + htmlEscape(item.time) : ''}</span>` : ''}
        ${item.count > 1 ? `<span class="item-date">×${item.count}</span>` : ''}
      </div>
      <div class="item-title">${htmlEscape(item.title)}</div>
      ${detailHtml}
      <div class="item-actions">
        ${calBtn}
        <a class="btn-mini" href="${waHref}" target="_blank" rel="noopener">💬 וואטסאפ</a>
      </div>
      <details class="original-toggle"><summary>הצג מקור</summary>${digestOriginalHtml(item.source)}</details>
    </div>
  `;
}

function homeSectionItems(items, categories) {
  return items.filter(i => categories.includes(i.category));
}

// "School HQ" — the main entry point. Three colorful child cards condensed to
// four rows each (need-to-do / school / upcoming / updates), each capped at two
// visible lines with a "+N more" link into the full Today's Digest.
function generateHomePage(todayChildren) {
  const todayDisplay = new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });

  const cards = todayChildren.map(({ name, items }) => {
    const meta = childMeta(name);
    const sectionsHtml = HOME_SECTIONS.map(({ label, icon, categories }) => {
      const list = homeSectionItems(items, categories);
      if (!list.length) return '';
      const shown = list.slice(0, 2);
      const more = list.length - shown.length;
      const lines = shown.map(i => `<li>${htmlEscape(i.title)}${i.count > 1 ? ` (×${i.count})` : ''}</li>`).join('');
      return `
        <div class="home-section">
          <h4>${icon} ${htmlEscape(label)}</h4>
          <ul class="home-item-list">${lines}</ul>
          ${more > 0 ? `<a class="more-link" href="digest.html">+${more} נוספים</a>` : ''}
        </div>
      `;
    }).join('');
    return `
      <div class="child-card" style="--child-c:${meta.color}">
        <div class="child-card-head">
          <span class="child-avatar">${meta.icon}</span>
          <h3>${htmlEscape(name)}</h3>
        </div>
        ${items.length ? sectionsHtml : '<p class="all-clear">הכל תקין היום ✨</p>'}
      </div>
    `;
  }).join('');

  const body = `
    <section class="today-banner card">
      <h2>היום</h2>
      <p class="sub">${htmlEscape(todayDisplay)}</p>
    </section>
    <div class="child-cards-grid">${cards}</div>
    <section class="card" style="text-align:center;">
      <a class="gen-btn" href="digest.html">✨ סיכום היום המלא</a>
    </section>
  `;
  return pageShell('🎒 School HQ', 'index.html', body);
}

// "Today's Digest" — the full, verifiable version of the home cards, with
// calendar/WhatsApp actions per item plus bulk actions for the whole day.
function generateDigestPage(todayChildren, upcomingEvents) {
  const todayDisplay = new Date().toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'long' });

  const childSections = todayChildren.map(({ name, items }) => {
    const meta = childMeta(name);
    const sectionsHtml = DIGEST_SECTIONS.map(({ key, label, icon, categories }) => {
      const list = items.filter(i => categories.includes(i.category));
      if (!list.length) return '';
      return `<div class="digest-section ${key}"><h4>${icon} ${htmlEscape(label)}</h4>${list.map(i => renderItemCard(i, name)).join('')}</div>`;
    }).join('');
    return `
      <section class="card child-digest" style="--child-c:${meta.color}">
        <h3>${meta.icon} ${htmlEscape(name)}</h3>
        ${items.length ? sectionsHtml : '<p class="all-clear">הכל תקין היום ✨</p>'}
      </section>
    `;
  }).join('');

  const icsHref = upcomingEvents.length
    ? `data:text/calendar;charset=utf-8,${encodeURIComponent(buildIcsForEvents(upcomingEvents))}`
    : null;
  const waFullHref = `https://wa.me/?text=${encodeURIComponent(todayDigestWhatsAppText(todayChildren))}`;

  const body = `
    <section class="card digest-toolbar">
      <button class="gen-btn" id="gen-digest-btn">צור סיכום להיום</button>
      ${icsHref ? `<a class="cal-all-btn" download="family-events.ics" href="${icsHref}">📅 הוסף את כל האירועים הקרובים (${upcomingEvents.length})</a>` : ''}
      <a class="wa-all-btn" href="${waFullHref}" target="_blank" rel="noopener">💬 שתף את סיכום היום</a>
      <a class="nav-link" href="digest-history.html">היסטוריית סיכומים ←</a>
    </section>
    ${childSections}
  `;
  return pageShell(`✨ סיכום היום – ${todayDisplay}`, 'digest.html', body);
}

function generateDigestHistoryPage(historyEntries) {
  const links = historyEntries.map(({ date, dateDisplay }) => `<a href="digests/digest-${date}.html">${htmlEscape(dateDisplay)}</a>`).join('');
  const body = `
    <section class="card">
      <h3>היסטוריית סיכומים</h3>
      ${historyEntries.length ? `<div class="history-list">${links}</div>` : '<p class="empty">אין עדיין סיכומים שמורים.</p>'}
    </section>
  `;
  return pageShell('היסטוריית סיכומים יומיים', '', body);
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

  if (!fs.existsSync(DIGESTS_DIR)) fs.mkdirSync(DIGESTS_DIR);

  const todayChildren = buildTodayItems(htmlChildren, messageSources);
  const upcomingEvents = buildUpcomingEvents(htmlChildren, messageSources);
  const todayDate = new Date().toISOString().slice(0, 10);

  fs.writeFileSync(
    path.join(DIGESTS_DIR, `digest-${todayDate}.json`),
    JSON.stringify({ date: todayDate, dateDisplay: new Date().toLocaleDateString('he-IL'), children: todayChildren }, null, 2),
    { encoding: 'utf8' }
  );
  fs.writeFileSync(path.join(DIGESTS_DIR, `digest-${todayDate}.html`), generateDigestPage(todayChildren, upcomingEvents), { encoding: 'utf8' });
  fs.writeFileSync(DIGEST_TXT, todayDigestWhatsAppText(todayChildren), { encoding: 'utf8' });

  const historyEntries = fs.readdirSync(DIGESTS_DIR)
    .filter(f => /^digest-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map(f => {
      const date = f.match(/\d{4}-\d{2}-\d{2}/)[0];
      let dateDisplay = date;
      try { dateDisplay = JSON.parse(fs.readFileSync(path.join(DIGESTS_DIR, f), 'utf8')).dateDisplay; } catch (e) {}
      return { date, dateDisplay };
    })
    .sort((a, b) => b.date.localeCompare(a.date));

  fs.writeFileSync(SUMMARY_TXT, summaryLines.join('\n'), { encoding: 'utf8' });
  fs.writeFileSync(PAGE_ALL, generateAllNotificationsPage(htmlChildren), { encoding: 'utf8' });
  fs.writeFileSync(PAGE_MSG_INBOX, generateMessagesInboxPage(messageSources), { encoding: 'utf8' });
  fs.writeFileSync(PAGE_DIGEST, generateDigestPage(todayChildren, upcomingEvents), { encoding: 'utf8' });
  fs.writeFileSync(PAGE_DIGEST_HISTORY, generateDigestHistoryPage(historyEntries), { encoding: 'utf8' });
  fs.writeFileSync(PAGE_INDEX, generateHomePage(todayChildren), { encoding: 'utf8' });

  console.log(`Wrote ${SUMMARY_TXT}, ${PAGE_ALL}, ${PAGE_MSG_INBOX}, ${PAGE_DIGEST}, ${PAGE_DIGEST_HISTORY}, ${PAGE_INDEX}`);
  if (anySessionExpired) process.exit(2);
})().catch(e => {
  fs.writeFileSync(SUMMARY_TXT, `[${new Date().toISOString()}] ERROR: ${e.message}\n`);
  console.error('ERROR:', e.message);
  process.exit(1);
});
