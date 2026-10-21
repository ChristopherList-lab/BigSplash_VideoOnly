// Render the scorecard and the walkthrough page for a saved audit result, as phone and desktop screenshots.
// Usage: node preview.mjs out/city-reach-church.json [output folder]
// Writes <name>-scorecard.html and <name>-walkthrough.html (open them in a browser) and
// <name>-scorecard-phone.png, -scorecard-desktop.png, -walkthrough-phone.png and -walkthrough-desktop.png,
// next to the result unless a folder is given. The logo run-local.mjs saved beside the result
// (<name>-logo.<ext>) stands in for the worker's /logo route. The booking calendar is not loaded.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "/Users/listmediagroup/Desktop/BigSplash_Design/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";

const here = resolve(fileURLToPath(import.meta.url), "..");
const site = resolve(here, "..");
const file = process.argv[2];
if (!file) { console.error("Usage: node preview.mjs <result.json> [output folder]"); process.exit(1); }
const name = basename(file, ".json");
const from = dirname(resolve(file));
const outDir = resolve(process.argv[3] || from);
mkdirSync(outDir, { recursive: true });
const data = readFileSync(file, "utf8");

// The logo as a data: address, so the page's light-logo check can read its pixels.
const LOGO_TYPES = { png: "image/png", jpg: "image/jpeg", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml" };
const logo = Object.keys(LOGO_TYPES).map((ext) => [ext, resolve(from, `${name}-logo.${ext}`)]).find(([, f]) => existsSync(f));
const LOGO_SRC = "`${API}/logo?id=${encodeURIComponent(id)}`";
const PAGES = { scorecard: "front-door/index.html", walkthrough: "frontdoor/walkthrough/index.html" };
// The audit id in the address, as in a real link, so the walkthrough links back to its scorecard.
const id = JSON.parse(data).id;
const query = /^[a-z0-9-]{6,80}$/.test(id || "") ? `?id=${id}` : "";

function build(page) {
  // Site-absolute paths point at the local repo so the preview loads the real Big Splash logo and images.
  let html = readFileSync(resolve(site, PAGES[page]), "utf8")
    .replaceAll('src="/assets/', `src="file://${site}/assets/`)
    .replace("<script>", `<script>window.FRONT_DOOR_DATA = ${data};</script>\n<script>`)
    // The phone booking bar waits just under the fold, where a full-page screenshot would catch it.
    .replace("</head>", "<style>.sticky { display: none !important; }</style>\n</head>");
  if (logo) {
    if (html.includes(LOGO_SRC)) html = html.replace(LOGO_SRC, JSON.stringify(`data:${LOGO_TYPES[logo[0]]};base64,${readFileSync(logo[1]).toString("base64")}`));
    else console.warn(`preview: the ${page} logo markup changed, so the local logo is not shown`);
  }
  const out = resolve(outDir, `${name}-${page}.html`);
  writeFileSync(out, html);
  return out;
}

const browser = await puppeteer.launch({ headless: "new" });
try {
  const tab = await browser.newPage();
  await tab.setRequestInterception(true);
  // The GoHighLevel calendar and its embed script stay out of previews.
  tab.on("request", (req) => (/leadconnectorhq\.com|msgsndr\.com/.test(req.url()) ? req.abort() : req.continue()));
  const shots = [];
  for (const page of Object.keys(PAGES)) {
    const out = build(page);
    for (const [label, width, height] of [["phone", 390, 844], ["desktop", 1280, 900]]) {
      await tab.setViewport({ width, height, deviceScaleFactor: 2 });
      await tab.goto(`file://${out}${query}`, { waitUntil: "networkidle0" });
      await tab.evaluate(() => document.fonts.ready);
      await new Promise((r) => setTimeout(r, 150));
      const png = resolve(outDir, `${name}-${page}-${label}.png`);
      await tab.screenshot({ path: png, fullPage: true });
      shots.push(png);
    }
  }
  console.log(`preview:\n${shots.join("\n")}`);
} finally {
  await browser.close();
}
