# Deploying the analytics service on AWS

Railway was the wrong home for this. The WMS database sits behind a firewall that
allowlists IP addresses, and Railway only offers a fixed outbound IP on its paid
Pro tier. AWS Lightsail gives you a permanent IP address included with a $5/month
instance — one address to allowlist, in the account you already run everything
else in.

**Total cost: about $5 a month.** An Elastic/static IP is free while attached to a
running instance.

---

## What you end up with

    portal.sgkhomedelivery.co.uk   (Amplify, as now)
              |
              |  HTTPS, carrying the user's Cognito token
              v
    analytics.sgkhomedelivery.co.uk   (Lightsail, ONE fixed IP)
              |
              |  MySQL over TLS, from that one IP
              v
    146.148.124.120:3306   (Go2Stream extract — allowlists that one IP)

---

## 1. Create the instance

1. AWS Console → search **Lightsail** → **Create instance**
2. Region: **Europe (Stockholm) eu-north-1** — same as everything else you run
3. Platform: **Linux/Unix**
4. Blueprint: **OS Only → Ubuntu 24.04 LTS**
5. Plan: the **$5/month** one (1 GB RAM). Plenty — this service answers a
   handful of queries a minute.
6. Name it `sgk-analytics-api`
7. **Create instance**

## 2. Give it a permanent address

1. Lightsail → **Networking** tab → **Create static IP**
2. Region: eu-north-1, attach it to `sgk-analytics-api`
3. Name it `sgk-analytics-ip` → **Create**
4. **Write this IP down.** It is the one your colleague allowlists, and it never
   changes.

## 3. Open the ports

Instance → **Networking** tab → **IPv4 Firewall**. Make sure these exist:

| Application | Protocol | Port |
|---|---|---|
| SSH | TCP | 22 |
| HTTP | TCP | 80 |
| HTTPS | TCP | 443 |

Port 80 is needed for the certificate to be issued, not just for traffic.

## 4. Point a subdomain at it

Wherever `sgkhomedelivery.co.uk` DNS is managed (Route 53 or your registrar), add:

    Type: A     Name: analytics     Value: <the static IP>

The portal is served over HTTPS, and a browser will refuse to call a plain HTTP
address from an HTTPS page. This subdomain is how the service gets its own
certificate, which Caddy then issues and renews on its own.

## 5. Install everything

Instance → **Connect using SSH** (the browser button — no key files, no PuTTY).
Then:

    curl -fsSL https://raw.githubusercontent.com/sgkdistribution/sgk-analytics-api/main/deploy/setup.sh -o setup.sh
    bash setup.sh

It installs Node and Caddy, pulls the repo, sets the service up under systemd so
it survives crashes and reboots, and gets the HTTPS certificate.

## 6. Put the real values in

    sudo nano /etc/sgk-analytics.env

Fill in `SQL_PASSWORD`, `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID`, and the
`sqlKey` values in `CLIENT_MAP`. Ctrl+O, Enter, Ctrl+X to save. Then:

    sudo systemctl restart sgk-analytics-api
    curl localhost:8080/health

That file is root-only and never goes near the repo.

## 7. Check it from outside

    https://analytics.sgkhomedelivery.co.uk/health

You want `"db":"connected"` and `"auth":"configured"`.

## 8. Repoint the portal

AWS Amplify → SGK Home Delivery Portal → Hosting → Environment variables:

    VITE_ANALYTICS_URL = https://analytics.sgkhomedelivery.co.uk

Then **Redeploy this version** on the branch. Vite bakes this in at build time,
so it does nothing until the app is rebuilt.

## 9. Turn Railway off

Once the Lightsail one answers, delete the Railway `sgk-analytics-api` service so
nothing is left half-configured and billing for no reason. Leave the WhatsApp
fleet bot alone — that one is fine where it is.

---

## Updating it later

    ssh in, then:
    cd /opt/sgk-analytics-api && git pull && npm install --omit=dev
    sudo systemctl restart sgk-analytics-api

## When something is wrong

    sudo journalctl -u sgk-analytics-api -f     # live logs
    sudo systemctl status sgk-analytics-api     # is it running
    curl localhost:8080/health                  # does it answer locally
    npm run discover                            # what does the database look like
