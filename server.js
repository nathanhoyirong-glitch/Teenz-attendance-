const express = require('express');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const SHEET_CSV_URL = process.env.SHEET_CSV_URL || '';
// Timezone offset (hours from UTC) used to figure out "Sunday 12:00-15:00".
// Default 8 = Singapore / Asia/Singapore.
const TZ_OFFSET_HOURS = parseFloat(process.env.TZ_OFFSET_HOURS || '8');
const WINDOW_START_HOUR = parseFloat(process.env.WINDOW_START_HOUR || '12');
const WINDOW_END_HOUR = parseFloat(process.env.WINDOW_END_HOUR || '15');

const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

app.use(express.json({ limit: '2mb' }));
// Serves files straight from the repo root (where index.html actually lands
// when uploaded one-by-one via GitHub's mobile "Add file" UI), instead of
// requiring a public/ subfolder that's easy to lose on mobile uploads.
app.use(express.static(__dirname));

/* ----------------------------------------------------------------
   Shared, editable app state (names / dates / attendance marks).
   No auth: anyone who can reach the site can read and overwrite it.
   NOTE: on Render's free plan the disk is ephemeral, so this file
   is wiped on redeploy / occasional restarts. Attach a persistent
   disk (paid plan) if you need this to survive restarts. See README.
------------------------------------------------------------------- */
function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return null;
  }
}

function saveState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state));
}

app.get('/api/state', (req, res) => {
  res.json({ state: loadState() });
});

app.post('/api/state', (req, res) => {
  const state = req.body && req.body.state;
  if (!state || !Array.isArray(state.dates)) {
    return res.status(400).json({ error: 'invalid state' });
  }
  saveState(state);
  res.json({ ok: true });
});

/* ----------------------------------------------------------------
   Google Form sync.
   Reads the Form's linked Sheet, published as CSV (SHEET_CSV_URL),
   and returns names that submitted inside the most recent
   Sunday WINDOW_START_HOUR:00-WINDOW_END_HOUR:00 window.
   Expects columns whose headers contain "timestamp"/"time" and
   "name" (a "section"/"sec" column is read too, but matching back
   to a roster is done by name on the client, so it's informational).
------------------------------------------------------------------- */
function csvParse(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else if (c === '\r') {
      // skip
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length && r.some(c => String(c).trim() !== ''));
}

function findCol(headers, candidates) {
  const low = headers.map(h => String(h).toLowerCase());
  for (const cand of candidates) {
    const idx = low.findIndex(h => h.includes(cand));
    if (idx > -1) return idx;
  }
  return -1;
}

function toLocal(d) {
  return new Date(d.getTime() + TZ_OFFSET_HOURS * 3600 * 1000);
}
function toUtc(localLike) {
  return new Date(localLike.getTime() - TZ_OFFSET_HOURS * 3600 * 1000);
}
function pad2(n) { return (n < 10 ? '0' : '') + n; }

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function dateLabelFromLocal(local) {
  return local.getUTCDate() + ' ' + MONTHS[local.getUTCMonth()];
}

// Where to start pulling history from. SYNC_START_DATE (e.g. "2026-01-01")
// overrides; otherwise defaults to Jan 1 of the current (local) year.
function syncRangeStart(now) {
  const envStart = process.env.SYNC_START_DATE;
  if (envStart) {
    const d = new Date(envStart + 'T00:00:00Z');
    if (!isNaN(d.getTime())) return d;
  }
  const local = toLocal(now);
  return toUtc(new Date(Date.UTC(local.getUTCFullYear(), 0, 1)));
}

let cache = { at: 0, payload: null };
const CACHE_MS = 55000;

app.get('/api/responses', async (req, res) => {
  if (!SHEET_CSV_URL) {
    return res.json({ configured: false });
  }
  const force = req.query.force === '1';
  const now = new Date();
  if (!force && cache.payload && (now.getTime() - cache.at) < CACHE_MS) {
    return res.json(cache.payload);
  }
  try {
    const r = await fetch(SHEET_CSV_URL, { cache: 'no-store' });
    if (!r.ok) throw new Error('Sheet fetch failed: HTTP ' + r.status);
    const text = await r.text();
    const rows = csvParse(text);
    if (!rows.length) throw new Error('Sheet is empty');

    const headers = rows[0];
    const tsCol = findCol(headers, ['timestamp', 'time']);
    const nameCol = findCol(headers, ['name']);
    const secCol = findCol(headers, ['section', 'sec']);
    if (tsCol === -1 || nameCol === -1) {
      throw new Error('Could not find a Timestamp and a Name column in the sheet');
    }

    const rangeStart = syncRangeStart(now);

    // Bucket every response into the Sunday session it belongs to (sec1-4
    // all land in the same bucket for that date; the client matches each
    // name back to whichever section's roster it belongs to).
    const buckets = {}; // 'YYYY-MM-DD' (local) -> { label, names: [], bySection: {} }
    let inWindow = 0;
    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      const raw = row[tsCol];
      if (!raw) continue;
      const t = new Date(raw);
      if (isNaN(t.getTime())) continue;
      if (t < rangeStart || t > now) continue;

      const local = toLocal(t);
      if (local.getUTCDay() !== 0) continue; // only Sunday submissions count as a session
      const hour = local.getUTCHours() + local.getUTCMinutes() / 60;
      if (hour < WINDOW_START_HOUR || hour >= WINDOW_END_HOUR) continue; // only the 12:00-15:00 window

      const key = local.getUTCFullYear() + '-' + pad2(local.getUTCMonth() + 1) + '-' + pad2(local.getUTCDate());
      if (!buckets[key]) buckets[key] = { label: dateLabelFromLocal(local), names: [], bySection: {} };
      const nm = (row[nameCol] || '').trim();
      const sec = secCol > -1 ? (row[secCol] || '').trim() : '';
      if (!nm) continue;
      if (buckets[key].names.indexOf(nm) === -1) buckets[key].names.push(nm);
      if (sec) {
        buckets[key].bySection[sec] = buckets[key].bySection[sec] || [];
        if (buckets[key].bySection[sec].indexOf(nm) === -1) buckets[key].bySection[sec].push(nm);
      }
      inWindow++;
    }

    // Oldest to newest, so they merge into the table left-to-right in order.
    const dates = Object.keys(buckets).sort().map(function (k) { return buckets[k]; });

    const payload = {
      configured: true,
      dates,
      inWindow,
      sessionCount: dates.length,
      rangeStart: rangeStart.toISOString().slice(0, 10),
      window: { start: WINDOW_START_HOUR, end: WINDOW_END_HOUR },
      stale: false
    };
    cache = { at: now.getTime(), payload };
    res.json(payload);
  } catch (err) {
    if (cache.payload) {
      res.json(Object.assign({}, cache.payload, { stale: true, error: String(err.message || err) }));
    } else {
      res.json({
        configured: true,
        dates: [],
        inWindow: 0,
        sessionCount: 0,
        window: { start: WINDOW_START_HOUR, end: WINDOW_END_HOUR },
        error: String(err.message || err)
      });
    }
  }
});

app.listen(PORT, () => console.log('attendance-app listening on :' + PORT));
