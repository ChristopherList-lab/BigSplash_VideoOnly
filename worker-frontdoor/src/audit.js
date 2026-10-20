// Runs every Front Door Audit check for one church and returns the full result.
// church = { name, city, address, website, instagram? }   env = { GOOGLE_API_KEY?, ... }
// Anything the audit could not check is marked in `checks` and graded as not checked, never as a failure,
// and any doubt about whose data this is holds the audit for Chris (needsReview + reviewReasons).
import { checkWebsite, sameSite, siteKey } from "./website.js";
import { findListing, nearMeRank } from "./google.js";
import { mobileSpeed } from "./pagespeed.js";
import { geocode } from "./geocode.js";
import { homesWithin, milesBetween } from "./reach.js";
import { scoreAudit } from "./score.js";
import { writeNotes, fallbackNotes } from "./write.js";

const FAR_MILES = 5;
// The Workflow step times out at 5 minutes. PageSpeed gets until SPEED_BY, the write-up until NOTES_BY,
// so a slow check ends up "not checked" instead of failing the whole run.
const SPEED_BY = 210000;
const NOTES_BY = 260000;

// The promise's value, or `late` once `ms` have passed.
function within(ms, promise, late) {
  let timer;
  const cutoff = new Promise((r) => { timer = setTimeout(() => r(late), Math.max(0, ms)); });
  return Promise.race([promise, cutoff]).finally(() => clearTimeout(timer));
}

export async function runAudit(church, env = {}) {
  const started = Date.now();
  const errors = [];
  const safe = async (label, fn) => {
    try { return await fn(); } catch (err) { errors.push(`${label}: ${err.message}`); return null; }
  };
  const key = env.GOOGLE_API_KEY || null;
  const checks = { google: "skipped", nearMe: "skipped", website: "not-checked", speed: "skipped", reach: "not-checked" };

  // The typed address on a map, to compare with the listing. Only an address with a street number or ZIP
  // is precise enough for that.
  const precise = /^\s*\d+[a-z]?\s/i.test(church.address || "") || /\b\d{5}(?:-\d{4})?\b/.test(church.address || "");
  const typedGeoP = church.address ? safe("geocode", () => geocode(church.address)) : Promise.resolve(null);

  let website = await safe("website", () => checkWebsite(church.website, { name: church.name }));
  let speedP = website?.checked ? safe("pagespeed", () => mobileSpeed(website.finalUrl, key)) : null;

  let google = null;
  if (key) {
    const sites = [church.website, website?.finalUrl].filter(Boolean);
    google = await safe("google", () => findListing(key, church, sites));
    checks.google = google ? "ok" : "error";
  }

  // The typed site could not be read: try the site on the Google listing, when the listing has this church's name.
  if (!website?.checked && google?.found && google.website && google.nameMatch && !sameSite(google.website, church.website)) {
    const alt = await safe("website (Google listing)", () => checkWebsite(google.website, { source: "google", name: church.name }));
    if (alt?.checked) {
      website = alt;
      speedP = safe("pagespeed", () => mobileSpeed(alt.finalUrl, key));
    }
  }
  checks.website = website?.checked ? "ok" : website ? "not-checked" : "error";

  const typedGeo = await typedGeoP;
  // A ZIP-code center can sit miles from the church, so it never proves a listing is far away.
  const listingMiles = google?.found && precise && typedGeo && typedGeo.from !== "zip" && typeof google.lat === "number"
    ? Math.round(milesBetween(typedGeo.lat, typedGeo.lon, google.lat, google.lon) * 10) / 10 : null;
  const far = listingMiles !== null && listingMiles > FAR_MILES;
  if (google?.found) {
    // Grade the listing only when it is this church: matched, close to the typed address, and either sharing
    // the website or carrying the name when the typed site could not be read.
    google.trusted = !far && (google.confidence === "high" || google.confidence === "medium" ||
      (google.confidence === "conflict" && google.nameMatch && website?.source === "google"));
    google.milesFromTypedAddress = listingMiles;
  }

  let nearMe = null;
  if (key && google?.found && google.trusted) {
    nearMe = await safe("near-me", () => nearMeRank(key, google));
    checks.nearMe = nearMe?.checked ? "ok" : "error";
    for (const s of nearMe?.searches || []) if (!s.checked) errors.push(`near-me ${s.from}: ${s.error}`);
  }

  const speed = speedP ? await within(SPEED_BY - (Date.now() - started), speedP, { ok: false, error: "PageSpeed ran out of time" }) : null;
  if (website?.checked) checks.speed = speed?.ok ? "ok" : "error";
  if (speed && !speed.ok) errors.push(`pagespeed: ${speed.error}`);

  // Households: the listing's location when it is trusted, else the typed address.
  const where = google?.trusted ? { lat: google.lat, lon: google.lon, address: google.address } : typedGeo ? { lat: typedGeo.lat, lon: typedGeo.lon, address: church.address } : null;
  const reach = where ? homesWithin(where.lat, where.lon, 5, where.address, church.address) : null;
  checks.reach = reach ? "ok" : where ? "skipped" : "not-checked";

  const instagram = null; // filled in once the Meta app is connected
  const result = { church, google, nearMe, website, speed, instagram, reach, checks };
  const scores = scoreAudit(result);
  const notes = await within(NOTES_BY - (Date.now() - started), writeNotes({ ...result, scores }, env), fallbackNotes({ ...result, scores }));

  // Plain sentences for Chris. Any one of them holds the audit until he approves it.
  const reasons = [];
  if (!key) reasons.push("No Google key was set, so Google was not checked.");
  else if (checks.google === "error") reasons.push("The Google lookup failed, so the listing was not checked.");
  else if (!google?.found) reasons.push("No Google listing came up for this church's name and address.");
  else {
    if (google.confidence === "conflict") reasons.push(`The Google listing may be a different church: ${google.conflictReason}`);
    if (google.confidence === "low") reasons.push(`The Google listing may be a different church: ${google.conflictReason}`);
    if (far) reasons.push(`The Google listing (${google.address}) sits ${listingMiles} miles from the address the pastor typed.`);
    if (google.trusted && !nearMe?.checked) reasons.push("The near-me Google search failed, so search rank was not checked.");
  }
  if (website?.source === "google") reasons.push(`The typed website could not be checked, so the audit used the website on the Google listing (${siteKey(website.finalUrl)}).`);
  if (!website?.checked) reasons.push(`The website was not checked: ${website?.reason || "the check failed"}.`);
  const graded = Object.values(scores.areas).filter((x) => x.checked).length;
  if (graded < 3) reasons.push(`Only ${graded} of 4 areas could be graded.`);

  return {
    ...result,
    scores,
    notes,
    needsReview: reasons.length > 0,
    reviewReasons: reasons,
    reviewReason: reasons.length ? reasons.join(" ") : null,
    possibleDuplicates: google?.possibleDuplicates || [],
    errors,
    checkedAt: new Date().toISOString(),
    seconds: Math.round((Date.now() - started) / 100) / 10,
  };
}
