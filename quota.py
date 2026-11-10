"""Free-message quota per account."""
import os

import db

# Number of model replies a regular account may request (new message, edit or regenerate).
FREE_MESSAGE_LIMIT = int(os.getenv("FREE_MESSAGE_LIMIT", "10"))


def quota_info(user_id):
    """{used, limit, remaining, unlimited} for the given user (fresh from the DB)."""
    user = db.get_user(user_id)
    limit = db.effective_limit(user, FREE_MESSAGE_LIMIT)
    used = user["messages_used"]
    return {
        "used": used,
        "limit": limit,
        "remaining": None if limit is None else max(limit - used, 0),
        "unlimited": limit is None,
    }


def consume(user_id):
    return db.try_consume_message(user_id, FREE_MESSAGE_LIMIT)


def refund(user_id):
    db.refund_message(user_id)
