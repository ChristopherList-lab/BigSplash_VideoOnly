// Run one Front Door Audit from this Mac and print the result.
// Usage: node run-local.mjs "City Reach Church" "2700 W Whitestone Blvd, Cedar Park, TX 78613" cityreachchurch.com
// Reads the Google key from ~/.bigsplash-google-key when that file exists.
// The church logo goes in a stand-in for KV and is written to out/<name>-logo.<ext> for preview.mjs.
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runAudit } from "./src/audit.js";

const [name, address, website] = process.argv.slice(2);
if (!name || !website) {
  console.error('Usage: node run-local.mjs "<church name>" "<address>" <website>');
  process.exit(1);
}
// Keys live in private files in your home folder, never in this repo.
const readKey = (name) => {
  const f = join(homedir(), name);
  return existsSync(f) ? readFileSync(f, "utf8").trim() : undefined;
};
const env = { GOOGLE_API_KEY: readKey(".bigsplash-google-key"), ANTHROPIC_API_KEY: readKey(".bigsplash-anthropic-key") };
const city = (address || "").split(",").slice(-2).join(",").trim();
const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const kv = new Map();
env.AUDITS = { put: async (key, value, opts) => { kv.set(key, { value, metadata: opts?.metadata || null }); } };
const id = `local-${slug}`.slice(0, 80);

const result = await runAudit({ name, address, city, website }, env, { id });
result.id = id;
mkdirSync("out", { recursive: true });
const file = join("out", slug + ".json");
for (const ext of ["png", "jpg", "webp", "avif", "svg"]) rmSync(join("out", `${slug}-logo.${ext}`), { force: true });
const logo = kv.get(`logo:${id}`);
if (logo) {
  const ext = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif", "image/svg+xml": "svg" }[logo.metadata.type];
  writeFileSync(join("out", `${slug}-logo.${ext}`), logo.value);
  result.localLogo = { file: `out/${slug}-logo.${ext}`, ...logo.metadata };
}
writeFileSync(file, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ google: Boolean(env.GOOGLE_API_KEY), seconds: result.seconds, needsReview: result.needsReview, reviewReasons: result.reviewReasons, coverage: result.coverage, infoLines: result.infoLines, scores: result.scores, reach: result.reach, brand: result.brand, logo: result.localLogo || null, errors: result.errors }, null, 2));
console.log("full result:", file);
