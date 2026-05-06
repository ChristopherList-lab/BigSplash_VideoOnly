// Bigsplash Audit PDF Worker
//
// GET  /?id=<slug>          → renders bigsplash.video/audit/?id=<slug> to PDF
// GET  /pdf/<slug>          → same, prettier URL
//
// Returns: application/pdf with Content-Disposition: attachment so the
// browser triggers a download named "<slug>-brand-audit.pdf".

import puppeteer from "@cloudflare/puppeteer";

const CORS = {
  "Access-Control-Allow-Origin": "https://bigsplash.video",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405, headers: CORS });
    }

    const url = new URL(request.url);

    // Extract slug from either ?id= or /pdf/<slug>
    let slug = url.searchParams.get("id");
    if (!slug) {
      const m = url.pathname.match(/^\/pdf\/([a-z0-9-]+)/i);
      if (m) slug = m[1];
    }
    if (!slug || !/^[a-z0-9-]{1,80}$/i.test(slug)) {
      return json({ error: "Missing or invalid id. Use ?id=<church-slug>" }, 400);
    }

    const targetUrl = (env.AUDIT_BASE_URL || "https://bigsplash.video/audit/") + "?id=" + encodeURIComponent(slug);

    let browser;
    try {
      browser = await puppeteer.launch(env.BROWSER);
      const page = await browser.newPage();

      // Match the print-mode A4 layout the local render.sh produces.
      await page.setViewport({ width: 794, height: 1123, deviceScaleFactor: 2 });

      // Navigate. The page fetches audit JSON client-side; wait for it to
      // populate the #audit-app container before printing.
      await page.goto(targetUrl, { waitUntil: "networkidle0", timeout: 45000 });

      // Wait for the cover headline to render (proxy for "audit data loaded").
      // The dynamic renderer replaces the loading shell with rendered HTML.
      await page.waitForFunction(
        () => {
          const main = document.getElementById("audit-app");
          if (!main) return false;
          // After render, the #audit-app contains a section.cover with .h-display
          return !!main.querySelector("section.cover .h-display");
        },
        { timeout: 30000 }
      );

      // Give web fonts and images a beat to finish.
      await page.evaluate(() => document.fonts && document.fonts.ready);
      await new Promise(r => setTimeout(r, 800));

      const pdf = await page.pdf({
        format: "A4",
        printBackground: true,
        preferCSSPageSize: false,
        margin: { top: "0", bottom: "0", left: "0", right: "0" },
      });

      const filename = `${slug}-brand-audit.pdf`;
      return new Response(pdf, {
        status: 200,
        headers: {
          ...CORS,
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${filename}"`,
          "Cache-Control": "public, max-age=300",
        },
      });
    } catch (err) {
      return json({ error: "Render failed", detail: err.message || String(err) }, 500);
    } finally {
      if (browser) {
        try { await browser.close(); } catch {}
      }
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
