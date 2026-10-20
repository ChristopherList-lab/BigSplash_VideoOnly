// Fixed scoring rules, so every church is graded the same way. Each area earns points out of 100, then a
// letter. An area the audit could not check gets no points, no letter and no findings. Findings are the facts
// behind the grades, ordered by how much they cost a church in guests; the write-up turns them into notes.

export function letter(points) {
  if (points === null || points === undefined) return null;
  if (points >= 90) return "A";
  if (points >= 80) return "B";
  if (points >= 70) return "C";
  if (points >= 60) return "D";
  return "F";
}

// Points for the first step the value reaches, highest step first.
function tier(value, steps, otherwise = 0) {
  for (const [min, pts] of steps) if (value >= min) return pts;
  return otherwise;
}

// Points for the first step the value stays under, lowest step first (ranks, days).
function upTo(value, steps, otherwise = 0) {
  for (const [max, pts] of steps) if (value <= max) return pts;
  return otherwise;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const stars = (r) => Number(r).toFixed(1);

// "In a Google search for "church" from about 4 miles north, City Reach Church came up #7."
export function rankFact(name, nearMe) {
  const done = (nearMe?.searches || []).filter((s) => s.checked);
  if (!done.length) return null;
  const hit = done.filter((s) => s.rank).sort((a, b) => a.rank - b.rank)[0];
  const s = hit || done[0];
  const where = `In a Google search for "church" from about ${Math.round(s.milesAway) || 4} miles ${s.from}`;
  if (hit) return `${where}, ${name} came up #${hit.rank}.`;
  return s.scanned >= 60
    ? `${where}, ${name} did not come up in the first 60 churches.`
    : `${where}, ${name} did not come up among the ${s.scanned} churches Google listed.`;
}

export function scoreAudit(a) {
  const findings = [];
  // fix = the action for "Start here" (null for a plain fact), why = what that fix changes for a family.
  const add = (area, impact, fact, fix, why = null) => findings.push({ area, impact, fact, fix, why });
  const name = a.church?.name || "The church";
  // Only a listing the audit trusts is this church's. Anything else is not graded.
  const g = a.google?.found && a.google.trusted !== false ? a.google : null;

  // Google listing and search
  let google = null;
  if (g) {
    const nm = a.nearMe?.checked ? a.nearMe : null;
    let pts = 30 + (g.hoursListed ? 20 : 0) + (g.website ? 10 : 0), max = 60;
    if (nm) {
      pts += nm.best ? upTo(nm.best, [[3, 40], [6, 32], [10, 24], [20, 16], [60, 10]], 10) : 4;
      max = 100;
    }
    google = Math.round((pts / max) * 100);
    if (nm && (!nm.best || nm.best > 3)) add("google", nm.best ? 7 : 8, rankFact(name, nm), "Add photos and ask for reviews on your Google listing", "A complete, well-reviewed listing gives a family searching nearby more reasons to pick your church.");
    if (!g.hoursListed) add("google", 6, "The Google listing has no service times or hours.", "Add your service times to Google", "A family can see when to come without leaving Google.");
    if (!g.website) add("google", 4, "The Google listing does not link to your website.", "Add your website to your Google listing", "One tap takes a family from Google to your website.");
  }

  // Reviews
  let reviews = null;
  if (g) {
    const count = g.reviewCount || 0;
    const rating = count > 0 && typeof g.rating === "number" ? g.rating : null;
    reviews = (rating === null ? 0 : tier(rating, [[4.7, 60], [4.4, 50], [4.0, 36], [3.5, 20]])) + tier(count, [[50, 40], [25, 32], [10, 22], [5, 14], [1, 8]]);
    const ask = "Reviews from your members tell a new family what a Sunday feels like.";
    if (count === 0) add("reviews", 6, `${name} has no Google reviews yet.`, "Ask your members for Google reviews", ask);
    else if (count < 25) add("reviews", 5, rating >= 4.4 ? `${name} has ${stars(rating)} stars, but only ${plural(count, "Google review")}.` : `${name} has ${plural(count, "Google review")}.`, "Ask your members for Google reviews", ask);
    if (rating !== null && rating < 4.4) add("reviews", 5, `The Google rating is ${stars(rating)} stars.`, "Reply to every Google review, kind or not", "A kind reply shows a visitor how your church treats people.");
    // 4.4 to 4.6 earns fewer points but is a good rating: a plain fact, never a problem or a fix.
    else if (rating !== null && rating < 4.7 && count >= 25) add("reviews", 1, `The Google rating is ${stars(rating)} stars from ${plural(count, "review")}.`, null);
  }

  // Website, only when the audit could read the home page
  let website = null;
  const w = a.website?.checked ? a.website : null;
  if (w) {
    const speed = a.speed?.ok ? a.speed.score : null;
    const field = a.speed?.ok ? a.speed.fieldLcpSeconds || null : null;
    // Real visitors beat the lab test when Google has them; the lab score swings from run to run.
    const speedPts = field ? upTo(field, [[2.5, 16], [4, 11]], 5) : speed === null ? 11 : tier(speed, [[90, 16], [70, 14], [50, 11], [30, 8]], 5);
    const pts = (w.https ? 8 : 0) + (w.viewport ? 8 : 0) + (w.serviceTimes?.found ? 24 : 0) + (w.planVisit?.found ? 20 : 0) + (w.kids?.found ? 12 : 0) + speedPts;
    website = Math.round((pts / 88) * 100);
    if (!w.serviceTimes?.found) add("website", 9, "We couldn't find service times on the home page.", "Put service times at the top of your home page", "A family sees when to come in the first few seconds.");
    if (!w.planVisit?.found) add("website", 8, "We couldn't find a plan-your-visit or I'm-new link on the home page.", "Link a Plan Your Visit page from the top of your home page", "A first-time family learns where to park, where to go and what to expect.");
    if (!w.kids?.found) add("website", 6, "We couldn't find a link for kids or families on the home page.", "Link your kids ministry from the home page", "Parents can see their kids will be safe and welcome before Sunday.");
    const faster = "Families on a phone see your home page sooner.";
    if (field && field > 2.5) add("website", 5, `Real visitors on phones wait about ${field} seconds for the main content to show.`, "Speed up your website on phones", faster);
    else if (!field && speed !== null && speed < 50) add("website", 5, `Google's phone speed test, which simulates a slow cell connection, scores the site ${speed} out of 100.`, "Speed up your website on phones", faster);
    if (!w.https) add("website", 5, "The site did not load over a secure (https) connection.", "Turn on a secure https connection", "Phones stop warning visitors that the site is not secure.");
    if (!w.viewport) add("website", 5, "The home page is not set up to fit a phone screen.", "Make your website work on phones", "Families can read the site without pinching and zooming.");
  }

  // Social and sermons, from the same home page
  let social = null;
  if (w) {
    const s = w.socials || {};
    const linked = ["facebook", "instagram", "youtube", "tiktok", "vimeo"].filter((k) => s[k]).length;
    const sermons = Boolean(w.sermons?.found);
    const days = [w.youtube?.daysSinceLastUpload, w.vimeo?.daysSinceLastUpload].filter((d) => typeof d === "number");
    const newest = days.length ? Math.min(...days) : null;
    let fresh = newest;
    // A stale video account next to the church's own sermons page: the weekly sermons may live on that page,
    // so the old upload date says nothing about how often the church posts.
    const ownPage = (w.sermons?.sources || []).some((x) => x !== "YouTube" && x !== "Vimeo");
    const staleAccount = fresh !== null && fresh > 14 && ownPage;
    if (staleAccount) fresh = null;
    const linkPts = tier(linked, [[3, 30], [2, 22], [1, 12]]);
    // Unknown upload dates are graded like an unchecked search: out of the points that could be checked.
    social = sermons && fresh === null
      ? Math.round(((linkPts + 30) / 60) * 100)
      : linkPts + (sermons ? 30 : 0) + (fresh !== null ? upTo(fresh, [[7, 40], [14, 32], [30, 22], [60, 10]], 0) : 0);
    const post = "A recent sermon shows a family the church is active.";
    const follow = "Families can follow along between Sundays.";
    if (!sermons) add("social", 7, "We couldn't find a link to your sermons on the home page.", "Put last Sunday's sermon on your home page", "A family can hear you preach before they visit.");
    else if (staleAccount) add("social", 3, `The ${w.youtube?.daysSinceLastUpload === newest ? "YouTube" : "Vimeo"} account linked from your home page last posted ${newest} days ago.`, "Link the place you post sermons each week", "A family finds this week's sermon in one tap.");
    else if (fresh !== null && fresh > 14) add("social", 6, `The last sermon upload we found was ${fresh} days ago.`, "Post each Sunday's sermon", post);
    else if (fresh === null) add("social", 1, "We found your sermons online. This audit could not read their upload dates.", null);
    const NET = { facebook: "Facebook", instagram: "Instagram", youtube: "YouTube", tiktok: "TikTok", vimeo: "Vimeo" };
    const which = Object.keys(NET).filter((k) => s[k]).map((k) => NET[k]);
    const list = which.length > 1 ? `${which.slice(0, -1).join(", ")} and ${which.at(-1)}` : which[0];
    if (!linked) add("social", 5, "We couldn't find links to any social accounts on the home page.", "Link your social accounts from your website", follow);
    else if (linked < 3) add("social", linked === 1 ? 4 : 3, `The home page links to ${list} only${s.instagram ? "" : ". We couldn't find an Instagram link"}.`, s.instagram ? "Link your social accounts from your website" : "Link your Instagram from your website", follow);
    else if (!s.instagram) add("social", 2, "We couldn't find an Instagram link on the home page.", "Link your Instagram from your website", follow);
  }

  const areas = { google, reviews, website, social };
  const graded = Object.values(areas).filter((v) => v !== null);
  const overall = graded.length >= 3 ? Math.round(graded.reduce((x, y) => x + y, 0) / graded.length) : null;
  findings.sort((x, y) => y.impact - x.impact);

  return {
    overall: { points: overall, grade: letter(overall) },
    areas: Object.fromEntries(Object.entries(areas).map(([k, v]) => [k, { points: v, grade: letter(v), checked: v !== null }])),
    findings,
  };
}
