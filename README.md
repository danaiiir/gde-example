# Nova Assistant

A ChatGPT-style chat bot built with **Flask** and **Amazon Bedrock** (Claude), with a hand-written HTML/CSS/JS front end and SQLite storage.

## Features

- **Streaming chat** with Claude via the Bedrock `ConverseStream` API, with Markdown rendering and code blocks you can copy
- **Conversation history** in SQLite: sidebar grouped by date, search, rename, delete, a link for each chat (`/c/<id>`), auto-generated titles
- **Message actions:** copy, edit and resend, regenerate, stop generating
- **Accounts:** sign-up and login, scrypt password hashes, HTTP-only session cookies, CSRF protection, login throttling. Each user sees only their own chats
- **Free-message quota:** 10 model replies per account by default. Admins are unlimited
- **Context-window limit:** only the most recent messages that fit an estimated token budget are sent to the model
- Light and dark theme; works on phones

## Project layout

```
app.py              Flask app: pages, chat API, Bedrock streaming
auth.py             Login/sign-up, sessions, CSRF, admin commands
quota.py            Free-message quota
context.py          Context-window (token budget) limiting
db.py               SQLite schema, migrations and queries
templates/          index.html (chat UI), auth.html (login/sign-up)
static/             CSS and JavaScript
iam/                IAM policies for the EC2 instance role
scripts/            deploy-on-ec2.sh: pull from ECR and (re)start the container
Dockerfile          Production image (gunicorn)
docker-compose.yml  Local Docker run using your ~/.aws credentials
DEPLOY.md           Step-by-step EC2 + ECR deployment guide
```

## Requirements

- Python 3.12+
- AWS credentials with `bedrock:InvokeModel` and `bedrock:InvokeModelWithResponseStream` for the model you use. You also need access to that model enabled in Bedrock.

## Run locally

```bash
python -m venv .venv
.venv/Scripts/activate          # Windows (use: source .venv/bin/activate on macOS/Linux)
pip install -r requirements.txt
python app.py                   # http://127.0.0.1:5000
```

The first account created at `/signup` becomes the **admin**. After that, sign-up is closed unless `ALLOW_SIGNUP=true`.

## Run with Docker

```bash
docker compose up --build       # http://localhost:8000 (mounts ~/.aws read-only)
```

## Admin commands

```bash
flask --app app create-user alice            # add an account (prompts for password)
flask --app app reset-password alice
flask --app app set-limit alice 50           # or: unlimited | default
flask --app app reset-usage alice            # give their free messages back
```

Inside the container, prefix the command with `docker exec -it nova`.

## Configuration

| Variable | Default | Description |
|---|---|---|
| `AWS_REGION` | `us-east-1` | Bedrock region |
| `BEDROCK_MODEL_ID` | `global.anthropic.claude-opus-4-6-v1` | Model or inference profile |
| `MAX_TOKENS` | `2048` | Max tokens per reply |
| `TEMPERATURE` | `0.5` | Sampling temperature |
| `FREE_MESSAGE_LIMIT` | `10` | Replies per non-admin account |
| `MAX_CONTEXT_TOKENS` | `8000` | Estimated input-token budget per request |
| `MAX_CONTEXT_MESSAGES` | `40` | Max past messages per request |
| `MAX_INPUT_CHARS` | `8000` | Max characters in one message |
| `ALLOW_SIGNUP` | `false` | Allow sign-up after the first account |
| `SECRET_KEY` | auto-generated | Session signing key (otherwise stored next to the DB) |
| `SESSION_COOKIE_SECURE` | `false` | Set `true` when served over HTTPS |
| `CHAT_DB_PATH` | `./chat.db` | SQLite database path (`/data/chat.db` in Docker) |

## Deploy to AWS

See [DEPLOY.md](DEPLOY.md). It covers the EC2 instance role (no access keys on the server), pushing to Amazon ECR, and running the container on EC2.
