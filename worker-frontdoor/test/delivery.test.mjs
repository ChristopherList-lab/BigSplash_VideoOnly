// After the audit: GoHighLevel, the pastor's first messages, the follow-ups and LeadDesk, for each outcome.
// The audit step is stubbed so these tests stay about delivery. Every outside call hits a fake.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { stubFetch, fakeEnv, json } from "./spec-helpers.mjs";
import { fakeGhl, GHL_ENV, replayStep } from "./ghl-fake.mjs";
import worker, { FrontDoorAudit, FrontDoorApprove, parseUtm } from "../src/worker.js";

const ORIGIN = "https://bigsplash.video";
const BASE = "https://bigsplash-front-door.test.workers.dev";
const SLACK = "https://hooks.slack.test/T000/B000/fallback";
const pending = [];
const ctx = { waitUntil(p) { pending.push(p); }, passThroughOnException() {} };
const form = (x = {}) => ({ church: "City Reach Church", address: "2700 W Whitestone Blvd, Cedar Park, TX 78613", website: "cityreachchurch.com", name: "Pastor Pat Rivera",
  role: "Lead pastor", email: "pat@cityreach.example", phone: "(512) 555-0142", attendance: "250 to 499", sms_consent: "yes", facebook_frequency: "About once a week",
  page_url: "https://bigsplash.video/frontdoor/", utm: "utm_source=facebook&utm_medium=paid&utm_campaign=fd-launch&utm_content=video-a", hp_x7: "", ...x });

const READY = {
  needsReview: false, reviewReasons: [], possibleDuplicates: [],
  scores: { overall: { grade: "B" }, areas: { google: { grade: "A" }, reviews: { grade: "C" }, website: { grade: "B" }, social: { grade: null } } },
  notes: { fixes: [{ title: "Add Sunday service times to Google", why: "Families look on Saturday night." }, { title: "Answer your reviews", why: "Nine have no reply." }] },
  reach: { households: 12400 },
};
const REVIEW = { ...READY, needsReview: true, reviewReasons: ["No Google listing came up for this church's name and address."], possibleDuplicates: [{ name: "City Reach", address: "3501 Hatch Rd", reviewCount: 12 }] };

function fakeDesk({ throws = false, slackOk = true } = {}) {
  const leads = [];
  return {
    leads,
    async frontDoorLead(lead) {
      leads.push(JSON.parse(JSON.stringify(lead)));
      if (throws) throw new Error("desk is down");
      return { clickup: { ok: true, id: "cu-1", url: "https://app.clickup.com/t/cu-1" }, slack: { ok: slackOk } };
    },
  };
}

// Runs fn with Date.now fixed at iso, for the text window. Tuesday Oct 20, 2026, 11 AM Central by default.
async function atClock(fn, iso = "2026-10-20T16:00:00Z") {
  const real = Date.now;
  const at = Date.parse(iso);
  Date.now = () => at;
  try { return await fn(); } finally { Date.now = real; }
}
function fakeNurture({ duplicate = false } = {}) {
  const made = [];
  return { made, async create(o) { if (duplicate && made.length) throw new Error("instance.already_exists"); made.push(o); return { id: o.id }; } };
}

function setup({ ghlOpts, env: extra = {}, desk = fakeDesk(), nurture = fakeNurture(), slack = [] } = {}) {
  const g = fakeGhl(ghlOpts);
  const calls = stubFetch([g.route, [SLACK, (c) => { slack.push(c.json().text); return new Response("ok"); }]]);
  const e = fakeEnv({ ...GHL_ENV, DESK: desk, NURTURE_FLOW: nurture, WORKER_ORIGIN: BASE, SLACK_WEBHOOK_URL: SLACK, ...extra });
  return { g, e, desk, nurture, slack, calls };
}

const post = (e, body) => worker.fetch(new Request(`${BASE}/audit`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": "203.0.113.9" }, body: JSON.stringify(body) }), e, ctx);
const get = (e, path) => worker.fetch(new Request(BASE + path), e, ctx);
// Chris's button on the confirm page: a form POST with the id and token.
const approveIt = (e, id, t) => worker.fetch(new Request(`${BASE}/approve`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ id, t }).toString() }), e, ctx);

// Intake, then the Workflow with the audit step answering `result` (or throwing).
async function audit(e, result = READY, { body = form(), step = replayStep(), fail = null } = {}) {
  const r = await (await post(e, body)).json();
  const flow = e.flows.at(-1);
  const real = step.do.bind(step);
  step.do = async (name, a, b) => {
    if (name === "audit") { if (fail) throw fail; return JSON.parse(JSON.stringify(result)); }
    return real(name, a, b);
  };
  await new FrontDoorAudit({}, e).run({ payload: flow.params, instanceId: flow.id }, step);
  return { id: r.id, step, record: () => JSON.parse(e.AUDITS.m.get(`audit:${r.id}`)) };
}

describe("intake", () => {
  test("attendance, text consent and campaign tags reach the private contact record", async () => {
    const { e } = setup();
    const r = await (await post(e, form())).json();
    const c = JSON.parse(e.AUDITS.m.get(`contact:${r.id}`));
    assert.equal(c.attendance, "250 to 499");
    assert.equal(c.sms_consent, true);
    assert.deepEqual(c.utm, { source: "facebook", medium: "paid", campaign: "fd-launch", content: "video-a" });
    assert.deepEqual(e.flows[0].params.contact.utm, c.utm);
  });

  test("an attendance outside the five choices is dropped", async () => {
    const { e } = setup();
    for (const [attendance, want] of [["1,000+", "1,000+"], ["Under 100", "Under 100"], ["About 300", undefined], ["<b>500</b>", undefined]]) {
      const r = await (await post(e, form({ attendance, website: `site${Math.random().toString(36).slice(2, 8)}.org` }))).json();
      assert.equal(JSON.parse(e.AUDITS.m.get(`contact:${r.id}`)).attendance, want, attendance);
    }
  });

  test("text consent is true only for 'yes' with a phone number", async () => {
    const { e } = setup();
    for (const [x, want] of [[{ sms_consent: "yes" }, true], [{ sms_consent: "YES" }, true], [{ sms_consent: "on" }, false], [{ sms_consent: undefined }, false], [{ sms_consent: "yes", phone: "" }, false]]) {
      const r = await (await post(e, form({ ...x, website: `site${Math.random().toString(36).slice(2, 8)}.org` }))).json();
      assert.equal(JSON.parse(e.AUDITS.m.get(`contact:${r.id}`)).sms_consent, want, JSON.stringify(x));
    }
  });

  test("parseUtm reads the landing page's query string and caps each value", () => {
    assert.deepEqual(parseUtm("utm_source=facebook&utm_campaign=fd%20launch"), { source: "facebook", medium: "", campaign: "fd launch", content: "" });
    assert.deepEqual(parseUtm("?utm_content=" + "x".repeat(300)).content.length, 100);
    assert.deepEqual(parseUtm(""), { source: "", medium: "", campaign: "", content: "" });
    assert.deepEqual(parseUtm(undefined), { source: "", medium: "", campaign: "", content: "" });
  });

  test("health reports ghl, desk, nurture and the Slack fallback", async () => {
    const { e } = setup();
    const h = await (await get(e, "/health")).json();
    assert.deepEqual({ ghl: h.ghl, desk: h.desk, nurture: h.nurture, slack_fallback: h.slack_fallback, storage: h.storage }, { ghl: true, desk: true, nurture: true, slack_fallback: true, storage: true });
    assert.equal("slack" in h, false);
    const bare = await (await get(fakeEnv(), "/health")).json();
    assert.deepEqual([bare.ghl, bare.desk, bare.nurture], [false, false, false]);
  });
});

describe("ready", () => {
  test("GoHighLevel contact and note, email 1, text 1, follow-ups, then the desk", async () => {
    const { g, e, desk, nurture, slack } = setup();
    const { id, record } = await audit(e);
    assert.equal(g.upserts.length, 1);
    assert.equal(g.upserts[0].firstName, "Pat");
    assert.equal(g.upserts[0].companyName, "City Reach Church");
    assert.deepEqual(g.tags[0].tags, ["front-door-audit", "fd-grade-b", "fd-texts-ok"]);
    assert.equal(g.notes.length, 1);
    for (const bit of ["City Reach Church", "pat@cityreach.example", "250 to 499", "texts OK: yes", "overall B", "Add Sunday service times to Google", "12,400", "source facebook", `Audit id: ${id}`]) assert.ok(g.notes[0].body.includes(bit), bit);
    assert.equal(g.emails.length, 1);
    assert.equal(g.emails[0].subject, "Front Door scorecard for City Reach Church");
    assert.match(g.emails[0].message, new RegExp(`https://bigsplash\\.video/frontdoor/walkthrough/\\?id=${id}`));
    assert.equal(g.texts.length, 1);
    assert.equal(g.texts[0].message, `Pat, Chris at Big Splash. Your scorecard: https://bigsplash.video/front-door/?id=${id} Reply STOP to opt out`);

    assert.equal(nurture.made.length, 1);
    assert.equal(nurture.made[0].id, `nurture-${id}`);
    const p = nurture.made[0].params;
    assert.deepEqual({ ...p, startedAt: typeof p.startedAt }, {
      id, contactId: "ghl-contact-1", firstName: "Pat", church: "City Reach Church", grade: "B", topFix: "Add Sunday service times to Google",
      scorecardUrl: `https://bigsplash.video/front-door/?id=${id}`, walkthroughUrl: `https://bigsplash.video/frontdoor/walkthrough/?id=${id}`, smsConsent: true, startedAt: "number",
    });

    assert.equal(desk.leads.length, 1);
    const l = desk.leads[0];
    assert.equal(l.event, "ready");
    assert.equal(l.walkthrough_url, `https://bigsplash.video/frontdoor/walkthrough/?id=${id}`);
    assert.equal(l.scorecard_url, `https://bigsplash.video/front-door/?id=${id}`);
    assert.deepEqual([l.emailed, l.texted], [true, true]);
    assert.deepEqual(l.grades, { overall: "B", google: "A", reviews: "C", website: "B", social: null });
    assert.deepEqual(l.contact, { name: "Pastor Pat Rivera", role: "Lead pastor", email: "pat@cityreach.example", phone: "(512) 555-0142", sms_consent: true, attendance: "250 to 499", facebook_frequency: "About once a week" });
    assert.deepEqual(l.utm, { source: "facebook", medium: "paid", campaign: "fd-launch", content: "video-a" });
    assert.equal(l.households, 12400);
    assert.equal(l.fixes.length, 2);
    assert.equal(l.preview_url, "");

    assert.equal(slack.length, 0, "the desk posts Slack, not the worker");
    const rec = record();
    assert.equal(rec.status, "ready");
    assert.deepEqual(rec.ghl, { contactId: "ghl-contact-1", emailed: true, texted: true, nurture: true });
    assert.equal(rec.desk.ready.clickup.id, "cu-1");
    const pub = await (await get(e, `/result?id=${id}`)).text();
    assert.equal(/cu-1|ghl-contact-1|emailed/.test(pub), false, "delivery details stay private");
  });

  test("no consent: no text and the follow-ups know it", async () => {
    const { g, e, nurture, desk } = setup();
    await audit(e, READY, { body: form({ sms_consent: "" }) });
    assert.equal(g.texts.length, 0);
    assert.equal(g.emails.length, 1);
    assert.equal(nurture.made[0].params.smsConsent, false);
    assert.deepEqual([desk.leads[0].emailed, desk.leads[0].texted], [true, false]);
    assert.equal(g.tags[0].tags.includes("fd-texts-ok"), false);
  });

  test("a replayed Workflow sends nothing twice and starts the follow-ups once", async () => {
    const { g, e, nurture, desk } = setup({ nurture: fakeNurture({ duplicate: true }) });
    const step = replayStep();
    const { record } = await audit(e, READY, { step });
    const flow = e.flows.at(-1);
    await new FrontDoorAudit({}, e).run({ payload: flow.params, instanceId: flow.id }, step);
    assert.deepEqual([g.emails.length, g.texts.length, g.notes.length, nurture.made.length, desk.leads.length], [1, 1, 1, 1, 1]);
    assert.equal(record().ghl.emailed, true);
  });

  test("a duplicate follow-up start counts as started", async () => {
    const nurture = { made: [], async create() { throw new Error("instance.already_exists: nurture-x"); } };
    const { e } = setup({ nurture });
    const { record } = await audit(e);
    assert.equal(record().ghl.nurture, true);
  });

  test("an email that fails: scorecard still saved, desk told the pastor was not emailed, no follow-ups", async () => {
    const { g, e, nurture, desk } = setup({ ghlOpts: { fail: [[/^POST \/conversations\/messages$/, 500]] } });
    const { record } = await audit(e);
    assert.equal(record().status, "ready");
    assert.equal(g.emails.length, 0);
    assert.equal(desk.leads[0].emailed, false);
    assert.equal(nurture.made.length, 0);
    assert.equal(record().ghl.emailed, false);
  });

  test("GoHighLevel down entirely: no contact, no messages, desk still told", async () => {
    const { e, desk, nurture } = setup({ ghlOpts: { fail: [[/./, new TypeError("fetch failed")]] } });
    const { record } = await audit(e);
    assert.equal(record().status, "ready");
    assert.equal(desk.leads[0].emailed, false);
    assert.equal(nurture.made.length, 0);
  });

  test("a desk that throws never undoes the scorecard", async () => {
    const { e, g } = setup({ desk: fakeDesk({ throws: true }) });
    const { record } = await audit(e);
    assert.equal(record().status, "ready");
    assert.equal(record().ghl.emailed, true);
    assert.equal(g.emails.length, 1);
  });

  test("an opportunity opens only when GHL_PIPELINE_ID is set", async () => {
    let s = setup();
    await audit(s.e);
    assert.equal(s.g.opportunities.length, 0);
    s = setup({ env: { GHL_PIPELINE_ID: "pipe-1" } });
    await audit(s.e);
    assert.equal(s.g.opportunities.length, 1);
    assert.equal(s.g.opportunities[0].pipelineStageId, "stage-new");
  });
});

describe("no GHL_TOKEN", () => {
  test("every GoHighLevel step skips; the desk hears the pastor was not emailed", async () => {
    const { e, desk, nurture, calls } = setup({ env: { GHL_TOKEN: undefined } });
    const { record } = await audit(e);
    assert.equal(calls.filter((c) => c.url.includes("leadconnectorhq")).length, 0);
    assert.equal(record().status, "ready");
    assert.deepEqual([desk.leads[0].emailed, desk.leads[0].texted], [false, false]);
    assert.equal(nurture.made.length, 0);
  });

  test("approve says no email went out", async () => {
    const { e } = setup({ env: { GHL_TOKEN: undefined } });
    const { id, record } = await audit(e, REVIEW);
    const page = await (await approveIt(e, id, record().reviewToken)).text();
    assert.match(page, /GHL_TOKEN is not set, so no email went out/);
  });
});

describe("review and approve", () => {
  test("held: contact in GoHighLevel tagged fd-held with a note, no messages, desk gets preview and approve links", async () => {
    const { g, e, desk, nurture } = setup();
    const { id, record } = await audit(e, REVIEW);
    const token = record().reviewToken;
    assert.equal(record().status, "review");
    assert.equal(g.sent().length, 0, "a held pastor gets nothing");
    assert.ok(g.tags[0].tags.includes("fd-held"));
    assert.match(g.notes[0].body, /Held because: No Google listing came up/);
    assert.equal(nurture.made.length, 0);
    const l = desk.leads[0];
    assert.equal(l.event, "review");
    assert.equal(l.preview_url, `https://bigsplash.video/front-door/?id=${id}&t=${token}`);
    assert.equal(l.approve_url, `${BASE}/approve?id=${id}&t=${token}`);
    assert.equal(l.scorecard_url, "");
    assert.deepEqual(l.review_reasons, REVIEW.reviewReasons);
    assert.equal(l.possible_duplicates.length, 1);
    assert.deepEqual([l.emailed, l.texted], [false, false]);
    assert.equal(record().desk.review.clickup.id, "cu-1");
  });

  test("approve: the sorry-for-the-wait email, text 1, follow-ups and the desk with the task id", async () => {
    const { g, e, desk, nurture } = setup();
    const { id, record } = await audit(e, REVIEW);
    const res = await atClock(() => approveIt(e, id, record().reviewToken));
    assert.equal(res.status, 200);
    const page = await res.text();
    assert.match(page, /is approved and the scorecard is live/);
    assert.match(page, /sorry for the wait&quot; email and the scorecard text\. The follow-ups have started\./);
    assert.equal(g.emails.length, 1);
    assert.equal(g.emails[0].subject, "Your Front Door scorecard (sorry for the wait)");
    assert.equal(g.texts.length, 1);
    assert.equal(nurture.made[0].id, `nurture-${id}`);
    const l = desk.leads.at(-1);
    assert.deepEqual([l.event, l.clickup_task_id, l.emailed, l.texted], ["approved", "cu-1", true, true]);
    assert.equal(record().status, "ready");
    assert.deepEqual(Object.keys(record().desk).sort(), ["approved", "review"]);
    // A second click sends nothing more.
    assert.match(await (await approveIt(e, id, record().reviewToken)).text(), /already approved/);
    assert.equal(g.sent().length, 2);
  });

  test("two approvals racing past the status check still send one email", async () => {
    const { g, e } = setup();
    const { id, record } = await audit(e, REVIEW);
    const rec = record();
    await atClock(() => approveIt(e, id, rec.reviewToken));
    await e.AUDITS.put(`audit:${id}`, JSON.stringify({ ...rec, status: "review" }));
    await atClock(() => approveIt(e, id, rec.reviewToken));
    assert.equal(g.emails.length, 1);
    assert.equal(g.texts.length, 1);
  });
});

describe("the approve link", () => {
  test("a GET only shows a confirm page: nothing changes and nothing is sent, so a link scanner cannot approve", async () => {
    const { g, e, desk } = setup();
    const { id, record } = await audit(e, REVIEW);
    const t = record().reviewToken;
    const before = g.calls.length;
    for (let i = 0; i < 3; i++) {
      const res = await get(e, `/approve?id=${id}&t=${t}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      const html = await res.text();
      assert.match(html, /<form method="post" action="\/approve">/);
      assert.ok(html.includes(`name="id" value="${id}"`) && html.includes(`name="t" value="${t}"`));
      assert.match(html, /Approve and send/);
    }
    assert.equal(record().status, "review");
    assert.equal(g.calls.length, before);
    assert.equal(desk.leads.length, 1);
    assert.equal((await get(e, `/approve?id=${id}&t=${"0".repeat(32)}`)).status, 404);
    assert.equal((await approveIt(e, id, "0".repeat(32))).status, 404);
    assert.equal(record().status, "review");
  });

  test("with the approve Workflow bound: one instance per audit, a second tap says already approved, and the run sends once", async () => {
    const made = [];
    const flow = { async create(o) { if (made.some((m) => m.id === o.id)) throw new Error("instance.already_exists"); made.push(o); return { id: o.id }; } };
    const { g, e, desk, nurture } = setup({ env: { APPROVE_FLOW: flow } });
    const { id, record } = await audit(e, REVIEW);
    const t = record().reviewToken;
    const res = await approveIt(e, id, t);
    assert.match(await res.text(), /is approved and the scorecard is going live/);
    // Both taps land before the run starts: the second one finds the instance already there.
    assert.match(await (await approveIt(e, id, t)).text(), /already approved/);
    assert.deepEqual(made, [{ id: `approve-${id}`, params: { id } }]);
    assert.equal(g.sent().length, 0, "the request itself sends nothing");

    const step = replayStep();
    await atClock(() => new FrontDoorApprove({}, e).run({ payload: made[0].params, instanceId: made[0].id }, step));
    await atClock(() => new FrontDoorApprove({}, e).run({ payload: made[0].params, instanceId: made[0].id }, step));
    assert.equal(record().status, "ready");
    assert.deepEqual([g.emails.length, g.texts.length, nurture.made.length], [1, 1, 1]);
    assert.equal(g.emails[0].subject, "Your Front Door scorecard (sorry for the wait)");
    assert.deepEqual([desk.leads.at(-1).event, desk.leads.at(-1).emailed], ["approved", true]);
    assert.equal(record().ghl.emailed, true);
    assert.match(await (await approveIt(e, id, t)).text(), /already approved/);
  });

  test("approved at 10:30 PM: the email goes now, text 1 waits for the follow-up run's text window", async () => {
    const { g, e, desk, nurture } = setup();
    const { id, record } = await audit(e, REVIEW);
    const page = await (await atClock(() => approveIt(e, id, record().reviewToken), "2026-10-21T03:30:00Z")).text();
    assert.equal(g.emails.length, 1);
    assert.equal(g.texts.length, 0);
    assert.match(page, /The scorecard text goes out when the text window opens\./);
    const p = nurture.made[0].params;
    assert.deepEqual([p.text1, p.smsConsent], [true, true]);
    assert.deepEqual([desk.leads.at(-1).emailed, desk.leads.at(-1).texted], [true, false]);
    assert.equal(record().ghl.textLater, true);
  });

  test("approved at 9:34 AM: the scorecard text goes right away, with the desk told", async () => {
    const { g, e, desk } = setup();
    const { id, record } = await audit(e, REVIEW);
    await atClock(() => approveIt(e, id, record().reviewToken), "2026-10-20T14:34:00Z");
    assert.equal(g.texts.length, 1);
    assert.deepEqual([desk.leads.at(-1).texted, desk.leads.at(-1).text_later], [true, false]);
  });

  test("approved at 10:30 PM: the desk hears the text is queued", async () => {
    const { e, desk } = setup();
    const { id, record } = await audit(e, REVIEW);
    await atClock(() => approveIt(e, id, record().reviewToken), "2026-10-21T03:30:00Z");
    assert.deepEqual([desk.leads.at(-1).texted, desk.leads.at(-1).text_later], [false, true]);
  });

  test("text 1 that failed: the follow-ups send no text 2", async () => {
    const { g, e, nurture, desk } = setup();
    const real = globalThis.fetch;
    globalThis.fetch = async (input, init = {}) => (String(input).endsWith("/conversations/messages") && JSON.parse(init.body).type === "SMS"
      ? new Response('{"message":"bad number"}', { status: 400 }) : real(input, init));
    try { await audit(e); } finally { globalThis.fetch = real; }
    assert.deepEqual([g.emails.length, g.texts.length], [1, 0]);
    assert.equal(nurture.made[0].params.smsConsent, false);
    assert.equal("text1" in nurture.made[0].params, false);
    assert.deepEqual([desk.leads[0].emailed, desk.leads[0].texted], [true, false]);
  });
});

describe("desk failures reach Slack directly", () => {
  for (const [label, desk] of [["the desk throws", () => fakeDesk({ throws: true })], ["the desk's Slack post fails", () => fakeDesk({ slackOk: false })]]) {
    test(`${label}: a held audit's approve link still reaches Slack`, async () => {
      const slack = [];
      const { e } = setup({ desk: desk(), slack });
      const { id, record } = await audit(e, REVIEW);
      assert.equal(slack.length, 1);
      assert.ok(slack[0].includes(`${BASE}/approve?id=${id}&t=${record().reviewToken}`), slack[0]);
      assert.match(slack[0], /Front Door Audit needs your review/);
      assert.match(slack[0], label === "the desk throws" ? /LeadDesk did not reach Slack or ClickUp/ : /LeadDesk did not post Slack\. ClickUp: https:\/\/app\.clickup\.com\/t\/cu-1/);
    });

    test(`${label}: a failed audit and an approval reach Slack`, async () => {
      let slack = [];
      let s = setup({ desk: desk(), slack });
      await audit(s.e, READY, { fail: new Error("Places quota exceeded") });
      assert.ok(slack.some((t) => /Front Door Audit failed/.test(t) && /Places quota exceeded/.test(t)), slack.join("\n---\n"));
      slack = [];
      s = setup({ desk: desk(), slack });
      const { id, record } = await audit(s.e, REVIEW);
      slack.length = 0;
      await atClock(() => approveIt(s.e, id, record().reviewToken));
      assert.ok(slack.some((t) => /Front Door Audit approved/.test(t) && /Emailed the pastor/.test(t)), slack.join("\n---\n"));
    });
  }

  test("a desk that posted Slack gets no second post from the worker", async () => {
    const slack = [];
    const { e } = setup({ slack });
    await audit(e, REVIEW);
    await audit(e, READY, { body: form({ website: "otherchurch.org", church: "Other Church" }) });
    assert.equal(slack.length, 0);
  });
});

describe("the audit run cannot start", () => {
  test("the record is marked failed, the desk hears, no site marker is left, and a retry starts a fresh audit", async () => {
    const { e, desk } = setup();
    const create = e.AUDIT_FLOW.create;
    e.AUDIT_FLOW.create = async () => { throw new Error("Workflows is unavailable"); };
    const res = await post(e, form());
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.match(body.error, /did not start\. Try again in a minute, or email chris@bigsplash\.agency/);
    await Promise.all(pending);
    const failed = [...e.AUDITS.m.entries()].filter(([k, v]) => k.startsWith("audit:") && JSON.parse(v).status === "failed");
    assert.equal(failed.length, 1);
    assert.match(JSON.parse(failed[0][1]).error, /could not start: Workflows is unavailable/);
    assert.equal([...e.AUDITS.m.keys()].some((k) => k.startsWith("site:")), false);
    assert.deepEqual([desk.leads.at(-1).event, desk.leads.at(-1).contact.email], ["failed", "pat@cityreach.example"]);

    e.AUDIT_FLOW.create = create;
    const again = await (await post(e, form())).json();
    assert.equal(again.ok, true);
    assert.notEqual(`audit:${again.id}`, failed[0][0]);
    assert.equal(e.flows.length, 1);
  });

  test("a 'running' audit older than 30 minutes is treated as dead", async () => {
    const { e } = setup();
    const a = await (await post(e, form())).json();
    const rec = JSON.parse(e.AUDITS.m.get(`audit:${a.id}`));
    await e.AUDITS.put(`audit:${a.id}`, JSON.stringify({ ...rec, created: new Date(Date.now() - 31 * 60000).toISOString() }));
    const b = await (await post(e, form())).json();
    assert.notEqual(b.id, a.id);
    const c = await (await post(e, form())).json();
    assert.equal(c.id, b.id, "a fresh running audit still dedupes");
    await Promise.all(pending);
  });
});

describe("failed", () => {
  test("contact in GoHighLevel tagged fd-failed, desk told with the error, nobody messaged", async () => {
    const { g, e, desk, nurture } = setup();
    const { record } = await audit(e, READY, { fail: new Error("Places quota exceeded") });
    assert.equal(record().status, "failed");
    assert.equal(g.sent().length, 0);
    assert.ok(g.tags[0].tags.includes("fd-failed"));
    assert.match(g.notes[0].body, /Error: Places quota exceeded/);
    assert.equal(nurture.made.length, 0);
    const l = desk.leads[0];
    assert.equal(l.event, "failed");
    assert.equal(l.error, "Places quota exceeded");
    assert.equal(l.scorecard_url, "");
    assert.equal(l.contact.email, "pat@cityreach.example");
  });
});

describe("no DESK binding: Slack fallback", () => {
  test("ready posts Slack directly and says the pastor was emailed", async () => {
    const slack = [];
    const { e } = setup({ desk: null, slack, env: { DESK: undefined } });
    await audit(e);
    assert.equal(slack.length, 1);
    assert.match(slack[0], /Front Door Audit ready/);
    assert.match(slack[0], /Emailed the pastor through GoHighLevel and texted the scorecard\./);
  });

  test("without GHL_TOKEN the fallback says the pastor was not emailed", async () => {
    const slack = [];
    const { e } = setup({ desk: null, slack, env: { DESK: undefined, GHL_TOKEN: undefined } });
    await audit(e);
    assert.match(slack[0], /The pastor was not emailed\. Send the scorecard link by hand\./);
  });

  test("approve and failed also reach Slack", async () => {
    let slack = [];
    let s = setup({ desk: null, slack, env: { DESK: undefined } });
    const { id, record } = await audit(s.e, REVIEW);
    await approveIt(s.e, id, record().reviewToken);
    assert.ok(slack.some((t) => /Front Door Audit approved/.test(t) && /Emailed the pastor/.test(t)), slack.join("\n---\n"));
    slack = [];
    s = setup({ desk: null, slack, env: { DESK: undefined } });
    await audit(s.e, READY, { fail: new Error("boom") });
    assert.ok(slack.some((t) => /Front Door Audit failed/.test(t)));
  });
});

describe("a repeat request", () => {
  test("desk bound, no GHL_TOKEN: the contact is saved in KV and Slack hears about it", async () => {
    const { e, slack } = setup({ env: { GHL_TOKEN: undefined } });
    const a = await (await post(e, form())).json();
    await post(e, form({ name: "Sam Lee", email: "sam@cityreach.example", phone: "(512) 555-0199", role: "Worship pastor" }));
    await Promise.all(pending);
    const saved = [...e.AUDITS.m.entries()].filter(([k]) => k.startsWith(`contact:${a.id}:repeat:`));
    assert.equal(saved.length, 1);
    assert.deepEqual([JSON.parse(saved[0][1]).email, JSON.parse(saved[0][1]).role], ["sam@cityreach.example", "Worship pastor"]);
    assert.equal(slack.length, 1);
    assert.match(slack[0], /Front Door Audit asked again/);
    assert.match(slack[0], /sam@cityreach\.example/);
    assert.match(slack[0], /GHL_TOKEN is not set/);
  });

  test("desk bound, GoHighLevel down: Slack hears about it", async () => {
    const { e, slack } = setup({ ghlOpts: { fail: [[/./, new TypeError("fetch failed")]] } });
    await post(e, form());
    await post(e, form({ name: "Sam Lee", email: "sam@cityreach.example" }));
    await Promise.all(pending);
    assert.equal(slack.length, 1);
    assert.match(slack[0], /GoHighLevel did not take this contact/);
  });

  test("with the desk bound: no Slack from the worker, the new contact lands in GoHighLevel tagged fd-repeat", async () => {
    const { g, e, slack } = setup();
    const a = await (await post(e, form())).json();
    const b = await (await post(e, form({ website: "https://www.cityreachchurch.com/", name: "Sam Lee", email: "sam@cityreach.example" }))).json();
    assert.equal(b.id, a.id);
    await Promise.all(pending);
    assert.equal(slack.length, 0);
    assert.equal(g.upserts.at(-1).email, "sam@cityreach.example");
    assert.ok(g.tags.at(-1).tags.includes("fd-repeat"));
    assert.match(g.notes.at(-1).body, /Asked again/);
    assert.equal(g.sent().length, 0);
  });
});
