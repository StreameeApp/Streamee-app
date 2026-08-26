# Streamee TMDB Worker

This standalone Cloudflare Worker keeps Streamee's TMDB API Read Access Token out of the desktop app. It exposes only the read-only TMDB routes Streamee uses, rejects unknown paths and query parameters, caches successful responses, and rate-limits cache misses.

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
