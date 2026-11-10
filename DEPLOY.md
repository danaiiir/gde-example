# Deploying Nova Assistant to EC2 (Docker)

## How credentials work

| Where it runs        | Where boto3 gets credentials                                   |
|----------------------|----------------------------------------------------------------|
| Your laptop (venv)   | `~/.aws/credentials` (your IAM user)                           |
| Local Docker         | `~/.aws` mounted read-only by `docker-compose.yml`              |
| **EC2 (production)** | **IAM role attached to the instance (instance profile)**        |

On EC2 you **do not copy access keys** anywhere. boto3's default credential chain
automatically fetches short-lived, auto-rotating credentials from the instance
metadata service (IMDS). No code changes are needed — the same `boto3.Session()` works.

> Never bake `~/.aws` or keys into the image (`.dockerignore` already excludes them).

---

## 1. Create the IAM role (one time)

Run from this project folder with your admin AWS CLI profile:

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Role that EC2 can assume
aws iam create-role --role-name NovaAssistantEC2Role \
  --assume-role-policy-document file://iam/ec2-trust-policy.json

# Permission to call the Claude model on Bedrock
aws iam put-role-policy --role-name NovaAssistantEC2Role \
  --policy-name BedrockInvokeClaude \
  --policy-document file://iam/bedrock-policy.json

# Permission to pull the image from ECR (step 3)
aws iam attach-role-policy --role-name NovaAssistantEC2Role \
  --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly

# Optional: lets you use SSM Session Manager instead of SSH
aws iam attach-role-policy --role-name NovaAssistantEC2Role \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore

# Instance profile = the "container" that attaches a role to an EC2 instance
aws iam create-instance-profile --instance-profile-name NovaAssistantEC2Profile
aws iam add-role-to-instance-profile --instance-profile-name NovaAssistantEC2Profile \
  --role-name NovaAssistantEC2Role
```

If you change `BEDROCK_MODEL_ID`, update the ARNs in `iam/bedrock-policy.json` to match.

## 2. Attach the role to your EC2 instance

New instance: choose **IAM instance profile → NovaAssistantEC2Profile** in the launch wizard.

Existing instance:

```bash
aws ec2 associate-iam-instance-profile --instance-id i-xxxxxxxx \
  --iam-instance-profile Name=NovaAssistantEC2Profile
```

**Important for Docker — IMDS hop limit.** A container sits one network hop
behind the host, so the metadata service must allow 2 hops or boto3 inside the
container will fail with `NoCredentialsError`:

```bash
aws ec2 modify-instance-metadata-options --instance-id i-xxxxxxxx \
  --http-tokens required --http-put-response-hop-limit 2 --http-endpoint enabled
```

## 3. Push the image to Amazon ECR

From your laptop:

```bash
REGION=us-east-1
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REPO=$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/nova-assistant

aws ecr create-repository --repository-name nova-assistant --region $REGION   # first time only
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com

# EC2 is usually x86_64; use linux/arm64 for Graviton (t4g, m7g, ...)
docker build --platform linux/amd64 -t $REPO:latest .
docker push $REPO:latest
```

## 4. Run on the EC2 instance

Connect (SSH or `aws ssm start-session --target i-xxxxxxxx`), then on Amazon Linux 2023:

```bash
sudo dnf install -y docker
sudo systemctl enable --now docker

REGION=us-east-1
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)   # uses the instance role
REPO=$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com/nova-assistant

aws ecr get-login-password --region $REGION | sudo docker login --username AWS --password-stdin $ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com
sudo docker pull $REPO:latest

sudo docker run -d --name nova \
  --restart unless-stopped \
  -p 80:8000 \
  -v nova-data:/data \
  -e AWS_REGION=$REGION \
  $REPO:latest
```

Note: no `-v ~/.aws` and no `AWS_ACCESS_KEY_ID` — credentials come from the role.
The `nova-data` volume keeps the SQLite chat history across container restarts/upgrades.

## 5. Verify

```bash
curl http://localhost/api/health
# {"ok": true, "account": "...", ...}

sudo docker exec nova python -c "import boto3; print(boto3.client('sts').get_caller_identity()['Arn'])"
# arn:aws:sts::<account>:assumed-role/NovaAssistantEC2Role/i-xxxxxxxx   <- role, not your IAM user
```

Open `http://<instance-public-ip>/` in a browser.

## 6. Security group

Allow inbound TCP **80** only from your IP (e.g. `203.0.113.10/32`).

> ⚠️ The app has **no login**. Anyone who can reach it can chat — and every message
> is billed to your AWS account. Keep the security group restricted, or put it behind
> authentication (e.g. an ALB with Cognito) before opening it to the internet.
> For HTTPS, put an Application Load Balancer with an ACM certificate in front.

## Updating

```bash
# laptop
docker build --platform linux/amd64 -t $REPO:latest . && docker push $REPO:latest
# EC2
sudo docker pull $REPO:latest && sudo docker rm -f nova && sudo docker run -d --name nova \
  --restart unless-stopped -p 80:8000 -v nova-data:/data -e AWS_REGION=us-east-1 $REPO:latest
```

## Troubleshooting

| Error | Cause / fix |
|-------|-------------|
| `NoCredentialsError` / "Unable to locate credentials" | Role not attached, or IMDS hop limit is 1 → step 2 |
| `AccessDeniedException` on converse | Role policy missing the model/inference-profile ARN → `iam/bedrock-policy.json` |
| `ThrottlingException` | Bedrock quota; the app retries automatically with backoff |
| `exec format error` | Image arch ≠ instance arch → rebuild with the right `--platform` |

## Local testing

```bash
docker compose up --build     # http://localhost:8000, uses your ~/.aws (read-only)
AWS_PROFILE=myprofile docker compose up   # use a non-default profile
```

---

## Automatic deployment (GitHub Actions)

Every push to `main` runs [.github/workflows/deploy.yml](.github/workflows/deploy.yml):

1. **Build & test:** checks Python syntax, builds the Docker image, starts it and checks `/healthz`, the login redirect and the protected API.
2. **Push:** tags the image `git-<commit>` and `latest` and pushes it to ECR.
3. **Deploy:** runs `scripts/deploy-on-ec2.sh git-<commit>` on the instance through **SSM Run Command**, so port 22 stays closed. If the new container fails its health check, the script **rolls back** to the previous image and the workflow fails.

Pull requests run step 1 only. Every push to `main` deploys, even one that changes only documentation. You can also run the workflow by hand: **Actions → Build & Deploy → Run workflow**.

### One-time setup

GitHub gets temporary AWS credentials through **OIDC**, so no AWS keys are stored in GitHub. The role trusts only pushes to `main` of `danaiiir/gde-example`.

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
INSTANCE_ID=i-xxxxxxxxxxxxxxxxx

# 1. GitHub OIDC provider (once per AWS account; skip if it already exists)
aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com

# 2. Deploy role for GitHub Actions
sed "s/<ACCOUNT_ID>/$ACCOUNT_ID/g; s/<INSTANCE_ID>/$INSTANCE_ID/g" iam/github-oidc-trust-policy.json > /tmp/trust.json
sed "s/<ACCOUNT_ID>/$ACCOUNT_ID/g; s/<INSTANCE_ID>/$INSTANCE_ID/g" iam/github-deploy-policy.json   > /tmp/deploy.json
aws iam create-role --role-name GitHubActions-gde-example-deploy --assume-role-policy-document file:///tmp/trust.json
aws iam put-role-policy --role-name GitHubActions-gde-example-deploy --policy-name DeployNovaAssistant --policy-document file:///tmp/deploy.json

# 3. Let the instance receive SSM commands
aws iam attach-role-policy --role-name NovaAssistantEC2Role \
  --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
```

Then in GitHub, go to **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret | Value |
|---|---|
| `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::<account>:role/GitHubActions-gde-example-deploy` |
| `EC2_INSTANCE_ID` | `i-xxxxxxxxxxxxxxxxx` |
