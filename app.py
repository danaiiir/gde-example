import json
import os

# Use the Windows/OS certificate store so HTTPS works behind antivirus or
# corporate proxies that inspect TLS traffic (e.g. AVG Web Shield).
try:
    import truststore

    truststore.inject_into_ssl()
except ImportError:
    pass

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError, NoCredentialsError
from flask import Flask, Response, abort, g, jsonify, render_template, request, stream_with_context

import auth
import context
import db
import quota
from auth import login_required

# Same Bedrock settings as test_bedrock.py
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")
MODEL_ID = os.getenv("BEDROCK_MODEL_ID", "global.anthropic.claude-opus-4-6-v1")
MAX_TOKENS = int(os.getenv("MAX_TOKENS", "2048"))
TEMPERATURE = float(os.getenv("TEMPERATURE", "0.5"))

SYSTEM_PROMPT = (
    "You are a helpful, friendly and knowledgeable general-purpose assistant. "
    "Answer clearly and concisely. Use Markdown formatting (lists, code blocks, "
    "bold) when it improves readability."
)

app = Flask(__name__)
db.init_db()
auth.init_app(app)

aws_session = boto3.Session(region_name=AWS_REGION)
bedrock = aws_session.client(
    "bedrock-runtime",
    # Automatically back off and retry on ThrottlingException.
    config=Config(retries={"max_attempts": 6, "mode": "adaptive"}, read_timeout=300),
)


def generate_title(user_text, reply_text):
    """Ask the model for a short conversation title."""
    try:
        resp = bedrock.converse(
            modelId=MODEL_ID,
            system=[{"text": "You write very short titles for chat conversations."}],
            messages=[{
                "role": "user",
                "content": [{"text": (
                    "Write a concise title (max 6 words, no quotes, no trailing punctuation) "
                    f"for this conversation.\n\nUser: {user_text[:1500]}\n\nAssistant: {reply_text[:1500]}"
                )}],
            }],
            inferenceConfig={"maxTokens": 24, "temperature": 0.3},
        )
        title = "".join(b.get("text", "") for b in resp["output"]["message"]["content"])
        title = title.strip().strip('"\'').splitlines()[0][:80]
        return title or None
    except Exception:  # noqa: BLE001
        return None


def fallback_title(text):
    text = " ".join(text.split())
    return text[:48] + ("…" if len(text) > 48 else "")


def sse(event, data):
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


# ---------- Pages ----------
@app.route("/")
@app.route("/c/<conv_id>")
@login_required
def index(conv_id=None):
    return render_template(
        "index.html", model_id=MODEL_ID, region=AWS_REGION, user=g.user,
        quota=quota.quota_info(g.user["id"]), limits=context.limits(),
    )


# ---------- Conversation API ----------
@app.get("/api/conversations")
@login_required
def api_list_conversations():
    return jsonify(db.list_conversations(g.user["id"], request.args.get("q", "").strip() or None))


@app.get("/api/conversations/<conv_id>")
@login_required
def api_get_conversation(conv_id):
    conv = db.get_conversation(g.user["id"], conv_id)
    if not conv:
        abort(404)
    _, conv["context"] = context.build_context(conv["messages"], SYSTEM_PROMPT)
    return jsonify(conv)


@app.patch("/api/conversations/<conv_id>")
@login_required
def api_rename_conversation(conv_id):
    title = ((request.get_json(silent=True) or {}).get("title") or "").strip()[:120]
    if not title:
        return jsonify({"error": "Title is required."}), 400
    if not db.rename_conversation(g.user["id"], conv_id, title):
        abort(404)
    return jsonify({"id": conv_id, "title": title})


@app.delete("/api/conversations/<conv_id>")
@login_required
def api_delete_conversation(conv_id):
    if not db.delete_conversation(g.user["id"], conv_id):
        abort(404)
    return jsonify({"ok": True})


@app.delete("/api/conversations")
@login_required
def api_delete_all():
    db.delete_all_conversations(g.user["id"])
    return jsonify({"ok": True})


# ---------- Chat (streaming) ----------
@app.post("/api/chat")
@login_required
def chat():
    """
    Body: {conversation_id?, content?, regenerate?, edit_message_id?}
      - new message:  {conversation_id?, content}
      - regenerate:   {conversation_id, regenerate: true}
      - edit message: {conversation_id, edit_message_id, content}
    Streams SSE events: meta, delta, usage, title, done, error.
    """
    user_id = g.user["id"]
    payload = request.get_json(silent=True) or {}
    conv_id = payload.get("conversation_id")
    content = (payload.get("content") or "").strip()
    regenerate = bool(payload.get("regenerate"))
    edit_id = payload.get("edit_message_id")

    # ---- validate the request before touching the database or the quota ----
    if not regenerate and not content:
        return jsonify({"error": "A message is required."}), 400
    if len(content) > context.MAX_INPUT_CHARS:
        return jsonify({
            "error": f"Message is too long ({len(content):,} characters). "
                     f"The limit is {context.MAX_INPUT_CHARS:,}.",
            "code": "message_too_long",
        }), 413
    if regenerate and not conv_id:
        return jsonify({"error": "Nothing to regenerate."}), 400
    if edit_id is not None:
        try:
            edit_id = int(edit_id)
        except (TypeError, ValueError):
            return jsonify({"error": "Invalid message id."}), 400
    conv = None
    if conv_id:
        conv = db.get_conversation(user_id, conv_id)
        if not conv:
            return jsonify({"error": "Conversation not found."}), 404

    # ---- free-message quota: one unit per model reply ----
    if not quota.consume(user_id):
        info = quota.quota_info(user_id)
        return jsonify({
            "error": f"You've used all {info['limit']} of your free messages.",
            "code": "quota_exceeded",
            "quota": info,
        }), 429

    is_new = False
    if conv is None:
        conv = db.create_conversation(user_id)
        conv_id, is_new = conv["id"], True

    user_message_id = None
    if regenerate:
        db.delete_last_assistant_message(conv_id)
    else:
        if edit_id is not None:
            db.truncate_from(conv_id, edit_id)
        user_message_id = db.add_message(conv_id, "user", content)

    history = db.get_conversation(user_id, conv_id)["messages"]
    messages, context_info = context.build_context(history, SYSTEM_PROMPT)
    if not messages or messages[-1]["role"] != "user":
        quota.refund(user_id)
        return jsonify({"error": "Nothing to respond to."}), 400
    quota_after = quota.quota_info(user_id)

    needs_title = conv["title"] == "New chat"
    first_user_text = next((m["content"] for m in history if m["role"] == "user"), content)

    def generate():
        reply = ""
        saved = False
        yield sse("meta", {
            "conversation_id": conv_id,
            "user_message_id": user_message_id,
            "is_new": is_new,
            "quota": quota_after,
            "context": context_info,
        })
        try:
            response = bedrock.converse_stream(
                modelId=MODEL_ID,
                messages=messages,
                system=[{"text": SYSTEM_PROMPT}],
                inferenceConfig={"maxTokens": MAX_TOKENS, "temperature": TEMPERATURE},
            )
            for event in response["stream"]:
                if "contentBlockDelta" in event:
                    delta = event["contentBlockDelta"]["delta"]
                    if "text" in delta:
                        reply += delta["text"]
                        yield sse("delta", {"text": delta["text"]})
                elif "metadata" in event:
                    yield sse("usage", event["metadata"].get("usage", {}))

            assistant_id = db.add_message(conv_id, "assistant", reply) if reply else None
            saved = True

            if needs_title:
                title = generate_title(first_user_text, reply) or fallback_title(first_user_text)
                db.rename_conversation(user_id, conv_id, title)
                yield sse("title", {"conversation_id": conv_id, "title": title})

            yield sse("done", {"assistant_message_id": assistant_id})
        except NoCredentialsError:
            yield sse("error", {"message": "AWS credentials not found. Run: aws configure"})
        except ClientError as error:
            err = error.response["Error"]
            yield sse("error", {"message": f"{err['Code']}: {err['Message']}"})
        except GeneratorExit:
            pass  # client pressed Stop / disconnected
        except Exception as error:  # noqa: BLE001
            yield sse("error", {"message": str(error)})
        finally:
            # A request that produced no reply at all (e.g. Bedrock error) doesn't use up quota.
            if not reply:
                quota.refund(user_id)
            # Persist partial replies when the user stops generation mid-stream.
            if not saved and reply:
                db.add_message(conv_id, "assistant", reply)
            if needs_title and not saved:
                db.rename_conversation(user_id, conv_id, fallback_title(first_user_text))

    return Response(
        stream_with_context(generate()),
        mimetype="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.route("/healthz")
def healthz():
    """Liveness probe for Docker/load balancers (no AWS call)."""
    return jsonify({"ok": True})


@app.route("/api/health")
@login_required
def health():
    try:
        identity = aws_session.client("sts").get_caller_identity()
        return jsonify({"ok": True, "account": identity["Account"], "model": MODEL_ID})
    except Exception as error:  # noqa: BLE001
        return jsonify({"ok": False, "error": str(error)}), 500


if __name__ == "__main__":
    app.run(debug=True, port=5000, threaded=True)
