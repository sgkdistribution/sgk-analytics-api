#!/usr/bin/env bash
# ===========================================================================
# ONE PASTE. FINISHES THE BOX. Works whether it came from the snapshot or
# from a blank Ubuntu image — it looks and decides for itself.
#
# Open the browser terminal on sgk-analytics-api-dashboard-2, press
# "Paste into terminal", paste ALL of this, press Enter. Then wait.
# ===========================================================================
sudo bash <<'SGKEOF'
set +e
DOMAIN=analytics.sgkhomedelivery.co.uk
REPO=https://github.com/sgkdistribution/sgk-analytics-api.git
APP=/opt/sgk-analytics-api
export DEBIAN_FRONTEND=noninteractive

echo; echo "############ 1. WHAT AM I LOOKING AT ############"
echo "public IP of this box : $(curl -s --max-time 10 https://checkip.amazonaws.com || echo UNKNOWN)"
echo "   (must be 13.63.79.110 — that is the one Go2Stream lets through)"
[ -d "$APP" ] && echo "the code       : ALREADY HERE (this came from the snapshot)" \
              || echo "the code       : NOT HERE (blank Ubuntu — installing it now)"
[ -f /etc/sgk-analytics.env ] \
  && echo "the secrets    : HERE, $(grep -o '"companyId"' /etc/sgk-analytics.env | wc -l) companies configured" \
  || echo "the secrets    : MISSING — see the end of this output"
df -h / | tail -1

echo; echo "############ 2. SWAP + LOG CAP ############"
# 512MB with no swap is how the last box died: Linux runs out of memory, kills
# whatever it likes, and you get a machine that pings but answers nothing.
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "2GB swap ON"
else echo "swap already there"; fi
mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=200M\n' > /etc/systemd/journald.conf.d/size.conf
systemctl restart systemd-journald
echo "logs capped at 200MB so a crash loop can never fill the disk again"

echo; echo "############ 3. NODE + CADDY ############"
apt-get update -y -qq
apt-get install -y -qq curl git ca-certificates gnupg apt-transport-https debian-keyring debian-archive-keyring
if ! node -v 2>/dev/null | grep -q '^v2'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs
fi
node -v 2>/dev/null | grep -q '^v2' || {
  curl -fsSL https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-x64.tar.xz -o /tmp/n.tar.xz \
  && tar -xJf /tmp/n.tar.xz -C /usr/local --strip-components=1 \
  && ln -sf /usr/local/bin/node /usr/bin/node && ln -sf /usr/local/bin/npm /usr/bin/npm; }
echo "node $(node -v 2>/dev/null || echo MISSING)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y -qq && apt-get install -y -qq caddy
fi
echo "caddy $(caddy version 2>/dev/null | head -1 || echo MISSING)"

echo; echo "############ 4. THE CODE ############"
if [ -d "$APP/.git" ]; then git -C "$APP" fetch --all -q && git -C "$APP" reset --hard origin/main -q
else git clone -q "$REPO" "$APP"; fi
chown -R ubuntu:ubuntu "$APP"
cd "$APP" && sudo -u ubuntu npm install --omit=dev --silent
echo "commit on the box: $(git -C "$APP" rev-parse --short HEAD 2>/dev/null)"
[ -f "$APP/schema.js" ] && echo "schema.js present — this IS the fixed version" || echo "schema.js MISSING — the pull failed"

echo; echo "############ 5. SERVICE + HTTPS ############"
cp "$APP/deploy/sgk-analytics-api.service" /etc/systemd/system/
systemctl daemon-reload && systemctl enable -q sgk-analytics-api
printf '%s {\n    reverse_proxy 127.0.0.1:8080\n}\n' "$DOMAIN" > /etc/caddy/Caddyfile
systemctl restart caddy
systemctl restart sgk-analytics-api
sleep 6
systemctl is-active --quiet sgk-analytics-api && echo "service RUNNING" || { echo "service DID NOT START:"; journalctl -u sgk-analytics-api -n 15 --no-pager; }

echo; echo "############ 6. DOES IT WORK ############"
curl -s --max-time 30 localhost:8080/health; echo; echo
if [ ! -f /etc/sgk-analytics.env ]; then
cat <<'MSG'
###########################################################################
 THE SECRETS FILE IS MISSING — this box came from a blank Ubuntu image.
 Everything else is built and running. This is the only thing left.

 Run:   sudo nano /etc/sgk-analytics.env
 Paste the block below, fill in the four CHANGE_ME values from
 Railway -> SGK Analytics API -> Variables, then:
        sudo chmod 600 /etc/sgk-analytics.env
        sudo systemctl restart sgk-analytics-api
        curl -s localhost:8080/health
###########################################################################
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
CLIENT_MAP=CHANGE_ME
MSG
fi
echo "=========================================================="
echo " db: connected         -> DONE. Open the portal."
echo " db: connect ETIMEDOUT -> the static IP is not on this box."
echo " schema: renamed/...   -> those are the columns that moved."
echo "=========================================================="
SGKEOF