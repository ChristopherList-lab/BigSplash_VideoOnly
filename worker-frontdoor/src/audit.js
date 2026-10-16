// Runs every Front Door Audit check for one church and returns the full result.
// church = { name, city, address, website, instagram? }   env = { GOOGLE_API_KEY?, ... }
import { checkWebsite } from "./website.js";
import { findListing, nearMeRank } from "./google.js";
import { mobileSpeed } from "./pagespeed.js";
import { geocode } from "./geocode.js";
import { homesWithin } from "./reach.js";
import { scoreAudit } from "./score.js";
import { writeNotes } from "./write.js";

export async function runAudit(church, env = {}) {
  const started = Date.now();
  const errors = [];
  const safe = async (label, fn) => {
    try { return await fn(); } catch (err) { errors.push(`${label}: ${err.message}`); return null; }
  };

  const key = env.GOOGLE_API_KEY || null;
  const [website, speed, google] = await Promise.all([
    safe("website", () => checkWebsite(church.website)),
    safe("pagespeed", () => mobileSpeed(church.website.startsWith("http") ? church.website : `https://${church.website}`, key)),
    key ? safe("google", () => findListing(key, church)) : Promise.resolve(null),
  ]);
  const nearMe = key && google?.found ? await safe("near-me", () => nearMeRank(key, google)) : null;

  // Location for the reach count: the Google listing first, the Census geocoder as a fallback.
  let where = google?.found ? { lat: google.lat, lon: google.lon, from: "google" } : null;
  if (!where && church.address) {
    const g = await safe("geocode", () => geocode(church.address));
    if (g) where = { lat: g.lat, lon: g.lon, from: g.from };
  }
  const reach = where ? homesWithin(where.lat, where.lon, 5) : null;

  const instagram = null; // filled in once the Meta app is connected
  const result = { church, google, nearMe, website, speed, instagram, reach };
  const scores = scoreAudit(result);
  const notes = await writeNotes({ ...result, scores }, env);

  // Hold for a person when the Google match is shaky, so a pastor never gets another church's numbers.
  const needsReview = Boolean(key && (!google?.found || google.confidence === "low"));

  return {
    ...result,
    scores,
    notes,
    needsReview,
    reviewReason: needsReview ? (google?.found ? "The Google listing might belong to a different church." : "No Google listing was found.") : null,
    errors,
    checkedAt: new Date().toISOString(),
    seconds: Math.round((Date.now() - started) / 100) / 10,
  };
}
