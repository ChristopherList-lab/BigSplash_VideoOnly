// Run one Front Door Audit from this Mac and print the result.
// Usage: node run-local.mjs "City Reach Church" "2700 W Whitestone Blvd, Cedar Park, TX 78613" cityreachchurch.com
// Reads the Google key from ~/.bigsplash-google-key when that file exists.
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
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

const result = await runAudit({ name, address, city, website }, env);
mkdirSync("out", { recursive: true });
const file = join("out", name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + ".json");
writeFileSync(file, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ google: Boolean(env.GOOGLE_API_KEY), seconds: result.seconds, needsReview: result.needsReview, scores: result.scores, reach: result.reach, errors: result.errors }, null, 2));
console.log("full result:", file);
