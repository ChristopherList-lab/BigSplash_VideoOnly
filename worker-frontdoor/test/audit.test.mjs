import { test } from "node:test";
import assert from "node:assert/strict";
import { runAudit } from "../src/audit.js";
import { mobileSpeed } from "../src/pagespeed.js";
import { zipOf } from "../src/geocode.js";
import { homesWithin, stateOf } from "../src/reach.js";
import { stubFetch, page, homePage, jsonRes } from "./helpers.mjs";

const SEARCH = "https://places.googleapis.com/v1/places:searchText";
const env = { GOOGLE_API_KEY: "test-key" };
const church = { name: "City Reach Church", address: "2700 W Whitestone Blvd, Cedar Park, TX 78613", city: "Cedar Park, TX 78613", website: "https://cityreachchurch.com/" };
const HERE = { latitude: 30.528, longitude: -97.86 };
const goodSite = homePage('<a href="/visit">Plan a Visit</a><a href="/kids">Kids</a><p>Sundays 9:00 & 10:30am worship</p><a href="https://www.instagram.com/cityreach">ig</a><a href="https://www.facebook.com/cityreach">fb</a><a href="https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv">yt</a>');
const listing = (extra = {}) => ({ id: "cr", displayName: { text: "City Reach Church" }, formattedAddress: "2700 W Whitestone Blvd, Cedar Park, TX 78613, USA", location: HERE,
  rating: 4.7, userRatingCount: 264, websiteUri: "https://cityreachchurch.com/", regularOpeningHours: { periods: [{}] }, businessStatus: "OPERATIONAL", ...extra });

// One fixture world: Places, PageSpeed, Census and the church sites. Overrides go first.
function world({ site = () => page(goodSite), places = [listing()], nearMe = "rank3", geo = HERE, extra = [] } = {}) {
  return stubFetch([
    ...extra,
    [SEARCH, (url, init) => {
      const b = JSON.parse(init.body);
      if (b.textQuery !== "church") return jsonRes({ places });
      if (nearMe === "error") return jsonRes({ error: { message: "quota" } }, 429);
      return jsonRes({ places: [{ id: "a", displayName: { text: "A" } }, { id: "b", displayName: { text: "B" } }, { id: "cr", displayName: { text: "City Reach Church" } }] });
    }],
    [/pagespeedonline/, () => jsonRes({ lighthouseResult: { categories: { performance: { score: 0.91 } } } })],
    [/geocoding\.geo\.census\.gov/, () => jsonRes({ result: { addressMatches: [{ coordinates: { x: geo.longitude, y: geo.latitude }, matchedAddress: "x" }] } })],
    [/feeds\/videos\.xml/, () => page(`<feed><entry><title>Sunday</title><published>${new Date(Date.now() - 2.5 * 86400000).toISOString()}</published></entry></feed>`, 200, null, "application/xml")],
    [/cityreachchurch\.com/, site],
  ]);
}

test("a clean match is graded and not held", async () => {
  world();
  const r = await runAudit(church, env);
  assert.equal(r.needsReview, false, r.reviewReason);
  assert.deepEqual(r.checks, { google: "ok", nearMe: "ok", website: "ok", speed: "ok", reach: "ok" });
  assert.equal(r.scores.overall.grade, "A");
  assert.ok(r.reach.households > 0);
});

test("a listing with another church's website is held and not graded as this church", async () => {
  world({ places: [listing({ id: "gb", displayName: { text: "Grace Bible Church" }, websiteUri: "https://gbcgt.org/" })] });
  const r = await runAudit({ ...church, name: "Grace Bible Church" }, env);
  assert.equal(r.needsReview, true);
  assert.equal(r.google.confidence, "conflict");
  assert.equal(r.scores.areas.google.checked, false);
  assert.equal(r.scores.areas.reviews.checked, false);
  assert.ok(r.reviewReasons.some((x) => /gbcgt\.org/.test(x)));
  assert.equal(r.reviewReason, r.reviewReasons.join(" "));
});

test("a near-me search error holds the audit and never reads as 'not found'", async () => {
  world({ nearMe: "error" });
  const r = await runAudit(church, env);
  assert.equal(r.checks.nearMe, "error");
  assert.equal(r.needsReview, true);
  assert.ok(r.reviewReasons.some((x) => /near-me/.test(x)));
  assert.equal(r.scores.areas.google.points, 100); // out of 60, rank left out
  assert.equal(r.scores.findings.some((f) => /did not come up/.test(f.fact)), false);
});

test("a site that blocks the audit is not checked; the Google listing's site is tried and the audit is held", async () => {
  world({
    site: () => page("Forbidden", 403),
    places: [listing({ websiteUri: "https://cityreach.church/" })],
    extra: [[/cityreach\.church/, () => page(goodSite, 200, "https://cityreach.church/")]],
  });
  const r = await runAudit(church, env);
  assert.equal(r.website.source, "google");
  assert.equal(r.website.checked, true);
  assert.equal(r.needsReview, true);
  assert.ok(r.reviewReasons.some((x) => /used the website on the Google listing/.test(x)));
});

test("a site nobody can read stays not checked and is held, never graded F", async () => {
  world({ site: () => page("Forbidden", 403), places: [listing({ websiteUri: "https://cityreachchurch.com/" })] });
  const r = await runAudit(church, env);
  assert.equal(r.checks.website, "not-checked");
  assert.equal(r.scores.areas.website.grade, null);
  assert.equal(r.needsReview, true);
  assert.ok(r.reviewReasons.some((x) => /website was not checked/.test(x)));
});

test("a listing far from the typed address is held", async () => {
  world({ geo: { latitude: 30.528 + 0.2, longitude: -97.86 } }); // about 14 miles north
  const r = await runAudit(church, env);
  assert.equal(r.needsReview, true);
  assert.ok(r.reviewReasons.some((x) => /miles from the address/.test(x)));
  assert.equal(r.scores.areas.google.checked, false);
});

test("no Google listing holds the audit with no Google grade", async () => {
  world({ places: [] });
  const r = await runAudit(church, env);
  assert.equal(r.needsReview, true);
  assert.equal(r.scores.areas.google.grade, null);
  assert.ok(r.reviewReasons.some((x) => /No Google listing/.test(x)));
});

test("pagespeed: runtime errors are not scores, and only field data gives seconds", async () => {
  stubFetch([[/pagespeedonline/, () => jsonRes({ lighthouseResult: { runtimeError: { code: "NO_FCP" }, categories: { performance: { score: null } } } })]]);
  assert.equal((await mobileSpeed("https://x.org/")).ok, false);
  stubFetch([[/pagespeedonline/, () => jsonRes({ lighthouseResult: { categories: { performance: { score: 0.26 } }, audits: { "largest-contentful-paint": { numericValue: 18000 } } },
    loadingExperience: { metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 3140 } } } })]]);
  const s = await mobileSpeed("https://x.org/");
  assert.deepEqual([s.ok, s.score, s.fieldLcpSeconds, s.loadSeconds, s.loadTime], [true, 26, 3.1, undefined, undefined]);
});

test("ZIP fallback never takes the street number", () => {
  assert.equal(zipOf("15800 Crossroads Drive, Austin TX"), null);
  assert.equal(zipOf("15800 Crossroads Drive, Austin, TX 78717"), "78717");
  assert.equal(zipOf("Main St, Austin 78701"), "78701");
  assert.equal(zipOf("78701"), null);
});

test("reach counts Texas churches only", () => {
  assert.equal(stateOf("x, Texarkana, AR 71854, USA"), "AR");
  assert.equal(homesWithin(33.42, -94.04, 5, "x, Texarkana, AR 71854, USA"), null);
  assert.ok(homesWithin(30.528, -97.86, 5, "2700 W Whitestone Blvd, Cedar Park, TX 78613, USA").households > 0);
});
