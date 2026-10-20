// Spec items 3, 4 and 5: pagespeed.js, geocode.js ZIP fallback, reach.js Texas only.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { stubFetch, json, timeouts } from "./spec-helpers.mjs";
import { mobileSpeed } from "../src/pagespeed.js";
import { zipOf } from "../src/geocode.js";
import { homesWithin } from "../src/reach.js";

const PSI = /pagespeedonline\/v5\/runPagespeed/;
const lab = (score, extra = {}) => ({ lighthouseResult: { categories: { performance: { score } }, audits: { "largest-contentful-paint": { numericValue: 17940, displayValue: "17.9 s" } }, ...extra } });

describe("PageSpeed", () => {
  test("90 second timeout, score as a whole number, field LCP in seconds, no lab load time", async () => {
    timeouts.length = 0;
    const calls = stubFetch([[PSI, () => json({ ...lab(0.26), loadingExperience: { metrics: { LARGEST_CONTENTFUL_PAINT_MS: { percentile: 3140, category: "AVERAGE" } } } })]]);
    const s = await mobileSpeed("https://cityreachchurch.com/", "k");
    assert.equal(s.ok, true);
    assert.equal(s.score, 26);
    assert.ok(Math.abs(s.fieldLcpSeconds - 3.14) < 0.06, String(s.fieldLcpSeconds));
    assert.ok(calls[0].signal instanceof AbortSignal);
    assert.ok(timeouts.includes(90000), `timeouts seen: ${timeouts}`);
    assert.equal(/17\.9|17940/.test(JSON.stringify(s)), false, `lab LCP leaked: ${JSON.stringify(s)}`);
  });

  test("no field data means fieldLcpSeconds is null", async () => {
    stubFetch([[PSI, () => json(lab(0.45))]]);
    const s = await mobileSpeed("https://x.org/", "k");
    assert.deepEqual([s.ok, s.score, s.fieldLcpSeconds], [true, 45, null]);
  });

  test("a Lighthouse runtimeError is not a score", async () => {
    stubFetch([[PSI, () => json(lab(null, { runtimeError: { code: "NO_FCP", message: "The page did not paint any content." } }))]]);
    const s = await mobileSpeed("https://x.org/", "k");
    assert.equal(s.ok, false);
    assert.notEqual(s.score, 0);
  });

  test("a missing performance score is not a score", async () => {
    stubFetch([[PSI, () => json({ lighthouseResult: { categories: { performance: { score: null } } } })]]);
    assert.equal((await mobileSpeed("https://x.org/", "k")).ok, false);
    stubFetch([[PSI, () => json({ lighthouseResult: { categories: {} } })]]);
    assert.equal((await mobileSpeed("https://x.org/", "k")).ok, false);
  });

  test("an API error or a timeout is ok:false, not a throw", async () => {
    stubFetch([[PSI, () => json({ error: { code: 429, message: "Quota exceeded" } }, 429)]]);
    assert.equal((await mobileSpeed("https://x.org/", "k")).ok, false);
    stubFetch([[PSI, new DOMException("timed out", "TimeoutError")]]);
    assert.equal((await mobileSpeed("https://x.org/", "k")).ok, false);
  });
});

describe("ZIP fallback", () => {
  const z = (a) => { const v = zipOf(a); return v == null ? null : String(v); };
  test("never takes a five-digit street number", () => {
    assert.equal(z("15800 Crossroads Drive, Austin TX"), null);
    assert.equal(z("10701 FM 2222, Austin"), null);
    assert.equal(z("12345 Main St"), null);
  });
  test("takes a ZIP after a state name or abbreviation, or the final token", () => {
    assert.equal(z("15800 Crossroads Drive, Austin, TX 78717"), "78717");
    assert.equal(z("10701 FM 2222, Austin, Texas 78730"), "78730");
    assert.equal(z("2700 W Whitestone Blvd, Cedar Park, TX 78613, USA"), "78613");
    assert.equal(z("Main St, Austin 78701"), "78701");
  });
});

describe("reach", () => {
  test("Texas church gets a count", () => {
    const r = homesWithin(30.5156, -97.8703, 5, "2700 W Whitestone Blvd, Cedar Park, TX 78613, USA", "2700 W Whitestone Blvd, Cedar Park, TX 78613");
    assert.ok(r && r.households > 0);
  });
  test("Texarkana, AR from the Google address is null", () => {
    assert.equal(homesWithin(33.4418, -94.0377, 5, "100 E Broad St, Texarkana, AR 71854, USA", "100 E Broad St, Texarkana, AR"), null);
  });
  test("Sunland Park, NM from the typed address is null when Google gave none", () => {
    assert.equal(homesWithin(31.7965, -106.5799, 5, undefined, "1 Main St, Sunland Park, NM 88063"), null);
  });
  test("Anthony, NM is null; Texas spelled out still counts", () => {
    assert.equal(homesWithin(32.0040, -106.6056, 5, "200 Main St, Anthony, NM 88021, USA"), null);
    const r = homesWithin(30.2672, -97.7431, 5, undefined, "100 Congress Ave, Austin, Texas 78701");
    assert.ok(r && r.households > 0);
  });
});
