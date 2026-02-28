# Zoom Meetings (Speaking)

This app can auto-create Zoom meeting links for each speaking slot.

## 1) Create a Zoom app (Server-to-Server OAuth)

1. Log in to Zoom Marketplace as the Zoom account that will **host** the meetings.
2. Create a **Server-to-Server OAuth** app.
3. Add scopes (minimum):
   - `meeting:write:admin`
   - `meeting:read:admin`
   - `user:read:admin`
4. Activate the app and copy:
   - Account ID
   - Client ID
   - Client Secret

## 2) Configure environment variables

Set these on your server:

- `SPEAKING_PROVIDER=zoom`
- `ZOOM_ACCOUNT_ID=...`
- `ZOOM_CLIENT_ID=...`
- `ZOOM_CLIENT_SECRET=...`
- `ZOOM_HOST_EMAIL=host@example.com` (or use `ZOOM_HOST_USER_ID=...`)
- `ZOOM_TIMEZONE=UTC` (optional; default `UTC`)

Restart the app after changing env vars.

## 3) Generate links for existing slots

Open `speaking-scheduling.html` as admin and use **Recreate meeting links** for the exam period.

Notes:
- Candidates are redirected to `join_url`.
- Admin UI shows/copies `start_url` when provider is Zoom (host link).

