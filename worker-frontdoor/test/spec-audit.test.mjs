// Spec item 6: audit.js holds and per-check status, run end to end against fixtures.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { stubFetch, html, json, xml, redirect, churchPage, ytFeed, daysAgoIso, allText } from "./spec-helpers.mjs";
import { runAudit } from "../src/audit.js";

const env = { GOOGLE_API_KEY: "test-places-key" };
const UC = "UCa1b2c3d4e5f6g7h8i9j0kL";
const CR = { latitude: 30.5156, longitude: -97.8703 }; // 2700 W Whitestone Blvd, Cedar Park
const GT = { latitude: 30.6327, longitude: -97.6772 }; // Georgetown
const JARRELL = { latitude: 30.8249, longitude: -97.6045 };
const ROCKWALL = { latitude: 32.9135, longitude: -96.4627 };

function place(id, name, extra = {}) {
  return {
    id, displayName: { text: name }, formattedAddress: "2700 W Whitestone Blvd, Cedar Park, TX 78613, USA", location: CR, rating: 4.7, userRatingCount: 264,
    businessStatus: "OPERATIONAL", types: ["church", "place_of_worship"],
    regularOpeningHours: { periods: [{ open: { day: 0, hour: 8, minute: 15 } }], weekdayDescriptions: ["Sunday: 8:15 AM – 12:45 PM"] },
    ...extra,
  };
}

const goodPage = (extraNav = []) => churchPage({
  title: "City Reach Church | Cedar Park",
  nav: [["/visit", "Plan a Visit"], ["/kids", "CR Kids"], ...extraNav],
  body: "<section><h3>SERVICE TIMES</h3><p>SUNDAY | 8:15AM &amp; 10AM &amp; 11:45AM</p></section>",
  footer: `<a href="https://www.instagram.com/cityreachchurch">Instagram</a><a href="https://www.facebook.com/CityReachTX">Facebook</a><a href="https://www.youtube.com/channel/${UC}">YouTube</a>`,
});

const facebookLogin = `<!DOCTYPE html><html lang="en"><head><title>Facebook</title><meta name="viewport" content="width=device-width"></head>
<body><div id="login"><h2>See more on Facebook</h2><form action="/login/"><input name="email"><input name="pass" type="password"><button>Log in</button></form>
<a href="https://www.facebook.com/recover/initiate/">Forgot password?</a><a href="/r.php">Create new account</a></div></body></html>`;

// One world of fixtures. sites: [[RegExp, handler]] for church websites; listings: the Places answer for the church's name.
function world({ listings = [place("cr", "City Reach Church", { websiteUri: "https://cityreachchurch.com/" })], sites = [[/cityreachchurch\.com/, () => html(goodPage())]],
  nearMe = "rank2", geo = { Whitestone: CR, Jarrell: JARRELL, "Rock St": GT, Rockwall: ROCKWALL }, placesError = false } = {}) {
  return stubFetch([
    [/^https:\/\/places\.googleapis\.com\/v1\/places/, (c) => {
      if (c.method === "GET") { const p = listings.find((x) => c.url.includes(x.id)); return p ? json(p) : json({ error: { message: "not found" } }, 404); }
      const b = c.json();
      if (b.textQuery !== "church") return placesError ? json({ error: { code: 500, message: "Internal error" } }, 500) : json({ places: listings });
      if (nearMe === "429") return json({ error: { code: 429, message: "Quota exceeded for quota metric 'Text Search requests'", status: "RESOURCE_EXHAUSTED" } }, 429);
      const me = listings.find((x) => x.businessStatus !== "CLOSED_PERMANENTLY") || listings[0];
      return json({ places: [{ id: "hcbc", displayName: { text: "Hill Country Bible Church" } }, ...(me ? [{ id: me.id, displayName: me.displayName }] : []), { id: "life", displayName: { text: "Life Church" } }] });
    }],
    [/pagespeedonline/, () => json({ lighthouseResult: { categories: { performance: { score: 0.91 } } } })],
    [/geocoding\.geo\.census\.gov/, (c) => {
      const addr = decodeURIComponent(new URL(c.url).searchParams.get("address") || c.url).replace(/\+/g, " ");
      const hit = Object.entries(geo).find(([k]) => addr.includes(k));
      return json({ result: { addressMatches: hit ? [{ matchedAddress: addr.toUpperCase(), coordinates: { x: hit[1].longitude, y: hit[1].latitude } }] : [] } });
    }],
    [/nominatim\.openstreetmap\.org/, () => json([])],
    [/feeds\/videos\.xml/, () => xml(ytFeed([["Sunday Service", daysAgoIso(3.2)], ["Sunday Service 2", daysAgoIso(10.2)]]))],
    ...sites,
  ]);
}

const cityReach = { name: "City Reach Church", address: "2700 W Whitestone Blvd, Cedar Park, TX 78613", city: "Cedar Park, TX 78613", website: "cityreachchurch.com" };
const pastorText = (r) => allText(r.scores?.findings) + allText(r.notes);
// Sent automatically: nothing held, and every pastor-facing word stays kind (no "down", no blame for our checks).
const sent = (r) => {
  assert.equal(r.needsReview, false, r.reviewReason);
  assert.deepEqual(r.reviewReasons, []);
  assert.ok(r.scores.overall.grade, "an overall grade from the areas that were checked");
};
const held = (r) => {
  assert.equal(r.needsReview, true, "audit should be held");
  assert.ok(Array.isArray(r.reviewReasons) && r.reviewReasons.length > 0, "reviewReasons");
  assert.ok(r.reviewReasons.every((x) => typeof x === "string" && x.length > 10), "plain sentences");
  assert.equal(r.reviewReason, r.reviewReasons.join(" "));
};

describe("runAudit", () => {
  test("City Reach clean match: every check ok, graded, not held", async () => {
    world();
    const r = await runAudit(cityReach, env);
    assert.equal(r.needsReview, false, r.reviewReason);
    assert.deepEqual(r.reviewReasons, []);
    assert.deepEqual(r.checks, { google: "ok", nearMe: "ok", website: "ok", speed: "ok", reach: "ok" });
    assert.equal(r.google.confidence, "high");
    assert.equal(r.website.source, "typed");
    assert.ok(r.scores.overall.grade);
    assert.ok(r.reach && r.reach.households > 0);
  });

  test("Grace Bible Church typed with cityreachchurch.com: conflict, held", async () => {
    world({ listings: [place("gb", "Grace Bible Church", { websiteUri: "https://gbcgt.org/", formattedAddress: "1101 Leander Rd, Georgetown, TX 78628, USA", location: GT, userRatingCount: 310 })],
      sites: [[/cityreachchurch\.com/, () => html(goodPage())], [/gbcgt\.org/, () => html(churchPage({ nav: [["/visit", "Plan Your Visit"]] }))]] });
    const r = await runAudit({ name: "Grace Bible Church", address: "Georgetown, TX", city: "Georgetown, TX", website: "cityreachchurch.com" }, env);
    held(r);
    assert.ok(["conflict", "low"].includes(r.google.confidence), r.google.confidence);
  });

  test("Faith Lutheran: bogus typed site, working Google site is used, held, never 'did not load'", async () => {
    world({
      listings: [place("fl", "Faith Lutheran Church", { websiteUri: "https://flcms.org/", formattedAddress: "1407 Rock St, Georgetown, TX 78626, USA", location: GT, userRatingCount: 85 })],
      sites: [[/flcms\.org/, () => html(churchPage({ nav: [["/plan-a-visit", "Plan a Visit"], ["/preschool", "Preschool"]], body: "<p>Sunday Worship 8:30 &amp; 11:00 AM</p>" }))]],
    });
    const r = await runAudit({ name: "Faith Lutheran Church", address: "1407 Rock St, Georgetown, TX 78626", city: "Georgetown, TX 78626", website: "flcms.invalid" }, env);
    assert.equal(r.website.source, "google");
    assert.equal(r.website.checked, true);
    assert.equal(r.website.planVisit.found, true);
    held(r);
    assert.ok(r.scores.areas.website.grade, "website graded from the listing's site");
    assert.equal(/did not load|back online|is down/i.test(pastorText(r)), false, pastorText(r));
  });

  test("fpcgeorgetown.org style 403-to-bots site still checked when the iPhone UA gets 200", async () => {
    world({
      listings: [place("fpc", "First Presbyterian Church", { websiteUri: "https://fpcgeorgetown.org/", formattedAddress: "1101 Rock St, Georgetown, TX 78626, USA", location: GT })],
      sites: [[/fpcgeorgetown\.org/, (c) => (/iPhone/.test(c.headers.get("user-agent") || "") ? html(goodPage()) : html("Forbidden", 403))]],
    });
    const r = await runAudit({ name: "First Presbyterian Church", address: "1101 Rock St, Georgetown, TX 78626", city: "Georgetown, TX", website: "fpcgeorgetown.org" }, env);
    assert.equal(r.checks.website, "ok");
    assert.equal(r.website.checked, true);
  });

  test("near-me 429: Google graded without rank, no 'did not come up', sent with a note for Chris", async () => {
    world({ nearMe: "429" });
    const r = await runAudit(cityReach, env);
    assert.ok(["error", "not-checked"].includes(r.checks.nearMe), r.checks.nearMe);
    assert.equal(r.nearMe?.checked ?? false, false);
    sent(r);
    assert.equal(r.coverage.graded, 4);
    assert.ok(r.infoLines.some((x) => /near-me Google search failed/.test(x)), r.infoLines.join(" "));
    assert.ok(r.scores.areas.google.grade, "Google still graded");
    assert.ok(Math.abs(r.scores.areas.google.points - 100) <= 1, String(r.scores.areas.google.points));
    assert.equal(/did not come up|not in the top|Not in top/i.test(pastorText(r)), false, pastorText(r));
  });

  test("Cloudflare challenge on the church site: left out, no website grade, sent on the other areas", async () => {
    const cf = `<html><head><title>Just a moment...</title></head><body><p>Enable JavaScript and cookies to continue</p><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></body></html>`;
    world({ sites: [[/cityreachchurch\.com/, () => html(cf, 403, { server: "cloudflare" })]] });
    const r = await runAudit(cityReach, env);
    assert.equal(r.checks.website, "not-checked");
    assert.equal(r.website.checked, false);
    assert.equal(r.scores.areas.website.grade ?? null, null);
    assert.equal(r.scores.areas.social.grade ?? null, null);
    sent(r);
    assert.deepEqual(r.coverage.missing, [{ area: "website", why: "blocked" }, { area: "social", why: "blocked" }]);
    assert.equal(r.coverage.note, "Graded on 2 of 4 areas. We couldn't check your website this time.");
    assert.equal(/did not load|didn't load|back online|is down/i.test(pastorText(r)), false);
  });

  test("JavaScript shell site: left out, sent, no false 'missing' claims", async () => {
    world({ sites: [[/cityreachchurch\.com/, () => html('<!DOCTYPE html><html><head><title>City Reach</title></head><body><noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div><script src="/static/js/main.4f2a.js"></script></body></html>')]] });
    const r = await runAudit(cityReach, env);
    assert.equal(r.website.checked, false);
    assert.equal(r.website.reason, "page builds itself with JavaScript");
    assert.equal(r.website.failure, "javascript");
    sent(r);
    assert.equal(r.coverage.graded, 2);
    assert.equal(/plan-your-visit|service times are|kids|social accounts|sermons/i.test(allText(r.scores.findings)), false, allText(r.scores.findings));
  });

  test("Facebook page typed as the website: left out, sent, no false claims", async () => {
    world({
      listings: [place("fbc", "First Baptist Church of Georgetown", { websiteUri: "https://www.facebook.com/FBCGeorgetown", formattedAddress: "1333 W University Ave, Georgetown, TX 78628, USA", location: GT })],
      sites: [[/facebook\.com/, () => html(facebookLogin)]],
      geo: { University: GT },
    });
    const r = await runAudit({ name: "First Baptist Church of Georgetown", address: "1333 W University Ave, Georgetown, TX 78628", city: "Georgetown, TX", website: "facebook.com/FBCGeorgetown" }, env);
    assert.equal(r.website.checked, false);
    assert.equal(r.website.down, false);
    sent(r);
    assert.equal(/plan-your-visit|service times are|kids|social accounts/i.test(allText(r.scores.findings)), false, allText(r.scores.findings));
  });

  test("generic First Baptist Church in Jarrell matched to Georgetown's listing is held", async () => {
    world({
      listings: [place("fbcg", "First Baptist Church of Georgetown", { websiteUri: "https://fbcgeorgetown.org/", formattedAddress: "1333 W University Ave, Georgetown, TX 78628, USA", location: GT, userRatingCount: 410 })],
      sites: [[/fbcjarrell\.org/, () => html(goodPage())], [/fbcgeorgetown\.org/, () => html(goodPage())]],
    });
    const r = await runAudit({ name: "First Baptist Church", address: "123 Main St, Jarrell, TX 76537", city: "Jarrell, TX 76537", website: "fbcjarrell.org" }, env);
    held(r);
  });

  test("a listing more than 5 miles from the typed street address is held", async () => {
    world({ listings: [place("cr", "City Reach Church", { websiteUri: "https://cityreachchurch.com/", location: { latitude: CR.latitude + 0.2, longitude: CR.longitude } })] });
    const r = await runAudit(cityReach, env);
    held(r);
  });

  test("Lakepointe: typed site redirects to the listing's domain, so no domain hold", async () => {
    world({
      listings: [place("lp", "Lakepointe Church", { websiteUri: "https://lakepointe.church/", formattedAddress: "701 E Interstate 30, Rockwall, TX 75087, USA", location: ROCKWALL })],
      sites: [[/^https?:\/\/(www\.)?lakepointe\.org\//, () => redirect("https://lakepointe.church/")], [/lakepointe\.church/, () => html(goodPage())]],
    });
    const r = await runAudit({ name: "Lakepointe Church", address: "701 E Interstate 30, Rockwall, TX 75087", city: "Rockwall, TX 75087", website: "lakepointe.org" }, env);
    assert.equal(r.website.checked, true);
    assert.equal(r.needsReview, false, r.reviewReason);
  });

  test("no Google listing: Google and Reviews graded F with the claim-your-listing fix, sent", async () => {
    world({ listings: [] });
    const r = await runAudit(cityReach, env);
    sent(r);
    assert.equal(r.scores.areas.google.grade, "F");
    assert.equal(r.scores.areas.reviews.grade, "F");
    assert.equal(r.coverage.graded, 4);
    assert.match(pastorText(r), /We couldn't find your church on Google Maps\./);
    assert.match(pastorText(r), /Claim your free Google Business Profile/);
  });

  test("Google lookup error (500): Google and Reviews left out, graded on the website, sent", async () => {
    world({ placesError: true });
    const r = await runAudit(cityReach, env);
    assert.equal(r.checks.google, "error");
    sent(r);
    assert.equal(r.scores.areas.google.grade ?? null, null);
    assert.deepEqual(r.coverage.missing, [{ area: "google", why: "api-error" }, { area: "reviews", why: "api-error" }]);
    assert.equal(r.coverage.note, "Graded on 2 of 4 areas. We couldn't check Google this time.");
    assert.equal(/Google Maps|Business Profile/.test(pastorText(r)), false, "our failure never reads as a missing listing");
  });

  test("preschool sharing the domain loses; possible duplicates stay on the result for Slack", async () => {
    world({
      listings: [
        place("pre", "Faith Lutheran Preschool", { websiteUri: "https://flcms.org/preschool", userRatingCount: 6, rating: 3.9, formattedAddress: "1405 Rock St, Georgetown, TX 78626, USA", location: GT }),
        place("fl", "Faith Lutheran Church", { userRatingCount: 85, rating: 4.8, formattedAddress: "1407 Rock St, Georgetown, TX 78626, USA", location: GT }),
      ],
      sites: [[/flcms\.org/, () => html(goodPage())]],
    });
    const r = await runAudit({ name: "Faith Lutheran Church", address: "1407 Rock St, Georgetown, TX 78626", city: "Georgetown, TX", website: "flcms.org" }, env);
    assert.equal(r.google.reviewCount, 85);
    assert.ok((r.possibleDuplicates || []).some((d) => /Preschool/.test(d.name)), JSON.stringify(r.possibleDuplicates));
    assert.equal(/Preschool/.test(pastorText(r)), false, "duplicates never reach the pastor");
  });

  test("a closed listing with the same site never wins", async () => {
    world({ listings: [
      place("old", "City Reach Church", { websiteUri: "https://cityreachchurch.com/", businessStatus: "CLOSED_PERMANENTLY", userRatingCount: 12, formattedAddress: "3501 Hatch Rd, Cedar Park, TX 78613, USA" }),
      place("cr", "City Reach Church", { websiteUri: "https://cityreachchurch.com/", userRatingCount: 264 }),
    ] });
    const r = await runAudit(cityReach, env);
    assert.equal(r.google.reviewCount, 264);
  });
});
