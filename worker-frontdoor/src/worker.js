// Big Splash Front Door Audit worker.
// POST /audit takes the form, saves a "running" record and starts a Workflow that runs every check,
// writes the notes, saves the scorecard and tells Slack and GoHighLevel. GET /result serves the scorecard data.
// Contact details live in a separate key and never reach the public result.
import { WorkflowEntrypoint } from "cloudflare:workers";
import { runAudit } from "./audit.js";
import { normalizeUrl } from "./website.js";

const LIMITS = { church: 120, address: 200, website: 300, name: 120, role: 120, email: 200, phone: 40, instagram: 60, facebook_frequency: 40, page_url: 500, utm: 500 };
const REQUIRED = ["church", "address", "website", "name", "email"];
const FB_CHOICES = ["Several times a week", "About once a week", "A few times a month", "Rarely or never", "Not sure"];
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;
const MAX_BODY = 20 * 1024;
const SCORECARD = "https://bigsplash.video/front-door/?id=";

export default {
  async fetch(request, env) {
    const cors = corsHeaders(env, request);
    try {
      return await route(request, env, cors);
    } catch (err) {
      console.error("Request failed:", err?.message);
      return json({ ok: false, error: "Server error" }, 500, cors);
    }
  },
};

async function route(request, env, cors) {
  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/health" && request.method === "GET") {
    return json({ ok: true, google: Boolean(env.GOOGLE_API_KEY), anthropic: Boolean(env.ANTHROPIC_API_KEY), slack: Boolean(env.SLACK_WEBHOOK_URL), ghl: Boolean(env.GHL_WEBHOOK_URL), storage: Boolean(env.AUDITS) }, 200, cors);
  }
  if (path === "/result" && request.method === "GET") {
    const id = url.searchParams.get("id") || "";
    if (!/^[a-z0-9-]{6,80}$/.test(id)) return json({ error: "Not found" }, 404, cors);
    const record = await env.AUDITS.get(`audit:${id}`, "json");
    if (!record || record.status !== "ready") return json({ error: "Not found", status: record?.status || null }, 404, cors);
    return json(record.result, 200, { ...cors, "Cache-Control": "public, max-age=300" });
  }
  if ((path === "/audit" || path === "/") && request.method === "POST") return intake(request, env, cors);
  return json({ error: "Not found" }, 404, cors);
}

async function intake(request, env, cors) {
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
  if (body.company_site) return json({ ok: true, id: "received" }, 200, cors);

  const form = {};
  for (const [k, max] of Object.entries(LIMITS)) {
    if (body[k] === undefined || body[k] === null) continue;
    form[k] = String(body[k]).replace(INVISIBLE, "").replace(/\s+/g, " ").trim().slice(0, max);
  }
  const missing = REQUIRED.filter((k) => !form[k]);
  if (missing.length) return json({ ok: false, error: `Missing: ${missing.join(", ")}` }, 400, cors);
  if (!EMAIL_SHAPE.test(form.email)) return json({ ok: false, error: "Check the email address" }, 400, cors);
  const website = normalizeUrl(form.website);
  if (!website) return json({ ok: false, error: "Check the website address" }, 400, cors);
  if (form.facebook_frequency && !FB_CHOICES.includes(form.facebook_frequency)) delete form.facebook_frequency;
  form.instagram = form.instagram ? form.instagram.replace(/^@/, "").replace(/[^A-Za-z0-9._]/g, "").slice(0, 30) : undefined;

  const id = `${slug(form.church)}-${crypto.randomUUID().slice(0, 8)}`;
  const church = { name: form.church, address: form.address, city: cityOf(form.address), website, instagram: form.instagram };
  const contact = { name: form.name, role: form.role, email: form.email, phone: form.phone, facebook_frequency: form.facebook_frequency, page_url: form.page_url, utm: form.utm };

  await env.AUDITS.put(`audit:${id}`, JSON.stringify({ status: "running", church, created: new Date().toISOString() }), { expirationTtl: 60 * 60 * 24 * 365 });
  await env.AUDITS.put(`contact:${id}`, JSON.stringify(contact), { expirationTtl: 60 * 60 * 24 * 365 });
  await env.AUDIT_FLOW.create({ id, params: { id } });

  return json({ ok: true, id, url: SCORECARD + id }, 200, cors);
}

// Runs one audit. Each step retries on its own, so a slow Google or YouTube call never loses the request.
export class FrontDoorAudit extends WorkflowEntrypoint {
  async run(event, step) {
    const { id } = event.payload;
    const record = await step.do("load", async () => this.env.AUDITS.get(`audit:${id}`, "json"));
    const contact = await step.do("load contact", async () => this.env.AUDITS.get(`contact:${id}`, "json"));
    if (!record) return;

    const result = await step.do("audit", { retries: { limit: 2, delay: "20 seconds", backoff: "linear" }, timeout: "5 minutes" },
      async () => runAudit(record.church, this.env));

    const status = result.needsReview ? "review" : "ready";
    await step.do("save", async () => {
      await this.env.AUDITS.put(`audit:${id}`, JSON.stringify({ ...record, status, result, finished: new Date().toISOString() }), { expirationTtl: 60 * 60 * 24 * 365 });
      return status;
    });

    const link = SCORECARD + id;
    await step.do("slack", { retries: { limit: 3, delay: "10 seconds" } }, async () => {
      if (!this.env.SLACK_WEBHOOK_URL) return "skipped";
      await postJson(this.env.SLACK_WEBHOOK_URL, { text: slackText(record.church, contact, result, status, link, id), unfurl_links: false, unfurl_media: false });
      return "sent";
    });

    // GoHighLevel sends the pastor the scorecard. Audits held for review wait for Chris instead.
    if (status === "ready") {
      await step.do("gohighlevel", { retries: { limit: 3, delay: "10 seconds" } }, async () => {
        if (!this.env.GHL_WEBHOOK_URL) return "skipped";
        await postJson(this.env.GHL_WEBHOOK_URL, {
          form_type: "front_door_audit", audit_id: id, audit_url: link,
          church: record.church.name, website: record.church.website, address: record.church.address,
          name: contact?.name, role: contact?.role, email: contact?.email, phone: contact?.phone,
          facebook_frequency: contact?.facebook_frequency, overall_grade: result.scores.overall.grade,
          top_fix: result.notes?.fixes?.[0]?.title || null, utm: contact?.utm, page_url: contact?.page_url,
        });
        return "sent";
      });
    }
  }
}

function slackText(church, contact, result, status, link, id) {
  const s = result.scores;
  const safe = (v) => String(v ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])).replace(/[*_~`]/g, "");
  const grades = Object.entries(s.areas).map(([k, v]) => `${k} ${v.grade ?? "n/a"}`).join(" · ");
  const lines = [
    status === "ready" ? `*Front Door Audit sent:* ${safe(church.name)} got a ${s.overall.grade}` : `*Front Door Audit needs your review:* ${safe(church.name)}`,
    status === "review" ? `Held because: ${safe(result.reviewReason)} Check it, then send the link by hand.` : null,
    `${safe(contact?.name)}${contact?.role ? `, ${safe(contact.role)}` : ""} · ${safe(contact?.email)}${contact?.phone ? ` · ${safe(contact.phone)}` : ""}`,
    grades,
    contact?.facebook_frequency ? `Says they post on Facebook: ${safe(contact.facebook_frequency)}` : null,
    `Scorecard: ${link}`,
    `Audit id: ${id}`,
  ];
  return lines.filter(Boolean).join("\n");
}

async function postJson(url, payload) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`POST failed with ${res.status}`);
}

function originAllowed(env, request) {
  const origin = request.headers.get("origin");
  if (!origin) return true; // server-to-server and curl tests
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

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "church";
}

function cityOf(address) {
  const parts = String(address || "").split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join(", ") : parts[0] || "";
}
