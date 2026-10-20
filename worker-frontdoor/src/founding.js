// Founding partner checkout: the first churches (FOUNDING_TOTAL, 5) pay $3,500 for the campaign build,
// and month 1 of their term is included. Routes:
//   GET  /founding/status    { open, spots_left, total, terms_version } for the church page button
//   POST /founding/checkout  the founding form -> a Stripe Checkout Session -> { ok, url }
//   GET  /founding/session   { church, status } for the welcome page
//   POST /stripe/webhook     signed Stripe events: the payment, the bank payment, the monthly invoices
//   GET|POST /founding/start Chris's link: starts the monthly subscription once the campaign launches
// Prices live only here. A paid checkout is "won": GoHighLevel gets the contact (tagged founding-partner
// and fd-stop, so audit follow-ups stop) and the agreement note, the church gets Chris's welcome email,
// and LeadDesk opens the onboarding task in ClickUp and posts Slack. The won steps run in the
// FoundingFlow Workflow (instance won-<session id>), so a retried webhook or a double tap runs them once.
//
// KV (AUDITS):
//   founding:<session id>               the record: church, contact, term, agreement, status, Stripe ids
//   founding:taken:<session id>         "paid" or "processing"; each one holds a founding spot
//   founding:hold:<owner>:<session id>  a checkout still open on Stripe, so two churches can't both pay for
//                                       the last spot. Expires with the checkout. owner = the form's hash.
//   founding:miss:<session id>          Stripe has no such founding session; stops repeat lookups for 5 minutes
//   founding:subscription:<sub id>      the session id, for invoice and cancel events
//   founding:pending:<hash>             a fresh checkout, so a double click gets the same Stripe page
//   stripe:event:<event id>             a handled event, so a repeat delivery does nothing twice
import { WorkflowEntrypoint } from "cloudflare:workers";
import * as ghl from "./ghl.js";
import { stripeCall, stripeReady, verifySignature, hmacHex } from "./stripe.js";
import { foundingWelcomeEmail, KICKOFF_URL } from "./messages.js";
import { normalizeUrl } from "./website.js";

export const BUILD_CENTS = 350000;
export const BUILD_NAME = "Founding campaign build (includes month 1)";
export const MONTHLY_NAME = "Monthly campaign management";
export const TERMS = {
  "12": { months: 12, monthly: 1497, lookup: "bs_monthly_1497" },
  "6": { months: 6, monthly: 1697, lookup: "bs_monthly_1697" },
};
export const STATEMENT_TERMS = "I agree to the Founding Partnership Terms";
export const statementAuthorized = (church) => `I'm authorized to sign for ${church}`;

const LIMITS = { church: 120, name: 120, role: 120, email: 200, phone: 40, website: 300, utm: 500 };
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVISIBLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;
const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]{8,200}$/;
const AUDIT_ID = /^[a-z0-9-]{6,80}$/;
const MAX_BODY = 8 * 1024;
const MAX_WEBHOOK = 512 * 1024;
// Stripe keeps a Checkout page open at least 30 minutes after it is created. 31 leaves room for clock drift.
const CHECKOUT_MINUTES = 31;
const PENDING_TTL = 10 * 60;
// A hold outlives its checkout by 2 minutes, so a payment that lands at the last second still counts.
const HOLD_TTL = CHECKOUT_MINUTES * 60 + 120;
const MISS_TTL = 5 * 60;
const EVENT_TTL = 60 * 60 * 24 * 30;
const DAY_MS = 86400000;
const STEP = { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "2 minutes" };
// KV can serve an old copy of a record for about a minute. 5 tries over about 5 minutes outlast it.
const LOAD = { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "1 minute" };
const ONCE = { retries: { limit: 0, delay: "10 seconds" }, timeout: "1 minute" };
const SLACK_RETRY = { retries: { limit: 3, delay: "10 seconds" } };

const CLOSED = "Founding spots are full. Book a call with our team and we'll find the right fit for your church.";
const HELD = "The last founding spot is in another church's checkout right now. Try again in 30 minutes, or book a call with our team.";
const NOT_OPEN = "Founding checkout is not open yet. Book a call with our team.";
const CHECKOUT_FAILED = "Checkout did not open on our end. Try again in a minute, or email chris@bigsplash.agency.";

// For a call outside a Workflow: runs each callback once.
export const directStep = { do: async (name, a, b) => (typeof a === "function" ? a : b)() };

// ---------- Small helpers ----------

const total = (env) => { const n = Number(env.FOUNDING_TOTAL); return Number.isInteger(n) && n > 0 ? n : 5; };
const termsVersion = (env) => String(env.TERMS_VERSION || "").trim() || "unversioned";
const tz = (env) => env.TIMEZONE || "America/Chicago";
const live = (env) => String(env.FOUNDING_LIVE || "").trim().toLowerCase() === "yes";
const dollars = (n) => `$${Number(n).toLocaleString("en-US")}`;
const clean = (v, max) => String(v ?? "").replace(INVISIBLE, "").replace(/\s+/g, " ").trim().slice(0, max);
const truthy = (v) => v === true || ["true", "yes", "on", "1"].includes(String(v ?? "").trim().toLowerCase());
// Date.now, so a test clock reaches every timestamp.
const nowIso = () => new Date(Date.now()).toISOString();
const errText = (err) => String(err?.message || err).slice(0, 300);
const slackSafe = (v) => String(v ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])).replace(/[*_~`]/g, "");

export function newToken() {
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || !a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { ...headers, "Content-Type": "application/json" } });
}

function originAllowed(env, request) {
  const origin = request.headers.get("origin");
  return Boolean(origin) && String(env.ALLOWED_ORIGIN || "").split(",").map((s) => s.trim()).includes(origin);
}

// The founding pages live at /church/founding/ on bigsplash.video and at /founding/ on bigsplash.church,
// where the church page is the home page (see BigSplash_Church/sync_from_main_site.py).
export function foundingBase(origin) {
  return /(^|\.)bigsplash\.church$/i.test(new URL(origin).hostname) ? "/founding/" : "/church/founding/";
}

// "utm_source=x&utm_medium=y" -> { source, medium, campaign, content }.
function parseUtm(raw) {
  const out = { source: "", medium: "", campaign: "", content: "" };
  let p;
  try { p = new URLSearchParams(String(raw || "").replace(/^[?&]+/, "")); } catch { return out; }
  for (const k of Object.keys(out)) out[k] = clean(p.get(`utm_${k}`) || p.get(k) || "", 100);
  return out;
}

async function guard(step, name, opts, fn, fallback) {
  try {
    return await step.do(name, opts, fn);
  } catch (err) {
    console.error(`${name} failed: ${errText(err)}`);
    return fallback;
  }
}

async function postJson(url, payload) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`POST failed with ${res.status}`);
}

async function slackFallback(env, step, name, text) {
  if (!env.SLACK_WEBHOOK_URL) { console.error(`${name}: Slack was not told (SLACK_WEBHOOK_URL is not set)`); return false; }
  try {
    await step.do(name, SLACK_RETRY, async () => { await postJson(env.SLACK_WEBHOOK_URL, { text, unfurl_links: false, unfurl_media: false }); return "sent"; });
    return true;
  } catch (err) {
    console.error(`${name}: ${errText(err)}`);
    return false;
  }
}

// ---------- KV ----------

export const getRecord = (env, sid) => env.AUDITS.get(`founding:${sid}`, "json");
const putRecord = (env, rec) => env.AUDITS.put(`founding:${rec.session_id}`, JSON.stringify(rec));

// Read, change, write. fn gets the stored record and returns the new one (or null to leave it).
async function updateRecord(env, sid, fn) {
  const rec = await getRecord(env, sid);
  if (!rec) return null;
  const next = fn(rec);
  if (next) await putRecord(env, next);
  return next || rec;
}

async function listKeys(env, prefix) {
  const out = [];
  let cursor;
  do {
    const page = await env.AUDITS.list({ prefix, cursor });
    for (const k of page.keys) out.push(k.name.slice(prefix.length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

// Founding purchases held in KV: paid ones and bank payments still processing.
export async function spotsTaken(env) {
  return (await listKeys(env, "founding:taken:")).length;
}

// Taken spots, plus other churches' checkouts still open on Stripe. owner skips the asker's own hold,
// so a church that left checkout and came back is never blocked by itself.
export async function spotsBusy(env, owner = "") {
  const taken = new Set(await listKeys(env, "founding:taken:"));
  const held = new Set();
  for (const rest of await listKeys(env, "founding:hold:")) {
    const [who, sid] = rest.split(":");
    if (sid && who !== owner && !taken.has(sid)) held.add(sid);
  }
  return { taken: taken.size, held: held.size };
}

// KV has no atomic counter, so two churches paying at the same moment can both take the last spot.
// This catches it once the payment lands: true when this session pushes the count past the total.
async function isOversold(env, sid) {
  const taken = new Set(await listKeys(env, "founding:taken:"));
  taken.add(sid);
  return taken.size > total(env);
}

async function releaseHold(env, rec) {
  if (!rec?.hold_key) return;
  try { await env.AUDITS.delete(rec.hold_key); } catch (err) { console.error(`founding hold ${rec.session_id}: ${errText(err)}`); }
}

// The IP is keyed with a secret, so nobody holding the hash can test all 4 billion IPv4 addresses
// against it. IP_HASH_SECRET when set, else the Stripe key (always set when checkout runs).
async function ipHashOf(env, ip) {
  return (await hmacHex(env.IP_HASH_SECRET || env.STRIPE_SECRET_KEY, `founding-ip|${ip}`)).slice(0, 32);
}

export async function spotsLeft(env) {
  return Math.max(0, total(env) - (await spotsTaken(env)));
}

// ---------- Routes ----------

// Returns a Response for the founding routes, or null for any other path.
export async function foundingRoute(request, env, cors, ctx, path) {
  const m = request.method;
  if (path === "/founding/status" && m === "GET") return status(env, cors);
  if (path === "/founding/checkout" && m === "POST") return checkout(request, env, cors);
  if (path === "/founding/session" && m === "GET") return sessionStatus(request, env, cors, ctx);
  if (path === "/founding/start" && m === "GET") return startConfirm(request, env);
  if (path === "/founding/start" && m === "POST") return startMonthly(request, env);
  if (path === "/stripe/webhook" && m === "POST") return webhook(request, env, ctx);
  return null;
}

async function status(env, cors) {
  const left = await spotsLeft(env);
  const open = live(env) && stripeReady(env) && left > 0;
  return json({ open, spots_left: left, total: total(env), terms_version: termsVersion(env) }, 200, { ...cors, "Cache-Control": "no-store" });
}

async function checkout(request, env, cors) {
  if (!originAllowed(env, request)) return json({ ok: false, error: "Forbidden" }, 403, cors);
  if (!(request.headers.get("content-type") || "").includes("application/json")) return json({ ok: false, error: "Send JSON" }, 415, cors);
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (env.INTAKE_LIMIT && !(await env.INTAKE_LIMIT.limit({ key: `founding:${ip}` })).success) return json({ ok: false, error: "Too many tries. Wait a minute and try again." }, 429, cors);
  const text = await request.text();
  if (text.length > MAX_BODY) return json({ ok: false, error: "Too large" }, 413, cors);
  let body;
  try { body = JSON.parse(text); } catch { return json({ ok: false, error: "Bad JSON" }, 400, cors); }
  if (!body || typeof body !== "object") return json({ ok: false, error: "Bad JSON" }, 400, cors);
  if (body.hp_x7) return json({ ok: false, error: CHECKOUT_FAILED }, 400, cors);

  if (!live(env) || !stripeReady(env)) return json({ ok: false, closed: true, error: NOT_OPEN }, 409, cors);

  const f = {};
  for (const [k, max] of Object.entries(LIMITS)) f[k] = clean(body[k], max);
  if (!f.church || !f.name || !f.role || !f.email || !f.phone) return json({ ok: false, error: "Please fill in your church name, your name, your role, email and cell." }, 400, cors);
  if (!EMAIL_SHAPE.test(f.email)) return json({ ok: false, error: "Check the email address." }, 400, cors);
  const phone = ghl.usPhone(f.phone);
  if (!phone) return json({ ok: false, error: "Check the cell number." }, 400, cors);
  let website = "";
  if (f.website) {
    website = normalizeUrl(f.website) || "";
    if (!website) return json({ ok: false, error: "Check the church website address." }, 400, cors);
  }
  const term = TERMS[String(body.term ?? "").trim()] ? String(body.term).trim() : null;
  if (!term) return json({ ok: false, error: "Choose a 12 month or 6 month partnership." }, 400, cors);
  if (!truthy(body.agree_terms) || !truthy(body.agree_authorized)) return json({ ok: false, error: "Please check both boxes to continue." }, 400, cors);
  const auditId = AUDIT_ID.test(String(body.audit_id || "")) ? String(body.audit_id) : "";

  // A double click, or a second tap while Stripe loads, gets the page that already opened.
  const formHash = await sha256Hex(`${f.email.toLowerCase()}|${f.church.toLowerCase()}|${term}`);
  const pendingKey = `founding:pending:${formHash.slice(0, 32)}`;
  const owner = formHash.slice(0, 16);
  try {
    const pending = await env.AUDITS.get(pendingKey, "json");
    if (pending?.url && pending.id) {
      const prior = await getRecord(env, pending.id);
      if (prior?.status === "open") return json({ ok: true, url: pending.url }, 200, cors);
    }
  } catch {}

  const busy = await spotsBusy(env, owner);
  if (busy.taken >= total(env)) return json({ ok: false, closed: true, spots_left: 0, error: CLOSED }, 409, cors);
  if (busy.taken + busy.held >= total(env)) return json({ ok: false, held: true, spots_left: total(env) - busy.taken, error: HELD }, 409, cors);

  const origin = request.headers.get("origin");
  const base = origin + foundingBase(origin);
  const plan = TERMS[term];
  const agreedAt = nowIso();
  const ipHash = await ipHashOf(env, ip);
  const metadata = {
    kind: "founding", church: f.church, contact_name: f.name, role: f.role, phone, website,
    term, monthly_amount: String(plan.monthly), terms_version: termsVersion(env), agreed_at: agreedAt,
    ip_hash: ipHash, audit_id: auditId, utm: f.utm,
  };
  let session;
  try {
    session = await stripeCall(env, "POST", "/checkout/sessions", {
      params: {
        mode: "payment",
        line_items: [{ price_data: { currency: "usd", unit_amount: BUILD_CENTS, product_data: { name: BUILD_NAME } }, quantity: 1 }],
        allowed_payment_method_types: ["card", "us_bank_account"],
        // Instant bank verification only: microdeposits would hold a spot for up to 10 days before any debit.
        payment_method_options: { us_bank_account: { verification_method: "instant" } },
        customer_creation: "always",
        customer_email: f.email,
        billing_address_collection: "auto",
        payment_intent_data: { setup_future_usage: "off_session", description: `${BUILD_NAME}: ${f.church}`.slice(0, 500), metadata: { kind: "founding", church: f.church, term } },
        metadata,
        success_url: `${base}welcome/?session={CHECKOUT_SESSION_ID}`,
        cancel_url: `${base}?canceled=1`,
        expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_MINUTES * 60,
      },
    });
  } catch (err) {
    console.error(`founding checkout: ${errText(err)}`);
    return json({ ok: false, error: CHECKOUT_FAILED }, 502, cors);
  }
  if (!session?.id || !session.url) {
    console.error("founding checkout: Stripe sent back no session id or url");
    return json({ ok: false, error: CHECKOUT_FAILED }, 502, cors);
  }

  const holdKey = `founding:hold:${owner}:${session.id}`;
  const rec = {
    kind: "founding", session_id: session.id, status: "open", hold_key: holdKey, created: agreedAt, origin, api_origin: new URL(request.url).origin,
    church: { name: f.church, website }, contact: { name: f.name, role: f.role, email: f.email, phone },
    term, months: plan.months, monthly_amount: plan.monthly, amount: BUILD_CENTS / 100,
    agreement: {
      terms_version: termsVersion(env), terms_url: `${base}terms/`, statements: [STATEMENT_TERMS, statementAuthorized(f.church)],
      agreed_at: agreedAt, ip_hash: ipHash, user_agent: clean(request.headers.get("user-agent"), 300),
    },
    audit_id: auditId, utm: f.utm, start_token: newToken(),
  };
  try { await env.AUDITS.put(holdKey, "open", { expirationTtl: HOLD_TTL }); } catch (err) { console.error(`founding hold ${session.id}: ${errText(err)}`); }
  try {
    await putRecord(env, rec);
    await env.AUDITS.put(pendingKey, JSON.stringify({ id: session.id, url: session.url }), { expirationTtl: PENDING_TTL });
  } catch (err) {
    // The webhook rebuilds the record from the session metadata, so the church can still pay.
    console.error(`founding checkout save ${session.id}: ${errText(err)}`);
  }
  return json({ ok: true, url: session.url }, 200, cors);
}

// The welcome page: the church name and where the payment stands. Nothing else personal.
async function sessionStatus(request, env, cors, ctx) {
  const headers = { ...cors, "Cache-Control": "no-store" };
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!SESSION_ID.test(id)) return json({ error: "Not found" }, 404, headers);
  const rec = await getRecord(env, id);
  if (rec && ["paid", "processing", "failed", "expired"].includes(rec.status)) return json({ church: rec.church?.name || "", status: rec.status }, 200, headers);
  if (!stripeReady(env)) return rec ? json({ church: rec.church?.name || "", status: rec.status || "open" }, 200, headers) : json({ error: "Not found" }, 404, headers);

  // KV says open (or has no record yet): ask Stripe, and settle the record the way the webhook would.
  // The Stripe account's rate limit is shared with GoHighLevel and checkout, so made-up ids stop here:
  // a known miss answers from KV, and one address gets INTAKE_LIMIT lookups a minute.
  const asOpen = () => (rec ? json({ church: rec.church?.name || "", status: "open" }, 200, headers) : json({ error: "Not found" }, 404, headers));
  const missKey = `founding:miss:${id}`;
  if (!rec && await env.AUDITS.get(missKey)) return json({ error: "Not found" }, 404, headers);
  const ip = request.headers.get("cf-connecting-ip") || "unknown";
  if (env.INTAKE_LIMIT && !(await env.INTAKE_LIMIT.limit({ key: `founding-session:${ip}` })).success) return asOpen();
  const miss = () => env.AUDITS.put(missKey, "1", { expirationTtl: MISS_TTL }).catch(() => {});
  let s;
  try {
    s = await stripeCall(env, "GET", `/checkout/sessions/${encodeURIComponent(id)}`);
  } catch (err) {
    console.error(`founding session ${id}: ${errText(err)}`);
    if (err?.status === 404 && !rec) await miss();
    return asOpen();
  }
  if (s?.metadata?.kind !== "founding") { await miss(); return json({ error: "Not found" }, 404, headers); }
  const st = s.status === "expired" ? "expired" : s.status === "complete" ? (s.payment_status === "paid" ? "paid" : "processing") : "open";
  if (s.status === "complete") {
    const settle = onCompleted(env, s, ctx).catch((err) => console.error(`founding settle ${id}: ${errText(err)}`));
    if (ctx?.waitUntil) ctx.waitUntil(settle); else await settle;
  }
  return json({ church: rec?.church?.name || s.metadata.church || "", status: st }, 200, headers);
}

// ---------- Webhook ----------

const HANDLED = new Set([
  "checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed",
  "invoice.paid", "invoice.payment_failed", "customer.subscription.deleted",
]);

async function webhook(request, env, ctx) {
  if (!env.STRIPE_WEBHOOK_SECRET) {
    // A 5xx makes Stripe retry, so nothing is lost while the secret is being set.
    console.error("Stripe webhook: STRIPE_WEBHOOK_SECRET is not set");
    return json({ error: "Not set up" }, 503);
  }
  const payload = await request.text();
  if (payload.length > MAX_WEBHOOK) return json({ error: "Too large" }, 413);
  const v = await verifySignature(payload, request.headers.get("stripe-signature"), env.STRIPE_WEBHOOK_SECRET);
  if (!v.ok) { console.error(`Stripe webhook refused: ${v.reason}`); return json({ error: "Bad signature" }, 400); }
  let event;
  try { event = JSON.parse(payload); } catch { return json({ error: "Bad JSON" }, 400); }
  if (!event?.id || !event.type) return json({ error: "Bad event" }, 400);
  if (!HANDLED.has(event.type)) return json({ received: true, ignored: true });

  const seenKey = `stripe:event:${event.id}`;
  if (await env.AUDITS.get(seenKey)) return json({ received: true, duplicate: true });
  // A handler that throws gets a 500, and Stripe sends the event again.
  await handleEvent(env, event, ctx);
  await env.AUDITS.put(seenKey, nowIso(), { expirationTtl: EVENT_TTL });
  return json({ received: true });
}

export async function handleEvent(env, event, ctx) {
  const o = event.data?.object || {};
  switch (event.type) {
    case "checkout.session.completed": return onCompleted(env, o, ctx);
    case "checkout.session.async_payment_succeeded": return founding(o) ? markWon(env, o, "bank", ctx) : null;
    case "checkout.session.async_payment_failed": return founding(o) ? markFailed(env, o, ctx) : null;
    case "invoice.paid": return onInvoice(env, o, "invoice_paid", ctx);
    case "invoice.payment_failed": return onInvoice(env, o, "invoice_failed", ctx);
    case "customer.subscription.deleted": return onSubscriptionDeleted(env, o, ctx);
  }
  return null;
}

// Only our own founding sessions. The Stripe account also serves GoHighLevel, whose events land here too.
const founding = (s) => s?.object === "checkout.session" && s.mode === "payment" && s.metadata?.kind === "founding" && SESSION_ID.test(String(s.id || ""));

async function onCompleted(env, s, ctx) {
  if (!founding(s)) return null;
  if (s.amount_total !== undefined && s.amount_total !== BUILD_CENTS) {
    console.error(`founding ${s.id}: amount ${s.amount_total} is not ${BUILD_CENTS}, left alone`);
    return null;
  }
  // A card pays at once. Checkout offers one delayed method here, the bank account, which completes unpaid.
  if (s.payment_status === "paid") return markWon(env, s, "card", ctx);
  if (s.payment_status === "unpaid") return markProcessing(env, s, ctx);
  return null;
}

// The record for a session, rebuilt from the session's metadata when KV lost it.
async function loadOrRebuild(env, s) {
  const rec = await getRecord(env, s.id);
  if (rec) return rec;
  const md = s.metadata || {};
  const term = TERMS[md.term] ? md.term : "12";
  const church = clean(md.church, 120) || "Unnamed church";
  const built = {
    kind: "founding", session_id: s.id, status: "open", created: nowIso(), rebuilt: true,
    church: { name: church, website: clean(md.website, 300) },
    contact: { name: clean(md.contact_name, 120), role: clean(md.role, 120), email: clean(s.customer_details?.email || s.customer_email, 200), phone: clean(md.phone, 40) },
    term, months: TERMS[term].months, monthly_amount: TERMS[term].monthly, amount: BUILD_CENTS / 100,
    agreement: { terms_version: clean(md.terms_version, 40), statements: [STATEMENT_TERMS, statementAuthorized(church)], agreed_at: clean(md.agreed_at, 40), ip_hash: clean(md.ip_hash, 64), user_agent: "" },
    audit_id: AUDIT_ID.test(md.audit_id || "") ? md.audit_id : "", utm: clean(md.utm, 500), start_token: newToken(),
  };
  await putRecord(env, built);
  return built;
}

const stripeIds = (s) => ({
  customer: typeof s.customer === "string" ? s.customer : s.customer?.id || null,
  payment_intent: typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id || null,
});

async function markProcessing(env, s, ctx) {
  const rec = await loadOrRebuild(env, s);
  // Only forward: a bank payment that already settled or failed stays where it is.
  if (rec.status === "processing") { await env.AUDITS.put(`founding:taken:${s.id}`, "processing"); await releaseHold(env, rec); return null; }
  if (rec.status !== "open" && rec.status !== "expired") return null;
  const ids = stripeIds(s);
  await env.AUDITS.put(`founding:taken:${s.id}`, "processing");
  const over = await isOversold(env, s.id);
  await putRecord(env, { ...rec, status: "processing", processing_at: nowIso(), customer: ids.customer || rec.customer || null, payment_intent: ids.payment_intent || rec.payment_intent || null, ...(over ? { oversold: true } : {}) });
  await releaseHold(env, rec);
  const who = `${rec.contact?.name || ""} ${rec.contact?.email || ""}`;
  if (over) {
    return notice(env, ctx, {
      kind: "oversold", id: `oversold-${s.id}`, session_id: s.id, church: rec.church?.name, clickup_task_id: "",
      message: `${rec.church?.name || "A church"} started a $3,500 bank payment after all ${total(env)} founding spots were taken. Decide whether to honor or refund it before the bank payment clears. ${who}`.replace(/\s+/g, " ").trim(),
    });
  }
  return notice(env, ctx, {
    kind: "bank_processing", id: `bank_processing-${s.id}`, session_id: s.id, church: rec.church?.name, clickup_task_id: "",
    message: `${rec.church?.name || "A church"} chose to pay the $3,500 founding build by bank. The payment is processing, which takes about 4 business days. Their founding spot is held. ${who}`.replace(/\s+/g, " ").trim(),
  });
}

async function markWon(env, s, paidBy, ctx) {
  const rec = await loadOrRebuild(env, s);
  // Written on every pass, so a retry after a failed write still holds the spot.
  await env.AUDITS.put(`founding:taken:${s.id}`, "paid");
  let paid = rec;
  if (rec.status !== "paid") {
    const ids = stripeIds(s);
    // A bank payment was counted when it started processing.
    const over = rec.status === "processing" ? rec.oversold === true : await isOversold(env, s.id);
    paid = {
      ...rec, status: "paid", paid_by: rec.status === "processing" ? "bank" : paidBy, paid_at: nowIso(),
      customer: ids.customer || rec.customer || null, payment_intent: ids.payment_intent || rec.payment_intent || null,
      ...(over ? { oversold: true } : {}),
    };
    await putRecord(env, paid);
  }
  await releaseHold(env, rec);
  if (rec.won?.done) return null;
  // The paid record rides along, so a stale KV read inside the Workflow can't end it early.
  return startFlow(env, ctx, `won-${s.id}`, { action: "won", session: s.id, rec: paid });
}

async function markFailed(env, s, ctx) {
  const rec = await loadOrRebuild(env, s);
  if (rec.status === "paid" || rec.status === "failed") return null;
  await putRecord(env, { ...rec, status: "failed", failed_at: nowIso() });
  await env.AUDITS.delete(`founding:taken:${s.id}`);
  await releaseHold(env, rec);
  return notice(env, ctx, {
    kind: "bank_failed", id: `bank_failed-${s.id}`, session_id: s.id, church: rec.church?.name, clickup_task_id: rec.clickup_task_id || "",
    message: `The $3,500 bank payment from ${rec.church?.name || "a founding church"} failed. Their founding spot is open again. Reach out to ${rec.contact?.name || "them"} (${rec.contact?.email || "no email"}) about paying another way.`,
  });
}

// The session behind a subscription: our own mapping first, then the subscription's metadata.
async function sessionForSubscription(env, subId, metadata) {
  if (subId) {
    const sid = await env.AUDITS.get(`founding:subscription:${subId}`);
    if (sid) return sid;
  }
  return metadata?.kind === "founding" && SESSION_ID.test(String(metadata.session || "")) ? metadata.session : null;
}

async function onInvoice(env, inv, kind, ctx) {
  // The subscription sits under parent.subscription_details on current API versions, at the top before.
  const details = inv.parent?.subscription_details || {};
  const subId = typeof details.subscription === "string" ? details.subscription : details.subscription?.id || (typeof inv.subscription === "string" ? inv.subscription : null);
  const sid = await sessionForSubscription(env, subId, details.metadata || inv.subscription_details?.metadata);
  if (!sid) return null;
  // The trial's $0 invoice is not a payment.
  if (kind === "invoice_paid" && !(inv.amount_paid > 0)) return null;
  const rec = (await getRecord(env, sid)) || {};
  const church = rec.church?.name || "A founding church";
  const amount = dollars(((kind === "invoice_paid" ? inv.amount_paid : inv.amount_due) || 0) / 100);
  return notice(env, ctx, {
    kind, id: `${kind}-${inv.id}`, session_id: sid, church, clickup_task_id: rec.clickup_task_id || "",
    message: kind === "invoice_paid"
      ? `${church} paid ${amount} for monthly campaign management.`
      : `The ${amount} monthly payment from ${church} failed. Stripe retries on its schedule. Send them the payment page if it keeps failing.`,
    link: kind === "invoice_failed" ? inv.hosted_invoice_url || "" : "",
  });
}

async function onSubscriptionDeleted(env, sub, ctx) {
  const sid = await sessionForSubscription(env, sub.id, sub.metadata);
  if (!sid) return null;
  const rec = (await getRecord(env, sid)) || {};
  if (rec.session_id) await putRecord(env, { ...rec, subscription: { ...(rec.subscription || {}), canceled_at: nowIso() } });
  return notice(env, ctx, {
    kind: "canceled", id: `canceled-${sub.id}`, session_id: sid, church: rec.church?.name || "A founding church", clickup_task_id: rec.clickup_task_id || "",
    message: `Monthly billing for ${rec.church?.name || "a founding church"} ended in Stripe. No more monthly charges go out.`,
  });
}

// ---------- Flows ----------

// The won steps and the desk notices run in the FoundingFlow Workflow. Its instance id exists once, so a
// repeated event starts nothing new. Without the binding they run here, in order.
async function startFlow(env, ctx, id, params) {
  if (env.FOUNDING_FLOW) {
    try {
      await env.FOUNDING_FLOW.create({ id, params });
    } catch (err) {
      if (!/already|exist|duplicate/i.test(errText(err))) throw err;
    }
    return null;
  }
  return runFlow(env, directStep, params);
}

const notice = (env, ctx, n) => startFlow(env, ctx, `notice-${n.id}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 100), { action: "notice", notice: n });

export async function runFlow(env, step, params) {
  if (params?.action === "won") return runWon(env, step, params.session, params.rec);
  if (params?.action === "notice") return runNotice(env, step, params.notice);
  console.error(`FoundingFlow: unknown action ${params?.action}`);
  return null;
}

export class FoundingFlow extends WorkflowEntrypoint {
  async run(event, step) {
    return runFlow(this.env, step, event.payload);
  }
}

const DEFAULT_TERMS_URL = "https://bigsplash.video/church/founding/terms/";
const startUrl = (env, rec) => `${rec.api_origin || env.WORKER_ORIGIN || ""}/founding/start?session=${encodeURIComponent(rec.session_id)}&t=${encodeURIComponent(rec.start_token || "")}`;

export function agreementSummary(rec) {
  const a = rec.agreement || {};
  const st = (a.statements || []).map((x) => `"${x}"`).join(" and ");
  return `Checked ${st || "both boxes"} on the founding form. Terms version ${a.terms_version || "unknown"}, agreed ${a.agreed_at || "at an unknown time"}, IP hash ${String(a.ip_hash || "none").slice(0, 16)}.`;
}

// The GoHighLevel note: the whole agreement record, for the file.
export function agreementNote(rec) {
  const a = rec.agreement || {};
  const plan = TERMS[rec.term] || TERMS["12"];
  return [
    "Founding partner: paid the $3,500 campaign build (month 1 included)",
    `Church: ${rec.church?.name || "not given"}`,
    `Website: ${rec.church?.website || "none"}`,
    `Contact: ${rec.contact?.name || "no name"}${rec.contact?.role ? ` (${rec.contact.role})` : ""}`,
    `Email: ${rec.contact?.email || "not given"}`,
    `Cell: ${rec.contact?.phone || "not given"}`,
    `Term: ${plan.months} months at ${dollars(plan.monthly)}/month, starting the day the campaign launches`,
    `Paid by: ${rec.paid_by === "bank" ? "bank (ACH)" : "card"}`,
    `Terms version: ${a.terms_version || "unknown"}`,
    `Terms page: ${a.terms_url || "not recorded"}`,
    ...(a.statements || []).map((x) => `Checked: ${x}`),
    `Agreed at: ${a.agreed_at || "unknown"}`,
    `IP hash: ${a.ip_hash || "none"}`,
    `Browser: ${a.user_agent || "not recorded"}`,
    `Stripe customer: ${rec.customer || "unknown"}`,
    `Stripe checkout: ${rec.session_id}`,
    ...(rec.audit_id ? [`Front Door audit: ${rec.audit_id}`] : []),
  ].join("\n");
}

export function wonPayload(env, rec, { spotsLeft: left = null, emailed = false } = {}) {
  return {
    event: "won",
    id: rec.session_id,
    session_id: rec.session_id,
    church: { name: rec.church?.name || "", website: rec.church?.website || "" },
    contact: { name: rec.contact?.name || "", role: rec.contact?.role || "", email: rec.contact?.email || "", phone: rec.contact?.phone || "" },
    term: rec.term,
    monthly_amount: rec.monthly_amount,
    amount_paid: BUILD_CENTS / 100,
    paid_by: rec.paid_by || "card",
    stripe_customer: rec.customer || "",
    agreement_summary: agreementSummary(rec),
    start_monthly_url: startUrl(env, rec),
    audit_id: rec.audit_id || "",
    utm: parseUtm(rec.utm),
    spots_left: left,
    spots_total: total(env),
    emailed: emailed === true,
    paid_at: rec.paid_at || nowIso(),
  };
}

const deskShape = (r) => ({ clickup: { ok: Boolean(r?.clickup?.ok), id: r?.clickup?.id || null, url: r?.clickup?.url || null }, slack: { ok: Boolean(r?.slack?.ok) } });

// Won: GoHighLevel, the welcome email, then LeadDesk. Each piece is its own step and caught on its own.
// snapshot is the paid record markWon wrote, used when KV still serves an older copy.
export async function runWon(env, step, sid, snapshot = null) {
  let rec;
  try {
    rec = await step.do("load", LOAD, async () => {
      const r = await getRecord(env, sid);
      if (r?.status === "paid") return r;
      if (snapshot?.status === "paid" && snapshot.session_id === sid) return snapshot;
      // Thrown, so the step tries again until the paid record shows.
      throw new Error(`record is ${r?.status || "missing"}`);
    });
  } catch (err) {
    console.error(`won ${sid}: nothing to do (${errText(err)})`);
    return null;
  }
  if (rec.oversold) return runOversold(env, step, rec);
  const out = { contactId: null, noted: false, emailed: false };
  if (!ghl.ghlReady(env)) console.error("won: GoHighLevel skipped, GHL_TOKEN or GHL_LOCATION_ID is not set");
  else if (rec.contact?.email) {
    const up = await guard(step, "won ghl contact", STEP, () => ghl.upsertContact(env, {
      name: rec.contact.name, email: rec.contact.email, phone: rec.contact.phone, church: rec.church?.name, website: rec.church?.website,
      tags: ["founding-partner", "fd-stop"], source: "Founding checkout",
    }), null);
    out.contactId = up?.contactId || null;
    if (out.contactId) {
      out.noted = await guard(step, "won ghl note", ONCE, () => ghl.sendOnce(env, `founding:sent:${sid}:note`, () => ghl.addNote(env, out.contactId, agreementNote(rec))), false);
      const email = foundingWelcomeEmail({ firstName: ghl.splitName(rec.contact.name).firstName, church: rec.church?.name, kickoffUrl: KICKOFF_URL, termMonths: rec.months, monthly: rec.monthly_amount,
        termsUrl: rec.agreement?.terms_url || DEFAULT_TERMS_URL, termsVersion: rec.agreement?.terms_version, address: env.BUSINESS_ADDRESS });
      out.emailed = await guard(step, "won welcome email", ONCE, () => ghl.sendOnce(env, `founding:sent:${sid}:welcome`, () =>
        ghl.sendEmail(env, { contactId: out.contactId, subject: email.subject, html: email.html, text: email.text })), false);
    }
  }
  const left = await guard(step, "won spots", ONCE, () => spotsLeft(env), null);
  let desk = null;
  if (env.DESK) desk = await guard(step, "won desk", STEP, async () => deskShape(await env.DESK.frontDoorLead(wonPayload(env, rec, { spotsLeft: left, emailed: out.emailed }))), null);

  await guard(step, "won save", STEP, async () => {
    await updateRecord(env, sid, (r) => ({ ...r, won: { done: nowIso(), ghl: out, desk }, clickup_task_id: desk?.clickup?.id || r.clickup_task_id || "" }));
    return true;
  }, false);

  if (!(env.DESK && desk?.slack?.ok)) {
    const c = rec.contact || {};
    await slackFallback(env, step, "won slack fallback", [
      `*New founding partner:* ${slackSafe(rec.church?.name)}`,
      `${slackSafe(c.name)}${c.role ? `, ${slackSafe(c.role)}` : ""} · ${slackSafe(c.email)} · ${slackSafe(c.phone)}`,
      `Paid $3,500 by ${rec.paid_by === "bank" ? "bank" : "card"} · ${rec.months} months at ${dollars(rec.monthly_amount)}/month`,
      out.emailed ? "Welcome email sent through GoHighLevel." : ghl.ghlReady(env) ? "Welcome email did NOT go out. Send it by hand." : "Not in GoHighLevel: GHL_TOKEN is not set. Add them and send the welcome by hand.",
      !env.DESK ? "LeadDesk is not bound: add the ClickUp onboarding task by hand." : desk?.clickup?.ok ? `ClickUp: ${desk.clickup.url || desk.clickup.id}` : "LeadDesk did not reach ClickUp. Add the onboarding task by hand.",
      `Start monthly billing after launch: ${startUrl(env, rec)}`,
    ].join("\n"));
  }
  return { ghl: out, desk };
}

// Past the last spot: nothing goes to the church, GoHighLevel or ClickUp until Chris decides.
async function runOversold(env, step, rec) {
  const c = rec.contact || {};
  const n = {
    kind: "oversold", id: `oversold-won-${rec.session_id}`, session_id: rec.session_id, church: rec.church?.name || "A church", clickup_task_id: "",
    message: [
      `${rec.church?.name || "A church"} paid $3,500 by ${rec.paid_by === "bank" ? "bank" : "card"} after all ${total(env)} founding spots were taken.`,
      "They got no welcome email, no GoHighLevel contact and no ClickUp task.",
      "To refund, use the Stripe dashboard. To honor it, add them in GoHighLevel, send the welcome by hand, and start monthly billing after launch:",
      startUrl(env, rec),
      `Contact: ${c.name || "no name"} ${c.email || ""} ${c.phone || ""}`.trim(),
    ].join(" "),
  };
  const r = await runNotice(env, step, n);
  await guard(step, "won save", STEP, async () => {
    await updateRecord(env, rec.session_id, (x) => ({ ...x, oversold: true, won: { done: nowIso(), oversold: true } }));
    return true;
  }, false);
  return { oversold: true, desk: r?.desk || null };
}

// A billing notice: LeadDesk comments on the client task (when there is one) and posts Slack.
export async function runNotice(env, step, n) {
  if (!n?.kind) return null;
  const payload = { event: "billing", id: n.id, kind: n.kind, session_id: n.session_id || "", church: { name: n.church || "" }, clickup_task_id: n.clickup_task_id || "", message: n.message || "", link: n.link || "" };
  let desk = null;
  if (env.DESK) desk = await guard(step, `${n.kind} desk`, STEP, async () => deskShape(await env.DESK.frontDoorLead(payload)), null);
  if (!(env.DESK && desk?.slack?.ok)) {
    await slackFallback(env, step, `${n.kind} slack fallback`, [`*${NOTICE_HEADLINES[n.kind] || "Founding billing"}:* ${slackSafe(n.church)}`, slackSafe(n.message), n.link ? `Payment page: ${n.link}` : ""].filter(Boolean).join("\n"));
  }
  return { desk };
}

export const NOTICE_HEADLINES = {
  started: "Monthly billing set",
  invoice_paid: "Monthly payment received",
  invoice_failed: "Monthly payment failed",
  canceled: "Monthly billing ended",
  bank_processing: "Founding bank payment processing",
  bank_failed: "Founding bank payment failed",
  oversold: "OVERSOLD: refund or honor this church",
};

// ---------- Start monthly billing ----------

// Noon on y-m-d in the time zone, as epoch ms. Two passes settle a clock change.
export function zonedNoon(y, m0, d, zone) {
  const wall = Date.UTC(y, m0, d, 12);
  let guess = wall;
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", hourCycle: "h23" })
      .formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
    guess += wall - Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
  }
  return guess;
}

// Month 1 is included, so the first monthly charge is 30 days after launch, at noon in TIMEZONE.
// Returns epoch seconds, or null for a date that does not parse.
export function trialEnd(launch, zone = "America/Chicago") {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(launch || ""));
  if (!m) return null;
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (day.getUTCFullYear() !== Number(m[1]) || day.getUTCMonth() !== Number(m[2]) - 1 || day.getUTCDate() !== Number(m[3])) return null;
  const due = new Date(day.getTime() + 30 * DAY_MS);
  return Math.floor(zonedNoon(due.getUTCFullYear(), due.getUTCMonth(), due.getUTCDate(), zone) / 1000);
}

export const longDate = (secs, zone) => new Date(secs * 1000).toLocaleDateString("en-US", { timeZone: zone, month: "long", day: "numeric", year: "numeric" });

// The monthly price for a term, by lookup key. A missing price is made once, on the same product as the
// other term's price when that one exists.
export async function ensurePrice(env, term) {
  const plan = TERMS[term];
  const keys = ["12", "6"].map((k) => TERMS[k].lookup);
  const found = await stripeCall(env, "GET", "/prices", { query: { lookup_keys: keys, active: true, limit: 10 } });
  const list = Array.isArray(found?.data) ? found.data : [];
  const hit = list.find((p) => p?.lookup_key === plan.lookup);
  if (hit?.id) return hit.id;
  const other = list.find((p) => p?.product);
  const product = other ? (typeof other.product === "string" ? other.product : other.product.id) : null;
  const created = await stripeCall(env, "POST", "/prices", {
    params: {
      currency: "usd", unit_amount: plan.monthly * 100, recurring: { interval: "month" }, lookup_key: plan.lookup,
      nickname: `${MONTHLY_NAME}, ${plan.months} months`, ...(product ? { product } : { product_data: { name: MONTHLY_NAME } }),
      // An archived price can still hold the key. This moves it to the new price.
      transfer_lookup_key: true,
    },
    idempotencyKey: `bs-price-${plan.lookup}`,
  });
  if (!created?.id) throw new Error("Stripe sent back no price id");
  return created.id;
}

// The card or bank account saved by the founding checkout (setup_future_usage off_session).
async function savedPaymentMethod(env, rec) {
  let pi = rec.payment_intent;
  if (!pi) {
    const s = await stripeCall(env, "GET", `/checkout/sessions/${encodeURIComponent(rec.session_id)}`);
    pi = typeof s?.payment_intent === "string" ? s.payment_intent : s?.payment_intent?.id;
  }
  if (!pi) throw new Error("The checkout has no PaymentIntent");
  const intent = await stripeCall(env, "GET", `/payment_intents/${encodeURIComponent(pi)}`);
  const pm = typeof intent?.payment_method === "string" ? intent.payment_method : intent?.payment_method?.id;
  if (!pm) throw new Error("The PaymentIntent has no saved payment method");
  return pm;
}

// One subscription per founding session: an earlier one for this customer and session comes back as is.
export async function createMonthly(env, rec, launch) {
  const zone = tz(env);
  const end = trialEnd(launch, zone);
  if (!end) throw Object.assign(new Error("Pick the launch date."), { user: true });
  const nowSecs = Math.floor(Date.now() / 1000);
  if (end < nowSecs + 3600) throw Object.assign(new Error("That launch date is more than 30 days ago, so month 1 is already over. Pick the real launch date, or set billing up in Stripe by hand."), { user: true });
  if (end > nowSecs + 400 * 86400) throw Object.assign(new Error("That launch date is more than a year away. Check the date."), { user: true });
  if (!rec.customer) throw new Error("The record has no Stripe customer");

  const subs = await stripeCall(env, "GET", "/subscriptions", { query: { customer: rec.customer, status: "all", limit: 100 } });
  const existing = (subs?.data || []).find((x) => x?.metadata?.session === rec.session_id && x.status !== "canceled" && x.status !== "incomplete_expired");
  if (existing?.id) return { id: existing.id, trial_end: existing.trial_end || end, existing: true };

  const price = await ensurePrice(env, rec.term);
  const pm = await savedPaymentMethod(env, rec);
  const sub = await stripeCall(env, "POST", "/subscriptions", {
    params: {
      customer: rec.customer,
      items: [{ price }],
      default_payment_method: pm,
      trial_end: end,
      description: `${MONTHLY_NAME}: ${rec.church?.name || ""}`.slice(0, 500),
      metadata: { kind: "founding", church: rec.church?.name || "", term: rec.term, session: rec.session_id, launch },
    },
    idempotencyKey: `bs-sub-${rec.session_id}`,
  });
  if (!sub?.id) throw new Error("Stripe sent back no subscription id");
  return { id: sub.id, trial_end: sub.trial_end || end, price, existing: false };
}

async function startRecord(env, sid, t) {
  if (!SESSION_ID.test(sid || "")) return null;
  const rec = await getRecord(env, sid);
  return rec && safeEqual(rec.start_token, t || "") ? rec : null;
}

const startedText = (env, rec) => `Monthly billing for ${rec.church?.name || "this church"} starts ${longDate(rec.subscription.trial_end, tz(env))} at ${dollars(rec.monthly_amount)}. Stripe subscription ${rec.subscription.id}.`;

// The start link from ClickUp or Slack. A GET changes nothing: link previews open links.
async function startConfirm(request, env) {
  const q = new URL(request.url).searchParams;
  const rec = await startRecord(env, q.get("session"), q.get("t"));
  if (!rec) return page("Not found", "That link does not match a founding partner.", 404);
  if (rec.subscription?.id) return page("Already started", startedText(env, rec));
  if (rec.status !== "paid") return page("Not paid yet", `The $3,500 for ${rec.church?.name || "this church"} has not cleared (${rec.status}). Come back once it has.`, 409);
  return page(`Start monthly billing for ${rec.church?.name || "this church"}?`,
    `Pick the day the campaign launched. Month 1 is included, so the first ${dollars(rec.monthly_amount)} charge lands 30 days after launch, at noon Central, on the card or bank account they paid with. ${rec.months}-month partnership.`,
    200, { action: "/founding/start", fields: { session: rec.session_id, t: rec.start_token }, date: { name: "launch", label: "Launch date" }, button: "Start monthly billing" });
}

async function startMonthly(request, env) {
  const form = new URLSearchParams((await request.text()).slice(0, 2000));
  const rec = await startRecord(env, form.get("session"), form.get("t"));
  if (!rec) return page("Not found", "That link does not match a founding partner.", 404);
  if (rec.subscription?.id) return page("Already started", startedText(env, rec));
  if (rec.status !== "paid") return page("Not paid yet", `The $3,500 for ${rec.church?.name || "this church"} has not cleared (${rec.status}).`, 409);
  if (!stripeReady(env)) return page("Stripe is not set up", "STRIPE_SECRET_KEY is not set on the worker.", 503);
  const launch = String(form.get("launch") || "");
  let sub;
  try {
    sub = await createMonthly(env, rec, launch);
  } catch (err) {
    console.error(`founding start ${rec.session_id}: ${errText(err)}`);
    if (err?.user) return page("Check the date", err.message, 400, { action: "/founding/start", fields: { session: rec.session_id, t: rec.start_token }, date: { name: "launch", label: "Launch date", value: launch }, button: "Start monthly billing" });
    return page("Not started", `Stripe did not start the subscription: ${errText(err).slice(0, 200)}. Try again, or set it up in the Stripe dashboard.`, 502);
  }
  const saved = await updateRecord(env, rec.session_id, (r) => ({ ...r, subscription: { id: sub.id, trial_end: sub.trial_end, launch, started_at: nowIso() } }));
  await env.AUDITS.put(`founding:subscription:${sub.id}`, rec.session_id);
  const date = longDate(sub.trial_end, tz(env));
  try {
    await runNotice(env, directStep, {
      kind: "started", id: `started-${rec.session_id}`, session_id: rec.session_id, church: rec.church?.name, clickup_task_id: saved?.clickup_task_id || rec.clickup_task_id || "",
      message: `Monthly billing starts ${date} at ${dollars(rec.monthly_amount)}`,
    });
  } catch (err) {
    console.error(`founding start notice: ${errText(err)}`);
  }
  return page("Monthly billing is set", `${rec.church?.name || "The church"}: monthly billing starts ${date} at ${dollars(rec.monthly_amount)}. Stripe subscription ${sub.id}.${sub.existing ? " It was already set up, so nothing new was made." : ""}`);
}

// A small HTML page for Chris. form = { action, fields, date?: { name, label, value? }, button }.
function page(title, text, status = 200, form = null) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const date = form?.date ? `<label for="d">${esc(form.date.label)}</label><input id="d" type="date" name="${esc(form.date.name)}" required value="${esc(form.date.value || "")}">` : "";
  const formHtml = form ? `<form method="post" action="${esc(form.action)}">${Object.entries(form.fields).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("")}${date}<button type="submit">${esc(form.button)}</button></form>` : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;background:#131318;color:#e4e1e9;margin:0;padding:40px 16px}main{max-width:560px;margin:0 auto}h1{color:#eff88b;font-size:28px;margin:0 0 12px}p{overflow-wrap:anywhere}label{display:block;font-weight:600;margin:16px 0 6px}input[type=date]{font:17px system-ui,sans-serif;padding:10px;border-radius:8px;border:1px solid #555;background:#1d1d24;color:#e4e1e9}button{display:block;font:600 17px/1 system-ui,sans-serif;background:#eff88b;color:#131318;border:0;border-radius:10px;padding:14px 22px;margin-top:16px;cursor:pointer}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(text)}</p>${formHtml}</main></body></html>`;
  return new Response(html, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
