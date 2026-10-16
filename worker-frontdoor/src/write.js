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
- If an area was not checked, say it was not checked in this audit.
- Each fix must be something the church staff could start this week, written as an action.`;

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
  lines.push(`Overall grade: ${s.overall.grade ?? "not graded"}`);
  for (const [k, v] of Object.entries(s.areas)) lines.push(`${k} grade: ${v.grade ?? "not checked"}`);
  if (a.google?.found) lines.push(`Google: rating ${a.google.rating ?? "none"} from ${a.google.reviewCount} reviews, ${a.google.photoCount === null ? "photos not checked" : `${a.google.photoCount} photos`}, service hours ${a.google.hoursListed ? "listed" : "not listed"}.`);
  if (a.nearMe) lines.push(`Search "church" from about 4 miles away: ${a.nearMe.best ? `best position ${a.nearMe.best}` : "not in the top 20"}.`);
  if (a.website?.ok) {
    const w = a.website;
    lines.push(`Website: service times ${w.serviceTimes.found ? "found" : "missing"} on the home page, plan-your-visit link ${w.planVisit.found ? `found ("${w.planVisit.label}")` : "missing"}, kids link ${w.kids.found ? "found" : "missing"}, secure connection ${w.https ? "yes" : "no"}.`);
    lines.push(`Social links on the website: ${Object.keys(w.socials).join(", ") || "none"}.`);
    if (w.youtube?.daysSinceLastUpload !== undefined) lines.push(`YouTube: last upload ${w.youtube.daysSinceLastUpload} days ago, ${w.youtube.uploadsLast30Days} uploads in 30 days.`);
  }
  if (a.speed?.ok) lines.push(`Phone speed score: ${a.speed.score} out of 100${a.speed.loadTime ? `, main content appears in ${a.speed.loadTime}` : ""}.`);
  if (a.instagram?.ok) lines.push(`Instagram: ${a.instagram.postsLast30Days} posts in 30 days, last post ${a.instagram.daysSinceLastPost} days ago.`);
  if (a.reach) lines.push(`About ${a.reach.households.toLocaleString("en-US")} households live within ${a.reach.miles} miles.`);
  lines.push("Findings, most important first:");
  for (const f of s.findings) lines.push(`- [${f.area}] ${f.fact}`);
  if (!s.findings.length) lines.push("- No problems found in the areas checked.");
  return lines.join("\n");
}

// Plain wording built straight from the findings, used when Claude is unavailable.
export function fallbackNotes(a) {
  const s = a.scores;
  const by = (area) => s.findings.filter((f) => f.area === area).map((f) => f.fact);
  const note = (area, ok) => {
    if (s.areas[area].grade === null) return "Not checked in this audit.";
    const facts = by(area);
    return facts.length ? facts.slice(0, 2).join(" ") : ok;
  };
  const top = s.findings[0];
  return {
    summary: top
      ? `A new family can find a lot of what they need. The biggest gap: ${top.fact.charAt(0).toLowerCase()}${top.fact.slice(1)}`
      : "A new family can find what they need to plan a first visit.",
    areas: {
      google: note("google", "The Google listing gives a neighbor what they need."),
      reviews: note("reviews", "Reviews look healthy."),
      website: note("website", "The website answers a first-time guest's questions."),
      social: note("social", "Sermons and social accounts look active."),
    },
    fixes: s.findings.slice(0, 3).map((f) => ({ title: f.fix, why: f.fact })),
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
