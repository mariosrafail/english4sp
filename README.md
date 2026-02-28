# english4sp

Web app for administering and taking English tests (Listening / Reading / Writing) with optional speaking meeting links.

## Local development

Prereqs: Node.js 18+.

1. Install deps:
   - `npm install`
2. Create env:
   - Copy `.env.example` to `.env` and edit values as needed.
3. Run:
   - `node server.js`
4. Open:
   - App: `http://localhost:8080`
   - Admin: `http://localhost:8080/admin.html`

## Storage

Uploads and snapshots are stored on disk under `storage/` (and some UI uploads under `public/uploads/`), both ignored by git.

For production, mount `storage/` as a persistent volume.

## Meetings (speaking)

Speaking meeting links can be generated via providers (e.g. Zoom, LiveKit, or self-hosted URLs). Configure with env vars (see `.env.example`).

## Deployment

See `docker-compose.yml` and `deploy/` for self-hosted examples (Nginx, Jitsi, MiroTalk, etc).

