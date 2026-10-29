"""ClassPulse AI — privacy-first classroom attendance and engagement demo."""
from __future__ import annotations

import csv
import io
import json
import os
import random
import threading
import sqlite3
import secrets
from functools import wraps
from werkzeug.security import generate_password_hash, check_password_hash
from flask import session, redirect, url_for, flash
from datetime import datetime, timezone

from flask import Flask, Response, jsonify, render_template, request

app = Flask(__name__)
app.config["JSON_SORT_KEYS"] = False
app.secret_key = os.environ.get("SECRET_KEY", "pulse-room-dev-key-change-me")
DB_PATH = os.environ.get("PULSE_DB_PATH", os.path.join(os.path.dirname(__file__), "pulse_users.db"))


def _db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def _init_db():
    with _db() as conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )""")
        conn.execute("""CREATE TABLE IF NOT EXISTS preferences (
            user_id INTEGER PRIMARY KEY,
            institution TEXT NOT NULL DEFAULT 'PULSE//ROOM Academy',
            default_room TEXT NOT NULL DEFAULT 'Room 204',
            notifications INTEGER NOT NULL DEFAULT 1,
            privacy_mode INTEGER NOT NULL DEFAULT 1,
            FOREIGN KEY(user_id) REFERENCES users(id)
        )""")


_init_db()


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("user_id"):
            if request.path.startswith("/api/"):
                return jsonify({"error": "authentication_required"}), 401
            return redirect(url_for("login", next=request.path))
        return view(*args, **kwargs)
    return wrapped


def current_user():
    if not session.get("user_id"):
        return None
    with _db() as conn:
        row = conn.execute("SELECT id, name, email FROM users WHERE id = ?", (session["user_id"],)).fetchone()
        return dict(row) if row else None

_LOCK = threading.Lock()
_RNG = random.Random(7089)

STUDENT_SEED = [
    ("Aanya Sharma", "AS", "present", 91, 8),
    ("Aarav Mehta", "AM", "present", 86, 6),
    ("Aditi Rao", "AR", "present", 82, 5),
    ("Aditya Singh", "AD", "late", 63, 2),
    ("Ananya Iyer", "AI", "present", 94, 9),
    ("Arjun Verma", "AV", "present", 76, 4),
    ("Diya Kapoor", "DK", "present", 88, 7),
    ("Ishaan Patel", "IP", "present", 72, 3),
    ("Kabir Nair", "KN", "absent", 0, 0),
    ("Kavya Joshi", "KJ", "present", 81, 5),
    ("Meera Das", "MD", "present", 93, 8),
    ("Neel Shah", "NS", "present", 69, 2),
    ("Nisha Gupta", "NG", "present", 78, 4),
    ("Pranav Bose", "PB", "present", 84, 6),
    ("Riya Jain", "RJ", "present", 87, 7),
    ("Rohan Kumar", "RK", "late", 58, 1),
    ("Saanvi Roy", "SR", "present", 90, 8),
    ("Samarth Kulkarni", "SK", "present", 75, 3),
    ("Sara Ali", "SA", "present", 85, 6),
    ("Shaurya Mishra", "SM", "present", 71, 3),
    ("Tanvi Reddy", "TR", "present", 92, 8),
    ("Vihaan Sethi", "VS", "present", 66, 2),
    ("Yash Malhotra", "YM", "absent", 0, 0),
    ("Zoya Khan", "ZK", "absent", 0, 0),
]


def _new_session() -> dict:
    now = datetime.now(timezone.utc)
    students = [
        {
            "id": i + 1,
            "name": name,
            "initials": initials,
            "status": status,
            "engagement": engagement,
            "interactions": interactions,
            "lastSeen": "Now" if status != "absent" else "—",
        }
        for i, (name, initials, status, engagement, interactions) in enumerate(STUDENT_SEED)
    ]
    values = [74, 76, 73, 79, 81, 78, 82, 77, 75, 80, 79, 78]
    return {
        "id": "DS-A-204",
        "title": "Data Science Fundamentals",
        "cohort": "Batch A",
        "room": "Room 204",
        "instructor": "Jatin",
        "startedAt": now.isoformat(),
        "elapsed": 46 * 60 + 18,
        "running": True,
        "mode": "Demo mode",
        "students": students,
        "timeline": [
            {"label": f"{9 + (i * 5 + 55) // 60}:{(i * 5 + 55) % 60:02d}", "value": value}
            for i, value in enumerate(values)
        ],
        "audioLevel": 36,
        "events": [
            {
                "id": 1,
                "time": "09:55",
                "type": "system",
                "title": "Session started",
                "detail": "Vision and audio signal layers initialized locally.",
            },
            {
                "id": 2,
                "time": "10:14",
                "type": "poll",
                "title": "Confidence pulse completed",
                "detail": "18 responses · 72% selected confident or very confident.",
            },
            {
                "id": 3,
                "time": "10:28",
                "type": "alert",
                "title": "Room momentum dipped",
                "detail": "Recovered after switching to an interactive example.",
            },
        ],
        "poll": {
            "active": False,
            "question": "",
            "options": [],
            "responses": 0,
            "startedAt": None,
        },
        "updatedAt": now.isoformat(),
    }


SESSION = _new_session()


def _summary(session: dict) -> dict:
    present_students = [s for s in session["students"] if s["status"] != "absent"]
    engaged = [s["engagement"] for s in present_students]
    engagement = round(sum(engaged) / max(len(engaged), 1))
    interactions = sum(s["interactions"] for s in present_students)
    # Eight meaningful interactions per learner is treated as full participation
    # for this demo session, keeping the score transparent and explainable.
    participation = min(100, round(100 * interactions / max(len(present_students) * 8, 1)))
    low = [s for s in present_students if s["engagement"] < 68]
    late = [s for s in present_students if s["status"] == "late"]
    return {
        "present": len(present_students),
        "total": len(session["students"]),
        "absent": len(session["students"]) - len(present_students),
        "late": len(late),
        "engagement": engagement,
        "participation": participation,
        "interactions": interactions,
        "lowAttention": len(low),
    }


def _suggestions(session: dict, summary: dict) -> list[dict]:
    suggestions = []
    if summary["engagement"] <= 82:
        suggestions.append(
            {
                "type": "action",
                "icon": "spark",
                "title": "Try a 2-minute knowledge check",
                "body": "Attention has softened over the last 8 minutes. A quick poll can re-engage the room.",
                "cta": "Start quick poll",
            }
        )
    if summary["lowAttention"]:
        suggestions.append(
            {
                "type": "insight",
                "icon": "trend",
                "title": f"{summary['lowAttention']} learners may need support",
                "body": "Low visual activity was sustained—not inferred from a single frame. Consider changing pace.",
                "cta": "View learners",
            }
        )
    suggestions.append(
        {
            "type": "positive",
            "icon": "check",
            "title": "Participation is evenly distributed",
            "body": f"{summary['participation']}% of present learners have contributed during this session.",
            "cta": "See participation",
        }
    )
    return suggestions[:3]


def _payload() -> dict:
    summary = _summary(SESSION)
    return {**SESSION, "summary": summary, "suggestions": _suggestions(SESSION, summary)}


@app.after_request
def browser_permissions(response: Response) -> Response:
    """Allow this origin to use sensors while keeping camera data client-side."""
    response.headers["Permissions-Policy"] = "camera=(self), microphone=(self)"
    response.headers["X-Content-Type-Options"] = "nosniff"
    return response


@app.get("/")
def index():
    # Always show the new public landing page, even when the user is signed in.
    # The workspace is available explicitly at /dashboard.
    return render_template("landing.html")


@app.route("/login", methods=["GET", "POST"])
def login():
    if session.get("user_id"):
        return redirect(url_for("dashboard"))
    if request.method == "POST":
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        with _db() as conn:
            user = conn.execute("SELECT * FROM users WHERE email = ?", (email,)).fetchone()
        if user and check_password_hash(user["password_hash"], password):
            session.clear()
            session["user_id"] = user["id"]
            session["user_name"] = user["name"]
            next_path = request.args.get("next", "")
            # Only allow local absolute paths; never redirect to an external host.
            if not next_path.startswith("/") or next_path.startswith("//") or "\\" in next_path:
                next_path = url_for("dashboard")
            return redirect(next_path)
        flash("Email or password is incorrect.", "error")
    return render_template("auth.html", mode="login")


@app.route("/signup", methods=["GET", "POST"])
def signup():
    if session.get("user_id"):
        return redirect(url_for("dashboard"))
    if request.method == "POST":
        name = request.form.get("name", "").strip()
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        if len(name) < 2:
            flash("Enter your full name.", "error")
        elif "@" not in email or "." not in email.split("@")[-1]:
            flash("Enter a valid email address.", "error")
        elif len(password) < 8:
            flash("Password must contain at least 8 characters.", "error")
        else:
            try:
                with _db() as conn:
                    cur = conn.execute("INSERT INTO users(name,email,password_hash) VALUES(?,?,?)",
                                       (name, email, generate_password_hash(password)))
                    user_id = cur.lastrowid
                    conn.execute("INSERT INTO preferences(user_id) VALUES(?)", (user_id,))
                session.clear()
                session["user_id"] = user_id
                session["user_name"] = name
                return redirect(url_for("dashboard"))
            except sqlite3.IntegrityError:
                flash("An account with this email already exists. Sign in instead.", "error")
    return render_template("auth.html", mode="signup")


@app.post("/logout")
def logout():
    session.clear()
    return redirect(url_for("index"))


@app.get("/dashboard")
@login_required
def dashboard():
    return render_template("index.html", user=current_user(), active_page="dashboard")


@app.get("/live")
@login_required
def live_room():
    return render_template("index.html", user=current_user(), active_page="live", focus_live=True)


@app.get("/attendance")
@login_required
def attendance_page():
    with _LOCK:
        payload = _payload()
    return render_template("section.html", user=current_user(), active_page="attendance", page="attendance", payload=payload)


@app.get("/insights")
@login_required
def insights_page():
    with _LOCK:
        payload = _payload()
    return render_template("section.html", user=current_user(), active_page="insights", page="insights", payload=payload)


@app.get("/moments")
@login_required
def moments_page():
    with _LOCK:
        payload = _payload()
    return render_template("section.html", user=current_user(), active_page="moments", page="moments", payload=payload)


@app.get("/reports")
@login_required
def reports_page():
    with _LOCK:
        payload = _payload()
    return render_template("section.html", user=current_user(), active_page="reports", page="reports", payload=payload)


@app.route("/settings", methods=["GET", "POST"])
@login_required
def settings_page():
    user = current_user()
    if request.method == "POST":
        institution = request.form.get("institution", "").strip()[:100] or "PULSE//ROOM Academy"
        default_room = request.form.get("default_room", "").strip()[:60] or "Room 204"
        notifications = 1 if request.form.get("notifications") == "on" else 0
        privacy_mode = 1 if request.form.get("privacy_mode") == "on" else 0
        with _db() as conn:
            conn.execute("""INSERT INTO preferences(user_id,institution,default_room,notifications,privacy_mode)
                VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET institution=excluded.institution,
                default_room=excluded.default_room, notifications=excluded.notifications, privacy_mode=excluded.privacy_mode""",
                (user["id"], institution, default_room, notifications, privacy_mode))
        flash("Settings saved.", "success")
        return redirect(url_for("settings_page"))
    with _db() as conn:
        prefs = conn.execute("SELECT * FROM preferences WHERE user_id=?", (user["id"],)).fetchone()
    if not prefs:
        prefs = {"institution": "PULSE//ROOM Academy", "default_room": "Room 204", "notifications": 1, "privacy_mode": 1}
    return render_template("section.html", user=user, active_page="settings", page="settings", prefs=dict(prefs))


@app.get("/api/health")
def health():
    return jsonify({"status": "ok"})


@app.get("/api/session")
@login_required
def get_session():
    with _LOCK:
        return jsonify(_payload())


@app.post("/api/session/tick")
@login_required
def tick_session():
    incoming = request.get_json(silent=True) or {}
    with _LOCK:
        if SESSION["running"]:
            SESSION["elapsed"] += max(1, min(int(incoming.get("seconds", 4)), 30))
            SESSION["audioLevel"] = max(8, min(int(incoming.get("audioLevel", _RNG.randint(24, 58))), 100))
            poll = SESSION["poll"]
            if poll["active"] and poll["responses"] < 21 and poll["options"]:
                burst = min(_RNG.randint(1, 3), 21 - poll["responses"])
                weights = [2 + index for index in range(len(poll["options"]))]
                for _ in range(burst):
                    option = _RNG.choices(poll["options"], weights=weights, k=1)[0]
                    option["votes"] += 1
                    poll["responses"] += 1
            candidates = [s for s in SESSION["students"] if s["status"] != "absent"]
            for student in _RNG.sample(candidates, k=min(5, len(candidates))):
                student["engagement"] = max(38, min(99, student["engagement"] + _RNG.choice([-2, -1, 0, 1, 1, 2])))
                student["lastSeen"] = "Now"
            if _RNG.random() > 0.65:
                _RNG.choice(candidates)["interactions"] += 1
            avg = _summary(SESSION)["engagement"]
            if not SESSION["timeline"] or SESSION["elapsed"] % 12 < 5:
                SESSION["timeline"].append({"label": "Now", "value": avg})
                SESSION["timeline"] = SESSION["timeline"][-14:]
                for point in SESSION["timeline"][:-1]:
                    if point["label"] == "Now":
                        point["label"] = "Recent"
            SESSION["updatedAt"] = datetime.now(timezone.utc).isoformat()
        return jsonify(_payload())


@app.post("/api/session/control")
@login_required
def control_session():
    incoming = request.get_json(silent=True) or {}
    action = incoming.get("action")
    with _LOCK:
        if action == "start":
            SESSION["running"] = True
        elif action == "stop":
            SESSION["running"] = False
        else:
            return jsonify({"error": "action must be start or stop"}), 400
        SESSION["updatedAt"] = datetime.now(timezone.utc).isoformat()
        return jsonify(_payload())


@app.post("/api/session/reset")
@login_required
def reset_session():
    global SESSION
    with _LOCK:
        SESSION = _new_session()
        return jsonify(_payload())


def _session_clock() -> str:
    total_minutes = (9 * 60 + 55 + SESSION["elapsed"] // 60) % (24 * 60)
    return f"{total_minutes // 60:02d}:{total_minutes % 60:02d}"


@app.post("/api/session/checkpoint")
@login_required
def add_checkpoint():
    incoming = request.get_json(silent=True) or {}
    note = str(incoming.get("note", "")).strip()
    if not 3 <= len(note) <= 180:
        return jsonify({"error": "note must be between 3 and 180 characters"}), 400
    with _LOCK:
        event = {
            "id": max((item["id"] for item in SESSION["events"]), default=0) + 1,
            "time": _session_clock(),
            "type": "note",
            "title": "Teaching moment marked",
            "detail": note,
        }
        SESSION["events"].append(event)
        SESSION["events"] = SESSION["events"][-20:]
        SESSION["updatedAt"] = datetime.now(timezone.utc).isoformat()
        return jsonify(_payload()), 201


@app.post("/api/poll/start")
@login_required
def start_poll():
    incoming = request.get_json(silent=True) or {}
    question = str(incoming.get("question", "")).strip()
    labels = incoming.get("options") or ["Lost", "Getting there", "Confident", "Ready to explain"]
    if not 5 <= len(question) <= 120:
        return jsonify({"error": "question must be between 5 and 120 characters"}), 400
    if not isinstance(labels, list) or not 2 <= len(labels) <= 4:
        return jsonify({"error": "options must contain 2 to 4 labels"}), 400
    labels = [str(label).strip()[:40] for label in labels]
    if any(not label for label in labels):
        return jsonify({"error": "poll options cannot be empty"}), 400
    with _LOCK:
        SESSION["poll"] = {
            "active": True,
            "question": question,
            "options": [{"label": label, "votes": 0} for label in labels],
            "responses": 0,
            "startedAt": datetime.now(timezone.utc).isoformat(),
        }
        SESSION["updatedAt"] = datetime.now(timezone.utc).isoformat()
        return jsonify(_payload()), 201


@app.post("/api/poll/close")
@login_required
def close_poll():
    with _LOCK:
        poll = SESSION["poll"]
        if not poll["active"]:
            return jsonify({"error": "no active poll"}), 409
        poll["active"] = False
        leading = max(poll["options"], key=lambda option: option["votes"], default={"label": "No response", "votes": 0})
        event = {
            "id": max((item["id"] for item in SESSION["events"]), default=0) + 1,
            "time": _session_clock(),
            "type": "poll",
            "title": "Pulse poll completed",
            "detail": f"{poll['responses']} responses · top signal: {leading['label']} ({leading['votes']}).",
        }
        SESSION["events"].append(event)
        SESSION["events"] = SESSION["events"][-20:]
        SESSION["updatedAt"] = datetime.now(timezone.utc).isoformat()
        return jsonify(_payload())


@app.get("/api/session/report.json")
@login_required
def export_json_report():
    with _LOCK:
        report = {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "privacy": "No camera frames, face descriptors, or biometric templates are included.",
            "session": {
                "id": SESSION["id"],
                "title": SESSION["title"],
                "cohort": SESSION["cohort"],
                "room": SESSION["room"],
                "elapsedSeconds": SESSION["elapsed"],
            },
            "summary": _summary(SESSION),
            "students": SESSION["students"],
            "timeline": SESSION["timeline"],
            "events": SESSION["events"],
            "latestPoll": SESSION["poll"],
        }
        filename = f"session-report-{datetime.now().date().isoformat()}.json"
        return Response(
            json.dumps(report, ensure_ascii=False, indent=2),
            mimetype="application/json",
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )


@app.get("/api/session/export.csv")
@login_required
def export_csv():
    with _LOCK:
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["Student", "Status", "Engagement", "Interactions", "Last seen"])
        for student in SESSION["students"]:
            writer.writerow(
                [
                    student["name"],
                    student["status"].title(),
                    f"{student['engagement']}%" if student["status"] != "absent" else "—",
                    student["interactions"],
                    student["lastSeen"],
                ]
            )
        filename = f"attendance-{datetime.now().date().isoformat()}.csv"
        return Response(
            output.getvalue(),
            mimetype="text/csv",
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )


if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "5050")),
        debug=os.environ.get("FLASK_DEBUG", "0") == "1",
    )
