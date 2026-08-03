#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# SGK ANALYTICS API — one-shot setup for a fresh Ubuntu box on AWS Lightsail.
#
# Run it once, as ubuntu, on the new instance:
#     curl -fsSL <this file> -o setup.sh && bash setup.sh
# or just paste the whole thing into the browser SSH window.
#
# What it does:
#   * installs Node 20 and Caddy
#   * pulls the service from GitHub into /opt/sgk-analytics-api
#   * creates /etc/sgk-analytics.env for the secrets (chmod 600, root only)
#   * runs the service under systemd so it restarts on crash and on reboot
#   * puts Caddy in front for automatic HTTPS on your subdomain
#
# Nothing here writes to your database. Nothing here is specific to one client.
# ---------------------------------------------------------------------------
set -euo pipefail

REPO="${REPO:-https://github.com/sgkdistribution/sgk-analytics-api.git}"
DOMAIN="${DOMAIN:-analytics.sgkhomedelivery.co.uk}"
APP_DIR=/opt/sgk-analytics-api

echo "==> Updating the box"
sudo apt-get update -y
sudo apt-get install -y curl git ca-certificates debian-keyring debian-archive-keyring apt-transport-https

echo "==> Installing Node 20"
if ! command -v node >/dev/null || [[ "$(node -v)" != v20* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node -v

echo "==> Installing Caddy (handles HTTPS certificates automatically)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -y
  sudo apt-get install -y caddy
fi

echo "==> Fetching the service"
if [ -d "$APP_DIR/.git" ]; then
  sudo git -C "$APP_DIR" pull
else
  sudo git clone "$REPO" "$APP_DIR"
fi
sudo chown -R ubuntu:ubuntu "$APP_DIR"
cd "$APP_DIR"
npm install --omit=dev

echo "==> Creating the secrets file (if it is not already there)"
if [ ! -f /etc/sgk-analytics.env ]; then
  sudo tee /etc/sgk-analytics.env >/dev/null <<'ENVEOF'
# EVERY value goes here. This file is root-only and never leaves the box.
PORT=8080

SQL_SERVER=146.148.124.120
SQL_PORT=3306
SQL_DATABASE=stream_data_extract_sgk
SQL_USER=sgk_analytics
SQL_PASSWORD=CHANGE_ME
SQL_ENCRYPT=true
SQL_TRUST_CERT=true

COGNITO_REGION=eu-north-1
COGNITO_USER_POOL_ID=CHANGE_ME
COGNITO_CLIENT_ID=CHANGE_ME
SGK_DOMAINS=sgkhomedelivery.co.uk

ALLOWED_ORIGINS=https://portal.sgkhomedelivery.co.uk,https://sgkhomedelivery.co.uk
CACHE_TTL_MS=45000

CLIENT_MAP=[{"companyId":"roseland","name":"Roseland Furniture","sqlKey":"CHANGE_ME","domains":[],"emails":["info@sgkdistribution.co.uk"]},{"companyId":"bedroomking","name":"Bedroom King","sqlKey":"CHANGE_ME","domains":["bedroomking.co.uk"],"emails":["info@bedroomking.co.uk"]}]

# Schema mapping — corrected once the discovery output is in.
SQL_ORDERS_TABLE=orders
SQL_ORDERS_CLIENT_COL=PartnerName
SQL_ORDERS_STATUS_COL=OrderStatusName
SQL_ORDERS_CREATED_COL=OrderDate
ENVEOF
  sudo chmod 600 /etc/sgk-analytics.env
  echo "    -> created /etc/sgk-analytics.env — EDIT IT before the service will work"
fi

echo "==> Installing the systemd service"
sudo cp "$APP_DIR/deploy/sgk-analytics-api.service" /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable sgk-analytics-api
sudo systemctl restart sgk-analytics-api

echo "==> Pointing Caddy at it"
sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDYEOF
$DOMAIN {
    reverse_proxy localhost:8080
}
CADDYEOF
sudo systemctl restart caddy

echo
echo "=========================================================="
echo " Done."
echo
echo " 1. Edit the secrets:   sudo nano /etc/sgk-analytics.env"
echo " 2. Restart:            sudo systemctl restart sgk-analytics-api"
echo " 3. Check it:           curl localhost:8080/health"
echo " 4. From anywhere:      https://$DOMAIN/health"
echo
echo " Logs:                  sudo journalctl -u sgk-analytics-api -f"
echo "=========================================================="
