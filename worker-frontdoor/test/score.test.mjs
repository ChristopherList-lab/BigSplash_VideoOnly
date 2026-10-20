import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreAudit } from "../src/score.js";
import { fallbackNotes } from "../src/write.js";

const church = { name: "City Reach Church" };
const google = (extra = {}) => ({ found: true, trusted: true, rating: 4.8, reviewCount: 264, hoursListed: true, website: "https://cityreachchurch.com/", ...extra });
const nearMe = (north, south) => ({ checked: true, best: [north, south].filter(Boolean).sort((a, b) => a - b)[0] ?? null, searches: [
  { from: "north", milesAway: 4, checked: true, rank: north, scanned: north || 60, ahead: [] },
  { from: "south", milesAway: 4, checked: true, rank: south, scanned: south || 60, ahead: [] },
] });
const website = (extra = {}) => ({ ok: true, checked: true, https: true, viewport: true, serviceTimes: { found: true }, planVisit: { found: true }, kids: { found: true },
  socials: { facebook: {}, instagram: {}, youtube: {} }, sermons: { found: true, sources: ["YouTube"] }, youtube: { daysSinceLastUpload: 3 }, vimeo: null, ...extra });
const notes = (a) => fallbackNotes({ ...a, scores: scoreAudit(a) });

test("a strong church gets A's and the A opener", () => {
  const a = { church, google: google(), nearMe: nearMe(2, 7), website: website(), speed: { ok: true, score: 92 } };
  const s = scoreAudit(a);
  assert.deepEqual(Object.values(s.areas).map((x) => x.grade), ["A", "A", "A", "A"]);
  assert.equal(s.findings.length, 0);
  assert.equal(notes(a).summary, "A new family can find what they need to plan a first visit.");
});

test("Google rank is worded from the stored search", () => {
  let s = scoreAudit({ church, google: google(), nearMe: nearMe(7, 9) });
  assert.equal(s.findings[0].fact, 'In a Google search for "church" from about 4 miles north, City Reach Church came up #7.');
  assert.equal(s.findings[0].fix, "Add photos and ask for reviews on your Google listing");
  s = scoreAudit({ church, google: google(), nearMe: nearMe(null, null) });
  assert.match(s.findings[0].fact, /did not come up in the first 60 churches\.$/);
  assert.equal(s.areas.google.points, 64); // 30 + 20 + 10 + 4
});

test("near-me not checked grades Google out of 60 with no rank finding", () => {
  const s = scoreAudit({ church, google: google(), nearMe: { checked: false, best: null, searches: [] } });
  assert.equal(s.areas.google.points, 100);
  assert.equal(s.findings.filter((f) => f.area === "google").length, 0);
});

test("no listing, or an untrusted one, is not graded and gets no finding", () => {
  for (const g of [{ found: false }, google({ trusted: false }), null]) {
    const s = scoreAudit({ church, google: g, nearMe: null, website: website() });
    assert.equal(s.areas.google.points, null);
    assert.equal(s.areas.google.checked, false);
    assert.equal(s.areas.reviews.points, null);
    assert.equal(s.findings.filter((f) => f.area === "google" || f.area === "reviews").length, 0);
    assert.equal(s.overall.grade, null); // only 2 areas graded
  }
});

test("a website the audit could not read is not graded, and social goes with it", () => {
  const s = scoreAudit({ church, google: google(), nearMe: nearMe(2), website: { ok: false, checked: false, reason: "did not load" } });
  assert.equal(s.areas.website.grade, null);
  assert.equal(s.areas.social.grade, null);
  assert.equal(s.findings.some((f) => /did not load|back online/.test(f.fact + f.fix)), false);
  assert.equal(s.overall.points, null);
  const n = notes({ church, google: google(), nearMe: nearMe(2), website: { checked: false } });
  assert.equal(n.areas.website, "We couldn't check this one this time. We can look at it together on a walkthrough call.");
  assert.match(n.summary, /^We couldn't check everything this time\./);
});

test("reviews: few reviews and a lower rating each get a finding", () => {
  let s = scoreAudit({ church, google: google({ rating: 4.8, reviewCount: 5 }) });
  assert.equal(s.areas.reviews.points, 74);
  assert.ok(s.findings.some((f) => f.fact === "City Reach Church has 4.8 stars, but only 5 Google reviews." && f.fix === "Ask your members for Google reviews"));
  s = scoreAudit({ church, google: google({ rating: 4.1, reviewCount: 30 }) });
  assert.ok(s.findings.some((f) => f.fact === "The Google rating is 4.1 stars." && f.fix === "Reply to every Google review, kind or not"));
  // A 10-point deduction (4.5 stars) still names the fact behind it.
  s = scoreAudit({ church, google: google({ rating: 4.5, reviewCount: 60 }) });
  assert.equal(s.areas.reviews.points, 90);
  // A 4.5 is a good rating: a plain fact with no fix, never the biggest gap.
  assert.ok(s.findings.some((f) => f.fact === "The Google rating is 4.5 stars from 60 reviews." && f.fix === null));
});

test("website: speed is a lab score with no lab seconds; real-visitor seconds only from field data", () => {
  let s = scoreAudit({ church, website: website(), speed: { ok: true, score: 26, fieldLcpSeconds: null } });
  const f = s.findings.find((x) => x.fix === "Speed up your website on phones");
  assert.equal(f.fact, "Google's phone speed test, which simulates a slow cell connection, scores the site 26 out of 100.");
  assert.equal(s.areas.website.points, 88); // 77 of 88
  s = scoreAudit({ church, website: website(), speed: { ok: true, score: 40, fieldLcpSeconds: 3.1 } });
  assert.equal(s.findings[0].fact, "Real visitors on phones wait about 3.1 seconds for the main content to show.");
  // Fast real visitors: no speed fix, whatever the lab score says.
  s = scoreAudit({ church, website: website(), speed: { ok: true, score: 32, fieldLcpSeconds: 1.5 } });
  assert.equal(s.findings.some((x) => x.fix === "Speed up your website on phones"), false);
  assert.equal(s.areas.website.points, 100);
  s = scoreAudit({ church, website: website({ planVisit: { found: false } }), speed: null });
  assert.equal(s.areas.website.points, 72); // 63 of 88: unknown speed earns 11
  assert.ok(s.findings.some((x) => x.fact === "We couldn't find a plan-your-visit or I'm-new link on the home page."));
});

test("social: sermons on Vimeo are sermons; stale uploads and missing sermons are named", () => {
  let s = scoreAudit({ church, website: website({ socials: { facebook: {}, instagram: {}, vimeo: {} }, sermons: { found: true, sources: ["Vimeo"] }, youtube: null, vimeo: { daysSinceLastUpload: 1 } }) });
  assert.equal(s.areas.social.points, 100);
  assert.equal(s.findings.some((f) => /YouTube/.test(f.fact)), false);
  s = scoreAudit({ church, website: website({ youtube: { daysSinceLastUpload: 40 } }) });
  assert.ok(s.findings.some((f) => f.fact === "The last sermon upload we found was 40 days ago." && f.fix === "Post each Sunday's sermon"));
  s = scoreAudit({ church, website: website({ socials: {}, sermons: { found: false, sources: [] }, youtube: null }) });
  assert.equal(s.areas.social.points, 0);
  assert.ok(s.findings.some((f) => f.fact === "We couldn't find a link to your sermons on the home page." && f.fix === "Put last Sunday's sermon on your home page"));
  // Sermons found but no upload date: graded out of the 60 points that could be checked, and a plain fact with no fix.
  s = scoreAudit({ church, website: website({ youtube: { daysSinceLastUpload: null } }) });
  assert.equal(s.areas.social.points, 100);
  assert.ok(s.findings.some((f) => /could not read their upload dates/.test(f.fact) && f.fix === null));
});

test("notes: openers follow the grade, and an A or B with no findings keeps the kind sentence", () => {
  const a = { church, google: google({ reviewCount: 30 }), nearMe: nearMe(2), website: website({ kids: { found: false } }), speed: { ok: true, score: 92 } };
  const n = notes(a);
  assert.match(n.summary, /^A new family can find most of what they need\. The biggest gap: we couldn't find a link for kids/);
  assert.equal(n.areas.google, "The Google listing gives a neighbor what they need.");
  const weak = { church, google: google({ rating: 3.2, reviewCount: 2, hoursListed: false }), nearMe: nearMe(null), website: website({ serviceTimes: { found: false }, planVisit: { found: false } }) };
  assert.match(notes(weak).summary, /^A new family will have trouble finding what they need\./);
  assert.notEqual(notes(weak).areas.reviews, "Reviews look healthy.");
  assert.equal(new Set(notes(weak).fixes.map((f) => f.title)).size, notes(weak).fixes.length);
});

test("no pastor-facing text uses an em dash or 'holy'", () => {
  const a = { church, google: google({ rating: 3.2, reviewCount: 2, hoursListed: false, website: null }), nearMe: nearMe(null), website: website({ https: false, viewport: false, serviceTimes: { found: false }, planVisit: { found: false }, kids: { found: false }, socials: {}, sermons: { found: false }, youtube: null }), speed: { ok: true, score: 10, fieldLcpSeconds: 6 } };
  const text = JSON.stringify(notes(a)) + JSON.stringify(scoreAudit(a).findings);
  assert.equal(/—|\bholy\b/i.test(text), false);
});
