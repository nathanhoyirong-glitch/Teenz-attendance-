// Attendance tracker server (zero dependencies, Node 18+).
//
// Reads your Google Form responses sheet (as CSV) and works out who was present:
// a response only counts if it was submitted on the configured weekday inside the
// configured time window (default: Sunday, 12:00 to 15:00).
//
// Environment variables (set these in Render > Environment):
//   SHEET_CSV_URL   required  CSV link of the Form's responses sheet
//   NAME_COLUMNS    optional  comma list of header words that mark name columns
//                             (default "present,newcomers": every column whose header contains one of them)
//   WINDOW_DAY      optional  0=Sunday ... 6=Saturday (default 0)
//   START_HOUR      optional  default 12
//   END_HOUR        optional  default 15 (a response at exactly 15:00 is outside)
//   TIMEZONE        optional  default Asia/Singapore (only used to pick how often to refresh)
//   DATE_ORDER      optional  DMY or MDY, only used if it can't be auto-detected (default DMY)
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SHEET_URL = process.env.SHEET_CSV_URL || '';
const NAME_COLS = (process.env.NAME_COLUMNS || process.env.NAME_COLUMN || 'present,newcomers')
  .toLowerCase().split(',').map(x => x.trim()).filter(Boolean);
const num = (v, d) => (v !== undefined && v !== '' && !isNaN(+v) ? +v : d);
const DAY = num(process.env.WINDOW_DAY, 0);
const START = num(process.env.START_HOUR, 12);
const END = num(process.env.END_HOUR, 15);
const TIMEZONE = process.env.TIMEZONE || 'Asia/Singapore';
const DEFAULT_ORDER = (process.env.DATE_ORDER || 'DMY').toUpperCase() === 'MDY' ? 'MDY' : 'DMY';
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ---------- CSV ----------
function parseCSV(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(x => x !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(x => x !== '')) rows.push(row);
  return rows;
}

// ---------- timestamps (wall-clock as shown in the sheet) ----------
function splitTs(str) {
  str = (str || '').trim();
  let m = str.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})/);
  if (m) return { iso: true, y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5] };
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4}),?\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?/i);
  if (!m) return null;
  let h = +m[4];
  if (m[6]) { const pm = m[6].toUpperCase() === 'PM'; if (pm && h < 12) h += 12; if (!pm && h === 12) h = 0; }
  return { iso: false, a: +m[1], b: +m[2], y: +m[3], h, mi: +m[5] };
}
function detectOrder(parsed) {
  for (const p of parsed) if (p && !p.iso) { if (p.a > 12) return 'DMY'; if (p.b > 12) return 'MDY'; }
  return DEFAULT_ORDER;
}

function nowParts() {
  try {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', hourCycle: 'h23' });
    const o = {}; f.formatToParts(new Date()).forEach(p => { o[p.type] = +p.value; });
    return { y: o.year, mo: o.month, d: o.day, h: o.hour };
  } catch (e) { const n = new Date(Date.now() + 8 * 3600000); return { y: n.getUTCFullYear(), mo: n.getUTCMonth() + 1, d: n.getUTCDate(), h: n.getUTCHours() }; }
}

function computeAttendance(rows) {
  if (rows.length < 2) return { totalRows: 0, inWindow: 0, dates: [] };
  const header = rows[0].map(h => h.trim().toLowerCase());
  let tsCol = header.findIndex(h => h.includes('timestamp')); if (tsCol < 0) tsCol = 0;
  // every column whose header matches one of NAME_COLS holds names (comma separated).
  // Your Form has one "present" column and one "newcomers" column per section, so there are several.
  let nameCols = header.map((h, i) => (i !== tsCol && NAME_COLS.some(w => h.includes(w))) ? i : -1).filter(i => i >= 0);
  if (!nameCols.length) nameCols = [tsCol === 0 ? 1 : 0];

  const body = rows.slice(1);
  const parsed = body.map(r => splitTs(r[tsCol]));
  const order = detectOrder(parsed);
  const byDate = {}; let inWindow = 0, minTs = null;

  body.forEach((r, i) => {
    const p = parsed[i];
    const names = [];
    nameCols.forEach(c => (r[c] || '').split(',').forEach(x => { x = x.trim().replace(/\s+/g, ' '); if (x) names.push(x); }));
    if (!p || !names.length) return;
    const y = p.y, mo = p.iso ? p.mo : (order === 'DMY' ? p.b : p.a), d = p.iso ? p.d : (order === 'DMY' ? p.a : p.b);
    if (mo < 1 || mo > 12) return;
    const dayTs = Date.UTC(y, mo - 1, d);
    if (minTs === null || dayTs < minTs) minTs = dayTs;   // earliest response of any kind
    const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
    const mins = p.h * 60 + p.mi;
    if (dow !== DAY || mins < START * 60 || mins >= END * 60) return;   // outside the Sunday window
    inWindow++;
    const key = y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
    const day = byDate[key] || (byDate[key] = { key, label: d + ' ' + MONTHS[mo - 1], names: [], seen: {} });
    names.forEach(name => {
      const n = name.toLowerCase();
      if (!day.seen[n]) { day.seen[n] = 1; day.names.push(name); }
    });
  });

  // Every session day (Sunday) from the first response up to now, even ones with no responses.
  // A day with no responses in the window comes back with names: [] and empty: true (the app shows it yellow).
  const keyOf = t => { const dt = new Date(t); return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0'); };
  const labelOf = t => { const dt = new Date(t); return dt.getUTCDate() + ' ' + MONTHS[dt.getUTCMonth()]; };
  const list = {};
  if (minTs !== null) {
    const now = nowParts(), todayTs = Date.UTC(now.y, now.mo - 1, now.d);
    let cur = minTs;
    while (new Date(cur).getUTCDay() !== DAY) cur += 86400000;
    for (let i = 0; i < 300 && cur <= todayTs; i++, cur += 7 * 86400000) {
      const k = keyOf(cur);
      // today's session day only counts as "empty" once the window has closed
      if (cur === todayTs && now.h < END && !byDate[k]) continue;
      list[k] = { key: k, label: labelOf(cur), names: byDate[k] ? byDate[k].names : [] };
    }
  }
  Object.keys(byDate).forEach(k => { if (!list[k]) list[k] = { key: k, label: byDate[k].label, names: byDate[k].names }; });
  const dates = Object.keys(list).sort().map(k => ({ ...list[k], empty: list[k].names.length === 0 }));
  return { totalRows: body.length, inWindow, dates };
}

// ---------- fetching + cache ----------
function nowInWindow() {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: TIMEZONE, weekday: 'short', hour: 'numeric', hourCycle: 'h23' }).formatToParts(new Date());
    const wd = parts.find(p => p.type === 'weekday').value;
    const hr = +parts.find(p => p.type === 'hour').value;
    return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(wd) === DAY && hr >= START && hr < END;
  } catch (e) { return false; }
}
let cache = { at: 0, data: null }, lastForce = 0;

async function getAttendance(force) {
  if (!SHEET_URL) return { configured: false };
  const ttl = nowInWindow() ? 60 * 1000 : 10 * 60 * 1000;     // refresh faster during the window
  const now = Date.now();
  if (force && now - lastForce > 15000) { lastForce = now; cache.at = 0; }
  if (cache.data && now - cache.at < ttl) return cache.data;
  try {
    const r = await fetch(SHEET_URL, { redirect: 'follow', signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw new Error('Google returned HTTP ' + r.status + ' (is the sheet shared as "Anyone with the link"?)');
    const text = await r.text();
    if (/^\s*<(!doctype|html)/i.test(text)) throw new Error('Got a web page instead of CSV (check sharing / the CSV link)');
    const out = computeAttendance(parseCSV(text));
    cache = { at: now, data: { configured: true, fetchedAt: new Date().toISOString(),
      window: { day: DAY, start: START, end: END }, ...out } };
    return cache.data;
  } catch (e) {
    if (cache.data) return { ...cache.data, stale: true, error: String(e.message || e) };
    return { configured: true, error: String(e.message || e), dates: [] };
  }
}

// ---------- http ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url || '/', 'http://x');
  const urlPath = decodeURIComponent(u.pathname);

  if (urlPath === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }

  if (urlPath === '/api/responses') {
    const data = await getAttendance(u.searchParams.get('force') === '1');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(data));
  }

  const requested = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Attendance tracker on port ' + PORT + (SHEET_URL ? ' (Google Form sync on)' : ' (no SHEET_CSV_URL set: sync off)'));
});
