// After an audit is saved: the GoHighLevel contact and note, the pastor's first email and text, the
// follow-up Workflow, and the LeadDesk call that opens the ClickUp task and posts Slack.
// event "ready" and "approved" message the pastor. "review" and "failed" never do: the contact lands in
// GoHighLevel with a tag (fd-held, fd-failed) and the desk tells Chris.
// Each piece runs as its own step and is caught on its own, so a GoHighLevel or desk failure never
// undoes a saved scorecard. Returns { ghl: { contactId, emailed, texted, textLater?, nurture }, desk }.
import * as ghl from "./ghl.js";
import { scorecardEmail, approvedEmail, scorecardText } from "./messages.js";
import { inWindow } from "./nurture.js";

export const SCORECARD = "https://bigsplash.video/front-door/?id=";
export const WALKTHROUGH = "https://bigsplash.video/frontdoor/walkthrough/?id=";
const STEP = { retries: { limit: 2, delay: "10 seconds", backoff: "exponential" }, timeout: "2 minutes" };
// Messages are tried once per step (the client retries only a 429), so an unclear failure never doubles.
const ONCE = { retries: { limit: 0, delay: "10 seconds" }, timeout: "1 minute" };
const AREAS = ["google", "reviews", "website", "social"];

// For a call outside a Workflow (the approve link): runs each callback once.
export const directStep = { do: async (name, a, b) => (typeof a === "function" ? a : b)() };

const errText = (err) => String(err?.message || err).slice(0, 300);

async function guard(step, name, opts, fn, fallback) {
  try {
    return await step.do(name, opts, fn);
  } catch (err) {
    console.error(`${name} failed: ${errText(err)}`);
    return fallback;
  }
}

export function messageVars(env, { id, church, contact, result }) {
  return {
    firstName: ghl.splitName(contact?.name).firstName,
    church: church?.name || "",
    grade: result?.scores?.overall?.grade || "",
    topFix: result?.notes?.fixes?.[0]?.title || "",
    scorecardUrl: SCORECARD + id,
    walkthroughUrl: WALKTHROUGH + id,
    videoLive: Boolean(env.VSL_LIVE),
    address: env.BUSINESS_ADDRESS,
  };
}

// What LeadDesk expects (see worker-churchsnapshot/desk.js cleanLead).
export function leadPayload(a, delivery = {}) {
  const r = a.result || {};
  const c = a.contact || {};
  const grades = { overall: r.scores?.overall?.grade ?? null };
  for (const k of AREAS) grades[k] = r.scores?.areas?.[k]?.grade ?? null;
  const live = a.event === "ready" || a.event === "approved";
  return {
    event: a.event,
    id: a.id,
    scorecard_url: live ? SCORECARD + a.id : "",
    walkthrough_url: live ? WALKTHROUGH + a.id : "",
    preview_url: a.preview_url || "",
    approve_url: a.approve_url || "",
    clickup_task_id: a.clickup_task_id || "",
    church: { name: a.church?.name || "", address: a.church?.address || "", city: a.church?.city || "", website: a.church?.website || "" },
    contact: {
      name: c.name || "", role: c.role || "", email: c.email || "", phone: c.phone || "",
      sms_consent: c.sms_consent === true, attendance: c.attendance || "", facebook_frequency: c.facebook_frequency || "",
    },
    grades,
    fixes: (r.notes?.fixes || []).slice(0, 3).map((f) => ({ title: f?.title || "", why: f?.why || "" })),
    households: r.reach?.households ?? null,
    review_reasons: a.event === "review" ? r.reviewReasons || [] : [],
    possible_duplicates: r.possibleDuplicates || [],
    utm: c.utm && typeof c.utm === "object" ? c.utm : {},
    page_url: c.page_url || "",
    submitted_at: a.record?.created || new Date().toISOString(),
    error: a.error || "",
    emailed: delivery.emailed === true,
    texted: delivery.texted === true,
  };
}

const STATUS = { ready: "Scorecard sent automatically", approved: "Approved by Chris and sent", review: "Held for Chris's review, nothing sent to the pastor", failed: "Audit failed, nothing sent to the pastor", repeat: "Asked again for an audit that already ran" };

// Everything about the lead, in plain text, for the GoHighLevel contact note.
export function noteText(a) {
  const l = leadPayload(a);
  const c = l.contact;
  const g = l.grades;
  const utm = Object.entries(l.utm).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(", ");
  const lines = [
    `Front Door Audit: ${STATUS[a.event] || a.event}`,
    `Church: ${l.church.name || "not given"}`,
    `Address: ${l.church.address || "not given"}`,
    `Website: ${l.church.website || "none"}`,
    `Contact: ${c.name || "no name"}${c.role ? ` (${c.role})` : ""}`,
    `Email: ${c.email || "not given"}`,
    `Cell: ${c.phone || "not given"} (texts OK: ${c.sms_consent ? "yes" : "no"})`,
    `Sunday attendance: ${c.attendance || "not given"}`,
    `Posts on Facebook: ${c.facebook_frequency || "not given"}`,
    `Grades: overall ${g.overall || "not graded"}, Google ${g.google || "not checked"}, reviews ${g.reviews || "not checked"}, website ${g.website || "not checked"}, social ${g.social || "not checked"}`,
  ];
  l.fixes.forEach((f, i) => lines.push(`Fix ${i + 1}: ${f.title}${f.why ? `. ${f.why}` : ""}`));
  if (l.households !== null) lines.push(`Households within 5 miles: ${Number(l.households).toLocaleString("en-US")}`);
  if (a.event === "review") lines.push(...(a.result?.reviewReasons || []).map((r) => `Held because: ${r}`));
  if (a.error) lines.push(`Error: ${a.error}`);
  if (a.event !== "failed") lines.push(`Scorecard: ${SCORECARD + a.id}`, `Walkthrough: ${WALKTHROUGH + a.id}`);
  if (a.earlier) lines.push(`Earlier audit: ${SCORECARD + a.earlier}`);
  lines.push(`Came from: ${utm || "no campaign tags"}`);
  if (l.page_url) lines.push(`Page: ${l.page_url}`);
  lines.push(`Audit id: ${a.id}`);
  return lines.join("\n");
}

const EXTRA_TAG = { review: ["fd-held"], failed: ["fd-failed"], repeat: ["fd-repeat"] };

// The contact and note in GoHighLevel. Returns the contact id, or null.
export async function ghlContact(env, step, a) {
  if (!ghl.ghlReady(env)) { console.error("GoHighLevel skipped: GHL_TOKEN or GHL_LOCATION_ID is not set"); return null; }
  if (!a.contact?.email) { console.error(`GoHighLevel skipped for ${a.id}: no email address`); return null; }
  const p = `${a.event} ghl`;
  const up = await guard(step, `${p} contact`, STEP, () => ghl.upsertContact(env, {
    name: a.contact.name, email: a.contact.email, phone: a.contact.phone, church: a.church?.name, website: a.church?.website,
    tags: ghl.contactTags({ grade: a.result?.scores?.overall?.grade, smsConsent: a.contact.sms_consent === true, extra: EXTRA_TAG[a.event] || [] }),
    scorecardUrl: SCORECARD + (a.earlier || a.id), walkthroughUrl: WALKTHROUGH + (a.earlier || a.id),
  }), null);
  if (!up?.contactId) return null;
  await guard(step, `${p} note`, ONCE, () => ghl.addNote(env, up.contactId, noteText(a)), null);
  if (env.GHL_PIPELINE_ID && (a.event === "ready" || a.event === "review")) {
    await guard(step, `${p} opportunity`, ONCE, () => ghl.createOpportunity(env, { contactId: up.contactId, name: `${a.church?.name || "Church"} Front Door` }), null);
  }
  return up.contactId;
}

// a = { event, id, record, church, contact, result, error?, preview_url?, approve_url?, clickup_task_id? }
// Text 1 goes right away for a fresh audit, since the pastor just asked for it. An approved audit
// texts right away only inside the text window; otherwise the follow-up run sends text 1 when it opens.
export async function deliver(env, step, a) {
  // out.textLater (set only when true): text 1 waits for the text window in the follow-up run.
  const out = { contactId: null, emailed: false, texted: false, nurture: false };
  out.contactId = await ghlContact(env, step, a);
  const live = a.event === "ready" || a.event === "approved";

  if (live && out.contactId) {
    const v = messageVars(env, a);
    const email = a.event === "approved" ? approvedEmail(v) : scorecardEmail(v);
    out.emailed = await guard(step, `${a.event} email 1`, ONCE, () => ghl.sendOnce(env, `sent:${a.id}:email1`, () =>
      ghl.sendEmail(env, { contactId: out.contactId, subject: email.subject, html: email.html, text: email.text })), false);
    const textsOk = a.contact?.sms_consent === true && Boolean(ghl.usPhone(a.contact.phone));
    const textNow = textsOk && (a.event === "ready" ||
      await guard(step, `${a.event} text window`, ONCE, async () => inWindow(Date.now(), "sms", env.TIMEZONE || "America/Chicago"), true));
    if (textNow) {
      out.texted = await guard(step, `${a.event} text 1`, ONCE, () => ghl.sendOnce(env, `sent:${a.id}:text1`, () =>
        ghl.sendSms(env, { contactId: out.contactId, message: scorecardText(v).message })), false);
    } else if (textsOk && env.NURTURE_FLOW && out.emailed) {
      out.textLater = true;
    }
    // Follow-ups only after the scorecard email went out: they point back to it.
    if (env.NURTURE_FLOW && out.emailed) {
      out.nurture = await guard(step, `${a.event} start follow-ups`, STEP, async () => {
        const params = { id: a.id, contactId: out.contactId, firstName: v.firstName, church: v.church, grade: v.grade, topFix: v.topFix,
          // Text 2 only follows a text 1 that went out (or will, from the follow-up run).
          scorecardUrl: v.scorecardUrl, walkthroughUrl: v.walkthroughUrl, smsConsent: textsOk && Boolean(out.texted || out.textLater),
          ...(out.textLater ? { text1: true } : {}), startedAt: Date.now() };
        try {
          await env.NURTURE_FLOW.create({ id: `nurture-${a.id}`, params });
        } catch (err) {
          // A second create for the same audit is a no-op.
          if (!/already|exist|duplicate/i.test(errText(err))) throw err;
        }
        return true;
      }, false);
    }
    if (!out.nurture) delete out.textLater;
  }

  let desk = null;
  if (env.DESK) {
    desk = await guard(step, `${a.event} desk`, STEP, async () => {
      const r = await env.DESK.frontDoorLead(leadPayload(a, out));
      // Keep only what the record needs, as plain data.
      return { clickup: { ok: Boolean(r?.clickup?.ok), id: r?.clickup?.id || null, url: r?.clickup?.url || null }, slack: { ok: Boolean(r?.slack?.ok) } };
    }, null);
  }
  return { ghl: out, desk };
}
