# Pi-Stack status

A Cloudflare Worker that checks every public Pi-Stack site every 5 minutes and serves a status page with 24 hours of history.

- `src/index.js` holds the site list, the cron check and the page.
- Results live in one KV key (`STATE` binding), written once per run, which keeps it inside the free tier's 1,000 writes a day.
- `/api/status` returns the latest results as JSON.

Deploy with `npx wrangler deploy` and a `CLOUDFLARE_API_TOKEN` that can edit Workers on the Pi-Stack account.
