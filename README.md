# English Exam Demo (Vanilla JS + HTML + Node/Express)

This is a minimal, working demo of:
- Exam runner (Vanilla HTML/CSS/JS)
- Admin panel (create session links, view results)
- Link generator (token based)
- Results storage + grading (SQLite for local dev)
- Camera presence check without recording (pings only)

## Run locally
1) Install Node.js 18+
2) In this folder:
   - npm install
   - npm start
3) Open:
   - Exam entry: https://english4sp.netlify.app/
   - Admin panel: https://english4sp.netlify.app/admin.html

Admin login (demo):
- user: admin
- pass: admin

## Notes
- DB is SQLite for the demo. It is straightforward to swap to Azure SQL later by replacing db access.
- Listening rule: the audio can be played once.


## Admin accounts (seeded on first run)

These accounts are created automatically if the `admins` table is empty.

- admin1 / R4f@il2026
- admin2 / BananaBlade!26
- admin3 / OutrageInk#26
- admin4 / AthensExam$26
- admin5 / DoubleZ%26

Change them in DB (admins table) for production.
