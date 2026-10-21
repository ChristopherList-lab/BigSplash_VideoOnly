// Turns the audit facts into the scorecard's plain-language notes. Claude writes in Big Splash's church voice
// from the facts alone; if the call fails or no key is set, rule-based wording fills every field instead,
// so a pastor never waits on the write-up.
import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5-5";

const SYSTEM = `You write the notes on a Front Door Audit scorecard from Big Splash, the marketing agency for the local church. A pastor reads it to see what a new family sees when they look the church up online.

Voice:
- Write like a church member who knows how a Sunday runs. Warm, direct, plain. Short sentences.
- Say guests, families, neighbors, invitation, plan your visit. Never say leads, funnel, conversions, content or customers.
- Never call the church "holy" and never judge its faithfulness. The church is doing its part; the question is whether neighbors can find it.
- No hype, no guarantees of growth, no scripture, no exclamation points, no em dashes.
- Encourage first where the facts allow, then name the gap plainly.

Rules:
- Use only the facts provided. Never invent numbers, names, platforms or events.
- If an area was not checked, say it was not checked in this audit. Never call an area failing, weak or missing when it was not checked. A check that failed is our problem, never the church's.
- If the website did not load on a phone, or Google has no listing for the church, say so plainly and kindly and name the fix. A new family would run into the same thing.
- Never mention load times or seconds unless a real-visitor number is given. The phone speed score is a lab test on a simulated slow connection; call it that.
- Each fix must be something the church staff could start this week, written as an action.
- If upload dates were not checked, do not suggest posting more often and do not guess how recent the sermons are.
- If real visitors wait 2.5 seconds or less, do not tell the church to speed up the site.
- In each area, name one thing the church does well before the gap, when the facts show one.
- Only mention a search rank or household count when the facts give one.
- A finding marked "(fact only)" is not a problem; never turn it into a fix or the biggest gap.

Style:
- Active voice. No adverbs like really, just, actually or simply. Never write "not X, but Y"; state the point directly.`;

const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "areas", "fixes"],
  properties: {
    summary: { type: "string", description: "Two sentences: what a new family sees overall, then the biggest gap." },
    areas: {
      type: "object",
      additionalProperties: false,
      required: ["google", "reviews", "website", "social"],
      properties: {
        google: { type: "string", description: "One or two sentences on the Google listing and search results." },
        reviews: { type: "string", description: "One or two sentences on Google reviews." },
        website: { type: "string", description: "One or two sentences on the website as seen on a phone." },
        social: { type: "string", description: "One or two sentences on social media and sermon video." },
      },
    },
    fixes: {
      type: "array",
      description: "The top fixes in order of impact, at most three.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "why"],
        properties: {
          title: { type: "string", description: "The action, under 10 words." },
          why: { type: "string", description: "One sentence on what it changes for a new family." },
        },
      },
    },
  },
};

function factSheet(a) {
  const s = a.scores;
  const lines = [`Church: ${a.church.name}${a.church.city ? `, ${a.church.city}` : ""}`];
  const c = a.coverage;
  lines.push(`Overall grade: ${s.overall.grade ?? "not graded, nothing could be checked"}${s.overall.grade && c && c.graded < c.of ? ` (graded on ${c.graded} of ${c.of} areas; the rest could not be checked in this audit)` : ""}`);
  for (const [k, v] of Object.entries(s.areas)) lines.push(`${k} grade: ${v.grade ?? "not checked in this audit"}`);
  const g = a.google?.found && a.google.trusted !== false ? a.google : null;
  if (g) lines.push(`Google listing: rating ${g.reviewCount ? g.rating : "none yet"} from ${g.reviewCount} reviews, service hours ${g.hoursListed ? "listed" : "not listed"}, website ${g.website ? "on the listing" : "not on the listing"}.`);
  else if (a.google?.found === false && a.google.listed === false) lines.push("Google listing: none. Google Maps has no listing for this church's name and address, so there are no Google reviews either.");
  else lines.push("Google listing: not checked in this audit.");
  if (g && a.nearMe?.checked) {
    for (const r of a.nearMe.searches) {
      if (!r.checked) lines.push(`Search "church" from about 4 miles ${r.from}: not checked.`);
      else lines.push(`Search "church" from about ${Math.round(r.milesAway) || 4} miles ${r.from}: ${r.rank ? `#${r.rank}` : `not in the first ${r.scanned} results`}.`);
    }
  } else if (g) lines.push(`Search "church" from about 4 miles away: not checked.`);
  const w = a.website?.checked ? a.website : null;
  if (w) {
    const times = !w.serviceTimes.found ? "not found" : w.serviceTimes.via === "link" ? `not on the home page itself, but the home page links to them ("${w.serviceTimes.sample}")` : "found on the home page";
    lines.push(`Website (${w.finalUrl}): service times ${times}, plan-your-visit link ${w.planVisit.found ? `found ("${w.planVisit.label}")` : "not found"}, kids link ${w.kids.found ? "found" : "not found"}, secure connection ${w.https ? "yes" : "no"}.`);
    lines.push(`Social links on the website: ${Object.keys(w.socials).join(", ") || "none found"}.`);
    lines.push(`Sermons linked from the home page: ${w.sermons?.found ? w.sermons.sources.join(", ") : "none found"}.`);
    for (const [label, v] of [["YouTube", w.youtube], ["Vimeo", w.vimeo]]) {
      if (!v) continue;
      if (v.otherChannel) lines.push(`${label}: the only ${label} item on the home page is a video from another channel; not counted.`);
      else lines.push(typeof v.daysSinceLastUpload === "number" ? `${label}: last upload ${v.daysSinceLastUpload} days ago${typeof v.uploadsLast30Days === "number" ? `, ${v.uploadsLast30Days} uploads in 30 days` : ""}.` : `${label}: linked, upload dates not checked.`);
    }
  } else if (a.website?.down) {
    lines.push(`Website (${a.website.url}): did not load when we opened it on a phone (${a.website.reason}). A family would see an error too.`);
    lines.push("Social links and sermons: not checked in this audit. We read them from the home page, and it did not load.");
  } else lines.push("Website: not checked in this audit.");
  if (w && a.speed?.ok) lines.push(`Google phone speed test (lab test on a simulated slow cell connection): ${a.speed.score} out of 100.${a.speed.fieldLcpSeconds ? ` Real visitors on phones wait about ${a.speed.fieldLcpSeconds} seconds for the main content.` : " No real-visitor load time available."}`);
  else if (w) lines.push("Phone speed: not checked.");
  if (a.instagram?.ok) lines.push(`Instagram: ${a.instagram.postsLast30Days} posts in 30 days, last post ${a.instagram.daysSinceLastPost} days ago.`);
  if (a.reach) lines.push(`About ${a.reach.households.toLocaleString("en-US")} households live within ${a.reach.miles} miles.`);
  lines.push("Findings, most important first:");
  for (const f of s.findings) lines.push(`- [${f.area}] ${f.fact}${f.fix ? "" : " (fact only)"}`);
  if (!s.findings.length) lines.push("- No problems found in the areas checked.");
  return lines.join("\n");
}

const OPENERS = {
  A: "A new family can find what they need to plan a first visit.",
  B: "A new family can find most of what they need.",
  C: "A new family can find some of what they need.",
  D: "A new family will have trouble finding what they need.",
  F: "A new family will have trouble finding what they need.",
};
const NOT_CHECKED = "We couldn't check this one this time. We can go over it together on a call with our team.";
// The kind first sentence for an A or B area that still has a gap to name.
const LEADS = {
  google: "The Google listing has the basics.",
  reviews: "People who review you on Google rate you well.",
  website: "The home page has most of what a first-time guest looks for.",
  social: "A neighbor can find your sermons from the home page.",
};

// "The Google listing..." reads as "the Google listing..." mid-sentence; names and "Google's" keep their capital.
const midSentence = (fact) => /^(The|We|In|A|An|Real|Your|With)\b/.test(fact) ? fact.charAt(0).toLowerCase() + fact.slice(1) : fact;

// Plain wording built straight from the findings, used when Claude is unavailable.
export function fallbackNotes(a) {
  const s = a.scores;
  const by = (area) => s.findings.filter((f) => f.area === area);
  const note = (area, ok) => {
    const grade = s.areas[area].grade;
    if (grade === null) return NOT_CHECKED;
    const found = by(area);
    const good = grade === "A" || grade === "B";
    if (!found.length) return good ? ok : "There's room to grow here. We can go over it together on a call with our team.";
    // An A or B names what works before the gap; a plain fact with no fix stands on its own.
    if (good) return found[0].fix ? `${LEADS[area]} ${found[0].fact}` : found[0].fact;
    return found.slice(0, 2).map((f) => f.fact).join(" ");
  };
  // A plain fact with no fix (an unread upload date, a 4.5 rating) is never the biggest gap or a fix.
  const top = s.findings.find((f) => f.fix);
  const grade = s.overall.grade;
  const opener = grade === null ? "We couldn't check everything this time." : grade === "A" && top ? OPENERS.B : OPENERS[grade];
  const fixes = [];
  for (const f of s.findings) if (f.fix && fixes.length < 3 && !fixes.some((x) => x.title === f.fix)) fixes.push({ title: f.fix, why: f.why || f.fact });
  return {
    summary: top ? `${opener} The biggest gap: ${midSentence(top.fact)}` : opener,
    areas: {
      google: note("google", "The Google listing gives a neighbor what they need."),
      reviews: note("reviews", "Reviews look healthy."),
      website: note("website", "The website answers a first-time guest's questions."),
      social: note("social", "Your latest sermon went up recently, and the home page links to your social accounts."),
    },
    fixes,
    by: "rules",
  };
}

export async function writeNotes(a, env = {}) {
  if (!env.ANTHROPIC_API_KEY) return fallbackNotes(a);
  // An explicit base URL keeps a local ANTHROPIC_BASE_URL (set by other tools) from redirecting the call.
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: "https://api.anthropic.com", maxRetries: 2 });
  try {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: SCHEMA } },
      system: SYSTEM,
      messages: [{ role: "user", content: factSheet(a) }],
    });
    if (response.stop_reason === "refusal" || response.stop_reason === "max_tokens") return fallbackNotes(a);
    const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    const notes = JSON.parse(text);
    notes.fixes = (notes.fixes || []).slice(0, 3);
    return { ...notes, by: response.model };
  } catch (err) {
    if (err instanceof Anthropic.APIError) console.log(`write-up fell back to rules: API ${err.status}`);
    else console.log(`write-up fell back to rules: ${err.message}`);
    return fallbackNotes(a);
  }
}
