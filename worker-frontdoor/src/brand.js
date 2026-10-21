// The church's own look, read from its home page and up to two of its own stylesheets, so the scorecard can
// wear the church's color, font and logo under a slim Big Splash strip. Nothing here fetches: website.js
// fetches the stylesheets and hands their text in, and src/logo.js fetches and checks the logo.
// brandFromPage(html, pageUrl, css) returns { primary, accent?, font?, logoCandidates, source }:
//   primary  the church color as #rrggbb, or null when nothing trustworthy turned up
//   source   where primary came from: "css-variable", "theme-color", "buttons" or null
// themeColors() turns that into the colors the scorecard uses, contrast-checked against white.

// ---------- Colors ----------
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const hex2 = (n) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, "0");
export const toHex = ({ r, g, b }) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;

function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360; s = clamp(s, 0, 1); l = clamp(l, 0, 1);
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (!d) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? 60 * (((g - b) / d) % 6) : max === g ? 60 * ((b - r) / d + 2) : 60 * ((r - g) / d + 4);
  return { h: (h + 360) % 360, s, l };
}

const num = (v, scale = 1) => { const n = parseFloat(v); return Number.isFinite(n) ? (/%$/.test(v.trim()) ? (n / 100) * scale : n) : NaN; };
const alpha = (v) => (v === undefined ? 1 : num(v, 1));

// A CSS color: #rgb(a), #rrggbb(aa), rgb()/rgba(), hsl()/hsla(), or the bare triples Squarespace ("200,40%,30%")
// and Wix ("47,93,168") keep in custom properties. { r, g, b, a } or null.
export function parseColor(raw) {
  const v = String(raw || "").trim().toLowerCase().replace(/\s*!important$/, "");
  let m = v.match(/^#([0-9a-f]{3,8})$/);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1 };
  }
  m = v.match(/^(rgba?|hsla?)\(\s*([^)]*)\)$/);
  const fn = m ? m[1].slice(0, 3) : /^[\d.]+\s*(?:deg)?\s*,\s*[\d.]+%\s*,\s*[\d.]+%(?:\s*,\s*[\d.]+%?)?$/.test(v) ? "hsl" : /^[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+(?:\s*,\s*[\d.]+%?)?$/.test(v) ? "rgb" : null;
  if (!fn) return null;
  const parts = (m ? m[2] : v).split(/\s*[,/]\s*|\s+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return null;
  const a = alpha(parts[3]);
  if (fn === "rgb") {
    const [r, g, b] = parts.slice(0, 3).map((p) => num(p, 255));
    if (![r, g, b, a].every(Number.isFinite)) return null;
    return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: clamp(a, 0, 1) };
  }
  const h = parseFloat(parts[0]), s = num(parts[1].endsWith("%") ? parts[1] : parts[1] + "%", 1), l = num(parts[2].endsWith("%") ? parts[2] : parts[2] + "%", 1);
  if (![h, s, l, a].every(Number.isFinite)) return null;
  return { ...hslToRgb(h, s, l), a: clamp(a, 0, 1) };
}

// WCAG relative luminance and contrast ratio.
export function luminance({ r, g, b }) {
  const ch = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}
export function contrast(a, b) {
  const x = luminance(typeof a === "string" ? parseColor(a) : a), y = luminance(typeof b === "string" ? parseColor(b) : b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// Same hue and saturation, lightness moved step by step (darker against a light background, lighter against a
// dark one) until the color reaches `ratio` against every background. Returns #rrggbb.
export function ensureContrast(color, backgrounds = ["#ffffff"], ratio = 4.5) {
  const c = typeof color === "string" ? parseColor(color) : color;
  if (!c) return null;
  const bgs = backgrounds.map((b) => (typeof b === "string" ? parseColor(b) : b));
  // Checked on the rounded #rrggbb the page will use: rounding alone can drop 4.5 to 4.47.
  const ok = (x) => { const r = parseColor(toHex(x)); return bgs.every((b) => contrast(r, b) >= ratio); };
  if (ok(c)) return toHex(c);
  const darker = bgs.reduce((n, b) => n + luminance(b), 0) / bgs.length > 0.18;
  const { h, s } = rgbToHsl(c);
  let { l } = rgbToHsl(c);
  for (let i = 0; i < 100; i++) {
    l = clamp(l + (darker ? -0.01 : 0.01), 0, 1);
    const x = hslToRgb(h, s, l);
    if (ok(x)) return toHex(x);
  }
  return darker ? "#000000" : "#ffffff";
}

// A color that can stand for a church: opaque enough, not white, black or a gray.
export function usable(c) {
  if (!c || c.a < 0.9) return false;
  const max = Math.max(c.r, c.g, c.b), min = Math.min(c.r, c.g, c.b);
  const chroma = (max - min) / 255, l = (max + min) / 510;
  if (l > 0.92 || l < 0.08 || chroma < 0.15) return false;
  return chroma / (1 - Math.abs(2 * l - 1)) >= 0.2;
}

const distance = (a, b) => Math.hypot(a.r - b.r, a.g - b.g, a.b - b.b);

// Colors a site gets from its builder or framework without anyone choosing them: browser link blue, WordPress
// and Gutenberg presets, Bootstrap 3 to 5, Elementor's starter kit, and Squarespace's and Wix's stock link blue.
const DEFAULTS = new Set([
  "#0000ee", "#551a8b", "#0000ff",
  "#0073aa", "#007cba", "#2271b1", "#0693e3", "#00d084", "#cf2e2e", "#ff6900", "#fcb900", "#7bdcb5", "#8ed1fc", "#9b51e0", "#f78da7", "#abb8c3", "#32373c",
  "#0d6efd", "#007bff", "#337ab7", "#428bca", "#6610f2", "#6f42c1", "#d63384", "#dc3545", "#fd7e14", "#ffc107", "#198754", "#20c997", "#0dcaf0", "#28a745", "#17a2b8",
  // Bootstrap 3's state colors with their hover, active and border shades, which themes copy in whole.
  "#d9534f", "#c9302c", "#ac2925", "#d43f3a", "#761c19", "#f0ad4e", "#ec971f", "#d58512", "#eea236", "#985f0d", "#5cb85c", "#449d44", "#398439", "#4cae4c", "#255625",
  "#5bc0de", "#31b0d5", "#269abc", "#46b8da", "#1b6d85", "#286090", "#204d74", "#2e6da4", "#122b40", "#23527c", "#66afe9", "#3a87ad", "#b94a48", "#468847", "#c09853",
  // Social share buttons in the networks' own colors (Facebook, X/Twitter, Google, LinkedIn, Pinterest, Instagram).
  "#3b5998", "#2d4373", "#4267b2", "#1877f2", "#55acee", "#1da1f2", "#2795e9", "#dd4b39", "#c23321", "#0077b5", "#0e76a8", "#cb2027", "#bd081c", "#e1306c", "#c13584",
  // UIkit's primary, danger and success colors with their hover and active shades.
  "#1e87f0", "#0f7ae5", "#0e6dcd", "#f0506e", "#ee395b", "#ec2147", "#32d296", "#faa05a",
  "#6ec1e4", "#61ce70", "#54595f", "#7a7a7a",
  "#3e65ff", "#116dff", "#384ad3", "#4a90e2",
  // Squarespace's own editing red, shipped in every site.css; Hello Elementor's stock link color.
  "#f0523d", "#cc3366",
]);
const isDefault = (c) => DEFAULTS.has(toHex(c));
const good = (c) => usable(c) && !isDefault(c);

// ---------- Markup helpers ----------
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s) => String(s || "").replace(/&#(\d+);?/g, (_, n) => String.fromCharCode(Number(n) || 32)).replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCharCode(parseInt(h, 16) || 32)).replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
function attr(tag, name) {
  const m = tag.match(new RegExp(`[\\s"'/]${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"));
  return m ? decode(m[1] ?? m[2] ?? m[3]).trim() : null;
}
function absolute(raw, base) {
  if (!raw || /^(javascript|mailto|tel|data|blob):/i.test(raw.trim())) return null;
  try {
    const u = new URL(raw.trim(), base);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}
const registrable = (host) => {
  const parts = String(host || "").toLowerCase().replace(/\.$/, "").split(".");
  if (parts.length <= 2) return parts.join(".");
  const [sld, tld] = parts.slice(-2);
  return parts.slice(tld.length === 2 && ["co", "com", "org", "net", "ac", "gov", "edu"].includes(sld) ? -3 : -2).join(".");
};

// ---------- Stylesheets ----------
// Library CSS never carries the church's colors; the site's own theme file does. A builder's per-site file
// (Squarespace sitecss, Webflow's <site>.webflow.css or newer <site>.shared.<hash>.min.css, an Elementor kit) holds the palette the church chose.
const LIBRARY_CSS = /wp-includes|font-?awesome|bootstrap|jquery|slick|swiper|owl\.carousel|animate(?:\.min)?\.css|dashicons|block-library|fancybox|lightbox|magnific|select2|normalize|reset\.css|fonts\.googleapis|use\.typekit|cookie|recaptcha|wp-content\/plugins\/(?!elementor)/i;
const WEBFLOW_CSS = /\/css\/[\w-]+\.(?:webflow|shared)(?:\.[\w-]+)*\.css$/i;
const BUILDER_CSS = /versioned-site-css|\/sitecss\/|\.webflow(?:\.[\w-]+)*\.css|\/css\/[\w-]+\.shared(?:\.[\w-]+)*\.css|elementor\/css\/(?:global|post-\d+)|customizer|custom-css|additional/i;
const THEME_CSS = /site\.css|style\.css|theme|global|custom|main|app\.css|styles?\.css/i;
const CHILD_CSS = /\/themes\/[\w-]+-child\//i;
const STARTER_CSS = /hello-elementor|twentytwenty|astra\/assets|generatepress\/assets|kadence\/assets|oceanwp\/assets/i;

// Up to `limit` stylesheets from the church's own domain, its builder or theme file first. Squarespace and
// Webflow keep the site's own file on their CDNs, so those count as the church's too.
export function stylesheetLinks(html, pageUrl, limit = 2) {
  let site;
  try { site = registrable(new URL(pageUrl).hostname); } catch { return []; }
  const out = [];
  for (const m of String(html).matchAll(/<link\b[^>]*>/gi)) {
    const rel = (attr(m[0], "rel") || "").toLowerCase();
    if (!/\bstylesheet\b/.test(rel) || /\balternate\b/.test(rel)) continue;
    const media = (attr(m[0], "media") || "").toLowerCase();
    if (media && !/^(all|screen)/.test(media)) continue;
    const url = absolute(attr(m[0], "href"), pageUrl);
    if (!url || LIBRARY_CSS.test(url)) continue;
    const u = new URL(url);
    const own = registrable(u.hostname) === site || (/(^|\.)squarespace\.com$/.test(u.hostname) && /\/static\/(?:sitecss|versioned-site-css)\//.test(u.pathname)) ||
      (/(^|\.)(?:website-files\.com|webflow\.com)$/.test(u.hostname) && (/\.webflow(?:\.[\w-]+)*\.css$/.test(u.pathname) || WEBFLOW_CSS.test(u.pathname)));
    // A WordPress child theme holds what the church changed on top of the stock theme and its color skin.
    const score = BUILDER_CSS.test(u.pathname) ? 3 : CHILD_CSS.test(u.pathname) ? 2 : STARTER_CSS.test(u.pathname) ? 0 : THEME_CSS.test(u.pathname) ? 1 : 0;
    if (own && !out.some((x) => x.url === url)) out.push({ url, score, at: out.length });
  }
  return out.sort((a, b) => b.score - a.score || a.at - b.at).slice(0, limit).map((x) => x.url);
}

// Every rule as [selector, declarations], from CSS text with comments removed. @media blocks are flattened.
function rules(css) {
  const out = [];
  const text = String(css).replace(/\/\*[\s\S]*?\*\//g, " ");
  for (const chunk of text.split("}")) {
    const i = chunk.lastIndexOf("{");
    if (i === -1) continue;
    const selector = chunk.slice(0, i).replace(/^[\s\S]*[;{]/, "").trim();
    if (!selector || selector.startsWith("@")) continue;
    out.push([selector, chunk.slice(i + 1)]);
  }
  return out;
}

function declarations(block) {
  const out = [];
  for (const d of block.split(";")) {
    const i = d.indexOf(":");
    if (i === -1) continue;
    out.push([d.slice(0, i).trim().toLowerCase(), d.slice(i + 1).trim()]);
  }
  return out;
}

// var(--x, fallback) resolved through the custom properties, three levels deep.
function resolve(value, vars, depth = 0) {
  if (depth > 3 || !/var\(/i.test(value)) return value;
  const next = value.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\)[^()]*)*))?\)/gi, (_, name, fallback) => vars.get(name.toLowerCase()) ?? (fallback || "").trim());
  return resolve(next, vars, depth + 1);
}

const VAR_NAME = /(?:^|[-_])(primary|brand|main|accent)(?:$|[-_]|color|colour|hsl|rgb)/;
const VAR_NOT = /text|font|foreground|(?:^|[-_])fg|(?:^|[-_])bg|background|contrast|(?:^|[-_])on[-_]|hover|focus|active|light|dark|safe|shadow|border|size|width|height|radius|spacing|gap|family|weight|opacity|transition|duration|gradient/;
const VAR_RANK = { primary: 0, brand: 0, main: 1, accent: 2 };
// Only a plainly named property counts: --accent-hsl, --brand-color, --wp--preset--color--primary,
// --e-global-color-accent, Wix's --wst-button-color-fill-primary, The Events Calendar's --tec-color-accent-primary
// (it copies the theme's accent). A sub-brand's --lifechurch-now-accent or --card-link-primary does not.
const VAR_GENERIC = new Set(["color", "colour", "colors", "hsl", "rgb", "wp", "preset", "e", "global", "theme", "site", "bs", "clr", "c", "default", "base", "1",
  "wst", "tec", "button", "fill", "link"]);
const plainName = (bare) => bare.toLowerCase().split(/[-_]+/).filter((t) => t && !VAR_GENERIC.has(t)).every((t) => t in VAR_RANK);
// The builder's own editing and admin screens, which ship colors no church picked.
// TinyMCE's editor skin (.tox, .mce-) ships its own --color-primary on some church CMSs (HCBC's orange #ff791d); jQuery UI
// and typeahead dropdowns are library widgets, not the church's buttons.
const SELECTOR_NOT = /sqsp-|sqs-action|sqs-editing|sqs-modal|sqs-widgets|yui3?-|#wpadminbar|admin-bar|cookie|consent|cmplz|onetrust|recaptcha|grecaptcha|\.tox\b|\.mce-|\.ui-(?:autocomplete|datepicker|dialog|menu)|\.tt-(?:dropdown|suggestion)/i;

// The custom properties the page's own rules reach (directly or through other properties), and the ones only the
// builder's editing screens reach. A property only editor screens use is the editor's color, not the church's.
function varUse(all, vars, inlineStyles) {
  const reach = (text, into) => {
    const stack = [...String(text).matchAll(/var\(\s*(--[\w-]+)/gi)].map((m) => m[1].toLowerCase());
    while (stack.length) {
      const n = stack.pop();
      if (into.has(n)) continue;
      into.add(n);
      for (const m of String(vars.get(n) || "").matchAll(/var\(\s*(--[\w-]+)/gi)) stack.push(m[1].toLowerCase());
    }
  };
  const ok = new Set(), editor = new Set();
  for (const [selector, block] of all) {
    for (const [prop, value] of declarations(block)) if (!prop.startsWith("--")) reach(value, SELECTOR_NOT.test(selector) ? editor : ok);
  }
  for (const style of inlineStyles) reach(style, ok);
  return { ok, editor };
}
const BUTTONISH = /\bbutton\b|\bbtn\b|\bcta\b|button__link|block-button|wp-element-button|sqs-button|elementor-button|stylablebutton|\[type=["']?submit/i;
const LINKISH = /(?:^|[\s>+~])a(?=$|[\s:.[#>+~])/i;

// ---------- Fonts ----------
const ICON_FONTS = /icon|symbol|awesome|emoji/i;
const FAMILY = /^[A-Za-z0-9][A-Za-z0-9 ]{0,39}$/;

function googleFamilies(html, css) {
  const urls = [];
  for (const m of String(html).matchAll(/<link\b[^>]*>/gi)) {
    const href = attr(m[0], "href") || "";
    if (/fonts\.googleapis\.com\/css/i.test(href)) urls.push(href);
  }
  for (const text of css) for (const m of String(text).matchAll(/@import\s+(?:url\()?\s*["']?([^"')\s;]*fonts\.googleapis\.com\/css[^"')\s;]*)/gi)) urls.push(m[1]);
  const out = [];
  for (const raw of urls) {
    let u;
    try { u = new URL(decode(raw), "https://fonts.googleapis.com/"); } catch { continue; }
    if (u.hostname !== "fonts.googleapis.com") continue;
    for (const fam of u.searchParams.getAll("family")) {
      for (const part of fam.split("|")) {
        const name = part.split(":")[0].replace(/\+/g, " ").replace(/\s+/g, " ").trim();
        if (FAMILY.test(name) && !ICON_FONTS.test(name) && !out.includes(name)) out.push(name);
      }
    }
  }
  return out;
}

// ---------- Logo ----------
const LOGO = /logo|brand|site-title|site-branding|header-title|navbar-brand/i;
const SVG_INLINE_MAX = 60000;

// The srcset entry closest under 800w, else the narrowest; a width-less set gives its first URL.
function pickSrcset(set) {
  if (!set) return null;
  const items = set.trim().split(/,\s+/).map((p) => { const m = p.trim().match(/^(\S+)(?:\s+(\d+)w)?/); return m ? { url: m[1], w: m[2] ? Number(m[2]) : null } : null; }).filter(Boolean);
  const sized = items.filter((i) => i.w).sort((a, b) => a.w - b.w);
  return (sized.filter((i) => i.w <= 800).pop() || sized[0] || items[0])?.url || null;
}

// Squarespace serves the original upload without a format: 750w is plenty for a logo.
function logoSized(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)squarespace-cdn\.com$/.test(u.hostname) && !u.searchParams.has("format")) { u.searchParams.set("format", "750w"); return u.toString(); }
  } catch {}
  return url;
}

function imgUrl(tag, base) {
  const raw = ["data-src", "data-lazy-src", "data-original", "src"].map((n) => attr(tag, n)).find((v) => v && !/^data:/i.test(v) && !/blank\.(?:gif|png)|spacer|placeholder/i.test(v)) ||
    pickSrcset(attr(tag, "srcset") || attr(tag, "data-srcset"));
  const abs = absolute(raw, base);
  return abs ? logoSized(abs) : null;
}

// The tags still open around a tag, from the 600 characters before it, nearest three: the wrapper that names it
// a logo. A link or block that already closed (the logo link before the menu button) is not a wrapper.
const WRAPPERS = /^(?:a|div|span|p|h1|figure|picture|header|li|button)$/;
function wrapper(html, at) {
  const open = [];
  for (const m of html.slice(Math.max(0, at - 600), at).matchAll(/<(\/?)([a-z][\w-]*)\b[^>]*>/gi)) {
    const name = m[2].toLowerCase();
    if (!m[1]) { if (!m[0].endsWith("/>")) open.push({ name, tag: m[0] }); continue; }
    const i = open.map((o) => o.name).lastIndexOf(name);
    if (i !== -1) open.splice(i);
  }
  return open.filter((o) => WRAPPERS.test(o.name)).slice(-3).map((o) => o.tag).join(" ");
}
const says = (tag) => LOGO.test(`${attr(tag, "class") || ""} ${attr(tag, "id") || ""} ${attr(tag, "alt") || ""} ${attr(tag, "aria-label") || ""} ${attr(tag, "src") || ""} ${attr(tag, "data-src") || ""}`);

// An inline <svg> logo as a data: address. It gets the SVG namespace it needs to stand on its own.
function inlineSvg(svg) {
  if (svg.length > SVG_INLINE_MAX) return null;
  let s = svg.trim();
  if (!/^<svg\b[^>]*\sxmlns\s*=/i.test(s)) s = s.replace(/^<svg\b/i, '<svg xmlns="http://www.w3.org/2000/svg"');
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(s);
}

// Logos in one block of markup: <img> tags, Wix images and inline <svg> that say logo themselves or sit in a
// wrapper that does. With homeLink, an image inside the block's link to the home page counts too.
function logosIn(block, base, homeLink, withSvg = true) {
  const found = [];
  for (const m of block.matchAll(/<img\b[^>]*>/gi)) {
    const url = imgUrl(m[0], base);
    if (!url || /\.gif(?:$|\?)/i.test(url)) continue;
    const ctx = wrapper(block, m.index);
    if (says(m[0]) || LOGO.test(ctx)) found.push({ url, at: m.index, strong: true });
    else if (homeLink && /<a\b[^>]*href\s*=\s*["']?(?:\/|https?:\/\/[^/"']+\/?)["'\s>]/i.test(ctx)) found.push({ url, at: m.index, strong: false });
  }
  for (const m of block.matchAll(/<wow-image\b[^>]*>/gi)) {
    let d;
    try { d = JSON.parse(attr(m[0], "data-image-info") || "").imageData; } catch { continue; }
    const file = String(d?.uri || "").replace(/^https?:\/\/static\.wixstatic\.com\/media\//, "");
    if (!/^[\w-]+(?:~mv2)?\.(?:jpe?g|png|webp|svg)$/i.test(file)) continue;
    if (LOGO.test(`${d.alt || ""} ${d.name || ""} ${attr(m[0], "id") || ""}`) || LOGO.test(wrapper(block, m.index))) found.push({ url: `https://static.wixstatic.com/media/${file}`, at: m.index, strong: true });
  }
  // The first 40 inline <svg>s, each read up to its own close: a lazy regex over a page of unclosed <svg> tags
  // took seconds.
  let svgs = 0;
  for (const m of withSvg ? block.matchAll(/<svg\b[^>]*>/gi) : []) {
    if (++svgs > 40) break;
    const close = block.slice(m.index, m.index + SVG_INLINE_MAX + 10).search(/<\/svg\s*>/i);
    if (close === -1) continue;
    const whole = block.slice(m.index, m.index + close).concat("</svg>");
    const titled = /<title>[^<]*logo[^<]*<\/title>/i.test(whole.slice(0, 600));
    if (!(says(m[0]) || titled || LOGO.test(wrapper(block, m.index)))) continue;
    if (!/<(?:path|polygon|rect|circle|ellipse|text|g)\b/i.test(whole)) continue; // an empty frame, not a mark
    const url = inlineSvg(whole);
    if (url) found.push({ url, at: m.index, strong: true });
  }
  return found.sort((a, b) => Number(b.strong) - Number(a.strong) || a.at - b.at).map((f) => f.url);
}

export function findLogos(html, pageUrl, limit = 4) {
  const baseTag = (html.match(/<base\b[^>]*>/i) || [])[0];
  const base = (baseTag && absolute(attr(baseTag, "href"), pageUrl)) || pageUrl;
  const clean = html.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(script|style|noscript|template)\b(?![^>]*ld\+json)[\s\S]*?<\/\1\s*>/gi, " ");
  const list = [];
  // 1. The header and the menus.
  // The first eight (of at most twelve tried), each read up to its own close within 200 KB: a lazy regex over a page of unclosed
  // <header> tags took seconds.
  const blocks = [];
  let after = 0, tries = 0;
  for (const m of clean.matchAll(/<(header|nav)\b/gi)) {
    if (m.index < after) continue; // a menu inside the header already read
    if (++tries > 12 || blocks.length >= 8) break;
    const close = clean.slice(m.index, m.index + 200000).search(new RegExp(`</${m[1]}\\s*>`, "i"));
    if (close === -1) continue;
    blocks.push(clean.slice(m.index, m.index + close));
    after = m.index + close;
  }
  if (!blocks.length) {
    const start = clean.search(/<body\b/i);
    blocks.push(clean.slice(start === -1 ? 0 : start, (start === -1 ? 0 : start) + 30000));
  }
  for (const b of blocks) list.push(...logosIn(b, base, true));
  // 2. The logo in the page's structured data.
  for (const m of html.matchAll(/"logo"\s*:\s*(?:\{[^{}]*?"(?:url|contentUrl)"\s*:\s*)?"(https?:[^"]+)"/gi)) list.push(absolute(m[1].replace(/\\\//g, "/"), base));
  // 3. A logo anywhere else on the page, outside the footer.
  const body = clean.replace(/<footer\b[\s\S]*?<\/footer\s*>/gi, " ");
  list.push(...logosIn(body, base, false, false).slice(0, 2));
  // 4. The phone home-screen icon, the largest one: a small square mark.
  const touch = [...html.matchAll(/<link\b[^>]*>/gi)].filter((m) => /apple-touch-icon/i.test(attr(m[0], "rel") || ""))
    .map((m) => ({ url: absolute(attr(m[0], "href"), base), size: parseInt((attr(m[0], "sizes") || "0").split("x")[0], 10) || 0 }))
    .filter((t) => t.url).sort((a, b) => b.size - a.size);
  list.push(...touch.map((t) => t.url));
  return [...new Set(list.filter(Boolean))].slice(0, limit);
}

// ---------- The whole brand ----------
export function brandFromPage(html, pageUrl, css = []) {
  html = String(html || "");
  const sheets = [...[...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)].map((m) => m[1]), ...css.map(String)];
  const all = sheets.flatMap(rules);

  // Custom properties, first definition wins (a :root rule comes before section overrides).
  const vars = new Map();
  for (const [, block] of all) {
    for (const [prop, value] of declarations(block)) if (prop.startsWith("--") && !vars.has(prop) && value.length < 200) vars.set(prop, value);
  }
  for (const m of html.matchAll(/\sstyle\s*=\s*"([^"]*--[^"]*)"/gi)) {
    for (const [prop, value] of declarations(decode(m[1]))) if (prop.startsWith("--") && !vars.has(prop)) vars.set(prop, value);
  }
  const color = (value) => parseColor(resolve(value, vars).replace(/\s*!important$/i, "").trim());

  const candidates = [];
  // A. A custom property named for the brand: --primary, --brand-color, --wp--preset--color--primary, --accent-hsl.
  const named = [];
  const used = varUse(all, vars, [...html.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)].map((m) => decode(m[1])));
  for (const [name, value] of vars) {
    const bare = name.replace(/^--/, "");
    const m = bare.match(VAR_NAME);
    if (!m || VAR_NOT.test(bare) || !plainName(bare)) continue;
    if (used.editor.has(name) && !used.ok.has(name)) continue;
    const c = color(value);
    if (good(c)) named.push({ c, rank: VAR_RANK[m[1]], name });
  }
  named.sort((a, b) => a.rank - b.rank);
  // A brand or accent property is a choice someone made (Squarespace's --accent-hsl, an Elementor kit's
  // accent), so both go ahead of the meta tag and the button count.
  const varPrimary = named.find((n) => n.rank < 2), varAccent = named.find((n) => n.rank === 2);
  if (varPrimary) candidates.push({ c: varPrimary.c, source: "css-variable" });
  if (varAccent) candidates.push({ c: varAccent.c, source: "css-variable" });

  // B. The theme-color meta tag.
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    if ((attr(m[0], "name") || "").toLowerCase() !== "theme-color") continue;
    const media = attr(m[0], "media") || "";
    if (/dark/i.test(media)) continue;
    const c = parseColor(attr(m[0], "content"));
    if (good(c)) { candidates.push({ c, source: "theme-color" }); break; }
  }

  // C. The most used color on buttons and links: a button fill counts 3, a link color 2, anything else 1.
  const votes = [];
  const vote = (c, w) => {
    if (!good(c)) return;
    const near = votes.find((v) => distance(v.c, c) < 24);
    if (near) { near.w += w; if (w > near.top) { near.top = w; near.c = c; } } else votes.push({ c, w, top: w });
  };
  for (const [selector, block] of all) {
    if (SELECTOR_NOT.test(selector)) continue;
    const button = BUTTONISH.test(selector), link = !button && selector.split(",").some((s) => LINKISH.test(s.trim()));
    if (!button && !link) continue;
    for (const [prop, value] of declarations(block)) {
      if (!["color", "background-color", "background", "border-color"].includes(prop)) continue;
      const v = prop === "background" ? (resolve(value, vars).match(/#[0-9a-f]{3,8}\b|(?:rgba?|hsla?)\([^)]*\)/i) || [""])[0] : value;
      const c = color(v);
      if (button) vote(c, prop.startsWith("background") ? 3 : 1);
      else if (prop === "color") vote(c, 2);
    }
  }
  for (const m of html.matchAll(/<(a|button)\b[^>]*\sstyle\s*=\s*"([^"]*)"[^>]*>/gi)) {
    for (const [prop, value] of declarations(decode(m[2]))) {
      if (prop === "background-color" || prop === "background") vote(color((value.match(/#[0-9a-f]{3,8}\b|(?:rgba?|hsla?)\([^)]*\)/i) || [value])[0]), 3);
      else if (prop === "color") vote(color(value), m[1].toLowerCase() === "button" ? 1 : 2);
    }
  }
  votes.sort((a, b) => b.w - a.w);
  if (votes[0] && votes[0].w >= 3) candidates.push({ c: votes[0].c, source: "buttons" });
  for (const v of votes.slice(1)) if (v.w >= 3) candidates.push({ c: v.c, source: "buttons" });

  const primary = candidates[0] || null;
  const accent = primary ? candidates.find((x) => distance(x.c, primary.c) > 60) : null;

  // The font: the Google family the headings use, else the first one the page loads.
  const families = googleFamilies(html, sheets);
  let font = null;
  for (const [selector, block] of all) {
    if (font || !/(?:^|[\s,>])h[1-3]\b|heading|title/i.test(selector)) continue;
    for (const [prop, value] of declarations(block)) {
      if (prop !== "font-family") continue;
      const first = resolve(value, vars).split(",")[0].replace(/["']/g, "").trim();
      const hit = families.find((f) => f.toLowerCase() === first.toLowerCase());
      if (hit) { font = hit; break; }
    }
  }
  font = font || families[0] || null;

  return {
    primary: primary ? toHex(primary.c) : null,
    ...(accent ? { accent: toHex(accent.c) } : {}),
    ...(font ? { font } : {}),
    logoCandidates: findLogos(html, pageUrl),
    source: primary ? primary.source : null,
  };
}

// The scorecard's body is off-white (#f7f5f0) and its cards white; both carry church-color text.
export const PAGE_BACKGROUNDS = ["#ffffff", "#f7f5f0"];
const NEAR_BLACK = "#131318";

// The header wash on both pages: the church color mixed with white, 10% color. The pages draw it with the same
// per-channel rounding (tint() in front-door/index.html and frontdoor/walkthrough/index.html).
export const WASH_KEEP = 0.1;
export function washOf(hex, keep = WASH_KEEP) {
  const c = parseColor(hex);
  if (!c) return null;
  const mix = (v) => Math.round(v * keep + 255 * (1 - keep));
  return toHex({ r: mix(c.r), g: mix(c.g), b: mix(c.b) });
}

// The colors the scorecard uses: primary reaches 4.5:1 against white and the page for text and the grade ring;
// accent reaches 3:1 (borders and marks); onPrimary is white or near-black, whichever reads better on a primary fill.
// primaryOnDark is the same hue lifted to 3:1 against the dark walkthrough page, for its ring and borders.
// onWash is primary darkened until it reaches 4.5:1 on the header wash, for the small eyebrow line that sits on it.
export const DARK_BACKGROUNDS = ["#131318", "#1f1f25"];
export function themeColors(brand) {
  const raw = parseColor(brand?.primary);
  if (!raw || !usable(raw)) return { primary: null, accent: null, onPrimary: null, primaryOnDark: null, onWash: null };
  const primary = ensureContrast(raw, PAGE_BACKGROUNDS, 4.5);
  const rawAccent = parseColor(brand?.accent);
  const accent = rawAccent && usable(rawAccent) ? ensureContrast(rawAccent, PAGE_BACKGROUNDS, 3) : null;
  const onPrimary = contrast("#ffffff", primary) >= contrast(NEAR_BLACK, primary) ? "#ffffff" : NEAR_BLACK;
  const onWash = ensureContrast(primary, [washOf(primary), ...PAGE_BACKGROUNDS], 4.5);
  return { primary, accent, onPrimary, primaryOnDark: ensureContrast(raw, DARK_BACKGROUNDS, 3), onWash };
}
