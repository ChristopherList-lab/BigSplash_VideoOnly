# Bigsplash Audit PDF Worker

Renders any Big Splash audit at `bigsplash.video/audit/?id=<slug>` to PDF using Cloudflare Browser Rendering.

## One-time setup

1. **Workers Paid plan.** Browser Rendering requires it ($5/mo).
2. **Enable Browser Rendering** in the Cloudflare dashboard → Workers & Pages → Browser Rendering → Enable.

## Deploy

From this directory:

```bash
npm install
npx wrangler login
npx wrangler deploy
```

Wrangler prints the URL after deploy, e.g.

```
https://bigsplash-audit-pdf.<account>.workers.dev
```

## Wire it up

The `/audit/index.html` renderer reads a constant `AUDIT_PDF_WORKER` to know where to send PDF requests. Update it to match the deployed URL:

```js
const AUDIT_PDF_WORKER = "https://bigsplash-audit-pdf.<account>.workers.dev";
```

Push that change. The "Download PDF" button in the nav now hits the worker, which loads `bigsplash.video/audit/?id=<slug>` in a headless browser, prints to A4 PDF, and returns the file.

## Custom route (optional)

Bind the worker to a route on bigsplash.video so the URL is `bigsplash.video/api/render-pdf` instead of `*.workers.dev`. In `wrangler.toml`:

```toml
routes = [
  { pattern = "bigsplash.video/api/render-pdf*", zone_name = "bigsplash.video" }
]
```

Then update `AUDIT_PDF_WORKER` accordingly.

## Caching (optional)

Uncomment the R2 binding in `wrangler.toml`, create the bucket:

```bash
npx wrangler r2 bucket create bigsplash-audit-pdfs
```

Then update `index.js` to read from R2 by `<slug>:<lastModified>` key before rendering, and write back on success.

## Endpoints

- `GET /?id=<slug>` — renders the audit page to PDF, returns `application/pdf` with `Content-Disposition: attachment`.
- `GET /pdf/<slug>` — same, prettier path.

Slug must match `[a-z0-9-]{1,80}`.

## Troubleshooting

- **`Browser Rendering is not enabled`**: enable it in dashboard.
- **Timeout fetching the page**: the renderer waits 45s for navigation and 30s for the cover headline to appear. If your Apps Script endpoint is slow, increase those values in `index.js`.
- **PDF is blank or shows the loading shell**: the worker waits for `section.cover .h-display` inside `#audit-app` before printing. If the renderer changes, update the selector.
