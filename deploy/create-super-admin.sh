#!/usr/bin/env bash
# Creates (or resets the password of) the super admin on the production server over SSH.
# Usage: bash deploy/create-super-admin.sh <path-to-key.pem> [email] [password]
# The server runs NODE_ENV=production, so the password must be 12+ characters.
set -euo pipefail

KEY="${1:?Usage: bash deploy/create-super-admin.sh <path-to-key.pem> [email] [password]}"
EMAIL="${2:-superadmin@gmail.com}"
PASSWORD="${3:-}"
HOST="${EC2_HOST:-13.201.75.245}"
USER_NAME="${EC2_USER:-ubuntu}"
APP_DIR="${APP_DIR:-/var/www/cognicrm}"

if [ -z "$PASSWORD" ]; then
  read -r -s -p "Password for $EMAIL (12+ chars): " PASSWORD; echo
fi
if [ "${#PASSWORD}" -lt 12 ]; then
  echo "Password must be at least 12 characters (production refuses shorter ones)." >&2
  exit 1
fi

# Password goes over stdin so it never appears in the remote process list or shell history.
printf '%s\n' "$PASSWORD" | ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$USER_NAME@$HOST" \
  "read -r PW && cd '$APP_DIR/backend' && npm run --silent create-super-admin -- '$EMAIL' \"\$PW\" 'Super Admin'"

echo "Done. Log in at https://crm.cognieos.in with $EMAIL"
