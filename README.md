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

## Stress test with candidate links

You can simulate many candidates opening their own exam links and submitting, to see if the system degrades or fails.

1. In Admin, import candidates (Excel) so sessions/links are created.
2. Export the generated links (`sessions_examperiod_*.xlsx`) or prepare a `.txt/.csv` with one link (or token) per line.
3. Run stress script:
   - Local: `npm run stress:candidates -- --links ./sessions_examperiod_1.xlsx --base-url http://localhost:8080 --concurrency 100`
   - Production domain: `npm run stress:candidates -- --links ./sessions_examperiod_1.xlsx --base-url https://english4sp.stinis.ddns.net --concurrency 100 --with-listening --with-snapshots --snapshot-count 2`

Supported input files for `--links`:
- `.xlsx` / `.xls`: reads first sheet and auto-detects `token` / `link` columns.
- `.csv`: auto-detects `token`, `link`, `rawLink`, or `url` columns.
- `.txt`: one token or full exam link per line.

Useful flags:
- `--concurrency 150` number of concurrent candidates.
- `--timeout-ms 20000` per-request timeout.
- `--fail-rate-threshold 0.05` fail threshold (5%).
- `--no-presence` skip presence ping step.
- `--no-listening` skip listening-ticket step.
- `--with-snapshots --snapshot-count 2` include snapshot upload simulation.
- `--duration-minutes 10` keep each candidate active for 10 minutes before submit.
- `--snapshot-size-kb 1024` snapshot payload size (1 MB each).
- `--presence-interval-sec 25` presence ping cadence during the session.
- `--listening-interval-sec 20 --listening-chunk-kb 512` listen-heavy behavior (repeated listening attempts and audio range fetches).

Example (realistic long session):
- `node ./scripts/stress_candidates.js --links "C:\Users\Marios\Desktop\sessions_examperiod_2.xlsx" --base-url https://english4sp.stinis.ddns.net --concurrency 114 --duration-minutes 10 --with-listening --with-snapshots --snapshot-count 2 --snapshot-size-kb 1024 --presence-interval-sec 25 --listening-interval-sec 20 --listening-chunk-kb 512 --timeout-ms 30000 --report-file ./stress-reports/wave114_10min.json`

Output includes:
- flow summary (`ok`, `failed`, `failRate`, elapsed time)
- per-endpoint status codes and latency (`p50`, `p95`, `max`)

Tip: run this first against staging, then in production during an agreed low-risk window.

### Probe snapshot upload size limit

Use this to find the effective maximum snapshot size accepted by your deployment (including reverse proxy limits):

- `node ./scripts/probe_snapshot_limit.js --links "C:\Users\Marios\Desktop\sessions_examperiod_1.xlsx" --base-url https://english4sp.stinis.ddns.net --min-kb 64 --max-kb 2048 --report-file ./stress-reports/snapshot_limit_probe.json`

It runs a binary search and outputs:
- `bestAcceptedKb`
- `firstRejectedKb`
- detailed attempt list with HTTP status codes.

### Adaptive snapshot resizing (candidate client)

Snapshot capture now auto-reduces image dimensions before upload when payload is large, and retries with a smaller image on `413` responses. This improves reliability under strict upload-size limits.

