// Spec item 2: google.js. Places answers come from fixtures.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { stubFetch, json, timeouts } from "./spec-helpers.mjs";
import { findListing, nearMeRank } from "../src/google.js";

const PLACES = /^https:\/\/places\.googleapis\.com\/v1\/places/;
const GT = { latitude: 30.6327, longitude: -97.6772 }; // Georgetown, TX

function place(id, name, extra = {}) {
  return {
    id, displayName: { text: name, languageCode: "en" }, formattedAddress: `${id.length * 100} Main St, Georgetown, TX 78626, USA`, location: GT,
    rating: 4.8, userRatingCount: 40, businessStatus: "OPERATIONAL", types: ["church", "place_of_worship", "point_of_interest", "establishment"],
    regularOpeningHours: { periods: [{ open: { day: 0, hour: 10, minute: 0 }, close: { day: 0, hour: 11, minute: 30 } }], weekdayDescriptions: ["Sunday: 10:00 – 11:30 AM"] },
    ...extra,
  };
}

// Stub Places: the listing search answers with `places`; "church" searches go to nearMe(call).
function places(list, nearMe = () => json({ places: [] })) {
  return stubFetch([[PLACES, (c) => {
    const b = c.json();
    if (b.textQuery === "church") return nearMe(c, b);
    return json({ places: list });
  }]]);
}

const fieldMask = (c) => (c.headers.get("x-goog-fieldmask") || "") + " " + c.url;

describe("findListing", () => {
  test("asks for secondary hours and lists hours from either kind", async () => {
    const calls = places([place("cr", "City Reach Church", { regularOpeningHours: undefined, websiteUri: "https://cityreachchurch.com/",
      regularSecondaryOpeningHours: [{ secondaryHoursType: "SENIOR_HOURS", periods: [{ open: { day: 0, hour: 9 } }], weekdayDescriptions: ["Sunday: 9 AM"] }] })]);
    const g = await findListing("k", { name: "City Reach Church", address: "2700 W Whitestone Blvd, Cedar Park, TX 78613", website: "cityreachchurch.com" });
    assert.match(fieldMask(calls[0]), /regularSecondaryOpeningHours/);
    assert.equal(g.found, true);
    assert.equal(g.hoursListed, true);

    places([place("cr", "City Reach Church", { regularOpeningHours: undefined, websiteUri: "https://cityreachchurch.com/" })]);
    const none = await findListing("k", { name: "City Reach Church", address: "x", website: "cityreachchurch.com" });
    assert.equal(none.hoursListed, false);
  });

  test("a CLOSED_PERMANENTLY listing never wins, and alone means not found", async () => {
    places([
      place("old", "City Reach Church", { businessStatus: "CLOSED_PERMANENTLY", websiteUri: "https://cityreachchurch.com/", userRatingCount: 12 }),
      place("new", "City Reach Church", { websiteUri: "https://cityreachchurch.com/", userRatingCount: 264 }),
    ]);
    const g = await findListing("k", { name: "City Reach Church", address: "2700 W Whitestone Blvd, Cedar Park, TX 78613", website: "cityreachchurch.com" });
    assert.equal(g.reviewCount, 264);
    places([place("old", "City Reach Church", { businessStatus: "CLOSED_PERMANENTLY", websiteUri: "https://cityreachchurch.com/" })]);
    const only = await findListing("k", { name: "City Reach Church", address: "x", website: "cityreachchurch.com" });
    assert.equal(only.found, false);
  });

  test("Faith Lutheran: the preschool on the church's domain loses to the church listing, and shows up as a possible duplicate", async () => {
    places([
      place("pre", "Faith Lutheran Preschool", { websiteUri: "https://flcms.org/preschool", userRatingCount: 6, rating: 3.9, formattedAddress: "1405 Rock St, Georgetown, TX 78626, USA" }),
      place("church", "Faith Lutheran Church", { userRatingCount: 85, rating: 4.8, formattedAddress: "1407 Rock St, Georgetown, TX 78626, USA" }),
    ]);
    const g = await findListing("k", { name: "Faith Lutheran Church", address: "1407 Rock St, Georgetown, TX 78626", website: "flcms.org" });
    assert.equal(g.reviewCount, 85);
    assert.equal(g.confidence, "medium");
    const dup = (g.possibleDuplicates || []).find((d) => /Preschool/.test(d.name));
    assert.ok(dup, JSON.stringify(g.possibleDuplicates));
    assert.equal(dup.address, "1405 Rock St, Georgetown, TX 78626, USA");
    assert.equal(dup.reviewCount, 6);
  });

  for (const word of ["preschool", "school", "academy", "daycare", "thrift", "cafe", "coffee", "bookstore", "counseling"]) {
    test(`a "${word}" listing is down-ranked unless the typed name has the word`, async () => {
      const cap = word[0].toUpperCase() + word.slice(1);
      const list = [place("side", `Crossroads ${cap}`, { userRatingCount: 300 }), place("church", "Crossroads Church", { userRatingCount: 20 })];
      places(list);
      const g = await findListing("k", { name: "Crossroads Church", address: "15800 Crossroads Dr, Austin, TX 78717", website: "crossroadsaustin.com" });
      assert.equal(g.reviewCount, 20, `picked the ${word}`);
      places(list);
      const own = await findListing("k", { name: `Crossroads ${cap}`, address: "x", website: "crossroadsaustin.com" });
      assert.equal(own.reviewCount, 300);
    });
  }

  test("Grace Bible Church typed with cityreachchurch.com is a conflict with a reason", async () => {
    places([place("gb", "Grace Bible Church", { websiteUri: "https://gbcgt.org/", userRatingCount: 310 })]);
    const g = await findListing("k", { name: "Grace Bible Church", address: "Georgetown, TX", website: "cityreachchurch.com" });
    assert.equal(g.found, true);
    assert.equal(g.confidence, "conflict");
    assert.equal(typeof g.conflictReason, "string");
    assert.ok(g.conflictReason.length > 0);
  });

  test("high needs the same registrable domain and a name match (www, m. and paths ignored)", async () => {
    for (const uri of ["http://www.cityreachchurch.com/home", "https://cityreachchurch.com", "https://m.cityreachchurch.com/"]) {
      places([place("cr", "City Reach Church", { websiteUri: uri })]);
      const g = await findListing("k", { name: "City Reach Church", address: "2700 W Whitestone Blvd, Cedar Park, TX 78613", website: "https://www.cityreachchurch.com/" });
      assert.equal(g.confidence, "high", uri);
    }
  });

  test("medium: name matches and the listing has no website", async () => {
    places([place("cr", "City Reach Church")]);
    const g = await findListing("k", { name: "City Reach Church", address: "x", website: "cityreachchurch.com" });
    assert.equal(g.confidence, "medium");
  });

  test("weak words never make a name match", async () => {
    places([place("gc", "Grace Community Church")]);
    let g = await findListing("k", { name: "Grace Bible Church", address: "x", website: "gracebible.org" });
    assert.ok(!["high", "medium"].includes(g.confidence), g.confidence);

    places([place("ub", "First United Methodist Church")]);
    g = await findListing("k", { name: "First Baptist Church", address: "x", website: "fbc.org" });
    assert.ok(!["high", "medium"].includes(g.confidence), g.confidence);

    places([place("nh", "New Hope Church")]);
    g = await findListing("k", { name: "New Hope Church", address: "x", website: "newhope.org" });
    assert.equal(g.confidence, "medium", "exact normalized names match even with only weak words");
  });

  test("generic First Baptist Church in another town is not a match", async () => {
    places([place("fbcg", "First Baptist Church of Georgetown", { websiteUri: "https://fbcgeorgetown.org/", formattedAddress: "1333 W University Ave, Georgetown, TX 78628, USA" })]);
    let g = await findListing("k", { name: "First Baptist Church", address: "123 Main St, Jarrell, TX 76537", website: "fbcjarrell.org" });
    assert.ok(["conflict", "low"].includes(g.confidence), g.confidence);

    places([place("fbcg", "First Baptist Church of Georgetown", { formattedAddress: "1333 W University Ave, Georgetown, TX 78628, USA" })]);
    g = await findListing("k", { name: "First Baptist Church", address: "123 Main St, Jarrell, TX 76537", website: "fbcjarrell.org" });
    assert.equal(g.confidence, "low");
  });

  test("Facebook as the website: two Facebook pages are two churches", async () => {
    places([
      place("hf", "Hope Fellowship", { websiteUri: "https://www.facebook.com/hopefellowshiptx", userRatingCount: 50 }),
      place("nh", "New Hope Church", { websiteUri: "https://facebook.com/newhopegtx/", userRatingCount: 9 }),
    ]);
    let g = await findListing("k", { name: "New Hope Church", address: "x", website: "facebook.com/newhopegtx" });
    assert.equal(g.reviewCount, 9);
    assert.equal(g.confidence, "high");

    places([place("hf", "Hope Fellowship", { websiteUri: "https://www.facebook.com/hopefellowshiptx", userRatingCount: 50 })]);
    g = await findListing("k", { name: "New Hope Church", address: "x", website: "https://m.facebook.com/newhopegtx" });
    assert.notEqual(g.confidence, "high");
    assert.notEqual(g.confidence, "medium");
  });

  test("other shared hosts compare the first path segment", async () => {
    for (const [mine, theirs] of [["https://linktr.ee/gracegtx", "https://linktr.ee/gracecedarpark"], ["https://sites.google.com/view/gracegtx", "https://sites.google.com/view/gracecp"],
      ["https://gracegtx.churchcenter.com/home", "https://gracecp.churchcenter.com/home"], ["https://subsplash.com/gracegtx/app", "https://subsplash.com/gracecp/app"]]) {
      places([place("g", "Grace Church", { websiteUri: theirs })]);
      const g = await findListing("k", { name: "Grace Church", address: "x", website: mine });
      assert.notEqual(g.confidence, "high", `${mine} vs ${theirs}`);
    }
  });

  test("a redirect target passed in sites counts as the typed site", async () => {
    places([place("lp", "Lakepointe Church", { websiteUri: "https://lakepointe.church/" })]);
    const g = await findListing("k", { name: "Lakepointe Church", address: "701 E I-30, Rockwall, TX 75087", website: "lakepointe.org" }, ["lakepointe.org", "https://lakepointe.church/"]);
    assert.equal(g.confidence, "high");
  });

  test("City Reach: an old listing at Hatch Rd is a possible duplicate, top 5 at most", async () => {
    const list = [
      place("cr", "City Reach Church", { websiteUri: "https://cityreachchurch.com/", userRatingCount: 264, formattedAddress: "2700 W Whitestone Blvd, Cedar Park, TX 78613, USA" }),
      place("old", "City Reach Church", { websiteUri: "https://cityreachchurch.com/", userRatingCount: 12, formattedAddress: "3501 Hatch Rd, Cedar Park, TX 78613, USA" }),
      ...Array.from({ length: 6 }, (_, i) => place(`kids${i}`, `City Reach Kids ${i}`, { websiteUri: "https://cityreachchurch.com/kids", formattedAddress: `${i} Other Rd, Cedar Park, TX 78613, USA` })),
    ];
    places(list);
    const g = await findListing("k", { name: "City Reach Church", address: "2700 W Whitestone Blvd, Cedar Park, TX 78613", website: "cityreachchurch.com" });
    assert.equal(g.reviewCount, 264);
    assert.ok(Array.isArray(g.possibleDuplicates));
    assert.ok(g.possibleDuplicates.length <= 5);
    const old = g.possibleDuplicates.find((d) => /3501 Hatch Rd/.test(d.address));
    assert.deepEqual(old && [old.name, old.reviewCount], ["City Reach Church", 12]);
    assert.equal(g.possibleDuplicates.some((d) => /2700 W Whitestone/.test(d.address)), false, "the chosen listing is not its own duplicate");
  });

  test("no results means not found; every Places call has a 10 s timeout", async () => {
    timeouts.length = 0;
    const calls = places([]);
    const g = await findListing("k", { name: "Nowhere Church", address: "x", website: "nowhere.org" });
    assert.equal(g.found, false);
    assert.ok(calls.every((c) => c.signal instanceof AbortSignal));
    assert.ok(timeouts.includes(10000), `timeouts seen: ${timeouts}`);
  });
});

describe("nearMeRank", () => {
  const CHURCH = { latitude: 30.528, longitude: -97.86 };
  // Several common spellings, so the test does not depend on the listing object's exact shape.
  const listing = { found: true, id: "cr", placeId: "cr", name: "City Reach Church", lat: CHURCH.latitude, lon: CHURCH.longitude, lng: CHURCH.longitude,
    latitude: CHURCH.latitude, longitude: CHURCH.longitude, location: CHURCH, address: "2700 W Whitestone Blvd, Cedar Park, TX 78613, USA" };
  const others = (n, tag) => Array.from({ length: n }, (_, i) => ({ id: `${tag}${i}`, displayName: { text: `${tag} Church ${i}` }, location: CHURCH }));
  const me = { id: "cr", displayName: { text: "City Reach Church" }, location: CHURCH };
  const isNorth = (b) => b.locationBias.circle.center.latitude > CHURCH.latitude;
  const miles = (a, b) => {
    const r = (d) => (d * Math.PI) / 180, R = 3958.8;
    const dLat = r(b.latitude - a.latitude), dLon = r(b.longitude - a.longitude);
    return 2 * R * Math.asin(Math.sqrt(Math.sin(dLat / 2) ** 2 + Math.cos(r(a.latitude)) * Math.cos(r(b.latitude)) * Math.sin(dLon / 2) ** 2));
  };

  test("north and south from 4 miles out, a circle that holds the church, paging, ahead names and best rank", async () => {
    const calls = places([], (c, b) => {
      if (isNorth(b)) return b.pageToken ? json({ places: [...others(6, "N2"), me] }) : json({ places: others(20, "N"), nextPageToken: "north-p2" });
      return json({ places: [others(1, "S")[0], me, ...others(10, "S9")] });
    });
    const r = await nearMeRank("k", listing);
    assert.equal(r.checked, true);
    assert.equal(r.best, 2);
    const n = r.searches.find((s) => s.from === "north"), s = r.searches.find((x) => x.from === "south");
    assert.deepEqual([n.checked, n.rank], [true, 27]);
    assert.deepEqual(n.ahead, ["N Church 0", "N Church 1", "N Church 2"]);
    assert.ok(Math.abs(n.milesAway - 4) < 0.3, String(n.milesAway));
    assert.deepEqual([s.checked, s.rank], [true, 2]);
    assert.ok(typeof n.scanned === "number" && n.scanned >= 27);

    const churchCalls = calls.filter((c) => c.json().textQuery === "church");
    for (const c of churchCalls) {
      const circle = c.json().locationBias.circle;
      const d = miles(CHURCH, circle.center);
      assert.ok(Math.abs(d - 4) < 0.3, `center ${d.toFixed(2)} miles out`);
      assert.ok(Math.abs(circle.radius - (d * 1609.344 + 1500)) < 200, `radius ${circle.radius} m`);
      assert.ok(c.signal instanceof AbortSignal);
    }
    assert.ok(churchCalls.some((c) => c.json().pageToken === "north-p2"), "second page requested with nextPageToken");
  });

  test("stops at 60 results; a church not in them has rank null and scanned 60", async () => {
    let n = 0;
    const calls = places([], (c, b) => { if (isNorth(b)) n++; return json({ places: others(20, isNorth(b) ? `N${n}-` : "S"), nextPageToken: "more" }); });
    const r = await nearMeRank("k", listing);
    const north = r.searches.find((s) => s.from === "north");
    assert.deepEqual([north.checked, north.rank, north.scanned], [true, null, 60]);
    assert.equal(r.best, null);
    assert.equal(r.checked, true);
    assert.ok(calls.filter((c) => { const b = c.json(); return b.textQuery === "church" && isNorth(b); }).length <= 3);
  });

  test("a 429 on one search marks that search not checked and keeps the other", async () => {
    places([], (c, b) => (isNorth(b) ? json({ error: { code: 429, message: "Quota exceeded", status: "RESOURCE_EXHAUSTED" } }, 429) : json({ places: [...others(6, "S"), me] })));
    const r = await nearMeRank("k", listing);
    const north = r.searches.find((s) => s.from === "north"), south = r.searches.find((s) => s.from === "south");
    assert.equal(north.checked, false);
    assert.ok(north.error, "error recorded");
    assert.deepEqual([south.checked, south.rank], [true, 7]);
    assert.equal(r.checked, true);
    assert.equal(r.best, 7);
  });

  test("errors on every search mean not checked, and never throw", async () => {
    places([], () => json({ error: { message: "backend error" } }, 500));
    let r = await nearMeRank("k", listing);
    assert.deepEqual([r.checked, r.best], [false, null]);
    assert.ok(r.searches.every((s) => s.checked === false && s.error));

    stubFetch([]); // network down
    r = await nearMeRank("k", listing);
    assert.deepEqual([r.checked, r.best], [false, null]);
  });
});
