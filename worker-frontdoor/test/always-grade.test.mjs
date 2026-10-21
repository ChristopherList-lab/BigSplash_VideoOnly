// Chris's rule (2026-10-20): always give a score. Every area that was checked counts toward the grade; a site that
// did not load and a church with no Google listing are graded low with the fix; a check that failed on our side
// leaves its areas out with a plain note; and only doubt about whose data this is (or nothing to grade) holds an
// audit. Every test answers from fixtures; nothing reaches the network.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { stubFetch, html, json, xml, churchPage, ytFeed, daysAgoIso, dnsError, resetError, timeoutError, fakeEnv, fakeStep, allText } from "./spec-helpers.mjs";
import { fakeGhl, GHL_ENV } from "./ghl-fake.mjs";
import { checkWebsite } from "../src/website.js";
import { findListing, nearMeRank, placesFailure } from "../src/google.js";
import { scoreAudit, coverageOf, coverageNote, coverageText, rankFact, AREAS } from "../src/score.js";
import { fallbackNotes } from "../src/write.js";
import { runAudit } from "../src/audit.js";
import { scorecardEmail, approvedEmail } from "../src/messages.js";
import { leadPayload, noteText, messageVars } from "../src/deliver.js";
import { themeColors, washOf, contrast, PAGE_BACKGROUNDS } from "../src/brand.js";
import { fetchLogo, saveLogo, logoSizeOk, RASTER_MAX_PIXELS } from "../src/logo.js";
import worker, { FrontDoorAudit } from "../src/worker.js";

const NAME = "Cedar Bend Church";
const SITE = "cedarbendchurch.org";
const HERE = { latitude: 30.5156, longitude: -97.8703 };
const UC = "UCa1b2c3d4e5f6g7h8i9j0kL";
const cedarBend = { name: NAME, address: "100 Cedar Bend Dr, Cedar Park, TX 78613", city: "Cedar Park, TX 78613", website: SITE };
const goodPage = churchPage({
  title: "Cedar Bend Church",
  nav: [["/visit", "Plan a Visit"], ["/kids", "Kids"]],
  body: "<section><h3>SERVICE TIMES</h3><p>SUNDAY | 9AM &amp; 11AM</p></section>",
  footer: `<a href="https://www.instagram.com/cedarbend">Instagram</a><a href="https://www.facebook.com/cedarbend">Facebook</a><a href="https://www.youtube.com/channel/${UC}">YouTube</a>`,
});
const challenge = `<html><head><title>Just a moment...</title></head><body><p>Enable JavaScript and cookies to continue</p></body></html>`;
const pastorText = (r) => allText(r.scores?.findings) + allText(r.notes) + allText(r.coverage?.note);

function place(id, name, extra = {}) {
  return {
    id, displayName: { text: name }, formattedAddress: "100 Cedar Bend Dr, Cedar Park, TX 78613, USA", location: HERE, rating: 4.7, userRatingCount: 88,
    businessStatus: "OPERATIONAL", types: ["church", "place_of_worship"], websiteUri: `https://${SITE}/`,
    regularOpeningHours: { periods: [{ open: { day: 0, hour: 9 } }], weekdayDescriptions: ["Sunday: 9:00 AM – 12:30 PM"] }, ...extra,
  };
}

// One fixture world for the audit. places: the listing search ("ok", "empty", "closed", "quota", "error", "timeout",
// "key") or a list of listings; nearMe: "ok" or "429"; site: the church site's answer; psi: "auto" loads only a
// working site, "loads" loads any site (Google can reach a site our check could not).
function world({ places = "ok", nearMe = "ok", site = "good", psi = "auto", extra = [] } = {}) {
  const SITES = {
    good: () => html(goodPage),
    timeout: timeoutError(),
    502: () => html("<h1>502 Bad Gateway</h1>", 502),
    526: () => html("<h1>Invalid SSL certificate</h1>", 526),
    403: () => html("Forbidden", 403),
    challenge: () => html(challenge, 403),
    dns: dnsError(),
    reset: resetError(),
    js: () => html('<html><head><title>Cedar Bend</title></head><body><div id="root"></div></body></html>'),
  };
  const listings = Array.isArray(places) ? places : places === "closed" ? [place("old", NAME, { businessStatus: "CLOSED_PERMANENTLY" })] : [place("cb", NAME)];
  return stubFetch([
    ...extra,
    [/^https:\/\/places\.googleapis\.com/, (c) => {
      const b = c.json();
      if (b.textQuery === "church") {
        if (nearMe === "429") return json({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" } }, 429);
        return json({ places: [{ id: "hc", displayName: { text: "Hill Country Fellowship" }, types: ["church"] }, { id: listings[0]?.id, displayName: listings[0]?.displayName, types: ["church"] }] });
      }
      if (places === "quota") return json({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for quota metric 'Text Search requests'" } }, 429);
      if (places === "error") return json({ error: { code: 500, status: "INTERNAL", message: "Internal error" } }, 500);
      if (places === "key") return json({ error: { code: 403, status: "PERMISSION_DENIED", message: "API key not valid" } }, 403);
      if (places === "timeout") throw timeoutError();
      if (places === "empty") return json({});
      return json({ places: listings });
    }],
    [/pagespeedonline/, (c) => {
      const target = decodeURIComponent(new URL(c.url).searchParams.get("url") || "");
      const loads = psi === "loads" || (site === "good" && target.includes(SITE)) || !target.includes(SITE);
      return loads ? json({ lighthouseResult: { categories: { performance: { score: 0.91 } } } })
        : json({ lighthouseResult: { runtimeError: { code: "FAILED_DOCUMENT_REQUEST" }, categories: { performance: { score: null } } } });
    }],
    [/geocoding\.geo\.census\.gov/, (c) => json({ result: { addressMatches: /Cedar Bend|Main St/.test(decodeURIComponent(c.url).replace(/\+/g, " ")) ? [{ matchedAddress: "X", coordinates: { x: HERE.longitude, y: HERE.latitude } }] : [] } })],
    [/nominatim/, () => json([])],
    [/feeds\/videos\.xml/, () => xml(ytFeed([["Sunday", daysAgoIso(3.2)]]))],
    [new RegExp(SITE.replace(/\./g, "\\.")), SITES[site]],
    [/api\.anthropic\.com/, () => json({ error: { message: "no" } }, 401)],
  ]);
}
const KEY = { GOOGLE_API_KEY: "test-places-key" };

// ---------- website.js: why a site was not read ----------
describe("website reason codes", () => {
  const cases = [
    ["a timeout on every address", timeoutError(), { down: true, failure: "timeout" }, /too long/],
    ["a server error (502) on every address", () => html("Bad gateway", 502), { down: true, failure: "server-error" }, /error \(502\)/],
    ["Cloudflare 521 (refused)", () => html("Web server is down", 521), { down: true, failure: "refused" }],
    ["Cloudflare 522 (timed out)", () => html("Connection timed out", 522), { down: true, failure: "timeout" }],
    ["Cloudflare 526 (broken certificate)", () => html("Invalid SSL certificate", 526), { down: true, failure: "certificate" }],
    ["DNS failure everywhere", dnsError(), { down: true, failure: "dns" }, /^did not load$/],
    ["a 404 home page", () => html("Not Found", 404), { down: true, failure: "no-home-page" }, /^did not load$/],
    ["connection refused", Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }), { down: true, failure: "refused" }],
    ["an expired certificate", Object.assign(new TypeError("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED", message: "certificate has expired" } }), { down: true, failure: "certificate" }],
    ["a 403 (our check turned away)", () => html("Forbidden", 403), { down: false, failure: "blocked" }, /403/],
    ["a 429", () => html("Slow down", 429), { down: false, failure: "blocked" }],
    ["a 503 (Wordfence and maintenance pages look the same)", () => html("Service Unavailable", 503), { down: false, failure: "blocked" }],
    ["a bot challenge page", () => html(challenge, 403), { down: false, failure: "blocked" }, /bot check/],
    ["a connection reset (a firewall can drop our check)", resetError(), { down: false, failure: "connection" }],
    ["a PDF at the address", () => new Response("%PDF-1.4", { headers: { "content-type": "application/pdf" } }), { down: false, failure: "not-a-page" }],
  ];
  for (const [name, answer, want, reason] of cases) {
    test(name, async () => {
      stubFetch([[/cedarbend\.example/, answer]]);
      const w = await checkWebsite("cedarbend.example");
      assert.equal(w.checked, false);
      assert.deepEqual({ down: w.down, failure: w.failure }, want);
      if (reason) assert.match(w.reason, reason);
    });
  }

  test("down only when every address fails the way a phone would: a 403 anywhere means our check was turned away", async () => {
    stubFetch([[/^https:\/\/cedarbend\.example\//, timeoutError()], [/^http:\/\/cedarbend\.example\//, () => html("Forbidden", 403)]]);
    const w = await checkWebsite("cedarbend.example");
    assert.deepEqual([w.down, w.failure], [false, "blocked"]);
  });

  test("a mix of server errors and DNS misses is down, named by the server error", async () => {
    stubFetch([[/^https?:\/\/cedarbend\.example\//, () => html("Oops", 500)]]); // the www addresses fall to DNS misses
    const w = await checkWebsite("cedarbend.example");
    assert.deepEqual([w.down, w.failure, w.status], [true, "server-error", 500]);
  });

  test("a 404 on a deeper typed page may be a typo, so it is not down", async () => {
    stubFetch([[/cedarbend\.example/, () => html("Not Found", 404)]]);
    const w = await checkWebsite("cedarbend.example/welcome");
    assert.deepEqual([w.down, w.failure], [false, "page-missing"]);
  });

  test("a JavaScript shell and a non-address are left out, not down", async () => {
    stubFetch([[/cedarbend\.example/, () => html('<html><body><div id="root"></div></body></html>')]]);
    let w = await checkWebsite("cedarbend.example");
    assert.deepEqual([w.checked, w.down, w.failure], [false, false, "javascript"]);
    const calls = stubFetch([]);
    for (const typed of ["none", "n/a", "", "TBD"]) {
      w = await checkWebsite(typed);
      assert.deepEqual([w.checked, w.down, w.failure, w.reason], [false, false, "no-address", "no usable website address"], typed);
    }
    assert.equal(calls.length, 0, "nothing fetched for a non-address");
  });

  test("a site that loads has no failure code", async () => {
    stubFetch([[/cedarbend\.example/, () => html(goodPage)]]);
    const w = await checkWebsite("cedarbend.example");
    assert.equal(w.checked, true);
    assert.equal(w.down, undefined);
  });
});

// ---------- google.js: no listing versus a failed lookup ----------
describe("Google reason codes", () => {
  const church = { name: NAME, address: cedarBend.address, website: SITE };
  test("Places answering with nothing is a real finding: listed false", async () => {
    stubFetch([[/places\.googleapis\.com/, () => json({})]]);
    assert.deepEqual(await findListing("k", church), { found: false, listed: false, query: `${NAME}, ${cedarBend.address}`, possibleDuplicates: [] });
  });

  test("only a permanently closed listing is listed but not found", async () => {
    stubFetch([[/places\.googleapis\.com/, () => json({ places: [place("old", NAME, { businessStatus: "CLOSED_PERMANENTLY" })] })]]);
    const g = await findListing("k", church);
    assert.deepEqual([g.found, g.listed, g.closed], [false, true, true]);
  });

  for (const [name, answer, code] of [
    ["quota (429)", () => json({ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" } }, 429), "quota"],
    ["quota named in a 403", () => json({ error: { code: 403, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded" } }, 403), "quota"],
    ["a rejected key", () => json({ error: { code: 403, status: "PERMISSION_DENIED", message: "API key not valid" } }, 403), "key-rejected"],
    ["a server error", () => json({ error: { code: 500, message: "Internal" } }, 500), "api-error"],
    ["a timeout", timeoutError(), "timeout"],
    ["a network error", resetError(), "api-error"],
  ]) {
    test(`a failed lookup throws, and placesFailure names it: ${name}`, async () => {
      stubFetch([[/places\.googleapis\.com/, answer]]);
      const err = await findListing("k", church).then(() => null, (e) => e);
      assert.ok(err, "findListing throws on a failed lookup");
      assert.equal(placesFailure(err), code);
    });
  }
});

describe("Google: a reply we could not read is our failure, never 'not on Google Maps'", () => {
  const church = { name: NAME, address: cedarBend.address, website: SITE };
  const garbled = () => new Response("<html>upstream hiccup</html>", { status: 200, headers: { "content-type": "text/html" } });
  const stalled = () => new Response(new ReadableStream({ start(c) { c.error(timeoutError()); } }), { status: 200, headers: { "content-type": "application/json" } });

  test("a 200 that will not parse throws (api-error); a body that times out mid-read throws (timeout)", async () => {
    for (const [answer, code] of [[garbled, "api-error"], [stalled, "timeout"]]) {
      stubFetch([[/places\.googleapis\.com/, answer]]);
      const err = await findListing("k", church).then(() => null, (e) => e);
      assert.ok(err, `${code}: findListing throws`);
      assert.equal(placesFailure(err), code);
    }
  });

  test("Places (New) answers {} for no results: still an empty answer, not a failure", async () => {
    stubFetch([[/places\.googleapis\.com/, () => json({})]]);
    assert.equal((await findListing("k", church)).listed, false);
  });

  test("near-me: unreadable replies and searches with no churches are not checked, and the fact never says 'among the 0'", async () => {
    const me = { found: true, id: "me", lat: HERE.latitude, lon: HERE.longitude };
    for (const answer of [garbled, stalled, () => json({}), () => json({ places: [{ id: "x", displayName: { text: "Church's Chicken" }, types: ["restaurant"] }] })]) {
      stubFetch([[/places\.googleapis\.com/, answer]]);
      const r = await nearMeRank("k", me);
      assert.equal(r.checked, false);
      assert.deepEqual(r.searches.map((x) => x.checked), [false, false]);
      assert.equal(rankFact(NAME, r), null);
    }
  });

  test("runAudit: a garbled Places reply leaves Google and Reviews out and sends", async () => {
    world({ extra: [[/places\.googleapis\.com/, garbled]] });
    const r = await runAudit(cedarBend, KEY);
    assert.equal(r.needsReview, false, r.reviewReason);
    assert.deepEqual(r.coverage.missing, [{ area: "google", why: "api-error" }, { area: "reviews", why: "api-error" }]);
    assert.equal(/Google Maps|Business Profile|among the 0/.test(pastorText(r)), false);
  });

  test("runAudit: listing found but every near-me reply garbled grades Google from the listing alone", async () => {
    world({ extra: [[(c) => /places\.googleapis\.com/.test(c.url) && c.json().textQuery === "church", garbled]] });
    const r = await runAudit(cedarBend, KEY);
    assert.equal(r.needsReview, false, r.reviewReason);
    assert.equal(r.nearMe.checked, false);
    assert.equal(r.scores.areas.google.grade, "A");
    assert.equal(/among the 0|did not come up/.test(pastorText(r)), false);
    assert.ok(r.infoLines.some((x) => /near-me Google search failed/.test(x)));
  });
});

describe("Google: no listing means nothing Google returned is this church or any church", () => {
  const church = { name: NAME, address: cedarBend.address, website: SITE };
  const pizza = place("pz", "Hill Country Pizza", { types: ["restaurant", "food"], primaryType: "pizza_restaurant", websiteUri: "https://hcpizza.example/", userRatingCount: 300 });
  const street = { id: "addr", displayName: { text: "100 Cedar Bend Dr" }, formattedAddress: "100 Cedar Bend Dr, Cedar Park, TX 78613, USA", location: HERE, types: ["street_address"], businessStatus: undefined };
  const otherChurch = place("gb", "Grace Bible Church", { websiteUri: "https://gbcgt.example/" });
  const fbc = place("fbc", "FBC Cedar Park", { websiteUri: undefined, primaryType: "church" });

  test("a pizza shop with its own website, or the street address alone, is no listing", async () => {
    for (const answer of [[pizza], [street], [street, pizza]]) {
      stubFetch([[/places\.googleapis\.com/, () => json({ places: answer })]]);
      const g = await findListing("k", church);
      assert.deepEqual([g.found, g.listed], [false, false], answer.map((x) => x.displayName.text).join(", "));
    }
  });

  test("a church-typed place under another name may be this church: found, low or conflict, never 'no listing'", async () => {
    for (const [answer, confidence] of [[[otherChurch], "conflict"], [[fbc], "low"], [[pizza, fbc], "low"]]) {
      stubFetch([[/places\.googleapis\.com/, () => json({ places: answer })]]);
      const g = await findListing("k", church);
      assert.deepEqual([g.found, g.confidence], [true, confidence], answer.map((x) => x.displayName.text).join(", "));
    }
  });

  test("a place that shares the website or the name is never 'no listing', church-typed or not", async () => {
    stubFetch([[/places\.googleapis\.com/, () => json({ places: [place("cb", "Cedar Bend Community Center", { types: ["community_center"], primaryType: "community_center" })] })]]);
    const g = await findListing("k", church);
    assert.equal(g.found, true);
  });

  test("runAudit: pizza shop or street address sends with Google F; a church under another name holds", async () => {
    for (const places of [[pizza], [street]]) {
      world({ places });
      const r = await runAudit(cedarBend, KEY);
      assert.equal(r.needsReview, false, r.reviewReason);
      assert.deepEqual([r.scores.areas.google.grade, r.scores.areas.reviews.grade, r.coverage.graded], ["F", "F", 4]);
      assert.ok(r.infoLines.some((x) => x === `No Google listing came up for this church's name and address (Google returned only ${places[0].displayName.text}), so Google and Reviews were graded F.`), r.infoLines.join(" | "));
    }
    world({ places: [fbc] });
    const r = await runAudit(cedarBend, KEY);
    assert.equal(r.needsReview, true);
    assert.match(r.reviewReasons[0], /may be a different church/);
  });
});

describe("a typed 'none' is not a website", () => {
  test("'none', 'n/a' and '-' with a matching listing that has a site: medium, sent, graded on the listing's site", async () => {
    for (const typed of ["none", "n/a", "-"]) {
      world({ places: [place("cb", NAME, { websiteUri: "https://cedarbend.church/" })], extra: [[/cedarbend\.church/, () => html(goodPage)]] });
      const r = await runAudit({ ...cedarBend, website: typed }, KEY);
      assert.equal(r.google.confidence, "medium", typed);
      assert.equal(r.needsReview, false, `${typed}: ${r.reviewReason}`);
      assert.deepEqual([r.website.source, r.website.checked, r.scores.areas.website.grade !== null], ["google", true, true], typed);
      assert.ok(r.infoLines.some((x) => /graded the website on the Google listing \(cedarbend\.church\)/.test(x)), r.infoLines.join(" | "));
    }
  });
});

// ---------- score.js ----------
const website = (x = {}) => ({ ok: true, checked: true, https: true, viewport: true, url: `https://${SITE}/`, finalUrl: `https://${SITE}/`, serviceTimes: { found: true }, planVisit: { found: true }, kids: { found: true },
  socials: { facebook: {}, instagram: {}, youtube: {} }, sermons: { found: true, sources: ["YouTube"] }, youtube: { daysSinceLastUpload: 3 }, vimeo: null, ...x });
const listing = (x = {}) => ({ found: true, trusted: true, rating: 4.8, reviewCount: 264, hoursListed: true, website: `https://${SITE}/`, ...x });
const nearMe = { checked: true, best: 2, searches: [{ from: "north", milesAway: 4, checked: true, rank: 2, scanned: 2 }] };
const downSite = (failure, x = {}) => ({ ok: false, checked: false, url: `https://${SITE}/`, source: "typed", reason: "the site took too long to answer", down: true, failure, ...x });

describe("grading what a family would hit", () => {
  test("a website that did not load grades Website F with the fix, keeps Google, and leaves Social out (we never read it)", () => {
    const a = { church: { name: NAME }, google: listing(), nearMe, website: downSite("timeout") };
    const s = scoreAudit(a);
    assert.deepEqual(AREAS.map((k) => s.areas[k].grade), ["A", "A", "F", null]);
    assert.equal(s.areas.website.points, 0);
    assert.equal(s.areas.social.checked, false);
    assert.equal(s.findings[0].fact, "Your website didn't load when we opened it on a phone. The site didn't answer in time.");
    assert.equal(s.findings[0].fix, "Get your website loading on phones again");
    assert.equal(s.findings.some((f) => f.area === "social"), false, "no Social finding: the links were never read");
    assert.equal(s.overall.points, Math.round((s.areas.google.points + s.areas.reviews.points + 0) / 3));
    assert.equal(s.overall.grade, "D", "one failed fetch costs one area, not two");
    const n = fallbackNotes({ ...a, scores: s });
    assert.match(n.summary, /The biggest gap: your website didn't load when we opened it on a phone\./);
    assert.deepEqual(n.fixes.map((f) => f.title).filter((t) => /website loading/.test(t)), ["Get your website loading on phones again"], "the shared fix is listed once");
  });

  test("each way a site can be down reads plainly", () => {
    const fact = (w) => scoreAudit({ church: { name: NAME }, website: w }).findings[0];
    assert.match(fact(downSite("server-error", { status: 502 })).fact, /The site answered with a server error \(502\)\.$/);
    assert.match(fact(downSite("dns")).fact, /The web address doesn't lead to a site right now\.$/);
    assert.equal(fact(downSite("dns")).fix, "Make sure your web address still points to your site");
    assert.match(fact(downSite("certificate")).fact, /security certificate is broken/);
    assert.equal(fact(downSite("certificate")).fix, "Fix your website's security certificate");
    assert.match(fact(downSite("refused")).fact, /didn't accept the connection/);
    assert.match(fact(downSite("no-home-page")).fact, /page not found/);
  });

  test("a website our check could not read (down: false, or an older result) is left out, never F", () => {
    for (const w of [downSite("blocked", { down: false }), { ok: false, checked: false, reason: "did not load" }, null]) {
      const s = scoreAudit({ church: { name: NAME }, google: listing(), nearMe, website: w });
      assert.deepEqual([s.areas.website.grade, s.areas.social.grade], [null, null], JSON.stringify(w));
      assert.equal(s.overall.grade, "A");
      assert.equal(/didn't load|couldn't reach/.test(allText(s.findings)), false);
    }
  });

  test("no Google listing grades Google and Reviews F with claim-your-listing fixes", () => {
    const s = scoreAudit({ church: { name: NAME }, google: { found: false, listed: false }, website: website(), speed: { ok: true, score: 92 } });
    assert.deepEqual(AREAS.map((k) => s.areas[k].grade), ["F", "F", "A", "A"]);
    assert.deepEqual(s.findings.slice(0, 2).map((f) => [f.area, f.fact, f.fix]), [
      ["google", "We couldn't find your church on Google Maps.", "Claim your free Google Business Profile"],
      ["reviews", "With no Google listing, a family can't read reviews of your church yet.", "Ask your members for Google reviews once your listing is live"],
    ]);
  });

  test("the overall grade averages any number of graded areas, and is null only with none", () => {
    const one = scoreAudit({ church: { name: NAME }, website: website({ planVisit: { found: false } }), speed: { ok: true, score: 92 } });
    assert.equal(one.areas.google.grade, null);
    assert.equal(one.overall.points, Math.round((one.areas.website.points + one.areas.social.points) / 2));
    const none = scoreAudit({ church: { name: NAME } });
    assert.deepEqual([none.overall.points, none.overall.grade], [null, null]);
  });
});

describe("coverage", () => {
  const scores = (grades) => ({ areas: Object.fromEntries(AREAS.map((k, i) => [k, { grade: grades[i] }])) });
  test("notes for each partial shape, and none at 4 of 4", () => {
    assert.equal(coverageOf(scores(["A", "B", "C", "D"])).note, null);
    assert.equal(coverageOf(scores([null, null, "C", "D"])).note, "Graded on 2 of 4 areas. We couldn't check Google this time.");
    assert.equal(coverageOf(scores(["A", "B", null, null])).note, "Graded on 2 of 4 areas. We couldn't check your website this time.");
    assert.equal(coverageOf(scores([null, "B", "C", "D"])).note, "Graded on 3 of 4 areas. We couldn't check Google this time.");
    assert.equal(coverageOf(scores([null, null, "C", null])).note, "Graded on 1 of 4 areas. We couldn't check Google or your social links this time.");
    assert.equal(coverageOf(scores([null, null, null, null])).note, "We couldn't check any of the four areas this time.");
  });

  test("Social left out because the home page did not load says why; with another area out it reads like any other", () => {
    assert.equal(coverageNote(3, [{ area: "social", why: "site-down" }]), "Graded on 3 of 4 areas. We couldn't check your social links because your website didn't load.");
    assert.equal(coverageNote(1, [{ area: "google", why: "quota" }, { area: "reviews", why: "quota" }, { area: "social", why: "site-down" }]),
      "Graded on 1 of 4 areas. We couldn't check Google or your social links this time.");
    assert.equal(coverageText({ graded: 1, of: 4, missing: [{ area: "google", why: "timeout" }, { area: "reviews", why: "timeout" }, { area: "social", why: "site-down" }] }),
      "Graded on 1 of 4 areas. Left out: Google and Reviews (Google timed out); Social (the website did not load, so its links could not be read).");
  });

  test("shape: graded, of, missing with reason codes; Chris's line groups areas by reason", () => {
    const c = coverageOf(scores([null, null, "B", "A"]), { google: "quota", reviews: "quota", website: "blocked", social: "blocked" });
    assert.deepEqual(c, { graded: 2, of: 4, missing: [{ area: "google", why: "quota" }, { area: "reviews", why: "quota" }], note: "Graded on 2 of 4 areas. We couldn't check Google this time." });
    assert.equal(coverageText(c), "Graded on 2 of 4 areas. Left out: Google and Reviews (the Google quota ran out).");
    assert.equal(coverageText(coverageOf(scores([null, null, null, null]), { google: "no-key", reviews: "no-key", website: "javascript", social: "javascript" })),
      "Nothing could be graded. Left out: Google and Reviews (no Google key is set); Website and Social (the page builds itself with JavaScript).");
    assert.equal(coverageText(coverageOf(scores(["A", "A", "A", "A"]))), "");
    assert.equal(coverageText(undefined), "", "an older result has no coverage");
  });

  test("pastor-facing notes stay plain: no em dashes, no hype words, no blame", () => {
    const all = [];
    for (let mask = 0; mask < 16; mask++) all.push(coverageNote(AREAS.filter((_, i) => !(mask & (1 << i))).length, AREAS.filter((_, i) => mask & (1 << i))));
    all.push(coverageNote(3, [{ area: "social", why: "site-down" }]));
    const text = all.filter(Boolean).join(" ");
    assert.equal(/—|\b(really|just|simply|actually|truly|your fault|failed)\b/i.test(text), false, text);
  });
});

// ---------- audit.js: send or hold, for each case ----------
describe("runAudit: what is graded, what is held", () => {
  test("Google quota error: Google and Reviews left out, 2 of 4, sent", async () => {
    world({ places: "quota" });
    const r = await runAudit(cedarBend, KEY);
    assert.equal(r.needsReview, false, r.reviewReason);
    assert.deepEqual(r.coverage, { graded: 2, of: 4, missing: [{ area: "google", why: "quota" }, { area: "reviews", why: "quota" }], note: "Graded on 2 of 4 areas. We couldn't check Google this time." });
    assert.ok(r.scores.overall.grade);
    assert.ok(r.errors.some((e) => /Places search failed \(429\)/.test(e)));
    assert.equal(/Google Maps|Business Profile/.test(pastorText(r)), false, "our failure never reads as a missing listing");
  });

  test("Google timeout and a rejected key are our side too", async () => {
    for (const [places, why] of [["timeout", "timeout"], ["key", "key-rejected"]]) {
      world({ places });
      const r = await runAudit(cedarBend, KEY);
      assert.equal(r.needsReview, false, r.reviewReason);
      assert.deepEqual(r.coverage.missing.map((m) => m.why), [why, why], places);
    }
  });

  test("no Google key: left out, sent, and Chris is told to set it", async () => {
    world();
    const r = await runAudit(cedarBend, {});
    assert.equal(r.needsReview, false);
    assert.deepEqual(r.coverage.missing, [{ area: "google", why: "no-key" }, { area: "reviews", why: "no-key" }]);
    assert.ok(r.infoLines.some((x) => /No Google key is set/.test(x)));
  });

  test("no Google listing: F with the fix, 4 of 4, sent", async () => {
    world({ places: "empty" });
    const r = await runAudit(cedarBend, KEY);
    assert.equal(r.needsReview, false);
    assert.deepEqual([r.scores.areas.google.grade, r.scores.areas.reviews.grade, r.coverage.graded], ["F", "F", 4]);
    assert.ok(r.notes.fixes.some((f) => f.title === "Claim your free Google Business Profile"));
  });

  test("only a closed listing: left out with a note for Chris, sent", async () => {
    world({ places: "closed" });
    const r = await runAudit(cedarBend, KEY);
    assert.equal(r.needsReview, false);
    assert.deepEqual(r.coverage.missing.map((m) => m.why), ["listing-closed", "listing-closed"]);
    assert.ok(r.infoLines.some((x) => /permanently closed/.test(x)));
  });

  test("site timeout: Website F, Social left out, 3 of 4, sent, and Chris hears why", async () => {
    world({ site: "timeout" });
    const r = await runAudit(cedarBend, KEY);
    assert.equal(r.needsReview, false, r.reviewReason);
    assert.deepEqual([r.website.down, r.website.failure], [true, "timeout"]);
    assert.deepEqual(AREAS.map((k) => r.scores.areas[k].grade).slice(2), ["F", null]);
    assert.deepEqual(r.coverage, { graded: 3, of: 4, missing: [{ area: "social", why: "site-down" }],
      note: "Graded on 3 of 4 areas. We couldn't check your social links because your website didn't load." });
    assert.equal(coverageText(r.coverage), "Graded on 3 of 4 areas. Left out: Social (the website did not load, so its links could not be read).");
    assert.match(pastorText(r), /Your website didn't load when we opened it on a phone\./);
    assert.equal(/couldn't reach|sit on your website/.test(pastorText(r)), false);
    assert.ok(r.infoLines.some((x) => x === "The website did not load on a phone (the site took too long to answer), so Website was graded F and Social was left out."), r.infoLines.join(" | "));
    assert.equal(r.speed, null, "the second-opinion speed test is never shown as the site's speed");
  });

  test("site 5xx and a broken certificate: F", async () => {
    for (const [site, failure] of [["502", "server-error"], ["526", "certificate"]]) {
      world({ site });
      const r = await runAudit(cedarBend, KEY);
      assert.deepEqual([r.needsReview, r.website.failure, r.scores.areas.website.grade], [false, failure, "F"], site);
    }
  });

  test("a site that looks down to us but loads for Google's speed test is left out, not F", async () => {
    world({ site: "timeout", psi: "loads" });
    const r = await runAudit(cedarBend, KEY);
    assert.deepEqual([r.website.down, r.website.failure], [false, "loads-elsewhere"]);
    assert.equal(r.scores.areas.website.grade, null);
    assert.equal(r.coverage.note, "Graded on 2 of 4 areas. We couldn't check your website this time.");
    assert.ok(r.infoLines.some((x) => /Google's speed test did/.test(x)));
    assert.equal(/didn't load/.test(pastorText(r)), false);
  });

  test("site 403, bot wall, reset or JavaScript shell: left out, 2 of 4, sent", async () => {
    for (const [site, why] of [["403", "blocked"], ["challenge", "blocked"], ["reset", "connection"], ["js", "javascript"]]) {
      world({ site });
      const r = await runAudit(cedarBend, KEY);
      assert.equal(r.needsReview, false, `${site}: ${r.reviewReason}`);
      assert.deepEqual(r.coverage.missing, [{ area: "website", why }, { area: "social", why }], site);
      assert.equal(r.coverage.note, "Graded on 2 of 4 areas. We couldn't check your website this time.");
      assert.equal(/didn't load|is down|back online/.test(pastorText(r)), false, site);
    }
  });

  test("near-me failure: Google graded from the listing alone, sent, note for Chris", async () => {
    world({ nearMe: "429" });
    const r = await runAudit(cedarBend, KEY);
    assert.equal(r.needsReview, false);
    assert.equal(r.coverage.graded, 4);
    assert.ok(r.infoLines.some((x) => /near-me/.test(x)));
  });

  test("zero areas: held, with what was left out and why", async () => {
    world({ places: "quota", site: "403" });
    const r = await runAudit(cedarBend, KEY);
    assert.equal(r.needsReview, true);
    assert.deepEqual(r.reviewReasons, ["Nothing could be graded. Left out: Google and Reviews (the Google quota ran out); Website and Social (the site turned our check away)."]);
    assert.equal(r.scores.overall.grade, null);
  });

  test("still held: a listing that may be another church, or one far from the typed address", async () => {
    world({ places: [place("gb", "Grace Bible Church", { websiteUri: "https://gbcgt.example/" })] });
    let r = await runAudit(cedarBend, KEY);
    assert.equal(r.needsReview, true);
    assert.match(r.reviewReasons[0], /may be a different church/);
    world({ places: [place("cb", NAME, { location: { latitude: HERE.latitude + 0.2, longitude: HERE.longitude } })] });
    r = await runAudit(cedarBend, KEY);
    assert.equal(r.needsReview, true);
    assert.ok(r.reviewReasons.some((x) => /miles from the address/.test(x)));
  });

  test("a second listing for the same website holds only when the typed address could not place the church", async () => {
    const twin = [place("cb", NAME), place("cb2", `${NAME} North`, { formattedAddress: "9 Oak Ave, Leander, TX 78641, USA", userRatingCount: 12 })];
    world({ places: twin });
    let r = await runAudit({ ...cedarBend, address: "Cedar Park, TX" }, KEY);
    assert.equal(r.needsReview, true);
    assert.match(r.reviewReasons.join(" "), /another listing with this church's website \(Cedar Bend Church North, 9 Oak Ave/);
    world({ places: twin });
    r = await runAudit(cedarBend, KEY);
    assert.equal(r.needsReview, false, "a street address on the map shows which listing is this church's");
  });

  test("the typed site is down and the Google listing's site is blocked: left out, not F (the church may have moved)", async () => {
    world({ site: "dns", places: [place("cb", NAME, { websiteUri: "https://cedarbend.church/" })], extra: [[/cedarbend\.church/, () => html("Forbidden", 403)]] });
    const r = await runAudit(cedarBend, KEY);
    assert.equal(r.website.source, "google");
    assert.deepEqual([r.website.down, r.scores.areas.website.grade], [false, null]);
    assert.ok(r.infoLines.some((x) => /typed website did not load, and the website on the Google listing \(cedarbend\.church\) could not be checked either/.test(x)), r.infoLines.join(" | "));
  });
});

// ---------- The Workflow: which audits email the pastor, which wait for Chris ----------
describe("delivery: send or hold", () => {
  const ORIGIN = "https://bigsplash.video";
  const BASE = "https://bigsplash-front-door.test.workers.dev";
  const SLACK = "https://hooks.slack.test/T000/B000/xyz";
  const ctx = { waitUntil() {}, passThroughOnException() {} };
  const form = (x = {}) => ({ church: NAME, address: cedarBend.address, website: SITE, name: "Pat Rivera", role: "Lead pastor", email: "pat@cedarbend.example",
    phone: "", facebook_frequency: "About once a week", hp_x7: "", page_url: "https://bigsplash.video/frontdoor/", utm: "", ...x });

  async function run({ worldOpts = {}, env: extra = {}, body = form(), dropContact = false } = {}) {
    const ghl = fakeGhl(), slack = [];
    world({ ...worldOpts, extra: [[SLACK, (c) => { slack.push(c.json().text); return new Response("ok"); }], ghl.route, ...(worldOpts.extra || [])] });
    const e = fakeEnv({ WORKER_ORIGIN: BASE, SLACK_WEBHOOK_URL: SLACK, ...GHL_ENV, ...KEY, ...extra });
    const res = await worker.fetch(new Request(`${BASE}/audit`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": "203.0.113.9" }, body: JSON.stringify(body) }), e, ctx);
    const { id } = await res.json();
    const flow = e.flows.at(-1);
    if (dropContact) { e.AUDITS.m.delete(`contact:${id}`); delete flow.params.contact; }
    await new FrontDoorAudit({}, e).run({ payload: flow.params, instanceId: flow.id, timestamp: new Date() }, fakeStep());
    const rec = e.AUDITS.record(id);
    return { rec, ghl, slack: slack.join("\n"), id, e };
  }

  const table = [
    ["every check ran", {}, "ready"],
    ["Google quota error", { worldOpts: { places: "quota" } }, "ready"],
    ["Google lookup failed (500)", { worldOpts: { places: "error" } }, "ready"],
    ["no Google key", { env: { GOOGLE_API_KEY: "" } }, "ready"],
    ["no Google listing", { worldOpts: { places: "empty" } }, "ready"],
    ["near-me search failed", { worldOpts: { nearMe: "429" } }, "ready"],
    ["website timed out", { worldOpts: { site: "timeout" } }, "ready"],
    ["website 5xx", { worldOpts: { site: "502" } }, "ready"],
    ["website turned our check away (403)", { worldOpts: { site: "403" } }, "ready"],
    ["website behind a bot wall", { worldOpts: { site: "challenge" } }, "ready"],
    ["listing may be another church", { worldOpts: { places: [place("gb", "Grace Bible Church", { websiteUri: "https://gbcgt.example/" })] } }, "review"],
    ["listing far from the typed address", { worldOpts: { places: [place("cb", NAME, { location: { latitude: HERE.latitude + 0.2, longitude: HERE.longitude } })] } }, "review"],
    ["nothing could be graded", { worldOpts: { places: "quota", site: "403" } }, "review"],
    ["no email to send to", { dropContact: true }, "review"],
  ];
  for (const [name, opts, status] of table) {
    test(`${name}: ${status === "ready" ? "sent automatically" : "held for Chris"}`, async () => {
      const { rec, ghl, slack } = await run(opts);
      assert.equal(rec.status, status, JSON.stringify(rec.result?.reviewReasons));
      if (status === "ready") {
        assert.equal(ghl.emails.length, 1, "email 1 went to the pastor");
        assert.ok(rec.result.scores.overall.grade, "every sent scorecard has an overall grade");
        assert.match(slack, /\*Front Door Audit ready:\*/);
      } else {
        assert.equal(ghl.sent().length, 0, "nothing reaches the pastor before Chris approves");
        assert.match(slack, /needs your review/);
      }
    });
  }

  test("a partial audit: the email, the Slack line and the GoHighLevel note carry the coverage", async () => {
    const { rec, ghl, slack } = await run({ worldOpts: { places: "quota" } });
    assert.equal(rec.status, "ready");
    const email = ghl.emails[0];
    assert.match(email.message, /Overall grade: [A-F]\nGraded on 2 of 4 areas\. We couldn't check Google this time\./);
    assert.match(email.html, /Overall grade: [A-F]<br>\nGraded on 2 of 4 areas\. We couldn&#39;t check Google this time\./);
    assert.equal(/searched for you from about 4 miles out/.test(email.message), false, "a partial audit never claims the near-me search");
    assert.match(slack, /Graded on 2 of 4 areas\. Left out: Google and Reviews \(the Google quota ran out\)\./);
    assert.match(ghl.notes[0].body, /Graded on 2 of 4 areas\. Left out: Google and Reviews/);
  });

  test("a site graded F: Chris's Slack line says why, and the pastor's email says Social was left out", async () => {
    const { rec, ghl, slack } = await run({ worldOpts: { site: "timeout" } });
    assert.equal(rec.result.coverage.graded, 3);
    assert.match(slack, /FYI: The website did not load on a phone \(the site took too long to answer\), so Website was graded F and Social was left out\./);
    assert.match(slack, /Left out: Social \(the website did not load, so its links could not be read\)\./);
    assert.match(ghl.emails[0].message, /Overall grade: [A-F]\nGraded on 3 of 4 areas\. We couldn't check your social links because your website didn't load\./);
    assert.match(ghl.emails[0].message, /searched for you from about 4 miles out and opened your website on a phone/);
  });

  test("the first email names only the checks that ran: no 4-mile claim without the near-me search", async () => {
    for (const worldOpts of [{ places: "empty" }, { nearMe: "429" }, { places: "quota" }, { places: [place("pz", "Hill Country Pizza", { types: ["restaurant"], primaryType: "pizza_restaurant", websiteUri: "https://hcpizza.example/" })] }]) {
      const { rec, ghl } = await run({ worldOpts });
      assert.equal(rec.status, "ready", JSON.stringify(worldOpts));
      const email = ghl.emails[0].message;
      assert.equal(/4 miles out/.test(email), false, `${JSON.stringify(worldOpts)}: ${email}`);
      assert.match(email, /The audit looked your church up and opened your website on a phone, the way a family new to town would before their first Sunday\./);
    }
  });

  test("the public result keeps coverage and drops Chris's notes", async () => {
    const { id, e } = await run({ worldOpts: { places: "quota", nearMe: "429" } });
    const body = await (await worker.fetch(new Request(`${BASE}/result?id=${id}`), e, ctx)).json();
    assert.equal(body.coverage.note, "Graded on 2 of 4 areas. We couldn't check Google this time.");
    assert.equal("infoLines" in body, false);
    assert.equal("reviewReasons" in body, false);
  });
});

// ---------- Messages and the desk payload ----------
describe("messages and the desk", () => {
  const v = { firstName: "Pat", church: NAME, grade: "C", topFix: "Get your website loading on phones again", scorecardUrl: "https://bigsplash.video/front-door/?id=x", walkthroughUrl: "https://bigsplash.video/frontdoor/walkthrough/?id=x" };
  test("email 1 and the approved email put the note right under the grade", () => {
    for (const build of [scorecardEmail, approvedEmail]) {
      const m = build({ ...v, coverage: "Graded on 3 of 4 areas. We couldn't check Google this time." });
      assert.match(m.text, /Overall grade: C\nGraded on 3 of 4 areas\. We couldn't check Google this time\.\nFirst fix on your list/);
      assert.equal(/—/.test(m.text), false);
    }
  });

  test("email 1 names only the checks that ran", () => {
    const line = (x) => scorecardEmail({ ...v, ...x }).text.match(/The audit [^\n]*Sunday\./)[0];
    assert.equal(line({ searched: true, opened: true }), "The audit searched for you from about 4 miles out and opened your website on a phone, the way a family new to town would before their first Sunday.");
    assert.equal(line({ searched: true, opened: false }), "The audit searched for you from about 4 miles out, the way a family new to town would before their first Sunday.");
    assert.equal(line({ searched: false, opened: true }), "The audit looked your church up and opened your website on a phone, the way a family new to town would before their first Sunday.");
    assert.equal(line({ searched: false, opened: false }), "The audit looked your church up the way a family new to town would before their first Sunday.");
    assert.equal(line({ coverage: "Graded on 2 of 4 areas. We couldn't check Google this time." }), "The audit looked your church up the way a family new to town would before their first Sunday.", "no flags: follows coverage, as before");
  });

  test("messageVars: flags from the result; an older result without coverage keeps its email", () => {
    const base = { id: "x", church: { name: NAME }, contact: { name: "Pat Rivera" } };
    const at = (result) => { const m = messageVars({}, { ...base, result }); return [m.searched, m.opened]; };
    const cov = { graded: 4, of: 4, missing: [], note: null };
    assert.deepEqual(at({ coverage: cov, nearMe: null, website: { checked: true } }), [false, true]);
    assert.deepEqual(at({ coverage: cov, nearMe: { searches: [{ checked: false }, { checked: true }] }, website: { checked: false, down: true } }), [true, true]);
    assert.deepEqual(at({ coverage: cov, nearMe: { searches: [{ checked: false }] }, website: { checked: false, down: false } }), [false, false]);
    assert.deepEqual(at({ nearMe: null, website: null }), [undefined, undefined]);
  });

  test("all four areas: no note, and the first email reads as before", () => {
    const m = scorecardEmail(v);
    assert.match(m.text, /Overall grade: C\nFirst fix on your list/);
    assert.match(m.text, /searched for you from about 4 miles out/);
    assert.equal(/Graded on/.test(m.text), false);
  });

  test("messageVars, leadPayload and the GoHighLevel note read coverage, and older results without it", () => {
    const result = { scores: { overall: { grade: "B" }, areas: {} }, coverage: { graded: 2, of: 4, missing: [{ area: "website", why: "blocked" }, { area: "social", why: "blocked" }], note: "Graded on 2 of 4 areas. We couldn't check your website this time." },
      infoLines: ["The near-me Google search failed, so Google was graded from the listing alone."], notes: { fixes: [] } };
    const a = { event: "ready", id: "cedar-bend-church-1a2b3c4d", church: { name: NAME }, contact: { name: "Pat Rivera", email: "pat@cedarbend.example" }, result, record: {} };
    assert.equal(messageVars({}, a).coverage, result.coverage.note);
    const l = leadPayload(a);
    assert.equal(l.coverage, "Graded on 2 of 4 areas. Left out: Website and Social (the site turned our check away).");
    assert.deepEqual(l.info, result.infoLines);
    assert.match(noteText(a), /Graded on 2 of 4 areas\. Left out: Website and Social[\s\S]*Note: The near-me Google search failed/);
    const old = { ...a, result: { scores: { overall: { grade: "B" }, areas: {} }, notes: {} } };
    assert.deepEqual([messageVars({}, old).coverage, leadPayload(old).coverage, leadPayload(old).info], ["", "", []]);
  });
});

// ---------- The pages ----------
const ROOT = new URL("../../", import.meta.url);
const scorecard = readFileSync(new URL("front-door/index.html", ROOT), "utf8");
const walkthrough = readFileSync(new URL("frontdoor/walkthrough/index.html", ROOT), "utf8");
const inlineScripts = (p) => [...p.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n;\n");
const ID = "cedar-bend-church-1a2b3c4d";
const unescape = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

function classes() {
  const set = new Set();
  return { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle() {} };
}

async function renderScorecard(data) {
  const els = {};
  const el = (id) => (els[id] ||= { innerHTML: "", textContent: "", style: {} });
  const classList = classes();
  const context = {
    window: { FRONT_DOOR_DATA: data },
    document: { getElementById: el, title: "", documentElement: { classList } },
    location: { search: `?id=${ID}`, href: `https://bigsplash.video/front-door/?id=${ID}` },
    fetch: async () => new Response("{}", { status: 404 }),
    URLSearchParams, URL, Response, Date, Intl, Number, String, JSON, Math, Object, Array, Promise, Set, console, setTimeout, clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(inlineScripts(scorecard), context);
  await new Promise((r) => setTimeout(r, 20));
  return { html: unescape(el("app").innerHTML), style: el("brand-style").textContent };
}

async function renderWalkthrough(data) {
  const els = {};
  const node = (id) => ({ id, innerHTML: "", textContent: "", hidden: id === "grade" || id === "partial", href: "", style: {}, children: [], classList: classes(),
    appendChild(c) { this.children.push(c); }, setAttribute() {}, addEventListener() {}, closest() { return node("vsl"); } });
  const el = (id) => (els[id] ||= node(id));
  const context = {
    window: { addEventListener() {}, FRONT_DOOR_DATA: data },
    document: { getElementById: el, querySelector: () => node("footer"), createElement: (t) => node(t), body: node("body"), title: "", documentElement: { classList: classes() } },
    location: { search: `?id=${ID}`, href: `https://bigsplash.video/frontdoor/walkthrough/?id=${ID}` },
    fetch: async () => new Response("{}", { status: 404 }),
    URLSearchParams, URL, Response, AbortController, Date, Number, String, JSON, Math, Object, Array, Promise, Map, Set, console, setTimeout, clearTimeout,
  };
  context.window.document = context.document;
  vm.createContext(context);
  vm.runInContext(inlineScripts(walkthrough), context);
  await new Promise((r) => setTimeout(r, 20));
  return { headline: el("headline").innerHTML, partial: el("partial"), grade: el("grade-letter").textContent, style: el("brand-style").textContent };
}

// A scorecard result built the way audit.js builds one, from fabricated checks.
function result({ google = listing(), website: w = website(), coverageWhy = {}, old = false, brand = null } = {}) {
  const a = { church: { name: NAME, address: cedarBend.address }, google, nearMe: google?.found ? nearMe : null, website: w, speed: w?.checked ? { ok: true, score: 88 } : null, reach: null, checks: {} };
  const scores = scoreAudit(a);
  const coverage = coverageOf(scores, coverageWhy);
  const out = { id: ID, ...a, scores, coverage, notes: fallbackNotes({ ...a, scores }), checkedAt: "2026-10-20T15:00:00.000Z", brand };
  if (old) delete out.coverage;
  return out;
}

describe("scorecard and walkthrough pages", () => {
  test("a partial grade shows the note under the lede, and the left-out areas say Not checked", async () => {
    const d = result({ google: null });
    const { html } = await renderScorecard(d);
    assert.match(html, /<div class="grade"><b>A<\/b>/);
    assert.match(html, /<p class="lede">[^<]*<\/p>\s*<p class="partial">Graded on 2 of 4 areas\. We couldn't check Google this time\.<\/p>/);
    assert.equal((html.match(/<span class="badge none">Not checked<\/span>/g) || []).length, 2);
    const w = await renderWalkthrough(d);
    assert.equal(w.headline, `<span class="church-name">${NAME}'s</span> Front Door Audit: overall A`);
    assert.deepEqual([w.partial.hidden, w.partial.textContent], [false, "Graded on 2 of 4 areas. We couldn't check Google this time."]);
  });

  test("all four areas: no note on either page", async () => {
    const d = result();
    assert.equal(/class="partial"/.test((await renderScorecard(d)).html), false);
    assert.equal((await renderWalkthrough(d)).partial.hidden, true);
  });

  test("a website that did not load: F with plain rows, never 'Not found' for links we could not see", async () => {
    const { html } = await renderScorecard(result({ website: downSite("timeout"), coverageWhy: { social: "site-down" } }));
    const web = html.match(/<h3>Website on a phone<\/h3>[\s\S]*?<\/section>/)[0];
    assert.match(web, /<span class="badge F">F<\/span>/);
    assert.match(web, /Your website didn't load when we opened it on a phone\. The site didn't answer in time\./);
    assert.match(web, /Home page on a phone<\/span><b class="no">Didn't load<\/b>/);
    assert.match(web, /Address we opened<\/span><b class="">cedarbendchurch\.org<\/b>/);
    assert.equal(/Plan-your-visit link|Google phone test/.test(web), false);
    const social = html.match(/<h3>Social and sermons<\/h3>[\s\S]*?<\/section>/)[0];
    assert.match(social, /<span class="badge none">Not checked<\/span>/);
    assert.equal(/Site didn't load|sit on your website/.test(social), false, "no Social grade or row from a page we never read");
    assert.match(html, /<p class="partial">Graded on 3 of 4 areas\. We couldn't check your social links because your website didn't load\.<\/p>/);
  });

  test("no Google listing: F with the Maps row and the claim fix", async () => {
    const { html } = await renderScorecard(result({ google: { found: false, listed: false } }));
    const g = html.match(/<h3>Google search<\/h3>[\s\S]*?<\/section>/)[0];
    assert.match(g, /<span class="badge F">F<\/span>/);
    assert.match(g, /Google Maps listing<\/span><b class="no">Not found<\/b>/);
    assert.match(html, /<h3>Reviews<\/h3>[\s\S]*?Google reviews<\/span><b class="no">No listing yet<\/b>/);
    assert.match(html, /<ol class="fixes"><li><b>Claim your free Google Business Profile<\/b>/);
  });

  test("older results without coverage still render: the note from area grades, and a dash with no note when there is no overall", async () => {
    const old4 = result({ old: true });
    assert.equal(/class="partial"/.test((await renderScorecard(old4)).html), false);
    const old3 = result({ old: true });
    old3.scores.areas.reviews = { points: null, grade: null, checked: false };
    let { html } = await renderScorecard(old3);
    assert.match(html, /<p class="partial">Graded on 3 of 4 areas\. We couldn't check Google this time\.<\/p>/);
    assert.equal((await renderWalkthrough(old3)).partial.textContent, "Graded on 3 of 4 areas. We couldn't check Google this time.");
    const heldOld = result({ old: true, google: null });
    heldOld.scores.overall = { points: null, grade: null };
    ({ html } = await renderScorecard(heldOld));
    assert.match(html, /<div class="grade"><b>–<\/b>/);
    assert.equal(/class="partial"/.test(html), false);
    const w = await renderWalkthrough(heldOld);
    assert.deepEqual([w.headline.endsWith("Front Door Audit"), w.partial.hidden], [true, true]);
  });

  test("both pages build the note the way score.js does", async () => {
    for (let mask = 1; mask < 15; mask++) {
      const d = result({ old: true });
      AREAS.forEach((k, i) => { if (mask & (1 << i)) d.scores.areas[k] = { points: null, grade: null, checked: false }; });
      const want = coverageNote(AREAS.filter((_, i) => !(mask & (1 << i))).length, AREAS.filter((_, i) => mask & (1 << i)));
      assert.match((await renderScorecard(d)).html, new RegExp(`<p class="partial">${want.replace(/[.?]/g, "\\$&")}</p>`), String(mask));
      assert.equal((await renderWalkthrough(d)).partial.textContent, want, String(mask));
    }
  });

  test("the walkthrough promises each grade on the scorecard, never four of them", () => {
    assert.match(walkthrough, /goes through each grade with you\. Ask us anything along the way\./);
    assert.equal(/each of the four grades/.test(walkthrough), false);
  });

  test("hold and failure messages come from the team, never Chris by name", async () => {
    const msgs = scorecard.match(/const MESSAGES = \{[\s\S]*?\};/)[0];
    assert.match(msgs, /review: "Our team is double-checking a few details/);
    assert.match(msgs, /failed: "Something went wrong on our end\. Our team has the details/);
    assert.equal(/Chris (is|has)/.test(msgs), false);
  });

  test("the eyebrow on the wash takes onWash (4.5:1 there); a result from before onWash takes ink", async () => {
    const colors = themeColors({ primary: "#2f7fd0" });
    const brand = { ...colors, font: null, logo: null, source: "css-variable" };
    for (const render of [renderScorecard, renderWalkthrough]) {
      assert.match((await render(result({ brand }))).style, new RegExp(`--brand-ink: ${colors.onWash}; \\}$`));
      assert.match((await render(result({ brand: { ...brand, onWash: undefined } }))).style, /--brand-ink: #131318; \}$/);
      assert.match((await render(result({ brand: { ...brand, onWash: "red;}" } }))).style, /--brand-ink: #131318; \}$/, "a bad value never reaches the CSS");
    }
    for (const page of [scorecard, walkthrough]) assert.match(page, /html\.cobrand \.eyebrow \{ color: var\(--brand-ink\); \}/);
  });
});

// ---------- The two fixes from the logo review ----------
describe("eyebrow contrast on the header wash", () => {
  test("onWash reaches 4.5:1 on the wash, the page and white, for light, mid and dark church colors", () => {
    for (const hex of ["#2f7fd0", "#f5c400", "#98f18c", "#d20021", "#17545b", "#6a1b9a", "#00a3a3", "#ff6f00", "#0b1f3a", "#c99700"]) {
      const t = themeColors({ primary: hex });
      const wash = washOf(t.primary);
      for (const bg of [wash, ...PAGE_BACKGROUNDS]) assert.ok(contrast(t.onWash, bg) >= 4.5, `${hex}: ${t.onWash} on ${bg} is ${contrast(t.onWash, bg).toFixed(2)}`);
    }
  });

  test("a color that just clears 4.5:1 on white falls short on the wash, so onWash darkens it", () => {
    const t = themeColors({ primary: "#2f7fd0" });
    assert.ok(contrast(t.primary, washOf(t.primary)) < 4.5, "the bug: the raw primary on the wash");
    assert.notEqual(t.onWash, t.primary);
  });

  test("washOf matches the pages' tint() to the digit", () => {
    const tint = new Function(`${scorecard.match(/function tint\(hex, keep = 0\.12\) \{[\s\S]*?\n\}/)[0]}; return tint;`)();
    const tintW = new Function(`${walkthrough.match(/function tint\(hex, keep\) \{[\s\S]*?\n\}/)[0]}; return tint;`)();
    for (const hex of ["#2f7fd0", "#17545b", "#d20021", "#000000", "#ffffff"]) {
      assert.equal(washOf(hex), tint(hex, 0.1), hex);
      assert.equal(washOf(hex), tintW(hex, 0.1), hex);
    }
  });
});

describe("raster logos have a pixel budget", () => {
  const be32 = (n) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  const png = (w, h) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h), 8, 6, 0, 0, 0, 0, 0, 0, 0, ...new Array(200).fill(7)]);
  const img = (b) => new Response(b, { headers: { "content-type": "image/png" } });
  const kv = () => { const m = new Map(); return { m, async put(k, v, opts) { m.set(k, { v, opts }); } }; };

  test("Church of Whitestone's 14931x4167 PNG is skipped and the next candidate is used", async () => {
    stubFetch([[/huge\.png/, () => img(png(14931, 4167))], [/icon\.png/, () => img(png(180, 180))]]);
    assert.match((await fetchLogo("https://whitestone.example/huge.png")).reason, /14931x4167 is too many pixels for a phone/);
    const env = { AUDITS: kv() };
    const r = await saveLogo(env, "whitestone-1a2b3c4d", ["https://whitestone.example/huge.png", "https://whitestone.example/icon.png"]);
    assert.deepEqual(r.logo, { stored: true, type: "image/png", width: 180, height: 180 });
    assert.match(r.misses[0], /too many pixels/);
  });

  test("the budget is 4 megapixels: a 2000x2000 mark and a 4000x1000 wordmark pass, one pixel more does not", () => {
    assert.equal(RASTER_MAX_PIXELS, 4_000_000);
    assert.equal(logoSizeOk(2000, 2000), true);
    assert.equal(logoSizeOk(4000, 1000), true);
    assert.equal(logoSizeOk(4001, 1000), false);
    assert.equal(logoSizeOk(14931, 4167), false);
  });
});
