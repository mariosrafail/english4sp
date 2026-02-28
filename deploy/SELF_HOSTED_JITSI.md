# Self-Hosted Jitsi On The Same Server

This setup keeps your existing app and Jitsi on the same host, in separate containers.

## 1) DNS

Point both records to your server public IP:

- `english4sp.stinis.ddns.net`
- `meet.english4sp.stinis.ddns.net`

## 2) App (already prepared)

`docker-compose.yml` now includes:

- `SPEAKING_PROVIDER=selfhosted`
- `SELF_HOSTED_JITSI_BASE_URL=https://meet.english4sp.stinis.ddns.net`

Deploy app as usual:

```bash
docker compose up -d --build
```

## 2.1) One-command stack scripts (recommended)

You can manage app + Jitsi together:

```bash
sudo SERVER_IP=<YOUR_PUBLIC_IP> \
     APP_DOMAIN=english4sp.stinis.ddns.net \
     JITSI_DOMAIN=meet.english4sp.stinis.ddns.net \
     bash deploy/stack/up.sh
```

Rebuild all:

```bash
sudo SERVER_IP=<YOUR_PUBLIC_IP> \
     APP_DOMAIN=english4sp.stinis.ddns.net \
     JITSI_DOMAIN=meet.english4sp.stinis.ddns.net \
     bash deploy/stack/rebuild.sh
```

Stop all:

```bash
sudo bash deploy/stack/down.sh
```

## 3) Jitsi stack

Run bootstrap script on the server:

```bash
sudo JITSI_DOMAIN=meet.english4sp.stinis.ddns.net SERVER_IP=<YOUR_PUBLIC_IP> bash deploy/jitsi/bootstrap.sh
```

This will:

- clone official `docker-jitsi-meet` to `/opt/jitsi-docker`
- configure it for reverse-proxy mode (HTTP on `127.0.0.1:8000`)
- open Jitsi media on `10000/udp`
- start containers with `docker compose up -d`

## 4) Nginx reverse proxy

Install config:

```bash
sudo cp deploy/nginx/english4sp.conf /etc/nginx/sites-available/english4sp.conf
sudo ln -sf /etc/nginx/sites-available/english4sp.conf /etc/nginx/sites-enabled/english4sp.conf
```

Issue TLS certs (example with certbot):

```bash
sudo certbot --nginx -d english4sp.stinis.ddns.net -d meet.english4sp.stinis.ddns.net
```

Then reload Nginx:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## 5) Firewall / network

Allow:

- `80/tcp`
- `443/tcp`
- `10000/udp` (Jitsi media)

## 6) Validate

- App: `https://english4sp.stinis.ddns.net`
- Jitsi: `https://meet.english4sp.stinis.ddns.net`
- Create candidate and verify speaking link opens meeting without external meeting API dependency.
