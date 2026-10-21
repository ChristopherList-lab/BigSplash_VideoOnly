// The church's own look on the scorecard: reading its color, font and logo from the home page and its own
// stylesheets (brand.js), the contrast math, fetching, checking and saving the logo (logo.js), the /logo route,
// the co-branded scorecard and walkthrough pages, and the city read off a matched Google listing.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { brandFromPage, stylesheetLinks, findLogos, parseColor, toHex, contrast, luminance, ensureContrast, usable, themeColors } from "../src/brand.js";
import { svgProblem, svgSize, fetchLogo, saveLogo, servableLogo, logoSizeOk } from "../src/logo.js";
import { checkWebsite } from "../src/website.js";
import { runAudit, cityFromAddress } from "../src/audit.js";
import worker, { FrontDoorAudit } from "../src/worker.js";
import { stubFetch, html, json, redirect, fakeEnv, fakeStep } from "./spec-helpers.mjs";

const filler = `<p>${"Our church family gathers to worship, serve the city and love our neighbors well. ".repeat(8)}</p>` +
  ["/about", "/staff", "/give", "/events", "/contact", "/beliefs"].map((h) => `<a href="${h}">${h.slice(1)}</a>`).join("");

// ---------- Fixtures: four real-world kinds of church site ----------
const SQ_PAGE = "https://cedarbend.church/";
const SQ_CSS = "https://static1.squarespace.com/static/versioned-site-css/5f2a19a01a15776de4032c29/263/5c5a519771c10ba3470d8101/5f2a19a01a15776de4032c43/1841/site.css?nocustom=true";
const squarespace = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Cedar Bend Church</title>
<link rel="stylesheet" type="text/css" href="https://assets.squarespace.com/universal/styles-compressed/user-account-core-cc552ab7d7ddd3b1ba3a-min.en-US.css">
<link rel="stylesheet" type="text/css" href="${SQ_CSS.replace("https:", "")}">
</head><body id="collection-5f2a"><header data-test="header" id="header" class="header theme-col--primary" data-section-theme="white">
<div class="header-title-logo"><a href="/" data-animation-role="header-element"><img elementtiming="nbf-header-logo-desktop" src="//images.squarespace-cdn.com/content/v1/5f2a19a01a15776de4032c29/0e26/Cedar+Bend+Wordmark.png" alt="Cedar Bend Church" style="display:block" fetchpriority="high" loading="eager"></a></div>
<nav class="header-nav-list"><div class="header-nav-item"><a href="/visit">Plan a Visit</a></div></nav></header>
<main><a href="/visit" class="sqs-block-button-element--medium sqs-button-element--primary sqs-block-button-element">Plan your visit</a>${filler}</main></body></html>`;
// Squarespace 7.1's site.css: the palette on :root, its own editing red on admin-only selectors, buttons through the palette.
const squarespaceCss = `:root{--white-hsl:0,0%,100%;--black-hsl:0,0%,0%;--safeLightAccent-hsl:186,59%,22%;--safeDarkAccent-hsl:0,0%,0%;--accent-hsl:186,59%,22%;--lightAccent-hsl:40,33%,93%;--darkAccent-hsl:0,0%,20%}
.sqsp-tooltip .buttons a.reject:hover{background-color:#f0523d}.sqs-action-overlay>div.remove:hover{background:#f0523d url('//assets.squarespace.com/x.png')}.sqs-action-overlay>div.remove-video:hover{background:#f0523d}
[data-section-theme="white"]{--primaryButtonBackgroundColor-hsl:var(--accent-hsl);--primaryButtonTextColor-hsl:var(--white-hsl)}
.sqs-button-element--primary{background-color:hsla(var(--primaryButtonBackgroundColor-hsl),1);color:hsla(var(--primaryButtonTextColor-hsl),1)}`;

const WP_PAGE = "https://gracechurch.org/";
const wordpress = `<!DOCTYPE html><html lang="en-US"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#ffffff"><title>Grace Church</title>
<link rel='stylesheet' id='wp-block-library-css' href='https://gracechurch.org/wp-includes/css/dist/block-library/style.min.css?ver=6.6.1' media='all' />
<link rel='stylesheet' id='astra-theme-css-css' href='https://gracechurch.org/wp-content/themes/astra/assets/css/minified/main.min.css?ver=4.6.4' media='all' />
<link rel='stylesheet' id='bootstrap-css' href='https://gracechurch.org/wp-content/plugins/events/bootstrap.min.css?ver=5' media='all' />
<link rel='stylesheet' id='grace-style-css' href='https://gracechurch.org/wp-content/themes/grace/style.css?ver=1.2' media='all' />
<link rel='stylesheet' id='print-css' href='https://gracechurch.org/wp-content/themes/grace/print.css' media='print' />
<link rel='stylesheet' href='https://cdn.othersite.example/widget.css' />
<link rel='stylesheet' id='grace-fonts-css' href='https://fonts.googleapis.com/css2?family=Lora:wght@400;700&#038;family=Open+Sans:wght@400;600&#038;display=swap' media='all' />
<style id='global-styles-inline-css'>:root{--wp--preset--color--black: #000000;--wp--preset--color--white: #ffffff;--wp--preset--color--vivid-cyan-blue: #0693e3;--wp--preset--color--primary: #7a2e3b;--wp--preset--color--accent: #c8963e;--wp--preset--font-family--primary: "Lora", serif;}
.has-vivid-cyan-blue-background-color{background-color: var(--wp--preset--color--vivid-cyan-blue) !important;}</style>
<script type="application/ld+json" class="yoast-schema-graph">{"@context":"https://schema.org","@graph":[{"@type":"Organization","@id":"https://gracechurch.org/#organization","name":"Grace Church","logo":{"@type":"ImageObject","url":"https:\\/\\/gracechurch.org\\/wp-content\\/uploads\\/2024\\/01\\/grace-schema-logo.png","width":512,"height":512}}]}</script>
<link rel="apple-touch-icon" href="https://gracechurch.org/wp-content/uploads/2024/01/cropped-icon-180x180.png" />
</head><body class="home"><header id="masthead" class="site-header"><div class="site-branding"><a href="https://gracechurch.org/" class="custom-logo-link" rel="home"><img width="300" height="80" src="https://gracechurch.org/wp-content/uploads/2024/01/grace-logo.png" class="custom-logo" alt="Grace Church" decoding="async" /></a></div>
<nav id="site-navigation" class="main-navigation"><a href="/visit">Plan Your Visit</a></nav></header><main>${filler}</main>
<footer><img src="https://gracechurch.org/wp-content/uploads/partner-logo.png" alt="Partner logo"></footer></body></html>`;
const wordpressCss = `/* Theme Name: Grace */ body{font-family:"Open Sans",sans-serif;color:#333}h1,h2,h3{font-family:"Lora",Georgia,serif}a{color:#7a2e3b}a:hover{color:#5b2230}
.wp-block-button__link{background-color:#7a2e3b;color:#fff}.site-footer a{color:#999}`;

const WIX_PAGE = "https://www.wellspringumc.org/";
const wix = `<!DOCTYPE html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Home | Wellspring UMC</title>
<style id="css_masterPage">:root{--color_0:255,255,255;--color_11:255,255,255;--color_15:0,0,0;--color_18:42,92,170;--color_48:40,52,118;--color_50:255,255,255;--wst-button-color-fill-primary:rgb(var(--color_48));--wst-button-color-text-primary:rgb(var(--color_50));--wst-color-text-primary:rgb(var(--color_15))}</style>
</head><body><div id="SITE_CONTAINER"><header id="SITE_HEADER" class="xU8fqS SITE_HEADER wixui-header"><div id="comp-kx1" class="comp-kx1 wixui-image">
<wow-image id="img_comp-kx1" class="HlRz5e" data-image-info="{&quot;containerId&quot;:&quot;comp-kx1&quot;,&quot;displayMode&quot;:&quot;fill&quot;,&quot;imageData&quot;:{&quot;width&quot;:369,&quot;height&quot;:369,&quot;uri&quot;:&quot;fb815e_5b4625159ce44b08a629cf3058b38fa5~mv2.png&quot;,&quot;name&quot;:&quot;Wellspring logo.png&quot;,&quot;displayMode&quot;:&quot;fill&quot;}}">
<img src="https://static.wixstatic.com/media/fb815e_5b4625159ce44b08a629cf3058b38fa5~mv2.png/v1/fill/w_80,h_80,al_c,q_85,usm_0.66_1.00_0.01,enc_avif,quality_auto/Wellspring%20logo.png" alt="" style="width:80px;height:80px;object-fit:cover"></wow-image></div></header>
<main>${filler}</main></div></body></html>`;

const CUSTOM_PAGE = "https://riverside.example/";
const custom = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><meta name="theme-color" content="#1f6f5c" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0b0b0b" media="(prefers-color-scheme: dark)"><title>Riverside</title>
<link rel="stylesheet" href="/css/site.css"><link rel="apple-touch-icon" sizes="120x120" href="/icon-120.png"><link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
<link href="https://fonts.googleapis.com/css?family=Montserrat:400,700|Material+Icons" rel="stylesheet"></head>
<body><nav class="topnav"><a href="/" class="brand"><svg class="site-logo" viewBox="0 0 120 40" role="img"><title>Riverside Community Church</title><path d="M0 0h10v10z" fill="#1f6f5c"/></svg></a>
<button class="menu-toggle"><svg viewBox="0 0 24 24"><path d="M3 6h18"/></svg></button></nav><main>${filler}</main></body></html>`;
const customCss = `.btn-primary{background:#1f6f5c;color:#fff}.btn{border-color:#1f6f5c}a{color:#145244}footer a{color:#888}`;

describe("reading the church's look", () => {
  test("Squarespace: the palette's accent, not Squarespace's own editing red; the header logo at 750w", () => {
    const b = brandFromPage(squarespace, SQ_PAGE, [squarespaceCss]);
    assert.equal(b.primary, toHex(parseColor("hsl(186,59%,22%)")));
    assert.equal(b.source, "css-variable");
    assert.equal(b.font, undefined);
    assert.equal(b.logoCandidates[0], "https://images.squarespace-cdn.com/content/v1/5f2a19a01a15776de4032c29/0e26/Cedar+Bend+Wordmark.png?format=750w");
    assert.deepEqual(stylesheetLinks(squarespace, SQ_PAGE), [SQ_CSS], "the per-site sitecss counts; Squarespace's shared CSS does not");
  });

  test("Squarespace without a palette property: the buttons win and the editing red never does", () => {
    const css = squarespaceCss.replace(/--accent-hsl:[^;]*;/, "").replace(/--safeLightAccent-hsl:[^;]*;/, "").replace("var(--accent-hsl)", "186,59%,22%");
    const b = brandFromPage(squarespace, SQ_PAGE, [css]);
    assert.equal(b.primary, toHex(parseColor("hsl(186,59%,22%)")));
    assert.equal(b.source, "buttons");
  });

  test("WordPress: the theme's primary preset, its accent, the heading font, and logos in order", () => {
    const b = brandFromPage(wordpress, WP_PAGE, [wordpressCss]);
    assert.equal(b.primary, "#7a2e3b");
    assert.equal(b.accent, "#c8963e");
    assert.equal(b.source, "css-variable");
    assert.equal(b.font, "Lora", "the font the headings use, from the Google Fonts link");
    assert.deepEqual(b.logoCandidates, [
      "https://gracechurch.org/wp-content/uploads/2024/01/grace-logo.png",
      "https://gracechurch.org/wp-content/uploads/2024/01/grace-schema-logo.png",
      "https://gracechurch.org/wp-content/uploads/2024/01/cropped-icon-180x180.png",
    ], "header logo, then structured data, then the home-screen icon; never the footer's partner logo");
    assert.deepEqual(stylesheetLinks(wordpress, WP_PAGE), ["https://gracechurch.org/wp-content/themes/grace/style.css?ver=1.2", "https://gracechurch.org/wp-content/themes/astra/assets/css/minified/main.min.css?ver=4.6.4"],
      "the church's theme file first; WordPress core, plugins, print and other sites' CSS are skipped");
  });

  test("Wix: the button fill from the site palette and the header logo image", () => {
    const b = brandFromPage(wix, WIX_PAGE, []);
    assert.equal(b.primary, "#283476");
    assert.equal(b.source, "css-variable");
    assert.match(b.logoCandidates[0], /^https:\/\/static\.wixstatic\.com\/media\/fb815e_5b4625159ce44b08a629cf3058b38fa5~mv2\.png/);
  });

  test("custom HTML: the light theme-color, a Google font without icon fonts, an inline SVG logo and the largest touch icon", () => {
    const b = brandFromPage(custom, CUSTOM_PAGE, [customCss]);
    assert.equal(b.primary, "#1f6f5c");
    assert.equal(b.source, "theme-color");
    assert.equal(b.accent, undefined, "the buttons agree with the theme-color, so there is no second color");
    assert.equal(b.font, "Montserrat");
    assert.match(b.logoCandidates[0], /^data:image\/svg\+xml;charset=utf-8,/);
    const svg = decodeURIComponent(b.logoCandidates[0].split(",").slice(1).join(","));
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" class="site-logo"/, "the inline logo gets its namespace");
    assert.equal(b.logoCandidates.filter((u) => u.startsWith("data:")).length, 1, "the menu icon is not a logo");
    assert.equal(b.logoCandidates[1], "https://riverside.example/apple-touch-icon.png");
  });

  test("custom HTML with no theme-color or properties: the most used button and link color", () => {
    const page = custom.replace(/<meta name="theme-color"[^>]*>/g, "").replace('<main>', '<main><a class="button" style="background-color:#8a1c7c;color:#fff" href="/give">Give</a>');
    const b = brandFromPage(page, CUSTOM_PAGE, [".button{background:#8a1c7c}.cta{background-color:#8a1c7c}a{color:#8a1c7c}nav a{color:#2b6cb0}"]);
    assert.equal(b.primary, "#8a1c7c");
    assert.equal(b.source, "buttons");
  });

  test("framework defaults, grays, near-white and near-black never count; one stray link color is not enough", () => {
    const css = [":root{--bs-primary:#0d6efd;--bs-primary-rgb:13,110,253;--e-global-color-primary:#6EC1E4;--e-global-color-accent:#61CE70;--primary-color:#f4f4f4;--brand:#0a0a0a}",
      ".btn-primary{background-color:#0d6efd}.btn{background:#333;color:#fff}.elementor-button{background-color:#61ce70}a{color:#0073aa}button{background:#f7f7f7}",
      ".sqsp-tooltip a:hover{background-color:#f0523d}a{color:#cc3366}"].join("");
    const page = `<html><head><meta name="theme-color" content="#ffffff"></head><body>${filler}</body></html>`;
    assert.equal(brandFromPage(page, CUSTOM_PAGE, [css]).primary, null);
    assert.equal(brandFromPage(page, CUSTOM_PAGE, ["nav a{color:#7a2e3b}"]).primary, null, "a single link rule is weight 2, under the bar");
  });

  test("a sub-brand's property is not the church color; Wix and Events Calendar names are", () => {
    assert.equal(brandFromPage("<html></html>", CUSTOM_PAGE, [":root{--lifechurch-now-accent:#ac85f4;--card-link-primary:#00b3e5}"]).primary, null);
    assert.equal(brandFromPage("<html></html>", CUSTOM_PAGE, [":root{--tec-color-accent-primary:#68923d}"]).primary, "#68923d");
    assert.equal(brandFromPage("<html></html>", CUSTOM_PAGE, [":root{--primary-text:#7a2e3b;--primary-light:#7a2e3b;--brand-hover:#7a2e3b}"]).primary, null);
  });

  test("Webflow's per-site CSS counts; at most two stylesheets, builder files first", () => {
    const page = `<link href="https://cdn.prod.website-files.com/60ec/css/stone.webflow.shared.767c93f30.min.css" rel="stylesheet">
<link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="/b.css"><link rel="stylesheet" href="/wp-content/uploads/elementor/css/post-8739.css">`;
    assert.deepEqual(stylesheetLinks(page, "https://austinstone.org/"), ["https://cdn.prod.website-files.com/60ec/css/stone.webflow.shared.767c93f30.min.css", "https://austinstone.org/wp-content/uploads/elementor/css/post-8739.css"]);
  });

  test("Webflow's newer <site>.shared.<hash>.min.css counts; a WordPress child theme comes before the stock theme's color skin", () => {
    const wf = `<link href="https://cdn.prod.website-files.com/66f3/css/church-of-whitestone-f4af6c.shared.cef0b6e3f.min.css" rel="stylesheet">`;
    assert.deepEqual(stylesheetLinks(wf, "https://yourwhitestone.org/"), ["https://cdn.prod.website-files.com/66f3/css/church-of-whitestone-f4af6c.shared.cef0b6e3f.min.css"]);
    const wp = `<link rel="stylesheet" href="/wp-content/themes/bethlehem/style.min.css"><link rel="stylesheet" href="/wp-content/themes/bethlehem/assets/css/bethlehem-color.min.css">
<link rel="stylesheet" href="/wp-content/themes/bethlehem-child/bethlehem-child-style.min.css">`;
    assert.deepEqual(stylesheetLinks(wp, "https://fpc.org/"), ["https://fpc.org/wp-content/themes/bethlehem-child/bethlehem-child-style.min.css", "https://fpc.org/wp-content/themes/bethlehem/style.min.css"]);
  });

  test("an editor skin's primary, Bootstrap 3, UIkit and social colors, and library dropdowns never become the church color", () => {
    const css = [":root{--base-primary:#ff791d;--color-primary:var(--base-primary)}.tox .tox-button{background-color:var(--color-primary)}" +
      ".btn-danger{background-color:#d9534f}.btn-danger:hover{background-color:#c9302c}.uk-button-primary{background-color:#1e87f0}.uk-button-primary:hover{background-color:#0f7ae5}" +
      ".share-facebook a{color:#3b5998}.share-facebook a:hover{color:#2d4373}.tag-wrap .ui-autocomplete li a{color:#92bce0;background-color:#92bce0}.tt-suggestion a{color:#92bce0}" +
      ".wpconsent-accept-button{background-color:#ffb400}.btn-primary{background-color:#008489}"];
    const b = brandFromPage("<html></html>", CUSTOM_PAGE, css);
    assert.equal(b.primary, "#008489");
    assert.equal(b.accent, undefined);
    // The same property used by the church's own buttons still counts.
    assert.equal(brandFromPage("<html></html>", CUSTOM_PAGE, [":root{--color-primary:#17545b}.tox .tox-button{background-color:var(--color-primary)}.btn{color:var(--color-primary)}"]).primary, "#17545b");
  });

  test("no header tag: logos in the top of the body; an image in the home link counts after named ones", () => {
    const page = `<html><body><div class="top"><a href="/"><img src="/img/crest.png" alt="Grace"></a><div class="site-title"><img src="/img/wordmark.png" alt="Grace"></div></div></body></html>`;
    assert.deepEqual(findLogos(page, "https://grace.example/"), ["https://grace.example/img/wordmark.png", "https://grace.example/img/crest.png"]);
  });
});

describe("the home-page check carries the brand", () => {
  const page = `<!doctype html><html><head><meta name="viewport" content="width=device-width"><title>City Reach</title>
<link rel="stylesheet" href="/theme/site.css"><link rel="stylesheet" href="https://cdn.other.example/x.css"></head>
<body><header><a class="logo" href="/"><img src="/img/logo.png" alt="City Reach"></a></header><a href="/visit">Plan a Visit</a><a href="/kids">Kids</a>${filler}</body></html>`;

  test("fetches the church's own stylesheet, never another site's, and returns website.brand", async () => {
    const calls = stubFetch([
      [/cityreach\.example\/theme\/site\.css/, () => new Response(":root{--brand-color:#d20021}", { headers: { "content-type": "text/css" } })],
      [/cityreach\.example/, () => html(page)],
    ]);
    const w = await checkWebsite("https://cityreach.example/");
    assert.equal(w.checked, true);
    assert.deepEqual(w.brand, { primary: "#d20021", logoCandidates: ["https://cityreach.example/img/logo.png"], source: "css-variable" });
    assert.equal(calls.some((c) => /cdn\.other\.example/.test(c.url)), false);
  });

  test("a stylesheet that fails or is not CSS leaves the rest of the brand", async () => {
    stubFetch([[/site\.css/, () => html("<html>not css</html>")], [/cityreach\.example/, () => html(page)]]);
    const w = await checkWebsite("https://cityreach.example/");
    assert.equal(w.brand.primary, null);
    assert.deepEqual(w.brand.logoCandidates, ["https://cityreach.example/img/logo.png"]);
  });
});

describe("contrast math", () => {
  test("parses hex, rgb, hsl and the bare triples builders store", () => {
    assert.deepEqual(parseColor("#abc"), { r: 170, g: 187, b: 204, a: 1 });
    assert.equal(toHex(parseColor("rgb(23 84 91)")), "#17545b");
    assert.equal(toHex(parseColor("rgba(23, 84, 91, 0.5)")), "#17545b");
    assert.equal(parseColor("rgba(23, 84, 91, 0.5)").a, 0.5);
    assert.equal(toHex(parseColor("hsl(0, 100%, 50%)")), "#ff0000");
    assert.equal(toHex(parseColor("47,93,168")), "#2f5da8");
    assert.equal(toHex(parseColor("0,100%,50%")), "#ff0000");
    assert.equal(parseColor("red"), null);
    assert.equal(parseColor("var(--x)"), null);
  });

  test("luminance and the WCAG contrast ratio", () => {
    assert.equal(luminance(parseColor("#ffffff")), 1);
    assert.equal(luminance(parseColor("#000000")), 0);
    assert.equal(Math.round(contrast("#ffffff", "#000000") * 100) / 100, 21);
    assert.equal(Math.round(contrast("#767676", "#ffffff") * 100) / 100, 4.54);
  });

  test("darkens a light color to 4.5:1 on white and the off-white page, keeping its hue", () => {
    for (const c of ["#f5c400", "#61ce70", "#ff791d", "#00a3e1", "#fbc57c"]) {
      const out = ensureContrast(c, ["#ffffff", "#f7f5f0"], 4.5);
      assert.ok(contrast(out, "#ffffff") >= 4.5 && contrast(out, "#f7f5f0") >= 4.5, `${c} -> ${out}`);
      assert.ok(contrast(out, "#ffffff") < 6, `${c} -> ${out} moved no further than needed`);
      const hue = (x) => { const { r, g, b } = parseColor(x); return Math.round(Math.atan2(Math.sqrt(3) * (g - b), 2 * r - g - b) * 180 / Math.PI); };
      assert.ok(Math.abs(hue(out) - hue(c)) <= 3, `${c} -> ${out} keeps its hue`);
    }
    assert.equal(ensureContrast("#17545b", ["#ffffff"], 4.5), "#17545b", "a color that already passes is left alone");
  });

  test("the rounded #rrggbb still meets the ratio (rounding once left #98f18c at 4.47 and #412105 at 2.98)", () => {
    const t = themeColors({ primary: "#98f18c" });
    assert.ok(contrast(t.primary, "#f7f5f0") >= 4.5 && contrast(t.primary, "#ffffff") >= 4.5, t.primary);
    const d = themeColors({ primary: "#412105" });
    assert.ok(contrast(d.primaryOnDark, "#1f1f25") >= 3 && contrast(d.primaryOnDark, "#131318") >= 3, d.primaryOnDark);
    for (let i = 0; i < 3000; i++) {
      const hex = "#" + Math.floor(((i * 2654435761) >>> 0) % 0x1000000).toString(16).padStart(6, "0");
      const c = themeColors({ primary: hex, accent: hex });
      if (!c.primary) continue;
      assert.ok(Math.min(contrast(c.primary, "#ffffff"), contrast(c.primary, "#f7f5f0")) >= 4.5, `${hex} -> ${c.primary}`);
      assert.ok(Math.min(contrast(c.accent, "#ffffff"), contrast(c.accent, "#f7f5f0")) >= 3, `${hex} -> accent ${c.accent}`);
      assert.ok(Math.min(contrast(c.primaryOnDark, "#131318"), contrast(c.primaryOnDark, "#1f1f25")) >= 3, `${hex} -> dark ${c.primaryOnDark}`);
    }
  });

  test("lightens against a dark page", () => {
    const out = ensureContrast("#283476", ["#131318", "#1f1f25"], 3);
    assert.ok(contrast(out, "#131318") >= 3 && contrast(out, "#1f1f25") >= 3);
    assert.ok(luminance(parseColor(out)) > luminance(parseColor("#283476")));
  });

  test("themeColors: primary for text and the ring, a 3:1 accent, onPrimary, and nothing for an unusable color", () => {
    const t = themeColors({ primary: "#f5c400", accent: "#61ce70" });
    assert.ok(contrast(t.primary, "#ffffff") >= 4.5);
    assert.ok(contrast(t.accent, "#ffffff") >= 3);
    assert.equal(t.onPrimary, "#ffffff");
    assert.ok(contrast(t.primaryOnDark, "#131318") >= 3);
    assert.deepEqual(themeColors({ primary: "#777777" }), { primary: null, accent: null, onPrimary: null, primaryOnDark: null, onWash: null });
    assert.deepEqual(themeColors(null).primary, null);
    assert.equal(usable(parseColor("#fafafa")), false);
    assert.equal(usable(parseColor("#0b1f3a")), true, "a deep navy is a color, not black");
  });
});

// ---------- Logo bytes ----------
const be32 = (n) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const png = (w, h) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h), 8, 6, 0, 0, 0, 0, 0, 0, 0, ...new Array(200).fill(7)]);
const enc = (s) => new TextEncoder().encode(s);
const CLEAN_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 228 62"><defs><linearGradient id="g"><stop offset="0" stop-color="#17545b"/></linearGradient><path id="arch" d="M0 0h20v20z"/></defs>
<style>.a{fill:url(#g)}</style><use xlink:href="#arch"/><path class="a" d="M10 10h40v40z"/><image href="data:image/png;base64,iVBORw0KGgo=" width="4" height="4"/></svg>`;

describe("SVG checks", () => {
  test("a clean logo passes, with its size from the viewBox", () => {
    assert.equal(svgProblem(CLEAN_SVG), null);
    assert.deepEqual(svgSize(CLEAN_SVG), { width: 228, height: 62 });
    assert.deepEqual(svgSize('<svg width="120px" height="40">'), { width: 120, height: 40 });
  });

  const bad = {
    "a script": '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    "an encoded javascript: link": '<svg xmlns="http://www.w3.org/2000/svg"><a href="&#106;avascript:alert(1)"><path d="M0 0"/></a></svg>',
    "a split javascript: link": '<svg xmlns="http://www.w3.org/2000/svg"><a xlink:href="java\nscript:alert(1)"><path d="M0 0"/></a></svg>',
    "an onload handler": '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><path d="M0 0"/></svg>',
    "an onclick on a shape": '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0" onclick="x()"/></svg>',
    "foreignObject": '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>hi</div></foreignObject></svg>',
    "an outside image": '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/></svg>',
    "a protocol-relative use": '<svg xmlns="http://www.w3.org/2000/svg"><use xlink:href="//evil.example/s.svg#a"/></svg>',
    "an outside url() in CSS": '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:url(http://evil.example/p)}</style></svg>',
    "a font fetch": '<svg xmlns="http://www.w3.org/2000/svg"><style>@font-face{src:url("https://fonts.example/f.woff")}</style></svg>',
    "@import": '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "x.css";</style></svg>',
    "entities": '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg">&a;</svg>',
    "an iframe": '<svg xmlns="http://www.w3.org/2000/svg"><iframe src="x"/></svg>',
    "an html page": "<!doctype html><html><body><svg></svg></body></html>",
    "a use pointing nowhere": '<svg xmlns="http://www.w3.org/2000/svg"><use href="#sprite-logo"/></svg>',
    "a prefixed script": '<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/2000/svg"><x:script>alert(1)</x:script></svg>',
    "an XHTML script": '<svg xmlns="http://www.w3.org/2000/svg" xmlns:h="http://www.w3.org/1999/xhtml"><h:script>alert(1)</h:script></svg>',
    "a prefixed outside href": '<svg xmlns="http://www.w3.org/2000/svg" xmlns:l="http://www.w3.org/1999/xlink"><image l:href="https://evil.example/x.png"/></svg>',
    "a <set> that rewrites an href": '<svg xmlns="http://www.w3.org/2000/svg"><a href="#p"><set attributeName="href" to="https://evil.example/"/><path id="p" d="M0 0"/></a></svg>',
    "an <animate> that rewrites a use": '<svg xmlns="http://www.w3.org/2000/svg"><use href="#p"><animate attributeName="xlink:href" values="x.svg#p"/></use><path id="p" d="M0 0"/></svg>',
    "a CSS-escaped url()": '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{fill:u\\72l(https://evil.example/p)}</style><path class="a" d="M0 0"/></svg>',
    "image-set()": '<svg xmlns="http://www.w3.org/2000/svg"><path style="fill:image-set(&quot;https://evil.example/p&quot; 1x)" d="M0 0"/></svg>',
    "an xml-stylesheet": '<?xml-stylesheet type="text/css" href="https://evil.example/s.css"?><svg xmlns="http://www.w3.org/2000/svg"></svg>',
    "over 200 KB": `<svg xmlns="http://www.w3.org/2000/svg"><path d="${"M0 0 ".repeat(41000)}"/></svg>`,
  };
  for (const [name, svg] of Object.entries(bad)) {
    test(`rejects ${name}`, () => assert.notEqual(svgProblem(svg), null));
  }
});

test("reading the look stays quick on a page of unclosed <header>, <nav> and <svg> tags", () => {
  for (const html of ["<header>".repeat(250000), "<nav><img class=logo src=/a.png>".repeat(60000), "<header>" + '<svg class="logo"><path d="M0 0"/>'.repeat(60000)]) {
    const t = Date.now();
    brandFromPage(html, "https://grace.example/");
    assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms`);
  }
});

describe("fetching and saving the logo", () => {
  const svgRes = (s, type = "image/svg+xml") => new Response(s, { headers: { "content-type": type } });
  const img = (b, type) => new Response(b, { headers: { "content-type": type } });

  test("a clean SVG, an SVG served as XML, and a real PNG pass; a script SVG, a tiny icon and a GIF do not", async () => {
    stubFetch([
      [/clean\.svg/, () => svgRes(CLEAN_SVG)],
      [/xml\.svg/, () => svgRes(CLEAN_SVG, "text/xml")],
      [/evil\.svg/, () => svgRes('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>')],
      [/logo\.png/, () => img(png(342, 192), "image/png")],
      [/tiny\.png/, () => img(png(12, 12), "image/png")],
      [/fake\.png/, () => img(enc("<html>hello</html>".padEnd(40)), "image/png")],
      [/anim\.gif/, () => img(enc("GIF89a....."), "image/gif")],
    ]);
    assert.deepEqual(await fetchLogo("https://grace.example/clean.svg").then((r) => [r.ok, r.type, r.width, r.height]), [true, "image/svg+xml", 228, 62]);
    assert.equal((await fetchLogo("https://grace.example/xml.svg")).type, "image/svg+xml");
    assert.match((await fetchLogo("https://grace.example/evil.svg")).reason, /SVG has a script/);
    assert.deepEqual(await fetchLogo("https://grace.example/logo.png").then((r) => [r.ok, r.width, r.height]), [true, 342, 192]);
    assert.match((await fetchLogo("https://grace.example/tiny.png")).reason, /not logo-sized/);
    assert.match((await fetchLogo("https://grace.example/fake.png")).reason, /bytes are not image\/png/);
    assert.match((await fetchLogo("https://grace.example/anim.gif")).reason, /type image\/gif/);
    assert.equal(logoSizeOk(1408, 1408), true);
    assert.equal(logoSizeOk(2000, 100), false, "a banner strip is not a logo");
  });

  test("the shared image address rules: no private hosts, redirects checked by hand", async () => {
    const calls = stubFetch([
      [/grace\.example\/hop\.png/, () => redirect("http://192.168.1.10/logo.png", 302)],
      [/192\.168/, () => img(png(200, 80), "image/png")],
    ]);
    assert.equal((await fetchLogo("http://localhost/logo.png")).reason, "not a public web address");
    assert.equal((await fetchLogo("https://grace.example/hop.png")).reason, "redirected off the public web");
    assert.equal(calls.some((c) => /192\.168/.test(c.url)), false);
    assert.equal(calls[0].redirect, "manual");
  });

  test("an inline SVG from the page is checked without any fetch", async () => {
    const calls = stubFetch([]);
    const ok = await fetchLogo("data:image/svg+xml;charset=utf-8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><path d="M0 0h10v10z"/></svg>'));
    assert.deepEqual([ok.ok, ok.width, ok.height], [true, 120, 40]);
    assert.equal((await fetchLogo("data:image/svg+xml," + encodeURIComponent('<svg onload="x()"></svg>'))).ok, false);
    assert.equal((await fetchLogo("data:image/svg+xml;base64," + btoa(CLEAN_SVG))).ok, true);
    assert.equal(calls.length, 0);
  });

  test("saves the first good candidate under logo:<id> with its type and size; nothing usable saves nothing", async () => {
    stubFetch([[/bad\.png/, () => img(png(10, 10), "image/png")], [/good\.svg/, () => svgRes(CLEAN_SVG)]]);
    const env = { AUDITS: blobKv() };
    const r = await saveLogo(env, "grace-church-1a2b3c4d", ["https://grace.example/bad.png", "https://grace.example/good.svg"]);
    assert.deepEqual(r.logo, { stored: true, type: "image/svg+xml", width: 228, height: 62 });
    assert.equal(r.misses.length, 1);
    const saved = env.AUDITS.m.get("logo:grace-church-1a2b3c4d");
    assert.deepEqual(saved.opts.metadata, { type: "image/svg+xml", width: 228, height: 62, from: "https://grace.example/good.svg" });
    assert.equal(saved.opts.expirationTtl, 60 * 60 * 24 * 365);
    const none = { AUDITS: blobKv() };
    assert.equal((await saveLogo(none, "grace-church-1a2b3c4d", ["https://grace.example/bad.png"])).logo, null);
    assert.equal(none.AUDITS.m.size, 0);
  });
});

function blobKv() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k)?.value; return v === undefined ? null : type === "json" ? JSON.parse(v) : v; },
    async put(k, value, opts = {}) { m.set(k, { value: typeof value === "string" ? value : Uint8Array.from(value), opts }); },
    async getWithMetadata(k, type) {
      const e = m.get(k);
      if (!e) return { value: null, metadata: null };
      const v = typeof e.value === "string" ? enc(e.value) : e.value;
      return { value: type === "arrayBuffer" ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : e.value, metadata: e.opts.metadata ?? null };
    },
  };
}

describe("GET /logo", () => {
  const BASE = "https://front-door.example.workers.dev";
  const get = (env, path) => worker.fetch(new Request(BASE + path), env);
  const ID = "grace-church-1a2b3c4d";

  test("an SVG goes out as image/svg+xml with a policy that runs and loads nothing", async () => {
    const env = { AUDITS: blobKv() };
    await env.AUDITS.put(`logo:${ID}`, enc(CLEAN_SVG), { metadata: { type: "image/svg+xml" } });
    const res = await get(env, `/logo?id=${ID}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/svg+xml");
    assert.equal(res.headers.get("content-security-policy"), "default-src 'none'; style-src 'unsafe-inline'");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("cache-control"), "public, max-age=86400");
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(await res.text(), CLEAN_SVG);
  });

  test("a raster logo goes out with its own type and default-src 'none'", async () => {
    const env = { AUDITS: blobKv() };
    await env.AUDITS.put(`logo:${ID}`, png(342, 192), { metadata: { type: "image/png", width: 342, height: 192 } });
    const res = await get(env, `/logo?id=${ID}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.equal(res.headers.get("content-security-policy"), "default-src 'none'");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });

  test("404 when missing, for a bad id, for a POST, and for stored bytes that are not a clean logo of their type", async () => {
    const env = { AUDITS: blobKv() };
    let res = await get(env, `/logo?id=${ID}`);
    assert.equal(res.status, 404);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal((await get(env, "/logo?id=../photo:x")).status, 404);
    assert.equal((await get(env, "/logo")).status, 404);
    await env.AUDITS.put("logo:dirty-svg-1", enc('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'), { metadata: { type: "image/svg+xml" } });
    await env.AUDITS.put("logo:html-logo-1", enc("<!doctype html><html></html>".padEnd(64)), { metadata: { type: "image/png" } });
    await env.AUDITS.put("logo:html-type-1", enc("<html></html>"), { metadata: { type: "text/html" } });
    for (const id of ["dirty-svg-1", "html-logo-1", "html-type-1"]) assert.equal((await get(env, `/logo?id=${id}`)).status, 404, id);
    res = await worker.fetch(new Request(`${BASE}/logo?id=${ID}`, { method: "POST" }), env);
    assert.equal(res.status, 404);
    assert.equal(servableLogo(enc(CLEAN_SVG), "image/svg+xml"), true);
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
  scores: { overall: { grade: "B" }, areas: { google: { grade: "B" }, reviews: { grade: null }, website: { grade: "C" }, social: { grade: "B" } } },
  notes: { summary: "Summary.", areas: {}, fixes: [{ title: "Add a Plan Your Visit page", why: "Families look for it." }] },
  google: { found: true, rating: 4.6, reviewCount: 80, hoursListed: true, website: "https://cityreachchurch.com/" },
  nearMe: { searches: [{ from: "north", milesAway: 4, checked: true, rank: 3 }] },
  website: { checked: true, serviceTimes: { found: true }, planVisit: { found: false }, kids: { found: true }, socials: { facebook: {} }, sermons: { found: true, sources: ["YouTube"] } },
  speed: { ok: true, score: 60 }, reach: null, ...x,
});
const BRAND = { primary: "#17545b", accent: "#2b7a83", onPrimary: "#ffffff", primaryOnDark: "#3f9aa5", font: "Lora", logo: { stored: true, type: "image/svg+xml", width: 228, height: 62 }, source: "css-variable" };

function classes() {
  const set = new Set();
  return { set, add: (c) => set.add(c), remove: (c) => set.delete(c), contains: (c) => set.has(c), toggle() {} };
}

async function renderScorecard({ data, search = `?id=${ID}`, result } = {}) {
  const els = {};
  const el = (id) => (els[id] ||= { innerHTML: "", textContent: "", style: {} });
  const classList = classes();
  const context = {
    window: { FRONT_DOOR_DATA: data },
    document: { getElementById: el, title: "", documentElement: { classList } },
    location: { search, href: "https://bigsplash.video/front-door/" + search },
    fetch: async () => new Response(JSON.stringify(result ?? {}), { status: result ? 200 : 404 }),
    URLSearchParams, URL, Response, Date, Intl, Number, String, JSON, Math, Object, Array, Promise, console, setTimeout, clearTimeout,
  };
  vm.createContext(context);
  vm.runInContext(inlineScripts(scorecard), context);
  await new Promise((r) => setTimeout(r, 30));
  return { html: el("app").innerHTML, style: el("brand-style").textContent, cobrand: classList.contains("cobrand") };
}

const pick = (h, re) => (h.match(re) || []).join("\n");

const hero = (h) => (h.match(/<section class="hero[^"]*">[\s\S]*?<\/section>/) || [""])[0];
const logoTag = (h) => (h.match(/<img src="[^"]*\/logo\?[^>]*>/) || [""])[0];

describe("co-branded scorecard", () => {
  test("with a brand: the logo leads the header from /logo, the church color and font, and every fact row kept", async () => {
    const plain = await renderScorecard({ result: audit() });
    const r = await renderScorecard({ result: audit({ brand: BRAND }) });
    assert.equal(r.cobrand, true, "<html> gets .cobrand");
    assert.match(r.style, /--brand: #17545b;/);
    assert.match(r.style, /--on-brand: #ffffff;/);
    assert.match(r.style, /--brand-accent: #2b7a83;/);
    assert.match(r.style, /--brand-wash: #e8eeef;/, "a soft tint of the church color behind the header");
    assert.match(r.style, /--brand-font: "Lora";/);
    assert.match(r.style, /@import url\("https:\/\/fonts\.googleapis\.com\/css2\?family=Lora&display=swap"\);/);
    assert.match(r.style, /family=Lora:wght@700/);
    const h = hero(r.html);
    assert.match(h, /^<section class="hero has-logo"><div class="church-mark"><span class="church-logo"><img /, "the logo opens the header, above the name and the grade");
    const img = logoTag(h);
    assert.match(img, new RegExp(`^<img src="${API}/logo\\?id=${ID}" alt="City Reach Church logo" width="228" height="62" style="--logo-w: \\d+px; --logo-w-sm: \\d+px" crossorigin="anonymous"`));
    assert.match(img, /onload="logoTone\(this\)" onerror="logoGone\(this\)"/);
    assert.match(h, /<h1>City Reach Church<\/h1>/);
    assert.match(h, /<div class="grade"><b>B<\/b>/);
    // Facts, not-checked states, fixes, the button and the footer are the same as the Big Splash look.
    for (const re of [/<ul class="facts">[\s\S]*?<\/ul>/g, /<span class="badge[^"]*">[^<]*<\/span>/g, /<ol class="fixes">[\s\S]*?<\/ol>/g, /<footer>[\s\S]*?<\/footer>/g, /<a class="btn"[^>]*>Book a call with our team<\/a>/g]) {
      assert.equal(pick(r.html, re), pick(plain.html, re), String(re));
    }
    assert.match(r.html, /<span class="badge none">Not checked<\/span>/);
  });

  test("without a brand, or with no usable color and no logo, the page is the Big Splash dark look exactly", async () => {
    const before = await renderScorecard({ result: audit() });
    assert.equal(before.cobrand, false);
    assert.equal(before.style, "");
    assert.match(before.html, /<section class="hero">\s*<div><p class="eyebrow"><img src="\/assets\/images\/starburst-lime-solid\.svg" alt="">Front Door Audit · [^<]+<\/p>\s*<h1>City Reach Church<\/h1>/);
    const noLogo = { ...BRAND, logo: null };
    for (const brand of [null, { ...noLogo, primary: null }, { ...noLogo, primary: "red;} body{display:none" }, { ...noLogo, primary: "#17545b; color: red" }, { ...BRAND, primary: null, logo: { stored: false } }]) {
      const r = await renderScorecard({ result: audit({ brand }) });
      assert.equal(r.html, before.html, JSON.stringify(brand));
      assert.equal(r.cobrand, false);
      assert.equal(r.style, "");
    }
  });

  test("a logo with no usable color still leads, on a neutral look: ink color, white header, green good marks", async () => {
    for (const primary of [null, "red;} body{display:none"]) {
      const r = await renderScorecard({ result: audit({ brand: { ...BRAND, primary, accent: null, onPrimary: null } }) });
      assert.equal(r.cobrand, true);
      assert.match(r.style, /:root \{ --brand: #131318; --on-brand: #ffffff; --brand-accent: #131318; --brand-wash: #ffffff; --good: #1d6b45;/);
      assert.equal(/display:none|red;/.test(r.style), false, "the bad value never reaches the CSS");
      assert.match(hero(r.html), /^<section class="hero has-logo"><div class="church-mark">/);
    }
    // No audit id to fetch the logo by: no logo, and with no color either, the dark look.
    const noId = await renderScorecard({ search: "", data: audit({ brand: { ...BRAND, primary: null } }) });
    assert.equal(noId.cobrand, false);
  });

  test("no stored logo: the church's name in its color and font leads the header; a bad font name falls back to Inter", async () => {
    const r = await renderScorecard({ result: audit({ brand: { ...BRAND, logo: null, font: 'Lora");@import "x' } }) });
    assert.match(r.html, /<section class="hero">\s*<div><p class="eyebrow">[\s\S]*?<\/p>\s*<h1>City Reach Church<\/h1>/);
    assert.equal(/\/logo\?|church-mark/.test(r.html), false);
    assert.equal(/@import/.test(r.style), false);
    assert.match(r.style, /--brand-font: "Inter";/);
    assert.match(scorecard, /html\.cobrand \.hero h1 \{ color: var\(--brand\); \}/, "the name takes the church color");
    assert.match(scorecard, /html\.cobrand \.hero\.has-logo h1 \{ color: var\(--white\); font-size: clamp\(/, "beside a logo the name steps back to ink");
    const inter = await renderScorecard({ result: audit({ brand: { ...BRAND, font: "Inter" } }) });
    assert.equal(/@import/.test(inter.style), false);
  });

  test("a red church color leaves good marks green, so they never look like the red bad ones", async () => {
    assert.match((await renderScorecard({ result: audit({ brand: { ...BRAND, primary: "#d20021" } }) })).style, /--good: #1d6b45;/);
    assert.match((await renderScorecard({ result: audit({ brand: BRAND }) })).style, /--good: #17545b;/);
  });

  test("the page's CSS: a black strip on top, the church header on a full-width wash, a light body in the church color", () => {
    assert.match(scorecard, /html\.cobrand header\.top \{[^}]*background: var\(--ink\);[^}]*box-shadow: 0 0 0 100vmax var\(--ink\);/);
    assert.match(scorecard, /html\.cobrand header\.top \{[^}]*flex-direction: row-reverse;/, "'Front Door Audit' left, the Big Splash logo right");
    assert.match(scorecard, /html\.cobrand \.hero \{ border-image: linear-gradient\(to top, var\(--line\) 1px, var\(--brand-wash\) 1px\) 0 fill \/ 0 \/ 0 100vmax;/);
    assert.match(scorecard, /html\.cobrand \.church-mark \{ grid-column: 1 \/ -1;/, "the logo spans the top of the header");
    assert.match(scorecard, /html\.cobrand \.church-logo img \{[^}]*width: var\(--logo-w, 320px\); max-width: 100%;/);
    assert.match(scorecard, /@media \(max-width: 640px\) \{[\s\S]*?html\.cobrand \.church-logo img \{ width: var\(--logo-w-sm, 240px\); \}/);
    assert.match(scorecard, /html\.cobrand \.church-logo\.light \{ background: var\(--brand\);/);
    assert.match(scorecard, /html\.cobrand \.church-logo\.mixed \{ background: #131318;/);
    assert.match(scorecard, /html\.cobrand \.church-logo\.solid \{ background: #fff;/);
    assert.match(scorecard, /html\.cobrand, html\.cobrand body \{ background: var\(--soft\); \}/);
    assert.match(scorecard, /html\.cobrand \{[^}]*--lime: var\(--brand\);/);
    assert.match(scorecard, /html\.cobrand \.grade b \{ color: var\(--brand\); \}/);
    assert.match(scorecard, /html\.cobrand \.btn \{ color: var\(--on-brand\); \}/);
    assert.match(scorecard, /html\.cobrand h1, html\.cobrand h2[^{]*\{ font-family: var\(--brand-font\), "Inter"/);
    assert.match(scorecard, /<style id="brand-style"><\/style>/);
    assert.match(scorecard, /<header class="top"><a href="\/church\/"><img src="\/assets\/images\/logo-bigsplash-white-lime\.svg" alt="Big Splash"><\/a><span>Front Door Audit<\/span><\/header>/);
  });
});

describe("logo size and a logo that fails to load", () => {
  // logoWidth() from each page, run on its own.
  const sizer = (page) => {
    const fn = page.match(/function logoWidth\(logo, area, maxH, maxW\) \{[\s\S]*?\n\}/)[0];
    return (logo, ...args) => vm.runInNewContext(`${fn}; logoWidth(logo, ${args.join(", ")});`, { logo });
  };
  for (const [name, page] of [["scorecard", scorecard], ["walkthrough", walkthrough]]) {
    test(`${name}: a square mark and a long wordmark get about the same area, within the caps`, () => {
      const width = sizer(page);
      const square = width({ width: 1408, height: 1408, type: "image/webp" }, 46000, 150, 460);
      const wordmark = width({ width: 1319, height: 315, type: "image/webp" }, 46000, 150, 460);
      assert.equal(square, 150, "a square mark stops at the height cap");
      assert.ok(Math.abs(wordmark * (wordmark * 315 / 1319) - 46000) < 1500, `wordmark ${wordmark}px wide`);
      assert.equal(width({ width: 982, height: 186, type: "image/png" }, 46000, 150, 460), 460, "a very long wordmark stops at the width cap");
      assert.equal(width({ width: 120, height: 40, type: "image/png" }, 46000, 150, 460), 180, "a small raster logo grows to 1.5 times its pixels at most");
      assert.equal(width({ width: 84, height: 20, type: "image/svg+xml" }, 46000, 150, 460) > 400, true, "an SVG scales freely");
      assert.equal(width({ type: "image/svg+xml" }, 24000, 112, 310), 268, "no size: drawn as a 3:1 wordmark");
    });
  }

  test("scorecard: logoGone() takes the logo out and lets the name in the church color lead", () => {
    const fn = scorecard.match(/function logoGone\(img\) \{[\s\S]*?\n\}/)[0];
    const heroClasses = classes();
    heroClasses.add("hero"); heroClasses.add("has-logo");
    let removed = false;
    const img = { closest: (sel) => (sel === ".hero" ? { classList: heroClasses } : sel === ".church-mark" ? { remove: () => { removed = true; } } : null) };
    vm.runInNewContext(`${fn}; logoGone(img);`, { img });
    assert.equal(removed, true);
    assert.equal(heroClasses.contains("has-logo"), false);
  });
});

async function renderWalkthrough({ search = `?id=${ID}`, result = null } = {}) {
  const els = {};
  const node = (id) => ({ id, innerHTML: "", textContent: "", hidden: id === "grade", href: "", style: {}, children: [], classList: classes(),
    appendChild(c) { this.children.push(c); }, setAttribute() {}, addEventListener() {}, closest() { return node("vsl"); } });
  const el = (id) => (els[id] ||= node(id));
  const classList = classes();
  const context = {
    window: { addEventListener() {} },
    document: { getElementById: el, querySelector: () => node("footer"), createElement: (t) => node(t), body: node("body"), title: "", documentElement: { classList } },
    location: { search, href: "https://bigsplash.video/frontdoor/walkthrough/" + search },
    fetch: async () => new Response(JSON.stringify(result ?? {}), { status: result ? 200 : 404 }),
    URLSearchParams, URL, Response, AbortController, Date, Number, String, JSON, Math, Object, Array, Promise, Map, console, setTimeout, clearTimeout,
  };
  context.window.document = context.document;
  vm.createContext(context);
  vm.runInContext(inlineScripts(walkthrough), context);
  await new Promise((r) => setTimeout(r, 30));
  return { logo: el("logo-slot").innerHTML, style: el("brand-style").textContent, cobrand: classList.contains("cobrand"), headline: el("headline").innerHTML,
    hasLogo: el("hero").classList.contains("has-logo"), el, run: (code) => vm.runInContext(code, context) };
}

describe("logo chips", () => {
  // logoTone() on both pages, run on a stand-in canvas: all white ink gets the church-color chip; white words beside a
  // colored mark get a dark chip; a logo with no see-through pixels gets a white card; dark ink gets none.
  const tone = (page, pixels) => {
    const fn = page.match(/function logoTone\(img\) \{[\s\S]*?\n\}/)[0];
    const added = [];
    const document = { createElement: () => ({ getContext: () => ({ drawImage() {}, getImageData: () => ({ data: Uint8ClampedArray.from(pixels.flat()) }) }) }) };
    const img = { naturalWidth: 300, naturalHeight: 100, parentNode: { classList: { add: (c) => added.push(c) } } };
    vm.runInNewContext(`${fn}; logoTone(img);`, { document, img });
    return added;
  };
  const clear = [0, 0, 0, 0], white = [255, 255, 255, 255], gold = [176, 120, 40, 255], black = [10, 10, 10, 255];
  const logo = (ink) => [...Array(10).fill(clear), ...ink];
  for (const [name, page] of [["scorecard", scorecard], ["walkthrough", walkthrough]]) {
    test(`${name}: white logo, white words with a gold mark, a logo on its own box, and a dark logo`, () => {
      assert.deepEqual(tone(page, logo(Array(6).fill(white))), ["light"]);
      assert.deepEqual(tone(page, logo([white, white, gold, gold, gold, gold])), ["mixed"]);
      assert.deepEqual(tone(page, [...Array(12).fill(white), ...Array(4).fill(black)]), ["solid"], "a JPEG logo on white");
      assert.deepEqual(tone(page, logo(Array(6).fill(black))), []);
    });
  }
});

describe("walkthrough co-branding", () => {
  test("the church logo leads the hero, above the grade and headline, in the scorecard's look", async () => {
    const r = await renderWalkthrough({ result: audit({ brand: BRAND }) });
    assert.match(r.headline, /^<span class="church-name">City Reach Church's<\/span> Front Door Audit: overall B$/);
    assert.match(r.logo, new RegExp(`^<span class="church-logo"><img src="${API}/logo\\?id=${ID}" alt="City Reach Church logo" width="228" height="62" style="--logo-w: \\d+px; --logo-w-sm: \\d+px"`));
    assert.match(r.logo, /crossorigin="anonymous"[^>]*onload="logoTone\(this\)" onerror="logoGone\(this\)"/);
    assert.equal(r.hasLogo, true);
    // BRAND predates onWash, so the eyebrow on the wash takes ink.
    assert.match(r.style, /:root \{ --brand: #17545b; --on-brand: #ffffff; --brand-wash: #e8eeef; --brand-font: "Lora"; --brand-ink: #131318; \}$/);
    assert.match(r.style, /@import url\("https:\/\/fonts\.googleapis\.com\/css2\?family=Lora&display=swap"\);/);
    assert.equal(r.cobrand, true);
    assert.match(walkthrough, /<section class="hero" id="hero">\s*<div id="logo-slot"><\/div>\s*<div>\s*<p class="eyebrow">/);
    assert.match(walkthrough, /#logo-slot \{ grid-column: 1 \/ -1; order: -2; display: flex; \}/);
    assert.match(walkthrough, /#logo-slot:empty \{ display: none; \}/);
    assert.match(walkthrough, /html\.cobrand header\.top \{[^}]*background: var\(--ink\);/, "the same slim black strip");
    assert.match(walkthrough, /html\.cobrand \.hero \{ border-image: linear-gradient\(to top, var\(--line\) 1px, var\(--brand-wash\) 1px\) 0 fill \/ 0 \/ 0 100vmax;/);
    assert.match(walkthrough, /html\.cobrand \.cal \{ background: #fff;/, "the calendar keeps its white card on the light page");
  });

  test("a logo that fails to load leaves an empty slot and the name in the church color", async () => {
    const r = await renderWalkthrough({ result: audit({ brand: BRAND }) });
    assert.ok(r.logo);
    r.run("logoGone()");
    assert.equal(r.el("logo-slot").innerHTML, "");
    assert.equal(r.el("hero").classList.contains("has-logo"), false);
    assert.match(walkthrough, /html\.cobrand \.hero \.church-name \{ color: var\(--brand\); \}/);
    assert.match(walkthrough, /html\.cobrand \.hero\.has-logo \.church-name \{ color: inherit; \}/);
  });

  test("no logo: the name in the church color; a logo without a color: the neutral look", async () => {
    const noLogo = await renderWalkthrough({ result: audit({ brand: { ...BRAND, logo: null } }) });
    assert.deepEqual([noLogo.logo, noLogo.hasLogo, noLogo.cobrand], ["", false, true]);
    const neutral = await renderWalkthrough({ result: audit({ brand: { ...BRAND, primary: null } }) });
    assert.equal(neutral.hasLogo, true);
    assert.match(neutral.style, /--brand: #131318; --on-brand: #ffffff; --brand-wash: #ffffff;/);
  });

  test("no brand, a bad color with no logo, or no audit: the page stays as it was", async () => {
    for (const result of [audit(), audit({ brand: { ...BRAND, primary: "url(x)", logo: null } }), null]) {
      const r = await renderWalkthrough({ result });
      assert.deepEqual([r.logo, r.style, r.cobrand, r.hasLogo], ["", "", false, false]);
    }
  });
});

// ---------- City ----------
describe("the city from the Google listing", () => {
  test("cityFromAddress reads City, ST from a formatted address", () => {
    assert.equal(cityFromAddress("1200 Main St, Leander, TX 78641, USA"), "Leander, TX");
    assert.equal(cityFromAddress("2700 W Whitestone Blvd, Cedar Park, TX 78613, United States"), "Cedar Park, TX");
    assert.equal(cityFromAddress("Leander, TX"), "Leander, TX");
    assert.equal(cityFromAddress("123 Queen St W, Toronto, ON M5H 2M9, Canada"), "Toronto, ON");
    assert.equal(cityFromAddress("Somewhere"), null);
    assert.equal(cityFromAddress(""), null);
  });

  const SEARCH = "https://places.googleapis.com/v1/places:searchText";
  const HERE = { latitude: 30.528, longitude: -97.86 };
  const site = `<html><head><meta name="viewport" content="width=device-width"></head><body><a href="/visit">Plan a Visit</a><a href="/kids">Kids</a><p>Sundays 9:00am worship</p>${filler}</body></html>`;
  const listing = (x = {}) => ({ id: "cr", displayName: { text: "City Reach Church" }, formattedAddress: "2700 W Whitestone Blvd, Cedar Park, TX 78613, USA", location: HERE,
    rating: 4.7, userRatingCount: 264, websiteUri: "https://cityreachchurch.com/", regularOpeningHours: { periods: [{}] }, businessStatus: "OPERATIONAL", ...x });
  const world = (places) => stubFetch([
    [SEARCH, (c) => json(c.json().textQuery === "church" ? { places: [{ id: "cr", displayName: { text: "City Reach Church" }, types: ["church"] }] } : { places })],
    [/pagespeedonline/, () => json({ lighthouseResult: { categories: { performance: { score: 0.9 } } } })],
    [/geocoding\.geo\.census\.gov/, () => json({ result: { addressMatches: [{ coordinates: { x: HERE.longitude, y: HERE.latitude }, matchedAddress: "x" }] } })],
    [/cityreachchurch\.com/, () => html(site)],
  ]);
  const typed = { name: "City Reach Church", address: "2700 W Whitestone Blvd Cedar Park TX 78613", city: "2700 W Whitestone Blvd Cedar Park TX 78613", website: "https://cityreachchurch.com/" };

  test("a high-confidence match gives church.city from the listing; the typed address stays", async () => {
    world([listing()]);
    const r = await runAudit(typed, { GOOGLE_API_KEY: "k" });
    assert.equal(r.google.confidence, "high");
    assert.equal(r.church.city, "Cedar Park, TX");
    assert.equal(r.church.address, typed.address);
  });

  test("a medium match (name only) counts; a different church's listing does not", async () => {
    world([listing({ websiteUri: null })]);
    assert.equal((await runAudit(typed, { GOOGLE_API_KEY: "k" })).church.city, "Cedar Park, TX");
    world([listing({ displayName: { text: "Hill Country Bible Church" }, websiteUri: "https://hcbc.com/", formattedAddress: "12124 Ranch Rd 620 N, Austin, TX 78750, USA" })]);
    const r = await runAudit(typed, { GOOGLE_API_KEY: "k" });
    assert.notEqual(r.google.confidence, "high");
    assert.equal(r.church.city, typed.city);
  });

  test("the audit Workflow saves the listing's city on the record and hands it to LeadDesk", async () => {
    world([listing()]);
    const leads = [];
    const e = fakeEnv({ GOOGLE_API_KEY: "k", DESK: { frontDoorLead: async (p) => { leads.push(p); return { ok: true, clickup: { ok: true, id: "t1" }, slack: { ok: true } }; } } });
    const id = "city-reach-church-1a2b3c4d";
    const church = { name: typed.name, address: typed.address, city: typed.city, website: typed.website };
    await e.AUDITS.put(`audit:${id}`, JSON.stringify({ status: "running", church, reviewToken: "a".repeat(32), created: new Date().toISOString() }));
    await e.AUDITS.put(`contact:${id}`, JSON.stringify({ name: "Pat Rivera", email: "pat@cityreach.example" }));
    await new FrontDoorAudit({}, e).run({ payload: { id, church, contact: { name: "Pat Rivera", email: "pat@cityreach.example" } } }, fakeStep());
    const rec = JSON.parse(e.AUDITS.m.get(`audit:${id}`));
    assert.equal(rec.church.city, "Cedar Park, TX");
    assert.equal(rec.church.address, typed.address);
    assert.ok(leads.length >= 1);
    assert.equal(leads[0].church.city, "Cedar Park, TX");
    assert.equal(leads[0].church.address, typed.address);
  });
});
