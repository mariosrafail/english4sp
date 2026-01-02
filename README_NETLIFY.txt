NETLIFY DEPLOY (STATIC + FUNCTIONS)

1) Publish directory: public
2) Build command: (empty)
3) Functions directory: netlify/functions (auto)

Required Environment Variables (Netlify -> Site settings -> Environment variables):
- DATABASE_URL   (Postgres connection string)

Optional:
- SITE_URL (defaults to Netlify URL) used for generating absolute exam links.

Notes:
- Admin API is protected by Basic Auth (browser prompt) on /api/admin/*.
- Admin HTML pages are static (not password-protected by Netlify). Keep links private.
