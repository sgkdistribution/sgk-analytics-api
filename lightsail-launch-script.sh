#!/usr/bin/env bash
# ===========================================================================
# SGK ANALYTICS API — LIGHTSAIL LAUNCH SCRIPT
#
# WHAT THIS IS FOR.
#
# You cannot get into the current box. Not through the browser terminal, not
# through your own SSH client, not after a reboot, not after a full power
# cycle. So this does not try. It is pasted into the "Launch script" box when
# you CREATE a new instance, and Lightsail runs it as root on the first boot,
# before anything else — no login required at any point.
#
# It builds the whole service: Node, Caddy, HTTPS, the code from GitHub, the
# systemd unit, the secrets file. Then it writes everything it did to a page
# you can open in a browser:
#
#     https://analytics.sgkhomedelivery.co.uk/setup-log
#
# That page is how you watch this work. You never need a terminal.
#
# IT ALSO FIXES TWO THINGS THAT PROBABLY KILLED THE FIRST BOX (see further
# down): no swap on a 512MB machine, and no cap on the log files.
#
# ---------------------------------------------------------------------------
# BEFORE YOU PASTE THIS IN — READ THE NEXT 20 LINES.
#
# If you are creating the new instance FROM A SNAPSHOT of the broken one,
# leave the block below exactly as it is. The old /etc/sgk-analytics.env comes
# across on the snapshot with your full CLIENT_MAP in it, and this script will
# not touch it.
#
# If you are creating from a plain Ubuntu image, that file does not exist and
# the service has nothing to connect to. Fill the block in first. Every value
# except CLIENT_MAP is in Railway -> SGK Analytics API -> Variables. Open that
# tab, copy each one across.
#
# CLIENT_MAP is the one Railway cannot give you in full — its copy has only
# 2 companies in it. That is why the snapshot route is worth trying first.
# ===========================================================================

WRITE_ENV_FILE=no          # <-- set to yes ONLY if building from plain Ubuntu

SQL_PASSWORD_VALUE=''      # Railway -> Variables -> SQL_PASSWORD
COGNITO_USER_POOL_ID_VALUE=''
COGNITO_CLIENT_ID_VALUE=''
CLIENT_MAP_VALUE=''        # the whole [{...}] JSON, on one line, in quotes

# ===========================================================================
# Nothing below here needs editing.
# ===========================================================================

DOMAIN=analytics.sgkhomedelivery.co.uk
REPO=https://github.com/sgkdistribution/sgk-analytics-api.git
APP_DIR=/opt/sgk-analytics-api
LOG_DIR=/var/www/setup
LOG=$LOG_DIR/setup.log

mkdir -p "$LOG_DIR"

# Everything from here on is written to the log page AND to the console.
# No `set -e`: if one step fails the rest must still run, because a script that
# dies silently on a box you cannot log into tells you nothing at all. Each
# step reports its own result instead.
exec > >(tee -a "$LOG") 2>&1

say () { echo; echo "=== $* ==="; }
ok  () { echo "    OK      $*"; }
bad () { echo "    FAILED  $*"; }

echo "SGK Analytics API — build started $(date -u '+%Y-%m-%d %H:%M:%S UTC')"

# ---------------------------------------------------------------------------
# 1. WHAT STATE DID WE INHERIT?
#
# If this is a snapshot restore, this section is the post-mortem on the box
# that stopped answering. A disk at 100% is the single most common reason for
# an instance that pings, shows metrics, keeps its firewall — and refuses every
# connection, because sshd cannot write its session files and Caddy cannot
# write its certificate store. It survives a reboot because the disk is still
# full afterwards. That would fit your symptoms exactly.
# ---------------------------------------------------------------------------
say "Inherited state — this tells us what killed the old box"
df -h /
free -m
echo "    (if / was at 100% on the snapshot, that is your answer)"

# ---------------------------------------------------------------------------
# 2. SWAP — 512MB of RAM is not enough to run Node and Caddy safely.
#
# With no swap, Linux has one move when it runs out of memory: kill something.
# It picks whatever is using the most, which on this box is Node — but if it
# picks sshd, or if the kernel spends its time thrashing instead, you get a
# machine that is powered on, reports metrics, and answers nothing. Which is
# what you have been looking at all afternoon.
#
# 2GB of swap costs nothing and removes that failure entirely.
# ---------------------------------------------------------------------------
say "Adding swap"
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile \
    && grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  ok "2GB swap on, and it will come back after a reboot"
else
  ok "swap already present"
fi
sysctl -w vm.swappiness=10 >/dev/null

# ---------------------------------------------------------------------------
# 3. CAP THE LOGS.
#
# The service is set to Restart=always with a 5 second gap. If it ever gets
# into a crash loop again it writes a stack trace every 5 seconds, forever.
# Uncapped, that fills the disk and takes the whole box down with it. Capped
# at 200MB it cannot.
# ---------------------------------------------------------------------------
say "Capping the system logs at 200MB"
mkdir -p /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/size.conf <<'EOF'
[Journal]
SystemMaxUse=200M
SystemMaxFileSize=20M
EOF
systemctl restart systemd-journald && ok "capped" || bad "could not cap the journal"

# ---------------------------------------------------------------------------
# 4. PACKAGES
# ---------------------------------------------------------------------------
say "Updating and installing the basics"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y curl git ca-certificates debian-keyring debian-archive-keyring apt-transport-https gnupg

say "Installing Node 20"
if ! command -v node >/dev/null || [[ "$(node -v 2>/dev/null)" != v2[0-9]* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt-get install -y nodejs
fi
# If the NodeSource repository is having a bad day — and it was refusing
# requests earlier today — fall back to the official tarball rather than
# leaving the box with no Node on it at all.
if ! command -v node >/dev/null || [[ "$(node -v 2>/dev/null)" != v2[0-9]* ]]; then
  bad "NodeSource did not work, using the official tarball instead"
  curl -fsSL https://nodejs.org/dist/v20.18.1/node-v20.18.1-linux-x64.tar.xz -o /tmp/node.tar.xz \
    && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 \
    && ln -sf /usr/local/bin/node /usr/bin/node && ln -sf /usr/local/bin/npm /usr/bin/npm
fi
command -v node >/dev/null && ok "node $(node -v)" || bad "NO NODE — the service cannot start"

say "Installing Caddy (this is what gives you HTTPS automatically)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi
command -v caddy >/dev/null && ok "caddy installed" || bad "NO CADDY — there will be no HTTPS"

# ---------------------------------------------------------------------------
# 5. THE CODE
# ---------------------------------------------------------------------------
say "Fetching the service from GitHub"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --all && git -C "$APP_DIR" reset --hard origin/main
else
  git clone "$REPO" "$APP_DIR"
fi
chown -R ubuntu:ubuntu "$APP_DIR"
cd "$APP_DIR" && sudo -u ubuntu npm install --omit=dev
echo "    commit now on the box: $(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null)"
[ -f "$APP_DIR/schema.js" ] && ok "schema.js is present — this is the fixed version" \
                           || bad "schema.js missing — the pull did not work"

# ---------------------------------------------------------------------------
# 6. THE SECRETS
#
# An existing file is NEVER overwritten. On a snapshot restore that file is
# your only full copy of CLIENT_MAP, and losing it would mean rebuilding every
# company mapping by hand.
# ---------------------------------------------------------------------------
say "Secrets file"
if [ -f /etc/sgk-analytics.env ]; then
  ok "/etc/sgk-analytics.env already exists — left completely alone"
  echo "    companies configured: $(grep -o '"companyId"' /etc/sgk-analytics.env | wc -l)"
elif [ "$WRITE_ENV_FILE" = "yes" ]; then
  cat > /etc/sgk-analytics.env <<EOF
PORT=8080

SQL_SERVER=146.148.124.120
SQL_PORT=3306
SQL_DATABASE=stream_data_extract_sgk
SQL_USER=sgk_analytics
SQL_PASSWORD=${SQL_PASSWORD_VALUE}
SQL_ENCRYPT=true
SQL_TRUST_CERT=true

COGNITO_REGION=eu-north-1
COGNITO_USER_POOL_ID=${COGNITO_USER_POOL_ID_VALUE}
COGNITO_CLIENT_ID=${COGNITO_CLIENT_ID_VALUE}
SGK_DOMAINS=sgkhomedelivery.co.uk

ALLOWED_ORIGINS=https://portal.sgkhomedelivery.co.uk,https://sgkhomedelivery.co.uk
CACHE_TTL_MS=45000

CLIENT_MAP=${CLIENT_MAP_VALUE}
EOF
  chmod 600 /etc/sgk-analytics.env
  ok "written from the values pasted into this script"
  echo "    NOTE: no schema mapping lines are set, and that is deliberate."
  echo "    schema.js reads the real table and column names off the database"
  echo "    itself now, so pinning them here would only get in its way."
else
  bad "NO SECRETS FILE. The service will start and answer /health, but every"
  echo "            dashboard will say the database is not connected. Either"
  echo "            rebuild from the snapshot, or set WRITE_ENV_FILE=yes and"
  echo "            fill in the block at the top."
fi

# ---------------------------------------------------------------------------
# 7. SYSTEMD AND CADDY
# ---------------------------------------------------------------------------
say "Installing the service"
cp "$APP_DIR/deploy/sgk-analytics-api.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable sgk-analytics-api
systemctl restart sgk-analytics-api
sleep 5
systemctl is-active --quiet sgk-analytics-api && ok "service is running" || bad "service did not start"

say "Putting Caddy in front"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    handle /setup-log {
        root * $LOG_DIR
        rewrite * /setup.log
        file_server
    }
    handle {
        reverse_proxy 127.0.0.1:8080
    }
}
EOF
systemctl restart caddy && ok "caddy restarted" || bad "caddy did not restart"

# ---------------------------------------------------------------------------
# 8. DOES IT ACTUALLY WORK?
#
# The last thing this does is call the service and print the answer, so the
# log page tells you whether you are finished — including, at last, whether
# anything in the extract has changed.
# ---------------------------------------------------------------------------
say "Asking the service how it is"
sleep 5
curl -s --max-time 30 localhost:8080/health || bad "no answer on port 8080"
echo
echo
echo "==========================================================="
echo " Build finished $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo
echo " READ THE health LINE ABOVE."
echo "   db: connected          -> you are done. Load the portal."
echo "   db: connect ETIMEDOUT  -> the static IP is not on this box yet."
echo "                             Move it, then reload this page."
echo "   schema: renamed/...    -> those are the columns that moved in your"
echo "                             extract. Send me that line."
echo "==========================================================="
chmod -R a+r "$LOG_DIR"