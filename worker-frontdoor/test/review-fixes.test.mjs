// Fixes from the live review: every claim a pastor sees must be one the audit observed.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { stubFetch, html, json, xml, churchPage, ytFeed, vimeoFeed, daysAgoIso, daysAgoRfc, fakeEnv, fakeStep } from "./spec-helpers.mjs";
import { checkWebsite, findServiceTimes, siteKey, ownsChannel, youtubeActivity, vimeoActivity } from "../src/website.js";
import { scoreAudit } from "../src/score.js";
import { fallbackNotes } from "../src/write.js";
import { runAudit } from "../src/audit.js";
import worker, { slackText } from "../src/worker.js";
import { fakeGhl, GHL_ENV } from "./ghl-fake.mjs";

const UC = "UCa1b2c3d4e5f6g7h8i9j0kL";
const site = (body, host = "grace.org") => [new RegExp(`^https?://(www\\.)?${host.replace(".", "\\.")}/`), () => html(body)];

describe("website: links that are not what they look like", () => {
  test("'Send us a message', 'Social media' and /message-us are not sermons", async () => {
    stubFetch([site(churchPage({ footer: '<a href="/contact">Send us a message</a><a href="/social">Social media</a><a href="/message-us">Write to us</a><a href="/watch-party">Watch party</a>' }))]);
    const w = await checkWebsite("grace.org");
    assert.equal(w.sermons.found, false, JSON.stringify(w.sermons));
  });

  test("'Messages', 'Watch' and /sermons still are", async () => {
    for (const a of ['<a href="/watch">Messages</a>', '<a href="/media">Watch</a>', '<a href="/sermons/latest">Latest</a>', '<a href="/x">Watch live</a>']) {
      stubFetch([site(churchPage({ footer: a }))]);
      assert.equal((await checkWebsite("grace.org")).sermons.found, true, a);
    }
  });

  test("ages, grades and dates are not service times; 'Sundays 9 & 11' is", () => {
    assert.equal(findServiceTimes("Ages 2 and 3 meet in the nursery during Sunday worship").found, false);
    assert.equal(findServiceTimes("Sunday school for grades 1 & 5 during worship").found, false);
    assert.equal(findServiceTimes("Join us on Sunday, October 5 & 12").found, false);
    assert.equal(findServiceTimes("Sundays 9 & 11").found, true);
    assert.equal(findServiceTimes("Join us Sundays at 9 & 11").found, true);
  });

  test("campus links under /locations count as a link to service times", async () => {
    stubFetch([site(churchPage({ nav: [["/locations/downtown", "Downtown"], ["/locations/north", "North"]], body: "<p>Join us this Sunday at one of our six locations.</p>" }))]);
    const w = await checkWebsite("grace.org");
    assert.deepEqual([w.serviceTimes.found, w.serviceTimes.via], [true, "link"]);
  });

  test("Sunday School, Preschool and Christian Education count for kids", async () => {
    for (const a of ['<a href="/education">Christian Education</a>', '<a href="/school">Preschool</a>', '<a href="/sunday-school">Classes</a>']) {
      stubFetch([site(churchPage({ footer: a }))]);
      assert.equal((await checkWebsite("grace.org")).kids.found, true, a);
    }
  });

  test("a logo link back to the home page at /welcome is not a plan-your-visit link", async () => {
    const page = churchPage({ nav: [["/welcome", "Hill Country Bible Church"], ["/about", "About"], ["/visit-us", "Plan a Visit"]] });
    stubFetch([[/^https?:\/\/(www\.)?hcbc\.org\/?$/, () => new Response(null, { status: 301, headers: { location: "https://hcbc.org/welcome" } })], [/hcbc\.org\/welcome/, () => {
      const r = html(page); Object.defineProperty(r, "url", { value: "https://hcbc.org/welcome" }); return r;
    }]]);
    const w = await checkWebsite("hcbc.org");
    assert.equal(w.planVisit.label, "Plan a Visit");
  });

  test("a shared host compares by the church's own subdomain", () => {
    assert.notEqual(siteKey("grace.wordpress.com"), siteKey("hope.wordpress.com"));
    assert.notEqual(siteKey("grace.squarespace.com"), siteKey("hope.squarespace.com"));
  });
});

describe("website: video activity", () => {
  test("an embedded video from another channel is not the church's account or its recency", async () => {
    stubFetch([
      site(churchPage({ body: '<iframe src="https://www.youtube.com/embed/abcdefghijk"></iframe>' }), "cityreachchurch.com"),
      [/youtube\.com\/watch/, () => html(`<script>{"externalChannelId":"${UC}","ownerChannelName":"Elevation Worship","ownerProfileUrl":"http://www.youtube.com/@ElevationWorship"}</script>`)],
      [/feeds\/videos\.xml/, () => xml(ytFeed([["Song", daysAgoIso(1)]]))],
    ]);
    const w = await checkWebsite("cityreachchurch.com", { name: "City Reach Church" });
    assert.equal(w.socials.youtube, undefined);
    assert.equal(w.youtube.daysSinceLastUpload, null);
    assert.equal(w.youtube.otherChannel, true);
  });

  test("the church's own video counts, matched by name or by handle", async () => {
    assert.equal(ownsChannel({ name: "City Reach Church", site: "https://cityreachchurch.com/" }, ["City Reach Church"]), true);
    assert.equal(ownsChannel({ name: "City Reach Church", site: "https://cityreachchurch.com/" }, ["", "CityReachChurch"]), true);
    assert.equal(ownsChannel({ name: "Grace Bible Church", site: "https://gbcgt.org/" }, ["Grace Bible Church Georgetown TX", "gbcgt"]), true);
    assert.equal(ownsChannel({ name: "City Reach Church", site: "https://cityreachchurch.com/" }, ["Elevation Worship", "ElevationWorship"]), false);
  });

  test("a YouTube feed that fails twice falls back to the channel page's 'ago' text, with no made-up date", async () => {
    stubFetch([
      [/feeds\/videos\.xml/, () => html("Server Error", 500)],
      [/\/videos$/, () => html('<script>{"content":"9h ago"},{"content":"3d ago"}</script>')],
      [/\/streams$/, () => html('<script>{"content":"Streamed 2d ago"}</script>')],
    ]);
    const y = await youtubeActivity({ url: `https://www.youtube.com/channel/${UC}`, kind: "channel", channelId: UC });
    assert.deepEqual([y.checked, y.daysSinceLastUpload, y.lastUpload], [true, 0, null]);
  });

  test("a Vimeo showcase or embed reads its owner's feed through oEmbed", async () => {
    stubFetch([
      [/vimeo\.com\/api\/oembed/, () => json({ author_name: "Grace Bible Church Georgetown TX", author_url: "https://vimeo.com/gbcgt", upload_date: "2026-10-11 12:50:06" })],
      ["https://vimeo.com/gbcgt/videos/rss", () => xml(vimeoFeed([["10/18 sermon", daysAgoRfc(1.2)]]))],
    ]);
    for (const v of [{ url: "https://vimeo.com/showcase/9636988", kind: "showcase", handle: "9636988" }, { url: "https://player.vimeo.com/video/1234835580", kind: "video", handle: "1234835580" }]) {
      const out = await vimeoActivity(v, Date.now(), { name: "Grace Bible Church", site: "https://gbcgt.org/" });
      assert.equal(out.daysSinceLastUpload, 1, v.kind);
    }
  });

  test("a Vimeo embed from someone else is not counted", async () => {
    stubFetch([[/vimeo\.com\/api\/oembed/, () => json({ author_name: "Worship Films", author_url: "https://vimeo.com/worshipfilms" })]]);
    const out = await vimeoActivity({ url: "https://player.vimeo.com/video/1", kind: "video", handle: "1" }, Date.now(), { name: "Grace Bible Church", site: "https://gbcgt.org/" });
    assert.equal(out.otherChannel, true);
    assert.equal(out.daysSinceLastUpload, null);
  });
});

describe("scoring and notes", () => {
  const church = { name: "Grace Bible Church" };
  const website = (x = {}) => ({ checked: true, https: true, viewport: true, serviceTimes: { found: true }, planVisit: { found: true }, kids: { found: true },
    socials: { facebook: {}, instagram: {}, youtube: {} }, sermons: { found: true, sources: ["YouTube"] }, youtube: { daysSinceLastUpload: 3 }, ...x });
  const google = { found: true, trusted: true, hoursListed: true, website: "https://x.org", rating: 4.8, reviewCount: 120 };

  test("unknown upload dates never become a fix or the biggest gap", () => {
    const a = { church, google, nearMe: { checked: true, best: 2, searches: [] }, website: website({ youtube: { daysSinceLastUpload: null } }), speed: { ok: true, score: 92 } };
    const s = scoreAudit(a);
    const n = fallbackNotes({ ...a, scores: s });
    assert.equal(n.summary, "A new family can find what they need to plan a first visit.");
    assert.equal(n.fixes.length, 0);
    assert.equal(/Post each Sunday/.test(JSON.stringify(n)), false);
  });

  test("a stale video account next to the church's own sermons page asks to link that page, not to start posting", () => {
    const s = scoreAudit({ church, website: website({ sermons: { found: true, sources: ["YouTube", "Sermons page"] }, youtube: { daysSinceLastUpload: 240 } }) });
    const f = s.findings.find((x) => x.area === "social" && /240/.test(x.fact));
    assert.equal(f.fact, "The YouTube account linked from your home page last posted 240 days ago.");
    assert.equal(f.fix, "Link the place you post sermons each week");
  });

  test("Social names the only account linked", () => {
    const s = scoreAudit({ church, website: website({ socials: { facebook: {} }, sermons: { found: true, sources: ["Sermons page"] }, youtube: null }) });
    assert.ok(s.findings.some((f) => f.fact === "The home page links to Facebook only. We couldn't find an Instagram link."), JSON.stringify(s.findings));
  });

  test("an A or B area names what works before the gap, and each fix says what it changes for a family", () => {
    const a = { church, google, nearMe: { checked: true, best: 1, searches: [] }, website: website(), speed: { ok: true, score: 39, fieldLcpSeconds: null } };
    const s = scoreAudit(a);
    assert.equal(s.areas.website.grade, "A");
    const n = fallbackNotes({ ...a, scores: s });
    assert.match(n.areas.website, /^The home page has most of what a first-time guest looks for\. Google's phone speed test/);
    assert.equal(n.fixes[0].why, "Families on a phone see your home page sooner.");
    assert.notEqual(n.fixes[0].why, s.findings[0].fact);
  });
});

describe("audit: ZIP-center geocode", () => {
  test("a listing 6 miles from a ZIP center is not held as far away", async () => {
    stubFetch([
      [/geocoding\.geo\.census\.gov/, () => json({ result: { addressMatches: [] } })],
      [/nominatim.*postalcode/, () => json([{ lat: "30.40", lon: "-97.80" }])],
      [/nominatim/, () => json([])],
      [/^https:\/\/places\.googleapis\.com/, (c) => json({ places: c.json().textQuery === "church" ? [] : [{ id: "x", displayName: { text: "Crossroads Church" }, formattedAddress: "15800 Crossroads Dr, Austin, TX 78717, USA", location: { latitude: 30.49, longitude: -97.80 }, rating: 4.8, userRatingCount: 5, websiteUri: "https://crossroadschurchaustin.com/", businessStatus: "OPERATIONAL" }] })],
      [/pagespeedonline/, () => json({ lighthouseResult: { categories: { performance: { score: 0.9 } } } })],
      [/crossroadschurchaustin\.com/, () => html(churchPage({ nav: [["/visit", "Plan a Visit"], ["/kids", "Kids"]], body: "<p>Sundays at 9:00 and 10:30 am</p>" }))],
    ]);
    const r = await runAudit({ name: "Crossroads Church", address: "15800 Crossroads Drive, Austin, TX 78717", website: "crossroadschurchaustin.com" }, { GOOGLE_API_KEY: "k" });
    assert.equal(r.google.milesFromTypedAddress, null);
    assert.equal(r.google.trusted, true);
    assert.equal(r.reviewReasons.some((x) => /miles from the address/.test(x)), false, r.reviewReasons.join(" "));
  });
});

describe("worker: dedup and Slack", () => {
  const ORIGIN = "https://bigsplash.video";
  const BASE = "https://bigsplash-front-door.test.workers.dev";
  const form = (x = {}) => ({ church: "Grace Church", address: "1 Main St, Georgetown, TX 78626", website: "grace.wordpress.com", name: "Pat", email: "pat@grace.example", ...x });
  const post = (e, body) => worker.fetch(new Request(`${BASE}/audit`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(body) }), e, { waitUntil() {} });

  test("a different church on the same shared host, or typing 'none', gets its own audit", async () => {
    const e = fakeEnv();
    const a = await (await post(e, form())).json();
    const b = await (await post(e, form({ church: "Hope Church", website: "hope.wordpress.com", email: "b@hope.example" }))).json();
    assert.notEqual(a.id, b.id);
    const c = await (await post(e, form({ church: "Hope Church", website: "grace.wordpress.com", email: "b@hope.example" }))).json();
    assert.notEqual(c.id, a.id, "same site, different church name");
    const d = await (await post(e, form({ church: "First Church", website: "none" }))).json();
    const f = await (await post(e, form({ church: "Second Church", website: "none" }))).json();
    assert.notEqual(d.id, f.id);
    assert.equal(e.flows.length, 5);
  });

  test("a repeat request from the same church returns the earlier audit and still tells Slack about the contact", async () => {
    const slack = [];
    stubFetch([["https://hooks.slack.test/x", (c) => { slack.push(c.json().text); return new Response("ok"); }]]);
    const e = fakeEnv({ SLACK_WEBHOOK_URL: "https://hooks.slack.test/x" });
    const a = await (await post(e, form({ website: "gracegt.org" }))).json();
    const b = await (await post(e, form({ website: "https://www.gracegt.org/", name: "Sam", email: "sam@grace.example" }))).json();
    assert.equal(b.id, a.id);
    assert.match(slack.join("\n"), /sam@grace\.example/);
  });

  test("missing fields read as a sentence, not field keys", async () => {
    const res = await post(fakeEnv(), form({ address: "" }));
    assert.equal(res.status, 400);
    assert.equal(/Missing: /.test(await res.text()), false);
  });

  test("ready Slack says 'an A', says whether the pastor was emailed, and names the graded site", () => {
    const result = { scores: { overall: { grade: "A" }, areas: { google: { grade: "A" } } }, website: { finalUrl: "https://gbcgt.org/" }, google: { found: true, name: "Grace Bible Church", address: "1 Main" } };
    let t = slackText({ name: "Grace" }, { name: "Pat", email: "p@x" }, result, "ready", "grace-1", "t", "https://w", { emailed: false, texted: false });
    assert.match(t, /got an A/);
    assert.match(t, /The pastor was not emailed\. Send the scorecard link by hand\./);
    assert.match(t, /Website graded: https:\/\/gbcgt\.org\//);
    t = slackText({ name: "Grace" }, { name: "Pat", email: "p@x" }, { ...result, scores: { ...result.scores, overall: { grade: "B" } } }, "ready", "grace-1", "t", "https://w", { emailed: true, texted: true });
    assert.match(t, /got a B/);
    assert.match(t, /Emailed the pastor through GoHighLevel and texted the scorecard\./);
    assert.equal(/Front Door Audit sent/.test(t), false);
  });
});

describe("workflow: no contact means no email", () => {
  test("a contact that never arrives holds the audit instead of sending an empty email", async () => {
    const { FrontDoorAudit } = await import("../src/worker.js");
    const g = fakeGhl();
    stubFetch([g.route, [/./, () => html("", 404)]]);
    const e = fakeEnv({ ...GHL_ENV });
    await e.AUDITS.put("audit:grace-12345678", JSON.stringify({ status: "running", church: { name: "Grace", website: "https://grace.org/" }, reviewToken: "a".repeat(32) }));
    const run = new FrontDoorAudit({}, e);
    // A stub audit result keeps this test about the contact, not the checks.
    const step = fakeStep();
    const real = step.do.bind(step);
    step.do = async (name, a, b) => name === "audit" ? { needsReview: false, reviewReasons: [], scores: { overall: { grade: "A" }, areas: {} } } : real(name, a, b);
    await run.run({ payload: { id: "grace-12345678", church: { name: "Grace" } } }, step);
    assert.equal(JSON.parse(e.AUDITS.m.get("audit:grace-12345678")).status, "review");
    assert.equal(g.sent().length, 0);
  });
});
