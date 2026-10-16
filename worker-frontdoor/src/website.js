// Website checks from a first-time guest's point of view, adapted from worker-churchaudit.
// Fetches the home page once, then answers: can a stranger find service times, a plan-your-visit page and
// something for kids, and which social accounts does the church link to? YouTube activity comes from the
// channel's public feed, so it needs no API key.

const UA = "Mozilla/5.0 (compatible; BigSplashFrontDoorAudit/1.0; +https://bigsplash.video/church)";

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

export function domainOf(raw) {
  const url = normalizeUrl(raw);
  if (!url) return null;
  return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
}

function textOf(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ");
}

// Every link on the page. The label is read up to the closing tag, however long the markup inside is:
// Squarespace wraps social icons in long SVG blocks that a length-capped pattern skips.
function links(html, base) {
  const out = [];
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    let href = m[1].trim();
    try { href = new URL(href, base).toString(); } catch { continue; }
    const close = html.indexOf("</a>", re.lastIndex);
    const inner = html.slice(re.lastIndex, close === -1 ? re.lastIndex + 400 : Math.min(close, re.lastIndex + 4000));
    out.push({ href, label: textOf(inner).trim().slice(0, 80) });
  }
  return out;
}

const SOCIAL = {
  facebook: /^https?:\/\/(?:www\.|m\.)?facebook\.com\/(?!sharer|share|dialog|plugins|tr\b)([A-Za-z0-9.\-_]+)/i,
  instagram: /^https?:\/\/(?:www\.)?instagram\.com\/(?!p\/|reel\/|explore\/)([A-Za-z0-9._]+)/i,
  youtube: /^https?:\/\/(?:www\.)?youtube\.com\/(?:channel\/|c\/|user\/|@)([A-Za-z0-9.\-_]+)/i,
  tiktok: /^https?:\/\/(?:www\.)?tiktok\.com\/@([A-Za-z0-9._]+)/i,
};

async function youtubeActivity(channelUrl) {
  try {
    // A /channel/UC... link carries the ID; /c/, /user/ and @handle links need the channel page read.
    let id = (channelUrl.match(/\/channel\/(UC[A-Za-z0-9_-]+)/) || [])[1];
    if (!id) {
      const page = await fetch(channelUrl, { headers: { "User-Agent": UA }, redirect: "follow" });
      if (!page.ok) return { url: channelUrl, found: false };
      const html = await page.text();
      id = (html.match(/"(?:externalId|channelId)":"(UC[A-Za-z0-9_-]+)"/) ||
            html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[A-Za-z0-9_-]+)"/) ||
            html.match(/itemprop=["']channelId["'][^>]+content=["'](UC[^"']+)["']/i) || [])[1];
    }
    if (!id) return { url: channelUrl, found: true };
    const rss = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`);
    if (!rss.ok) return { url: channelUrl, found: true };
    const xml = await rss.text();
    const entries = xml.match(/<entry>[\s\S]*?<\/entry>/g) || [];
    const dates = entries.map((e) => (e.match(/<published>([^<]+)<\/published>/) || [])[1]).filter(Boolean);
    if (!dates.length) return { url: channelUrl, found: true, videosInFeed: 0 };
    const now = Date.now();
    const days = dates.map((d) => Math.floor((now - new Date(d).getTime()) / 86400000));
    return {
      url: channelUrl,
      found: true,
      lastUpload: dates[0],
      daysSinceLastUpload: days[0],
      uploadsLast30Days: days.filter((d) => d <= 30).length,
      lastTitle: ((entries[0].match(/<title>([^<]+)<\/title>/) || [])[1] || "").slice(0, 120),
    };
  } catch {
    return { url: channelUrl, found: false };
  }
}

export async function checkWebsite(rawUrl) {
  const url = normalizeUrl(rawUrl);
  if (!url) return { ok: false, error: "No usable website address" };
  const started = Date.now();
  let res, html;
  try {
    res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
    html = await res.text();
  } catch (err) {
    return { ok: false, url, error: "Could not load the website" };
  }
  const responseMs = Date.now() - started;
  const finalUrl = res.url || url;
  const text = textOf(html);
  const all = links(html, finalUrl);

  const time = /\b(?:1[0-2]|[1-9])(?::[0-5]\d)?\s?(?:a\.?m\.?|p\.?m\.?)\b/i;
  const serviceWords = /\b(sunday|service|services|gathering|worship|saturday)\b/i;
  const timeMatch = text.match(new RegExp(`.{0,60}${time.source}.{0,40}`, "i"));
  const serviceTimes = time.test(text) && serviceWords.test(text);

  const visitRe = /(plan[-\s]?(a|your)?[-\s]?visit|i'?m[-\s]?new|new[-\s]?here|first[-\s]?time|visit us|guest)/i;
  const visit = all.find((l) => visitRe.test(l.label) || visitRe.test(l.href));

  const kidsRe = /\b(kids|children|nursery|preschool|students|youth|family ministry)\b/i;
  const kids = all.find((l) => kidsRe.test(l.label) || /\/(kids|children|nursery|students|youth)\b/i.test(l.href));

  const socials = {};
  for (const l of all) {
    for (const [name, re] of Object.entries(SOCIAL)) {
      const m = l.href.match(re);
      if (m && !socials[name]) socials[name] = { url: l.href.split("?")[0], handle: m[1].replace(/\/$/, "") };
    }
  }
  const youtube = socials.youtube ? await youtubeActivity(socials.youtube.url) : null;

  return {
    ok: res.ok,
    url,
    finalUrl,
    status: res.status,
    https: finalUrl.startsWith("https://"),
    viewport: /<meta[^>]+name=["']viewport["']/i.test(html),
    responseMs,
    title: ((html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1] || "").trim().slice(0, 120),
    serviceTimes: { found: serviceTimes, sample: serviceTimes && timeMatch ? timeMatch[0].trim().slice(0, 100) : null },
    planVisit: visit ? { found: true, label: visit.label, href: visit.href } : { found: false },
    kids: kids ? { found: true, label: kids.label, href: kids.href } : { found: false },
    socials,
    youtube,
  };
}
