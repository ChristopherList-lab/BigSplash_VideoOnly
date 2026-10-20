// Website checks from a first-time guest's point of view. Opens the home page the way a phone does, then
// answers: can a stranger find service times, a plan-your-visit page and something for kids, which social
// accounts does the church link to, and where are the sermons? YouTube and Vimeo activity come from public
// feeds, so they need no API key. A page the audit could not read comes back checked:false, never as "down".
import { namesMatch, nameWords } from "./google.js";

export const PHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";
const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const PHONE = { "User-Agent": PHONE_UA, "Accept-Language": "en-US,en;q=0.9", Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" };
// YouTube and Vimeo pages: a desktop browser, with the consent cookie so a European edge never gets the consent wall.
const VIDEO = { "User-Agent": DESKTOP_UA, "Accept-Language": "en-US,en;q=0.9", Cookie: "SOCS=CAI; CONSENT=YES+1" };
const TIMEOUT_MS = 15000;
// The whole home-page check, every address variant and redirect hop included, stays under this.
const SITE_BUDGET_MS = 45000;
const MAX_BYTES = 2_000_000;
const DAY = 86400000;

export function normalizeUrl(raw) {
  let url = String(raw || "").trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return null;
    return u.toString();
  } catch {
    return null;
  }
}

// The part of a domain a church registers: cityreachchurch.com, or church.org.uk.
export function registrableDomain(host) {
  const parts = String(host || "").toLowerCase().replace(/\.$/, "").split(".");
  if (parts.length <= 2) return parts.join(".");
  const [sld, tld] = parts.slice(-2);
  return parts.slice(tld.length === 2 && ["co", "com", "org", "net", "ac", "gov", "edu"].includes(sld) ? -3 : -2).join(".");
}

// Hosts many churches share, where the domain alone says nothing about which church it is.
const SHARED = ["facebook.com", "instagram.com", "linktr.ee", "sites.google.com", "churchcenter.com", "subsplash.com", "wixsite.com", "square.site", "weebly.com", "godaddysites.com",
  "wordpress.com", "blogspot.com", "squarespace.com", "webflow.io", "business.site", "wix.com", "carrd.co", "tithely.com", "breezechms.com", "netlify.app", "github.io"];

// A comparable key for "is this the same website": the registrable domain, or on a shared host the
// church's own part of it (name.churchcenter.com, or facebook.com/<page>).
export function siteKey(raw) {
  const url = normalizeUrl(raw);
  if (!url) return null;
  const u = new URL(url);
  let host = u.hostname.toLowerCase().replace(/^(www|m|web|mobile)\./, "");
  const shared = SHARED.find((h) => host === h || host.endsWith("." + h));
  if (!shared) return registrableDomain(host);
  if (shared === "facebook.com" || shared === "instagram.com") host = shared;
  if (host !== shared && shared !== "wixsite.com") return host; // the subdomain already names the church
  const segs = u.pathname.toLowerCase().split("/").filter(Boolean);
  let seg = segs[0] || "";
  if (seg === "profile.php") seg += "?id=" + (u.searchParams.get("id") || "");
  if (shared === "sites.google.com" && ["view", "site"].includes(seg)) seg += "/" + (segs[1] || "");
  return `${host}/${seg}`;
}

export function sameSite(a, b) {
  const x = siteKey(a), y = siteKey(b);
  return Boolean(x && y && x === y);
}

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"', ndash: "-", mdash: "-", hellip: "...", middot: "·", bull: "•", copy: "©", reg: "®", trade: "™", eacute: "é", rarr: "→", larr: "←", raquo: "»", laquo: "«" };

// HTML entities to text, and curly quotes to straight ones, so I&#8217;m New reads as I'm New.
export function decode(s) {
  return String(s || "")
    .replace(/&#(\d+);?/g, (_, n) => safeChar(Number(n)))
    .replace(/&#x([0-9a-f]+);?/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED[name.toLowerCase()] ?? m)
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„″]/g, '"');
}

function safeChar(code) {
  try { return String.fromCodePoint(code); } catch { return " "; }
}

function textOf(html) {
  return decode(String(html)
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

// One attribute from a tag's markup, quoted with " or ' or not quoted at all.
function attr(tag, name) {
  const m = tag.match(new RegExp(`[\\s"'/]${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"));
  return m ? decode(m[1] ?? m[2] ?? m[3]).trim() : null;
}

function absolute(raw, base) {
  if (!raw || /^(javascript|mailto|tel|sms|data):/i.test(raw)) return null;
  try {
    const u = new URL(raw, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

// Every link and embedded frame on the page. The label is read up to the closing tag, however long the
// markup inside is: Squarespace wraps social icons in long SVG blocks.
export function links(html, base) {
  const out = [];
  const re = /<a\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const raw = attr(m[1], "href");
    const href = absolute(raw, base);
    if (!href) continue;
    const frag = ((raw.match(/#([\w-]+)/) || [])[1] || "").toLowerCase();
    const rest = html.slice(re.lastIndex, re.lastIndex + 4000);
    const end = rest.search(/<\/a\s*>/i);
    const inner = end === -1 ? rest.slice(0, 400) : rest.slice(0, end);
    const label = textOf(inner) || attr(m[1], "aria-label") || attr(m[1], "title") || attr(inner, "alt") || "";
    out.push({ href, label: label.slice(0, 80), tag: "a", frag });
  }
  const frames = /<i?frame\b([^>]*)>/gi;
  while ((m = frames.exec(html))) {
    const href = absolute(attr(m[1], "src") || attr(m[1], "data-src"), base);
    if (href) out.push({ href, label: "", tag: "frame" });
  }
  return out;
}

async function readCapped(res, max = MAX_BYTES) {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let out = "", size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    out += dec.decode(value, { stream: true });
    if (size >= max) { reader.cancel().catch(() => {}); break; }
  }
  return out + dec.decode();
}

async function getPage(url, headers = PHONE, timeout = TIMEOUT_MS) {
  const res = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(timeout) });
  return { res, body: await readCapped(res), url: res.url || url };
}

const CHALLENGE = /<title>\s*(?:just a moment|attention required|checking your browser)|sgcaptcha|_cf_chl_opt|enable javascript and cookies to continue/i;

// One fetch, sorted into: a page we can read, a page that is not there, or something that kept us out.
async function tryUrl(url, timeout = TIMEOUT_MS) {
  const started = Date.now();
  try {
    const { res, body, url: finalUrl } = await getPage(url, PHONE, timeout);
    const s = res.status;
    if (CHALLENGE.test(body.slice(0, 30000))) return { kind: "blocked", status: s, reason: "a bot check page stopped the audit" };
    if (s === 404 || s === 410) return { kind: "missing", status: s };
    if (s === 530 && /\b1016\b|dns/i.test(body)) return { kind: "missing", status: s };
    if ([401, 403, 429, 503].includes(s)) return { kind: "blocked", status: s, reason: `the site turned the audit away (${s})` };
    if (!res.ok) return { kind: "blocked", status: s, reason: `the site answered with an error (${s})` };
    const type = res.headers.get("content-type") || "";
    if (type && !/html|xml/i.test(type)) return { kind: "blocked", status: s, reason: `the address returned ${type.split(";")[0]}, not a web page` };
    return { kind: "ok", status: s, html: body, finalUrl, ms: Date.now() - started };
  } catch (err) {
    const code = err?.cause?.code || err?.code || "";
    if (code === "ENOTFOUND") return { kind: "missing", status: null };
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return { kind: "error", status: null, reason: timedOut ? "the site took too long to answer" : `the connection failed${code ? ` (${code})` : ""}` };
  }
}

// The typed address first, then with or without www, then plain http.
function variants(url) {
  const u = new URL(url);
  const host = u.hostname;
  const alt = host.startsWith("www.") ? host.slice(4) : "www." + host;
  const rest = u.pathname + u.search;
  const list = [url];
  for (const proto of ["https:", "http:"]) for (const h of [host, alt]) list.push(`${proto}//${h}${rest}`);
  return [...new Set(list.map((x) => new URL(x).toString()))];
}

const JS_NOTICE = /(?:enable|turn on|requires?|need)\s+javascript|javascript (?:is )?(?:disabled|required|must be enabled)/i;

function isThin(html, text, linkCount) {
  if (text.length < 400 || linkCount < 5) return true;
  const noscript = (html.match(/<noscript\b[\s\S]*?<\/noscript\s*>/gi) || []).map((n) => textOf(n.replace(/^<noscript[^>]*>|<\/noscript\s*>$/gi, ""))).join(" ");
  // A real page can carry a stray "enable JavaScript" note; only a short page that leans on one is a shell.
  return text.length < 1500 && (JS_NOTICE.test(noscript) || JS_NOTICE.test(text));
}

// Where a page sends the browser next: a meta refresh, a bare window.location script or a full-page frame.
function nextHop(html, base, thin) {
  const meta = (html.match(/<meta\b[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/i) || [])[0];
  const metaUrl = meta && ((attr(meta, "content") || "").match(/url\s*=\s*['"]?([^'"\s]+)/i) || [])[1];
  if (metaUrl) return absolute(metaUrl, base);
  const frame = (html.match(/<frame\b[^>]*>/i) || [])[0];
  if (frame) return absolute(attr(frame, "src"), base);
  if (!thin) return null;
  const js = html.match(/(?:window\.|document\.|top\.|self\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']|location\.(?:replace|assign)\(\s*["']([^"']+)["']/);
  if (js) return absolute(js[1] || js[2], base);
  const iframes = html.match(/<iframe\b[^>]*>/gi) || [];
  if (iframes.length === 1) {
    const src = absolute(attr(iframes[0], "src"), base);
    if (src && !/youtube|youtu\.be|vimeo|google|facebook/i.test(new URL(src).hostname)) return src;
  }
  return null;
}

const segsOf = (href) => new URL(href).pathname.toLowerCase().split("/").filter(Boolean);
const hostOf = (href) => new URL(href).hostname.toLowerCase().replace(/^(www|m|web|mobile)\./, "");
const clean = (label) => label.toLowerCase().replace(/\s+/g, " ").trim();

const VISIT_LABEL = /\bvisit(?:ing|ors?)?\b|\bplan (?:your|a) (?:first )?(?:visit|sunday)\b|\bwhat to expect\b|\bstart here\b|\bnew here\b|\bnew to\b|\bi'?m new\b|\bfirst[- ]time\b|\bfirst visit\b|\bguests?\b|\bwelcome\b/;
const VISIT_PATH = /^(?:visit|plan(?:$|[-_]|your|a)|new$|new[-_]here|newhere|im-?new|i-m-new|start-?here|what-?to-?expect|welcome|first-?time|guests?(?:$|[-_]))/;
const KIDS_LABEL = /\b(?:kids?|kid's|kidz|children'?s?|famil(?:y|ies)|next ?gen|little ones|elementary|nursery|students?|youth|sunday school|preschool|pre-k|christian education|vbs|vacation bible school|awana)\b/;
const KIDS_PATH = /^(?:kids?|kidz|kid-s|children|childrens|family|families|next-?gen|little-?ones|elementary|nursery|students?|youth|sunday-?school|preschool|pre-?k|christian-?ed(?:ucation)?|vbs|awana)(?:$|[-_])/;
// Sermon links. "Send us a message", "Social media" and "Watch party" are not sermons.
const SERMON_NOT = /\b(?:send|message us|text|social media|watch party|contact|email|prayer)\b/;
const SERMON_LABEL = /\b(?:sermons?|messages|podcasts?|livestream|live ?stream(?:ing)?)\b|^(?:watch|media|listen|live|online)$|\b(?:watch|listen) (?:live|online|now|again|sermons?|messages)\b|\blive online\b|\bchurch online\b/;
const SERMON_PATH = /^(?:sermons?|messages|watch|media|podcasts?|listen|live|livestream|live-stream)(?:$|[-_.])/;
const SERMON_PATH_NOT = /(?:^|[-_])(?:us|party|contact|kit|form|prayer)(?:$|[-_.])/;
// A link into a times or locations page: /service-times, /locations/downtown.
const TIMES_PATH = /^(?:service-?times|times|locations?|campus(?:es)?|gatherings?|when-?we-?meet)$/;
const TIMES_LABEL = /^(?:our )?(?:sunday )?(?:service ?times?|times|gatherings?|when we meet|locations?|campuses)(?: (?:&|and) (?:times|locations?|service times))?$/;
const SOCIAL_HOST = /(?:^|\.)(?:facebook|instagram|youtube|youtu|tiktok|vimeo|twitter|x|linkedin)\.(?:com|be)$/;

// Social and video links, with the parts the activity checks need.
function socialOf(href) {
  const u = new URL(href);
  const host = hostOf(href);
  const p = u.pathname.split("/").filter(Boolean);
  const first = p[0] || "";
  if (/sharer|\/share\b|\/intent\//i.test(u.pathname)) return null;
  if (host === "facebook.com" || host === "fb.com") {
    if (first === "plugins") { const page = u.searchParams.get("href"); return page && /facebook\.com/i.test(page) ? socialOf(absolute(page, href) || href) : null; }
    if (!first || ["dialog", "tr", "login", "watch", "share", "sharer.php", "home.php"].includes(first.toLowerCase())) return null;
    const handle = first === "profile.php" ? `id ${u.searchParams.get("id") || ""}` : first;
    return { net: "facebook", url: first === "profile.php" ? href : `https://www.facebook.com/${first}`, handle };
  }
  if (host === "instagram.com") {
    if (!first || ["p", "reel", "reels", "explore", "stories", "tv", "accounts"].includes(first.toLowerCase())) return null;
    return { net: "instagram", url: `https://www.instagram.com/${first}`, handle: first };
  }
  if (host === "tiktok.com" && first.startsWith("@")) return { net: "tiktok", url: `https://www.tiktok.com/${first}`, handle: first };
  if (host === "youtu.be" && first) return { net: "youtube", url: href, handle: first, kind: "video", video: first };
  if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const f = first.toLowerCase();
    if (f === "channel" && /^UC[\w-]+$/.test(p[1] || "")) return { net: "youtube", url: href, handle: p[1], kind: "channel", channelId: p[1] };
    if ((f === "c" || f === "user") && p[1]) return { net: "youtube", url: href, handle: p[1], kind: "page" };
    if (first.startsWith("@")) return { net: "youtube", url: href, handle: first, kind: "page" };
    if (f === "embed" && p[1] === "live_stream") {
      const ch = u.searchParams.get("channel");
      return ch ? { net: "youtube", url: href, handle: ch, kind: "channel", channelId: ch } : null;
    }
    const list = u.searchParams.get("list");
    if (f === "playlist" || (f === "embed" && p[1] === "videoseries")) return list ? { net: "youtube", url: href, handle: list, kind: "playlist", list } : null;
    const video = f === "watch" ? u.searchParams.get("v") : ["embed", "live", "shorts", "v"].includes(f) ? p[1] : null;
    if (video) return { net: "youtube", url: href, handle: video, kind: "video", video };
    const reserved = ["results", "feed", "about", "t", "redirect", "premium", "kids", "gaming", "account", "signin", "logout", "upload", "howyoutubeworks", "ads", "creators", "yt", "s", "attribution_link", "hashtag", "iframe_api", "subscription_center", "watch", "embed", "live", "shorts", "playlist", "channel", "c", "user", "sw.js", "img", "favicon.ico"];
    if (first && !reserved.includes(f) && /^[\w.-]+$/.test(first)) return { net: "youtube", url: href, handle: first, kind: "page" };
    return null;
  }
  if (host === "player.vimeo.com") return p[0] === "video" && p[1] ? { net: "vimeo", url: href, handle: p[1], kind: "video" } : null;
  if (host === "vimeo.com") {
    const f = first.toLowerCase();
    if (!first) return null;
    if (["showcase", "album", "channels"].includes(f) && p[1]) return { net: "vimeo", url: href, handle: p[1], kind: "showcase" };
    if (/^\d+$/.test(first) || f === "event") return { net: "vimeo", url: href, handle: p[1] || first, kind: "video" };
    const reserved = ["video", "groups", "ondemand", "upgrade", "log_in", "join", "features", "blog", "help", "categories", "watch", "search", "about", "live", "manage", "home", "solutions", "enterprise", "create", "stock", "ott", "privacy", "terms", "cookie_policy", "user"];
    if (!reserved.includes(f) && /^[\w-]+$/.test(first)) return { net: "vimeo", url: `https://vimeo.com/${first}`, handle: first, kind: "user" };
  }
  return null;
}

const KIND_ORDER = { channel: 0, user: 0, page: 1, showcase: 1, playlist: 2, video: 3 };

function findSocials(all) {
  const socials = {};
  for (const l of all) {
    let s;
    try { s = socialOf(l.href); } catch { s = null; }
    if (!s) continue;
    const { net, ...rest } = s;
    const have = socials[net];
    if (!have || (KIND_ORDER[rest.kind] ?? 9) < (KIND_ORDER[have.kind] ?? 9)) socials[net] = rest;
  }
  return socials;
}

function isSermonLink(label, segs) {
  const text = clean(label);
  if (text && SERMON_NOT.test(text)) return false;
  if (text.length <= 40 && SERMON_LABEL.test(text)) return true;
  return segs.some((s) => SERMON_PATH.test(s) && !SERMON_PATH_NOT.test(s));
}

function findSermons(all, socials) {
  const sources = new Set();
  if (socials.youtube) sources.add("YouTube");
  if (socials.vimeo) sources.add("Vimeo");
  for (const l of all) {
    const host = hostOf(l.href);
    const segs = segsOf(l.href);
    if (host === "fb.watch" || (/(^|\.)facebook\.com$/.test(host) && segs.some((s) => ["videos", "live", "watch"].includes(s)))) sources.add("Facebook video");
    else if (/(^|\.)subsplash\.com$|^subspla\.sh$/.test(host)) sources.add("Subsplash");
    else if (/(^|\.)boxcast\.(tv|com)$/.test(host)) sources.add("BoxCast");
    else if (host.endsWith(".online.church")) sources.add("Church Online");
    else if (/(^|\.)livestream\.com$/.test(host)) sources.add("Livestream");
    else if (l.tag === "a" && !SOCIAL_HOST.test(host) && isSermonLink(l.label, segs)) sources.add("Sermons page");
  }
  return { found: sources.size > 0, sources: [...sources] };
}

// Service times: a time of day close to a service word, or a home-page link to the times page.
const TIME = /\b(?:(?:1[0-2]|0?[1-9]):[0-5]\d\s*(?:[ap]\.?\s?m\b\.?)?|(?:1[0-2]|0?[1-9])\s*[ap]\.?\s?m\b\.?|at\s+(?:1[0-2]|[1-9])\b(?!\s*(?:%|\d|of\b|location|campus|years?|days?|weeks?|people))|(?:1[0-2]|[1-9])\s*(?:&|and|\+)\s*(?:1[0-2]|[1-9])(?::[0-5]\d)?\b)/gi;
const SERVICE_WORD = /\b(?:services?|worship|gather(?:ing)?s?|sundays?|saturdays?|mass(?:es)?|celebration)\b/i;

// Office hours alone are not service times. A time belongs to office hours when "office" comes
// before it and nothing in between starts talking about services ("Office Hours: Mon - Thu, 9:00 AM - 4:00 PM").
const SERVICE_BREAK = /\b(?:services?|worship|gather(?:ing)?s?|mass(?:es)?|celebration)\b|(?:^|[.|;•·\n])\s*(?:join us\s+)?(?:on\s+)?(?:sundays?|saturdays?)\b/i;
function inOfficeHours(text, i) {
  const before = text.slice(Math.max(0, i - 150), i);
  const k = before.toLowerCase().lastIndexOf("office");
  return k >= 0 && !SERVICE_BREAK.test(before.slice(k + 6));
}

// A bare pair like "9 & 11" is a pair of service times only right after "at" or a service word
// ("Sundays 9 & 11"), never after ages, grades or a month ("Ages 2 and 3", "October 5 & 12").
const PAIR = /^(?:1[0-2]|[1-9])\s*(?:&|and|\+)/i;
const PAIR_LEAD = /(?:\bat|\b(?:services?|worship|gather(?:ing)?s?|sundays?|saturdays?|mass(?:es)?|celebrations?))[\s,:-]*$/i;

export function findServiceTimes(text, all = []) {
  for (const m of text.matchAll(TIME)) {
    const t = m[0];
    // h:mm without am/pm only counts on the quarter hour, so "John 3:16" is not a service time.
    if (/^\d{1,2}:(\d\d)$/.test(t.trim()) && !["00", "15", "30", "45"].includes(t.trim().slice(-2))) continue;
    const i = m.index;
    if (PAIR.test(t) && !PAIR_LEAD.test(text.slice(Math.max(0, i - 30), i))) continue;
    if (inOfficeHours(text, i)) continue;
    const near = text.slice(Math.max(0, i - 80), i + t.length + 80);
    if (!SERVICE_WORD.test(near)) continue;
    const from = Math.max(0, i - 60);
    const sample = text.slice(from, i + t.length + 40).replace(from ? /^\S*\s/ : /^/, "").replace(/\s\S*$/, "").trim();
    return { found: true, sample: sample.slice(0, 100), via: "text" };
  }
  const link = all.find((l) => l.tag === "a" && TIMES_LABEL.test(clean(l.label).replace(/[:.!?]+$/, ""))) ||
    all.find((l) => l.tag === "a" && !SOCIAL_HOST.test(hostOf(l.href)) && TIMES_PATH.test(segsOf(l.href)[0] || ""));
  if (link) return { found: true, sample: link.label, via: "link", href: link.href };
  return { found: false, sample: null, via: null };
}

// A link by its text first, then by its path. A one-page site's /#kids counts; a bare home link (the logo)
// never does, and neither does a link back to the page itself (a home page served at /welcome).
function findLink(all, labelRe, pathRe, self) {
  const usable = all.filter((l) => {
    if (l.tag !== "a" || SOCIAL_HOST.test(hostOf(l.href))) return false;
    if (!l.frag && self && l.href.replace(/\/$/, "") === self.replace(/[#?].*$/, "").replace(/\/$/, "")) return false;
    return segsOf(l.href).length > 0 || Boolean(l.frag);
  });
  return usable.find((l) => labelRe.test(clean(l.label))) ||
    usable.find((l) => [...segsOf(l.href), ...(l.frag ? [l.frag] : [])].some((s) => pathRe.test(s)));
}

const tagText = (xml, name) => decode(((xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`)) || [])[1] || "").replace(/^<!\[CDATA\[|\]\]>$/g, "")).trim();

function activity(items, now) {
  const seen = new Set();
  const list = [];
  for (const it of items) {
    if (!it.t || Number.isNaN(it.t) || seen.has(it.title)) continue;
    seen.add(it.title);
    list.push(it);
  }
  list.sort((a, b) => b.t - a.t);
  if (!list.length) return { lastUpload: null, daysSinceLastUpload: null, uploadsLast30Days: 0, lastTitle: null };
  return {
    lastUpload: new Date(list[0].t).toISOString(),
    daysSinceLastUpload: Math.max(0, Math.floor((now - list[0].t) / DAY)),
    uploadsLast30Days: list.filter((x) => now - x.t <= 30 * DAY).length,
    lastTitle: list[0].title.slice(0, 120),
  };
}

// Whether a video account belongs to this church: its name or handle shares a distinctive word with the
// church's name, or the handle matches the church's domain ("gbcgt" for gbcgt.org). An embedded worship
// song from another channel never stands in for the church's own uploads.
export function ownsChannel(owner, candidates) {
  if (!owner?.name) return true; // nothing to compare against (a direct call without a church)
  const compact = (v) => nameWords(v).join("");
  const core = nameWords(owner.name).filter((w) => !["church", "the", "of", "a", "at", "in", "and"].includes(w)).join("");
  let label = "";
  try { label = registrableDomain(new URL(normalizeUrl(owner.site) || "https://x.invalid").hostname).split(".")[0]; } catch {}
  return candidates.filter(Boolean).some((c) => {
    const cc = compact(c);
    if (!cc) return false;
    if (namesMatch(owner.name, c)) return true;
    if (core.length >= 5 && cc.includes(core)) return true;
    return label.length >= 4 && (cc === label || cc.includes(label) || (cc.length >= 5 && label.includes(cc)));
  });
}

// The church's photo for the scorecard. Candidates, best first: the share image (og:image, then
// twitter:image), then a hero background and the largest images near the top of the page. Logos, icons,
// SVGs and images known to be small or banner-shaped are skipped, and so is any picture the page also uses as
// its site icon or logo. A PNG (often a graphic) goes after any JPEG or WebP, and a file named like a designed
// graphic (a sermon series title, a slide, a flyer) goes after both. src/photo.js fetches them in order and
// checks the real size.
// wzsitethumbnails: the share image Weebly makes by screenshotting the site itself.
const PHOTO_URL_NOT = /logo|favicon|icon|avatar|badge|placeholder|spacer|sprite|wzsitethumbnails|(?:^|[^a-z])pixels?(?:[^a-z]|$)/;
const PHOTO_ALT_NOT = /logo|favicon|avatar|placeholder|spacer|\bicons?\b|\bbadges?\b|\bpixels?\b/i;
// Video thumbnails, maps and profile pictures are never the church's photo.
const NOT_PHOTO_HOST = /(?:^|\.)(?:ytimg\.com|vimeocdn\.com|maps\.googleapis\.com|maps\.gstatic\.com|gravatar\.com|fbcdn\.net|cdninstagram\.com)$/i;
const PHOTO_MIN_WIDTH = 600;
const PHOTO_ASPECT = [0.6, 2.5];
const PHOTO_TRIES = 3;
// File-name words for a designed graphic rather than a photo: "ACTS - Title.jpg", "COME TO THE TABLE SLIDE.jpg".
const GRAPHIC_NAME = /(?:^|[^a-z])(?:titles?|slides?|graphics?|flyers?|posters?|promos?|series|sermons?|invites?|invitations?|announcements?|save[-_ +]*the[-_ +]*date)(?:[^a-z]|$)/;
// Squarespace serves the original upload without a format; 1500w keeps it sharp and under the 2 MB cap.
const SQUARESPACE_WIDTH = 1500;

const intAttr = (tag, name) => {
  const v = attr(tag, name);
  return v && /^\d+(?:px)?$/i.test(v) ? parseInt(v, 10) : null;
};

// The srcset entry to fetch: the widest up to 2000w, else the narrowest above it. Width-less sets give a URL only.
function fromSrcset(set) {
  if (!set) return null;
  const items = set.trim().split(/,\s+/).map((part) => {
    const m = part.trim().match(/^(\S+)(?:\s+(\d+(?:\.\d+)?)([wx]))?/);
    return m ? { url: m[1].replace(/,$/, ""), w: m[3] === "w" ? Number(m[2]) : null, x: m[3] === "x" ? Number(m[2]) : null } : null;
  }).filter(Boolean);
  if (!items.length) return null;
  const sized = items.filter((i) => i.w).sort((a, b) => a.w - b.w);
  if (sized.length) return sized.filter((i) => i.w <= 2000).pop() || sized[0];
  return items.filter((i) => (i.x || 1) <= 2).sort((a, b) => (b.x || 1) - (a.x || 1))[0] || items[0];
}

// The file name, decoded and lowercased.
function fileName(url) {
  let name = "";
  try { name = new URL(url).pathname.split("/").filter(Boolean).pop() || ""; } catch {}
  try { name = decodeURIComponent(name); } catch {}
  return name.toLowerCase();
}

// The same picture at any size or format: a Wix media id, else the folder and the file name without its size,
// WordPress's cropped- prefix or the extension (Squarespace and WordPress folders are ids or months). A file
// name without an image extension (GetImage.ashx?guid=...) keeps its query, which names the picture.
function imageKey(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  let path = u.pathname;
  try { path = decodeURIComponent(path); } catch {}
  const wix = u.hostname === "static.wixstatic.com" && path.match(/^\/media\/([^/~.]+)/);
  if (wix) return `wix:${wix[1]}`;
  const parts = path.toLowerCase().split("/").filter(Boolean);
  const last = parts.pop() || "";
  if (!/\.(?:jpe?g|png|webp|avif|gif|svg|ico)$/.test(last)) return `${parts.pop() || ""}/${last}${u.search}`;
  const file = last.replace(/\.[a-z0-9]+$/, "").replace(/-\d{2,4}x\d{2,4}$/, "").replace(/-scaled$/, "").replace(/^cropped-/, "");
  return file ? `${parts.pop() || ""}/${file}` : null;
}

// Pictures the page uses as its site icon or logo: icon links, the tile image, logo <img>s (menu and footer
// included), Wix logo images and the logo in the page's structured data. A share image is often one of these.
function logoKeys(html, base) {
  const urls = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) if (/icon/i.test(attr(m[0], "rel") || "")) urls.push(attr(m[0], "href"));
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) if (/^msapplication-tileimage$/i.test(attr(m[0], "name") || "")) urls.push(attr(m[0], "content"));
  for (const m of html.matchAll(/<img\b[^>]*>/gi)) {
    if (!/logo/i.test(`${attr(m[0], "alt") || ""} ${attr(m[0], "class") || ""} ${attr(m[0], "id") || ""} ${attr(m[0], "src") || ""}`)) continue;
    urls.push(attr(m[0], "src"), attr(m[0], "data-src"), fromSrcset(attr(m[0], "srcset"))?.url);
  }
  for (const c of wixImages(html)) if (/logo/i.test(c.alt)) urls.push(c.url);
  for (const m of html.matchAll(/"logo"\s*:\s*(?:\{[^{}]*?"(?:url|contentUrl)"\s*:\s*)?"(https?:[^"]+)"/gi)) urls.push(m[1].replace(/\\\//g, "/"));
  return new Set(urls.map((u) => absolute(u, base)).filter(Boolean).map(imageKey).filter(Boolean));
}

// Wix draws its images from the data-image-info JSON on <wow-image>; the <img> inside has no address.
function wixImages(html) {
  const out = [];
  for (const m of html.matchAll(/<wow-image\b[^>]*>/gi)) {
    let d;
    try { d = JSON.parse(attr(m[0], "data-image-info") || "").imageData; } catch { continue; }
    const file = String(d?.uri || "").replace(/^https?:\/\/static\.wixstatic\.com\/media\//, "");
    if (!/^[\w-]+(?:~mv2)?\.(?:jpe?g|png|webp)$/i.test(file)) continue;
    const width = Number(d.width) > 0 ? Number(d.width) : null, height = Number(d.height) > 0 ? Number(d.height) : null;
    const url = `https://static.wixstatic.com/media/${file}` + (width && height ? `/v1/fill/w_${width},h_${height},al_c,q_85/${file}` : "");
    out.push({ url, width, height, alt: `${d.alt || ""} ${d.name || ""}`.trim(), cls: attr(m[0], "id") || "" });
  }
  return out;
}

const isPng = (u) => /\.png(?:$|\/)/i.test(u.pathname) || /[?&](?:format|fm)=png\b/i.test(u.search);

function photoOk(c) {
  let u;
  try { u = new URL(c.url); } catch { return false; }
  if (!/^https?:$/.test(u.protocol) || NOT_PHOTO_HOST.test(u.hostname)) return false;
  let path = u.pathname + u.search;
  try { path = decodeURIComponent(path); } catch {}
  path = path.toLowerCase();
  if (/\.(?:svgz?|gif|ico|bmp|tiff?)(?:$|\/)/.test(u.pathname.toLowerCase()) || /[?&](?:format|fm)=svg\b/.test(path)) return false;
  if (PHOTO_URL_NOT.test(path) || PHOTO_ALT_NOT.test(c.alt || "") || PHOTO_ALT_NOT.test(c.cls || "")) return false;
  if (c.width && c.width < PHOTO_MIN_WIDTH) return false;
  if (c.width && c.height && (c.width / c.height < PHOTO_ASPECT[0] || c.width / c.height > PHOTO_ASPECT[1])) return false;
  return true;
}

// Image hosts that size on request. A Squarespace image without a size asks for 1500w. A Wix image asks for
// its displayed size (the img width and height) up to 1600 wide, without the blurred low-res placeholder.
function cdnSized(c) {
  let u;
  try { u = new URL(c.url); } catch { return c; }
  const wix = u.hostname === "static.wixstatic.com" && u.pathname.match(/^(\/media\/[^/]+)\/v1\/(?:fill|fit|crop)\/([^/]+)\/([^/]+)$/);
  if (wix) {
    const asked = wix[2].match(/(?:^|,)w_(\d+),h_(\d+)/);
    const [w, h] = c.width && c.height ? [c.width, c.height] : asked ? [Number(asked[1]), Number(asked[2])] : [null, null];
    if (!w || !h) return c;
    const width = Math.min(w, 1600), height = Math.round(h * Math.min(w, 1600) / w);
    return { ...c, url: `${u.origin}${wix[1]}/v1/fill/w_${width},h_${height},al_c,q_85/${wix[3]}`, width, height };
  }
  if (!/(^|\.)squarespace-cdn\.com$/.test(u.hostname) || u.searchParams.has("format")) return c;
  u.searchParams.set("format", `${SQUARESPACE_WIDTH}w`);
  const out = { ...c, url: u.toString() };
  if (c.width > SQUARESPACE_WIDTH) {
    if (c.height) out.height = Math.round(c.height * SQUARESPACE_WIDTH / c.width);
    out.width = SQUARESPACE_WIDTH;
  }
  return out;
}

// One <img>: the URL to fetch (srcset first, then the lazy-load attributes, then src) and its known size.
function imgCandidate(tag, base) {
  const dims = (attr(tag, "data-image-dimensions") || "").match(/^(\d+)\s*x\s*(\d+)$/i);
  const aw = intAttr(tag, "width"), ah = intAttr(tag, "height");
  const [dw, dh] = dims ? [Number(dims[1]), Number(dims[2])] : [null, null];
  const set = fromSrcset(attr(tag, "srcset") || attr(tag, "data-srcset") || attr(tag, "data-lazy-srcset"));
  const ratio = aw && ah ? ah / aw : dw && dh ? dh / dw : null;
  let url, width, height;
  if (set?.w) {
    url = set.url; width = set.w; height = ratio ? Math.round(set.w * ratio) : null;
  } else {
    const raw = ["data-src", "data-lazy-src", "data-original", "data-image", "src"].map((n) => attr(tag, n))
      .find((v) => v && !/^data:/i.test(v) && !/blank\.(?:gif|png)|spacer|lazy[-_]?placeholder/i.test(v)) || set?.url;
    url = raw; width = dw || aw; height = dw ? dh : ah;
  }
  const abs = absolute(url, base);
  if (abs && !width) ({ width, height } = { width, height, ...sizeFromName(abs) });
  return abs ? { url: abs, width: width || null, height: height || null, alt: attr(tag, "alt") || "", cls: `${attr(tag, "class") || ""} ${attr(tag, "id") || ""}` } : null;
}

const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/i;
const HERO_SELECTOR = /hero|banner|masthead|jumbotron|cover|header|slide|splash|intro|landing|page-title/i;

// Background images: inline style or lazy-load attributes on the page's blocks, and <style> rules. A block or
// rule that reads like a hero (hero, banner, masthead, slide...) is a hero; any other block, such as a
// call-to-action card, ranks with the images whose size is unknown.
function backgrounds(body, html, base) {
  const hero = [], other = [];
  for (const m of body.matchAll(/<(?:div|section|header|figure|a|span|li|main|article)\b[^>]*>/gi)) {
    if (hero.length + other.length >= 8) break;
    const tag = m[0];
    const style = attr(tag, "style") || "";
    const raw = (/background(?:-image)?\s*:/i.test(style) && (style.match(CSS_URL) || [])[2]) ||
      attr(tag, "data-bg") || attr(tag, "data-background") || attr(tag, "data-background-image") || attr(tag, "data-bg-src");
    const url = raw && absolute((raw.match(CSS_URL) || [])[2] || raw, base);
    if (!url) continue;
    const cls = `${attr(tag, "class") || ""} ${attr(tag, "id") || ""}`;
    (HERO_SELECTOR.test(cls) ? hero : other).push({ url, source: "hero", cls, ...sizeFromName(url) });
  }
  for (const s of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi)) {
    // Split on braces rather than one regex: a long run with no brace made the regex take seconds.
    for (const chunk of s[1].split("}")) {
      if (hero.length >= 3) break;
      const parts = chunk.split("{");
      if (parts.length < 2) continue;
      const decl = parts.pop(), selector = parts.pop();
      if (!HERO_SELECTOR.test(selector) || !/background(?:-image)?\s*:/i.test(decl)) continue;
      const url = absolute(decode((decl.match(CSS_URL) || [])[2] || ""), base);
      if (url) hero.push({ url, source: "hero", ...sizeFromName(url) });
    }
  }
  return { hero, other };
}

// WordPress names its resized copies photo-1024x768.jpg: a known size for free.
function sizeFromName(url) {
  const m = url.match(/-(\d{2,4})x(\d{2,4})\.(?:jpe?g|png|webp|avif)(?:$|\?)/i);
  return m ? { width: Number(m[1]), height: Number(m[2]) } : {};
}

// website.photo is the first candidate; src/photo.js tries photoCandidates in order. Never throws.
function photoFields(html, pageUrl) {
  let list = [];
  try { list = findPhotos(html, pageUrl); } catch {}
  return { photo: list[0] || null, photoCandidates: list };
}

export function findPhotos(html, pageUrl, limit = PHOTO_TRIES) {
  const baseTag = (html.match(/<base\b[^>]*>/i) || [])[0];
  const base = (baseTag && absolute(attr(baseTag, "href"), pageUrl)) || pageUrl;

  // The share image, with its stated size when the page gives one.
  const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => [(attr(m[0], "property") || attr(m[0], "name") || "").toLowerCase(), attr(m[0], "content") || ""]);
  const share = (names, prefix, source) => {
    const i = metas.findIndex(([k, v]) => names.includes(k) && v);
    if (i === -1) return null;
    const url = absolute(metas[i][1], base);
    if (!url) return null;
    let width = null, height = null;
    for (const [k, v] of metas.slice(i + 1)) {
      if (names.includes(k)) break;
      if (k === `${prefix}:width` && /^\d+$/.test(v)) width = Number(v);
      if (k === `${prefix}:height` && /^\d+$/.test(v)) height = Number(v);
    }
    return { url, source, width, height };
  };
  const og = share(["og:image", "og:image:url", "og:image:secure_url"], "og:image", "og");
  const twitter = share(["twitter:image", "twitter:image:src"], "twitter:image", "twitter");

  // Images near the top of the page body, outside the menu and the footer. noscript stays: lazy loaders
  // often keep the real <img> there.
  const start = html.search(/<body\b/i);
  const body = (start === -1 ? html : html.slice(start))
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|template|svg|nav|footer)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const imgs = [...body.matchAll(/<img\b[^>]*>/gi)].slice(0, 40)
    .map((m, i) => ({ ...imgCandidate(m[0], base), source: "img", at: i }))
    .filter((c) => c.url)
    .concat(wixImages(body).slice(0, 20).map((c, i) => ({ ...c, source: "img", at: 40 + i })));
  const sized = imgs.filter((c) => c.width).sort((a, b) => Math.min(b.width, 1600) - Math.min(a.width, 1600) || a.at - b.at);
  const unsized = imgs.filter((c) => !c.width);

  const seen = new Set();
  // A share image with a stock name (facebook-share-default.jpg, og-image.png) or a square one is often the
  // logo on a color card or a slogan graphic, so every image on the page goes ahead of it.
  const bg = backgrounds(body, html, base);
  const stock = (c) => /share|social|default|open-?graph|\bog[-_]?image|fb[-_]?image|\bog\b/i.test(new URL(c.url).pathname) ||
    Boolean(c.width && c.height && Math.abs(c.width / c.height - 1) < 0.1);
  const shares = [og, twitter].filter(Boolean);
  const logos = logoKeys(html, base);
  const list = [...shares.filter((c) => !stock(c)), ...bg.hero, ...sized, ...bg.other, ...unsized, ...shares.filter(stock)].filter(Boolean).map(cdnSized).filter((c) => {
    if (seen.has(c.url) || !photoOk(c) || logos.has(imageKey(c.url))) return false;
    seen.add(c.url);
    return true;
  });
  // A PNG is often a graphic: any JPEG or WebP goes first. A file named like a designed graphic goes last.
  // Wix keeps the uploaded file name in the alt text, after any alt the church wrote.
  const graphic = (c) => GRAPHIC_NAME.test(fileName(c.url)) || (/\.(?:jpe?g|png|webp)$/i.test(c.alt || "") && GRAPHIC_NAME.test(c.alt.toLowerCase()));
  const tier = (c) => (graphic(c) ? 2 : 0) + (isPng(new URL(c.url)) ? 1 : 0);
  const ranked = list.map((c, i) => ({ c, i, t: tier(c) })).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.c);
  return ranked.slice(0, limit).map(({ url, source, width, height }) => ({ url, source, ...(width ? { width } : {}), ...(height ? { height } : {}) }));
}

// Time left before a deadline, capped at one fetch's timeout. Under a second means stop.
const left = (until, cap = 10000) => Math.min(cap, until - Date.now());
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// YouTube activity from the channel or playlist feed. Unknown stays null, never zero.
export async function youtubeActivity(yt, now = Date.now(), owner = null, until = Date.now() + 40000) {
  const out = { url: yt.url, found: true, checked: false, channelId: yt.channelId || null, lastUpload: null, daysSinceLastUpload: null, uploadsLast30Days: null, lastTitle: null };
  try {
    let feed;
    if (yt.kind === "playlist") feed = `https://www.youtube.com/feeds/videos.xml?playlist_id=${encodeURIComponent(yt.list)}`;
    else {
      if (!out.channelId) {
        const pageUrl = yt.kind === "video" ? `https://www.youtube.com/watch?v=${encodeURIComponent(yt.video)}` : yt.url;
        const { res, body } = await getPage(pageUrl, VIDEO, left(until));
        if (!res.ok) return out;
        out.channelId = (body.match(/"externalId":"(UC[\w-]{22})"/) ||
          body.match(/"externalChannelId":"(UC[\w-]{22})"/) ||
          body.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/) ||
          body.match(/itemprop=["']channelId["'][^>]*content=["'](UC[\w-]{22})["']/i) ||
          body.match(/"channelId":"(UC[\w-]{22})"/) || [])[1] || null;
        if (yt.kind === "video") {
          // A lone video: count it only when the channel behind it is the church's.
          const channelName = decode((body.match(/"ownerChannelName":"([^"]*)"/) || [])[1] || "");
          const handle = (body.match(/"ownerProfileUrl":"https?:\/\/www\.youtube\.com\/@?([^"\/]+)"/) || [])[1] || "";
          out.channelName = channelName || null;
          if (!ownsChannel(owner, [channelName, handle])) return { ...out, channelId: null, otherChannel: true };
        }
      }
      if (!out.channelId) return out;
      feed = `https://www.youtube.com/feeds/videos.xml?channel_id=${out.channelId}`;
    }
    // The feed often answers 404 or 500 for a channel that posted yesterday: try twice.
    let page = await getPage(feed, VIDEO, left(until)).catch(() => null);
    if (!page?.res.ok && left(until) > 3000) { await pause(500); page = await getPage(feed, VIDEO, left(until)).catch(() => null); }
    if (page?.res.ok) {
      const items = (page.body.match(/<entry>[\s\S]*?<\/entry>/g) || []).map((e) => ({ title: tagText(e, "title"), t: Date.parse(tagText(e, "published")) }));
      return { ...out, checked: true, ...activity(items, now) };
    }
    if (!out.channelId) return out;
    // Fallback: the channel's Videos and Live tabs say how long ago each upload went up ("9h ago",
    // "Streamed 1d ago"). That gives days, not a date, so lastUpload stays null.
    const unit = { min: 0, h: 1 / 24, d: 1, w: 7, mo: 30, y: 365 };
    const ages = [];
    for (const tab of ["videos", "streams"]) {
      if (left(until) < 1000) break;
      const p = await getPage(`https://www.youtube.com/channel/${out.channelId}/${tab}`, VIDEO, left(until)).catch(() => null);
      const m = p?.res.ok && p.body.match(/"content":"(?:Streamed )?(\d+)(min|mo|h|d|w|y) ago"/);
      if (m) ages.push(Math.floor(Number(m[1]) * unit[m[2]]));
    }
    if (!ages.length) return out;
    return { ...out, checked: true, daysSinceLastUpload: Math.min(...ages), via: "channel page" };
  } catch {
    return out;
  }
}

// Vimeo activity from a user's public feed. A showcase or a single video names its owner through Vimeo's
// oEmbed, and that owner's feed gives the dates. Unknown stays null, never zero.
export async function vimeoActivity(v, now = Date.now(), owner = null, until = Date.now() + 30000) {
  const out = { url: v.url, kind: v.kind, checked: false, lastUpload: null, daysSinceLastUpload: null, uploadsLast30Days: null, lastTitle: null };
  try {
    let handle = v.kind === "user" ? v.handle : null;
    let single = null;
    if (!handle) {
      const res = await fetch(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(v.url)}`, { headers: VIDEO, signal: AbortSignal.timeout(Math.max(1000, left(until))) });
      const o = res.ok ? await res.json().catch(() => null) : null;
      handle = (String(o?.author_url || "").match(/vimeo\.com\/([\w-]+)\/?$/) || [])[1] || null;
      // An embedded video only counts when its owner is the church.
      if (v.kind === "video" && handle && !ownsChannel(owner, [o?.author_name, handle])) return { ...out, otherChannel: true };
      const t = Date.parse(String(o?.upload_date || "").replace(" ", "T") + (o?.upload_date && !/Z|[+-]\d\d:?\d\d$/.test(o.upload_date) ? "Z" : ""));
      if (v.kind === "video" && !Number.isNaN(t)) single = { title: String(o.title || ""), t };
    }
    if (!handle) return out;
    out.account = `https://vimeo.com/${handle}`;
    const page = left(until) > 1000 ? await getPage(`https://vimeo.com/${encodeURIComponent(handle)}/videos/rss`, VIDEO, left(until)).catch(() => null) : null;
    if (page?.res.ok) {
      const items = (page.body.match(/<item>[\s\S]*?<\/item>/g) || []).map((e) => ({ title: tagText(e, "title"), t: Date.parse(tagText(e, "pubDate")) }));
      const known = activity(items, now);
      if (known.lastUpload) return { ...out, checked: true, ...known };
    }
    // No readable feed: the embedded video's own upload date is still a real date.
    if (single) return { ...out, checked: true, ...activity([single], now), uploadsLast30Days: null };
    return out;
  } catch {
    return out;
  }
}

// name = the church's name, so a video embedded from someone else's channel is never read as the church's.
export async function checkWebsite(rawUrl, { source = "typed", name = null } = {}) {
  const url = normalizeUrl(rawUrl);
  if (!url) return { ok: false, checked: false, reason: "no usable website address", url: rawUrl || null, source };

  // Every variant and hop shares one time budget. A host that timed out is not tried again under the
  // same scheme, so a site that drops packets costs two timeouts, not five.
  const until = Date.now() + SITE_BUDGET_MS;
  const slow = new Set();
  let hit = null, fail = null;
  for (const candidate of variants(url)) {
    const u = new URL(candidate);
    if (slow.has(u.protocol + u.hostname.replace(/^www\./, ""))) continue;
    const wait = left(until, TIMEOUT_MS);
    if (wait < 1000) { fail = fail || { kind: "error", status: null, reason: "the site took too long to answer" }; break; }
    const r = await tryUrl(candidate, wait);
    if (r.kind === "ok") { hit = r; break; }
    if (r.kind === "error" && /too long/.test(r.reason)) slow.add(u.protocol + u.hostname.replace(/^www\./, ""));
    if (r.kind !== "missing" && !fail) fail = r;
  }
  if (!hit) return { ok: false, checked: false, reason: fail ? fail.reason : "did not load", url, status: fail?.status ?? null, source };

  // Follow a meta refresh, a script redirect or a full-page frame, up to two hops.
  let { html, finalUrl, ms: responseMs, status } = hit;
  let all = links(html, finalUrl);
  let text = textOf(html);
  for (let hop = 0; hop < 2; hop++) {
    const next = nextHop(html, finalUrl, isThin(html, text, all.filter((l) => l.tag === "a").length));
    if (!next || next === finalUrl || left(until, TIMEOUT_MS) < 1000) break;
    const r = await tryUrl(next, left(until, TIMEOUT_MS));
    if (r.kind !== "ok") break;
    ({ html, finalUrl, status } = r);
    all = links(html, finalUrl);
    text = textOf(html);
  }

  const base = {
    url, finalUrl, status, source, responseMs,
    https: finalUrl.startsWith("https://"),
    title: textOf(((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "")).slice(0, 120),
    ...photoFields(html, finalUrl),
  };
  if (isThin(html, text, all.filter((l) => l.tag === "a").length)) {
    return { ok: false, checked: false, reason: "page builds itself with JavaScript", ...base };
  }

  const kids = findLink(all, KIDS_LABEL, KIDS_PATH, finalUrl);
  const visit = findLink(all, VISIT_LABEL, VISIT_PATH, finalUrl);
  const socials = findSocials(all);
  const sermons = findSermons(all, socials);
  const now = Date.now();
  const owner = name ? { name, site: finalUrl } : null;
  const videoUntil = Date.now() + 40000;
  const [youtube, vimeo] = await Promise.all([
    socials.youtube ? youtubeActivity(socials.youtube, now, owner, videoUntil) : null,
    socials.vimeo ? vimeoActivity(socials.vimeo, now, owner, videoUntil) : null,
  ]);
  // A lone video from another channel is not one of the church's accounts.
  if (youtube?.otherChannel) delete socials.youtube;
  if (vimeo?.otherChannel) delete socials.vimeo;

  return {
    ok: true,
    checked: true,
    reason: null,
    ...base,
    viewport: /<meta\b[^>]*[\s"']name\s*=\s*["']?viewport\b/i.test(html),
    serviceTimes: findServiceTimes(text, all),
    planVisit: visit ? { found: true, label: visit.label, href: visit.href } : { found: false },
    kids: kids ? { found: true, label: kids.label, href: kids.href } : { found: false },
    socials,
    sermons,
    youtube,
    vimeo,
  };
}
