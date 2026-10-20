// Spec item 1: website.js. Every test answers from fixtures; nothing reaches the network.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  stubFetch, html, xml, redirect, isIphone, churchPage, ytFeed, vimeoFeed, daysAgoIso, daysAgoRfc,
  dnsError, resetError, timeoutError, timeouts,
} from "./spec-helpers.mjs";
import { checkWebsite, normalizeUrl } from "../src/website.js";

const UC = "UCa1b2c3d4e5f6g7h8i9j0kL";
const site = (pageHtml, host = "grace.org") => stubFetch([[new RegExp(`^https?://(www\\.)?${host.replace(/\./g, "\\.")}/`), () => html(pageHtml)]]);
const check = async (pageHtml, host = "grace.org") => { site(pageHtml, host); return checkWebsite(host); };
const notDown = (w) => {
  assert.equal(w.ok, false);
  assert.equal(w.checked, false);
  assert.equal(typeof w.reason, "string");
  assert.ok(w.reason.length > 0);
};

describe("fetching like a phone", () => {
  test("sends an iPhone Safari user agent, en-US and a 15 second timeout", async () => {
    timeouts.length = 0;
    const calls = stubFetch([["https://grace.org/", () => html(churchPage())]]);
    const w = await checkWebsite("grace.org");
    assert.equal(w.checked, true, w.reason);
    assert.equal(w.ok, true);
    const first = calls[0];
    assert.equal(first.url, "https://grace.org/");
    assert.ok(isIphone(first), first.headers.get("user-agent"));
    assert.match(first.headers.get("accept-language") || "", /^en-US/);
    assert.ok(first.signal instanceof AbortSignal, "website fetch has an AbortSignal");
    assert.ok(timeouts.includes(15000), `AbortSignal.timeout values seen: ${timeouts}`);
  });

  test("keeps the renderer's field names and labels the source", async () => {
    stubFetch([["https://grace.org/", () => html(churchPage({ title: "Home | Grace Church" }))]]);
    const w = await checkWebsite("grace.org");
    for (const k of ["ok", "url", "finalUrl", "status", "https", "viewport", "responseMs", "title", "serviceTimes", "planVisit", "kids", "socials", "sermons", "checked", "source"]) {
      assert.ok(k in w, `missing field ${k}`);
    }
    assert.equal(w.status, 200);
    assert.equal(w.https, true);
    assert.equal(w.viewport, true);
    assert.equal(w.title, "Home | Grace Church");
    assert.equal(typeof w.responseMs, "number");
    assert.equal(w.source, "typed");
    stubFetch([["https://grace.org/", () => html(churchPage())]]);
    assert.equal((await checkWebsite("grace.org", { source: "google" })).source, "google");
  });

  test("normalizeUrl turns a bare domain into a fetchable https URL", () => {
    const u = normalizeUrl("cityreachchurch.com");
    assert.match(u, /^https:\/\/(www\.)?cityreachchurch\.com\/?/);
  });

  test("fpcgeorgetown.org style: 403 to bots, 200 to an iPhone, so it is checked and read", async () => {
    const fpc = churchPage({
      title: "First Presbyterian Church Georgetown",
      nav: [["/plan-your-visit/", "Plan Your Visit"], ["/children/", "Children"], ["https://www.facebook.com/fpcgeorgetown", "Facebook"],
        ["https://www.instagram.com/fpcgeorgetown/", "Instagram"], ["https://www.youtube.com/channel/" + UC, "YouTube"]],
      body: "<section><h3>Sunday Worship</h3><p>Traditional 8:30 AM &middot; Contemporary 11:00 AM</p></section>",
    });
    stubFetch([
      [/^https?:\/\/(www\.)?fpcgeorgetown\.org\//, (c) => (isIphone(c) ? html(fpc) : html("<h1>403 Forbidden</h1>", 403))],
      [/feeds\/videos\.xml/, () => xml(ytFeed([["Worship", daysAgoIso(3.2)]]))],
    ]);
    const w = await checkWebsite("fpcgeorgetown.org");
    assert.equal(w.checked, true, w.reason);
    assert.equal(w.serviceTimes.found, true);
    assert.equal(w.planVisit.found, true);
    assert.equal(w.kids.found, true);
    assert.deepEqual(Object.keys(w.socials).sort(), ["facebook", "instagram", "youtube"]);
  });

  test("body read is capped near 2 MB (an endless page still finishes)", async () => {
    let pulled = 0;
    const head = new TextEncoder().encode(churchPage({ nav: [["/visit", "Plan a Visit"]] }).replace("</body>", ""));
    const chunk = new TextEncoder().encode(`<p>${"x".repeat(65530)}</p>`);
    stubFetch([["https://big.org/", () => new Response(new ReadableStream({
      start(ctl) { ctl.enqueue(head); pulled += head.length; },
      pull(ctl) { if (pulled > 40e6) { ctl.error(new Error("read far past the cap")); return; } ctl.enqueue(chunk); pulled += chunk.length; },
    }), { headers: { "content-type": "text/html" } })]]);
    const w = await checkWebsite("big.org");
    assert.equal(w.checked, true, w.reason);
    assert.equal(w.planVisit.found, true);
    assert.ok(pulled < 4e6, `read ${pulled} bytes`);
  });
});

describe("trying the other addresses", () => {
  test("lakepointe.org style: https resets and times out, http redirects to the real site", async () => {
    const calls = stubFetch([
      ["https://lakepointe.org/", resetError()],
      ["https://www.lakepointe.org/", timeoutError()],
      [/^http:\/\/(www\.)?lakepointe\.org\//, () => redirect("https://lakepointe.church/")],
      ["https://lakepointe.church/", () => html(churchPage({ title: "Lakepointe Church" }))],
    ]);
    const w = await checkWebsite("lakepointe.org");
    assert.equal(w.checked, true, w.reason);
    assert.equal(w.finalUrl, "https://lakepointe.church/");
    assert.equal(w.https, true);
    const order = calls.map((c) => c.url);
    assert.ok(order.indexOf("https://www.lakepointe.org/") > order.indexOf("https://lakepointe.org/"), order.join(" "));
  });

  test("a site that only answers on http is checked and https is false", async () => {
    stubFetch([
      [/^https:/, dnsError()],
      [/^http:\/\/(www\.)?oldchurch\.org\//, () => html(churchPage())],
    ]);
    const w = await checkWebsite("https://oldchurch.org/");
    assert.equal(w.checked, true, w.reason);
    assert.match(w.finalUrl, /^http:\/\//);
    assert.equal(w.https, false);
  });

  test("typed www falls back to the bare domain", async () => {
    stubFetch([
      [/^https?:\/\/www\.bare\.org\//, dnsError()],
      ["https://bare.org/", () => html(churchPage())],
    ]);
    const w = await checkWebsite("www.bare.org");
    assert.equal(w.checked, true, w.reason);
    assert.equal(w.finalUrl, "https://bare.org/");
  });
});

describe("could not check is never 'down'", () => {
  for (const status of [401, 403, 429, 503]) {
    test(`HTTP ${status} on every variant is not checked`, async () => {
      stubFetch([[/blocked\.org/, () => html("<html><body>Nope</body></html>", status)]]);
      const w = await checkWebsite("blocked.org");
      notDown(w);
      assert.notEqual(w.reason, "did not load");
    });
  }

  test("Cloudflare 'Just a moment' challenge is not checked", async () => {
    const cf = `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title><meta name="robots" content="noindex,nofollow"></head>
<body><div class="main-wrapper"><h1>www.cfchurch.org</h1><p>Verifying you are human. This may take a few seconds.</p>
<noscript><div>Enable JavaScript and cookies to continue</div></noscript><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script></div></body></html>`;
    stubFetch([[/cfchurch\.org/, () => html(cf, 403, { server: "cloudflare", "cf-mitigated": "challenge" })]]);
    const w = await checkWebsite("cfchurch.org");
    notDown(w);
    assert.notEqual(w.reason, "did not load");
  });

  test("Cloudflare 'Attention Required' served with 200 is not checked", async () => {
    stubFetch([[/attn\.org/, () => html(`<html><head><title>Attention Required! | Cloudflare</title></head><body><h1>Sorry, you have been blocked</h1><p>You are unable to access attn.org</p></body></html>`)]]);
    notDown(await checkWebsite("attn.org"));
  });

  test("SiteGround sgcaptcha page is not checked", async () => {
    stubFetch([[/sgchurch\.org/, () => html(`<html><head><meta http-equiv="refresh" content="0;/.well-known/sgcaptcha/?r=%2F&y=ipc:1.2.3.4:1760000000.000"></head><body></body></html>`, 202)]]);
    const w = await checkWebsite("sgchurch.org");
    notDown(w);
    assert.notEqual(w.reason, "did not load");
  });

  test("'enable JavaScript and cookies' notice with 200 is not checked", async () => {
    stubFetch([[/jsck\.org/, () => html(`<html><head><title>One moment</title></head><body><p>Please enable JavaScript and cookies to continue.</p></body></html>`)]]);
    notDown(await checkWebsite("jsck.org"));
  });

  test("a timeout on every variant is not checked and is not 'did not load'", async () => {
    stubFetch([[/slow\.org/, timeoutError()]]);
    const w = await checkWebsite("slow.org");
    notDown(w);
    assert.notEqual(w.reason, "did not load");
  });

  test("404 on every variant is 'did not load', still not checked", async () => {
    stubFetch([[/gone\.org/, () => html("<h1>Not Found</h1>", 404)]]);
    const w = await checkWebsite("gone.org");
    assert.deepEqual([w.ok, w.checked, w.reason], [false, false, "did not load"]);
  });

  test("410 and DNS failure mixed is 'did not load'", async () => {
    stubFetch([[/^https:\/\/gone2\.org\//, () => html("Gone", 410)]]);
    const w = await checkWebsite("gone2.org");
    assert.deepEqual([w.ok, w.checked, w.reason], [false, false, "did not load"]);
  });

  test("a bogus domain (DNS fails everywhere) is 'did not load'", async () => {
    stubFetch([]);
    const w = await checkWebsite("flcms.invalid");
    assert.deepEqual([w.ok, w.checked, w.reason], [false, false, "did not load"]);
  });
});

describe("pages that build themselves with JavaScript", () => {
  test("Life.Church style 'javascript must be enabled' shell is not checked", async () => {
    const shell = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width"><title>Life.Church</title></head>
<body><noscript><h1>Javascript Disabled</h1><p>For the best experience, javascript must be enabled.</p></noscript><div id="__next"></div>
<script src="/_next/static/chunks/main-abc.js"></script></body></html>`;
    const w = await check(shell, "life.church");
    assert.deepEqual([w.ok, w.checked, w.reason], [false, false, "page builds itself with JavaScript"]);
  });

  test("Church Center style empty root is not checked", async () => {
    const shell = `<!DOCTYPE html><html><head><title>Emmaus Church</title></head><body><div id="root"></div><script src="/packs/js/application-123.js"></script></body></html>`;
    const w = await check(shell, "emmausgtx.churchcenter.com");
    assert.equal(w.checked, false);
    assert.equal(w.reason, "page builds itself with JavaScript");
  });

  test("a page with plenty of text but fewer than 5 links is thin", async () => {
    const p = `<html><head><title>Hope</title></head><body><p>${"We gather to worship together and love our city well. ".repeat(20)}</p><a href="/give">Give</a></body></html>`;
    const w = await check(p, "hope.org");
    assert.equal(w.checked, false);
    assert.equal(w.reason, "page builds itself with JavaScript");
  });

  test("a normal page with a Google Tag Manager noscript iframe is still checked", async () => {
    const p = churchPage({ body: '<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=GTM-ABC123" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>' });
    const w = await check(p, "gtm.org");
    assert.equal(w.checked, true, w.reason);
    assert.equal(w.finalUrl.includes("googletagmanager"), false);
  });
});

describe("redirect pages and frames", () => {
  test("meta refresh is followed", async () => {
    stubFetch([
      [/^https?:\/\/(www\.)?old\.org\//, () => html(`<html><head><meta http-equiv="refresh" content="0; URL='https://new.church/'"></head><body></body></html>`)],
      ["https://new.church/", () => html(churchPage({ nav: [["/plan-your-visit", "Plan Your Visit"]] }))],
    ]);
    const w = await checkWebsite("old.org");
    assert.equal(w.checked, true, w.reason);
    assert.equal(w.finalUrl, "https://new.church/");
    assert.equal(w.planVisit.found, true);
  });

  test("calvarylongview.com style window.location script is followed", async () => {
    stubFetch([
      [/^https?:\/\/(www\.)?calvarylongview\.com\//, () => html(`<html><head><script type="text/javascript">window.location.href = "https://calvarylongview.org/";</script></head><body></body></html>`)],
      ["https://calvarylongview.org/", () => html(churchPage({ nav: [["/kids", "Kids"]] }))],
    ]);
    const w = await checkWebsite("calvarylongview.com");
    assert.equal(w.checked, true, w.reason);
    assert.equal(w.finalUrl, "https://calvarylongview.org/");
    assert.equal(w.kids.found, true);
  });

  test("registrar masking with a full-page frameset is followed", async () => {
    stubFetch([
      [/^https?:\/\/(www\.)?masked\.org\//, () => html(`<html><head><title>Masked Church</title></head><frameset rows="100%,*" border="0"><frame src="https://real-church.org/" frameborder="0"></frameset></html>`)],
      ["https://real-church.org/", () => html(churchPage({ nav: [["/im-new", "I'm New"]] }))],
    ]);
    const w = await checkWebsite("masked.org");
    assert.equal(w.checked, true, w.reason);
    assert.equal(w.planVisit.found, true);
  });

  test("a single full-page iframe is followed", async () => {
    stubFetch([
      [/^https?:\/\/(www\.)?wrapped\.org\//, () => html(`<html><head><title>Wrapped</title></head><body style="margin:0"><iframe src="https://inner-church.org/" style="border:0;width:100%;height:100vh"></iframe></body></html>`)],
      ["https://inner-church.org/", () => html(churchPage({ nav: [["/visit", "Visit"]] }))],
    ]);
    const w = await checkWebsite("wrapped.org");
    assert.equal(w.checked, true, w.reason);
    assert.equal(w.planVisit.found, true);
  });

  test("no more than 2 hops", async () => {
    let hops = 0;
    stubFetch([[/loop\d*\.org/, (c) => { hops++; const n = Number(c.url.match(/loop(\d*)/)[1] || 0) + 1; return html(`<meta http-equiv="refresh" content="0;url=https://loop${n}.org/">`); }]]);
    const w = await checkWebsite("https://loop.org/");
    assert.equal(w.checked, false);
    assert.ok(hops <= 3 * 4, `followed ${hops} pages`);
    assert.equal(/loop[4-9]\.org/.test(w.finalUrl || ""), false);
  });
});

describe("plan your visit", () => {
  const labels = ["Visit", "Plan Your Visit", "Plan a Visit", "Plan Your First Visit", "Plan Your First Sunday", "What to Expect", "Start Here", "New Here?", "New to Saddleback?",
    "I'm New", "Im New", "I&#8217;m New", "I&#x27;m New", "I&#39;m New", "I’m New", "First Time?", "Your First Visit", "Guests", "Welcome"];
  for (const label of labels) {
    test(`link text "${label}" counts`, async () => {
      const w = await check(churchPage({ nav: [["/connect-card", label]] }));
      assert.equal(w.planVisit.found, true, label);
      assert.equal(/&#|’/.test(w.planVisit.label || ""), false, `label not decoded: ${w.planVisit.label}`);
    });
  }

  for (const path of ["/visit", "/plan", "/plan-your-visit/", "/new", "/im-new", "/i-m-new", "/new-here", "/start-here", "/what-to-expect", "/welcome", "/first-time", "/guests"]) {
    test(`path ${path} counts even with plain link text`, async () => {
      const w = await check(churchPage({ nav: [[path, "Learn More"]] }));
      assert.equal(w.planVisit.found, true, path);
    });
  }

  test("'/#plan-your-visit' fragment link and an unquoted href both count", async () => {
    let w = await check(churchPage({ nav: [["/#plan-your-visit", "Plan Your Visit"]] }));
    assert.equal(w.planVisit.found, true, "fragment link dropped");
    site(churchPage().replace("</main>", '<p><a class=btn href=/im-new>Get started</a></p></main>'));
    w = await checkWebsite("grace.org");
    assert.equal(w.planVisit.found, true, "unquoted href missed");
  });

  test("single-quoted href and the I&#8217;m New label as WordPress writes it", async () => {
    const p = churchPage().replace("</main>", "<a href='/i-m-new/' class='button'>I&#8217;m New</a></main>");
    const w = await check(p);
    assert.equal(w.planVisit.found, true);
    assert.equal(w.planVisit.label, "I'm New");
    assert.match(w.planVisit.href, /^https:\/\/grace\.org\/i-m-new\/?$/);
  });

  test("a 'Welcome' heading is not a link; /news is not /new", async () => {
    const w = await check(churchPage({ nav: [["/news", "News"], ["/connect", "Connect"]], body: "<h1>Welcome to Grace Church</h1><h2>Welcome home</h2>" }));
    assert.equal(w.planVisit.found, false);
  });
});

describe("kids", () => {
  for (const label of ["Kids", "Kid's Ministry", "Kidz", "Children's Ministry", "Children", "Family", "Families", "Next Gen", "NextGen", "Little Ones", "Elementary", "Nursery", "Students", "Youth"]) {
    test(`"${label}" link counts`, async () => {
      const w = await check(churchPage({ nav: [["/ministry-a", label]] }));
      assert.equal(w.kids.found, true, label);
    });
  }

  test("Hill Country Bible style 'Family' link at /family", async () => {
    const w = await check(churchPage({ nav: [["https://hcbc.com/family", "Family"]] }), "hcbc.com");
    assert.equal(w.kids.found, true);
    assert.match(w.kids.href, /\/family/);
  });

  test("a kids path with plain text counts, and no kids link is not found", async () => {
    let w = await check(churchPage({ nav: [["/nextgen/", "Ministries"]] }));
    assert.equal(w.kids.found, true);
    w = await check(churchPage());
    assert.equal(w.kids.found, false);
  });
});

describe("service times", () => {
  const found = [
    "<p>Sundays 9:00 &amp; 10:30</p>",
    "<p>Join us Sundays at 9 &amp; 11</p>",
    "<p>Saturday Mass 5:30 PM &middot; Sunday Mass 8, 10 &amp; 12</p>",
    "<div>SERVICE TIMES SUNDAY | 8:15AM &amp; 10AM &amp; 11:45AM</div>",
    "<h3>Worship Gatherings</h3><p>9:30am and 11:00am</p>",
    "<p>Our Celebration service begins at 10:45 a.m.</p>",
  ];
  for (const body of found) {
    test(`found: ${body.replace(/<[^>]+>/g, "")}`, async () => {
      const w = await check(churchPage({ body: `<section>${body}</section>` }));
      assert.equal(w.serviceTimes.found, true);
      assert.equal(typeof w.serviceTimes.sample, "string");
      assert.equal(/&amp;|&middot;/.test(w.serviceTimes.sample), false, `sample not decoded: ${w.serviceTimes.sample}`);
    });
  }

  test("sample keeps the decoded text", async () => {
    const w = await check(churchPage({ body: "<p>Join us Sundays at 9 &amp; 11</p>" }));
    assert.match(w.serviceTimes.sample, /9 & 11/);
  });

  test("hcbc.com style office hours alone do not count", async () => {
    let w = await check(churchPage({ footer: "<p>Office Hours Mon, Tues, Thurs: 8:30 AM - 4:30 PM | Fri: 8:30 AM - 12:00 PM</p>" }), "hcbc.com");
    assert.equal(w.serviceTimes.found, false, w.serviceTimes.sample);
    w = await check(churchPage({ footer: "<p>Office Hours: Monday - Thursday, 9:00 AM - 4:00 PM. Closed Saturday and Sunday.</p>" }), "hcbc.com");
    assert.equal(w.serviceTimes.found, false, w.serviceTimes.sample);
  });

  for (const label of ["Locations &amp; Times", "Times &amp; Locations", "Service Times", "Times", "Gatherings", "When We Meet", "Locations"]) {
    test(`multi-campus link "${label}" counts via link`, async () => {
      const w = await check(churchPage({ nav: [["/locations", label]] }), "austinstone.org");
      assert.equal(w.serviceTimes.found, true);
      assert.equal(w.serviceTimes.via, "link");
    });
  }
});

describe("social accounts", () => {
  test("all five networks, ignoring share links, with the Facebook handle", async () => {
    const w = await check(churchPage({
      footer: `<a href="https://www.facebook.com/gracetx/" aria-label="Facebook"><svg></svg></a>
        <a href="https://instagram.com/gracetx">Instagram</a>
        <a href="https://www.youtube.com/channel/${UC}">YouTube</a>
        <a href="https://www.tiktok.com/@gracetx">TikTok</a>
        <a href="https://vimeo.com/gracetx">Vimeo</a>
        <a href="https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fgrace.org">Share</a>
        <a href="https://twitter.com/intent/tweet?url=https%3A%2F%2Fgrace.org">Tweet</a>`,
    }));
    assert.deepEqual(Object.keys(w.socials).sort(), ["facebook", "instagram", "tiktok", "vimeo", "youtube"]);
    assert.equal(w.socials.facebook.handle, "gracetx");
    assert.match(w.socials.facebook.url, /facebook\.com\/gracetx/);
  });

  test("a share button alone is not a Facebook account", async () => {
    const w = await check(churchPage({ footer: '<a href="https://www.facebook.com/sharer.php?u=https://grace.org/">Share on Facebook</a><a href="https://www.facebook.com/dialog/share?app_id=1">Share</a>' }));
    assert.equal("facebook" in w.socials, false);
  });

  const ytShapes = [
    `https://www.youtube.com/channel/${UC}`, "https://www.youtube.com/c/GraceChurchTX", "https://www.youtube.com/user/gracechurchtx", "https://www.youtube.com/@gracetx",
    "https://www.youtube.com/saddlebackchurch", "https://m.youtube.com/@gracetx", "https://youtu.be/dQw4w9WgXcQ", "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://www.youtube.com/live/dQw4w9WgXcQ", "https://www.youtube.com/embed/dQw4w9WgXcQ", "https://www.youtube.com/playlist?list=PLabc123",
    `https://www.youtube.com/embed/live_stream?channel=${UC}`,
  ];
  for (const href of ytShapes) {
    test(`YouTube link ${href} counts as YouTube and as sermons`, async () => {
      stubFetch([
        [/^https?:\/\/(www\.)?yt\.org\//, () => html(churchPage({ footer: `<a href="${href}">YouTube</a>` }))],
        [/youtube\.com|youtu\.be/, () => html("<html></html>", 404)],
      ]);
      const w = await checkWebsite("yt.org");
      assert.ok(w.socials.youtube, href);
      assert.equal(w.sermons.found, true, href);
    });
  }

  test("a YouTube iframe embed counts", async () => {
    stubFetch([
      [/^https?:\/\/(www\.)?yt\.org\//, () => html(churchPage({ body: '<iframe width="560" height="315" src="https://www.youtube.com/embed/dQw4w9WgXcQ" allowfullscreen></iframe>' }))],
      [/youtube\.com/, () => html("", 404)],
    ]);
    const w = await checkWebsite("yt.org");
    assert.equal(w.sermons.found, true);
  });

  for (const href of ["https://vimeo.com/gracetx", "https://vimeo.com/showcase/9636988", "https://player.vimeo.com/video/1234835580"]) {
    test(`Vimeo link ${href} counts`, async () => {
      stubFetch([[/^https?:\/\/(www\.)?vm\.org\//, () => html(churchPage({ footer: `<a href="${href}">Vimeo</a>` }))], [/vimeo\.com/, () => html("", 404)]]);
      const w = await checkWebsite("vm.org");
      assert.ok(w.socials.vimeo, href);
      assert.equal(w.sermons.found, true);
    });
  }
});

describe("sermons", () => {
  test("Grace Bible style: Vimeo iframe embed, no YouTube, still sermons", async () => {
    stubFetch([[/^https?:\/\/(www\.)?gbcgt\.org\//, () => html(churchPage({ body: '<section class="latest"><h2>Latest</h2><iframe src="https://player.vimeo.com/video/1234835580?h=abc&amp;badge=0" allow="autoplay; fullscreen"></iframe></section>' }))], [/vimeo\.com/, () => html("", 404)]]);
    const w = await checkWebsite("gbcgt.org");
    assert.equal(w.sermons.found, true);
    assert.ok(Array.isArray(w.sermons.sources) && w.sermons.sources.length > 0);
    assert.equal(w.socials.youtube, undefined);
  });

  const triggers = [
    ["Facebook videos", '<a href="https://www.facebook.com/gracetx/videos">Videos</a>'],
    ["Facebook live", '<a href="https://www.facebook.com/gracetx/live">Facebook</a>'],
    ["Subsplash", '<a href="https://subsplash.com/gracechurch/lb/mi/+abc123">App</a>'],
    ["BoxCast", '<iframe src="https://boxcast.tv/view-embed/abc123"></iframe>'],
    ["online.church", '<a href="https://grace.online.church/">Church Online</a>'],
    ["Livestream", '<a href="https://livestream.com/gracechurch">Stream</a>'],
    ["Sermons text", '<a href="/resources">Sermons</a>'],
    ["Messages text", '<a href="/resources">Messages</a>'],
    ["Watch text", '<a href="/resources">Watch</a>'],
    ["Media text", '<a href="/resources">Media</a>'],
    ["Podcast path", '<a href="/podcast/">Subscribe</a>'],
    ["Listen text", '<a href="/resources">Listen</a>'],
    ["Live path", '<a href="/live-stream/">Join us</a>'],
    ["sermons path", '<a href="/media/sermons/">Recent</a>'],
  ];
  for (const [name, link] of triggers) {
    test(`${name} counts as sermons`, async () => {
      const w = await check(churchPage({ body: `<section>${link}</section>` }));
      assert.equal(w.sermons.found, true, name);
      assert.ok(w.sermons.sources.length > 0);
    });
  }

  test("no sermon link at all is not found", async () => {
    const w = await check(churchPage());
    assert.equal(w.sermons.found, false);
    assert.deepEqual(w.sermons.sources, []);
  });
});

describe("YouTube and Vimeo activity", () => {
  const feed = ytFeed([["Sunday Service 10/12", daysAgoIso(3.2)], ["Sunday Service 10/12", daysAgoIso(3.3)], ["Sunday Service 10/5", daysAgoIso(10.2)], ["Summer Series", daysAgoIso(45)]]);

  test("channel link: feed read, last upload as ISO, duplicate titles counted once, timeouts set", async () => {
    timeouts.length = 0;
    const calls = stubFetch([
      [/^https?:\/\/(www\.)?grace\.org\//, () => html(churchPage({ footer: `<a href="https://www.youtube.com/channel/${UC}">YouTube</a>` }))],
      [new RegExp(`feeds/videos\\.xml\\?channel_id=${UC}`), () => xml(feed)],
    ]);
    const w = await checkWebsite("grace.org");
    assert.equal(w.youtube.daysSinceLastUpload, 3);
    assert.ok(!Number.isNaN(Date.parse(w.youtube.lastUpload)));
    assert.match(w.youtube.lastUpload, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(w.youtube.uploadsLast30Days, 2);
    assert.ok(calls.every((c) => c.signal instanceof AbortSignal), "every fetch carries a timeout signal");
  });

  for (const [label, href, pageRe] of [
    ["legacy vanity", "https://www.youtube.com/saddlebackchurch", /youtube\.com\/saddlebackchurch/],
    ["handle", "https://www.youtube.com/@gracetx", /youtube\.com\/@gracetx/],
    ["/c/ link", "https://www.youtube.com/c/GraceChurchTX", /youtube\.com\/c\/GraceChurchTX/],
    ["/user/ link", "https://www.youtube.com/user/gracechurchtx", /youtube\.com\/user\/gracechurchtx/],
  ]) {
    test(`${label}: channel id read from the channel page`, async () => {
      const channelPage = `<html><head><link rel="canonical" href="https://www.youtube.com/channel/${UC}"><meta itemprop="channelId" content="${UC}"></head>
<body><script>var ytInitialData = {"metadata":{"channelMetadataRenderer":{"externalId":"${UC}","title":"Grace"}}};</script></body></html>`;
      stubFetch([
        [/^https?:\/\/(www\.)?grace\.org\//, () => html(churchPage({ footer: `<a href="${href}">YouTube</a>` }))],
        [pageRe, () => html(channelPage)],
        [new RegExp(`feeds/videos\\.xml\\?channel_id=${UC}`), () => xml(feed)],
      ]);
      const w = await checkWebsite("grace.org");
      assert.equal(w.youtube?.daysSinceLastUpload, 3);
    });
  }

  test("playlist link uses the playlist feed", async () => {
    stubFetch([
      [/^https?:\/\/(www\.)?grace\.org\//, () => html(churchPage({ footer: '<a href="https://www.youtube.com/playlist?list=PLsermons2026">Sermons</a>' }))],
      [/feeds\/videos\.xml\?playlist_id=PLsermons2026/, () => xml(feed)],
    ]);
    const w = await checkWebsite("grace.org");
    assert.equal(w.youtube?.daysSinceLastUpload, 3);
  });

  test("Vimeo user: RSS gives the last upload", async () => {
    stubFetch([
      [/^https?:\/\/(www\.)?grace\.org\//, () => html(churchPage({ footer: '<a href="https://vimeo.com/gracetx">Vimeo</a>' }))],
      ["https://vimeo.com/gracetx/videos/rss", () => xml(vimeoFeed([["Sunday 10/16", daysAgoRfc(1.2)], ["Sunday 10/9", daysAgoRfc(8.2)]]))],
    ]);
    const w = await checkWebsite("grace.org");
    assert.equal(w.vimeo.daysSinceLastUpload, 1);
    assert.ok(!Number.isNaN(Date.parse(w.vimeo.lastUpload)));
  });

  test("Vimeo showcase or player only: recency unknown, never zero", async () => {
    stubFetch([
      [/^https?:\/\/(www\.)?gbcgt\.org\//, () => html(churchPage({ footer: '<a href="https://vimeo.com/showcase/9636988">Vimeo</a><iframe src="https://player.vimeo.com/video/1234835580"></iframe>' }))],
      [/vimeo\.com/, () => xml(vimeoFeed([["x", daysAgoRfc(0.1)]]))],
    ]);
    const w = await checkWebsite("gbcgt.org");
    assert.ok(w.vimeo == null || w.vimeo.daysSinceLastUpload == null, JSON.stringify(w.vimeo));
  });

  test("a YouTube feed that fails leaves recency unknown, not stale", async () => {
    stubFetch([
      [/^https?:\/\/(www\.)?grace\.org\//, () => html(churchPage({ footer: `<a href="https://www.youtube.com/channel/${UC}">YouTube</a>` }))],
      [/feeds\/videos\.xml/, () => html("Server Error", 500)],
    ]);
    const w = await checkWebsite("grace.org");
    assert.ok(w.youtube == null || w.youtube.daysSinceLastUpload == null, JSON.stringify(w.youtube));
    assert.equal(w.sermons.found, true);
  });
});

describe("markup quirks", () => {
  test("viewport with unquoted attributes counts", async () => {
    const w = await check(churchPage({ head: "<meta name=viewport content=width=device-width,initial-scale=1>" }));
    assert.equal(w.viewport, true);
  });

  test("no viewport is false", async () => {
    const w = await check(churchPage({ head: "" }));
    assert.equal(w.viewport, false);
  });
});
