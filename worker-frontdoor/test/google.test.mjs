import { test } from "node:test";
import assert from "node:assert/strict";
import { findListing, nearMeRank, matchConfidence, namesMatch } from "../src/google.js";
import { stubFetch, jsonRes } from "./helpers.mjs";

const SEARCH = "https://places.googleapis.com/v1/places:searchText";
const place = (id, name, extra = {}) => ({ id, displayName: { text: name }, formattedAddress: `${id} Main St, Georgetown, TX 78628, USA`, location: { latitude: 30.6, longitude: -97.7 }, userRatingCount: 10, rating: 4.8, businessStatus: "OPERATIONAL", ...extra });
const body = (init) => JSON.parse(init.body);

test("names: weak words never match, distinctive words and equal names do", () => {
  assert.equal(namesMatch("First Baptist Church", "First Baptist Church of Georgetown", ["georgetown"]), false);
  assert.equal(namesMatch("Grace Bible Church", "Grace Community Church"), false);
  assert.equal(namesMatch("First Baptist Church", "First Baptist Church"), true);
  assert.equal(namesMatch("City Reach Church", "CityReach Church"), true);
  assert.equal(namesMatch("Crossroads Church Austin", "Crossroads Church", ["austin"]), true);
  assert.equal(namesMatch("First Baptist Georgetown", "Georgetown Church of Christ", ["georgetown", "tx"]), false);
});

test("confidence: high, medium, conflict, low", () => {
  const church = { name: "City Reach Church", website: "https://cityreachchurch.com/", address: "2700 W Whitestone Blvd, Cedar Park, TX 78613" };
  assert.equal(matchConfidence({ displayName: { text: "City Reach Church" }, websiteUri: "http://www.cityreachchurch.com/home" }, church).confidence, "high");
  assert.equal(matchConfidence({ displayName: { text: "City Reach Church" } }, church).confidence, "medium");
  const c = matchConfidence({ displayName: { text: "Grace Bible Church" }, websiteUri: "https://gbcgt.org/" }, { ...church, name: "Grace Bible Church" });
  assert.equal(c.confidence, "conflict");
  assert.match(c.reason, /gbcgt\.org/);
  assert.equal(matchConfidence({ displayName: { text: "Hill Country Bible" } }, church).confidence, "low");
  // A redirect target counts as the typed site.
  assert.equal(matchConfidence({ displayName: { text: "Lakepointe Church" }, websiteUri: "https://lakepointe.church" }, { name: "Lakepointe Church", website: "https://lakepointe.org/" }, ["https://lakepointe.org/", "https://www.lakepointe.church/"]).confidence, "high");
  // Two Facebook pages are two churches.
  assert.equal(matchConfidence({ displayName: { text: "New Hope" }, websiteUri: "https://facebook.com/hopefellowshiptx" }, { name: "New Hope", website: "https://facebook.com/newhopegtx" }).confidence, "conflict");
});

test("findListing: preschool on the church's domain loses to the church, closed listings drop, duplicates are kept for Slack", async () => {
  const church = { name: "Faith Lutheran Church", website: "https://flcms.org/", address: "1 Main St, Georgetown, TX 78628" };
  stubFetch([[SEARCH, () => jsonRes({ places: [
    place("pre", "Faith Lutheran Preschool", { websiteUri: "https://flcms.org/preschool", userRatingCount: 6 }),
    place("old", "Faith Lutheran Church", { businessStatus: "CLOSED_PERMANENTLY" }),
    place("church", "Faith Lutheran Church", { userRatingCount: 85, regularSecondaryOpeningHours: [{ periods: [{ open: { day: 0, hour: 9 } }], weekdayDescriptions: ["Sunday: 9 AM"] }] }),
  ] })]]);
  const g = await findListing("k", church);
  assert.equal(g.id, "church");
  assert.equal(g.confidence, "medium");
  assert.equal(g.hoursListed, true);
  assert.deepEqual(g.possibleDuplicates.map((d) => d.name), ["Faith Lutheran Preschool"]);
});

test("findListing: no results means not found", async () => {
  stubFetch([[SEARCH, () => jsonRes({})]]);
  assert.equal((await findListing("k", { name: "X", website: "x.org" })).found, false);
});

test("nearMeRank pages through results, records each search, and never throws", async () => {
  const listing = { found: true, id: "me", lat: 30.5, lon: -97.8 };
  const filler = (n, from) => Array.from({ length: n }, (_, i) => ({ id: `${from}${i}`, displayName: { text: `Church ${from}${i}` } }));
  const calls = stubFetch([[SEARCH, (url, init) => {
    const b = body(init);
    const north = b.locationBias.circle.center.latitude > listing.lat;
    if (!north) return jsonRes({ error: { message: "quota" } }, 429);
    if (!b.pageToken) return jsonRes({ places: [{ id: "chicken", displayName: { text: "Church's Texas Chicken" }, types: ["restaurant"] }, ...filler(20, "a")], nextPageToken: "p2" });
    return jsonRes({ places: [...filler(6, "b"), { id: "me", displayName: { text: "Me" } }] });
  }]]);
  const r = await nearMeRank("k", listing);
  assert.equal(r.checked, true);
  assert.equal(r.best, 27);
  const [n, s] = r.searches;
  assert.deepEqual([n.from, n.checked, n.rank, n.scanned], ["north", true, 27, 27]);
  assert.deepEqual(n.ahead, ["Church a0", "Church a1", "Church a2"]);
  assert.equal(Math.round(n.milesAway), 4);
  assert.deepEqual([s.from, s.checked], ["south", false]);
  assert.match(s.error, /429/);
  // The bias circle reaches past the church: 4 miles plus 1.5 km.
  const radius = body(calls[0].init).locationBias.circle.radius;
  assert.ok(radius > 7800 && radius < 8100, String(radius));
  assert.ok(calls.every((c) => c.init.signal instanceof AbortSignal));
});

test("nearMeRank: all errors means not checked, not 'not found'", async () => {
  stubFetch([[SEARCH, () => jsonRes({ error: { message: "down" } }, 500)]]);
  const r = await nearMeRank("k", { found: true, id: "me", lat: 30.5, lon: -97.8 });
  assert.deepEqual([r.checked, r.best], [false, null]);
});
