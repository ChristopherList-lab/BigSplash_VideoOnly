// The follow-ups after the scorecard email: email 2 at day 1, text 2 at day 2 (with consent), email 3 at
// day 4 and email 4 at day 7. Before each send the contact is checked in GoHighLevel, and the run stops
// once the pastor books, replies, turns on Do Not Disturb or gets the fd-stop tag.
// Sends land in America/Chicago (TIMEZONE) hours: never on Sunday, emails 8 AM to 6 PM, texts 10 AM to 7 PM.
// The text window is 8 AM Pacific to 8 PM Eastern, so it stays inside quiet-hour rules in every continental zone.
// An audit Chris approves outside that window hands text 1 to this run (p.text1), which sends it when the
// window opens. Text 2 goes only after text 1 went out, since text 1 carries the STOP line.
// Each send is its own step with a sent:<id>:<message> marker in KV, so a replayed run never sends twice. What happened is logged in KV under
// nurture:<id> for Chris (GET /nurture?id=&t=<reviewToken>).
import { WorkflowEntrypoint } from "cloudflare:workers";
import * as ghl from "./ghl.js";
import { scorecardText, fixEmail, nudgeText, callEmail, lastEmail } from "./messages.js";

const DAY = 86400000;
const YEAR = 60 * 60 * 24 * 365;
export const WINDOWS = { email: [8, 18], sms: [10, 19] };
export const STEPS = [
  { key: "text 1", day: 0, kind: "sms", build: scorecardText, only: "text1" },
  { key: "email 2", day: 1, kind: "email", build: fixEmail },
  { key: "text 2", day: 2, kind: "sms", build: nudgeText },
  { key: "email 3", day: 4, kind: "email", build: callEmail },
  { key: "email 4", day: 7, kind: "email", build: lastEmail },
];
const CHECK = { retries: { limit: 3, delay: "1 minute", backoff: "exponential" }, timeout: "2 minutes" };
// A send is tried once (the client retries only a 429), so an unclear failure never sends twice.
const ONCE = { retries: { limit: 0, delay: "10 seconds" }, timeout: "1 minute" };

// The wall clock in a time zone: year, month (0-11), day, hour, weekday (0 = Sunday).
function wall(ms, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric", weekday: "short", hourCycle: "h23",
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month - 1, d: +p.day, h: +p.hour % 24, min: +p.minute, s: +p.second, wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}

// The instant the clock in tz reads y-m-d h:00. Two passes settle a daylight saving change.
export function zonedTime(y, m, d, h, tz) {
  const want = Date.UTC(y, m, d, h);
  let guess = want;
  for (let i = 0; i < 2; i++) {
    const p = wall(guess, tz);
    guess += want - Date.UTC(p.y, p.m, p.d, p.h, p.min, p.s);
  }
  return guess;
}

// The first moment at or after `ms` inside the send window for this kind of message.
export function sendTime(ms, kind, tz = "America/Chicago") {
  const [open, close] = WINDOWS[kind] || WINDOWS.email;
  let t = ms;
  for (let i = 0; i < 10; i++) {
    const p = wall(t, tz);
    if (p.wd === 0 || p.h >= close) { t = zonedTime(p.y, p.m, p.d + 1, open, tz); continue; }
    if (p.h < open) return zonedTime(p.y, p.m, p.d, open, tz);
    return t;
  }
  return t;
}

// True when a message of this kind could go out at `ms`.
export const inWindow = (ms, kind, tz) => sendTime(ms, kind, tz) === ms;

// Wake times for every step, in order and never earlier than the step before.
export function plan(startedAt, { smsConsent, text1 = false, tz }) {
  let last = startedAt;
  const out = [];
  for (const s of STEPS) {
    if (s.kind === "sms" && !smsConsent) continue;
    if (s.only === "text1" && !text1) continue;
    last = Math.max(last, sendTime(startedAt + s.day * DAY, s.kind, tz));
    out.push({ key: s.key, kind: s.kind, at: last });
  }
  return out;
}

// Appends one entry to nurture:<id>. Never throws: a log write must not fail a send that went out.
export async function logNurture(env, id, entry) {
  try {
    const key = `nurture:${id}`;
    const log = (await env.AUDITS.get(key, "json")) || { id, events: [] };
    log.events.push({ ...entry, at: new Date().toISOString() });
    if (entry.stopped) log.stopped = entry.stopped;
    if (entry.done) log.done = true;
    await env.AUDITS.put(key, JSON.stringify(log), { expirationTtl: YEAR });
  } catch (err) {
    console.error(`nurture log ${id}: ${err?.message}`);
  }
}

// Why the follow-ups stop: { stop } ends the run, { skip } passes over this one message, null sends it.
export async function stopCheck(env, p, kind) {
  if (!ghl.ghlReady(env)) return { stop: "GHL_TOKEN is not set" };
  if (!p.contactId) return { stop: "no GoHighLevel contact" };
  const contact = await ghl.getContact(env, p.contactId);
  const dnd = ghl.isDnd(contact);
  if (dnd.all) return { stop: "Do Not Disturb is on" };
  if (ghl.hasTag(contact, "fd-stop")) return { stop: "tagged fd-stop" };
  if (await ghl.hasAppointment(env, p.contactId)) return { stop: "booked a call" };
  const reply = await ghl.hasInboundReplySince(env, p.contactId, p.startedAt);
  // "Stop" by email gets the fd-stop tag, so a later audit for this pastor starts no follow-ups either.
  if (reply.optOut) {
    try { await ghl.addTags(env, p.contactId, ["fd-stop"]); } catch (err) { console.error(`fd-stop tag for ${p.id}: ${err?.message}`); }
    return { stop: "asked to stop" };
  }
  if (reply.replied) return { stop: "replied" };
  if (dnd.email && kind === "email") return { stop: "email Do Not Disturb is on" };
  if (dnd.sms && kind === "sms") return { skip: "text Do Not Disturb is on" };
  return null;
}

export class FrontDoorNurture extends WorkflowEntrypoint {
  async run(event, step) {
    const p = event.payload || {};
    const env = this.env;
    const tz = env.TIMEZONE || "America/Chicago";
    const schedule = await step.do("plan", async () => {
      const at = plan(p.startedAt, { smsConsent: p.smsConsent === true, text1: p.text1 === true, tz });
      await logNurture(env, p.id, { planned: at.map((s) => ({ step: s.key, at: new Date(s.at).toISOString() })), ...(p.smsConsent ? {} : { skipped: "text 2", reason: "no text consent" }) });
      return at;
    });

    // Text 2 needs text 1 (and its STOP line) to have gone out. Without p.text1 it went out already.
    let textOneSent = p.text1 !== true;
    for (const s of schedule) {
      if (s.key === "text 2" && !textOneSent) {
        await step.do("log skip text 2", async () => { await logNurture(env, p.id, { skipped: "text 2", reason: "text 1 did not go out" }); return true; });
        continue;
      }
      await step.sleepUntil(`wait for ${s.key}`, new Date(s.at));
      let verdict;
      try {
        verdict = await step.do(`check before ${s.key}`, CHECK, async () => stopCheck(env, p, s.kind));
      } catch (err) {
        // GoHighLevel could not be read: skip this message rather than send blind.
        await step.do(`log check failed ${s.key}`, async () => { await logNurture(env, p.id, { skipped: s.key, reason: "the stop check failed" }); return true; });
        continue;
      }
      if (verdict?.stop) {
        await step.do(`log stop at ${s.key}`, async () => { await logNurture(env, p.id, { stopped: verdict.stop, before: s.key }); return true; });
        return;
      }
      if (verdict?.skip) {
        await step.do(`log skip ${s.key}`, async () => { await logNurture(env, p.id, { skipped: s.key, reason: verdict.skip }); return true; });
        continue;
      }
      try {
        const done = await step.do(`send ${s.key}`, ONCE, async () => {
          const def = STEPS.find((x) => x.key === s.key);
          const msg = def.build({ ...p, videoLive: Boolean(env.VSL_LIVE), address: env.BUSINESS_ADDRESS });
          if (!msg) { await logNurture(env, p.id, { skipped: s.key, reason: "no top fix" }); return "skipped"; }
          // Text 1 shares its marker with deliver.js, so it never goes out from both places.
          await ghl.sendOnce(env, `sent:${p.id}:${s.key.replace(/\s+/g, "")}`, () => (s.kind === "sms"
            ? ghl.sendSms(env, { contactId: p.contactId, message: msg.message })
            : ghl.sendEmail(env, { contactId: p.contactId, subject: msg.subject, html: msg.html, text: msg.text })));
          await logNurture(env, p.id, { sent: s.key });
          return "sent";
        });
        if (s.key === "text 1" && done === "sent") textOneSent = true;
      } catch (err) {
        console.error(`nurture ${p.id} ${s.key} failed: ${err?.message}`);
        await step.do(`log failed ${s.key}`, async () => { await logNurture(env, p.id, { failed: s.key, reason: String(err?.message || err).slice(0, 200) }); return true; });
      }
    }
    await step.do("log done", async () => { await logNurture(env, p.id, { done: true }); return true; });
  }
}
