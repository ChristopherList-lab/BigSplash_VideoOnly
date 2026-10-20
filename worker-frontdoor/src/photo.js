// The church photo on the scorecard. website.js picks up to three candidate images from the home page;
// this fetches them in order the way a phone would and keeps the first real JPEG, PNG, WebP or AVIF that is
// at least 600 px wide and not a banner strip. Its bytes go in KV (AUDITS, photo:<audit id>), so the
// scorecard never loads anything from the church's site. A photo that cannot be had is left out: it never
// fails the audit or changes a grade.
import { PHONE_UA } from "./website.js";

export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif"];
const ALIASES = { "image/jpg": "image/jpeg", "image/pjpeg": "image/jpeg", "image/x-png": "image/png" };
export const PHOTO_TIMEOUT_MS = 10000;
export const PHOTO_MAX_BYTES = 2_000_000;
const MIN_WIDTH = 600;
const ASPECT = [0.6, 2.5];
const TRIES = 3;
const MAX_HOPS = 3;
// Bytes per pixel below this is a flat graphic (a logo on a color card), not a photo. AVIF packs tighter.
const FLAT = { "image/avif": 0.012, other: 0.025 };
const YEAR = 60 * 60 * 24 * 365;
const HEADERS = { "User-Agent": PHONE_UA, "Accept-Language": "en-US,en;q=0.9", Accept: "image/avif,image/webp,image/jpeg,image/png;q=0.9,*/*;q=0.5" };

const ascii = (b, at, len) => String.fromCharCode(...b.subarray(at, at + len));
const u16be = (b, i) => (b[i] << 8) | b[i + 1];
const u32be = (b, i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
const u24le = (b, i) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);

// The image type the bytes themselves say, or null.
export function sniffImage(b) {
  if (!b || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x89 && ascii(b, 1, 3) === "PNG" && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WEBP") return "image/webp";
  if (ascii(b, 4, 4) === "ftyp") {
    const size = Math.min(u32be(b, 0), b.length, 256);
    for (let i = 8; i + 4 <= size; i += 4) if (["avif", "avis"].includes(ascii(b, i, 4))) return "image/avif";
  }
  return null;
}

// Width and height from the header bytes: JPEG SOF, PNG IHDR, WebP VP8/VP8L/VP8X, AVIF ispe. Null when unreadable.
export function imageSize(b, type = sniffImage(b)) {
  try {
    if (type === "image/png") return ascii(b, 12, 4) === "IHDR" ? { width: u32be(b, 16), height: u32be(b, 20) } : null;
    if (type === "image/jpeg") {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) return null;
        const m = b[i + 1];
        if (m === 0xff) { i++; continue; } // fill byte
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; } // no length
        if (m === 0xd9 || m === 0xda) return null; // end of image or scan data before any frame header
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { width: u16be(b, i + 7), height: u16be(b, i + 5) };
        i += 2 + u16be(b, i + 2);
      }
      return null;
    }
    if (type === "image/webp") {
      const chunk = ascii(b, 12, 4);
      if (chunk === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
      if (chunk === "VP8L" && b[20] === 0x2f) {
        const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
      if (chunk === "VP8X") return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
      return null;
    }
    if (type === "image/avif") {
      // The largest ispe box (a grid image also carries its tiles' sizes).
      let best = null;
      const end = Math.min(b.length - 16, 65536);
      for (let i = 4; i < end; i++) {
        if (b[i] !== 0x69 || ascii(b, i, 4) !== "ispe") continue;
        const width = u32be(b, i + 8), height = u32be(b, i + 12);
        if (!best || width > best.width) best = { width, height };
      }
      return best;
    }
  } catch {}
  return null;
}

// Whether a known size makes a usable scorecard photo.
export function photoSizeOk(width, height) {
  if (!width || !height) return false;
  const r = width / height;
  return width >= MIN_WIDTH && r >= ASPECT[0] && r <= ASPECT[1];
}

async function readAll(res, max) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) { reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

// The church's page picks these addresses, so only a plain public web address is fetched: http or https on
// the usual port, a host name (never an IP address, localhost or a local-network name) and no login in it.
export function publicImageUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || host.startsWith("[") || /^[\d.]+$/.test(host) || /^0x/i.test(host)) return null;
  if (/(?:^|\.)(?:localhost|local|internal|intranet|lan|home\.arpa|corp)$/.test(host)) return null;
  return u;
}

// One candidate: { ok: true, bytes, type, width, height } or { ok: false, reason }. Redirects are followed by
// hand, at most MAX_HOPS, and every hop has to pass publicImageUrl too. One timeout covers every hop and the body.
export async function fetchPhoto(url, { signal = null, referer = null } = {}) {
  try {
    let u = publicImageUrl(url);
    if (!u) return { ok: false, reason: "not a public web address" };
    const headers = referer ? { ...HEADERS, Referer: referer } : HEADERS;
    const timeout = AbortSignal.timeout(PHOTO_TIMEOUT_MS);
    const both = signal ? AbortSignal.any([timeout, signal]) : timeout;
    let res;
    for (let hop = 0; ; hop++) {
      res = await fetch(u.toString(), { headers, redirect: "manual", signal: both });
      if (res.status < 300 || res.status > 399 || res.status === 304) break;
      res.body?.cancel().catch(() => {});
      const next = hop < MAX_HOPS && res.headers.get("location");
      if (!next) return { ok: false, reason: hop < MAX_HOPS ? `answered ${res.status}` : "too many redirects" };
      u = publicImageUrl(new URL(next, u).toString());
      if (!u) return { ok: false, reason: "redirected off the public web" };
    }
    if (!res.ok) { res.body?.cancel().catch(() => {}); return { ok: false, reason: `answered ${res.status}` }; }
    const given = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    const type = ALIASES[given] || given;
    if (!PHOTO_TYPES.includes(type)) { res.body?.cancel().catch(() => {}); return { ok: false, reason: `type ${given || "missing"}` }; }
    if (Number(res.headers.get("content-length")) > PHOTO_MAX_BYTES) { res.body?.cancel().catch(() => {}); return { ok: false, reason: "over 2 MB" }; }
    const bytes = res.body ? await readAll(res, PHOTO_MAX_BYTES) : null;
    if (!bytes) return { ok: false, reason: res.body ? "over 2 MB" : "empty" };
    if (sniffImage(bytes) !== type) return { ok: false, reason: `bytes are not ${type}` };
    const size = imageSize(bytes, type);
    if (!size) return { ok: false, reason: "size unreadable" };
    if (!photoSizeOk(size.width, size.height)) return { ok: false, reason: `${size.width}x${size.height} is too small or not photo-shaped` };
    if (bytes.length / (size.width * size.height) < (FLAT[type] || FLAT.other)) return { ok: false, reason: "a flat graphic, not a photo" };
    return { ok: true, bytes, type, ...size };
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return { ok: false, reason: timedOut ? "took too long" : "fetch failed" };
  }
}

// Tries up to three candidates and saves the first good one under photo:<id>. Returns { photo, misses }:
// photo = { stored: true, width, height, source } or null; misses = one short line per candidate that failed.
// An aborted signal stops the tries and skips the save, so a late photo never lands after the audit moved on.
export async function savePhoto(env, id, candidates, { signal = null, referer = null } = {}) {
  const misses = [];
  if (!env?.AUDITS || !id) return { photo: null, misses };
  for (const c of (candidates || []).slice(0, TRIES)) {
    if (signal?.aborted) break;
    const got = await fetchPhoto(c.url, { signal, referer });
    if (!got.ok) { misses.push(`${String(c.url).slice(0, 120)}: ${got.reason}`); continue; }
    if (signal?.aborted) break;
    // KV metadata is capped at 1024 bytes of JSON, so the source address is cut short well under that.
    const metadata = { type: got.type, width: got.width, height: got.height, source: String(c.source || "").slice(0, 20), from: String(c.url).slice(0, 400) };
    await env.AUDITS.put(`photo:${id}`, got.bytes, { expirationTtl: YEAR, metadata });
    return { photo: { stored: true, width: got.width, height: got.height, source: c.source }, misses };
  }
  return { photo: null, misses };
}
