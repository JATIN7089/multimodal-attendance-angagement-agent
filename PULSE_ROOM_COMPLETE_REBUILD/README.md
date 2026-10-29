# PULSE//ROOM — Classroom Intelligence Prototype

A Flask-based classroom dashboard prototype with an opening page, account registration/sign-in, protected workspace pages, a local browser face-detection layer, session metrics, polls, teaching moments and report exports.

## Run locally

Requirements: Python 3.10+.

```bash
python -m venv .venv
# Windows PowerShell
.venv\Scripts\Activate.ps1
# macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

Open `http://127.0.0.1:5050`. This rebuild deliberately uses port **5050** so it does not silently show an older copy already running on port 5000. The `/` route always displays the public landing page; use **Get started** to create an account, then navigate to the workspace. There is no shared default password. The user database is stored in `pulse_users.db` beside `app.py` by default. Set `PULSE_DB_PATH` to use another database path and set `SECRET_KEY` to a long random secret before deploying.

## Start the correct build on Windows

1. Stop any older server terminal with `Ctrl+C`.
2. Extract this ZIP into a new folder named `PULSE_ROOM_COMPLETE_REBUILD` (do not merge it into the old project folder).
3. Double-click `run_windows.bat`, or run the commands below from this folder.
4. Open `http://127.0.0.1:5050` (not the old `:5000` address).

## Pages

- `/` — landing / product introduction
- `/signup`, `/login`, `/logout` — account access
- `/dashboard` — overview dashboard
- `/live` — live camera room
- `/attendance` — searchable roster and CSV/JSON exports
- `/insights` — session indicators and trend summary
- `/moments` — session event timeline
- `/reports` — report downloads
- `/settings` — saved workspace preferences

## Important prototype limitations

- User accounts use SQLite and Werkzeug password hashing. This is a local prototype, not production-ready identity infrastructure; add CSRF protection, rate limiting, secure deployment settings, and a proper user/session model before public deployment.
- Session/roster data is seeded demo data and shared by this single-process prototype; it is not yet isolated per account or persisted as real attendance records.
- Camera frames are processed in the browser and are not uploaded to Flask. Face detection is not identity recognition and does not automatically prove attendance.
- Engagement/participation values are demo signals and must not be treated as validated psychological measurements or official student records.
