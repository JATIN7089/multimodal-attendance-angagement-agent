# Added platform features

- Landing page with product overview, workflow, feature cards and privacy explanation.
- Signup and sign-in pages with server-side validation, password hashing, unique email constraint and session login.
- Logout action and protected dashboard, live room, attendance, insights, moments, reports and settings routes.
- Attendance page with searchable student roster and CSV/JSON exports.
- Insights page with session metrics, trend bars and explicit demo-data limitations.
- Moments page with event timeline.
- Reports page with direct exports.
- Settings page with preferences saved in SQLite per account.
- Navigation updated to use real routes rather than placeholder toast messages.
- Session API endpoints now require authentication.

## Still demo-only

Roster/session metrics are seeded and shared by the current prototype rather than tenant-isolated or stored as authoritative attendance. Camera face detection detects faces; it does not identify named students. Production deployment needs CSRF protection, rate limiting, secure cookies/HTTPS, per-user session data, audit logging and a proper identity/liveness design.
