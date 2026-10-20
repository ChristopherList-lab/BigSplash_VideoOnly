import { test } from "node:test";
import assert from "node:assert/strict";
import { checkWebsite, findServiceTimes, links, decode, siteKey, sameSite } from "../src/website.js";
import { stubFetch, page, homePage, ytFeed, vimeoFeed, timeoutError, DAY } from "./helpers.mjs";

const iso = (daysAgo) => new Date(Date.now() - daysAgo * DAY).toISOString();

test("fetches like a phone, with a timeout", async () => {
  const calls = stubFetch([["https://a.org/", () => page(homePage("<p>Sunday worship 10:30am</p>"))]]);
  const w = await checkWebsite("a.org");
  assert.equal(w.checked, true);
  const { headers, signal } = calls[0].init;
  assert.match(headers["User-Agent"], /iPhone.*Safari/);
  assert.match(headers["Accept-Language"], /^en-US/);
  assert.ok(signal instanceof AbortSignal);
});

test("a 403 on the typed address falls through to www, then http", async () => {
  stubFetch([
    ["https://a.org/", () => page("Forbidden", 403)],
    ["https://www.a.org/", () => page("", 503)],
    ["http://a.org/", () => page(homePage("<p>Sunday worship 10:30am</p>"), 200, "http://a.org/")],
  ]);
  const w = await checkWebsite("https://a.org");
  assert.equal(w.checked, true);
  assert.equal(w.finalUrl, "http://a.org/");
  assert.equal(w.https, false);
});

test("blocked, challenged or timed out means could not check, never 'down'", async () => {
  stubFetch([[/a\.org/, () => page("nope", 403)]]);
  let w = await checkWebsite("a.org");
  assert.deepEqual([w.ok, w.checked], [false, false]);
  assert.match(w.reason, /403/);

  stubFetch([[/b\.org/, () => page("<html><head><title>Just a moment...</title></head></html>", 503)]]);
  w = await checkWebsite("b.org");
  assert.equal(w.checked, false);
  assert.match(w.reason, /bot check/);

  stubFetch([[/c\.org/, () => page('<meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2F">', 202)]]);
  w = await checkWebsite("c.org");
  assert.match(w.reason, /bot check/);

  stubFetch([[/d\.org/, timeoutError()]]);
  w = await checkWebsite("d.org");
  assert.equal(w.checked, false);
  assert.match(w.reason, /too long/);
});

test("404 or DNS failure on every variant is 'did not load'", async () => {
  stubFetch([[/^https:\/\/gone\.org/, () => page("not found", 404)]]); // http variants fall to ENOTFOUND
  const w = await checkWebsite("gone.org");
  assert.deepEqual([w.ok, w.checked, w.reason], [false, false, "did not load"]);
});

test("a JavaScript shell page is not checked", async () => {
  stubFetch([[/spa\.org/, () => page('<html><body><noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div></body></html>')]]);
  const w = await checkWebsite("spa.org");
  assert.equal(w.checked, false);
  assert.equal(w.reason, "page builds itself with JavaScript");
});

test("follows a meta refresh to the real home page", async () => {
  stubFetch([
    ["https://old.org/", () => page('<html><head><meta http-equiv="refresh" content="0; url=https://new.church/"></head></html>')],
    ["https://new.church/", () => page(homePage('<a href="/plan-your-visit">Plan Your Visit</a>'), 200, "https://new.church/")],
  ]);
  const w = await checkWebsite("old.org");
  assert.equal(w.checked, true);
  assert.equal(w.finalUrl, "https://new.church/");
  assert.equal(w.planVisit.found, true);
});

test("reads plan-visit, kids, times, socials and sermons the way churches write them", async () => {
  const html = homePage(`
    <nav><a href='/i-m-new'>I&#8217;m New</a><a href=/family>Family</a><a href="/#top">Top</a>
    <a href="https://www.youtube.com/gracechurchtx" aria-label="YouTube"><svg></svg></a>
    <a href="https://vimeo.com/gracetx">Vimeo</a><a href="https://www.facebook.com/gracetx#">Facebook</a>
    <a href="https://www.facebook.com/sharer/sharer.php?u=https://grace.org">Share</a></nav>
    <p>Sundays at 9 &amp; 11 in the worship center</p>`, "<meta name=viewport content=width=device-width>");
  stubFetch([
    ["https://grace.org/", () => page(html)],
    ["https://www.youtube.com/gracechurchtx", () => page('<html>"externalId":"UCabcdefghijklmnopqrstuv"</html>')],
    ["https://www.youtube.com/feeds/videos.xml?channel_id=UCabcdefghijklmnopqrstuv", () => page(ytFeed([["Sunday 9am", iso(2.5)], ["Sunday 9am", iso(2.6)], ["Last week", iso(9.5)], ["Old", iso(60.5)]]), 200, null, "application/xml")],
    ["https://vimeo.com/gracetx/videos/rss", () => page(vimeoFeed([["Sermon", new Date(Date.now() - 1.5 * DAY).toUTCString()]]), 200, null, "application/rss+xml")],
  ]);
  const w = await checkWebsite("grace.org");
  assert.equal(w.checked, true);
  assert.equal(w.viewport, true);
  assert.equal(w.planVisit.found, true);
  assert.equal(w.planVisit.label, "I'm New");
  assert.equal(w.kids.found, true);
  assert.equal(w.serviceTimes.found, true);
  assert.match(w.serviceTimes.sample, /Sundays at 9 & 11/);
  assert.deepEqual(Object.keys(w.socials).sort(), ["facebook", "vimeo", "youtube"]);
  assert.equal(w.socials.facebook.handle, "gracetx");
  assert.equal(w.youtube.daysSinceLastUpload, 2);
  assert.equal(w.youtube.uploadsLast30Days, 2); // the duplicate title counts once
  assert.equal(w.vimeo.daysSinceLastUpload, 1);
  assert.deepEqual(w.sermons.sources.sort(), ["Vimeo", "YouTube"]);
  assert.equal(w.source, "typed");
});

test("Vimeo showcase and embedded players: sermons found, recency unknown", async () => {
  stubFetch([["https://gbc.org/", () => page(homePage('<a href="https://vimeo.com/showcase/9636988">Vimeo</a><iframe data-src="https://player.vimeo.com/video/1234835580"></iframe><a href="/media/sermons/">Sermons</a>'))]]);
  const w = await checkWebsite("gbc.org");
  assert.equal(w.sermons.found, true);
  assert.ok(w.sermons.sources.includes("Vimeo") && w.sermons.sources.includes("Sermons page"));
  assert.equal(w.vimeo.daysSinceLastUpload, null);
  assert.equal(w.youtube, null);
});

test("YouTube link shapes all count", async () => {
  const shapes = ["https://m.youtube.com/@grace", "https://youtu.be/abc123", "https://www.youtube.com/watch?v=abc", "https://www.youtube.com/live/abc",
    "https://www.youtube.com/embed/abc", "https://www.youtube.com/playlist?list=PL1", "https://www.youtube.com/embed/live_stream?channel=UCabcdefghijklmnopqrstuv",
    "https://www.youtube.com/c/grace", "https://www.youtube.com/user/grace", "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv", "https://www.youtube.com/saddlebackchurch"];
  for (const href of shapes) {
    stubFetch([["https://y.org/", () => page(homePage(`<a href="${href}">Watch</a>`))], [/youtube\.com/, () => page("", 404)]]);
    const w = await checkWebsite("y.org");
    assert.ok(w.socials.youtube, href);
    assert.equal(w.sermons.found, true, href);
  }
});

test("service times: office hours alone do not count, a times link does", () => {
  assert.equal(findServiceTimes("Office Hours: Mon-Fri 9am-4pm. Closed Sunday.").found, false);
  assert.equal(findServiceTimes("Read John 3:16 with us this Sunday").found, false);
  assert.equal(findServiceTimes("Sundays 9:00 & 10:30").found, true);
  assert.equal(findServiceTimes("Saturday Mass 5:30 PM").found, true);
  const viaLink = findServiceTimes("Welcome home", [{ tag: "a", label: "Times & Locations", href: "https://x.org/locations" }]);
  assert.deepEqual([viaLink.found, viaLink.via], [true, "link"]);
});

test("links keep fragment links, read unquoted hrefs and iframes, decode entities", () => {
  const l = links(`<a href=/visit>Visit</a><a href='/kids#top'>Kids</a><a href="#">x</a><iframe src="//www.youtube.com/embed/x"></iframe><a href="/a?x=1&amp;y=2">a</a>`, "https://c.org/");
  const hrefs = l.map((x) => x.href);
  assert.ok(hrefs.includes("https://c.org/visit"));
  assert.ok(hrefs.includes("https://c.org/kids"));
  assert.ok(hrefs.includes("https://www.youtube.com/embed/x"));
  assert.ok(hrefs.includes("https://c.org/a?x=1&y=2"));
  assert.equal(decode("I&#x27;m &amp; I’m"), "I'm & I'm");
});

test("site keys: registrable domain, or the church's part of a shared host", () => {
  assert.equal(siteKey("https://www.cityreachchurch.com/visit"), "cityreachchurch.com");
  assert.equal(siteKey("kids.church.org.uk"), "church.org.uk");
  assert.equal(sameSite("facebook.com/newhopegtx", "https://m.facebook.com/hopefellowshiptx"), false);
  assert.equal(sameSite("facebook.com/newhopegtx", "https://www.facebook.com/newhopegtx/about"), true);
  assert.equal(sameSite("https://emmaus.churchcenter.com/home", "emmaus.churchcenter.com"), true);
  assert.equal(sameSite("https://sites.google.com/view/a", "https://sites.google.com/view/b"), false);
});
