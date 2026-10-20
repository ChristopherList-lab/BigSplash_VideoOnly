// A small GoHighLevel API v2 client: the contact, a note, an optional opportunity, the emails and texts,
// and the checks that stop the follow-ups. Paths, headers and fields follow the HighLevel API docs
// (marketplace.gohighlevel.com/docs and the highlevel-api-docs OpenAPI files).
// Needs env.GHL_TOKEN (a Private Integration token) and env.GHL_LOCATION_ID. Every function throws on
// failure; callers catch. Error messages never carry the token.

const BASE = "https://services.leadconnectorhq.com";
// The Version header each API group documents.
const V_CONTACTS = "2021-07-28"; // contacts, locations, opportunities
const V_CONVERSATIONS = "2021-04-15";
const TIMEOUT = 15000;
const MAX_WAIT = 10000;
const FIELD_KEYS = ["contact.audit_scorecard_url", "contact.audit_walkthrough_url"];
const FIELD_TTL = 60 * 60 * 24;
const SENT_TTL = 60 * 60 * 24 * 30;
const DEFAULT_FROM = "Chris List <chris@bigsplash.agency>";

export const ghlReady = (env) => Boolean(env?.GHL_TOKEN && env?.GHL_LOCATION_ID);

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry-After in seconds or as a date, capped at 10 s. One second when the header is missing.
export function retryDelay(res) {
  const h = res.headers.get("retry-after");
  if (h === null || h === "") return 1000;
  const secs = Number(h);
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(h) - Date.now();
  return Math.min(MAX_WAIT, Math.max(0, Number.isFinite(ms) ? ms : 1000));
}

// One request. A 429 or 5xx gets one retry after Retry-After. Returns the parsed JSON body.
// retry "429" retries only a 429: a send that got a 5xx may have gone out, and a second try could double it.
async function call(env, method, path, { version = V_CONTACTS, query, body, retry = "all" } = {}) {
  if (!ghlReady(env)) throw new Error("GoHighLevel is not set up (GHL_TOKEN or GHL_LOCATION_ID missing)");
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  const init = () => ({
    method,
    headers: { Authorization: `Bearer ${env.GHL_TOKEN}`, Version: version, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  let res = await fetch(url.href, init());
  if (res.status === 429 || (retry === "all" && res.status >= 500)) {
    await wait(retryDelay(res));
    res = await fetch(url.href, init());
  }
  const text = await res.text();
  if (!res.ok) {
    const detail = text.replace(/\s+/g, " ").slice(0, 200).split(env.GHL_TOKEN).join("[token]");
    throw Object.assign(new Error(`GoHighLevel ${method} ${path} answered ${res.status}: ${detail}`), { status: res.status });
  }
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

// "Pastor Pat Rivera" -> Pat / Rivera. A title on its own stays as the first name.
const TITLES = /^(pastor|pr\.?|rev\.?|reverend|dr\.?|mr\.?|mrs\.?|ms\.?|elder|bishop|father|fr\.?)$/i;
export function splitName(full) {
  const parts = String(full || "").trim().split(/\s+/).filter(Boolean);
  while (parts.length > 1 && TITLES.test(parts[0])) parts.shift();
  return { firstName: parts[0] || "", lastName: parts.slice(1).join(" ") };
}

// A US number in E.164 (+1 and ten digits), or null for anything that does not parse as one.
export function usPhone(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (s.startsWith("+") && !s.startsWith("+1")) return null;
  let d = s.replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  return /^[2-9]\d{2}[2-9]\d{6}$/.test(d) ? `+1${d}` : null;
}

export function contactTags({ grade, smsConsent, extra = [] } = {}) {
  const tags = ["front-door-audit"];
  const g = String(grade || "").trim().charAt(0).toLowerCase();
  if (/^[a-f]$/.test(g)) tags.push(`fd-grade-${g}`);
  if (smsConsent) tags.push("fd-texts-ok");
  return [...tags, ...extra];
}

// fieldKey -> id for the two audit fields, from the location's custom fields, cached in KV for a day.
export async function customFieldIds(env) {
  const key = `ghl:fields:${env.GHL_LOCATION_ID}`;
  try {
    const cached = await env.AUDITS?.get(key, "json");
    if (cached && typeof cached === "object") return cached;
  } catch {}
  const data = await call(env, "GET", `/locations/${encodeURIComponent(env.GHL_LOCATION_ID)}/customFields`, { query: { model: "contact" } });
  const ids = {};
  for (const f of data?.customFields || []) if (FIELD_KEYS.includes(f?.fieldKey) && f.id) ids[f.fieldKey] = f.id;
  try { await env.AUDITS?.put(key, JSON.stringify(ids), { expirationTtl: FIELD_TTL }); } catch {}
  return ids;
}

// Creates or updates the contact, then adds the tags. Upsert's own tags field replaces every tag on the
// contact (per the docs), which would wipe tags like fd-stop, so tags go through the Add Tags endpoint.
// lead = { name, email, phone, church, website, tags, scorecardUrl, walkthroughUrl }
export async function upsertContact(env, lead) {
  const { firstName, lastName } = splitName(lead.name);
  const body = { locationId: env.GHL_LOCATION_ID, email: lead.email, source: "Front Door Audit" };
  if (firstName) body.firstName = firstName;
  if (lastName) body.lastName = lastName;
  const phone = usPhone(lead.phone);
  if (phone) body.phone = phone;
  if (lead.church) body.companyName = lead.church;
  if (lead.website) body.website = lead.website;

  const values = { "contact.audit_scorecard_url": lead.scorecardUrl, "contact.audit_walkthrough_url": lead.walkthroughUrl };
  let ids = {};
  try { ids = await customFieldIds(env); } catch (err) { console.error(`GoHighLevel custom fields: ${err.message}`); }
  const fields = FIELD_KEYS.filter((k) => ids[k] && values[k]).map((k) => ({ id: ids[k], field_value: values[k] }));
  if (fields.length) body.customFields = fields;

  const data = await call(env, "POST", "/contacts/upsert", { body });
  const contactId = data?.contact?.id;
  if (!contactId) throw new Error("GoHighLevel upsert sent back no contact id");
  if (lead.tags?.length) await addTags(env, contactId, lead.tags);
  return { contactId, isNew: data.new === true, phone: Boolean(phone) };
}

export async function addTags(env, contactId, tags) {
  return call(env, "POST", `/contacts/${encodeURIComponent(contactId)}/tags`, { body: { tags } });
}

export async function addNote(env, contactId, text) {
  const data = await call(env, "POST", `/contacts/${encodeURIComponent(contactId)}/notes`, { body: { body: String(text).slice(0, 5000) } });
  return { noteId: data?.note?.id || null };
}

// Only when GHL_PIPELINE_ID is set. The stage is GHL_PIPELINE_STAGE_ID, or the pipeline's first stage.
export async function createOpportunity(env, { contactId, name }) {
  if (!env.GHL_PIPELINE_ID) return null;
  let stage = env.GHL_PIPELINE_STAGE_ID;
  if (!stage) {
    const data = await call(env, "GET", "/opportunities/pipelines", { query: { locationId: env.GHL_LOCATION_ID } });
    const pipeline = (data?.pipelines || []).find((p) => p?.id === env.GHL_PIPELINE_ID);
    stage = pipeline?.stages?.[0]?.id;
    if (!stage) throw new Error("GoHighLevel pipeline GHL_PIPELINE_ID has no stages, or was not found");
  }
  const data = await call(env, "POST", "/opportunities/", {
    body: { pipelineId: env.GHL_PIPELINE_ID, locationId: env.GHL_LOCATION_ID, name: String(name).slice(0, 200), pipelineStageId: stage, status: "open", contactId },
  });
  return { opportunityId: data?.opportunity?.id || data?.id || null };
}

// Email from Chris. html is the message; text goes in message, the plain text the API takes alongside it.
export async function sendEmail(env, { contactId, subject, html, text }) {
  const data = await call(env, "POST", "/conversations/messages", {
    version: V_CONVERSATIONS,
    body: { type: "Email", contactId, subject, html, message: text, emailFrom: env.GHL_EMAIL_FROM || DEFAULT_FROM },
    retry: "429",
  });
  return { messageId: data?.messageId || null, conversationId: data?.conversationId || null };
}

// A text from the location's default number to the contact's phone.
export async function sendSms(env, { contactId, message }) {
  const data = await call(env, "POST", "/conversations/messages", { version: V_CONVERSATIONS, body: { type: "SMS", contactId, message }, retry: "429" });
  return { messageId: data?.messageId || null, conversationId: data?.conversationId || null };
}

// ---------- Stop checks ----------

export async function getContact(env, contactId) {
  const data = await call(env, "GET", `/contacts/${encodeURIComponent(contactId)}`);
  return data?.contact || {};
}

// Do Not Disturb: { all, email, sms }. "active" and "permanent" both block a channel.
export function isDnd(contact) {
  const on = (ch) => ["active", "permanent"].includes(String(contact?.dndSettings?.[ch]?.status || "").toLowerCase());
  const all = contact?.dnd === true;
  return { all, email: all || on("Email"), sms: all || on("SMS") };
}

export function hasTag(contact, tag) {
  return (contact?.tags || []).some((t) => String(t).toLowerCase() === tag.toLowerCase());
}

// Any appointment that was not cancelled counts as booked.
export async function hasAppointment(env, contactId) {
  const data = await call(env, "GET", `/contacts/${encodeURIComponent(contactId)}/appointments`);
  return (data?.events || []).some((e) => {
    const s = String(e?.appointmentStatus || e?.status || "").toLowerCase();
    return e && e.deleted !== true && !["cancelled", "canceled", "invalid"].includes(s);
  });
}

// A reply that opens with one of these words asks Chris to stop.
const OPT_OUT = /^\s*(stop|unsubscribe|remove me|opt out|quit|cancel|end)\b/i;
const plainBody = (m) => String(m?.body || "").replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ");

// { replied, optOut }: whether the contact sent any inbound message (email, text, call) at or after
// `since` (ms), and whether one of those asked to stop.
export async function hasInboundReplySince(env, contactId, since) {
  const out = { replied: false, optOut: false };
  const found = await call(env, "GET", "/conversations/search", { version: V_CONVERSATIONS, query: { locationId: env.GHL_LOCATION_ID, contactId, limit: 10 } });
  for (const c of (found?.conversations || []).slice(0, 5)) {
    if (!c?.id) continue;
    const data = await call(env, "GET", `/conversations/${encodeURIComponent(c.id)}/messages`, { version: V_CONVERSATIONS, query: { limit: 50 } });
    // The docs put the list at "messages"; a nested messages.messages is read too, in case the live API wraps it.
    const list = Array.isArray(data?.messages) ? data.messages : Array.isArray(data?.messages?.messages) ? data.messages.messages : [];
    const replies = list.filter((m) => m?.direction === "inbound" && Date.parse(m.dateAdded) >= since);
    if (replies.length) out.replied = true;
    if (replies.some((m) => OPT_OUT.test(plainBody(m)))) out.optOut = true;
  }
  return out;
}

// Sends at most once per key (sent:<audit id>:<message>), even when a step or an approve runs again.
export async function sendOnce(env, key, send) {
  try { if (await env.AUDITS.get(key)) return true; } catch {}
  await send();
  try { await env.AUDITS.put(key, new Date().toISOString(), { expirationTtl: SENT_TTL }); } catch {}
  return true;
}
