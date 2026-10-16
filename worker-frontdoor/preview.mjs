// Render the scorecard for a saved audit result, as a phone and a desktop screenshot.
// Usage: node preview.mjs out/city-reach-church.json
// Writes out/<name>-phone.png, out/<name>-desktop.png and out/<name>.html (open it in a browser).
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "/Users/listmediagroup/Desktop/BigSplash_Design/node_modules/puppeteer/lib/esm/puppeteer/puppeteer.js";

const here = resolve(fileURLToPath(import.meta.url), "..");
const site = resolve(here, "..");
const file = process.argv[2];
if (!file) { console.error("Usage: node preview.mjs <result.json>"); process.exit(1); }
const name = basename(file, ".json");
const data = readFileSync(file, "utf8");

// Site-absolute paths point at the local repo so the preview loads the real logo and starburst.
let html = readFileSync(resolve(site, "front-door/index.html"), "utf8")
  .replaceAll('src="/assets/', `src="file://${site}/assets/`)
  .replace("<script>", `<script>window.FRONT_DOOR_DATA = ${data};</script>\n<script>`);
const out = resolve(here, "out", `${name}.html`);
writeFileSync(out, html);

const browser = await puppeteer.launch({ headless: "new" });
try {
  const page = await browser.newPage();
  for (const [label, width, height] of [["phone", 390, 844], ["desktop", 1280, 900]]) {
    await page.setViewport({ width, height, deviceScaleFactor: 2 });
    await page.goto("file://" + out, { waitUntil: "networkidle0" });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: resolve(here, "out", `${name}-${label}.png`), fullPage: true });
  }
  console.log(`preview: out/${name}.html, out/${name}-phone.png, out/${name}-desktop.png`);
} finally {
  await browser.close();
}
