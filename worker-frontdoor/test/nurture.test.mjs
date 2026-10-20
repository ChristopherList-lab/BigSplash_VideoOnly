// The follow-up Workflow: send windows, stop reasons, consent, and no double sends on replay.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { stubFetch, fakeKV } from "./spec-helpers.mjs";
import { fakeGhl, GHL_ENV, replayStep } from "./ghl-fake.mjs";
import { FrontDoorNurture, sendTime, plan } from "../src/nurture.js";
import worker from "../src/worker.js";

const TZ = "America/Chicago";
const Z = (iso) => Date.parse(iso);
// Tuesday, October 20, 2026, 10:00 AM Central (CDT, UTC-5).
const TUE_10AM = Z("2026-10-20T15:00:00Z");
// Saturday, October 24, 2026, 7:30 PM Central.
const SAT_730PM = Z("2026-10-25T00:30:00Z");

const params = (x = {}) => ({
  id: "city-reach-church-1a2b3c4d", contactId: "ghl-contact-1", firstName: "Pat", church: "City Reach Church", grade: "B",
  topFix: "Add Sunday service times to Google", scorecardUrl: "https://bigsplash.video/front-door/?id=city-reach-church-1a2b3c4d",
  walkthroughUrl: "https://bigsplash.video/frontdoor/walkthrough/?id=city-reach-church-1a2b3c4d", smsConsent: true, startedAt: TUE_10AM, ...x,
});
const env = (x = {}) => ({ ...GHL_ENV, AUDITS: fakeKV(), TIMEZONE: TZ, ...x });

async function run(e, p = params(), step = replayStep()) {
  await new FrontDoorNurture({}, e).run({ payload: p, instanceId: `nurture-${p.id}` }, step);
  return { step, log: JSON.parse(e.AUDITS.m.get(`nurture:${p.id}`) || "null") };
}

describe("send windows", () => {
  test("inside the window, a time stays as it is", () => {
    assert.equal(sendTime(TUE_10AM, "email", TZ), TUE_10AM);
    assert.equal(sendTime(TUE_10AM, "sms", TZ), TUE_10AM);
  });

  test("Sunday moves to Monday at the window's start", () => {
    const sunNoon = Z("2026-10-25T17:00:00Z");
    assert.equal(sendTime(sunNoon, "email", TZ), Z("2026-10-26T13:00:00Z"), "Monday 8 AM CDT");
    assert.equal(sendTime(sunNoon, "sms", TZ), Z("2026-10-26T15:00:00Z"), "Monday 10 AM CDT");
  });

  test("before the window waits for it; after it moves to the next day", () => {
    const tue830 = Z("2026-10-20T13:30:00Z");
    assert.equal(sendTime(tue830, "email", TZ), tue830);
    assert.equal(sendTime(tue830, "sms", TZ), Z("2026-10-20T15:00:00Z"), "texts wait for 10 AM Central, 8 AM Pacific");
    const tue915 = Z("2026-10-20T14:15:00Z");
    assert.equal(sendTime(tue915, "sms", TZ), Z("2026-10-20T15:00:00Z"), "9:15 AM Central is 7:15 AM Pacific");
    const tue630pm = Z("2026-10-20T23:30:00Z");
    assert.equal(sendTime(tue630pm, "email", TZ), Z("2026-10-21T13:00:00Z"), "emails stop at 6 PM");
    assert.equal(sendTime(tue630pm, "sms", TZ), tue630pm, "texts run until 7 PM");
    const tue5am = Z("2026-10-20T10:00:00Z");
    assert.equal(sendTime(tue5am, "email", TZ), Z("2026-10-20T13:00:00Z"));
  });

  test("Saturday evening skips Sunday; the clock change on Nov 1 is handled", () => {
    const at = plan(SAT_730PM, { smsConsent: true, tz: TZ });
    assert.deepEqual(at.map((s) => [s.key, new Date(s.at).toISOString()]), [
      ["email 2", "2026-10-26T13:00:00.000Z"], // Sunday 7:30 PM -> Monday 8 AM CDT
      ["text 2", "2026-10-27T15:00:00.000Z"], // Monday 7:30 PM -> Tuesday 10 AM
      ["email 3", "2026-10-29T13:00:00.000Z"], // Wednesday 7:30 PM -> Thursday 8 AM
      ["email 4", "2026-11-02T14:00:00.000Z"], // Saturday 7:30 PM -> Monday 8 AM CST
    ]);
    for (const s of at) assert.notEqual(new Date(s.at - 6 * 3600000).getUTCDay(), 0, "never a Sunday in Central time");
  });

  test("no consent leaves text 2 out of the plan", () => {
    assert.deepEqual(plan(TUE_10AM, { smsConsent: false, tz: TZ }).map((s) => s.key), ["email 2", "email 3", "email 4"]);
  });
});

describe("the run", () => {
  test("sends email 2, text 2, email 3 and email 4 in order, each after its sleep", async () => {
    const g = fakeGhl();
    stubFetch([g.route]);
    const e = env();
    const { step, log } = await run(e);
    assert.deepEqual(g.emails.map((m) => m.subject), ["The fix I'd start with at City Reach Church", "Before you book: the 30-minute call with our team", "Last note on your scorecard"]);
    assert.equal(g.texts.length, 1);
    assert.match(g.texts[0].message, /^Pat, Chris at Big Splash\./);
    assert.ok(g.emails.every((m) => m.contactId === "ghl-contact-1" && m.type === "Email" && m.html && m.message));
    assert.deepEqual(step.sleeps.map((s) => [s.name, new Date(s.at).toISOString()]), [
      ["wait for email 2", "2026-10-21T15:00:00.000Z"], ["wait for text 2", "2026-10-22T15:00:00.000Z"],
      ["wait for email 3", "2026-10-24T15:00:00.000Z"], ["wait for email 4", "2026-10-27T15:00:00.000Z"],
    ]);
    // Each wait comes before its check, and each check before its send.
    const order = step.order.filter((n) => /^(wait for|check before|send) /.test(n));
    assert.deepEqual(order, ["email 2", "text 2", "email 3", "email 4"].flatMap((k) => [`wait for ${k}`, `check before ${k}`, `send ${k}`]));
    assert.deepEqual(log.events.filter((x) => x.sent).map((x) => x.sent), ["email 2", "text 2", "email 3", "email 4"]);
    assert.equal(log.done, true);
  });

  test("a replayed run never sends twice", async () => {
    const g = fakeGhl();
    stubFetch([g.route]);
    const e = env();
    const step = replayStep();
    await run(e, params(), step);
    const first = g.sent().length;
    await run(e, params(), step);
    await run(e, params(), step);
    assert.equal(first, 4);
    assert.equal(g.sent().length, 4);
  });

  test("no consent: no text, emails still go", async () => {
    const g = fakeGhl();
    stubFetch([g.route]);
    const { log, step } = await run(env(), params({ smsConsent: false }));
    assert.equal(g.texts.length, 0);
    assert.equal(g.emails.length, 3);
    assert.equal(step.names.some((n) => /text 2/.test(n)), false);
    assert.ok(log.events.some((x) => x.skipped === "text 2" && x.reason === "no text consent"));
  });

  test("no top fix skips email 2 and sends the rest", async () => {
    const g = fakeGhl();
    stubFetch([g.route]);
    const { log } = await run(env(), params({ topFix: "" }));
    assert.deepEqual(g.emails.map((m) => m.subject), ["Before you book: the 30-minute call with our team", "Last note on your scorecard"]);
    assert.ok(log.events.some((x) => x.skipped === "email 2" && x.reason === "no top fix"));
  });

  const stops = [
    ["booked a call", { events: [{ id: "a1", appointmentStatus: "confirmed" }] }],
    ["replied", { messages: [{ direction: "inbound", dateAdded: "2026-10-20T20:00:00.000Z", body: "Thanks Chris" }] }],
    ["Do Not Disturb is on", { contact: { dnd: true } }],
    ["email Do Not Disturb is on", { contact: { dndSettings: { Email: { status: "active" } } } }],
    ["tagged fd-stop", { contact: { tags: ["front-door-audit", "fd-stop"] } }],
  ];
  for (const [reason, opts] of stops) {
    test(`stops before email 2 when the pastor ${reason}`, async () => {
      const g = fakeGhl(opts);
      stubFetch([g.route]);
      const { log, step } = await run(env());
      assert.equal(g.sent().length, 0);
      assert.equal(log.stopped, reason);
      assert.equal(step.sleeps.length, 1, "no more waits after the stop");
    });
  }

  test("an email reply of 'Stop' tags fd-stop, so a later audit's follow-ups stop before email 2", async () => {
    const g = fakeGhl({ messages: [{ direction: "inbound", dateAdded: "2026-10-20T20:00:00.000Z", body: "Stop" }] });
    stubFetch([g.route]);
    const e = env();
    const { log } = await run(e);
    assert.equal(g.sent().length, 0);
    assert.equal(log.stopped, "asked to stop");
    assert.deepEqual(g.tags, [{ id: "ghl-contact-1", tags: ["fd-stop"] }]);
    // GoHighLevel now has the tag. A new audit a week later starts a new run with a later start time.
    g.contact.tags = ["front-door-audit", "fd-stop"];
    g.messages.length = 0;
    const later = params({ id: "city-reach-church-9z8y7x6w", startedAt: TUE_10AM + 7 * 86400000 });
    const second = await run(e, later);
    assert.equal(g.sent().length, 0);
    assert.equal(second.log.stopped, "tagged fd-stop");
  });

  test("a send whose marker is already in KV does not go out again", async () => {
    const g = fakeGhl();
    stubFetch([g.route]);
    const e = env();
    await e.AUDITS.put(`sent:${params().id}:email2`, "2026-10-21T15:00:01.000Z");
    await run(e);
    assert.deepEqual(g.emails.map((m) => m.subject), ["Before you book: the 30-minute call with our team", "Last note on your scorecard"]);
    assert.ok(e.AUDITS.m.has(`sent:${params().id}:text2`) && e.AUDITS.m.has(`sent:${params().id}:email4`));
  });

  test("text 1 handed over by a late approval waits for 8 AM Central, then text 2 follows it", async () => {
    const g = fakeGhl();
    stubFetch([g.route]);
    // Approved Tuesday 10:30 PM Central.
    const late = Z("2026-10-21T03:30:00Z");
    const { step, log } = await run(env(), params({ text1: true, startedAt: late }));
    assert.deepEqual(step.sleeps.slice(0, 1).map((s) => [s.name, new Date(s.at).toISOString()]), [["wait for text 1", "2026-10-21T13:00:00.000Z"]]);
    assert.equal(g.texts.length, 2);
    assert.equal(g.texts[0].message, `Pat, Chris at Big Splash. Your scorecard: ${params().scorecardUrl} Reply STOP to opt out`);
    assert.match(g.texts[1].message, /^Pat, Chris at Big Splash\. Book a call with our team: /);
    assert.deepEqual(log.events.filter((x) => x.sent).map((x) => x.sent), ["text 1", "email 2", "text 2", "email 3", "email 4"]);
  });

  test("text 2 never goes when text 1 did not", async () => {
    const g = fakeGhl({ fail: [[/^POST \/conversations\/messages$/, 400, 1]] });
    stubFetch([g.route]);
    const { log } = await run(env(), params({ text1: true }));
    assert.equal(g.texts.length, 0);
    assert.equal(g.emails.length, 3);
    assert.ok(log.events.some((x) => x.failed === "text 1"));
    assert.ok(log.events.some((x) => x.skipped === "text 2" && x.reason === "text 1 did not go out"));
  });

  test("a reply from before the audit does not stop the follow-ups", async () => {
    const g = fakeGhl({ messages: [{ direction: "inbound", dateAdded: "2026-10-01T15:00:00.000Z" }] });
    stubFetch([g.route]);
    await run(env());
    assert.equal(g.sent().length, 4);
  });

  test("a booking after email 3 stops email 4", async () => {
    const g = fakeGhl();
    stubFetch([g.route]);
    const e = env();
    const step = replayStep();
    const real = step.do.bind(step);
    step.do = async (name, a, b) => {
      if (name === "check before email 4") g.events.push({ id: "a1", appointmentStatus: "booked" });
      return real(name, a, b);
    };
    const { log } = await run(e, params(), step);
    assert.equal(g.emails.length, 2);
    assert.equal(log.stopped, "booked a call");
  });

  test("text Do Not Disturb skips only the text", async () => {
    const g = fakeGhl({ contact: { dndSettings: { SMS: { status: "active" } } } });
    stubFetch([g.route]);
    const { log } = await run(env());
    assert.equal(g.texts.length, 0);
    assert.equal(g.emails.length, 3);
    assert.ok(log.events.some((x) => x.skipped === "text 2" && /Do Not Disturb/.test(x.reason)));
  });

  test("no GHL_TOKEN stops cleanly with nothing sent and no request made", async () => {
    const g = fakeGhl();
    const calls = stubFetch([g.route]);
    const { log } = await run(env({ GHL_TOKEN: undefined }));
    assert.equal(calls.length, 0);
    assert.equal(log.stopped, "GHL_TOKEN is not set");
  });

  test("a check that keeps failing skips that message instead of sending blind", async () => {
    const g = fakeGhl({ fail: [[/^GET \/contacts\/ghl-contact-1$/, 500, 2]] });
    stubFetch([g.route]);
    const { log } = await run(env());
    assert.deepEqual(g.emails.map((m) => m.subject).length, 2, "email 2 skipped, email 3 and 4 sent");
    assert.ok(log.events.some((x) => x.skipped === "email 2" && x.reason === "the stop check failed"));
  });

  test("a failed send is logged and the run goes on", async () => {
    const g = fakeGhl({ fail: [[/^POST \/conversations\/messages$/, 400, 1]] });
    stubFetch([g.route]);
    const { log } = await run(env());
    assert.ok(log.events.some((x) => x.failed === "email 2"));
    assert.equal(g.sent().length, 3);
  });

  test("the video line appears only when VSL_LIVE is set", async () => {
    let g = fakeGhl();
    stubFetch([g.route]);
    await run(env());
    assert.equal(/3-minute video/.test(g.emails[0].message), false);
    g = fakeGhl();
    stubFetch([g.route]);
    await run(env({ VSL_LIVE: "yes" }));
    assert.match(g.emails[0].message, /3-minute video/);
  });
});

describe("GET /nurture", () => {
  test("token-protected, no-store, returns the log", async () => {
    const e = env();
    const token = "f".repeat(32);
    await e.AUDITS.put("audit:x-nurture1", JSON.stringify({ status: "ready", reviewToken: token, ghl: { contactId: "c1", emailed: true } }));
    await e.AUDITS.put("nurture:x-nurture1", JSON.stringify({ id: "x-nurture1", events: [{ sent: "email 2" }] }));
    const get = (q) => worker.fetch(new Request(`https://w.example/nurture?${q}`), e);
    assert.equal((await get("id=x-nurture1")).status, 404);
    assert.equal((await get(`id=x-nurture1&t=${"0".repeat(32)}`)).status, 404);
    const res = await get(`id=x-nurture1&t=${token}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const body = await res.json();
    assert.deepEqual(body.nurture.events, [{ sent: "email 2" }]);
    assert.equal(body.ghl.emailed, true);
    assert.equal(JSON.stringify(body).includes(token), false);
  });

  test("the public result never carries the delivery or follow-up details", async () => {
    const e = env();
    await e.AUDITS.put("audit:x-public1", JSON.stringify({ status: "ready", reviewToken: "a".repeat(32), result: { scores: {} }, ghl: { contactId: "c1" }, desk: { ready: { clickup: { id: "cu1" } } } }));
    const body = await (await worker.fetch(new Request("https://w.example/result?id=x-public1"), e)).text();
    assert.equal(/contactId|clickup|nurture/.test(body), false);
  });
});
