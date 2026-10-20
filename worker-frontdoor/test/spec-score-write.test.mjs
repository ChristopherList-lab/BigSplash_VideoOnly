// Spec items 7 and 8: score.js grading and write.js wording.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { stubFetch, json, allText } from "./spec-helpers.mjs";
import { scoreAudit, letter } from "../src/score.js";
import { fallbackNotes, writeNotes } from "../src/write.js";

const NAME = "City Reach Church";
const church = { name: NAME, address: "2700 W Whitestone Blvd, Cedar Park, TX 78613", website: "https://cityreachchurch.com/" };
const google = (x = {}) => ({ found: true, name: NAME, confidence: "high", rating: 4.8, reviewCount: 264, hoursListed: true, website: "https://cityreachchurch.com/", photoCount: null, ...x });
const search = (from, rank, extra = {}) => ({ from, milesAway: 4, checked: true, rank, scanned: rank ?? 60, ahead: ["Hill Country Bible Church", "Life Church", "North Way Bible Church"], ...extra });
const nearMe = (north, south) => {
  const searches = [typeof north === "object" && north ? north : search("north", north), typeof south === "object" && south ? south : search("south", south)];
  const ranks = searches.filter((s) => s.checked && s.rank).map((s) => s.rank);
  return { checked: searches.some((s) => s.checked), best: ranks.length ? Math.min(...ranks) : null, searches };
};
const failed = (from) => ({ from, milesAway: 4, checked: false, error: "Places 429" });
const website = (x = {}) => ({ ok: true, checked: true, source: "typed", url: "https://cityreachchurch.com/", finalUrl: "https://cityreachchurch.com/", status: 200, https: true, viewport: true,
  serviceTimes: { found: true, sample: "Sundays 8:15AM & 10AM & 11:45AM" }, planVisit: { found: true, label: "Plan a Visit", href: "https://cityreachchurch.com/visit" },
  kids: { found: true, label: "Kids", href: "https://cityreachchurch.com/kids" },
  socials: { facebook: { url: "https://www.facebook.com/CityReachTX", handle: "CityReachTX" }, instagram: { url: "https://www.instagram.com/cityreachchurch", handle: "cityreachchurch" }, youtube: { url: "https://www.youtube.com/@cityreach", handle: "@cityreach" } },
  sermons: { found: true, sources: ["YouTube"] }, youtube: { found: true, daysSinceLastUpload: 3, lastUpload: "2026-10-16T15:00:00Z", uploadsLast30Days: 5 }, vimeo: null, ...x });
const speed = (score, fieldLcpSeconds = null) => ({ ok: true, score, fieldLcpSeconds });
const audit = (x = {}) => ({ church, google: google(), nearMe: nearMe(2, 7), website: website(), speed: speed(92), reach: { households: 57700, miles: 5 }, ...x });

const findings = (s) => { assert.ok(Array.isArray(s.findings), "scores.findings is a list"); return s.findings; };
const facts = (s) => findings(s).map((f) => f.fact);
const has = (s, fact, fix) => findings(s).some((f) => f.fact === fact && (fix === undefined || f.fix === fix));
const near = (actual, expected, msg) => assert.ok(actual != null && Math.abs(actual - expected) <= 1, `${msg || ""} expected about ${expected}, got ${actual}`);
const notesFor = (a) => fallbackNotes({ ...a, scores: scoreAudit(a) });

describe("area shape and overall", () => {
  test("areas are { points, grade, checked } and a strong church gets A with no findings", () => {
    const s = scoreAudit(audit());
    for (const k of ["google", "reviews", "website", "social"]) {
      assert.deepEqual(Object.keys(s.areas[k]).filter((x) => ["points", "grade", "checked"].includes(x)).sort(), ["checked", "grade", "points"], k);
      assert.equal(s.areas[k].checked, true, k);
      assert.equal(s.areas[k].points, 100, k);
    }
    assert.equal(s.overall.grade, "A");
    assert.deepEqual(facts(s), []);
  });

  test("overall is the average of graded areas, only with 3 or more", () => {
    let s = scoreAudit(audit({ google: google({ rating: 4.8, reviewCount: 5 }), website: { ok: false, checked: false, reason: "could not check" } }));
    assert.equal(s.areas.website.points, null);
    assert.equal(s.areas.social.points, null);
    assert.equal(s.overall.points ?? null, null);
    assert.equal(s.overall.grade ?? null, null);
    s = scoreAudit(audit({ google: google({ rating: 4.8, reviewCount: 5 }), website: website({ socials: {}, sermons: { found: false, sources: [] }, youtube: null }) }));
    // google 100, reviews 74, website 100, social 0
    near(s.overall.points, (100 + 74 + 100 + 0) / 4, "overall");
  });

  test("letter is A at 100 and F at 0", () => {
    assert.equal(letter(100), "A");
    assert.equal(letter(0), "F");
  });
});

describe("Google area", () => {
  const pts = (x) => scoreAudit(audit(x)).areas.google.points;
  test("rank tiers out of 100: base 30, hours 20, website 10, rank 40", () => {
    near(pts({ nearMe: nearMe(1, 9) }), 100, "rank 1");
    near(pts({ nearMe: nearMe(5, 9) }), 92, "rank 5");
    near(pts({ nearMe: nearMe(8, 9) }), 84, "rank 8");
    near(pts({ nearMe: nearMe(15, 30) }), 76, "rank 15");
    near(pts({ nearMe: nearMe(40, null) }), 70, "rank 40");
    near(pts({ nearMe: nearMe(null, null) }), 64, "not in results");
    near(pts({ google: google({ hoursListed: false }) }), 80, "no hours");
    near(pts({ google: google({ website: null }) }), 90, "no website on listing");
  });

  test("photos never count", () => {
    assert.equal(pts({ google: google({ photoCount: 0 }) }), pts({ google: google({ photoCount: 10 }) }));
    assert.equal(pts({ google: google({ photoCount: null }) }), pts({ google: google({ photoCount: 2 }) }));
  });

  test("near-me not checked: graded out of 60 with no rank finding", () => {
    const off = { checked: false, best: null, searches: [failed("north"), failed("south")] };
    let s = scoreAudit(audit({ nearMe: off }));
    near(s.areas.google.points, 100, "hours + website of 60");
    assert.equal(s.areas.google.checked, true);
    assert.equal(/did not come up|came up #/.test(allText(findings(s))), false);
    s = scoreAudit(audit({ nearMe: off, google: google({ website: null }) }));
    near(s.areas.google.points, (50 / 60) * 100, "hours only of 60");
    s = scoreAudit(audit({ nearMe: null }));
    assert.equal(/did not come up/.test(allText(findings(s))), false, "null nearMe is not 'not found'");
  });

  test("rank finding is worded from the stored search", () => {
    let s = scoreAudit(audit({ nearMe: nearMe(7, 9) }));
    assert.ok(has(s, `In a Google search for "church" from about 4 miles north, ${NAME} came up #7.`, "Add photos and ask for reviews on your Google listing"), allText(facts(s)));
    s = scoreAudit(audit({ nearMe: nearMe(failed("north"), 9) }));
    assert.ok(facts(s).includes(`In a Google search for "church" from about 4 miles south, ${NAME} came up #9.`), allText(facts(s)));
    s = scoreAudit(audit({ nearMe: nearMe(null, null) }));
    assert.ok(facts(s).some((f) => new RegExp(`^In a Google search for "church" from about 4 miles (north|south), ${NAME} did not come up in the first 60 churches\\.$`).test(f)), allText(facts(s)));
    s = scoreAudit(audit({ nearMe: nearMe(3, 12) }));
    assert.equal(/came up #|did not come up/.test(allText(facts(s))), false, "rank 3 or better gets no rank finding");
  });

  test("hours missing finding", () => {
    const s = scoreAudit(audit({ google: google({ hoursListed: false }) }));
    assert.ok(has(s, "The Google listing has no service times or hours.", "Add your service times to Google"));
  });

  test("no Google listing: Google and Reviews not graded, no finding, never F", () => {
    for (const g of [{ found: false }, null]) {
      const s = scoreAudit(audit({ google: g, nearMe: null }));
      assert.deepEqual([s.areas.google.points, s.areas.google.grade ?? null, s.areas.google.checked], [null, null, false]);
      assert.deepEqual([s.areas.reviews.points, s.areas.reviews.grade ?? null, s.areas.reviews.checked], [null, null, false]);
      assert.equal(/Google listing|review|rating/i.test(allText(facts(s))), false, allText(facts(s)));
    }
  });
});

describe("Reviews area", () => {
  const ratingPts = (r) => (r >= 4.7 ? 60 : r >= 4.4 ? 50 : r >= 4.0 ? 36 : r >= 3.5 ? 20 : 0);
  const countPts = (c) => (c >= 50 ? 40 : c >= 25 ? 32 : c >= 10 ? 22 : c >= 5 ? 14 : c >= 1 ? 8 : 0);

  test("Crossroads: 4.8 stars from 5 reviews names both numbers and is not an F", () => {
    const s = scoreAudit(audit({ google: google({ rating: 4.8, reviewCount: 5 }) }));
    near(s.areas.reviews.points, 74, "4.8 / 5");
    assert.notEqual(s.areas.reviews.grade, "F");
    assert.ok(has(s, `${NAME} has 4.8 stars, but only 5 Google reviews.`, "Ask your members for Google reviews"), allText(facts(s)));
  });

  test("a rating under 4.4 gets the reply finding", () => {
    const s = scoreAudit(audit({ google: google({ rating: 4.1, reviewCount: 30 }) }));
    near(s.areas.reviews.points, 68, "4.1 / 30");
    assert.ok(has(s, "The Google rating is 4.1 stars.", "Reply to every Google review, kind or not"));
  });

  test("points follow the table, and every deduction of 10 or more has a finding", () => {
    for (const rating of [3.2, 3.8, 4.2, 4.5, 4.6, 4.8, 5.0]) {
      for (const count of [1, 3, 7, 12, 30, 60, 300]) {
        const s = scoreAudit(audit({ google: google({ rating, reviewCount: count }) }));
        const want = ratingPts(rating) + countPts(count);
        near(s.areas.reviews.points, want, `${rating} / ${count}`);
        if (100 - want >= 10) {
          assert.ok(findings(s).some((f) => /review|rating|stars/i.test(f.fact)), `${rating} stars, ${count} reviews lost ${100 - want} points with no finding`);
        }
      }
    }
  });
});

describe("Website area", () => {
  test("scaled from 88: https 8, viewport 8, times 24, plan 20, kids 12, speed 16", () => {
    const pts = (w, sp) => scoreAudit(audit({ website: website(w), speed: sp })).areas.website.points;
    near(pts({}, speed(92)), 100);
    near(pts({}, speed(75)), (86 / 88) * 100, "speed 75");
    near(pts({}, speed(55)), (83 / 88) * 100, "speed 55");
    near(pts({}, speed(35)), (80 / 88) * 100, "speed 35");
    near(pts({}, speed(26)), (77 / 88) * 100, "speed 26");
    near(pts({ planVisit: { found: false } }, null), (63 / 88) * 100, "unknown speed earns 11");
    near(pts({ planVisit: { found: false } }, { ok: false }), (63 / 88) * 100, "failed speed test earns 11");
    near(pts({ https: false, viewport: false, serviceTimes: { found: false }, kids: { found: false } }, speed(92)), (36 / 88) * 100, "only plan + speed");
  });

  test("City Reach: lab score finding with no load seconds", () => {
    const s = scoreAudit(audit({ speed: speed(26) }));
    assert.ok(has(s, "Google's phone speed test, which simulates a slow cell connection, scores the site 26 out of 100.", "Speed up your website on phones"), allText(facts(s)));
    assert.equal(/seconds| s to appear/.test(allText(findings(s))), false);
  });

  test("real-visitor seconds only from field data, and field data outranks the lab score", () => {
    let s = scoreAudit(audit({ speed: speed(26, 4.2) }));
    const f = findings(s).find((x) => x.fix === "Speed up your website on phones");
    assert.equal(f.fact, "Real visitors on phones wait about 4.2 seconds for the main content to show.");
    near(s.areas.website.points, (77 / 88) * 100, "4.2 s earns 5");
    // City Reach: lab 32, real visitors 1.5 s. No "speed up" advice next to a fast real-visitor time.
    s = scoreAudit(audit({ speed: speed(32, 1.5) }));
    assert.equal(findings(s).some((x) => /speed/i.test(x.fact + x.fix)), false);
    near(s.areas.website.points, 100, "1.5 s earns 16");
  });

  test("no speed finding at 50 or above", () => {
    const s = scoreAudit(audit({ speed: speed(55, 2.1) }));
    assert.equal(findings(s).some((f) => /speed/i.test(f.fact + f.fix)), false);
  });

  test("plan visit, service times, kids, https and viewport findings", () => {
    const s = scoreAudit(audit({ website: website({ https: false, viewport: false, serviceTimes: { found: false }, planVisit: { found: false }, kids: { found: false } }) }));
    assert.ok(facts(s).includes("We couldn't find a plan-your-visit or I'm-new link on the home page."));
    assert.ok(facts(s).some((f) => /service times/i.test(f)), "service times finding");
    assert.ok(facts(s).some((f) => /kid/i.test(f)), "kids finding");
    assert.ok(findings(s).some((f) => /https|secure|padlock|not safe/i.test(f.fact + f.fix)), "https finding");
    assert.ok(findings(s).some((f) => /phone screen|mobile|viewport/i.test(f.fact + f.fix)), "viewport finding");
  });

  for (const w of [{ ok: false, checked: false, reason: "did not load" }, { ok: false, checked: false, reason: "HTTP 403" }, { ok: false, checked: false, reason: "page builds itself with JavaScript" }]) {
    test(`website not checked (${w.reason}): website and social are null with no findings, never 'down'`, () => {
      const s = scoreAudit(audit({ website: w, speed: null }));
      for (const k of ["website", "social"]) {
        assert.deepEqual([s.areas[k].points, s.areas[k].grade ?? null, s.areas[k].checked], [null, null, false], k);
      }
      const text = allText(findings(s));
      assert.equal(/did not load|back online|is down|offline|could not load|social accounts|sermon/i.test(text), false, text);
      const n = notesFor(audit({ website: w, speed: null }));
      assert.equal(/did not load|back online|is down|offline/i.test(allText(n)), false, allText(n));
    });
  }
});

describe("Social and sermons area", () => {
  const pts = (w) => scoreAudit(audit({ website: website(w) })).areas.social.points;
  test("accounts, sermons and recency tiers", () => {
    near(pts({}), 100, "3 accounts, sermons, 3 days");
    near(pts({ socials: { facebook: {}, instagram: {} }, sermons: { found: true, sources: ["Vimeo"] }, youtube: null, vimeo: { daysSinceLastUpload: 10, lastUpload: "2026-10-09T00:00:00Z" } }), 22 + 30 + 32, "2 accounts, 10 days");
    near(pts({ socials: { facebook: {} }, youtube: { daysSinceLastUpload: 20 } }), 12 + 30 + 22, "1 account, 20 days");
    near(pts({ youtube: { daysSinceLastUpload: 45 } }), 70, "45 days");
    near(pts({ youtube: { daysSinceLastUpload: 90 } }), 60, "90 days");
    near(pts({ youtube: { daysSinceLastUpload: null } }), 100, "sermons, recency unknown: 60 of 60");
    near(pts({ socials: { facebook: {} }, youtube: { daysSinceLastUpload: null } }), (42 / 60) * 100, "1 account, recency unknown");
    near(pts({ youtube: null, vimeo: null, sermons: { found: true, sources: ["Sermons page"] } }), 100, "sermons page only");
    near(pts({ socials: { facebook: {}, instagram: {}, tiktok: {} }, sermons: { found: false, sources: [] }, youtube: null }), 30, "no sermons");
    near(pts({ socials: {}, sermons: { found: false, sources: [] }, youtube: null }), 0, "nothing");
  });

  test("freshest of YouTube and Vimeo wins", () => {
    const s = scoreAudit(audit({ website: website({ socials: { facebook: {}, instagram: {}, youtube: {}, vimeo: {} }, sermons: { found: true, sources: ["YouTube", "Vimeo"] },
      youtube: { daysSinceLastUpload: 40 }, vimeo: { daysSinceLastUpload: 5 } }) }));
    near(s.areas.social.points, 100);
    assert.equal(/days ago/.test(allText(facts(s))), false);
  });

  test("Grace Bible: Vimeo sermons and no YouTube never reads as 'hard to find'", () => {
    const s = scoreAudit(audit({ website: website({ socials: { facebook: {}, instagram: {}, vimeo: {} }, sermons: { found: true, sources: ["Vimeo", "Sermons page", "Podcast"] }, youtube: null, vimeo: null }) }));
    near(s.areas.social.points, 100);
    const text = allText(findings(s));
    assert.equal(/YouTube|hard to find|can't find|couldn't find/i.test(text), false, text);
    const n = notesFor(audit({ website: website({ socials: { facebook: {}, instagram: {}, vimeo: {} }, sermons: { found: true, sources: ["Vimeo"] }, youtube: null, vimeo: null }) }));
    assert.equal(/hard to find|YouTube channel/i.test(allText(n)), false, allText(n));
  });

  test("stale upload finding", () => {
    const s = scoreAudit(audit({ website: website({ youtube: { daysSinceLastUpload: 40 } }) }));
    assert.ok(has(s, "The last sermon upload we found was 40 days ago.", "Post each Sunday's sermon"), allText(facts(s)));
    const fresh = scoreAudit(audit({ website: website({ youtube: { daysSinceLastUpload: 14 } }) }));
    assert.equal(/days ago/.test(allText(facts(fresh))), false);
  });

  test("no sermons, no accounts, no Instagram", () => {
    let s = scoreAudit(audit({ website: website({ socials: { facebook: {}, instagram: {} }, sermons: { found: false, sources: [] }, youtube: null }) }));
    assert.ok(has(s, "We couldn't find a link to your sermons on the home page.", "Put last Sunday's sermon on your home page"));
    s = scoreAudit(audit({ website: website({ socials: {}, sermons: { found: false, sources: [] }, youtube: null }) }));
    assert.ok(findings(s).some((f) => /account|social|facebook|instagram/i.test(f.fact)), allText(facts(s)));
    s = scoreAudit(audit({ website: website({ socials: { facebook: {}, youtube: {}, tiktok: {} } }) }));
    assert.ok(findings(s).some((f) => /instagram/i.test(f.fact + f.fix)), "missing Instagram is named");
  });
});

describe("fallback notes", () => {
  const OPENERS = {
    A: "A new family can find what they need to plan a first visit.",
    B: "A new family can find most of what they need.",
    C: "A new family can find some of what they need.",
    D: "A new family will have trouble finding what they need.",
    F: "A new family will have trouble finding what they need.",
    null: "We couldn't check everything this time.",
  };
  const scenarios = {
    strong: audit(),
    aWithFinding: audit({ website: website({ socials: { facebook: {}, youtube: {}, tiktok: {} } }) }),
    b: audit({ google: google({ rating: 4.5, reviewCount: 30 }), website: website({ kids: { found: false }, socials: { facebook: {}, instagram: {} }, youtube: { daysSinceLastUpload: 10 } }) }),
    c: audit({ nearMe: nearMe(5, 9), google: google({ rating: 4.8, reviewCount: 5 }), website: website({ planVisit: { found: false }, socials: { facebook: {}, instagram: {} }, youtube: { daysSinceLastUpload: 20 } }), speed: speed(60) }),
    weak: audit({ nearMe: nearMe(null, null), google: google({ rating: 3.2, reviewCount: 2, hoursListed: false }),
      website: website({ https: false, viewport: false, serviceTimes: { found: false }, planVisit: { found: false }, kids: { found: false }, socials: {}, sermons: { found: false, sources: [] }, youtube: null }), speed: speed(12) }),
    notChecked: audit({ google: { found: false }, nearMe: null }),
  };

  test("opener follows the overall grade, then the biggest gap", () => {
    const seen = new Set();
    for (const [name, a] of Object.entries(scenarios)) {
      const s = scoreAudit(a);
      const g = s.overall.grade ?? null;
      seen.add(g === "D" || g === "F" ? "DF" : String(g));
      const n = fallbackNotes({ ...a, scores: s });
      // A plain fact with no fix (an unread upload date) never counts as a gap.
      const gaps = findings(s).filter((f) => f.fix);
      const want = g === "A" && gaps.length ? OPENERS.B : OPENERS[String(g)];
      assert.ok(n.summary.startsWith(want), `${name} (${g}): ${n.summary}`);
      if (gaps.length) assert.match(n.summary, /The biggest gap: /, name);
      else assert.equal(/biggest gap/i.test(n.summary), false, name);
    }
    assert.deepEqual([...seen].sort(), ["A", "B", "C", "DF", "null"].sort(), "scenarios cover every opener");
  });

  test("the A opener stands alone only with no findings", () => {
    assert.equal(notesFor(scenarios.strong).summary, OPENERS.A);
  });

  test("note: kind sentence only for A or B with no findings, null says not checked, else the top facts", () => {
    const strong = notesFor(scenarios.strong);
    const kind = strong.areas;
    for (const k of ["google", "reviews", "website", "social"]) assert.ok(typeof kind[k] === "string" && kind[k].length > 0, k);

    const weakA = scenarios.weak, s = scoreAudit(weakA), n = fallbackNotes({ ...weakA, scores: s });
    for (const k of ["google", "reviews", "website", "social"]) {
      if (["A", "B"].includes(s.areas[k].grade)) continue;
      assert.notEqual(n.areas[k], kind[k], `${k} ${s.areas[k].grade} got the kind sentence`);
      assert.equal(/healthy|looks? good|in good shape|gives a neighbor what they need/i.test(n.areas[k]), false, `${k}: ${n.areas[k]}`);
      const areaFacts = findings(s).filter((f) => f.area === k).map((f) => f.fact);
      if (areaFacts.length) assert.ok(n.areas[k].includes(areaFacts[0]) || areaFacts.some((f) => n.areas[k].includes(f)), `${k} note should carry its facts: ${n.areas[k]}`);
    }

    const aWith = notesFor(scenarios.aWithFinding);
    assert.notEqual(aWith.areas.social, kind.social, "an A area with a finding shows the finding");
    assert.match(aWith.areas.social, /Instagram/);

    const nc = notesFor(scenarios.notChecked);
    assert.equal(nc.areas.google, "We couldn't check this one this time. We can go over it together on a call with our team.");
    assert.equal(nc.areas.reviews, "We couldn't check this one this time. We can go over it together on a call with our team.");
  });

  test("Reviews at 4.5 from 40 (B or lower with a finding) never says 'healthy'", () => {
    const a = audit({ google: google({ rating: 4.5, reviewCount: 40 }) });
    const n = notesFor(a);
    assert.equal(/healthy/i.test(n.areas.reviews), false, n.areas.reviews);
  });

  test("no pastor-facing text has an em dash or 'holy'", () => {
    for (const a of Object.values(scenarios)) {
      const s = scoreAudit(a);
      const text = allText(findings(s)) + allText(fallbackNotes({ ...a, scores: s }));
      assert.equal(/—/.test(text), false, "em dash");
      assert.equal(/\bholy\b/i.test(text), false, "holy");
    }
  });
});

describe("writeNotes fact sheet for Claude", () => {
  test("system rules and fact sheet use the new fields", async () => {
    const sent = [];
    stubFetch([[/api\.anthropic\.com/, (c) => {
      sent.push(c.json());
      return json({ id: "msg_1", type: "message", role: "assistant", model: "claude", stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 },
        content: [{ type: "text", text: JSON.stringify({ summary: "A new family can find most of what they need.", areas: {}, fixes: [] }) }] });
    }]]);
    const a = audit({
      nearMe: nearMe(7, failed("south")),
      website: website({ socials: { facebook: {}, instagram: {}, vimeo: {} }, sermons: { found: true, sources: ["Vimeo", "Sermons page"] }, youtube: null, vimeo: { daysSinceLastUpload: 4, lastUpload: "2026-10-15T00:00:00Z" } }),
      speed: { ok: true, score: 26, fieldLcpSeconds: 3.1, loadTime: 17.9 },
    });
    await writeNotes({ ...a, scores: scoreAudit(a) }, { ANTHROPIC_API_KEY: "sk-test-not-real" });
    assert.equal(sent.length, 1, "one Claude call");
    const body = sent[0];
    const system = typeof body.system === "string" ? body.system : allText(body.system);
    assert.match(system, /seconds/i, "SYSTEM covers load seconds");
    assert.match(system, /real.visitor/i, "SYSTEM ties seconds to the real-visitor number");
    assert.match(system, /not checked|wasn't checked|was not checked|couldn't check/i, "SYSTEM covers not-checked areas");
    const sheet = allText(body.messages);
    assert.match(sheet, /4 miles north/, "rank wording from the searches");
    assert.match(sheet, /#7|came up 7|rank 7|\b7\b/, "rank number");
    assert.match(sheet, /south[\s\S]{0,160}not.checked|not.checked[\s\S]{0,160}south/i, "the failed search is labeled not checked");
    assert.match(sheet, /Vimeo/, "sermon sources");
    assert.match(sheet, /\b26\b/, "speed score");
    assert.match(sheet, /3\.1/, "field LCP");
    assert.equal(/17\.9/.test(sheet), false, "no lab seconds");
  });

  test("a not-checked website is labeled not checked in the fact sheet", async () => {
    const sent = [];
    stubFetch([[/api\.anthropic\.com/, (c) => { sent.push(c.json()); return json({ id: "m", type: "message", role: "assistant", model: "claude", stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text: JSON.stringify({ summary: "We couldn't check everything this time.", areas: { google: "g", reviews: "r", website: "w", social: "s" }, fixes: [{ title: "Ask your members for Google reviews", why: "x" }] }) }] }); }]]);
    const a = audit({ website: { ok: false, checked: false, reason: "HTTP 403" }, speed: null });
    const n = await writeNotes({ ...a, scores: scoreAudit(a) }, { ANTHROPIC_API_KEY: "sk-test-not-real" });
    assert.ok(n && typeof n.summary === "string", "notes still come back");
    const sheet = allText(sent[0]?.messages);
    assert.match(sheet, /not checked|couldn't check|could not check/i);
    assert.equal(/did not load|is down/i.test(sheet), false);
  });

  test("without a key, writeNotes falls back with no network call", async () => {
    const calls = stubFetch([]);
    const a = audit();
    const n = await writeNotes({ ...a, scores: scoreAudit(a) }, {});
    assert.equal(n.summary, "A new family can find what they need to plan a first visit.");
    assert.equal(calls.length, 0);
  });
});
