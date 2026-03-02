# LiveKit (Self-Hosted) - Speaking Calls

This app supports LiveKit for 1:1 speaking calls (max 2 participants per room).

## 1) Server prerequisites

- Docker + Docker Compose
- Nginx
- TLS certs (e.g. certbot / Let's Encrypt)

## 2) DNS

Point your app domain to your server public IP, e.g.:

- `english4sp.stinis.ddns.net` -> server public IP

## 3) Firewall / ports

Allow inbound:

- `80/tcp` and `443/tcp` (Nginx + TLS)
- `7881/tcp` (LiveKit TCP fallback)
- `50000-50100/udp` (LiveKit media)

## 4) Configure LiveKit keys

Edit `deploy/livekit/livekit.yaml` and set strong values under `keys:`:

- `LIVEKIT_API_KEY` = the YAML key name
- `LIVEKIT_API_SECRET` = the YAML key value

## 5) App env (production)

Set (example):

- `PORT=8080` (matches `docker-compose.yml` port mapping)
- `PUBLIC_BASE_URL=https://english4sp.stinis.ddns.net`
- `SPEAKING_PROVIDER=livekit`
- `LIVEKIT_URL=wss://english4sp.stinis.ddns.net/livekit`
- `LIVEKIT_API_URL=http://livekit:7880`
- `LIVEKIT_API_KEY=...` (must match `deploy/livekit/livekit.yaml`)
- `LIVEKIT_API_SECRET=...` (must match `deploy/livekit/livekit.yaml`)

## 6) Start services

From repo root on the server:

```bash
docker compose up -d --build
```

## 7) Nginx reverse proxy

Use the provided config as a starting point:

- `deploy/nginx/english4sp.stinis.ddns.net.conf`

Important:
- Keep `LIVEKIT_URL` as `wss://<domain>/livekit` (no trailing slash needed in env).
- Nginx must proxy `/livekit` to LiveKit and **strip** the `/livekit` prefix (handled in the provided config). Do **not** redirect `/livekit` -> `/livekit/` as that can break WebSocket clients.

Install and enable (example):

```bash
sudo cp deploy/nginx/english4sp.stinis.ddns.net.conf /etc/nginx/sites-available/english4sp.conf
sudo ln -sf /etc/nginx/sites-available/english4sp.conf /etc/nginx/sites-enabled/english4sp.conf
sudo nginx -t && sudo systemctl reload nginx
```

Issue TLS cert and reload (example):

```bash
sudo certbot --nginx -d english4sp.stinis.ddns.net
sudo nginx -t && sudo systemctl reload nginx
```

## 8) Validate

- App: `https://english4sp.stinis.ddns.net`
- LiveKit WS should be reachable at: `wss://english4sp.stinis.ddns.net/livekit`
