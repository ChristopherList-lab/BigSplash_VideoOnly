// Spec items 10 and 11: the scorecard renderer (run in a small fake DOM) and the landing page markup.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ROOT = new URL("../../", import.meta.url);
const scorecard = readFileSync(new URL("front-door/index.html", ROOT), "utf8");
const landing = readFileSync(new URL("frontdoor/index.html", ROOT), "utf8");
const inlineScripts = (page) => [...page.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n;\n");
const visible = (page) => page.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");

// Run the scorecard page's script with either inline data or a fake /result response.
async function renderScorecard({ data, search = "", result } = {}) {
  const els = {};
  const el = (id) => (els[id] ||= { innerHTML: "", textContent: "", style: {}, appendChild() {}, addEventListener() {} });
  const fetched = [];
  const context = {
    window: { FRONT_DOOR_DATA: data },
    document: { getElementById: el, querySelector: () => el("q"), title: "", createElement: () => el("new" + Math.random()) },
    location: { search, href: "https://bigsplash.video/front-door/" + search },
    fetch: async (url) => { fetched.push(String(url)); return new Response(JSON.stringify(result?.body ?? {}), { status: result?.status ?? 404, headers: { "content-type": "application/json" } }); },
    URLSearchParams, URL, Response, Date, Intl, Number, String, JSON, Math, Object, Array, Promise, console, setTimeout, clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(inlineScripts(scorecard), context);
  await new Promise((r) => setTimeout(r, 30));
  const raw = el("app").innerHTML;
  // Text as the reader sees it; raw keeps the markup for escaping checks.
  const text = raw.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return { html: text, raw, fetched, title: context.document.title };
}

const data = (x = {}) => ({
  church: { name: "City Reach Church" }, checkedAt: "2026-10-19T18:00:00.000Z",
  scores: { overall: { points: 89, grade: "B" }, areas: { google: { points: 84, grade: "B", checked: true }, reviews: { points: 100, grade: "A", checked: true },
    website: { points: 88, grade: "B", checked: true }, social: { points: 92, grade: "A", checked: true } } },
  notes: { summary: "A new family can find most of what they need. The biggest gap: one thing.", areas: { google: "g note", reviews: "r note", website: "w note", social: "s note" },
    fixes: [{ title: "Add a Plan Your Visit page", why: "New families look for it first." }] },
  google: { found: true, rating: 4.7, reviewCount: 264, hoursListed: true, website: "https://cityreachchurch.com/" },
  nearMe: { checked: true, best: 7, searches: [{ from: "north", milesAway: 4, checked: true, rank: 7, scanned: 27, ahead: [] }, { from: "south", milesAway: 4, checked: true, rank: null, scanned: 60, ahead: [] }] },
  website: { ok: true, checked: true, https: true, viewport: true, serviceTimes: { found: true }, planVisit: { found: false }, kids: { found: true },
    socials: { facebook: {}, instagram: {}, vimeo: {} }, sermons: { found: true, sources: ["Vimeo", "Sermons page"] },
    youtube: { daysSinceLastUpload: 1, lastUpload: "2026-10-18T15:00:00.000Z", uploadsLast30Days: 4 }, vimeo: { daysSinceLastUpload: 3, lastUpload: "2026-10-16T15:00:00.000Z" } },
  speed: { ok: true, score: 26, fieldLcpSeconds: null, loadTime: 17.9 },
  reach: null,
  ...x,
});

describe("scorecard page", () => {
  test("Google rows show north and south results", async () => {
    const { html } = await renderScorecard({ data: data() });
    // The distance sits in the label, so the value stays short on a phone.
    assert.match(html, /from 4 miles north<\/span><b[^>]*>#7</);
    assert.match(html, /from 4 miles south<\/span><b[^>]*>Not in the first 60</);
    const off = data({ nearMe: { checked: true, best: 7, searches: [{ from: "north", milesAway: 4, checked: true, rank: 7, scanned: 27 }, { from: "south", milesAway: 4, checked: false, error: "429" }] } });
    const r2 = await renderScorecard({ data: off });
    assert.match(r2.html, /south[\s\S]{0,200}Not checked/);
  });

  test("speed row shows the phone test score, never lab seconds; real-visitor seconds only from field data", async () => {
    let { html } = await renderScorecard({ data: data() });
    assert.match(html, /Google phone test/);
    assert.match(html, /26 \/ 100/);
    assert.equal(/17\.9/.test(html), false);
    assert.equal(/Real visitors wait about/.test(html), false);
    ({ html } = await renderScorecard({ data: data({ speed: { ok: true, score: 26, fieldLcpSeconds: 3.1 } }) }));
    assert.match(html, /Real visitors wait about[\s\S]{0,80}3\.1 s/);
  });

  test("sermons row with sources; upload recency as an absolute date as of the check, never today or yesterday", async () => {
    const { html } = await renderScorecard({ data: data() });
    assert.match(html, /Vimeo, Sermons page/);
    assert.match(html, /Oct 18[\s\S]{0,40}as of Oct 19/);
    assert.match(html, /Oct 16[\s\S]{0,40}as of Oct 19/, "Vimeo recency shown");
    assert.equal(/\btoday\b|\byesterday\b|days ago/i.test(html), false);
  });

  test("a null area shows a neutral Not checked badge and the not-checked note", async () => {
    const d = data();
    d.scores.areas.website = { points: null, grade: null, checked: false };
    d.scores.areas.social = { points: null, grade: null, checked: false };
    d.website = { ok: false, checked: false, reason: "HTTP 403" };
    const { html } = await renderScorecard({ data: d });
    assert.match(html, /Not checked/);
    assert.match(html, /We couldn't check this one this time\. We can go over it together on a call with our team\./);
    assert.equal(/did not load|back online/i.test(html), false);
  });

  test("reach null explains Texas only", async () => {
    const { html } = await renderScorecard({ data: data() });
    assert.match(html, /Household count is available for Texas churches\./);
  });

  test("every inserted string is escaped", async () => {
    const d = data({ church: { name: `St Peter's <b>Evangelical</b> & "Friends"` } });
    d.notes.summary = "<img src=x onerror=alert(1)> summary";
    d.notes.areas.google = "<script>alert(2)</script>";
    d.notes.fixes = [{ title: "<i>Fix</i>", why: "<u>why</u>" }];
    d.website.sermons.sources = ["<svg onload=alert(3)>"];
    d.speed = { ok: true, score: "<b>26</b>", fieldLcpSeconds: "<b>3</b>" };
    const { raw: html } = await renderScorecard({ data: d });
    for (const bad of ["<b>Evangelical</b>", "<img src=x", "<script>alert(2)", "<i>Fix</i>", "<u>why</u>", "<svg onload", "<b>26</b>", "<b>3</b>"]) {
      assert.equal(html.includes(bad), false, `unescaped: ${bad}`);
    }
    assert.match(html, /&lt;b&gt;Evangelical&lt;\/b&gt;/);
  });

  test("footer says how the check was done, naming only the checks that ran", async () => {
    const full = data({ reach: { households: 34600, miles: 5 } });
    full.website.youtube.checked = true;
    full.website.vimeo.checked = true;
    let { html } = await renderScorecard({ data: full });
    assert.match(html, /Big Splash checked City Reach Church on Oct 19, 2026 on a phone, the way a neighbor would, and searched Google from about 4 miles away\. Numbers come from Google, Google PageSpeed, YouTube, Vimeo and the US Census\./);
    // No near-me search, no video dates, no household count: the footer does not claim them.
    const d = data({ nearMe: null, reach: null });
    d.website.youtube = { checked: false };
    d.website.vimeo = null;
    ({ html } = await renderScorecard({ data: d }));
    assert.match(html, /on a phone, the way a neighbor would\. Numbers come from Google and Google PageSpeed\./);
    assert.equal(/searched Google|YouTube, |Vimeo and|US Census/.test(html.split("<footer>")[1]), false, html.split("<footer>")[1]);
  });

  test("old records: a search with a rank but no checked flag still shows, a missing sermons field shows no row", async () => {
    const d = data({ nearMe: { checked: true, best: 7, searches: [{ from: "north", milesAway: 4, rank: 7, scanned: 27 }, { from: "south", milesAway: 4, rank: null, scanned: 60 }] } });
    delete d.website.sermons;
    const { html } = await renderScorecard({ data: d });
    assert.match(html, /from 4 miles north<\/span><b[^>]*>#7</);
    assert.equal(/Sermons linked from the home page/.test(html), false);
  });

  test("fast real visitors keep a low lab score neutral; a times link reads as linked, not found on the page", async () => {
    const d = data({ speed: { ok: true, score: 32, fieldLcpSeconds: 1.5 } });
    d.website.serviceTimes = { found: true, via: "link", sample: "Locations" };
    const { html } = await renderScorecard({ data: d });
    assert.match(html, /<b class="">32 \/ 100</);
    assert.match(html, /Service times<\/span><b class="yes">Linked from the home page</);
  });

  test("a Texas church with no household count is not told counts are for Texas churches", async () => {
    const { html } = await renderScorecard({ data: data({ church: { name: "City Reach Church", address: "2700 W Whitestone Blvd, Cedar Park, TX 78613" } }) });
    assert.match(html, /We couldn't count the households near your church this time\./);
  });

  test("long names wrap: overflow-wrap:anywhere on h1 and .summary", () => {
    const css = scorecard.match(/<style>([\s\S]*?)<\/style>/)[1];
    const rule = (sel) => (css.match(new RegExp(`(^|[}\\s,])${sel.replace(".", "\\.")}\\s*\\{([^}]*)\\}`, "m")) || [])[2] || "";
    assert.match(rule("h1"), /overflow-wrap:\s*anywhere/);
    assert.match(rule(".summary"), /overflow-wrap:\s*anywhere/);
  });

  const T = "a".repeat(32);
  for (const [status, msg] of [
    ["running", "Your audit is still running. Refresh in a minute."],
    ["review", "Chris is double-checking a few details and will email your scorecard within one business day."],
    ["failed", "Something went wrong on our end. Chris has the details and will email your scorecard."],
  ]) {
    test(`status ${status} gets its own message and the token is passed to /result`, async () => {
      const r = await renderScorecard({ search: `?id=city-reach-church-c6d90375&t=${T}`, result: { status: 404, body: { status } } });
      assert.ok(r.html.includes(msg), r.html);
      assert.ok(r.fetched.some((u) => /\/result\?/.test(u) && u.includes(`t=${T}`) && u.includes("id=city-reach-church-c6d90375")), r.fetched.join(" "));
    });
  }

  test("an unknown audit keeps the not-found text", async () => {
    const r = await renderScorecard({ search: "?id=city-reach-church-c6d90375", result: { status: 404, body: {} } });
    assert.match(r.html, /We couldn't find that audit/);
  });

  test("no em dash in pastor-facing text", () => {
    assert.equal(/—|&mdash;/.test(visible(scorecard)), false);
    assert.equal(/—/.test(inlineScripts(scorecard).replace(/\/\/.*$/gm, "")), false);
  });
});

describe("landing page", () => {
  const selectFirstOption = (name) => {
    const sel = landing.match(new RegExp(`<select[^>]*name="${name}"[^>]*>([\\s\\S]*?)</select>`));
    assert.ok(sel, `select ${name}`);
    return sel[1].match(/<option[^>]*>[^<]*<\/option>/)[0];
  };

  test("role and Facebook selects start blank, disabled, 'Choose one'", () => {
    for (const name of ["role", "facebook_frequency"]) {
      const opt = selectFirstOption(name);
      assert.match(opt, /value=""/, name);
      assert.match(opt, /\bdisabled\b/, name);
      assert.match(opt, /\bselected\b/, name);
      assert.match(opt, />Choose one</, name);
    }
  });

  test("honeypot is hp_x7 with autocomplete new-password; company_site is gone", () => {
    const input = landing.match(/<input[^>]*name="hp_x7"[^>]*>/);
    assert.ok(input, "hp_x7 input");
    assert.match(input[0], /autocomplete="new-password"/);
    assert.equal(/company_site/.test(landing), false);
  });

  test("a 'Run my free audit' jump link sits above the form and points at it", () => {
    const formId = landing.match(/<form[^>]*id="([^"]+)"/)[1];
    const formAt = landing.search(/<form\b/);
    const jump = [...landing.matchAll(/<(a|button)\b([^>]*)>\s*Run my free audit\s*<\/\1>/g)].find((m) => m.index < formAt);
    assert.ok(jump, "jump button before the form");
    assert.ok(jump[2].includes(`href="#${formId}"`) || /scroll/i.test(jump[2]), jump[0]);
  });

  test("household promise names Texas churches and up to three fixes", () => {
    assert.match(landing, /within a 10-minute drive \(Texas churches\) and up to three fixes to start with\./);
  });

  test("polling handles failed and review", () => {
    const js = inlineScripts(landing);
    assert.match(js, /status\s*===\s*["']failed["']/);
    assert.match(js, /Something went wrong on our end\. Chris has the details and will email your scorecard\./);
    assert.match(js, /status\s*===\s*["']review["']/);
  });

  test("no em dash or 'holy' in landing copy", () => {
    assert.equal(/—|&mdash;/.test(visible(landing)), false);
    assert.equal(/\bholy\b/i.test(visible(landing)), false);
  });
});
