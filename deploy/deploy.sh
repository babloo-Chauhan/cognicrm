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
API_PORT="${API_PORT:-5000}"

echo "==> CogniEOS CRM deploy  (dir=$APP_DIR branch=$BRANCH domain=$DOMAIN)"

# --- 0. prerequisites -------------------------------------------------------
command -v node >/dev/null || { echo "node not found. Install Node 20+ first."; exit 1; }
command -v pm2  >/dev/null || { echo "pm2 not found -> npm i -g pm2"; sudo npm i -g pm2; }

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
if [ ! -f .env ]; then
  echo "!! backend/.env missing. Creating from .env.example — EDIT IT before go-live."
  cp .env.example .env
  # production-sane defaults
  sed -i "s#^NODE_ENV=.*#NODE_ENV=production#"                                   .env
  sed -i "s#^PORT=.*#PORT=${API_PORT}#"                                          .env
  sed -i "s#^PUBLIC_BASE_URL=.*#PUBLIC_BASE_URL=https://${DOMAIN}#"              .env
  sed -i "s#^CORS_ORIGIN=.*#CORS_ORIGIN=https://${DOMAIN}#"                      .env
  sed -i "s#^FRONTEND_URL=.*#FRONTEND_URL=https://${DOMAIN}#"                    .env
  # generate secrets if they are blank
  sed -i "s#^JWT_SECRET=.*#JWT_SECRET=$(openssl rand -hex 32)#"                 .env
  sed -i "s#^ENCRYPTION_KEY=.*#ENCRYPTION_KEY=$(openssl rand -hex 32)#"         .env
  sed -i "s#^URL_SIGNING_SECRET=.*#URL_SIGNING_SECRET=$(openssl rand -hex 32)#" .env
  echo "   -> wrote backend/.env (MONGO_URI defaults to local mongodb; set it if using Atlas)"
fi
# read the actual port the app will use
API_PORT="$(grep -E '^PORT=' .env | cut -d= -f2 | tr -d '[:space:]')"
API_PORT="${API_PORT:-5000}"

# --- 3. frontend ------------------------------------------------------------
echo "==> frontend build (same-origin API)"
cd "$APP_DIR/frontend"
npm install --no-audit --no-fund
# Build against the real domain. Empty values also work (relative), but set them
# explicitly so the bundle is unambiguous.
cat > .env.production.local <<EOF
VITE_API_URL=https://${DOMAIN}/api/v1
VITE_SOCKET_URL=https://${DOMAIN}
EOF
npm run build
echo "   -> built $APP_DIR/frontend/dist"

# --- 4. pm2 -----------------------------------------------------------------
echo "==> pm2"
sudo mkdir -p /var/log/cognicrm
sudo chown -R "$USER":"$USER" /var/log/cognicrm
cd "$APP_DIR"
pm2 startOrReload deploy/ecosystem.config.cjs --update-env
pm2 save

# --- 5. nginx ---------------------------------------------------------------
echo "==> nginx site for $DOMAIN (API port $API_PORT)"
SITE=/etc/nginx/sites-available/$DOMAIN
sudo cp deploy/nginx-crm.cognieos.in.conf "$SITE"
sudo sed -i "s/__API_PORT__/${API_PORT}/g; s/crm.cognieos.in/${DOMAIN}/g" "$SITE"
sudo ln -sf "$SITE" /etc/nginx/sites-enabled/$DOMAIN
sudo nginx -t
sudo systemctl reload nginx

echo ""
echo "==> done."
echo "    Local health check:"
curl -fsS "http://127.0.0.1:${API_PORT}/health" && echo " (backend OK)" || echo " (backend NOT responding — check: pm2 logs cognicrm-api)"
echo ""
echo "    Next: enable HTTPS ->  sudo certbot --nginx -d ${DOMAIN}"
echo "    Then: https://${DOMAIN}/  and  https://${DOMAIN}/api/v1/..."
