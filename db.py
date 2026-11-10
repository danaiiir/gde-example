"""SQLite persistence for users, conversations and messages."""
import os
import sqlite3
import time
import uuid
from contextlib import contextmanager

DB_PATH = os.getenv("CHAT_DB_PATH", os.path.join(os.path.dirname(os.path.abspath(__file__)), "chat.db"))

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash  TEXT NOT NULL,
    is_admin       INTEGER NOT NULL DEFAULT 0,
    created_at     REAL NOT NULL,
    last_login_at  REAL,
    messages_used  INTEGER NOT NULL DEFAULT 0,  -- lifetime count of model replies requested
    message_limit  INTEGER                      -- NULL = default free limit, -1 = unlimited
);
CREATE TABLE IF NOT EXISTS conversations (
    id          TEXT PRIMARY KEY,
    user_id     INTEGER REFERENCES users(id) ON DELETE CASCADE,
    title       TEXT NOT NULL DEFAULT 'New chat',
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id  TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role             TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
    content          TEXT NOT NULL,
    created_at       REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS login_failures (
    key  TEXT NOT NULL,
    ts   REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_login_failures ON login_failures(key, ts);
"""


@contextmanager
def connect():
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with connect() as conn:
        conn.execute("PRAGMA journal_mode = WAL")
        conn.executescript(SCHEMA)
        # Migration: databases created before authentication have no user_id column.
        cols = {r["name"] for r in conn.execute("PRAGMA table_info(conversations)")}
        if "user_id" not in cols:
            conn.execute(
                "ALTER TABLE conversations ADD COLUMN user_id INTEGER REFERENCES users(id) ON DELETE CASCADE"
            )
        user_cols = {r["name"] for r in conn.execute("PRAGMA table_info(users)")}
        if "messages_used" not in user_cols:
            conn.execute("ALTER TABLE users ADD COLUMN messages_used INTEGER NOT NULL DEFAULT 0")
        if "message_limit" not in user_cols:
            conn.execute("ALTER TABLE users ADD COLUMN message_limit INTEGER")
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_conv_user_updated ON conversations(user_id, updated_at DESC)"
        )


# ---------- Users ----------
def count_users():
    with connect() as conn:
        return conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]


def create_user(username, password_hash, is_admin=False):
    """Create a user. The very first user also adopts chats created before auth existed."""
    now = time.time()
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO users (username, password_hash, is_admin, created_at) VALUES (?, ?, ?, ?)",
            (username, password_hash, int(is_admin), now),
        )
        user_id = cur.lastrowid
        if conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 1:
            conn.execute("UPDATE conversations SET user_id = ? WHERE user_id IS NULL", (user_id,))
    return user_id


def get_user_by_username(username):
    with connect() as conn:
        row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
    return dict(row) if row else None


def get_user(user_id):
    with connect() as conn:
        row = conn.execute(
            "SELECT id, username, is_admin, created_at, last_login_at, messages_used, message_limit "
            "FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
    return dict(row) if row else None


def update_password(user_id, password_hash):
    with connect() as conn:
        conn.execute("UPDATE users SET password_hash = ? WHERE id = ?", (password_hash, user_id))


def touch_login(user_id):
    with connect() as conn:
        conn.execute("UPDATE users SET last_login_at = ? WHERE id = ?", (time.time(), user_id))


# ---------- Message quota ----------
def effective_limit(user, default_limit):
    """None means unlimited."""
    if user["is_admin"]:
        return None
    limit = user["message_limit"] if user["message_limit"] is not None else default_limit
    return None if limit < 0 else limit


def try_consume_message(user_id, default_limit):
    """Atomically use one message if the user is under their limit. Returns True if allowed."""
    with connect() as conn:
        cur = conn.execute(
            """UPDATE users SET messages_used = messages_used + 1
               WHERE id = ?
                 AND (is_admin = 1
                      OR COALESCE(message_limit, ?) < 0
                      OR messages_used < COALESCE(message_limit, ?))""",
            (user_id, default_limit, default_limit),
        )
        return cur.rowcount == 1


def refund_message(user_id):
    with connect() as conn:
        conn.execute(
            "UPDATE users SET messages_used = MAX(messages_used - 1, 0) WHERE id = ?", (user_id,)
        )


def set_message_limit(user_id, limit):
    with connect() as conn:
        conn.execute("UPDATE users SET message_limit = ? WHERE id = ?", (limit, user_id))


def reset_message_usage(user_id):
    with connect() as conn:
        conn.execute("UPDATE users SET messages_used = 0 WHERE id = ?", (user_id,))


# ---------- Login throttling ----------
def record_login_failure(key):
    with connect() as conn:
        conn.execute("INSERT INTO login_failures (key, ts) VALUES (?, ?)", (key, time.time()))


def recent_login_failures(key, window_seconds):
    cutoff = time.time() - window_seconds
    with connect() as conn:
        conn.execute("DELETE FROM login_failures WHERE ts < ?", (time.time() - 86400,))
        return conn.execute(
            "SELECT COUNT(*) FROM login_failures WHERE key = ? AND ts >= ?", (key, cutoff)
        ).fetchone()[0]


def clear_login_failures(key):
    with connect() as conn:
        conn.execute("DELETE FROM login_failures WHERE key = ?", (key,))


# ---------- Conversations (always scoped to a user) ----------
def create_conversation(user_id, title="New chat"):
    now = time.time()
    conv_id = uuid.uuid4().hex
    with connect() as conn:
        conn.execute(
            "INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
            (conv_id, user_id, title, now, now),
        )
    return {"id": conv_id, "title": title, "created_at": now, "updated_at": now}


def list_conversations(user_id, query=None):
    sql = "SELECT id, title, created_at, updated_at FROM conversations WHERE user_id = ?"
    params = [user_id]
    if query:
        like = f"%{query}%"
        sql += " AND (title LIKE ? OR id IN (SELECT conversation_id FROM messages WHERE content LIKE ?))"
        params += [like, like]
    sql += " ORDER BY updated_at DESC"
    with connect() as conn:
        return [dict(r) for r in conn.execute(sql, params)]


def get_conversation(user_id, conv_id):
    with connect() as conn:
        row = conn.execute(
            "SELECT id, title, created_at, updated_at FROM conversations WHERE id = ? AND user_id = ?",
            (conv_id, user_id),
        ).fetchone()
        if not row:
            return None
        msgs = conn.execute(
            "SELECT id, role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id",
            (conv_id,),
        ).fetchall()
    conv = dict(row)
    conv["messages"] = [dict(m) for m in msgs]
    return conv


def rename_conversation(user_id, conv_id, title):
    with connect() as conn:
        cur = conn.execute(
            "UPDATE conversations SET title = ? WHERE id = ? AND user_id = ?", (title, conv_id, user_id)
        )
        return cur.rowcount > 0


def delete_conversation(user_id, conv_id):
    with connect() as conn:
        cur = conn.execute("DELETE FROM conversations WHERE id = ? AND user_id = ?", (conv_id, user_id))
        return cur.rowcount > 0


def delete_all_conversations(user_id):
    with connect() as conn:
        conn.execute("DELETE FROM conversations WHERE user_id = ?", (user_id,))


# ---------- Messages ----------
# These are only called after get_conversation(user_id, conv_id) has verified ownership.
def add_message(conv_id, role, content):
    now = time.time()
    with connect() as conn:
        cur = conn.execute(
            "INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)",
            (conv_id, role, content, now),
        )
        conn.execute("UPDATE conversations SET updated_at = ? WHERE id = ?", (now, conv_id))
        return cur.lastrowid


def delete_last_assistant_message(conv_id):
    """Remove the trailing assistant message (used for 'regenerate')."""
    with connect() as conn:
        row = conn.execute(
            "SELECT id, role FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 1",
            (conv_id,),
        ).fetchone()
        if row and row["role"] == "assistant":
            conn.execute("DELETE FROM messages WHERE id = ?", (row["id"],))


def truncate_from(conv_id, message_id):
    """Delete a message and everything after it (used for 'edit message')."""
    with connect() as conn:
        conn.execute(
            "DELETE FROM messages WHERE conversation_id = ? AND id >= ?", (conv_id, message_id)
        )
