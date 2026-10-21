// The retired church photo and the image rules it leaves behind. The scorecard used to show a photo picked from
// the church's home page; it picked event graphics and stock fields, so the logo is now the one picture the
// scorecard shows. These tests cover fetchImage() and the byte checks in photo.js that the logo still uses,
// and that nothing fetches, saves, serves or shows a photo any more, old audit links included.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { checkWebsite } from "../src/website.js";
import * as photo from "../src/photo.js";
import { runAudit } from "../src/audit.js";
import worker from "../src/worker.js";
import { stubFetch, page, homePage } from "./helpers.mjs";

const { sniffImage, imageSize, fetchImage, PHOTO_MAX_BYTES } = photo;
const PAGE = "https://cityreachchurch.com/";

// ---------- Image bytes ----------
// Padding keeps a fixture above the flat-graphic floor (bytes per pixel), like a real photo.
const pad = (w, h, rate = 0.05) => new Uint8Array(Math.ceil(w * h * rate)).map((_, i) => (i * 37) & 0xff);
const join = (...parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let at = 0; for (const p of parts) { out.set(p, at); at += p.length; } return out; };
const be16 = (n) => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const le16 = (n) => [n & 0xff, (n >> 8) & 0xff];
const le24 = (n) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const text = (s) => [...s].map((c) => c.charCodeAt(0));

// A JPEG with an APP0 segment before the frame header, as cameras and editors write them.
function jpeg(w, h, rate) {
  return join(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, ...text("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
    0xff, 0xc0, 0x00, 0x11, 0x08, ...be16(h), ...be16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]), pad(w, h, rate), Uint8Array.from([0xff, 0xd9]));
}
const png = (w, h, rate) => join(Uint8Array.from([0x89, ...text("PNG"), 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, ...text("IHDR"), ...be32(w), ...be32(h), 8, 2, 0, 0, 0]), pad(w, h, rate));
const riff = (chunk, data, w, h, rate) => join(Uint8Array.from([...text("RIFF"), 0, 0, 0, 0, ...text("WEBP"), ...text(chunk), 0, 0, 0, 0, ...data]), pad(w, h, rate));
const webpLossy = (w, h, rate) => riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h)], w, h, rate);
function webpLossless(w, h, rate) {
  const bits = ((w - 1) & 0x3fff) | (((h - 1) & 0x3fff) << 14);
  return riff("VP8L", [0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff], w, h, rate);
}
const webpExtended = (w, h, rate) => riff("VP8X", [0x10, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)], w, h, rate);
const avif = (w, h, rate) => join(Uint8Array.from([0, 0, 0, 0x1c, ...text("ftyp"), ...text("avif"), 0, 0, 0, 0, ...text("avif"), ...text("mif1"), ...text("miaf"),
  0, 0, 0, 0x14, ...text("ispe"), 0, 0, 0, 0, ...be32(w), ...be32(h)]), pad(w, h, rate));

const img = (bytes, type, extra = {}) => new Response(bytes, { status: 200, headers: { "content-type": type, ...extra } });

// ---------- KV with metadata ----------
function photoKv() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k)?.value; return v === undefined ? null : type === "json" ? JSON.parse(v) : v; },
    async put(k, value, opts = {}) { m.set(k, { value: typeof value === "string" ? value : Uint8Array.from(value), opts }); },
    async getWithMetadata(k, type) {
      const e = m.get(k);
      if (!e) return { value: null, metadata: null };
      const v = e.value;
      return { value: type === "arrayBuffer" && typeof v !== "string" ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v, metadata: e.opts.metadata ?? null };
    },
  };
}

describe("checking the image bytes", () => {
  test("type and size from the header bytes: JPEG, PNG, WebP (VP8, VP8L, VP8X) and AVIF", () => {
    for (const [make, type] of [[jpeg, "image/jpeg"], [png, "image/png"], [webpLossy, "image/webp"], [webpLossless, "image/webp"], [webpExtended, "image/webp"], [avif, "image/avif"]]) {
      const b = make(1500, 1000, 0.001);
      assert.equal(sniffImage(b), type, make.name);
      assert.deepEqual(imageSize(b, type), { width: 1500, height: 1000 }, make.name);
    }
    assert.equal(sniffImage(new TextEncoder().encode("<!doctype html><html><body>Not found</body></html>")), null);
    assert.equal(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"></svg>')), null);
  });

  test("an image comes back with its bytes and type, fetched with the phone user agent and the page as referer", async () => {
    const calls = stubFetch([["https://x.test/front.jpg", () => img(jpeg(1600, 1067), "image/jpg")]]);
    const r = await fetchImage("https://x.test/front.jpg", { referer: PAGE });
    assert.equal(r.ok, true);
    assert.equal(r.type, "image/jpeg", "image/jpg is read as image/jpeg");
    assert.equal(sniffImage(r.bytes), "image/jpeg");
    assert.match(calls[0].init.headers["User-Agent"], /iPhone/);
    assert.equal(calls[0].init.headers.Referer, PAGE);
    assert.ok(calls[0].init.signal, "fetched with a timeout");
  });

  test("the size cap: a stated length over it, or a body that runs over it, is refused; the logo passes a smaller cap", async () => {
    stubFetch([[/stated/, () => img(jpeg(1600, 1000), "image/jpeg", { "content-length": String(PHOTO_MAX_BYTES + 1) })],
      [/streamed/, () => img(jpeg(4000, 3000, 0.2), "image/jpeg")],
      [/mid/, () => img(jpeg(1000, 1000, 0.5), "image/jpeg")]]);
    assert.deepEqual(await fetchImage("https://x.test/stated.jpg"), { ok: false, reason: "over 2 MB" });
    assert.deepEqual(await fetchImage("https://x.test/streamed.jpg"), { ok: false, reason: "over 2 MB" });
    assert.deepEqual(await fetchImage("https://x.test/mid.jpg", { maxBytes: 200_000 }), { ok: false, reason: "over 200 KB" });
  });

  test("only the asked-for types are read: SVG and HTML are refused unless asked for", async () => {
    stubFetch([
      [/svg/, () => img('<svg xmlns="http://www.w3.org/2000/svg"/>', "image/svg+xml")],
      [/html/, () => img("<!doctype html><title>Not found</title>", "text/html; charset=utf-8")],
      [/notype/, () => new Response(jpeg(1600, 1000), { status: 200, headers: { "content-type": "" } })],
    ]);
    assert.match((await fetchImage("https://x.test/a.svg")).reason, /image\/svg\+xml/);
    assert.equal((await fetchImage("https://x.test/a.svg", { types: ["image/svg+xml"] })).ok, true);
    assert.match((await fetchImage("https://x.test/html.jpg")).reason, /text\/html/);
    assert.equal((await fetchImage("https://x.test/notype.jpg")).reason, "type missing");
  });

  test("errors and timeouts never throw", async () => {
    stubFetch([
      [/gone/, () => new Response("Not found", { status: 404 })],
      [/slow/, Object.assign(new DOMException("The operation was aborted due to timeout", "TimeoutError"))],
      [/down/, new TypeError("fetch failed")],
    ]);
    assert.deepEqual(await fetchImage("https://x.test/gone.jpg"), { ok: false, reason: "answered 404" });
    assert.deepEqual(await fetchImage("https://x.test/slow.jpg"), { ok: false, reason: "took too long" });
    assert.deepEqual(await fetchImage("https://x.test/down.jpg"), { ok: false, reason: "fetch failed" });
  });
});

describe("only public web addresses are fetched", () => {
  test("IP addresses, odd ports, logins and local names are refused before any fetch", async () => {
    const calls = stubFetch([[/./, () => img(jpeg(1600, 1000), "image/jpeg")]]);
    for (const u of ["http://127.0.0.1/a.jpg", "http://2130706433/a.jpg", "http://[::1]/a.jpg", "http://169.254.169.254/latest/meta-data",
      "https://cdn.test:8443/a.jpg", "https://user:pw@cdn.test/a.jpg", "http://localhost/a.jpg", "http://printer.local/a.jpg",
      "http://intranet/a.jpg", "ftp://cdn.test/a.jpg", "file:///etc/passwd"]) {
      assert.deepEqual(await fetchImage(u), { ok: false, reason: "not a public web address" }, u);
    }
    assert.equal(calls.length, 0);
  });

  test("redirects are followed by hand: each hop is checked, and more than three are refused", async () => {
    const hop = (to) => () => new Response(null, { status: 302, headers: { location: to } });
    const calls = stubFetch([
      [/start\.jpg/, hop("/moved/front.jpg")],
      [/moved\/front\.jpg/, () => img(jpeg(1600, 1067), "image/jpeg")],
      [/to-port/, hop("https://cdn.test:8080/a.jpg")],
      [/to-ip/, hop("http://10.0.0.5/a.jpg")],
      [/loop/, hop("https://x.test/loop.jpg")],
    ]);
    const r = await fetchImage("https://x.test/start.jpg");
    assert.equal(r.ok, true);
    assert.deepEqual(calls.map((c) => c.url), ["https://x.test/start.jpg", "https://x.test/moved/front.jpg"]);
    assert.ok(calls.every((c) => c.init.redirect === "manual"));
    assert.deepEqual(await fetchImage("https://x.test/to-port.jpg"), { ok: false, reason: "redirected off the public web" });
    assert.deepEqual(await fetchImage("https://x.test/to-ip.jpg"), { ok: false, reason: "redirected off the public web" });
    calls.length = 0;
    assert.deepEqual(await fetchImage("https://x.test/loop.jpg"), { ok: false, reason: "too many redirects" });
    assert.equal(calls.length, 4);
  });
});

describe("no church photo any more", () => {
  const ID = "city-reach-church-1a2b3c4d";
  const church = { name: "City Reach Church", address: "2700 W Whitestone Blvd, Cedar Park, TX 78613", city: "Cedar Park, TX 78613", website: PAGE };
  // A home page with everything the old photo picker went for (a share image, a hero background, a big photo)
  // and a header logo.
  const site = homePage('<header><a href="/" class="site-logo"><img src="/uploads/city-reach-logo.png" alt="City Reach Church logo"></a></header>' +
    '<div class="hero" style="background-image:url(/uploads/hero.jpg)"></div><a href="/visit">Plan a Visit</a><a href="/kids">Kids</a>' +
    '<p>Sundays 9:00 & 10:30am worship</p><img src="/uploads/sunday.jpg" width="1600" height="1000">',
    '<meta name="viewport" content="width=device-width"><meta property="og:image" content="/uploads/easter-promo.jpg"><meta property="og:image:width" content="1200">');
  const world = () => stubFetch([
    [/geocoding\.geo\.census\.gov/, () => new Response(JSON.stringify({ result: { addressMatches: [] } }), { headers: { "content-type": "application/json" } })],
    [/city-reach-logo\.png/, () => img(png(600, 200, 0.01), "image/png")],
    [/uploads\//, () => img(jpeg(1600, 1000), "image/jpeg")],
    [/cityreachchurch\.com/, () => page(site, 200, PAGE)],
  ]);

  test("photo.js keeps only the shared image rules", () => {
    assert.deepEqual(Object.keys(photo).sort(), ["PHOTO_MAX_BYTES", "PHOTO_TIMEOUT_MS", "PHOTO_TYPES", "fetchImage", "imageSize", "publicImageUrl", "sniffImage"]);
  });

  test("the home-page check no longer lists photo candidates", async () => {
    world();
    const w = await checkWebsite(PAGE);
    assert.equal(w.checked, true);
    assert.equal("photo" in w, false);
    assert.equal("photoCandidates" in w, false);
    assert.deepEqual(w.brand.logoCandidates, ["https://cityreachchurch.com/uploads/city-reach-logo.png"]);
  });

  test("the audit fetches and saves the logo only: no photo fetch, no photo:<id>, no result.photo", async () => {
    const calls = world();
    const env = { AUDITS: photoKv() };
    const r = await runAudit(church, env, { id: ID });
    assert.deepEqual([...env.AUDITS.m.keys()], [`logo:${ID}`]);
    assert.deepEqual(r.brand.logo, { stored: true, type: "image/png", width: 600, height: 200 });
    assert.equal("photo" in r, false);
    assert.equal(calls.some((c) => /easter-promo|hero\.jpg|sunday\.jpg/.test(c.url)), false, "no photo candidate is fetched");
    assert.equal(r.errors.some((e) => /^photo/.test(e)), false);
  });

  test("the grades are the same whether or not the logo could be had", async () => {
    world();
    const withLogo = await runAudit(church, { AUDITS: photoKv() }, { id: ID });
    stubFetch([
      [/geocoding\.geo\.census\.gov/, () => new Response(JSON.stringify({ result: { addressMatches: [] } }), { headers: { "content-type": "application/json" } })],
      [/city-reach-logo\.png/, () => img("<html>Forbidden</html>", "text/html")],
      [/cityreachchurch\.com/, () => page(site, 200, PAGE)],
    ]);
    const without = await runAudit(church, { AUDITS: photoKv() }, { id: ID });
    assert.equal(without.brand.logo, null);
    assert.deepEqual(without.scores, withLogo.scores);
    assert.ok(without.errors.some((e) => /^logo: none usable/.test(e)));
  });

  test("GET /photo answers 404 for every id, a photo saved by an older audit included", async () => {
    const BASE = "https://front-door.example.workers.dev";
    const env = { AUDITS: photoKv() };
    await env.AUDITS.put(`audit:${ID}`, JSON.stringify({ status: "ready", result: {} }));
    await env.AUDITS.put(`photo:${ID}`, jpeg(1600, 1000), { metadata: { type: "image/jpeg", width: 1600, height: 1000, source: "img", from: "https://x.test/a.jpg" } });
    for (const path of [`/photo?id=${ID}`, "/photo?id=../audit:x", "/photo"]) {
      const res = await worker.fetch(new Request(BASE + path), env);
      assert.equal(res.status, 404, path);
      assert.notEqual(res.headers.get("content-type"), "image/jpeg");
    }
  });
});

// ---------- Pages ----------
const ROOT = new URL("../../", import.meta.url);
const scorecard = readFileSync(new URL("front-door/index.html", ROOT), "utf8");
const walkthrough = readFileSync(new URL("frontdoor/walkthrough/index.html", ROOT), "utf8");
const inlineScripts = (p) => [...p.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n;\n");
const ID = "city-reach-church-1a2b3c4d";
const OLD_PHOTO = { stored: true, width: 1500, height: 1002, source: "img" };
const audit = (x = {}) => ({
  church: { name: "City Reach Church" }, checkedAt: "2026-10-19T18:00:00.000Z",
  scores: { overall: { grade: "B" }, areas: { google: { grade: "B" }, reviews: { grade: "A" }, website: { grade: "C" }, social: { grade: "B" } } },
  notes: { summary: "Summary.", areas: {}, fixes: [{ title: "Add a Plan Your Visit page", why: "Families look for it." }] },
  google: { found: true, rating: 4.6, reviewCount: 80, hoursListed: true, website: PAGE },
  website: { checked: true, serviceTimes: { found: true }, planVisit: { found: false }, kids: { found: true }, socials: {} },
  speed: { ok: true, score: 60 }, reach: null, ...x,
});
const BRAND = { primary: "#d20021", onPrimary: "#ffffff", logo: { stored: true, type: "image/webp", width: 1408, height: 1408 } };
const classes = () => { const set = new Set(); return { add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle() {} }; };

async function renderScorecard({ search = `?id=${ID}`, result } = {}) {
  const els = {};
  const el = (id) => (els[id] ||= { innerHTML: "", textContent: "", style: {} });
  const fetched = [];
  const context = {
    window: {},
    document: { getElementById: el, title: "", documentElement: { classList: classes() } },
    location: { search, href: "https://bigsplash.video/front-door/" + search },
    fetch: async (url) => { fetched.push(String(url)); return new Response(JSON.stringify(result ?? {}), { status: result ? 200 : 404 }); },
    URLSearchParams, URL, Response, Date, Intl, Number, String, JSON, Math, Object, Array, Promise, console, setTimeout, clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(inlineScripts(scorecard), context);
  await new Promise((r) => setTimeout(r, 30));
  return { html: el("app").innerHTML, fetched };
}

async function renderWalkthrough({ search = `?id=${ID}`, result = null } = {}) {
  const els = {};
  const node = (id) => ({ id, innerHTML: "", textContent: "", hidden: id === "grade", href: "", style: {}, children: [], classList: classes(),
    appendChild(c) { this.children.push(c); }, setAttribute() {}, addEventListener() {}, closest() { return node("vsl"); } });
  const el = (id) => (els[id] ||= node(id));
  const fetched = [];
  const context = {
    window: { addEventListener() {} },
    document: { getElementById: el, querySelector: () => node("footer"), createElement: (t) => node(t), body: node("body"), title: "", documentElement: { classList: classes() } },
    location: { search, href: "https://bigsplash.video/frontdoor/walkthrough/" + search },
    fetch: async (url) => { fetched.push(String(url)); return new Response(JSON.stringify(result ?? {}), { status: result ? 200 : 404 }); },
    URLSearchParams, URL, Response, AbortController, Date, Number, String, JSON, Math, Object, Array, Promise, Map, console, setTimeout, clearTimeout,
  };
  context.window.document = context.document;
  vm.createContext(context);
  vm.runInContext(inlineScripts(walkthrough), context);
  await new Promise((r) => setTimeout(r, 30));
  return { hero: Object.values(els).map((e) => e.innerHTML).join("\n"), fetched };
}

describe("the pages show no photo", () => {
  test("neither page has photo markup, styles, captions or the /photo route", () => {
    for (const [name, html] of [["scorecard", scorecard], ["walkthrough", walkthrough]]) {
      assert.equal(/\/photo\?|photo-slot|photoBanner|church-photo|class="photo"|\.photo\b|figcaption|'s website/.test(html), false, name);
    }
  });

  test("an older audit that saved a photo renders without it and asks for nothing but /result", async () => {
    for (const brand of [undefined, BRAND]) {
      const r = await renderScorecard({ result: audit({ photo: OLD_PHOTO, ...(brand ? { brand } : {}) }) });
      assert.match(r.html, /<h1>City Reach Church<\/h1>/);
      assert.equal(/photo|<figure/i.test(r.html), false);
      assert.deepEqual(r.fetched.map((u) => new URL(u).pathname), ["/result"]);
      const w = await renderWalkthrough({ result: audit({ photo: OLD_PHOTO, ...(brand ? { brand } : {}) }) });
      assert.match(w.hero, /City Reach Church's<\/span> Front Door Audit: overall B/);
      assert.equal(/photo|<figure/i.test(w.hero), false);
      assert.deepEqual(w.fetched.map((u) => new URL(u).pathname), ["/result"]);
    }
  });
});
