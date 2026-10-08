# Deploying CogniEOS CRM to crm.cognieos.in

Target server: `13.201.75.245` · App dir: `/var/www/cognicrm` · Domain: `crm.cognieos.in`

- Frontend (static React build) is served by nginx at `https://crm.cognieos.in/`
- Backend (Node/Express + Socket.IO) runs under PM2 on `127.0.0.1:5000`, proxied at `https://crm.cognieos.in/api` and `/socket.io`

---

## 1. One-time server bootstrap

SSH into the server, then install the runtime once:

```bash
# Node 20 + build tools
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs nginx git
sudo npm i -g pm2

# MongoDB — either install locally…
#   https://www.mongodb.com/docs/manual/tutorial/install-mongodb-on-ubuntu/
# …or use MongoDB Atlas and set MONGO_URI in backend/.env (recommended).
```

Point DNS: an **A record** for `crm.cognieos.in` → `13.201.75.245`.

## 2. First deploy

```bash
sudo mkdir -p /var/www/cognicrm && sudo chown -R $USER:$USER /var/www/cognicrm
git clone git@github.com:babloo-Chauhan/cognicrm.git /var/www/cognicrm
cd /var/www/cognicrm
bash deploy/deploy.sh
```

The script creates `backend/.env` from the example with generated secrets and production URLs.
**Edit `backend/.env`** to set `MONGO_URI`, `SUPER_ADMIN_EMAIL`/`SUPER_ADMIN_PASSWORD`, and any
provider keys (Twilio, Razorpay, Anthropic, …), then re-run `bash deploy/deploy.sh`.

## 3. HTTPS

```bash
sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d crm.cognieos.in
```

Certbot adds the `:443` block and HTTP→HTTPS redirect, and auto-renews.

## 4. CI/CD (GitHub Actions)

`.github/workflows/deploy.yml` tests on every push/PR and deploys on push to `main`.

Add these **repo secrets** (GitHub → Settings → Secrets and variables → Actions):

| Secret | Value |
|---|---|
| `EC2_HOST` | `13.201.75.245` |
| `EC2_USER` | the SSH login user on the server (e.g. `ubuntu`) |
| `EC2_SSH_KEY` | a **private** SSH key whose public half is in that user's `~/.ssh/authorized_keys` |
| `EC2_PORT` | `22` (optional) |

> Generate a dedicated deploy key on the server and authorize it:
> ```bash
> ssh-keygen -t ed25519 -f ~/.ssh/ci_deploy -N ""
> cat ~/.ssh/ci_deploy.pub >> ~/.ssh/authorized_keys
> cat ~/.ssh/ci_deploy   # paste THIS into the DEPLOY_SSH_KEY secret
> ```
> Do not reuse the GitHub deploy key for server login — keep repo-read and server-login keys separate.

After that, every push to `main` auto-deploys.

## 5. Useful ops

```bash
pm2 status
pm2 logs cognicrm-api
pm2 restart cognicrm-api
curl -s http://127.0.0.1:5000/health
sudo nginx -t && sudo systemctl reload nginx
```
