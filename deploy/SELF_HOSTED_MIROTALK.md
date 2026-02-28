# Self-Hosted MiroTalk P2P On The Same Server

This setup runs your app and MiroTalk P2P on the same host with Docker Compose.

## 1) DNS

Point both records to your server public IP:

- `app.example.com`
- `meet.example.com`

## 2) Docker stack

`docker-compose.yml` includes:

- `app` on `127.0.0.1:8080`
- `mirotalk` on `127.0.0.1:3010`
- `SPEAKING_PROVIDER=mirotalk_p2p`
- `SELF_HOSTED_MIROTALK_BASE_URL=https://meet.example.com`

Start:

```bash
docker compose up -d --build
```

Or with scripts:

```bash
sudo bash deploy/stack/up.sh
```

Rebuild all:

```bash
sudo bash deploy/stack/rebuild.sh
```

Stop all:

```bash
sudo bash deploy/stack/down.sh
```

## 3) Nginx reverse proxy

Install config:

```bash
sudo cp deploy/nginx/english4sp.conf /etc/nginx/sites-available/english4sp.conf
sudo ln -sf /etc/nginx/sites-available/english4sp.conf /etc/nginx/sites-enabled/english4sp.conf
```

Issue TLS certs:

```bash
sudo certbot --nginx -d app.example.com -d meet.example.com
```

Reload Nginx:

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## 4) Firewall

Allow:

- `80/tcp`
- `443/tcp`

## 5) Validate

- App: `https://app.example.com`
- Meet: `https://meet.example.com`
- In `speaking-scheduling.html`, run `Recreate meeting links` once to rotate old links.
