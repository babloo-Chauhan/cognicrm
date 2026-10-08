#!/usr/bin/env bash
# CogniEOS CRM deploy / update script. Idempotent: safe to re-run.
# Run ON THE SERVER (13.201.75.245) as a sudo-capable user:
#   curl/clone the repo, then:  bash deploy/deploy.sh
#
# What it does:
#   1. pulls latest code into /var/www/cognicrm
#   2. installs backend deps, ensures backend/.env exists
#   3. builds the frontend (same-origin API, so it works behind nginx)
#   4. (re)starts the backend under PM2 on a free port
#   5. writes the API port into the nginx site and reloads nginx
set -euo pipefail

APP_DIR="${APP_DIR:-/var/www/cognicrm}"
REPO="${REPO:-git@github.com:babloo-Chauhan/cognicrm.git}"
BRANCH="${BRANCH:-main}"
DOMAIN="${DOMAIN:-crm.cognieos.in}"
# Base port to try. 5000 is often already taken by another app on the box, so
# default to a less-common one; we still auto-pick a free port if it's in use.
API_PORT="${API_PORT:-5055}"

echo "==> CogniEOS CRM deploy  (dir=$APP_DIR branch=$BRANCH domain=$DOMAIN)"

# --- 0. prerequisites -------------------------------------------------------
command -v node >/dev/null || { echo "node not found. Install Node 20+ first."; exit 1; }
command -v pm2  >/dev/null || { echo "pm2 not found -> npm i -g pm2"; sudo npm i -g pm2; }

# Is a TCP port being LISTENed on (by anything other than our own app)?
port_in_use() {
  if command -v ss >/dev/null; then
    ss -ltnH "sport = :$1" 2>/dev/null | grep -q .
  else
    (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null && { exec 3>&- 3<&-; return 0; } || return 1
  fi
}
# Pick the first free port at/after the base, so we never collide with another service.
pick_free_port() {
  local p="$1"
  for _ in $(seq 0 20); do
    port_in_use "$p" || { echo "$p"; return 0; }
    p=$((p+1))
  done
  echo "$1"  # fallback: give back the base
}

# --- 1. code ----------------------------------------------------------------
if [ ! -d "$APP_DIR/.git" ]; then
  echo "==> cloning $REPO"
  sudo mkdir -p "$APP_DIR"
  sudo chown -R "$USER":"$USER" "$APP_DIR"
  git clone "$REPO" "$APP_DIR"
fi
cd "$APP_DIR"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git reset --hard "origin/$BRANCH"

# --- 2. backend -------------------------------------------------------------
echo "==> backend deps"
cd "$APP_DIR/backend"
npm install --omit=dev --no-audit --no-fund

# Stop our own process first so it releases its port before we choose one.
pm2 delete cognicrm-api >/dev/null 2>&1 || true

# Set KEY=VALUE in .env, replacing the line if present or appending it.
set_env() {
  local key="$1" val="$2"
  if grep -qE "^${key}=" .env; then
    # use a non-/ delimiter since values contain https:// and slashes
    sed -i "s#^${key}=.*#${key}=${val}#" .env
  else
    printf '%s=%s\n' "$key" "$val" >> .env
  fi
}

if [ ! -f .env ]; then
  echo "!! backend/.env missing. Creating from .env.example — EDIT IT before go-live."
  cp .env.example .env
  # generate secrets if they are blank (only on first creation)
  set_env JWT_SECRET         "$(openssl rand -hex 32)"
  set_env ENCRYPTION_KEY     "$(openssl rand -hex 32)"
  set_env URL_SIGNING_SECRET "$(openssl rand -hex 32)"
  echo "   -> wrote backend/.env (MONGO_URI defaults to local mongodb; set it if using Atlas)"
fi

# Always enforce deployment-derived values (safe to overwrite; not secrets).
# This fixes a stale .env whose CORS_ORIGIN still pointed at localhost.
set_env NODE_ENV        production
set_env PUBLIC_BASE_URL "https://${DOMAIN}"
set_env CORS_ORIGIN     "https://${DOMAIN}"
set_env FRONTEND_URL    "https://${DOMAIN}"

# Choose the API port: keep the one in .env if it is free, else pick a free one.
# (Our own app is already stopped above, so a busy port means ANOTHER service.)
CUR_PORT="$(grep -E '^PORT=' .env | head -1 | cut -d= -f2 | tr -d '[:space:]')"
if [ -n "$CUR_PORT" ] && ! port_in_use "$CUR_PORT"; then
  API_PORT="$CUR_PORT"
else
  API_PORT="$(pick_free_port "${API_PORT}")"
  [ -n "$CUR_PORT" ] && echo "   port $CUR_PORT is taken by another service -> using free port $API_PORT"
fi
# Persist the chosen port into .env (add the line if missing).
if grep -qE '^PORT=' .env; then
  sed -i "s#^PORT=.*#PORT=${API_PORT}#" .env
else
  printf '\nPORT=%s\n' "${API_PORT}" >> .env
fi
echo "   backend will listen on 127.0.0.1:${API_PORT}"

# --- 3. frontend ------------------------------------------------------------
echo "==> frontend build (same-origin API)"
cd "$APP_DIR/frontend"
npm install --no-audit --no-fund
# Same-origin: the app calls whatever host/scheme served it, so it can never
# point at the wrong domain and there is no http/https mixed-content problem.
cat > .env.production.local <<EOF
VITE_API_URL=/api/v1
VITE_SOCKET_URL=/
EOF
npm run build
echo "   -> built $APP_DIR/frontend/dist"

# --- 4. pm2 -----------------------------------------------------------------
echo "==> pm2"
sudo mkdir -p /var/log/cognicrm
sudo chown -R "$USER":"$USER" /var/log/cognicrm
cd "$APP_DIR"
pm2 start deploy/ecosystem.config.cjs --update-env
pm2 save

# Verify OUR backend actually came up on API_PORT before wiring nginx to it.
# (Prevents nginx from proxying /api to some other app if ours crashed, e.g. no MongoDB.)
echo "==> verifying backend on 127.0.0.1:${API_PORT}"
ok=""
for i in $(seq 1 15); do
  body="$(curl -fsS -m 5 "http://127.0.0.1:${API_PORT}/health" 2>/dev/null || true)"
  if printf '%s' "$body" | grep -q '"status"'; then ok=1; echo "   backend healthy: $body"; break; fi
  sleep 2
done
if [ -z "$ok" ]; then
  echo "!! Backend did not become healthy on 127.0.0.1:${API_PORT}."
  echo "   Most likely MongoDB is unreachable (set MONGO_URI in backend/.env) or the app crashed."
  echo "   Recent logs:"; pm2 logs cognicrm-api --lines 25 --nostream || true
  exit 1
fi

# --- 5. nginx ---------------------------------------------------------------
echo "==> nginx site for $DOMAIN (API port $API_PORT)"
SITE=/etc/nginx/sites-available/$DOMAIN
sudo cp deploy/nginx-crm.cognieos.in.conf "$SITE"
sudo sed -i "s/__API_PORT__/${API_PORT}/g; s/crm.cognieos.in/${DOMAIN}/g" "$SITE"
sudo ln -sf "$SITE" /etc/nginx/sites-enabled/$DOMAIN
sudo nginx -t
sudo systemctl reload nginx

# --- 6. SSL (Let's Encrypt via certbot) -------------------------------------
# Idempotent: certbot skips reissue if a valid cert exists and only renews near
# expiry. Non-fatal so a TLS hiccup never breaks the app deploy.
# Control with: ENABLE_SSL=false to skip; CERTBOT_EMAIL=you@example.com for renewal notices.
if [ "${ENABLE_SSL:-true}" != "false" ]; then
  echo "==> SSL for $DOMAIN (certbot)"
  if ! command -v certbot >/dev/null; then
    echo "   installing certbot…"
    sudo apt-get update -y && sudo apt-get install -y certbot python3-certbot-nginx
  fi
  if [ -n "${CERTBOT_EMAIL:-}" ]; then
    EMAIL_ARG="-m ${CERTBOT_EMAIL} --agree-tos"
  else
    EMAIL_ARG="--register-unsafely-without-email --agree-tos"
  fi
  # Obtain + install the cert for this host and add the HTTP->HTTPS redirect.
  sudo certbot --nginx -d "$DOMAIN" --non-interactive --redirect $EMAIL_ARG \
    && sudo systemctl reload nginx \
    && echo "   -> HTTPS enabled for https://$DOMAIN" \
    || echo "   !! certbot failed (check DNS -> this host, port 80 open, and rate limits). App still serves on HTTP."
else
  echo "==> SSL skipped (ENABLE_SSL=false)"
fi

echo ""
echo "==> done."
echo "    Local health check:"
curl -fsS "http://127.0.0.1:${API_PORT}/health" && echo " (backend OK)" || echo " (backend NOT responding — check: pm2 logs cognicrm-api)"
echo ""
echo "    App:  https://${DOMAIN}/   API: https://${DOMAIN}/api/v1/   health: https://${DOMAIN}/health"
