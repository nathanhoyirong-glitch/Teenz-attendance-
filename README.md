# Attendance app — Render deployment

## What changed from the standalone HTML file
- The board (names, sections, dates, who's present) now lives on the **server**
  (`/api/state`), not just in each visitor's browser. Anyone who opens the site
  can edit it and everyone else sees the change (next load / next 60s sync).
- `/api/responses` reads your Google Form's linked Sheet (published as CSV) and
  picks up names that submitted inside the most recent **Sunday 12:00–15:00**
  window (timezone and window are configurable, see below).

## 1. Get your Sheet's CSV link
1. Open the Google Sheet your Form writes to.
2. File → Share → **Publish to web**.
3. Choose the response sheet/tab, select **CSV**, click Publish.
4. Copy the generated URL (looks like
   `https://docs.google.com/spreadsheets/d/e/.../pub?output=csv`).

Your sheet needs at least a column with "Timestamp"/"Time" in its header and
one with "Name" in its header (Google Forms adds the Timestamp column
automatically). A "Section"/"Sec" column is read too, if present.

## 2. Deploy to Render
**Option A — Blueprint (easiest):** push this folder to a GitHub repo, then in
Render click **New → Blueprint**, pick the repo (it will read `render.yaml`).
Render will ask you to fill in `SHEET_CSV_URL` during setup.

**Option B — Manual:** New → Web Service → connect the repo →
- Build command: `npm install`
- Start command: `npm start`
- Add environment variable `SHEET_CSV_URL` = (the link from step 1)

## 3. Environment variables
| Variable | Default | Meaning |
|---|---|---|
| `SHEET_CSV_URL` | *(empty)* | Required for form sync. Published CSV link from step 1. |
| `TZ_OFFSET_HOURS` | `8` | Hours from UTC used to compute "Sunday" (8 = Singapore). |
| `WINDOW_START_HOUR` | `12` | Start of the sync window, local time. |
| `WINDOW_END_HOUR` | `15` | End of the sync window, local time. |

## Important limitation: free-plan storage is not permanent
The shared board is saved to a JSON file on disk (`data/state.json`). Render's
**free** plan gives the service an *ephemeral* disk — it's fine while the
service stays up, but a redeploy or a restart after the free service spins
down from inactivity will reset it to empty.

If you need it to survive restarts:
- Upgrade to a paid Render plan and attach a **persistent disk**, mounted at
  `/opt/render/project/src/data` (uncomment the `disk:` block you'd add to
  `render.yaml`), **or**
- Swap `loadState`/`saveState` in `server.js` for a small external store
  (e.g. a free tier of Upstash Redis, or a Google Sheet itself) — say the
  word and I can wire that up instead.

## Run locally
```
npm install
SHEET_CSV_URL="https://docs.google.com/spreadsheets/d/e/.../pub?output=csv" npm start
```
Then open http://localhost:3000
