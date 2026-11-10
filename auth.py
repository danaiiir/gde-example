"""Username/password authentication backed by SQLite.

- Passwords are hashed with scrypt (werkzeug.security); plaintext is never stored.
- Sessions are signed, HTTP-only, SameSite=Lax cookies.
- Every state-changing request needs a CSRF token (form field or X-CSRF-Token header).
- Repeated failed logins from one IP/username are throttled.
- Sign-up is always open for the first account; after that only if ALLOW_SIGNUP=true.
"""
import os
import re
import secrets
import sqlite3
from datetime import timedelta
from functools import wraps
from urllib.parse import urlparse

import click
from flask import (
    Blueprint, abort, current_app, g, jsonify, redirect, render_template,
    request, session, url_for,
)
from werkzeug.security import check_password_hash, generate_password_hash

import db
import quota

bp = Blueprint("auth", __name__)

USERNAME_RE = re.compile(r"^[A-Za-z0-9_.@-]{3,64}$")
MIN_PASSWORD_LEN = 8
MAX_FAILURES = 5                  # failed logins allowed ...
FAILURE_WINDOW = 15 * 60          # ... within this many seconds
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}

# A constant hash so unknown usernames take as long to check as real ones.
_DUMMY_HASH = generate_password_hash(secrets.token_hex(16))


# ---------------------------------------------------------------- setup
def _load_secret_key():
    """SECRET_KEY env var, else a random key persisted next to the database."""
    if os.getenv("SECRET_KEY"):
        return os.environ["SECRET_KEY"]
    path = os.path.join(os.path.dirname(db.DB_PATH), ".secret_key")
    try:
        with open(path) as f:
            key = f.read().strip()
        if key:
            return key
    except FileNotFoundError:
        pass
    key = secrets.token_hex(32)
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        os.write(fd, key.encode())
    except Exception:
        os.close(fd)
        raise
    os.close(fd)
    return key


def init_app(app):
    try:
        app.secret_key = _load_secret_key()
    except FileExistsError:  # another worker created it first
        app.secret_key = _load_secret_key()
    app.config.update(
        SESSION_COOKIE_NAME="nova_session",
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Lax",
        # Set SESSION_COOKIE_SECURE=true once the site is served over HTTPS.
        SESSION_COOKIE_SECURE=os.getenv("SESSION_COOKIE_SECURE", "false").lower() == "true",
        PERMANENT_SESSION_LIFETIME=timedelta(days=30),
    )
    app.register_blueprint(bp)
    app.before_request(_load_user_and_check_csrf)
    app.context_processor(lambda: {"csrf_token": csrf_token(), "current_user": g.get("user")})
    app.cli.add_command(create_user_command)
    app.cli.add_command(reset_password_command)
    app.cli.add_command(set_limit_command)
    app.cli.add_command(reset_usage_command)


def signup_allowed():
    return db.count_users() == 0 or os.getenv("ALLOW_SIGNUP", "false").lower() == "true"


# ----------------------------------------------------------------- CSRF
def csrf_token():
    if "csrf" not in session:
        session["csrf"] = secrets.token_urlsafe(32)
    return session["csrf"]


def _load_user_and_check_csrf():
    g.user = None
    uid = session.get("uid")
    if uid is not None:
        user = db.get_user(uid)
        if user:
            g.user = user
        else:  # account was deleted
            session.clear()

    if request.method not in SAFE_METHODS:
        sent = request.headers.get("X-CSRF-Token") or request.form.get("csrf_token")
        expected = session.get("csrf")
        if not expected or not sent or not secrets.compare_digest(sent, expected):
            if request.path.startswith("/api/"):
                return jsonify({"error": "Invalid or missing CSRF token. Reload the page."}), 403
            abort(400, "Invalid form token. Please reload the page and try again.")


# ------------------------------------------------------------ decorators
def login_required(view):
    @wraps(view)
    def wrapper(*args, **kwargs):
        if g.get("user") is None:
            if request.path.startswith("/api/"):
                return jsonify({"error": "Authentication required."}), 401
            return redirect(url_for("auth.login", next=request.full_path.rstrip("?")))
        return view(*args, **kwargs)
    return wrapper


def _safe_next(target):
    """Only allow redirects to local paths (prevents open redirects)."""
    if not target:
        return url_for("index")
    parsed = urlparse(target)
    if parsed.scheme or parsed.netloc or not target.startswith("/") or target.startswith("//"):
        return url_for("index")
    return target


def _login(user, remember):
    session.clear()                        # prevent session fixation
    session["uid"] = user["id"]
    session.permanent = bool(remember)
    csrf_token()                           # fresh CSRF token for the new session
    db.touch_login(user["id"])


# ----------------------------------------------------------------- views
@bp.route("/login", methods=["GET", "POST"])
def login():
    if g.user:
        return redirect(_safe_next(request.args.get("next")))

    error = None
    username = ""
    if request.method == "POST":
        username = (request.form.get("username") or "").strip()
        password = request.form.get("password") or ""
        # No reverse proxy in front of the app, so X-Forwarded-For would be spoofable.
        ip = request.remote_addr or "unknown"
        keys = (f"ip:{ip}", f"user:{username.lower()}")

        if any(db.recent_login_failures(k, FAILURE_WINDOW) >= MAX_FAILURES for k in keys):
            error = "Too many failed attempts. Please wait 15 minutes and try again."
        else:
            user = db.get_user_by_username(username) if username else None
            ok = check_password_hash(user["password_hash"] if user else _DUMMY_HASH, password)
            if user and ok:
                for k in keys:
                    db.clear_login_failures(k)
                _login(user, request.form.get("remember"))
                return redirect(_safe_next(request.args.get("next")))
            for k in keys:
                db.record_login_failure(k)
            error = "Incorrect username or password."

    return render_template(
        "auth.html", mode="login", error=error, username=username,
        signup_allowed=signup_allowed(), next=request.args.get("next", ""),
    ), (401 if error else 200)


@bp.route("/signup", methods=["GET", "POST"])
def signup():
    if g.user:
        return redirect(url_for("index"))
    first_user = db.count_users() == 0
    if not signup_allowed():
        return render_template("auth.html", mode="closed"), 403

    error = None
    username = ""
    if request.method == "POST":
        username = (request.form.get("username") or "").strip()
        password = request.form.get("password") or ""
        confirm = request.form.get("confirm") or ""
        if not USERNAME_RE.match(username):
            error = "Username must be 3–64 characters: letters, numbers, and . _ - @"
        elif len(password) < MIN_PASSWORD_LEN:
            error = f"Password must be at least {MIN_PASSWORD_LEN} characters."
        elif password != confirm:
            error = "Passwords do not match."
        else:
            try:
                uid = db.create_user(username, generate_password_hash(password), is_admin=first_user)
            except sqlite3.IntegrityError:
                error = "That username is already taken."
            else:
                _login(db.get_user(uid), remember=True)
                return redirect(url_for("index"))

    return render_template(
        "auth.html", mode="signup", error=error, username=username, first_user=first_user,
    ), (400 if error else 200)


@bp.post("/logout")
def logout():
    session.clear()
    return redirect(url_for("auth.login"))


@bp.get("/api/me")
@login_required
def me():
    u = g.user
    return jsonify({
        "id": u["id"], "username": u["username"], "is_admin": bool(u["is_admin"]),
        "quota": quota.quota_info(u["id"]),
    })


@bp.post("/api/me/password")
@login_required
def change_password():
    data = request.get_json(silent=True) or {}
    current, new = data.get("current") or "", data.get("new") or ""
    full = db.get_user_by_username(g.user["username"])
    if not check_password_hash(full["password_hash"], current):
        return jsonify({"error": "Current password is incorrect."}), 400
    if len(new) < MIN_PASSWORD_LEN:
        return jsonify({"error": f"New password must be at least {MIN_PASSWORD_LEN} characters."}), 400
    db.update_password(g.user["id"], generate_password_hash(new))
    return jsonify({"ok": True})


# ------------------------------------------------------------ CLI tools
@click.command("create-user")
@click.argument("username")
@click.option("--admin", is_flag=True, help="Mark the user as an admin.")
@click.password_option()
def create_user_command(username, admin, password):
    """Create a user account:  flask --app app create-user alice"""
    if not USERNAME_RE.match(username):
        raise click.ClickException("Invalid username.")
    if len(password) < MIN_PASSWORD_LEN:
        raise click.ClickException(f"Password must be at least {MIN_PASSWORD_LEN} characters.")
    try:
        db.create_user(username, generate_password_hash(password), is_admin=admin)
    except sqlite3.IntegrityError:
        raise click.ClickException("Username already exists.")
    click.echo(f"Created user '{username}'.")


@click.command("reset-password")
@click.argument("username")
@click.password_option()
def reset_password_command(username, password):
    """Reset a user's password:  flask --app app reset-password alice"""
    user = db.get_user_by_username(username)
    if not user:
        raise click.ClickException("No such user.")
    if len(password) < MIN_PASSWORD_LEN:
        raise click.ClickException(f"Password must be at least {MIN_PASSWORD_LEN} characters.")
    db.update_password(user["id"], generate_password_hash(password))
    db.clear_login_failures(f"user:{username.lower()}")
    click.echo(f"Password updated for '{username}'.")


@click.command("set-limit")
@click.argument("username")
@click.argument("limit")
def set_limit_command(username, limit):
    """Set a user's message limit:  flask --app app set-limit alice 50 | unlimited | default"""
    user = db.get_user_by_username(username)
    if not user:
        raise click.ClickException("No such user.")
    if limit == "unlimited":
        value = -1
    elif limit == "default":
        value = None
    elif limit.isdigit():
        value = int(limit)
    else:
        raise click.ClickException("LIMIT must be a number, 'unlimited' or 'default'.")
    db.set_message_limit(user["id"], value)
    info = quota.quota_info(user["id"])
    shown = "unlimited" if info["unlimited"] else f"{info['remaining']} of {info['limit']} left"
    click.echo(f"Limit for '{username}' set to {limit} ({shown}).")


@click.command("reset-usage")
@click.argument("username")
def reset_usage_command(username):
    """Give a user their free messages back:  flask --app app reset-usage alice"""
    user = db.get_user_by_username(username)
    if not user:
        raise click.ClickException("No such user.")
    db.reset_message_usage(user["id"])
    click.echo(f"Usage reset for '{username}'.")
