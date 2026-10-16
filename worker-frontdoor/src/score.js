// Fixed scoring rules, so every church is graded the same way. Each area earns points out of 100,
// then a letter. Findings are the facts behind the grades, ordered by how much they cost a church in guests;
// the write-up step turns them into plain sentences.

export function letter(points) {
  if (points === null || points === undefined) return null;
  if (points >= 90) return "A";
  if (points >= 80) return "B";
  if (points >= 70) return "C";
  if (points >= 60) return "D";
  return "F";
}

function tier(value, steps) {
  for (const [min, pts] of steps) if (value >= min) return pts;
  return 0;
}

export function scoreAudit(a) {
  const findings = [];
  const add = (area, impact, fact, fix) => findings.push({ area, impact, fact, fix });

  // Google listing and search
  let google = null;
  if (a.google) {
    const g = a.google;
    if (!g.found) {
      google = 0;
      add("google", 10, "No Google listing came up for the church's name and city.", "Claim and fill out your Google Business Profile");
    } else {
      const rank = a.nearMe?.best ?? null;
      let pts = 20, max = 80;
      pts += rank === null ? 0 : rank <= 3 ? 45 : rank <= 6 ? 34 : rank <= 10 ? 22 : 12;
      pts += g.hoursListed ? 15 : 0;
      if (g.photoCount !== null) { pts += tier(g.photoCount, [[10, 20], [6, 14], [3, 8], [1, 4]]); max = 100; }
      google = Math.min(100, Math.round((pts / max) * 100));
      if (rank === null) add("google", 9, "The church did not show up in the top 20 when someone about 4 miles away searches \"church.\"", "Build up your Google listing so nearby families find you");
      else if (rank > 3) add("google", 7, `The church shows up at number ${rank} when someone about 4 miles away searches "church."`, "Build up your Google listing so nearby families find you");
      if (!g.hoursListed) add("google", 6, "The Google listing has no service times or hours.", "Add your service times to Google");
      if (g.photoCount !== null && g.photoCount < 6) add("google", 4, `The Google listing has ${g.photoCount} photo${g.photoCount === 1 ? "" : "s"}.`, "Add 10 photos of a real Sunday to Google");
    }
  }

  // Reviews
  let reviews = null;
  if (a.google?.found) {
    const g = a.google;
    reviews = tier(g.rating ?? 0, [[4.7, 50], [4.4, 40], [4.0, 28], [3.5, 15]]) + tier(g.reviewCount, [[150, 50], [75, 40], [30, 28], [10, 15], [1, 6]]);
    if (g.reviewCount < 30) add("reviews", 5, `The church has ${g.reviewCount} Google review${g.reviewCount === 1 ? "" : "s"}.`, "Ask your members for Google reviews");
    if ((g.rating ?? 0) < 4.4 && g.reviewCount > 0) add("reviews", 5, `The Google rating is ${g.rating}.`, "Reply to every Google review, kind or not");
  }

  // Website
  let website = null;
  if (a.website?.ok) {
    const w = a.website;
    let pts = 0;
    pts += w.https ? 8 : 0;
    pts += w.viewport ? 8 : 0;
    pts += w.serviceTimes.found ? 24 : 0;
    pts += w.planVisit.found ? 24 : 0;
    pts += w.kids.found ? 12 : 0;
    const speed = a.speed?.ok ? a.speed.score : null;
    // Phone speed scores swing 10 points between runs, so speed moves the grade without deciding it.
    pts += speed === null ? (w.responseMs < 1500 ? 14 : 6) : tier(speed, [[90, 24], [70, 20], [50, 15], [30, 10], [0, 4]]);
    website = pts;
    if (!w.serviceTimes.found) add("website", 9, "Service times are not on the home page.", "Put service times at the top of your home page");
    if (!w.planVisit.found) add("website", 8, "The home page has no plan-your-visit or I'm-new link.", "Add a Plan Your Visit page and link it up top");
    if (!w.kids.found) add("website", 6, "The home page does not point parents to anything for kids.", "Link your kids ministry from the home page");
    if (speed !== null && speed < 50) add("website", 6, `The site scores ${speed} out of 100 for speed on a phone${a.speed.loadTime ? `, with the main content taking ${a.speed.loadTime} to appear` : ""}.`, "Speed up your website on phones");
    if (!w.https) add("website", 5, "The site does not load over a secure (https) connection.", "Turn on a secure https connection");
    if (!w.viewport) add("website", 5, "The site is not set up for phone screens.", "Make your website work on phones");
  } else if (a.website) {
    website = 0;
    add("website", 10, "The website did not load.", "Get your website back online");
  }

  // Social and video
  let social = null;
  if (a.website?.ok) {
    const s = a.website.socials || {};
    const linked = ["facebook", "instagram", "youtube", "tiktok"].filter((k) => s[k]).length;
    let pts = tier(linked, [[3, 20], [2, 14], [1, 8]]);
    const yt = a.website.youtube;
    const ytDays = yt?.daysSinceLastUpload ?? null;
    const ytPts = ytDays === null ? 0 : tier(-ytDays, [[-7, 40], [-14, 32], [-30, 22], [-60, 10]]);
    const ig = a.instagram?.ok ? a.instagram : null;
    const igPts = ig ? tier(ig.postsLast30Days, [[12, 40], [8, 32], [4, 22], [1, 10]]) : null;
    if (igPts === null) pts += Math.round(ytPts * 2); // no Instagram data: YouTube carries the activity weight
    else pts += ytPts + igPts;
    social = Math.min(100, pts);
    if (!linked) add("social", 8, "The website does not link to any social accounts.", "Link your social accounts from your website");
    if (!s.youtube) add("social", 5, "The website does not link to a YouTube channel, so sermons are hard to find.", "Post sermons to YouTube and link the channel");
    else if (ytDays === null) add("social", 4, "The YouTube channel shows no recent uploads.", "Post each Sunday's sermon to YouTube");
    else if (ytDays > 14) add("social", 6, `The last YouTube upload was ${ytDays} days ago.`, "Post each Sunday's sermon to YouTube");
    if (ig && ig.postsLast30Days < 8) add("social", 6, `Instagram had ${ig.postsLast30Days} post${ig.postsLast30Days === 1 ? "" : "s"} in the last 30 days.`, "Post on Instagram at least twice a week");
    if (!s.instagram) add("social", 4, "The website does not link to an Instagram account.", "Link your Instagram from your website");
  }

  const areas = { google, reviews, website, social };
  const graded = Object.values(areas).filter((v) => v !== null);
  const overall = graded.length ? Math.round(graded.reduce((x, y) => x + y, 0) / graded.length) : null;
  findings.sort((x, y) => y.impact - x.impact);

  return {
    overall: { points: overall, grade: letter(overall) },
    areas: Object.fromEntries(Object.entries(areas).map(([k, v]) => [k, { points: v, grade: letter(v) }])),
    findings,
  };
}
