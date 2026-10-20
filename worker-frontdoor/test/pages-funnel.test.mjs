// The funnel pages: the ad landing form (attendance, text consent, Lead tracking), the scorecard's
// walkthrough link, the walkthrough page's minutes, the church page's move to the audit, and the old thanks page.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ROOT = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), "utf8");
const landing = read("frontdoor/index.html");
const scorecard = read("front-door/index.html");
const walkthrough = read("frontdoor/walkthrough/index.html");
const church = read("church/index.html");
const thanks = read("church/thanks/index.html");
const intake = read("js/intake.js");

const inlineScripts = (page) => [...page.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n;\n");
const visible = (page) => page.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<!--[\s\S]*?-->/g, "");
const unescape = (s) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// The shared Meta Pixel and GA4 block, whitespace-normalized, from window.BS_TRACK to the end of its IIFE.
const pixelBlock = (page) => {
  const m = page.match(/window\.BS_TRACK = \{[\s\S]*?\}\)\(window\.BS_TRACK\);/);
  return m ? m[0].replace(/\s+/g, " ") : null;
};

import { runLanding } from "./landing-dom.mjs";

const filled = { church: "Grace Bible Church", address: "1 Main St, Georgetown, TX 78626", website: "gracebible.org", attendance: "100 to 249",
  name: "Sam Lee", role: "Lead pastor", email: "sam@gracebible.org", phone: "", facebook_frequency: "About once a week" };

describe("landing page form", () => {
  test("attendance select: required, blank disabled 'Choose one' first, then the five sizes", () => {
    const sel = landing.match(/<select([^>]*name="attendance"[^>]*)>([\s\S]*?)<\/select>/);
    assert.ok(sel, "attendance select");
    assert.match(sel[1], /\brequired\b/);
    const label = landing.match(/<label for="attendance">([^<]*)<\/label>/);
    assert.equal(label?.[1], "About how many people on a Sunday?");
    const opts = [...sel[2].matchAll(/<option([^>]*)>([^<]*)<\/option>/g)];
    assert.match(opts[0][1], /value=""/);
    assert.match(opts[0][1], /\bdisabled\b/);
    assert.match(opts[0][1], /\bselected\b/);
    assert.equal(opts[0][2], "Choose one");
    assert.deepEqual(opts.slice(1).map((o) => o[2]), ["Under 100", "100 to 249", "250 to 499", "500 to 999", "1,000+"]);
  });

  test("sms_consent checkbox: unchecked, value yes, the exact label, right under the phone field", () => {
    const box = landing.match(/<input[^>]*name="sms_consent"[^>]*>/);
    assert.ok(box, "sms_consent input");
    assert.match(box[0], /type="checkbox"/);
    assert.match(box[0], /value="yes"/);
    assert.equal(/\bchecked\b/.test(box[0]), false);
    assert.ok(landing.includes('Text me my scorecard. Big Splash will send up to 2 texts about my audit. Msg and data rates may apply. Reply HELP for help or STOP to opt out. <a href="/privacy/" style="color:inherit">Privacy policy</a>'));
    const phoneAt = landing.search(/<input[^>]*name="phone"/);
    const boxAt = landing.search(/<input[^>]*name="sms_consent"/);
    const between = landing.slice(phoneAt, boxAt);
    assert.ok(phoneAt > 0 && boxAt > phoneAt, "box after phone");
    assert.equal(/<input|<select/.test(between.replace(/^<input[^>]*>/, "")), false, "nothing between phone and the box");
  });

  test("unchecked: the payload has no sms_consent and the phone stays optional", async () => {
    const page = runLanding({ fields: filled });
    await page.submit();
    assert.equal(page.posts.length, 1, page.err.textContent);
    const body = page.posts[0].body;
    assert.match(page.posts[0].url, /\/audit$/);
    assert.equal("sms_consent" in body, false);
    assert.equal(body.attendance, "100 to 249");
    assert.equal(body.utm, "utm_source=facebook&utm_campaign=oct30");
    assert.equal(page.elements.phone.required, false);
  });

  test("checked: the phone becomes required, and the payload carries sms_consent 'yes'", async () => {
    const page = runLanding({ fields: { ...filled, phone: "512-555-0142" } });
    page.toggleConsent(true);
    assert.equal(page.elements.phone.required, true);
    assert.match(page.hint.textContent, /texts/);
    await page.submit();
    assert.equal(page.posts.length, 1, page.err.textContent);
    assert.equal(page.posts[0].body.sms_consent, "yes");
    assert.equal(page.posts[0].body.phone, "512-555-0142");
    page.toggleConsent(false);
    assert.equal(page.elements.phone.required, false);
    assert.equal(page.hint.textContent, "(optional)");
  });

  test("checked with no usable phone: nothing is sent and the pastor is told why", async () => {
    for (const phone of ["", "555-01"]) {
      const page = runLanding({ fields: { ...filled, phone, sms_consent: true } });
      page.toggleConsent(true);
      await page.submit();
      assert.equal(page.posts.length, 0);
      assert.match(page.err.textContent, /cell number/);
      assert.equal(page.elements.phone.focused, 1);
    }
  });

  test("no attendance: nothing is sent", async () => {
    const page = runLanding({ fields: { ...filled, attendance: "" } });
    await page.submit();
    assert.equal(page.posts.length, 0);
    assert.match(page.err.textContent, /Sunday/);
  });

  test("a started audit fires Meta Lead with the audit id as eventID and GA4 generate_lead, once", async () => {
    const page = runLanding({ fields: filled });
    await page.submit();
    // The calls come from another vm realm, so compare them as JSON.
    assert.equal(JSON.stringify(page.fbq), JSON.stringify([["track", "Lead", { content_name: "Front Door Audit" }, { eventID: "grace-bible-church-1a2b3c4d" }]]));
    assert.equal(JSON.stringify(page.gtag), JSON.stringify([["event", "generate_lead"]]));
    await page.submit(); // a second submit cannot double count
    assert.equal(page.fbq.length, 1);
    assert.equal(page.gtag.length, 1);
  });

  test("no Lead when the audit does not start", async () => {
    const quiet = runLanding({ fields: filled, response: { ok: true, id: "received" } });
    await quiet.submit();
    assert.equal(quiet.fbq.length + quiet.gtag.length, 0);
    const failed = runLanding({ fields: filled, response: { ok: false, error: "Something went wrong" } });
    await failed.submit();
    assert.equal(failed.fbq.length + failed.gtag.length, 0);
  });
});

describe("tracking blocks", () => {
  test("landing, scorecard and walkthrough use the church page's Pixel and GA4 block, with empty IDs", () => {
    const base = pixelBlock(church);
    assert.ok(base, "church block");
    assert.match(base, /META_PIXEL_ID: '', GA4_ID: ''/);
    for (const [name, page] of [["landing", landing], ["scorecard", scorecard], ["walkthrough", walkthrough]]) {
      assert.equal(pixelBlock(page), base, name);
    }
  });

  test("the scorecard sends PageView only; the walkthrough keeps its Schedule event", () => {
    const js = inlineScripts(scorecard);
    assert.equal(/'Lead'|"Lead"|generate_lead|Schedule/.test(js), false);
    assert.match(inlineScripts(walkthrough), /fbq\("track", "Schedule"/);
  });
});

// ---------- Scorecard ----------
async function renderScorecard({ data, search = "", result } = {}) {
  const els = {};
  const el = (id) => (els[id] ||= { innerHTML: "", textContent: "", style: {} });
  const context = {
    window: { FRONT_DOOR_DATA: data },
    document: { getElementById: el, title: "" },
    location: { search, href: "https://bigsplash.video/front-door/" + search },
    fetch: async () => new Response(JSON.stringify(result ?? {}), { status: result ? 200 : 404 }),
    URLSearchParams, URL, Response, Date, Intl, Number, String, JSON, Math, Object, Array, Promise, console, setTimeout, clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(inlineScripts(scorecard), context);
  await new Promise((r) => setTimeout(r, 30));
  return el("app").innerHTML;
}

const audit = {
  church: { name: "Grace Bible Church" }, checkedAt: "2026-10-19T18:00:00.000Z",
  scores: { overall: { grade: "B" }, areas: { google: { grade: "B" }, reviews: { grade: "A" }, website: { grade: "C" }, social: { grade: "B" } } },
  notes: { summary: "Summary.", areas: {}, fixes: [{ title: "Add a Plan Your Visit page", why: "Families look for it." }] },
  google: { found: true, rating: 4.6, reviewCount: 80, hoursListed: true, website: "https://gracebible.org/" },
  website: { checked: true, serviceTimes: { found: true }, planVisit: { found: false }, kids: { found: true }, socials: {} },
  speed: { ok: true, score: 60 }, reach: null,
};
// Until VIDEO_LIVE is true the button books the call; it never promises a video that is not there.
const ctaHref = (html) => unescape((html.match(/<a class="btn" href="([^"]*)">Book a call with our team<\/a>/) || [])[1] ?? "");

describe("scorecard call to action", () => {
  const T = "b".repeat(32);

  test("sends the pastor to the walkthrough page with the audit id and token", async () => {
    const html = await renderScorecard({ search: `?id=grace-bible-church-1a2b3c4d&t=${T}`, result: audit });
    assert.equal(ctaHref(html), `/frontdoor/walkthrough/?id=grace-bible-church-1a2b3c4d&t=${T}`);
    assert.match(html, /Next: go over it with our team/);
    assert.match(html, /A free 30-minute call\. Our team goes over every grade with you\./);
    assert.equal(/short video|3-minute/.test(html), false);
  });

  test("no token, a bad token, or no id at all", async () => {
    let html = await renderScorecard({ search: "?id=grace-bible-church-1a2b3c4d", result: audit });
    assert.equal(ctaHref(html), "/frontdoor/walkthrough/?id=grace-bible-church-1a2b3c4d");
    html = await renderScorecard({ search: "?id=grace-bible-church-1a2b3c4d&t=<x>", result: audit });
    assert.equal(ctaHref(html), "/frontdoor/walkthrough/?id=grace-bible-church-1a2b3c4d");
    html = await renderScorecard({ data: audit });
    assert.equal(ctaHref(html), "/frontdoor/walkthrough/");
  });

  test("the call is 30 minutes everywhere on the page, and the old booking link is gone", () => {
    assert.equal(/20-minute|20 minute/.test(scorecard), false);
    assert.match(scorecard, /30-minute/);
    assert.equal(/leadconnectorhq|Book your walkthrough|target="_blank"/.test(scorecard), false);
  });
});

describe("walkthrough page", () => {
  test("every call length says 30 minutes; only the video runs 3", () => {
    const text = walkthrough.replace(/<!--[\s\S]*?-->/g, "");
    const mentions = [...text.matchAll(/(\d+)(?:[- ]free)?[- ]minutes?\b/gi)].map((m) => [m[1], text.slice(Math.max(0, m.index - 60), m.index + 20)]);
    assert.ok(mentions.length >= 5, "found the minute mentions");
    for (const [n, around] of mentions) {
      if (n === "3") assert.match(around, /About 3 minutes|scorecard in 3 minutes/, around);
      else assert.equal(n, "30", around);
    }
    assert.equal(/\b20[- ]minute/.test(walkthrough), false);
  });

  test("every booking label reads 'Book a call with our team' and the call is with the team", () => {
    const text = visible(walkthrough);
    assert.match(walkthrough, /<a class="btn" href="#book" id="top-cta">Book a call with our team<\/a>/);
    assert.match(walkthrough, /<div class="sticky"[^>]*><a class="btn" href="#book" tabindex="-1">Book a call with our team<\/a><\/div>/);
    assert.match(walkthrough, /<h1 id="headline">Go over your scorecard with our team\.<\/h1>/);
    assert.match(walkthrough, /<title>Book a call with our team · Big Splash<\/title>/);
    assert.match(walkthrough, /f\.title = "Book a call with our team";/);
    assert.match(walkthrough, /document\.title = `\$\{name\} · Book a call with our team · Big Splash`;/);
    assert.match(text, /Meet the Big Splash team/);
    assert.match(text, /Chris List, a filmmaker, founded it and built the Front Door Audit\./);
    assert.equal(/Book my|walkthrough|with Chris|Talk to Chris|You'll talk to/i.test(text.replace(/https?:\/\/\S+/g, "")), false, "no old booking wording on the page");
    assert.equal(/with Chris|walkthrough/i.test(walkthrough.match(/<meta name="description"[^>]*>/)[0] + walkthrough.match(/<meta property="og:title"[^>]*>/)[0] + walkthrough.match(/<meta property="og:description"[^>]*>/)[0]), false);
    assert.match(inlineScripts(walkthrough), /gtag\("event", "book_walkthrough"/, "analytics names stay");
  });
});

// ---------- Church page ----------
describe("church page", () => {
  const AUDIT = "/frontdoor/?utm_source=church_page";
  const founderAt = church.indexOf("<!-- ========== FOUNDER");
  const founderEnd = church.indexOf("</section>", founderAt);
  const withoutFounder = church.slice(0, founderAt) + church.slice(founderEnd);

  test("the Snapshot offer is gone", () => {
    assert.equal(/snapshot/i.test(church), false);
    assert.equal(/SNAPSHOT_API_URL|TURNAROUND_HOURS/.test(church), false);
    assert.equal(/72 hours|72-hour/i.test(church), false);
    assert.equal(/\b(3|three) (captioned )?(sermon )?clips|thumbnail|\bloom\b|send (us )?(one|your) sermon/i.test(church), false);
    assert.equal(/sermon clips/i.test(withoutFounder), false, "only the founder bio may mention sermon clips");
    assert.equal(/<form\b/.test(church), false);
    assert.equal(/href="#snapshot"/.test(church), false);
  });

  test("every offer button links to the audit with the church_page source", () => {
    const links = [...church.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*data-cta="([^"]+)"[^>]*>/g)].map((m) => [m[2], m[1]]);
    const ctas = Object.fromEntries(links);
    for (const where of ["nav", "hero", "audit-section", "price-monthly", "christmas-audit", "founder", "final", "mobile-sticky"]) {
      assert.equal(ctas[where], AUDIT, where);
    }
    const sticky = church.match(/<div id="mobile-cta"[\s\S]*?<\/div>/)[0];
    assert.ok(sticky.includes(`href="${AUDIT}"`), "the phone bar goes to the audit");
  });

  test("every button that opens the contact modal reads 'Book a call with our team'", () => {
    const labels = [...church.matchAll(/<button\b[^>]*data-open-intake[^>]*>([^<]*)<\/button>/g)].map((m) => m[1].trim());
    assert.ok(labels.length >= 5, String(labels.length));
    for (const l of labels) assert.equal(l, "Book a call with our team");
    const text = visible(church);
    assert.equal(/Talk to Chris|Message Chris|call with Chris|message Chris/.test(text), false);
    assert.match(text, /you can book a free 30-minute call with our team afterward\./);
  });

  test("one Front Door Audit section: the four areas, the sample scorecard, the button and the promise", () => {
    const sections = church.match(/<section id="audit"[\s\S]*?<\/section>/g) || [];
    assert.equal(sections.length, 1);
    const s = sections[0];
    for (const area of ["Google search", "Reviews", "Website on a phone", "Social and sermons"]) assert.ok(s.includes(area), area);
    assert.match(s, /<img[^>]*src="\/frontdoor\/sample-scorecard\.jpg"/);
    assert.ok(s.includes(`href="${AUDIT}"`));
    assert.ok(s.includes("Most scorecards are ready in a few minutes. Free, no call needed."));
  });

  test("pricing, films, founder and Christmas stay; the light theme stays", () => {
    for (const keep of ["$1,497", "$1,997", "Custom quote", 'id="films"', 'id="christmas"', "<!-- ========== FOUNDER", 'id="levels"', 'id="faq"']) {
      assert.ok(church.includes(keep), keep);
    }
    assert.match(church, /paper: '#f8f5ee'/);
    assert.match(church, /html, body \{ background: #f8f5ee;/);
  });

  test("the FAQ covers the audit and the page script no longer looks for the form", () => {
    assert.match(church, /Does the Front Door Audit cost anything\?/);
    const js = inlineScripts(church);
    assert.equal(/snapshot-form|getElementById\('snapshot'\)/.test(js), false);
    assert.match(js, /getElementById\('audit'\)/);
  });

  test("copy rules on the changed pages", () => {
    for (const [name, page] of [["church", church], ["landing", landing], ["scorecard", scorecard], ["walkthrough", walkthrough], ["thanks", thanks]]) {
      const text = visible(page);
      assert.equal(/—|&mdash;/.test(text), false, `${name}: em dash`);
      assert.equal(/\bholy\b/i.test(text), false, `${name}: holy`);
    }
  });
});

describe("old thanks page", () => {
  test("redirects to the audit in 3 seconds, is noindex, and links there", () => {
    assert.match(thanks, /<meta http-equiv="refresh" content="3;url=\/frontdoor\/">/);
    assert.match(thanks, /<meta name="robots" content="noindex">/);
    assert.match(thanks, /<a[^>]*href="\/frontdoor\/"/);
    assert.equal(/snapshot|72 hours|clips/i.test(visible(thanks)), false);
    assert.match(thanks, /#f8f5ee/);
  });
});

describe("intake modal", () => {
  test("the church options offer the Front Door Audit", () => {
    assert.match(intake, /'Free Front Door Audit'/);
    assert.equal(/Growth Snapshot/.test(intake), false);
  });

  test("the church modal books a call with our team; other services keep their own wording", () => {
    const churchCfg = intake.slice(intake.indexOf("Church: {"), intake.indexOf("fields:", intake.indexOf("Church: {")));
    assert.match(churchCfg, /headline: "Book a call<br\/>with our team\."/);
    assert.match(churchCfg, /calText: 'Book a call with our team'/);
    assert.equal(/Talk to|Chris/.test(churchCfg), false);
    assert.match(intake, /\$\{config\.calText \|\| 'Or book a discovery call instead'\}/);
  });
});

describe("privacy and plain words", () => {
  const privacy = read("privacy/index.html");

  test("the privacy page covers the text promise, how to opt out and the mailing address", () => {
    const text = visible(privacy);
    assert.ok(text.includes("We do not sell or share your mobile number or text consent with anyone for their marketing."));
    assert.match(text, /up to 2 texts/);
    assert.match(text, /Reply STOP/);
    assert.match(text, /reply stop to any email/);
    assert.match(text, /chris@bigsplash\.agency/);
    assert.match(text, /1119 Ascot St\., Georgetown, TX 78626/);
    assert.equal(/—|\b(really|just|actually|simply|truly|holy)\b/i.test(text), false);
  });

  test("every funnel page links the privacy page in its footer", () => {
    for (const [name, page] of [["landing", landing], ["scorecard", scorecard], ["walkthrough", walkthrough], ["church", church]]) {
      const footer = page.slice(page.lastIndexOf("<footer"));
      assert.match(footer, /href="\/privacy\/"/, name);
    }
  });

  test("the form says follow-up notes come after the scorecard", () => {
    assert.match(landing, /We'll email you a copy, then a few short notes from our team over the next week\. Reply stop anytime\./);
  });

  test("the walkthrough page hides the video spot until VSL_URL is set", () => {
    assert.match(walkthrough, /function showPoster\(player\) \{ player\.closest\("\.vsl"\)\.hidden = true; \}/);
    assert.match(walkthrough, /\.vsl\[hidden\] \{ display: none; \}/);
    assert.equal(/The video is on its way/.test(walkthrough), false);
  });

  test("a short grade value like #7 never wraps one character to a line", () => {
    assert.match(scorecard, /\.facts li b \{[^}]*overflow-wrap: break-word;[^}]*flex: 0 1 auto;/);
  });

  test("the church page keeps to Chris's writing rules where the review found gaps", () => {
    const text = visible(church);
    for (const banned of ["Fill Sunday", "fill Sunday", "likes and clicks", "Where you land", "How do you know who showed up", "What is the campaign budget", "Who films and edits", "and on your welcome team"]) {
      assert.equal(church.includes(banned), false, banned);
    }
    assert.match(text, /We film your church\./);
    assert.match(text, /100,000 families welcomed into the local church/);
    assert.equal(/Where you land/.test(landing), false);
  });
});
