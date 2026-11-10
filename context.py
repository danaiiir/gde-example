"""Context-window limiting: decide which past messages are sent to the model.

The newest messages are kept until an estimated token budget is used up; older
ones are dropped (a sliding window). The full history stays in the database and
in the UI — only what the model "sees" is limited.
"""
import math
import os

# Max estimated input tokens per request (system prompt + history + new message).
MAX_CONTEXT_TOKENS = int(os.getenv("MAX_CONTEXT_TOKENS", "8000"))
# Hard cap on the number of past messages, regardless of size.
MAX_CONTEXT_MESSAGES = int(os.getenv("MAX_CONTEXT_MESSAGES", "40"))
# Max characters in a single user message.
MAX_INPUT_CHARS = int(os.getenv("MAX_INPUT_CHARS", "8000"))

PER_MESSAGE_OVERHEAD = 4  # role markers / formatting


def estimate_tokens(text):
    """Conservative token estimate without calling the model.

    English averages ~4 characters per token; non-Latin scripts (Greek, Hebrew,
    Cyrillic, CJK...) and emoji use far fewer characters per token, so they are
    weighted more heavily to avoid underestimating.
    """
    if not text:
        return 0
    ascii_chars = sum(1 for ch in text if ord(ch) < 128)
    other_chars = len(text) - ascii_chars
    return math.ceil(ascii_chars / 4 + other_chars / 1.5)


def build_context(history, system_prompt=""):
    """Select the most recent messages that fit the budget.

    history: [{id, role, content}, ...] oldest first.
    Returns (bedrock_messages, info) where info describes what was included.
    """
    usable = [m for m in history if (m.get("content") or "").strip()]
    budget = MAX_CONTEXT_TOKENS - estimate_tokens(system_prompt)

    selected, used = [], 0
    for item in reversed(usable):
        if len(selected) >= MAX_CONTEXT_MESSAGES:
            break
        cost = estimate_tokens(item["content"].strip()) + PER_MESSAGE_OVERHEAD
        # Always keep the newest message, even if it alone exceeds the budget.
        if selected and used + cost > budget:
            break
        selected.append(item)
        used += cost
    selected.reverse()

    # The model requires the conversation to start with a user turn.
    while selected and selected[0]["role"] != "user":
        used -= estimate_tokens(selected[0]["content"].strip()) + PER_MESSAGE_OVERHEAD
        selected.pop(0)

    # Bedrock Converse requires alternating roles; merge consecutive same-role turns.
    messages = []
    for item in selected:
        text = item["content"].strip()
        if messages and messages[-1]["role"] == item["role"]:
            messages[-1]["content"][0]["text"] += "\n\n" + text
        else:
            messages.append({"role": item["role"], "content": [{"text": text}]})

    info = {
        "included": len(selected),
        "total": len(usable),
        "trimmed": len(selected) < len(usable),
        "first_message_id": selected[0].get("id") if selected else None,
        "estimated_tokens": used + estimate_tokens(system_prompt),
        "max_tokens": MAX_CONTEXT_TOKENS,
    }
    return messages, info


def limits():
    return {"max_input_chars": MAX_INPUT_CHARS, "max_context_tokens": MAX_CONTEXT_TOKENS}
