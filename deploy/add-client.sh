#!/usr/bin/env bash
# ===========================================================================
# ADD A COMPANY TO THE DASHBOARDS (or put one right that is already there).
#
# Run it on the analytics box (sgk-analytics-live), in the browser terminal:
#
#     sudo bash /opt/sgk-analytics-api/deploy/add-client.sh
#
# It asks three questions, finds the company's client name(s) in the delivery
# system itself, shows you exactly what it will save, and only writes once you
# say yes. Then it proves the lockdown — the company's own login sees its
# dashboard, a second company with the same name does not — and restarts the
# service. A dated copy of the settings file is kept before anything changes.
# ===========================================================================
set -euo pipefail

APP=/opt/sgk-analytics-api
ENVF=/etc/sgk-analytics.env

[ "$(id -u)" = 0 ] || { echo "Run it with sudo:  sudo bash $APP/deploy/add-client.sh"; exit 1; }
[ -f "$ENVF" ] || { echo "The settings file $ENVF is missing — nothing to add to."; exit 1; }
[ -f "$APP/deploy/add-client.mjs" ] || { echo "The code is out of date — update it first (see the top of this file)."; exit 1; }

cd "$APP"
exec node "$APP/deploy/add-client.mjs" "$@"
