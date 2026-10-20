// Big Splash Front Door Audit worker.
// POST /audit takes the form, saves a "running" record and starts a Workflow that runs every check,
// writes the notes and saves the scorecard. Then deliver.js puts the pastor in GoHighLevel, emails (and,
// with consent, texts) the scorecard, starts the follow-up Workflow (nurture.js) and hands the lead to
// LeadDesk, which opens the ClickUp task and posts Slack. GET /result serves the scorecard data.
// Audits held for review wait for Chris: the desk gets a preview link and an approve link, both carrying
// the record's reviewToken. The approve link opens a confirm page; its button posts back and starts the
// approve Workflow (FrontDoorApprove), whose fixed instance id lets each audit be approved once.
// When the desk is not bound or its Slack post fails, the worker posts Slack itself (SLACK_WEBHOOK_URL).
// Contact details live in a separate key and never reach the public result.
import { WorkflowEntrypoint } from "cloudflare:workers";
import { runAudit } from "./audit.js";
import { normalizeUrl, siteKey } from "./website.js";
import { deliver, directStep, ghlContact, SCORECARD } from "./deliver.js";
import { ghlReady } from "./ghl.js";
export { FrontDoorNurture } from "./nurture.js";

const LIMITS = { church: 120, address: 200, website: 300, name: 120, role: 120, email: 200, phone: 40, instagram: 60, facebook_frequency: 40, attendance: 40, page_url: 500, utm: 500 };
const REQUIRED = ["church", "address", "website", "name", "email"];
const FB_CHOICES = ["Several times a week", "About once a week", "A few times a month", "Rarely or never", "Not sure"];
const ATTENDANCE = ["Under 100", "100 to 249", "250 to 499", "500 to 999", "1,000+"];
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;
const MAX_BODY = 20 * 1024;
const YEAR = 60 * 60 * 24 * 365;
const OVER_LIMIT = "We've reached today's limit. Email chris@bigsplash.agency and we'll run yours by hand.";
const START_FAILED = "Something went wrong on our end and your audit did not start. Try again in a minute, or email chris@bigsplash.agency.";
// A "running" audit older than this is treated as dead, so a new request for the church starts fresh.
const STALE_RUN_MS = 30 * 60 * 1000;
const SLACK_RETRY = { retries: { limit: 3, delay: "10 seconds" } };

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(env, request);
    try {
      return await route(request, env, cors, ctx);
    } catch (err) {
      console.error("Request failed:", err?.message);
      return json({ ok: false, error: "Server error" }, 500, cors);
    }
  },
};

async function route(request, env, cors, ctx) {
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/health" && request.method === "GET") {
    return json({ ok: true, google: Boolean(env.GOOGLE_API_KEY), anthropic: Boolean(env.ANTHROPIC_API_KEY), ghl: ghlReady(env), desk: Boolean(env.DESK),
      nurture: Boolean(env.NURTURE_FLOW), approve_flow: Boolean(env.APPROVE_FLOW), slack_fallback: Boolean(env.SLACK_WEBHOOK_URL), storage: Boolean(env.AUDITS), daily_limit: dailyLimit(env) }, 200, cors);
  }
  if (path === "/result" && request.method === "GET") return result(url, env, cors);
  if (path === "/approve" && request.method === "GET") return approveConfirm(url, env);
  if (path === "/approve" && request.method === "POST") return approve(request, env);
  if (path === "/nurture" && request.method === "GET") return nurtureLog(url, env, cors);
  if ((path === "/audit" || path === "/") && request.method === "POST") return intake(request, env, cors, ctx);
  return json({ error: "Not found" }, 404, cors);
}

async function result(url, env, cors) {
  const id = url.searchParams.get("id") || "";
  if (!/^[a-z0-9-]{6,80}$/.test(id)) return json({ error: "Not found", status: null }, 404, cors);
  const record = await env.AUDITS.get(`audit:${id}`, "json");
  if (record?.status === "ready") return json(publicResult(record.result), 200, { ...cors, "Cache-Control": "public, max-age=300" });
  if (record?.status === "review" && tokenOk(record, url.searchParams.get("t"))) {
    return json(record.result, 200, { ...cors, "Cache-Control": "no-store" });
  }
  return json({ error: "Not found", status: record?.status || null }, 404, { ...cors, "Cache-Control": "no-store" });
}

// The approve link from Slack or ClickUp. A GET changes nothing: mail scanners and link previews open links,
// so this page only asks Chris to confirm, and the button posts back to approve().
async function approveConfirm(url, env) {
  const id = url.searchParams.get("id") || "";
  const t = url.searchParams.get("t") || "";
  const record = /^[a-z0-9-]{6,80}$/.test(id) ? await env.AUDITS.get(`audit:${id}`, "json") : null;
  if (!record || !tokenOk(record, t)) return page("Not found", "That approve link does not match an audit.", 404);
  if (record.status === "ready") return page("Already approved", `${record.church?.name || "This audit"} was already approved. Scorecard: ${SCORECARD + id}`);
  if (record.status !== "review") return page("Not ready", `This audit is ${record.status}, so there is nothing to approve yet.`, 409);
  return page(`Approve ${record.church?.name || "this audit"}?`, "The scorecard goes live, and the pastor gets the \"sorry for the wait\" email (and the scorecard text, with consent). The follow-ups start after that.", 200,
    { action: "/approve", fields: { id, t }, button: "Approve and send" });
}

// Chris confirmed: the approve Workflow publishes the scorecard and sends the "sorry for the wait" email
// (and text 1 with consent), starts the follow-ups and tells the desk. Its instance id approve-<id> can
// exist once, so a double tap or two racing requests approve once. Without the binding it runs here.
async function approve(request, env) {
  const form = new URLSearchParams((await request.text()).slice(0, 2000));
  const id = form.get("id") || "";
  const record = /^[a-z0-9-]{6,80}$/.test(id) ? await env.AUDITS.get(`audit:${id}`, "json") : null;
  if (!record || !tokenOk(record, form.get("t"))) return page("Not found", "That approve link does not match an audit.", 404);
  const name = record.church?.name || "The audit";
  const already = page("Already approved", `${record.church?.name || "This audit"} was already approved. Scorecard: ${SCORECARD + id}`);
  if (record.status === "ready") return already;
  if (record.status !== "review") return page("Not ready", `This audit is ${record.status}, so there is nothing to approve yet.`, 409);

  if (env.APPROVE_FLOW) {
    try {
      await env.APPROVE_FLOW.create({ id: `approve-${id}`, params: { id } });
    } catch (err) {
      if (/already|exist|duplicate/i.test(String(err?.message || err))) return already;
      throw err;
    }
    const what = ghlReady(env)
      ? "The pastor's email goes out in the next minute. Slack and the ClickUp task will say whether it went."
      : "GHL_TOKEN is not set, so no email will go out. Send the scorecard link by hand.";
    return page("Approved", `${name} is approved and the scorecard is going live: ${SCORECARD + id}. ${what}`);
  }

  const done = await runApproval(env, directStep, id);
  const g = done?.sent?.ghl || {};
  const what = !ghlReady(env)
    ? "GHL_TOKEN is not set, so no email went out. Send the scorecard link by hand."
    : g.emailed
      ? `The pastor got the "sorry for the wait" email${g.texted ? " and the scorecard text" : ""}.${g.textLater ? " The scorecard text goes out when the text window opens." : ""}${g.nurture ? " The follow-ups have started." : ""}`
      : "The email did not go out. Send the scorecard link by hand.";
  return page("Approved", `${name} is approved and the scorecard is live: ${SCORECARD + id}. ${what}`);
}

// Publishes a held audit and sends the approved messages, one step at a time. Never throws past a
// saved scorecard. Returns { sent } or null when there is nothing to approve.
async function runApproval(env, step, id) {
  const record = await step.do("load", async () => env.AUDITS.get(`audit:${id}`, "json"));
  if (!record || !["review", "ready"].includes(record.status)) { console.error(`approve ${id}: nothing to approve (${record?.status || "missing"})`); return null; }
  await step.do("publish", async () => {
    await env.AUDITS.put(`audit:${id}`, JSON.stringify({ ...record, status: "ready", approved: new Date().toISOString() }), { expirationTtl: YEAR });
    return true;
  });
  const contact = await step.do("load contact", async () => env.AUDITS.get(`contact:${id}`, "json"));
  let sent = { ghl: { contactId: null, emailed: false, texted: false, nurture: false }, desk: null };
  try {
    sent = await deliver(env, step, { event: "approved", id, record, church: record.church, contact, result: record.result, clickup_task_id: record.desk?.review?.clickup?.id || "" });
  } catch (err) {
    console.error(`approve ${id}: ${err?.message}`);
  }
  try {
    await step.do("save approved delivery", async () => { await saveDelivery(env, id, "approved", sent); return true; });
  } catch (err) {
    console.error(`approve ${id} save: ${err?.message}`);
  }
  if (!deskPosted(env, sent)) {
    await slackFallback(env, step, "slack fallback", [`*Front Door Audit approved:* ${slackSafe(record.church?.name || "unknown church")}`, contactLine(contact),
      `Scorecard: ${SCORECARD + id}`, sentLine(sent.ghl), deskLine(env, sent)].filter(Boolean).join("\n"));
  }
  return { sent };
}

// The approve Workflow: each step is saved, so a dropped connection never leaves a pastor unemailed.
export class FrontDoorApprove extends WorkflowEntrypoint {
  async run(event, step) {
    await runApproval(this.env, step, event.payload?.id);
  }
}

// Chris's view of the follow-ups for one audit. Needs the record's reviewToken.
async function nurtureLog(url, env, cors) {
  const id = url.searchParams.get("id") || "";
  const record = /^[a-z0-9-]{6,80}$/.test(id) ? await env.AUDITS.get(`audit:${id}`, "json") : null;
  const headers = { ...cors, "Cache-Control": "no-store" };
  if (!record || !tokenOk(record, url.searchParams.get("t"))) return json({ error: "Not found" }, 404, headers);
  const log = await env.AUDITS.get(`nurture:${id}`, "json");
  return json({ id, status: record.status, ghl: record.ghl || null, nurture: log || null }, 200, headers);
}

// Delivery results go on the record (private: /result serves only record.result).
async function saveDelivery(env, id, event, sent) {
  const rec = (await env.AUDITS.get(`audit:${id}`, "json")) || {};
  const desk = { ...(rec.desk || {}) };
  if (sent.desk) desk[event] = sent.desk;
  await env.AUDITS.put(`audit:${id}`, JSON.stringify({ ...rec, ghl: { ...(rec.ghl || {}), ...sent.ghl, contactId: sent.ghl.contactId || rec.ghl?.contactId || null }, desk }), { expirationTtl: YEAR });
}

async function intake(request, env, cors, ctx) {
  if (!originAllowed(env, request)) return json({ ok: false, error: "Forbidden" }, 403, cors);
  if (!(request.headers.get("content-type") || "").includes("application/json")) return json({ ok: false, error: "Send JSON" }, 415, cors);
  if (env.INTAKE_LIMIT) {
    const key = request.headers.get("cf-connecting-ip") || "unknown";
    if (!(await env.INTAKE_LIMIT.limit({ key })).success) return json({ ok: false, error: "Too many requests" }, 429, cors);
  }
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ ok: false, error: "Too large" }, 413, cors);
  let body;
  try { body = JSON.parse(text); } catch { return json({ ok: false, error: "Bad JSON" }, 400, cors); }

  // Honeypot: bots fill the hidden field and get a normal-looking reply with nothing started.
  if (body.hp_x7) return json({ ok: true, id: "received" }, 200, cors);

  const form = {};
  for (const [k, max] of Object.entries(LIMITS)) {
    if (body[k] === undefined || body[k] === null) continue;
    const v = String(body[k]).replace(INVISIBLE, "").replace(/\s+/g, " ").trim().slice(0, max);
    if (v) form[k] = v; // a blank "Choose one" select is left out
  }
  const missing = REQUIRED.filter((k) => !form[k]);
  if (missing.length) return json({ ok: false, error: "Please fill in the church name, address, website, your name and email" }, 400, cors);
  if (!EMAIL_SHAPE.test(form.email)) return json({ ok: false, error: "Check the email address" }, 400, cors);
  const website = normalizeUrl(form.website);
  if (!website) return json({ ok: false, error: "Check the website address" }, 400, cors);
  if (form.facebook_frequency && !FB_CHOICES.includes(form.facebook_frequency)) delete form.facebook_frequency;
  if (form.attendance && !ATTENDANCE.includes(form.attendance)) delete form.attendance;
  form.instagram = form.instagram ? form.instagram.replace(/^@/, "").replace(/[^A-Za-z0-9._]/g, "").slice(0, 30) : undefined;

  // The same church and website within a day gets the audit that already ran (or is running), not a new
  // one. Only a real domain counts: "none", or a bare shared host like wordpress.com, never matches.
  const key = siteKey(website) || "";
  const siteMark = key.includes(".") && !key.endsWith("/") ? `site:${key}` : null;
  const earlier = siteMark ? await env.AUDITS.get(siteMark) : null;
  if (earlier) {
    const prior = await env.AUDITS.get(`audit:${earlier}`, "json");
    const dead = prior?.status === "failed" || (prior?.status === "running" && Date.now() - Date.parse(prior.created || 0) > STALE_RUN_MS);
    if (prior && !dead && sameName(prior.church?.name, form.church)) {
      // The second contact still reaches Chris: saved in KV, into GoHighLevel with a note, and Slack.
      const note = repeatRequest(env, earlier, form, website, body);
      if (ctx?.waitUntil) ctx.waitUntil(note); else await note;
      return json({ ok: true, id: earlier, url: SCORECARD + earlier }, 200, cors);
    }
  }

  // A daily cap keeps a flood of form posts from running up the Google and PageSpeed bills.
  const dayKey = `daily:${new Date().toISOString().slice(0, 10)}`;
  const today = Number(await env.AUDITS.get(dayKey)) || 0;
  if (today >= dailyLimit(env)) return json({ ok: false, error: OVER_LIMIT }, 429, cors);
  await env.AUDITS.put(dayKey, String(today + 1), { expirationTtl: 60 * 60 * 48 });

  const id = `${slug(form.church)}-${crypto.randomUUID().slice(0, 8)}`;
  const church = { name: form.church, address: form.address, city: cityOf(form.address), website, instagram: form.instagram };
  const contact = contactRecord(form, body);
  const record = { status: "running", church, reviewToken: newToken(), origin: new URL(request.url).origin, created: new Date().toISOString() };

  await env.AUDITS.put(`audit:${id}`, JSON.stringify(record), { expirationTtl: YEAR });
  await env.AUDITS.put(`contact:${id}`, JSON.stringify(contact), { expirationTtl: YEAR });
  try {
    // The params carry the contact too, in case the Workflow's KV read lags the write above.
    await env.AUDIT_FLOW.create({ id, params: { id, church, contact } });
  } catch (err) {
    // No run means no failed path, so mark it failed here and tell Chris. No site marker was written,
    // so the pastor's retry starts a fresh audit.
    const error = `The audit could not start: ${String(err?.message || err).slice(0, 150)}`;
    console.error(`${id}: ${error}`);
    await env.AUDITS.put(`audit:${id}`, JSON.stringify({ ...record, status: "failed", error, finished: new Date().toISOString() }), { expirationTtl: YEAR });
    const told = startFailed(env, id, record, church, contact, error);
    if (ctx?.waitUntil) ctx.waitUntil(told); else await told;
    return json({ ok: false, error: START_FAILED }, 503, cors);
  }
  // Written only once the run exists, so a resubmission never lands on an audit that never ran.
  if (siteMark) await env.AUDITS.put(siteMark, id, { expirationTtl: 60 * 60 * 24 });

  return json({ ok: true, id, url: SCORECARD + id }, 200, cors);
}

// Runs one audit. Each step retries on its own, so a slow Google or YouTube call never loses the request.
// If the run still fails, the record says so and the desk (or Slack) hears about it, so no pastor waits on a dead audit.
export class FrontDoorAudit extends WorkflowEntrypoint {
  async run(event, step) {
    const { id, church: paramChurch, contact: paramContact } = event.payload;
    let record = null, contact = null, church = paramChurch;
    // A direct Slack post when LeadDesk is not bound, or it failed, or its Slack post did not go out.
    // Never fails the run: a dead webhook must not undo a saved scorecard.
    const alert = async (name, text, sent) => {
      if (!deskPosted(this.env, sent)) await slackFallback(this.env, step, name, [text, deskLine(this.env, sent)].filter(Boolean).join("\n"));
    };
    const save = async (event, sent) => {
      try {
        await step.do(`save ${event} delivery`, async () => { await saveDelivery(this.env, id, event, sent); return true; });
      } catch (err) {
        console.error(`save ${event} delivery: ${err?.message}`);
      }
    };

    // The whole run sits in one try, so a failed load step still marks the record failed and tells Chris.
    let result, status;
    try {
      // The params carry the church too, so a record that went missing from KV still gets audited.
      record = (await step.do("load", async () => this.env.AUDITS.get(`audit:${id}`, "json"))) ||
        { status: "running", church: paramChurch, reviewToken: await step.do("new token", async () => newToken()), created: new Date().toISOString() };
      // A KV read in another location can miss a fresh write for up to a minute: retry, then use the params.
      contact = await step.do("load contact", { retries: { limit: 3, delay: "20 seconds", backoff: "linear" } }, async () => {
        const c = await this.env.AUDITS.get(`contact:${id}`, "json");
        if (!c) throw new Error("contact not readable yet");
        return c;
      }).catch(() => null) || paramContact || null;
      church = record.church || paramChurch;
      if (!church) throw new Error("No church details in the record or the workflow params");
      result = await step.do("audit", { retries: { limit: 2, delay: "20 seconds", backoff: "linear" }, timeout: "5 minutes" },
        async () => runAudit(church, this.env));
      // With no email address nobody would get the scorecard, so Chris holds it.
      if (!contact?.email) {
        result.needsReview = true;
        result.reviewReasons = [...(result.reviewReasons || []), "The pastor's contact details did not reach the audit, so no email can go out."];
        result.reviewReason = result.reviewReasons.join(" ");
      }
      status = result.needsReview ? "review" : "ready";
      await step.do("save", async () => {
        await this.env.AUDITS.put(`audit:${id}`, JSON.stringify({ ...record, church, status, result, finished: new Date().toISOString() }), { expirationTtl: YEAR });
        return status;
      });
    } catch (err) {
      const error = String(err?.message || err).slice(0, 200);
      try {
        // Read again whatever the failed steps never loaded, so the saved record keeps its token and Chris gets the contact.
        const saved = await step.do("mark failed", async () => {
          const prior = record || (await this.env.AUDITS.get(`audit:${id}`, "json")) || { church: paramChurch, created: new Date().toISOString() };
          const c = prior.church || paramChurch;
          await this.env.AUDITS.put(`audit:${id}`, JSON.stringify({ ...prior, church: c, status: "failed", error, finished: new Date().toISOString() }), { expirationTtl: YEAR });
          return { church: c, created: prior.created || null };
        });
        church = church || saved?.church;
        record = record || { created: saved?.created };
        if (!contact) contact = (await step.do("reload contact", async () => this.env.AUDITS.get(`contact:${id}`, "json"))) || paramContact || null;
      } catch (e) {
        console.error(`mark failed: ${e?.message}`);
      }
      // No pastor message for a failed audit: GoHighLevel gets the contact (tag fd-failed) and the desk tells Chris.
      let sent = { ghl: { contactId: null, emailed: false, texted: false, nurture: false }, desk: null };
      try { sent = await deliver(this.env, step, { event: "failed", id, record, church, contact, result: null, error }); } catch (e) { console.error(`failed delivery: ${e?.message}`); }
      await save("failed", sent);
      await alert("slack fallback failed", failedText(church, contact, id, error), sent);
      return;
    }

    const origin = record.origin || this.env.WORKER_ORIGIN || "";
    const q = `id=${encodeURIComponent(id)}&t=${encodeURIComponent(record.reviewToken)}`;
    const links = status === "review" ? { preview_url: `https://bigsplash.video/front-door/?${q}`, approve_url: `${origin}/approve?${q}` } : {};
    // Held audits message nobody: the contact goes to GoHighLevel tagged fd-held and Chris gets the approve link.
    let sent = { ghl: { contactId: null, emailed: false, texted: false, nurture: false }, desk: null };
    try { sent = await deliver(this.env, step, { event: status, id, record, church, contact, result, ...links }); } catch (e) { console.error(`delivery: ${e?.message}`); }
    await save(status, sent);
    await alert("slack fallback", slackText(church, contact, result, status, id, record.reviewToken, origin, sent.ghl), sent);
  }
}

// The second request for a church audited today. The contact is saved under contact:<earlier>:repeat:<n>
// and goes to GoHighLevel tagged fd-repeat with a note. LeadDesk has no repeat event, so Slack hears about
// it whenever GoHighLevel did not take the contact or the desk is not bound. Never throws.
async function repeatRequest(env, earlier, form, website, body) {
  const contact = contactRecord(form, body);
  try {
    await env.AUDITS.put(`contact:${earlier}:repeat:${crypto.randomUUID().slice(0, 8)}`, JSON.stringify({ ...contact, church: form.church, website, asked: new Date().toISOString() }), { expirationTtl: YEAR });
  } catch (err) {
    console.error(`repeat request save: ${err?.message}`);
  }
  let contactId = null;
  try {
    if (ghlReady(env)) contactId = await ghlContact(env, directStep, { event: "repeat", id: earlier, earlier, church: { name: form.church, address: form.address, website }, contact, result: null, record: {} });
  } catch (err) {
    console.error(`repeat request: ${err?.message}`);
  }
  if (contactId && env.DESK) return;
  await slackFallback(env, directStep, "slack repeat", [`*Front Door Audit asked again:* ${slackSafe(form.church)}`, contactLine(form),
    `Sent them the audit already started today: ${SCORECARD + earlier}`,
    contactId ? "" : ghlReady(env) ? "GoHighLevel did not take this contact. Add them by hand." : "Not in GoHighLevel: GHL_TOKEN is not set. Add them by hand.",
  ].filter(Boolean).join("\n"));
}

// An audit whose Workflow could not be created: GoHighLevel (tag fd-failed) and the desk hear about it the
// same way a failed run does, and Slack when the desk did not post. Never throws.
async function startFailed(env, id, record, church, contact, error) {
  let sent = { ghl: {}, desk: null };
  try { sent = await deliver(env, directStep, { event: "failed", id, record, church, contact, result: null, error }); } catch (err) { console.error(`start failed delivery: ${err?.message}`); }
  if (!deskPosted(env, sent)) await slackFallback(env, directStep, "slack fallback failed", [failedText(church, contact, id, error), deskLine(env, sent)].filter(Boolean).join("\n"));
}

// True when LeadDesk is bound and its Slack post went out.
const deskPosted = (env, sent) => Boolean(env.DESK && sent?.desk?.slack?.ok);

// For a direct post while the desk is bound: whether the ClickUp task exists.
function deskLine(env, sent) {
  if (!env.DESK) return "";
  const c = sent?.desk?.clickup;
  return c?.ok ? `LeadDesk did not post Slack. ClickUp: ${c.url || c.id || "task made"}` : "LeadDesk did not reach Slack or ClickUp. Add the ClickUp task by hand.";
}

// The direct Slack post, as its own step with retries. Never throws.
async function slackFallback(env, step, name, text) {
  if (!env.SLACK_WEBHOOK_URL) { console.error(`${name}: Slack was not told (SLACK_WEBHOOK_URL is not set)`); return false; }
  try {
    await step.do(name, SLACK_RETRY, async () => {
      await postJson(env.SLACK_WEBHOOK_URL, { text, unfurl_links: false, unfurl_media: false });
      return "sent";
    });
    return true;
  } catch (err) {
    console.error(`${name}: ${err?.message}`);
    return false;
  }
}

// The private contact record: the form fields plus the text consent and the campaign tags.
function contactRecord(form, body) {
  const phone = form.phone || undefined;
  return {
    name: form.name, role: form.role, email: form.email, phone,
    attendance: form.attendance, facebook_frequency: form.facebook_frequency,
    // A yes without a phone number cannot be texted, so it counts as no.
    sms_consent: String(body?.sms_consent ?? "").trim().toLowerCase() === "yes" && Boolean(phone),
    page_url: form.page_url, utm: parseUtm(form.utm),
  };
}

// The landing page sends "utm_source=x&utm_medium=y...": keep the four campaign tags.
export function parseUtm(raw) {
  const out = { source: "", medium: "", campaign: "", content: "" };
  if (!raw) return out;
  let params;
  try { params = new URLSearchParams(String(raw).replace(/^[?&]+/, "")); } catch { return out; }
  for (const k of Object.keys(out)) out[k] = String(params.get(`utm_${k}`) || params.get(k) || "").replace(INVISIBLE, "").replace(/\s+/g, " ").trim().slice(0, 100);
  return out;
}

function sentLine(g) {
  if (!g?.emailed) return "The pastor was not emailed. Send the scorecard link by hand.";
  return `Emailed the pastor through GoHighLevel${g.texted ? " and texted the scorecard" : ""}.${g.textLater ? " The scorecard text goes out when the text window opens." : ""}`;
}

const slackSafe = (v) => String(v ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])).replace(/[*_~`]/g, "");

function contactLine(contact) {
  return `${slackSafe(contact?.name)}${contact?.role ? `, ${slackSafe(contact.role)}` : ""} · ${slackSafe(contact?.email)}${contact?.phone ? ` · ${slackSafe(contact.phone)}` : ""}`;
}

export function slackText(church, contact, result, status, id, token, origin, sent = null) {
  const s = result.scores;
  const grades = Object.entries(s.areas).map(([k, v]) => `${k} ${v.grade ?? "not checked"}`).join(" · ");
  const dups = (result.possibleDuplicates || []).map((d) => `• ${slackSafe(d.name)}, ${slackSafe(d.address)} (${d.reviewCount} reviews${d.sameSite ? ", same website" : ""})`);
  const g = s.overall.grade;
  const lines = status === "ready"
    ? [`*Front Door Audit ready:* ${slackSafe(church.name)} got ${g ? `${/^[AEF]/.test(g) ? "an" : "a"} ${g}` : "no overall grade"}`]
    : [`*Front Door Audit needs your review:* ${slackSafe(church.name)}`, "Held because:", ...(result.reviewReasons || [result.reviewReason]).map((r) => `• ${slackSafe(r)}`)];
  lines.push(contactLine(contact), `Overall ${g ?? "not graded"} · ${grades}`);
  // Which site the Website and Social grades came from, next to the listing that was graded.
  if (result.website?.finalUrl) lines.push(`Website graded: ${slackSafe(result.website.finalUrl)}${result.google?.found ? ` · Listing: ${slackSafe(result.google.name)}, ${slackSafe(result.google.address)}` : ""}`);
  if (contact?.facebook_frequency) lines.push(`Says they post on Facebook: ${slackSafe(contact.facebook_frequency)}`);
  if (dups.length) lines.push("Other Google listings that may be the same church:", ...dups);
  if (status === "review") {
    const q = `id=${encodeURIComponent(id)}&t=${encodeURIComponent(token)}`;
    lines.push(`Preview: https://bigsplash.video/front-door/?${q}`, `Approve and email the pastor: ${origin}/approve?${q}`);
  } else lines.push(`Scorecard: ${SCORECARD + id}`, sentLine(sent));
  lines.push(`Audit id: ${id}`);
  return lines.join("\n");
}

function failedText(church, contact, id, error) {
  return [`*Front Door Audit failed:* ${slackSafe(church?.name || "unknown church")}`, contactLine(contact), `Error: ${slackSafe(error)}`, `Audit id: ${id}`].join("\n");
}

const sameName = (a, b) => String(a || "").toLowerCase().replace(/[^a-z0-9]+/g, "") === String(b || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

async function postJson(url, payload) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`POST failed with ${res.status}`);
}

// What the public scorecard link serves: no other churches' listings and no notes meant for Chris.
function publicResult(r) {
  if (!r) return r;
  const { possibleDuplicates, reviewReasons, reviewReason, errors, ...rest } = r;
  if (rest.google) {
    const { possibleDuplicates: _d, conflictReason: _c, ...g } = rest.google;
    rest.google = g;
  }
  return rest;
}

function tokenOk(record, given) {
  const want = record?.reviewToken;
  if (!want || typeof given !== "string" || given.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

function newToken() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function dailyLimit(env) {
  const n = Number(env.DAILY_LIMIT);
  return Number.isFinite(n) && n > 0 ? n : 300;
}

function originAllowed(env, request) {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  return String(env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).includes(origin);
}

function corsHeaders(env, request) {
  const origin = request.headers.get("origin");
  const allowed = String(env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim());
  return {
    "Access-Control-Allow-Origin": origin && allowed.includes(origin) ? origin : allowed[0] || "https://bigsplash.video",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, "Content-Type": "application/json" } });
}

// A small HTML page for Chris. form = { action, fields, button } adds a POST form with hidden fields.
function page(title, text, status = 200, form = null) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const formHtml = form ? `<form method="post" action="${esc(form.action)}">${Object.entries(form.fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("")}<button type="submit">${esc(form.button)}</button></form>` : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#131318;color:#e4e1e9;margin:0;padding:40px 16px}main{max-width:560px;margin:0 auto}h1{color:#eff88b;font-size:28px;margin:0 0 12px}p{overflow-wrap:anywhere}button{font:600 17px/1 system-ui,sans-serif;background:#eff88b;color:#131318;border:0;border-radius:10px;padding:14px 22px;margin-top:8px;cursor:pointer}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(text)}</p>${formHtml}</main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "church";
}

function cityOf(address) {
  const parts = String(address || "").split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join(", ") : parts[0] || "";
}
