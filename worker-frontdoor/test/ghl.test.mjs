// The GoHighLevel client: request shapes match the HighLevel API docs, retries and timeouts behave,
// and nothing goes out without a token. All calls hit the fake in ghl-fake.mjs.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { stubFetch, fakeKV, timeouts } from "./spec-helpers.mjs";
import { fakeGhl, GHL_ENV, GHL_BASE } from "./ghl-fake.mjs";
import * as ghl from "../src/ghl.js";

const env = (x = {}) => ({ ...GHL_ENV, AUDITS: fakeKV(), ...x });
const lead = { name: "Pastor Pat Rivera", email: "pat@cityreach.example", phone: "(512) 555-0142", church: "City Reach Church", website: "https://cityreachchurch.com/",
  tags: ghl.contactTags({ grade: "B", smsConsent: true }), scorecardUrl: "https://bigsplash.video/front-door/?id=x-1", walkthroughUrl: "https://bigsplash.video/frontdoor/walkthrough/?id=x-1" };

describe("contact", () => {
  test("upsert posts the documented body with Bearer auth and Version 2021-07-28, then adds tags", async () => {
    const g = fakeGhl();
    stubFetch([g.route]);
    const r = await ghl.upsertContact(env(), lead);
    assert.deepEqual(r, { contactId: "ghl-contact-1", isNew: true, phone: true });
    const up = g.calls.find((c) => c.sig === "POST /contacts/upsert");
    assert.equal(up.url, `${GHL_BASE}/contacts/upsert`);
    assert.equal(up.headers.get("authorization"), "Bearer pit-test-token-not-real");
    assert.equal(up.headers.get("version"), "2021-07-28");
    assert.equal(up.headers.get("content-type"), "application/json");
    assert.deepEqual(up.body, {
      locationId: "f8RUB78GlgA6lIDz8HB8", email: "pat@cityreach.example", source: "Front Door Audit", firstName: "Pat", lastName: "Rivera",
      phone: "+15125550142", companyName: "City Reach Church", website: "https://cityreachchurch.com/",
      customFields: [{ id: "fld-score", field_value: lead.scorecardUrl }, { id: "fld-walk", field_value: lead.walkthroughUrl }],
    });
    assert.equal("tags" in up.body, false, "upsert tags would overwrite every tag on the contact");
    assert.deepEqual(g.tags, [{ id: "ghl-contact-1", tags: ["front-door-audit", "fd-grade-b", "fd-texts-ok"] }]);
    const cf = g.calls.find((c) => c.path.endsWith("/customFields"));
    assert.equal(cf.url, `${GHL_BASE}/locations/f8RUB78GlgA6lIDz8HB8/customFields?model=contact`);
    assert.equal(cf.headers.get("version"), "2021-07-28");
  });

  test("custom field ids are cached in KV for a day", async () => {
    const g = fakeGhl();
    stubFetch([g.route]);
    const e = env();
    await ghl.upsertContact(e, lead);
    await ghl.upsertContact(e, lead);
    assert.equal(g.calls.filter((c) => c.path.endsWith("/customFields")).length, 1);
    assert.deepEqual(JSON.parse(e.AUDITS.m.get("ghl:fields:f8RUB78GlgA6lIDz8HB8")), { "contact.audit_scorecard_url": "fld-score", "contact.audit_walkthrough_url": "fld-walk" });
    assert.equal(e.AUDITS.ttl.get("ghl:fields:f8RUB78GlgA6lIDz8HB8"), 86400);
  });

  test("a custom fields failure still saves the contact, without customFields", async () => {
    const g = fakeGhl({ fail: [[/customFields/, 403]] });
    stubFetch([g.route]);
    await ghl.upsertContact(env(), lead);
    assert.equal("customFields" in g.upserts[0], false);
  });

  test("names, phones and tags", () => {
    assert.deepEqual(ghl.splitName("Pat"), { firstName: "Pat", lastName: "" });
    assert.deepEqual(ghl.splitName("  Rev. Dr. Ana  de la Cruz "), { firstName: "Ana", lastName: "de la Cruz" });
    assert.deepEqual(ghl.splitName("Pastor"), { firstName: "Pastor", lastName: "" });
    assert.deepEqual(ghl.splitName(""), { firstName: "", lastName: "" });
    assert.equal(ghl.usPhone("512-555-0142"), "+15125550142");
    assert.equal(ghl.usPhone("+1 (512) 555 0142"), "+15125550142");
    assert.equal(ghl.usPhone("1.512.555.0142"), "+15125550142");
    for (const bad of ["555-0142", "+44 20 7946 0958", "012-555-0142", "512-055-0142", "", null, "call me"]) assert.equal(ghl.usPhone(bad), null, String(bad));
    assert.deepEqual(ghl.contactTags({ grade: null, smsConsent: false }), ["front-door-audit"]);
    assert.deepEqual(ghl.contactTags({ grade: "A", smsConsent: false, extra: ["fd-held"] }), ["front-door-audit", "fd-grade-a", "fd-held"]);
  });

  test("a phone that is not a US number is left off the contact", async () => {
    const g = fakeGhl();
    stubFetch([g.route]);
    const r = await ghl.upsertContact(env(), { ...lead, phone: "+44 20 7946 0958", name: "" });
    assert.equal("phone" in g.upserts[0], false);
    assert.equal("firstName" in g.upserts[0], false);
    assert.equal(r.phone, false);
  });

  test("note goes to POST /contacts/:id/notes with a body", async () => {
    const g = fakeGhl();
    stubFetch([g.route]);
    await ghl.addNote(env(), "ghl-contact-1", "Church: City Reach");
    const c = g.calls[0];
    assert.equal(c.url, `${GHL_BASE}/contacts/ghl-contact-1/notes`);
    assert.deepEqual(c.body, { body: "Church: City Reach" });
  });
});

describe("opportunity", () => {
  test("skipped without GHL_PIPELINE_ID", async () => {
    const g = fakeGhl();
    stubFetch([g.route]);
    assert.equal(await ghl.createOpportunity(env(), { contactId: "c", name: "X" }), null);
    assert.equal(g.calls.length, 0);
  });

  test("first stage of the pipeline, or GHL_PIPELINE_STAGE_ID", async () => {
    const g = fakeGhl();
    stubFetch([g.route]);
    await ghl.createOpportunity(env({ GHL_PIPELINE_ID: "pipe-1" }), { contactId: "c1", name: "City Reach Front Door" });
    assert.equal(g.calls[0].url, `${GHL_BASE}/opportunities/pipelines?locationId=f8RUB78GlgA6lIDz8HB8`);
    assert.equal(g.calls[1].url, `${GHL_BASE}/opportunities/`);
    assert.deepEqual(g.opportunities[0], { pipelineId: "pipe-1", locationId: "f8RUB78GlgA6lIDz8HB8", name: "City Reach Front Door", pipelineStageId: "stage-new", status: "open", contactId: "c1" });
    await ghl.createOpportunity(env({ GHL_PIPELINE_ID: "pipe-1", GHL_PIPELINE_STAGE_ID: "stage-2" }), { contactId: "c1", name: "Y" });
    assert.equal(g.calls.filter((c) => c.path === "/opportunities/pipelines").length, 1);
    assert.equal(g.opportunities[1].pipelineStageId, "stage-2");
  });
});

describe("messages", () => {
  test("email: POST /conversations/messages, Version 2021-04-15, html plus plain text, emailFrom", async () => {
    const g = fakeGhl();
    stubFetch([g.route]);
    const r = await ghl.sendEmail(env(), { contactId: "c1", subject: "Hi", html: "<p>Hi</p>", text: "Hi" });
    assert.deepEqual(r, { messageId: "msg-1", conversationId: "conv-1" });
    const c = g.calls[0];
    assert.equal(c.url, `${GHL_BASE}/conversations/messages`);
    assert.equal(c.headers.get("version"), "2021-04-15");
    assert.deepEqual(c.body, { type: "Email", contactId: "c1", subject: "Hi", html: "<p>Hi</p>", message: "Hi", emailFrom: "Big Splash <chris@bigsplash.agency>" });
    await ghl.sendEmail(env({ GHL_EMAIL_FROM: "Chris <chris@mail.bigsplash.agency>" }), { contactId: "c1", subject: "Hi", html: "<p>Hi</p>", text: "Hi" });
    assert.equal(g.emails[1].emailFrom, "Chris <chris@mail.bigsplash.agency>");
  });

  test("text: type SMS with the message only", async () => {
    const g = fakeGhl();
    stubFetch([g.route]);
    await ghl.sendSms(env(), { contactId: "c1", message: "Pat, Chris at Big Splash." });
    assert.deepEqual(g.calls[0].body, { type: "SMS", contactId: "c1", message: "Pat, Chris at Big Splash." });
  });
});

describe("retries, timeouts and errors", () => {
  test("a 429 gets one retry after Retry-After; a read retries a 5xx once; a send never retries a 5xx", async () => {
    let g = fakeGhl({ fail: [[/conversations\/messages/, 429, 1]] });
    stubFetch([g.route]);
    await ghl.sendSms(env(), { contactId: "c1", message: "x" });
    assert.equal(g.calls.length, 2);
    assert.equal(g.texts.length, 1);

    g = fakeGhl({ fail: [[/^GET \/contacts\/c1$/, 503]] });
    stubFetch([g.route]);
    await assert.rejects(ghl.getContact(env(), "c1"), /answered 503/);
    assert.equal(g.calls.length, 2, "one retry only");

    // A 5xx after GoHighLevel took the message would send it twice on a retry.
    for (const send of [() => ghl.sendSms(env(), { contactId: "c1", message: "x" }), () => ghl.sendEmail(env(), { contactId: "c1", subject: "s", html: "h", text: "t" })]) {
      g = fakeGhl({ fail: [[/conversations\/messages/, 502]] });
      stubFetch([g.route]);
      await assert.rejects(send(), /answered 502/);
      assert.equal(g.calls.length, 1);
    }
  });

  test("a 4xx is not retried", async () => {
    const g = fakeGhl({ fail: [[/conversations\/messages/, 422]] });
    stubFetch([g.route]);
    await assert.rejects(ghl.sendEmail(env(), { contactId: "c1", subject: "s", html: "h", text: "t" }), /422/);
    assert.equal(g.calls.length, 1);
  });

  test("Retry-After is honored up to 10 seconds", () => {
    const r = (h) => new Response("", { status: 429, headers: h === undefined ? {} : { "retry-after": h } });
    assert.equal(ghl.retryDelay(r("2")), 2000);
    assert.equal(ghl.retryDelay(r("120")), 10000);
    assert.equal(ghl.retryDelay(r()), 1000);
    assert.equal(ghl.retryDelay(r(new Date(Date.now() + 60000).toUTCString())), 10000);
  });

  test("every request carries a 15 s timeout", async () => {
    const g = fakeGhl();
    stubFetch([g.route]);
    timeouts.length = 0;
    await ghl.addNote(env(), "c1", "x");
    assert.deepEqual(timeouts, [15000]);
  });

  test("no token: throws before any request; errors never carry the token", async () => {
    const g = fakeGhl({ fail: [[/notes/, 400]] });
    stubFetch([g.route]);
    await assert.rejects(ghl.addNote({ AUDITS: fakeKV() }, "c1", "x"), /not set up/);
    assert.equal(g.calls.length, 0);
    assert.equal(ghl.ghlReady({ GHL_TOKEN: "x" }), false);
    stubFetch([[() => true, () => new Response(`bad token ${GHL_ENV.GHL_TOKEN}`, { status: 401 })]]);
    const err = await ghl.addNote(env(), "c1", "x").catch((e) => e);
    assert.match(err.message, /401/);
    assert.equal(err.message.includes(GHL_ENV.GHL_TOKEN), false);
  });
});

describe("stop checks", () => {
  test("DND: the contact flag, or Email/SMS settings active or permanent", () => {
    assert.deepEqual(ghl.isDnd({ dnd: true }), { all: true, email: true, sms: true });
    assert.deepEqual(ghl.isDnd({ dnd: false, dndSettings: { Email: { status: "active" }, SMS: { status: "inactive" } } }), { all: false, email: true, sms: false });
    assert.deepEqual(ghl.isDnd({ dndSettings: { SMS: { status: "permanent" } } }), { all: false, email: false, sms: true });
    assert.deepEqual(ghl.isDnd({}), { all: false, email: false, sms: false });
  });

  test("tags match without regard to case", () => {
    assert.equal(ghl.hasTag({ tags: ["FD-Stop"] }, "fd-stop"), true);
    assert.equal(ghl.hasTag({ tags: ["front-door-audit"] }, "fd-stop"), false);
    assert.equal(ghl.hasTag({}, "fd-stop"), false);
  });

  test("appointments: a cancelled one does not count", async () => {
    let g = fakeGhl({ events: [{ id: "e1", appointmentStatus: "cancelled" }] });
    stubFetch([g.route]);
    assert.equal(await ghl.hasAppointment(env(), "c1"), false);
    assert.equal(g.calls[0].url, `${GHL_BASE}/contacts/c1/appointments`);
    g = fakeGhl({ events: [{ id: "e1", appointmentStatus: "cancelled" }, { id: "e2", status: "booked", appointmentStatus: "confirmed" }] });
    stubFetch([g.route]);
    assert.equal(await ghl.hasAppointment(env(), "c1"), true);
  });

  test("replies: only inbound messages at or after the start count", async () => {
    const since = Date.parse("2026-10-20T15:00:00Z");
    let g = fakeGhl({ messages: [{ direction: "outbound", dateAdded: "2026-10-21T15:00:00.000Z" }, { direction: "inbound", dateAdded: "2026-10-19T15:00:00.000Z" }] });
    stubFetch([g.route]);
    assert.deepEqual(await ghl.hasInboundReplySince(env(), "c1", since), { replied: false, optOut: false });
    const search = g.calls[0];
    assert.equal(search.path, "/conversations/search");
    assert.deepEqual(search.query, { locationId: "f8RUB78GlgA6lIDz8HB8", contactId: "c1", limit: "10" });
    assert.equal(search.headers.get("version"), "2021-04-15");
    assert.equal(g.calls[1].path, "/conversations/conv-1/messages");
    g = fakeGhl({ messages: [{ direction: "inbound", dateAdded: "2026-10-21T15:00:00.000Z", body: "Thanks! Can we stop by Tuesday?" }] });
    stubFetch([g.route]);
    assert.deepEqual(await ghl.hasInboundReplySince(env(), "c1", since), { replied: true, optOut: false });
  });

  test("replies: one that opens with stop or unsubscribe is an opt-out, in plain text or HTML", async () => {
    const since = Date.parse("2026-10-20T15:00:00Z");
    for (const body of ["Stop", "  stop please", "<div dir=\"ltr\">STOP</div><div>On Tue, Chris wrote:</div>", "Unsubscribe", "remove me from this list"]) {
      const g = fakeGhl({ messages: [{ direction: "inbound", dateAdded: "2026-10-21T15:00:00.000Z", body }] });
      stubFetch([g.route]);
      assert.deepEqual(await ghl.hasInboundReplySince(env(), "c1", since), { replied: true, optOut: true }, body);
    }
    // A stop from before this run, or one Chris sent, is not this pastor asking now.
    const g = fakeGhl({ messages: [{ direction: "inbound", dateAdded: "2026-10-01T15:00:00.000Z", body: "stop" }, { direction: "outbound", dateAdded: "2026-10-21T15:00:00.000Z", body: "Reply STOP to opt out" }] });
    stubFetch([g.route]);
    assert.deepEqual(await ghl.hasInboundReplySince(env(), "c1", since), { replied: false, optOut: false });
  });

  test("getContact reads GET /contacts/:id", async () => {
    const g = fakeGhl({ contact: { tags: ["fd-stop"] } });
    stubFetch([g.route]);
    const c = await ghl.getContact(env(), "ghl-contact-1");
    assert.deepEqual(c.tags, ["fd-stop"]);
    assert.equal(g.calls[0].headers.get("version"), "2021-07-28");
  });
});
