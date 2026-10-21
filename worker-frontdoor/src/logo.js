// The church's logo on the scorecard. brand.js lists up to four candidates from the home page (the header logo,
// the structured-data logo, the phone home-screen icon); this fetches them in order with the shared image
// rules in src/photo.js (public web address only, redirects by hand, one timeout) and keeps the first real
// PNG, JPEG, WebP, AVIF or clean SVG. The bytes go in KV (AUDITS, logo:<audit id>) and the worker's /logo route
// serves them, so the scorecard never loads anything from the church's site. A logo that cannot be had is
// left out: the scorecard shows the church's name in its color instead, and the grades never change.
// A raster logo over the pixel budget is skipped like any other bad candidate, and the next one is tried: the
// worker has no image resizer, and a phone decodes every pixel (Church of Whitestone's 14931x4167 PNG is 62
// million pixels, about 250 MB of memory, to draw a logo at most 460 CSS pixels wide). SVGs are vector and exempt.
import { fetchImage, sniffImage, imageSize, PHOTO_TYPES } from "./photo.js";

export const SVG_TYPE = "image/svg+xml";
export const LOGO_TYPES = [...PHOTO_TYPES, SVG_TYPE];
export const SVG_MAX_BYTES = 200_000;
const RASTER_MAX_BYTES = 1_000_000;
// 4 megapixels (2000x2000, or 4000x1000 for a wordmark) is sharp at 3x on the widest logo slot (460x150 CSS pixels)
// and decodes in about 16 MB.
export const RASTER_MAX_PIXELS = 4_000_000;
const TRIES = 3;
const YEAR = 60 * 60 * 24 * 365;
// Servers label SVG files a few ways; the bytes still have to be an <svg> document.
const SVG_GIVEN = [SVG_TYPE, "text/xml", "application/xml"];

const ENTITY = (s) => s.replace(/&#x([0-9a-f]+);?/gi, (_, h) => String.fromCharCode(parseInt(h, 16) || 32)).replace(/&#(\d+);?/g, (_, n) => String.fromCharCode(Number(n) || 32));

// Why an SVG cannot be shown, or null when it is safe: no scripts, event handlers, javascript: addresses,
// embedded HTML (foreignObject, iframe, object, embed), DOCTYPE or entities, @import, and no reference to
// anything outside the file (an href or CSS url() may point only inside it, or at an embedded raster image).
export function svgProblem(text) {
  const s = String(text ?? "");
  if (new TextEncoder().encode(s).length > SVG_MAX_BYTES) return "over 200 KB";
  const body = s.replace(/^\uFEFF/, "").replace(/<\?xml[\s\S]*?\?>/i, "").replace(/<!--[\s\S]*?-->/g, "").trim();
  if (!/^<svg[\s>]/i.test(body)) return "not an SVG document";
  const flat = ENTITY(s);
  // Element and attribute names may carry any namespace prefix (<x:script>, <h:script> in XHTML, l:href), so
  // every name check allows one.
  const P = "(?:[\\w.-]+:)?";
  if (new RegExp(`<\\s*${P}script`, "i").test(flat)) return "has a script";
  if (/j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t\s*:/i.test(flat)) return "has a javascript: address";
  if (/[\s"'/]on[a-z]+\s*=/i.test(flat)) return "has an event handler";
  if (new RegExp(`<\\s*${P}(?:foreignObject|iframe|object|embed|audio|video|handler|listener)\\b`, "i").test(flat)) return "embeds other content";
  if (/<!\s*(?:DOCTYPE|ENTITY)/i.test(flat)) return "has a DOCTYPE or entities";
  if (/<\?xml-stylesheet/i.test(flat)) return "imports a stylesheet";
  if (/@import/i.test(flat)) return "imports a stylesheet";
  // An animation can rewrite an href after the checks below have read it.
  if (new RegExp(`<\\s*${P}(?:set|animate)\\b[^>]*attributeName\\s*=\\s*["']?\\s*${P}href`, "i").test(flat)) return "animates a link";
  // CSS escapes (u\72l) and image-set() can hide an outside address from the url() check.
  const css = [...flat.matchAll(/<\s*(?:[\w.-]+:)?style\b[^>]*>([\s\S]*?)<\/\s*(?:[\w.-]+:)?style\s*>/gi)].map((m) => m[1])
    .concat([...flat.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((m) => m[1] ?? m[2]));
  if (css.some((c) => /\\|image-set\s*\(/i.test(c))) return "has CSS escapes";
  for (const m of flat.matchAll(new RegExp(`(?:^|[\\s"'])${P}(?:href|src)\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "gi"))) {
    const v = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (v && !v.startsWith("#") && !/^data:image\/(?:png|jpeg|jpg|gif|webp);/i.test(v)) return "references an outside file";
  }
  for (const m of flat.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    const v = m[2].trim();
    if (!v.startsWith("#") && !/^data:image\/(?:png|jpeg|jpg|gif|webp);/i.test(v)) return "references an outside file";
  }
  // A <use> that points at a part the file does not have draws nothing.
  for (const m of flat.matchAll(/<use\b[^>]*?(?:[\w.-]+:)?href\s*=\s*["']#([^"']+)["']/gi)) {
    if (!new RegExp(`\\sid\\s*=\\s*["']${m[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["']`).test(flat)) return "points at a part it does not have";
  }
  return null;
}

// Width and height from the viewBox, else plain width and height attributes. Null when neither is readable.
export function svgSize(text) {
  const open = (String(text).match(/<svg\b[^>]*>/i) || [""])[0];
  const vb = open.match(/viewBox\s*=\s*["']\s*[-\d.e]+[\s,]+[-\d.e]+[\s,]+([\d.e]+)[\s,]+([\d.e]+)\s*["']/i);
  if (vb && Number(vb[1]) > 0 && Number(vb[2]) > 0) return { width: Math.round(Number(vb[1])), height: Math.round(Number(vb[2])) };
  const w = open.match(/\swidth\s*=\s*["']?([\d.]+)(?:px)?["'\s>]/i), h = open.match(/\sheight\s*=\s*["']?([\d.]+)(?:px)?["'\s>]/i);
  return w && h && Number(w[1]) > 0 && Number(h[1]) > 0 ? { width: Math.round(Number(w[1])), height: Math.round(Number(h[1])) } : null;
}

// A raster logo has to be big enough to read, small enough for a phone to decode, and shaped like a mark or a wordmark.
export function logoSizeOk(width, height) {
  if (!width || !height) return false;
  const r = width / height;
  return Math.min(width, height) >= 16 && Math.max(width, height) >= 32 && width * height <= RASTER_MAX_PIXELS && r >= 0.33 && r <= 10;
}

function checkSvg(bytes) {
  if (bytes.length > SVG_MAX_BYTES) return { ok: false, reason: "over 200 KB" };
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return { ok: false, reason: "not UTF-8 text" }; }
  const problem = svgProblem(text);
  if (problem) return { ok: false, reason: `SVG ${problem}` };
  return { ok: true, bytes, type: SVG_TYPE, ...(svgSize(text) || {}) };
}

// An inline <svg> from the page, which brand.js hands over as a data: address.
function fromDataUrl(url) {
  const m = String(url).match(/^data:image\/svg\+xml(;[^,]*)?,([\s\S]*)$/i);
  if (!m) return { ok: false, reason: "not an SVG data address" };
  try {
    const text = /;base64/i.test(m[1] || "") ? new TextDecoder().decode(Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0))) : decodeURIComponent(m[2]);
    return checkSvg(new TextEncoder().encode(text));
  } catch {
    return { ok: false, reason: "unreadable data address" };
  }
}

// One candidate: { ok: true, bytes, type, width?, height? } or { ok: false, reason }.
export async function fetchLogo(url, { signal = null, referer = null } = {}) {
  if (/^data:/i.test(url)) return fromDataUrl(url);
  const got = await fetchImage(url, { signal, referer, types: [...PHOTO_TYPES, ...SVG_GIVEN], maxBytes: RASTER_MAX_BYTES });
  if (!got.ok) return got;
  if (SVG_GIVEN.includes(got.type)) return checkSvg(got.bytes);
  if (sniffImage(got.bytes) !== got.type) return { ok: false, reason: `bytes are not ${got.type}` };
  const size = imageSize(got.bytes, got.type);
  if (!size) return { ok: false, reason: "size unreadable" };
  if (size.width * size.height > RASTER_MAX_PIXELS) return { ok: false, reason: `${size.width}x${size.height} is too many pixels for a phone` };
  if (!logoSizeOk(size.width, size.height)) return { ok: false, reason: `${size.width}x${size.height} is not logo-sized` };
  return { ok: true, bytes: got.bytes, type: got.type, ...size };
}

// Tries up to three candidates and saves the first good one under logo:<id>. Returns { logo, misses }:
// logo = { stored: true, type, width?, height? } or null. An aborted signal stops the tries and skips the save.
export async function saveLogo(env, id, candidates, { signal = null, referer = null } = {}) {
  const misses = [];
  if (!env?.AUDITS || !id) return { logo: null, misses };
  for (const url of (candidates || []).slice(0, TRIES)) {
    if (signal?.aborted) break;
    const where = /^data:/i.test(url) ? "inline svg" : String(url).slice(0, 120);
    const got = await fetchLogo(url, { signal, referer });
    if (!got.ok) { misses.push(`${where}: ${got.reason}`); continue; }
    if (signal?.aborted) break;
    const size = got.width && got.height ? { width: got.width, height: got.height } : {};
    const metadata = { type: got.type, ...size, from: /^data:/i.test(url) ? "inline svg" : String(url).slice(0, 400) };
    await env.AUDITS.put(`logo:${id}`, got.bytes, { expirationTtl: YEAR, metadata });
    return { logo: { stored: true, type: got.type, ...size }, misses };
  }
  return { logo: null, misses };
}

// What the /logo route may serve: the stored type still matches the bytes, and an SVG is still clean.
export function servableLogo(bytes, type) {
  if (!bytes || !LOGO_TYPES.includes(type)) return false;
  if (type !== SVG_TYPE) return sniffImage(bytes) === type;
  try { return svgProblem(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) === null; } catch { return false; }
}
