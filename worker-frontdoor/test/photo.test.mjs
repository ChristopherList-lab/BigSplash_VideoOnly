// The church photo: picking candidates from the home page (website.js), fetching and checking the bytes and
// saving them (photo.js), the /photo route, the audit wiring, and the scorecard and walkthrough pages with
// and without a photo.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { findPhotos, checkWebsite } from "../src/website.js";
import { sniffImage, imageSize, fetchPhoto, savePhoto, PHOTO_MAX_BYTES } from "../src/photo.js";
import { runAudit } from "../src/audit.js";
import worker from "../src/worker.js";
import { stubFetch, page, homePage, filler } from "./helpers.mjs";

const PAGE = "https://cityreachchurch.com/";
const fileName = (url) => decodeURIComponent(new URL(url).pathname.split("/").pop()).toLowerCase();

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

describe("picking the photo from the home page", () => {
  test("Squarespace: a logo og:image falls back to the hero image, sized with format=1500w", () => {
    const html = `<html><head><meta property="og:image" content="https://images.squarespace-cdn.com/content/v1/abc/CRC+Logo.png?format=1500w">
      <meta property="og:image:width" content="1500"><meta property="og:image:height" content="1500"></head><body>
      <header><img src="https://images.squarespace-cdn.com/content/v1/abc/logo-white.png?format=300w" alt="City Reach Church"></header>
      <img data-src="https://images.squarespace-cdn.com/content/v1/abc/16c2/SN-crowd.jpg" data-image="https://images.squarespace-cdn.com/content/v1/abc/16c2/SN-crowd.jpg"
        data-image-dimensions="2500x1667" alt="Sunday worship" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
      <img data-src="https://images.squarespace-cdn.com/content/v1/abc/9d/kids.jpg" data-image-dimensions="400x300" alt="Kids"></body></html>`;
    const list = findPhotos(html, PAGE);
    assert.equal(list[0].source, "img");
    assert.equal(list[0].url, "https://images.squarespace-cdn.com/content/v1/abc/16c2/SN-crowd.jpg?format=1500w");
    assert.equal(list[0].width, 1500);
    assert.equal(list[0].height, 1000);
    assert.equal(list.some((c) => /logo|kids/i.test(c.url)), false, "logos and small images are skipped");
  });

  test("WordPress: og:image with its size comes first; srcset gives the widest copy up to 2000w", () => {
    const html = `<html><head><meta property="og:image" content="https://gbcgt.org/wp-content/uploads/2026/03/IMG_6045.jpeg">
      <meta property="og:image:width" content="1600"><meta property="og:image:height" content="1200"></head><body>
      <img width="1024" height="683" src="https://gbcgt.org/wp-content/uploads/2026/02/worship-1024x683.jpg" class="attachment-large size-large wp-image-9"
        srcset="https://gbcgt.org/wp-content/uploads/2026/02/worship-300x200.jpg 300w, https://gbcgt.org/wp-content/uploads/2026/02/worship-1024x683.jpg 1024w, https://gbcgt.org/wp-content/uploads/2026/02/worship-1536x1024.jpg 1536w, https://gbcgt.org/wp-content/uploads/2026/02/worship-2560x1707.jpg 2560w"></body></html>`;
    const list = findPhotos(html, PAGE);
    assert.deepEqual(list[0], { url: "https://gbcgt.org/wp-content/uploads/2026/03/IMG_6045.jpeg", source: "og", width: 1600, height: 1200 });
    assert.deepEqual(list[1], { url: "https://gbcgt.org/wp-content/uploads/2026/02/worship-1536x1024.jpg", source: "img", width: 1536, height: 1025 });
  });

  test("Wix-style og tags with a size; a tiny og:image is skipped for twitter:image", () => {
    const wix = `<head><meta property="og:image" content="https://static.wixstatic.com/media/e969ae_6d1f~mv2.jpg/v1/fill/w_1200,h_630,al_c/e969ae_6d1f~mv2.jpg">
      <meta property="og:image:width" content="1200"><meta property="og:image:height" content="630"></head><body>${filler}</body>`;
    const list = findPhotos(wix, "https://www.gracechurch.org/");
    assert.equal(list[0].source, "og");
    assert.equal(list[0].width, 1200);
    assert.equal(list[0].height, 630);
    assert.match(list[0].url, /^https:\/\/static\.wixstatic\.com\/media\/e969ae_6d1f~mv2\.jpg\/v1\/fill\/w_1200,h_630/);

    const small = `<head><meta property="og:image" content="/share.jpg"><meta property="og:image:width" content="400"><meta property="og:image:height" content="400">
      <meta name="twitter:image" content="/images/building.jpg"></head><body></body>`;
    assert.deepEqual(findPhotos(small, PAGE).map((c) => [c.source, c.url]), [["twitter", "https://cityreachchurch.com/images/building.jpg"]]);
  });

  test("a Wix img asks for its displayed size, without the blurred placeholder", () => {
    const html = `<body><img src="https://static.wixstatic.com/media/11062b_18fa~mv2.jpg/v1/fill/w_80,h_41,al_c,q_80,blur_2,enc_avif/11062b_18fa~mv2.jpg" alt="Sunday" width="1200" height="800"></body>`;
    const [c] = findPhotos(html, PAGE);
    assert.equal(c.url, "https://static.wixstatic.com/media/11062b_18fa~mv2.jpg/v1/fill/w_1200,h_800,al_c,q_85/11062b_18fa~mv2.jpg");
    assert.equal(c.width, 1200);
  });

  test("relative URLs resolve against the final page URL and a <base> tag", () => {
    const html = `<head><meta property="og:image" content="../img/front-doors.jpg"></head><body><img src="photos/lobby.webp" width="1200" height="800"></body>`;
    const list = findPhotos(html, "https://www.cityreach.church/en/welcome/");
    assert.equal(list[0].url, "https://www.cityreach.church/en/img/front-doors.jpg");
    assert.equal(list[1].url, "https://www.cityreach.church/en/welcome/photos/lobby.webp");
    const based = findPhotos(`<head><base href="https://cdn.cityreach.church/site/"></head><body><img src="hero.jpg" width="1600" height="900"></body>`, PAGE);
    assert.equal(based[0].url, "https://cdn.cityreach.church/site/hero.jpg");
  });

  test("a hero background image counts; SVG, data URIs, favicons, icons, small and banner-shaped images never do", () => {
    const html = `<head><link rel="icon" href="/favicon.ico"><meta property="og:image" content="/brand/mark.svg">
      <style>.site-hero { background-image: url('/uploads/hero-sunday.jpg'); }</style></head><body>
      <img src="data:image/png;base64,iVBORw0KGgo=" width="1200" height="800">
      <img src="/icons/app-icon.png" width="1024" height="1024">
      <img src="/uploads/strip.jpg" width="3000" height="400">
      <img src="/uploads/thumb.jpg" width="320" height="240">
      <img src="/uploads/team.jpg" alt="Church logo" width="1200" height="800">
      <img src="/uploads/tall.jpg" width="800" height="1600"></body>`;
    assert.deepEqual(findPhotos(html, PAGE), [{ url: "https://cityreachchurch.com/uploads/hero-sunday.jpg", source: "hero" }]);
    const inline = `<body><section class="hero" style="background-image: url(&quot;/uploads/front.jpg&quot;)"></section></body>`;
    assert.deepEqual(findPhotos(inline, PAGE), [{ url: "https://cityreachchurch.com/uploads/front.jpg", source: "hero" }]);
  });

  test("a PNG goes after any JPEG or WebP, and at most three candidates come back", () => {
    const html = `<head><meta property="og:image" content="/uploads/welcome-graphic.png"></head><body>
      <img src="/a.jpg" width="1600" height="900"><img src="/b.webp" width="1400" height="900"><img src="/c.jpg" width="1200" height="800"><img src="/d.jpg" width="1000" height="700"></body>`;
    const list = findPhotos(html, PAGE);
    assert.deepEqual(list.map((c) => c.url.replace(PAGE, "/")), ["/a.jpg", "/b.webp", "/c.jpg"]);
  });

  test("a stock-named share image goes after the page's own large photo", () => {
    const html = `<head><meta property="og:image" content="/media/facebook-share-default.jpg"></head><body><img src="/uploads/sunday.jpg" width="1600" height="1000"></body>`;
    assert.deepEqual(findPhotos(html, PAGE).map((c) => c.source), ["img", "og"]);
  });

  test("a share image that is also the site icon or the logo is skipped (Wellspring UMC on Wix)", () => {
    const logo = "fb815e_5b46~mv2.png";
    const info = (data) => JSON.stringify({ displayMode: "fill", imageData: data }).replace(/"/g, "&quot;");
    const html = `<head><link rel="icon" href="https://static.wixstatic.com/media/${logo}/v1/fill/w_32%2Ch_32/${logo}">
      <meta property="og:image" content="https://static.wixstatic.com/media/${logo}/v1/fit/w_2500,h_1330,al_c/${logo}">
      <meta property="og:image:width" content="2500"><meta property="og:image:height" content="1330"></head><body>
      <wow-image data-image-info="${info({ width: 369, height: 369, uri: `https://static.wixstatic.com/media/${logo}`, name: "logo" })}"><img alt="Wellspring logo"></wow-image>
      <wow-image id="bgImg_comp-1" data-image-info="${info({ width: 2816, height: 2112, uri: "fb815e_7f35~mv2.jpg", name: "Building View with Bluebonnets 2.JPG" })}"><img alt="The Church Building with Bluebonnets"></wow-image>
      <wow-image data-image-info="${info({ width: 2550, height: 1650, uri: "fb815e_a292~mv2.png", alt: "UMC Logo", name: "UMC_CrossFlame_CLR.png" })}"><img alt="UMC Logo"></wow-image></body>`;
    assert.deepEqual(findPhotos(html, "https://www.wellumc.org/"), [
      { url: "https://static.wixstatic.com/media/fb815e_7f35~mv2.jpg/v1/fill/w_1600,h_1200,al_c,q_85/fb815e_7f35~mv2.jpg", source: "img", width: 1600, height: 1200 },
    ]);
    // WordPress: the og:image is the header logo's full-size upload; the site icon is its cropped- copy.
    const wp = `<head><link rel="apple-touch-icon" href="/wp-content/uploads/2021/04/cropped-mark-180x180.png">
      <meta property="og:image" content="/wp-content/uploads/2021/04/mark.jpg"><meta name="twitter:image" content="/wp-content/uploads/2021/05/crest.jpg"></head>
      <body><header><img class="site-logo" src="/wp-content/uploads/2021/05/crest-300x120.jpg"></header><img src="/wp-content/uploads/2024/09/sunday-1600x1000.jpg"></body>`;
    assert.deepEqual(findPhotos(wp, PAGE).map((c) => c.url), ["https://cityreachchurch.com/wp-content/uploads/2024/09/sunday-1600x1000.jpg"]);
    // Images served by one handler differ by query: a logo there leaves the other pictures alone.
    const handler = `<head><meta property="og:image" content="/GetImage.ashx?guid=aaa"></head><body><header><img alt="HCBC logo" src="/GetImage.ashx?guid=bbb"></header></body>`;
    assert.deepEqual(findPhotos(handler, PAGE).map((c) => c.url), ["https://cityreachchurch.com/GetImage.ashx?guid=aaa"]);
  });

  test("a square or stock-named share image goes after every image on the page (Celebration Church)", () => {
    const html = `<head><meta property="og:image" content="/img/meta-card.jpg"><meta property="og:image:width" content="2000"><meta property="og:image:height" content="2000">
      </head><body><img src="/assets/images/494acd.jpg"><img src="/assets/images/afb18e.jpg"></body>`;
    assert.deepEqual(findPhotos(html, PAGE).map((c) => c.source), ["img", "img", "og"]);
    const stock = `<head><meta property="og:image" content="/img/Meta-Share-Default.jpg"></head><body><img src="/assets/images/494acd.jpg"></body>`;
    assert.deepEqual(findPhotos(stock, PAGE).map((c) => c.source), ["img", "og"]);
  });

  test("a file named like a designed graphic (series title, slide, flyer) goes after photos and PNGs", () => {
    const html = `<body><img data-src="https://images.squarespace-cdn.com/content/v1/abc/1958/ACTS+-ctxapproved16_9+-+Title.jpg" data-image-dimensions="2500x1406">
      <img data-src="https://images.squarespace-cdn.com/content/v1/abc/7b29/COME+TO+THE+TABLE+SLIDE.jpg" data-image-dimensions="2000x1500">
      <img data-src="https://images.squarespace-cdn.com/content/v1/abc/2c1/kids-room.png" data-image-dimensions="1500x1000">
      <img data-src="https://images.squarespace-cdn.com/content/v1/abc/6f10/land+picture+color+corrected.jpg" data-image-dimensions="1500x1125"></body>`;
    assert.deepEqual(findPhotos(html, PAGE).map((c) => fileName(c.url)), ["land+picture+color+corrected.jpg", "kids-room.png", "acts+-ctxapproved16_9+-+title.jpg"]);
    // A slide is a slide: "slideshow" or a "sermon"-free name is not.
    const plain = `<body><img src="/uploads/slideshow-sunday.jpg" width="1600" height="900"><img src="/uploads/easter-flyer.jpg" width="1800" height="1200"></body>`;
    assert.deepEqual(findPhotos(plain, PAGE).map((c) => fileName(c.url)), ["slideshow-sunday.jpg", "easter-flyer.jpg"]);
  });

  test("checkWebsite returns website.photo and the candidates; a page without one gets null", async () => {
    stubFetch([[PAGE, () => page(homePage("<p>Sundays 10am worship</p>", '<meta name="viewport" content="width=device-width"><meta property="og:image" content="/uploads/front.jpg">'), 200, PAGE)]]);
    const w = await checkWebsite(PAGE);
    assert.deepEqual(w.photo, { url: "https://cityreachchurch.com/uploads/front.jpg", source: "og" });
    assert.equal(w.photoCandidates.length, 1);
    stubFetch([[PAGE, () => page(homePage("<p>Sundays 10am worship</p>"), 200, PAGE)]]);
    const none = await checkWebsite(PAGE);
    assert.equal(none.photo, null);
    assert.deepEqual(none.photoCandidates, []);
  });
});

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

  test("a good JPEG comes back with its real size, fetched with the phone user agent", async () => {
    const calls = stubFetch([["https://x.test/front.jpg", () => img(jpeg(1600, 1067), "image/jpeg")]]);
    const r = await fetchPhoto("https://x.test/front.jpg", { referer: PAGE });
    assert.equal(r.ok, true);
    assert.equal(r.type, "image/jpeg");
    assert.deepEqual([r.width, r.height], [1600, 1067]);
    assert.match(calls[0].init.headers["User-Agent"], /iPhone/);
    assert.equal(calls[0].init.headers.Referer, PAGE);
    assert.ok(calls[0].init.signal, "fetched with a timeout");
  });

  test("the 2 MB cap: a stated length over it, or a body that runs over it, is refused", async () => {
    stubFetch([[/stated/, () => img(jpeg(1600, 1000), "image/jpeg", { "content-length": String(PHOTO_MAX_BYTES + 1) })],
      [/streamed/, () => img(jpeg(4000, 3000, 0.2), "image/jpeg")]]);
    assert.deepEqual(await fetchPhoto("https://x.test/stated.jpg"), { ok: false, reason: "over 2 MB" });
    assert.deepEqual(await fetchPhoto("https://x.test/streamed.jpg"), { ok: false, reason: "over 2 MB" });
  });

  test("SVG and HTML are refused, and bytes that do not match the stated type are refused", async () => {
    stubFetch([
      [/svg/, () => img('<svg xmlns="http://www.w3.org/2000/svg"/>', "image/svg+xml")],
      [/html/, () => img("<!doctype html><title>Not found</title>", "text/html; charset=utf-8")],
      [/lying/, () => img("<!doctype html><title>Not found</title>".padEnd(200000, " "), "image/png")],
      [/swapped/, () => img(png(1600, 1000), "image/jpeg")],
      [/notype/, () => new Response(jpeg(1600, 1000), { status: 200, headers: { "content-type": "" } })],
    ]);
    assert.match((await fetchPhoto("https://x.test/a.svg")).reason, /image\/svg\+xml/);
    assert.match((await fetchPhoto("https://x.test/html.jpg")).reason, /text\/html/);
    assert.match((await fetchPhoto("https://x.test/lying.png")).reason, /bytes are not image\/png/);
    assert.match((await fetchPhoto("https://x.test/swapped.jpg")).reason, /bytes are not image\/jpeg/);
    assert.equal((await fetchPhoto("https://x.test/notype.jpg")).ok, false);
  });

  test("too small, banner-shaped or flat graphics are refused; errors and timeouts never throw", async () => {
    stubFetch([
      [/small/, () => img(jpeg(512, 512), "image/jpeg")],
      [/strip/, () => img(webpLossy(3000, 900), "image/webp")],
      [/flat/, () => img(jpeg(1200, 630, 0.01), "image/jpeg")],
      [/gone/, () => new Response("Not found", { status: 404 })],
      [/slow/, Object.assign(new DOMException("The operation was aborted due to timeout", "TimeoutError"))],
    ]);
    assert.match((await fetchPhoto("https://x.test/small.jpg")).reason, /512x512/);
    assert.match((await fetchPhoto("https://x.test/strip.webp")).reason, /3000x900/);
    assert.match((await fetchPhoto("https://x.test/flat.jpg")).reason, /flat graphic/);
    assert.deepEqual(await fetchPhoto("https://x.test/gone.jpg"), { ok: false, reason: "answered 404" });
    assert.deepEqual(await fetchPhoto("https://x.test/slow.jpg"), { ok: false, reason: "took too long" });
  });
});

describe("only public web addresses are fetched", () => {
  test("IP addresses, odd ports, logins and local names are refused before any fetch", async () => {
    const calls = stubFetch([[/./, () => img(jpeg(1600, 1000), "image/jpeg")]]);
    for (const u of ["http://127.0.0.1/a.jpg", "http://2130706433/a.jpg", "http://[::1]/a.jpg", "http://169.254.169.254/latest/meta-data",
      "https://cdn.test:8443/a.jpg", "https://user:pw@cdn.test/a.jpg", "http://localhost/a.jpg", "http://printer.local/a.jpg",
      "http://intranet/a.jpg", "ftp://cdn.test/a.jpg", "file:///etc/passwd"]) {
      assert.deepEqual(await fetchPhoto(u), { ok: false, reason: "not a public web address" }, u);
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
    const r = await fetchPhoto("https://x.test/start.jpg");
    assert.equal(r.ok, true);
    assert.deepEqual(calls.map((c) => c.url), ["https://x.test/start.jpg", "https://x.test/moved/front.jpg"]);
    assert.ok(calls.every((c) => c.init.redirect === "manual"));
    assert.deepEqual(await fetchPhoto("https://x.test/to-port.jpg"), { ok: false, reason: "redirected off the public web" });
    assert.deepEqual(await fetchPhoto("https://x.test/to-ip.jpg"), { ok: false, reason: "redirected off the public web" });
    calls.length = 0;
    assert.deepEqual(await fetchPhoto("https://x.test/loop.jpg"), { ok: false, reason: "too many redirects" });
    assert.equal(calls.length, 4);
  });

  test("a Weebly share image is a screenshot of the site itself, so it is skipped", () => {
    const html = '<html><head><meta property="og:image" content="https://storage.googleapis.com/wzsitethumbnails/site-47646454/800x500.jpg"></head><body></body></html>';
    assert.deepEqual(findPhotos(html, PAGE), []);
  });

  test("a <style> block with a long run and no braces is read quickly", () => {
    const t = Date.now();
    findPhotos(`<html><body><style>.hero{background:url(/a.jpg)}${"a".repeat(300000)}</style></body></html>`, PAGE);
    assert.ok(Date.now() - t < 1000);
  });
});

describe("saving the photo", () => {
  const candidates = [
    { url: "https://x.test/og-logo-card.jpg", source: "og" },
    { url: "https://x.test/vector.svg.jpg", source: "twitter" },
    { url: "https://x.test/sunday.webp", source: "img", width: 1500 },
    { url: "https://x.test/fourth.jpg", source: "img" },
  ];

  test("falls back to the next candidate and saves the first good one with its metadata and a year's TTL", async () => {
    const calls = stubFetch([
      [/og-logo-card/, () => img(jpeg(1200, 630, 0.01), "image/jpeg")],
      [/vector/, () => img("<svg/>", "image/svg+xml")],
      [/sunday/, () => img(webpExtended(1500, 1000), "image/webp")],
      [/fourth/, () => img(jpeg(1600, 900), "image/jpeg")],
    ]);
    const env = { AUDITS: photoKv() };
    const r = await savePhoto(env, "city-reach-church-1a2b3c4d", candidates);
    assert.deepEqual(r.photo, { stored: true, width: 1500, height: 1000, source: "img" });
    assert.equal(r.misses.length, 2);
    assert.equal(calls.length, 3, "stops at the first good candidate");
    const saved = env.AUDITS.m.get("photo:city-reach-church-1a2b3c4d");
    assert.equal(sniffImage(saved.value), "image/webp");
    assert.equal(saved.opts.expirationTtl, 60 * 60 * 24 * 365);
    assert.deepEqual(saved.opts.metadata, { type: "image/webp", width: 1500, height: 1000, source: "img", from: "https://x.test/sunday.webp" });
  });

  test("tries three candidates at most; nothing usable saves nothing", async () => {
    const calls = stubFetch([[/./, () => img(jpeg(400, 300), "image/jpeg")]]);
    const env = { AUDITS: photoKv() };
    const r = await savePhoto(env, "city-reach-church-1a2b3c4d", candidates);
    assert.equal(r.photo, null);
    assert.equal(calls.length, 3);
    assert.equal(env.AUDITS.m.size, 0);
  });

  test("an aborted signal saves nothing; no id or no KV saves nothing", async () => {
    stubFetch([[/./, () => img(jpeg(1600, 1000), "image/jpeg")]]);
    const env = { AUDITS: photoKv() };
    const stop = new AbortController();
    stop.abort();
    assert.equal((await savePhoto(env, "city-reach-church-1a2b3c4d", candidates, { signal: stop.signal })).photo, null);
    assert.equal((await savePhoto(env, null, candidates)).photo, null);
    assert.equal((await savePhoto({}, "city-reach-church-1a2b3c4d", candidates)).photo, null);
    assert.equal(env.AUDITS.m.size, 0);
  });
});

describe("the audit", () => {
  const church = { name: "City Reach Church", address: "2700 W Whitestone Blvd, Cedar Park, TX 78613", city: "Cedar Park, TX 78613", website: PAGE };
  const site = homePage('<a href="/visit">Plan a Visit</a><a href="/kids">Kids</a><p>Sundays 9:00 & 10:30am worship</p><img src="/uploads/sunday.jpg" width="1600" height="1000">');
  const world = (photo) => stubFetch([
    [/geocoding\.geo\.census\.gov/, () => new Response(JSON.stringify({ result: { addressMatches: [] } }), { headers: { "content-type": "application/json" } })],
    [/uploads\/sunday\.jpg/, photo],
    [/cityreachchurch\.com/, () => page(site, 200, PAGE)],
  ]);

  test("saves the photo under photo:<id> and records result.photo without a URL", async () => {
    world(() => img(jpeg(1600, 1000), "image/jpeg"));
    const env = { AUDITS: photoKv() };
    const r = await runAudit(church, env, { id: "city-reach-church-1a2b3c4d" });
    assert.deepEqual(r.photo, { stored: true, width: 1600, height: 1000, source: "img" });
    assert.equal(env.AUDITS.m.get("photo:city-reach-church-1a2b3c4d").opts.metadata.from, "https://cityreachchurch.com/uploads/sunday.jpg");
  });

  test("a photo that fails leaves result.photo null and the grades unchanged", async () => {
    world(() => img(jpeg(1600, 1000), "image/jpeg"));
    const good = await runAudit(church, { AUDITS: photoKv() }, { id: "city-reach-church-1a2b3c4d" });
    world(() => img("<html>Forbidden</html>", "text/html"));
    const bad = await runAudit(church, { AUDITS: photoKv() }, { id: "city-reach-church-1a2b3c4d" });
    assert.equal(bad.photo, null);
    assert.deepEqual(bad.scores, good.scores);
    assert.ok(bad.errors.some((e) => /^photo: none usable/.test(e)));
    world(new TypeError("fetch failed"));
    assert.equal((await runAudit(church, { AUDITS: photoKv() }, { id: "city-reach-church-1a2b3c4d" })).photo, null);
  });

  test("without an audit id (a local run) nothing is fetched or saved", async () => {
    const calls = world(() => img(jpeg(1600, 1000), "image/jpeg"));
    const r = await runAudit(church, { AUDITS: photoKv() });
    assert.equal(r.photo, null);
    assert.equal(calls.some((c) => /sunday\.jpg/.test(c.url)), false);
  });

  test("the audit Workflow passes its id to runAudit", () => {
    assert.match(readFileSync(new URL("../src/worker.js", import.meta.url), "utf8"), /runAudit\(church, this\.env, \{ id \}\)/);
  });
});

describe("GET /photo", () => {
  const BASE = "https://front-door.example.workers.dev";
  const get = (env, path) => worker.fetch(new Request(BASE + path), env);
  const ID = "city-reach-church-1a2b3c4d";

  test("serves the stored bytes with their type and locked-down headers, whatever the audit's status", async () => {
    const env = { AUDITS: photoKv() };
    const bytes = jpeg(1600, 1000);
    await env.AUDITS.put(`audit:${ID}`, JSON.stringify({ status: "review", reviewToken: "a".repeat(32) }));
    await env.AUDITS.put(`photo:${ID}`, bytes, { metadata: { type: "image/jpeg", width: 1600, height: 1000, source: "img", from: "https://x.test/a.jpg" } });
    const res = await get(env, `/photo?id=${ID}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/jpeg");
    assert.equal(res.headers.get("cache-control"), "public, max-age=86400");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("content-security-policy"), "default-src 'none'");
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
  });

  test("404 when missing, for a bad id, and for anything that is not a stored photo", async () => {
    const env = { AUDITS: photoKv() };
    await env.AUDITS.put(`audit:${ID}`, JSON.stringify({ status: "ready", result: {} }));
    let res = await get(env, `/photo?id=${ID}`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal((await get(env, "/photo?id=../audit:x")).status, 404);
    assert.equal((await get(env, "/photo")).status, 404);
    // An audit record is never served through /photo, and stored bytes must match their stored type.
    await env.AUDITS.put("photo:svg-photo-1", new TextEncoder().encode("<svg/>"), { metadata: { type: "image/svg+xml" } });
    await env.AUDITS.put("photo:html-photo-1", new TextEncoder().encode("<!doctype html>".padEnd(64)), { metadata: { type: "image/jpeg" } });
    assert.equal((await get(env, "/photo?id=svg-photo-1")).status, 404);
    assert.equal((await get(env, "/photo?id=html-photo-1")).status, 404);
    res = await worker.fetch(new Request(`${BASE}/photo?id=${ID}`, { method: "POST" }), env);
    assert.equal(res.status, 404);
  });
});

// ---------- Pages ----------
const ROOT = new URL("../../", import.meta.url);
const scorecard = readFileSync(new URL("front-door/index.html", ROOT), "utf8");
const walkthrough = readFileSync(new URL("frontdoor/walkthrough/index.html", ROOT), "utf8");
const inlineScripts = (p) => [...p.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n;\n");
const API = "https://bigsplash-front-door.chris-bc4.workers.dev";
const ID = "city-reach-church-1a2b3c4d";

const audit = (x = {}) => ({
  church: { name: "City Reach Church" }, checkedAt: "2026-10-19T18:00:00.000Z",
  scores: { overall: { grade: "B" }, areas: { google: { grade: "B" }, reviews: { grade: "A" }, website: { grade: "C" }, social: { grade: "B" } } },
  notes: { summary: "Summary.", areas: {}, fixes: [{ title: "Add a Plan Your Visit page", why: "Families look for it." }] },
  google: { found: true, rating: 4.6, reviewCount: 80, hoursListed: true, website: PAGE },
  website: { checked: true, serviceTimes: { found: true }, planVisit: { found: false }, kids: { found: true }, socials: {} },
  speed: { ok: true, score: 60 }, reach: null, ...x,
});
const PHOTO = { stored: true, width: 1500, height: 1002, source: "img" };

async function renderScorecard({ data, search = "", result } = {}) {
  const els = {};
  const el = (id) => (els[id] ||= { innerHTML: "", textContent: "", style: {} });
  const fetched = [];
  const context = {
    window: { FRONT_DOOR_DATA: data },
    document: { getElementById: el, title: "" },
    location: { search, href: "https://bigsplash.video/front-door/" + search },
    fetch: async (url) => { fetched.push(String(url)); return new Response(JSON.stringify(result ?? {}), { status: result ? 200 : 404 }); },
    URLSearchParams, URL, Response, Date, Intl, Number, String, JSON, Math, Object, Array, Promise, console, setTimeout, clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(inlineScripts(scorecard), context);
  await new Promise((r) => setTimeout(r, 30));
  return { html: el("app").innerHTML, fetched };
}

describe("scorecard page photo", () => {
  test("shows the church photo in the hero from /photo, with alt, caption, size and an error fallback", async () => {
    const { html } = await renderScorecard({ search: `?id=${ID}`, result: audit({ photo: PHOTO }) });
    const fig = (html.match(/<figure class="photo">[\s\S]*?<\/figure>/) || [])[0];
    assert.ok(fig, "photo figure present");
    assert.match(html, /<section class="hero"><figure class="photo">/, "the photo sits in the hero");
    assert.match(fig, new RegExp(`src="${API}/photo\\?id=${ID}"`));
    assert.match(fig, /alt="Photo from City Reach Church's website"/);
    assert.match(fig, /width="1500" height="1002"/);
    assert.match(fig, /loading="eager"/);
    assert.match(fig, /onerror="this\.parentNode\.remove\(\)"/);
    assert.match(fig, /<figcaption>From City Reach Church's website<\/figcaption>/);
    assert.match(html, /<h1>City Reach Church<\/h1>/, "the church name stays");
    assert.match(html, /<div class="grade"><b>B<\/b>/, "the grade ring stays");
  });

  test("a preview build uses the data's id; a church name is escaped in the alt and caption", async () => {
    const { html } = await renderScorecard({ data: audit({ id: ID, photo: PHOTO, church: { name: 'St. "Mark" <Church>' } }) });
    assert.match(html, new RegExp(`/photo\\?id=${ID}`));
    assert.match(html, /alt="Photo from St\. &quot;Mark&quot; &lt;Church&gt;'s website"/);
    assert.equal(/<Church>/.test(html), false);
  });

  test("no photo, or no id to fetch it by: the page is the same as before", async () => {
    const before = (await renderScorecard({ search: `?id=${ID}`, result: audit() })).html;
    assert.equal(/class="photo"|\/photo\?/.test(before), false);
    assert.match(before, /<section class="hero">\s*<div><p class="eyebrow">/);
    const noId = (await renderScorecard({ data: audit({ photo: PHOTO }) })).html;
    assert.equal(/class="photo"/.test(noId), false);
    const notStored = (await renderScorecard({ search: `?id=${ID}`, result: audit({ photo: null }) })).html;
    assert.equal(notStored, before);
  });

  test("the banner is 16:9 with rounded corners on desktop and 4:3 on phones", () => {
    assert.match(scorecard, /\.photo \{[^}]*aspect-ratio: 16 \/ 9;[^}]*border-radius: 16px;/);
    assert.match(scorecard, /\.photo img \{[^}]*object-fit: cover;/);
    assert.match(scorecard, /@media \(max-width: 640px\) \{[\s\S]*?\.photo \{ aspect-ratio: 4 \/ 3;/);
    assert.match(scorecard, /\.photo::after \{[^}]*linear-gradient/);
  });
});

// The walkthrough page's script in a small fake DOM.
async function renderWalkthrough({ search = "", result = null, data } = {}) {
  const els = {};
  const node = (id) => ({ id, innerHTML: "", textContent: "", hidden: id === "grade", href: "", style: {}, children: [], classList: { toggle() {} },
    appendChild(c) { this.children.push(c); }, setAttribute() {}, addEventListener() {}, closest() { return node("vsl"); } });
  const el = (id) => (els[id] ||= node(id));
  const fetched = [];
  const context = {
    window: { FRONT_DOOR_DATA: data, addEventListener() {} },
    document: { getElementById: el, querySelector: () => node("footer"), createElement: (t) => node(t), body: node("body"), title: "" },
    location: { search, href: "https://bigsplash.video/frontdoor/walkthrough/" + search },
    fetch: async (url) => { fetched.push(String(url)); return new Response(JSON.stringify(result ?? {}), { status: result ? 200 : 404 }); },
    URLSearchParams, URL, Response, AbortController, Date, Number, String, JSON, Math, Object, Array, Promise, Map, console, setTimeout, clearTimeout,
  };
  context.window.document = context.document;
  vm.createContext(context);
  vm.runInContext(inlineScripts(walkthrough), context);
  await new Promise((r) => setTimeout(r, 30));
  return { slot: el("photo-slot").innerHTML, headline: el("headline").innerHTML, fetched };
}

describe("walkthrough page photo", () => {
  test("shows the church photo above the personalized headline, from the same /photo route", async () => {
    const { slot, headline } = await renderWalkthrough({ search: `?id=${ID}`, result: audit({ photo: PHOTO }) });
    assert.match(headline, /City Reach Church's Front Door Audit: overall B/);
    assert.match(slot, /^<figure class="church-photo"><img /);
    assert.match(slot, new RegExp(`src="${API}/photo\\?id=${ID}"`));
    assert.match(slot, /alt="Photo from City Reach Church's website"/);
    assert.match(slot, /width="1500" height="1002"/);
    assert.match(slot, /loading="eager"/);
    assert.match(slot, /onerror="this\.parentNode\.remove\(\)"/);
    assert.match(slot, /<figcaption>From City Reach Church's website<\/figcaption>/);
    assert.match(walkthrough, /<div id="photo-slot"><\/div>\s*<p class="eyebrow">/, "the slot sits above the eyebrow and headline");
  });

  test("no photo, no audit, or a failed /result: no image", async () => {
    assert.equal((await renderWalkthrough({ search: `?id=${ID}`, result: audit() })).slot, "");
    assert.equal((await renderWalkthrough({ search: `?id=${ID}` })).slot, "");
    const generic = await renderWalkthrough();
    assert.equal(generic.slot, "");
    assert.equal(generic.fetched.length, 0);
  });
});
