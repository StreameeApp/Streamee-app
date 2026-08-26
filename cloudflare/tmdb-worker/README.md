# Streamee TMDB Worker

This standalone Cloudflare Worker keeps Streamee's TMDB API Read Access Token out of the desktop app. It exposes only the read-only TMDB routes Streamee uses, rejects unknown paths and query parameters, caches successful responses, and rate-limits valid requests per client IP.

To reduce billable Worker invocations, Streamee uses four bounded aggregate routes:

- `GET /v1/tmdb/aggregate/board?content_mode=all` returns the four Board catalog rows in one response.
- `GET /v1/tmdb/aggregate/discovery?content_mode=all&media_type=all&page=1` returns Movie and TV Discovery results in one response. Optional validated filters are `genre_id`, `year`, and `language`.
- `GET /v1/tmdb/aggregate/previews?items=movie:11,tv:1399` returns preview metadata for up to 20 validated TMDB IDs.
- `GET /v1/tmdb/aggregate/title/movie/11?include_watch_providers=1` returns title metadata and optional watch-provider data in one response.

These routes make a fixed, allowlisted set of TMDB subrequests. They do not accept arbitrary upstream URLs.

## Deploy

Run these commands from `cloudflare/tmdb-worker` in PowerShell:

```powershell
npm install
npx wrangler login
npx wrangler secret put TMDB_API_READ_ACCESS_TOKEN
npm run deploy
```

When prompted for the secret, paste the **API Read Access Token** from TMDB's API settings page. Do not use the shorter v3 API key and do not put either credential in `.env`, `wrangler.jsonc`, source control, or Streamee settings.

Wrangler prints the deployed URL, normally similar to:

```text
https://streamee-tmdb.<your-workers-subdomain>.workers.dev
```

From the Streamee repository root, copy `.env.example` to `.env.local` and replace its example value with that deployed URL. Do not add `/v1/tmdb`; the app adds that route prefix itself.

```powershell
Copy-Item .env.example .env.local
npm run build
```

The Worker URL is public configuration and is baked into the desktop build. The TMDB token remains a Cloudflare secret.

## Caching and request telemetry

Catalog, Board, and Discovery responses use a 30-minute edge cache. Title and preview metadata use a six-hour edge cache. Streamee also persists responses locally: title and preview metadata remain reusable for 24 hours, IMDb identities for 90 days, current episode lists for six hours, and historical episode lists for 30 days. Full title responses populate the preview, poster, season, trailer, identity, and watch-provider caches so later features do not request the same title independently. Expired local data can be used briefly if a refresh fails.

Workers Logs receives structured request summaries through the configured 5% head sampling rate. Each summary contains only the route category, HTTP method, status, cache result, and duration. It does not contain the client IP, search terms, TMDB IDs, query strings, or credentials.

## Optional edge protection

The binding in `wrangler.jsonc` remains the final per-IP safeguard inside the Worker. If unexpected public traffic becomes material, put the Worker on a custom domain in a Cloudflare-managed zone and update `VITE_TMDB_WORKER_URL` to that HTTPS origin. Then, if your Cloudflare plan exposes rate limiting rules:

1. Open the domain in the Cloudflare dashboard and go to **Security > WAF > Rate limiting rules**.
2. Create a rule matching `GET` requests whose URI path starts with `/v1/tmdb/`.
3. Start with a conservative per-IP threshold below the Worker's `600 requests / 60 seconds` fallback, monitor Security Events for legitimate clients, and adjust before choosing a blocking action.
4. Keep `/health` outside that rule if it is used by external uptime monitoring.

A terminating edge rule stops abusive traffic before later request phases. Availability and configurable thresholds depend on the Cloudflare plan, so this rule is intentionally not part of the repository deployment.

## Local development

Copy `.dev.vars.example` to `.dev.vars`, insert the TMDB API Read Access Token, then run:

```powershell
npm run dev
```

Streamee development builds default to `http://127.0.0.1:8787` when `VITE_TMDB_WORKER_URL` is unset.

## Validation

```powershell
npm run types
npm run check
npm run deploy:dry-run
npx wrangler check startup
```

After deployment, verify the health route and one allowed route:

```powershell
Invoke-RestMethod 'https://streamee-tmdb.<your-workers-subdomain>.workers.dev/health'
Invoke-RestMethod 'https://streamee-tmdb.<your-workers-subdomain>.workers.dev/v1/tmdb/movie/11'
```

The first response should be `{ "ok": true }`. The second should return TMDB metadata without exposing an API token in the request or response.
