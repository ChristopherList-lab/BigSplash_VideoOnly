// Bigsplash Church Audit — auto-audit Worker
// Takes a church website URL, returns auto-scored items keyed by exact item text
// matching the audit form. Frontend (audit/index.html) merges these into the form.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }
    if (request.method !== "POST") {
      return new Response("POST a JSON body { url: '...' }", {
        status: 405,
        headers: CORS,
      });
    }
    let body;
    try { body = await request.json(); }
    catch { return json({ error: "Invalid JSON" }, 400); }

    const rawUrl = (body.url || "").trim();
    if (!rawUrl) return json({ error: "url required" }, 400);

    try {
      const result = await runAudit(rawUrl);
      return json(result);
    } catch (err) {
      return json({ error: err.message || String(err) }, 500);
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

async function runAudit(rawUrl) {
  let url = rawUrl;
  if (!/^https?:\/\//i.test(url)) url = "https://" + url;
  const parsed = new URL(url);
  const origin = parsed.origin;

  const scores = {};
  const reasons = {};
  const detected = { origin };
  const set = (item, score, reason) => {
    scores[item] = score;
    reasons[item] = reason;
  };

  // ---- Fetch home page
  const t0 = Date.now();
  let homeRes, homeText, finalUrl;
  try {
    homeRes = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": "BigsplashAuditBot/1.0 (+https://bigsplash.video)" },
    });
    finalUrl = homeRes.url;
    homeText = await homeRes.text();
  } catch (err) {
    return { error: "Could not fetch site: " + err.message, attemptedUrl: url };
  }
  detected.responseMs = Date.now() - t0;
  detected.finalUrl = finalUrl;
  detected.status = homeRes.status;

  // ---- 1. HTTPS enforced
  set(
    "HTTPS enforced site-wide",
    finalUrl.startsWith("https://") ? 5 : 0,
    finalUrl.startsWith("https://")
      ? "Site loads over HTTPS"
      : "Site does not enforce HTTPS"
  );

  // ---- 2. Mobile viewport
  if (/<meta[^>]+name=["']viewport["']/i.test(homeText)) {
    set("Mobile experience equal to desktop", 4, "Viewport meta tag present (responsive likely; full mobile test requires human review)");
  } else {
    set("Mobile experience equal to desktop", 1, "No viewport meta tag — site likely not responsive");
  }

  // ---- 3. Page speed (server response time as proxy)
  const ms = detected.responseMs;
  let speedScore;
  if (ms < 500) speedScore = 5;
  else if (ms < 1000) speedScore = 4;
  else if (ms < 2000) speedScore = 3;
  else if (ms < 4000) speedScore = 2;
  else speedScore = 1;
  set("Page speed acceptable (LCP under 2.5s)", speedScore, `Server responded in ${ms}ms (proxy for full-page load — not actual LCP)`);

  // ---- 4. Meta tags
  const titleMatch = homeText.match(/<title[^>]*>([^<]+)<\/title>/i);
  const descMatch = homeText.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  const ogImage = homeText.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
  let metaScore = 0;
  if (titleMatch) metaScore += 2;
  if (descMatch) metaScore += 2;
  if (ogImage) metaScore += 1;
  set(
    "Meta title, description, OG image use brand assets",
    metaScore,
    `Title: ${titleMatch ? "✓" : "✗"}, Description: ${descMatch ? "✓" : "✗"}, OG Image: ${ogImage ? "✓" : "✗"}`
  );

  // ---- 5. Favicon
  const faviconLink = /<link[^>]+rel=["'](?:shortcut )?icon["']/i.test(homeText);
  if (faviconLink) {
    set("Favicon set and matches brand mark", 4, "<link rel=\"icon\"> present (visual brand match needs human check)");
  } else {
    let favOk = false;
    try {
      const favRes = await fetch(origin + "/favicon.ico", { method: "HEAD" });
      favOk = favRes.ok;
    } catch {}
    set(
      "Favicon set and matches brand mark",
      favOk ? 3 : 1,
      favOk ? "Default /favicon.ico exists (no <link> tag — not optimal)" : "No favicon found"
    );
  }

  // ---- 6. Sitemap
  try {
    const smRes = await fetch(origin + "/sitemap.xml");
    set(
      "Sitemap.xml submitted to Google Search Console",
      smRes.ok ? 4 : 1,
      smRes.ok ? "/sitemap.xml exists (Google submission status can't be auto-checked)" : "No /sitemap.xml found"
    );
  } catch {
    set("Sitemap.xml submitted to Google Search Console", 1, "Could not fetch /sitemap.xml");
  }

  // ---- 7. Schema markup
  if (
    /application\/ld\+json/i.test(homeText) ||
    /itemtype=["']https?:\/\/schema\.org/i.test(homeText)
  ) {
    set("Structured data / schema markup for church and events", 4, "Structured data detected (JSON-LD or microdata)");
  } else {
    set("Structured data / schema markup for church and events", 1, "No schema.org markup detected");
  }

  // ---- 8. Custom 404 page
  try {
    const fakePath = "/bigsplash-audit-404-test-" + Math.random().toString(36).slice(2, 8);
    const r404 = await fetch(origin + fakePath, { redirect: "follow" });
    if (r404.status === 404) {
      const t404 = await r404.text();
      if (t404.length > 1500) {
        set("404 page branded", 4, `Custom 404 page (${t404.length} bytes — likely branded)`);
      } else {
        set("404 page branded", 2, `Server returns 404 but page is minimal (${t404.length} bytes)`);
      }
    } else if (r404.status === 200) {
      set("404 page branded", 1, "Server returns 200 for unknown URL — no proper 404 handling");
    } else {
      set("404 page branded", 2, `Server returned ${r404.status} for unknown URL`);
    }
  } catch {
    set("404 page branded", null, "Could not test 404 page");
  }

  // ---- 9. Footer detection
  const footerMatch = homeText.match(/<footer[\s\S]*?<\/footer>/i);
  if (footerMatch) {
    const f = footerMatch[0];
    const hasEmail = /\b[\w._%+-]+@[\w.-]+\.\w{2,}\b/.test(f);
    const hasPhone = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.test(f);
    const hasSocial = /(facebook|instagram|twitter|youtube|tiktok|linkedin|x\.com)/i.test(f);
    const total = [hasEmail, hasPhone, hasSocial].filter(Boolean).length;
    const score = total === 3 ? 5 : total === 2 ? 4 : total === 1 ? 2 : 1;
    set(
      "Footer has correct legal name, contact, social",
      score,
      `Footer found. Email: ${hasEmail ? "✓" : "✗"}, Phone: ${hasPhone ? "✓" : "✗"}, Social links: ${hasSocial ? "✓" : "✗"}`
    );
  } else {
    set("Footer has correct legal name, contact, social", 1, "No <footer> element found in HTML");
  }

  // ---- 10. Social profile detection
  const socialPatterns = {
    facebook: /https?:\/\/(?:www\.)?facebook\.com\/[a-zA-Z0-9.\-_]+/g,
    instagram: /https?:\/\/(?:www\.)?instagram\.com\/[a-zA-Z0-9.\-_]+/g,
    youtube: /https?:\/\/(?:www\.)?youtube\.com\/(?:channel\/|c\/|user\/|@)[a-zA-Z0-9.\-_]+/g,
    tiktok: /https?:\/\/(?:www\.)?tiktok\.com\/@[a-zA-Z0-9.\-_]+/g,
    twitter: /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[a-zA-Z0-9.\-_]+/g,
    linkedin: /https?:\/\/(?:www\.)?linkedin\.com\/(?:company|in|school)\/[a-zA-Z0-9.\-_]+/g,
  };
  detected.socials = [];
  for (const [platform, regex] of Object.entries(socialPatterns)) {
    const matches = [...new Set((homeText.match(regex) || []).map(u => u.replace(/[.,)\]]+$/, "")))];
    if (matches.length) detected.socials.push({ platform, urls: matches });
  }
  if (detected.socials.length >= 2) {
    const handles = detected.socials.map(s => {
      const url = s.urls[0];
      return url.split("/").filter(Boolean).pop().replace(/^@/, "").toLowerCase();
    });
    const allMatch = handles.every(h => h === handles[0]);
    set(
      "Handle consistent across platforms",
      allMatch ? 5 : 2,
      `Handles: ${handles.join(" / ")}. ${allMatch ? "All match." : "Inconsistent — review manually."}`
    );
  }

  // ---- 15. Probe each social URL + YouTube cadence
  detected.socialHealth = [];
  let mostRecentDays = null;
  for (const s of detected.socials) {
    const url = s.urls[0];
    const info = { platform: s.platform, url, alive: false };
    try {
      const r = await fetch(url, {
        redirect: "follow",
        headers: { "User-Agent": "Mozilla/5.0 BigsplashAuditBot/1.0" },
      });
      info.alive = r.ok;
      info.status = r.status;
      if (r.ok) {
        const text = await r.text();
        const ogImg = text.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
        const ogDesc = text.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i);
        if (ogImg) info.profileImage = ogImg[1];
        if (ogDesc) info.bio = ogDesc[1].slice(0, 200);

        // YouTube: extract channel_id, fetch RSS, get latest upload
        if (s.platform === "youtube") {
          const cidMatch = text.match(/"channelId":"(UC[a-zA-Z0-9_-]+)"/) ||
                           text.match(/<meta[^>]+itemprop=["']channelId["'][^>]+content=["']([^"']+)["']/i);
          if (cidMatch) {
            info.channelId = cidMatch[1];
            try {
              const rssRes = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${cidMatch[1]}`);
              if (rssRes.ok) {
                const rss = await rssRes.text();
                // First <entry> block is the most recent video; channel-level <published> is before <entry> so we scope match inside the first entry
                const firstEntry = rss.match(/<entry>[\s\S]*?<\/entry>/);
                if (firstEntry) {
                  const entryBlock = firstEntry[0];
                  const pubMatch = entryBlock.match(/<published>([^<]+)<\/published>/);
                  if (pubMatch) {
                    info.lastUpload = pubMatch[1];
                    const days = Math.floor((Date.now() - new Date(pubMatch[1]).getTime()) / 86400000);
                    info.daysSinceLastUpload = days;
                    if (mostRecentDays === null || days < mostRecentDays) mostRecentDays = days;
                  }
                  const titleMatch = entryBlock.match(/<title>([^<]+)<\/title>/);
                  if (titleMatch) info.lastVideoTitle = titleMatch[1];
                }
              }
            } catch {}
          }
        }
      }
    } catch (err) {
      info.error = err.message;
    }
    detected.socialHealth.push(info);
  }

  // Score posting cadence based on most recent detectable activity (YouTube only for now)
  if (mostRecentDays !== null) {
    let cadenceScore;
    if (mostRecentDays <= 7) cadenceScore = 5;
    else if (mostRecentDays <= 14) cadenceScore = 4;
    else if (mostRecentDays <= 30) cadenceScore = 3;
    else if (mostRecentDays <= 60) cadenceScore = 2;
    else cadenceScore = 1;
    set(
      "Posting cadence consistent",
      cadenceScore,
      `Most recent YouTube upload: ${mostRecentDays} days ago. (Other platforms not auto-checkable.)`
    );
  }

  // ---- 11. Service times on home page
  const stripped = homeText.replace(/<script[\s\S]*?<\/script>/gi, " ")
                           .replace(/<style[\s\S]*?<\/style>/gi, " ")
                           .replace(/<[^>]+>/g, " ");
  const timePattern = /\b(?:1[0-2]|[1-9])(?::\d{2})?\s?(?:am|pm)\b/i;
  const sundayPattern = /\bsunday[s]?\b/i;
  if (timePattern.test(stripped) && (sundayPattern.test(stripped) || /service|gathering|worship/i.test(stripped))) {
    set("Service times prominent on home page", 4, "Time references + service/Sunday context found");
  } else if (timePattern.test(stripped)) {
    set("Service times prominent on home page", 3, "Time references found, no clear service context");
  } else {
    set("Service times prominent on home page", 1, "No service times detected on home page");
  }

  // ---- 12. Plan-a-visit page
  const visitLinkRe = /<a[^>]+href=["']([^"']*(?:plan|visit|first-?time|new-?here|i-?m-?new|guest)[^"']*)["'][^>]*>([^<]{1,80})<\/a>/i;
  const visitMatch = homeText.match(visitLinkRe);
  if (visitMatch) {
    set("Plan-a-visit page linked from header", 4, `Visit link found: "${visitMatch[2].trim()}" → ${visitMatch[1]}`);
  } else {
    set("Plan-a-visit page linked from header", 1, "No plan-a-visit / new-here link detected");
  }

  return { ok: true, scores, reasons, detected };
}
