# Attendance Tracker (Render-ready)

## Features
- Paste student names separated by commas in the Names box.
- The name column stays frozen on the left while you scroll horizontally.
- Red means absent / not marked; green means present.
- Click a cell to toggle attendance.
- Add date columns and edit date labels.
- Export the table as `attendance.csv`.

## Run locally
```bash
npm install
npm start
```
Then open http://localhost:3000.

## Deploy to Render
1. Upload this folder to a GitHub repository.
2. In Render, choose **New + → Web Service** and connect the repository.
3. Build command: `npm install`
4. Start command: `npm start`
5. Deploy.

The app currently keeps attendance in the browser session; export CSV to save a copy. It does not use a database.
