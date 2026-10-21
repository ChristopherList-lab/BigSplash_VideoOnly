// Runs every Front Door Audit check for one church and returns the full result.
// church = { name, city, address, website, instagram? }   env = { GOOGLE_API_KEY?, AUDITS?, ... }
// id = the audit id; with it and env.AUDITS, the church's logo from its website is saved under logo:<id>.
// result.brand carries the church's color (contrast-checked), font and logo for the co-branded scorecard;
// result.church.city comes from a matched Google listing's address when there is one. No photo is fetched:
// the logo is the one picture the scorecard shows.
// Chris's rule (2026-10-20): always give a score and send it. A check that failed on our side leaves its areas
// out (result.coverage says which and why); a site that did not load (Website F, Social left out) and a church
// with no Google listing (Google and Reviews F) are graded, low, since a family would hit them too (see score.js).
// Only doubt about whose data this is holds the audit for Chris (needsReview + reviewReasons): a listing that may
// be another church, a listing far from the typed address, a second listing for the same website when the address
// could not say which is this church's, or nothing gradable at all. worker.js also holds an audit with no email to send it to. infoLines tell Chris
// the rest (a swapped website, a failed near-me search) in Slack and ClickUp without holding anything.
import { checkWebsite, sameSite, siteKey } from "./website.js";
import { findListing, nearMeRank, placesFailure } from "./google.js";
import { mobileSpeed } from "./pagespeed.js";
import { geocode } from "./geocode.js";
import { homesWithin, milesBetween } from "./reach.js";
import { scoreAudit, coverageOf, coverageText } from "./score.js";
import { writeNotes, fallbackNotes } from "./write.js";
import { PHOTO_TIMEOUT_MS } from "./photo.js";
import { saveLogo } from "./logo.js";
import { themeColors } from "./brand.js";

const FAR_MILES = 5;
// The Workflow step times out at 5 minutes. PageSpeed gets until SPEED_BY, the write-up until NOTES_BY,
// so a slow check ends up "not checked" instead of failing the whole run.
const SPEED_BY = 210000;
const NOTES_BY = 260000;

// "City, ST" from a Google formatted address: "1200 Main St, Leander, TX 78641, USA" gives "Leander, TX".
// Null when the address has no part shaped like a state or province with its postal code.
export function cityFromAddress(formatted) {
  const parts = String(formatted || "").split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length && /^(?:usa|us|united states(?: of america)?|canada)$/i.test(parts.at(-1))) parts.pop();
  for (let i = parts.length - 1; i >= 1; i--) {
    const m = parts[i].match(/^([A-Z]{2})(?:\s+[A-Z0-9][A-Z0-9 -]{2,9})?$/);
    const city = parts[i - 1];
    if (m && city && !/\d/.test(city) && city.length <= 60) return `${city}, ${m[1]}`;
  }
  return null;
}

// The promise's value, or `late` once `ms` have passed.
function within(ms, promise, late) {
  let timer;
  const cutoff = new Promise((r) => { timer = setTimeout(() => r(late), Math.max(0, ms)); });
  return Promise.race([promise, cutoff]).finally(() => clearTimeout(timer));
}

export async function runAudit(church, env = {}, { id = null } = {}) {
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
  // A site that looks down gets Google's phone speed test as a second opinion: if Google can load it, the
  // failure was ours and the site is left out instead of graded F.
  const speedFor = (w) => (w?.checked ? w.finalUrl : w?.down ? w.url : null);
  let speedP = speedFor(website) ? safe("pagespeed", () => mobileSpeed(speedFor(website), key)) : null;

  // A typed "none", "n/a" or "-" is not a website, so it never argues that a listing with a site is another church's.
  const typedSite = website?.failure === "no-address" ? null : church.website;
  let google = null, googleFailure = null;
  if (key) {
    const sites = [typedSite, website?.finalUrl].filter(Boolean);
    try {
      google = await findListing(key, church, sites);
    } catch (err) {
      errors.push(`google: ${err.message}`);
      googleFailure = placesFailure(err);
    }
    checks.google = google ? "ok" : "error";
  }

  // The typed site could not be read: try the site on the Google listing, when the listing has this church's name.
  // A typed site that is down gives way to a listing site our check could not read, since the church may have moved.
  let triedListingSite = null;
  if (!website?.checked && google?.found && google.website && google.nameMatch && !sameSite(google.website, typedSite)) {
    const alt = await safe("website (Google listing)", () => checkWebsite(google.website, { source: "google", name: church.name }));
    triedListingSite = alt || { checked: false, url: google.website };
    if (alt?.checked || (alt && website?.down && !alt.down)) {
      website = alt;
      speedP = speedFor(alt) ? safe("pagespeed", () => mobileSpeed(speedFor(alt), key)) : null;
    }
  }
  checks.website = website?.checked ? "ok" : website ? "not-checked" : "error";

  // The church logo, from the site whose look the scorecard borrows, runs beside the other checks. Once they
  // are done it gets one image timeout more at most, then it is dropped; it never feeds a grade.
  const logoStop = new AbortController();
  const logoCandidates = website?.brand?.logoCandidates || [];
  const logoP = id && env.AUDITS && logoCandidates.length
    ? safe("logo", () => saveLogo(env, id, logoCandidates, { signal: logoStop.signal, referer: website.finalUrl })) : null;
  // An inline SVG travels as a long data: address; the saved result names it instead of carrying it.
  if (website?.brand?.logoCandidates) website.brand = { ...website.brand, logoCandidates: logoCandidates.map((u) => (/^data:/i.test(u) ? "inline svg" : u)) };

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
  // A listing that matched by name or website says the city plainly, so ClickUp and Slack show "Leander, TX"
  // and not the street address the pastor typed. The typed address stays in church.address.
  if (google?.trusted && (google.confidence === "high" || google.confidence === "medium")) {
    const city = cityFromAddress(google.address);
    if (city) church = { ...church, city };
  }

  let nearMe = null;
  if (key && google?.found && google.trusted) {
    nearMe = await safe("near-me", () => nearMeRank(key, google));
    checks.nearMe = nearMe?.checked ? "ok" : "error";
    for (const s of nearMe?.searches || []) if (!s.checked) errors.push(`near-me ${s.from}: ${s.error}`);
  }

  const ran = speedP ? await within(SPEED_BY - (Date.now() - started), speedP, { ok: false, error: "PageSpeed ran out of time" }) : null;
  const speed = website?.checked ? ran : null;
  if (website?.checked) checks.speed = speed?.ok ? "ok" : "error";
  if (speed && !speed.ok) errors.push(`pagespeed: ${speed.error}`);
  const info = [];
  if (website && !website.checked && website.down) {
    if (ran?.ok) {
      info.push(`Our check could not load ${siteKey(website.url) || "the website"} (${website.reason}), but Google's speed test did, so the audit left Website and Social out instead of grading Website F.`);
      website = { ...website, down: false, failure: "loads-elsewhere" };
    } else if (ran) errors.push(`pagespeed (second opinion): ${ran.error}`);
  }

  // Households: the listing's location when it is trusted, else the typed address.
  const where = google?.trusted ? { lat: google.lat, lon: google.lon, address: google.address } : typedGeo ? { lat: typedGeo.lat, lon: typedGeo.lon, address: church.address } : null;
  const reach = where ? homesWithin(where.lat, where.lon, 5, where.address, church.address) : null;
  checks.reach = reach ? "ok" : where ? "skipped" : "not-checked";

  const instagram = null; // filled in once the Meta app is connected
  const result = { church, google, nearMe, website, speed, instagram, reach, checks };
  const scores = scoreAudit(result);
  // Why each area left out of the grade was left out, as reason codes.
  const googleWhy = !key ? "no-key" : googleFailure || (google?.found && !google.trusted ? "listing-unsure" : google?.closed ? "listing-closed" : "not-checked");
  const siteWhy = website?.failure || "not-checked";
  // Social is read from the home page: a home page that did not load leaves it out with its own reason, since
  // website.failure ("timeout", "dns") describes the site, not why Social has no grade.
  const coverage = coverageOf(scores, { google: googleWhy, reviews: googleWhy, website: siteWhy, social: website?.down ? "site-down" : siteWhy });
  const notes = await within(NOTES_BY - (Date.now() - started), writeNotes({ ...result, scores, coverage }, env), fallbackNotes({ ...result, scores, coverage }));

  // Plain sentences for Chris. Any one of them holds the audit until he approves it; each one is a doubt
  // about whose data this is, or an audit with nothing to grade.
  const reasons = [];
  if (!key) info.push("No Google key is set, so Google and Reviews were left out. Set GOOGLE_API_KEY.");
  else if (google?.found) {
    if (google.confidence === "conflict" || google.confidence === "low") reasons.push(`The Google listing may be a different church: ${google.conflictReason}`);
    if (far) reasons.push(`The Google listing (${google.address}) sits ${listingMiles} miles from the address the pastor typed.`);
    // Another listing with the same website (a second campus, an old building) when the typed address could not
    // be placed on a map: the graded listing may be the other location's.
    const twin = google.trusted && listingMiles === null ? (google.possibleDuplicates || []).find((d) => d.sameSite) : null;
    if (twin) reasons.push(`Google has another listing with this church's website (${twin.name}, ${twin.address}), and the typed address could not show which one is this church.`);
    if (google.trusted && !nearMe?.checked) info.push("The near-me Google search failed, so Google was graded from the listing alone.");
  } else if (google?.listed === false) {
    const got = google.returned?.length ? ` (Google returned only ${google.returned.join("; ")})` : "";
    info.push(`No Google listing came up for this church's name and address${got}, so Google and Reviews were graded F.`);
  }
  else if (google?.closed) info.push("Google shows only a permanently closed listing for this church's name and address, so Google and Reviews were left out.");
  if (website?.source === "google") {
    info.push(website.checked
      ? `The typed website could not be checked, so the audit graded the website on the Google listing (${siteKey(website.finalUrl)}).`
      : `The typed website did not load, and the website on the Google listing (${siteKey(website.url)}) could not be checked either.`);
  } else if (triedListingSite) {
    info.push(`The website on the Google listing (${siteKey(triedListingSite.url)}) could not be checked either.`);
  }
  if (website?.down) info.push(`The website did not load on a phone (${website.reason}), so Website was graded F and Social was left out.`);
  if (!coverage.graded) reasons.push(coverageText(coverage));

  const mark = logoP ? await within(PHOTO_TIMEOUT_MS, logoP, "late") : null;
  logoStop.abort();
  if (mark === "late") errors.push("logo: ran out of time");
  else if (mark && !mark.logo && mark.misses.length) errors.push(`logo: none usable (${mark.misses.join("; ")})`);

  // The church's look for the scorecard. Colors are contrast-checked here, so the page only applies them.
  const found = website?.brand || null;
  const colors = themeColors(found);
  const logo = mark && mark !== "late" ? mark.logo : null;
  const brand = found ? { ...colors, font: found.font || null, logo, source: colors.primary ? found.source : null, found: found.primary || null } : null;

  return {
    ...result,
    brand,
    scores,
    coverage,
    notes,
    needsReview: reasons.length > 0,
    reviewReasons: reasons,
    reviewReason: reasons.length ? reasons.join(" ") : null,
    infoLines: info,
    possibleDuplicates: google?.possibleDuplicates || [],
    errors,
    checkedAt: new Date().toISOString(),
    seconds: Math.round((Date.now() - started) / 100) / 10,
  };
}
