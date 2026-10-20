// The founding partner checkout: Stripe client and signatures, the routes, the webhook flows, the won
// steps (GoHighLevel, welcome email, LeadDesk) and the start-monthly link. Stripe, GoHighLevel, Slack and
// the desk are all fakes. Nothing here reaches the network.
import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stubFetch, fakeEnv, json } from "./spec-helpers.mjs";
import { fakeGhl, GHL_ENV, replayStep } from "./ghl-fake.mjs";
import { fakeStripe, STRIPE_ENV } from "./stripe-fake.mjs";
import worker, { FoundingFlow } from "../src/worker.js";
import { formEncode, verifySignature, signPayload, stripeCall, STRIPE_VERSION, hmacHex } from "../src/stripe.js";
import { trialEnd, zonedNoon, ensurePrice, wonPayload, agreementNote, foundingBase, runFlow, TERMS } from "../src/founding.js";
import { foundingWelcomeEmail, KICKOFF_URL } from "../src/messages.js";

const BASE = "https://bigsplash-front-door.test.workers.dev";
const VIDEO = "https://bigsplash.video";
const CHURCH_SITE = "https://bigsplash.church";
const SLACK = "https://hooks.slack.test/T000/B000/fallback";
// Wednesday, October 21, 2026, 10 AM Central.
const NOW = Date.parse("2026-10-21T15:00:00Z");
const realNow = Date.now;
beforeEach(() => { Date.now = () => NOW; });
afterEach(() => { Date.now = realNow; });

const pending = [];
const ctx = { waitUntil(p) { pending.push(p); }, passThroughOnException() {} };
const settle = async () => { while (pending.length) await pending.shift(); };

function fakeDesk({ slackOk = true, throws = false } = {}) {
  const calls = [];
  return {
    calls,
    async frontDoorLead(p) {
      calls.push(JSON.parse(JSON.stringify(p)));
      if (throws) throw new Error("desk is down");
      return p.event === "won" ? { clickup: { ok: true, id: "cl-1", url: "https://app.clickup.com/t/cl-1" }, slack: { ok: slackOk } }
        : { clickup: { ok: Boolean(p.clickup_task_id), ...(p.clickup_task_id ? { id: p.clickup_task_id, url: `https://app.clickup.com/t/${p.clickup_task_id}` } : {}) }, slack: { ok: slackOk } };
    },
  };
}

function setup({ env: extra = {}, stripe: sOpts, ghl: gOpts, desk = fakeDesk() } = {}) {
  const st = fakeStripe(sOpts);
  const g = fakeGhl(gOpts);
  const slack = [];
  const calls = stubFetch([st.route, g.route, [SLACK, (c) => { slack.push(c.json().text); return new Response("ok"); }]]);
  const e = fakeEnv({ ...GHL_ENV, ...STRIPE_ENV, DESK: desk, SLACK_WEBHOOK_URL: SLACK, WORKER_ORIGIN: BASE, FOUNDING_LIVE: "yes", FOUNDING_TOTAL: "5", TERMS_VERSION: "2026-10-20",
    BUSINESS_ADDRESS: "1119 Ascot St., Georgetown, TX 78626", ...extra });
  return { st, g, e, desk, slack, calls };
}

const FORM = { church: "City Reach Church", name: "Pastor Pat Rivera", role: "Lead pastor", email: "pat@cityreach.example", phone: "(512) 555-0142",
  website: "cityreachchurch.com", term: "12", agree_terms: true, agree_authorized: true, audit_id: "city-reach-church-1a2b3c4d",
  utm: "utm_source=facebook&utm_medium=paid&utm_campaign=founding&utm_content=video-a", hp_x7: "" };

const req = (path, init = {}) => new Request(BASE + path, init);
const get = (e, path) => worker.fetch(req(path), e, ctx);
const postCheckout = (e, body = FORM, { origin = VIDEO, ip = "203.0.113.9", type = "application/json" } = {}) => worker.fetch(req("/founding/checkout", {
  method: "POST", headers: { "content-type": type, ...(origin ? { origin } : {}), "cf-connecting-ip": ip, "user-agent": "Mozilla/5.0 (iPhone) Safari" }, body: typeof body === "string" ? body : JSON.stringify(body),
}), e, ctx);

async function signed(e, event, { secret = e.STRIPE_WEBHOOK_SECRET, t, header } = {}) {
  const payload = JSON.stringify(event);
  const sig = header ?? await signPayload(payload, secret, t ?? Math.floor(Date.now() / 1000));
  const res = await worker.fetch(req("/stripe/webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": sig }, body: payload }), e, ctx);
  await settle();
  return res;
}

let evtN = 0;
const event = (type, object) => ({ id: `evt_test_${++evtN}`, object: "event", type, data: { object } });
// The session as Stripe sends it in an event: the fake's saved session plus what checkout filled in.
const sessionObj = (st, id, x = {}) => ({ ...st.sessions.get(id), status: "complete", payment_status: "paid", customer: "cus_Test123abc", payment_intent: "pi_test_1", customer_details: { email: "pat@cityreach.example" }, ...x });

async function checkedOut(e, body = FORM, opts) {
  const r = await (await postCheckout(e, body, opts)).json();
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.url.match(/cs_test_[A-Za-z0-9]+/)[0];
}
const record = (e, sid) => JSON.parse(e.AUDITS.m.get(`founding:${sid}`));

// ---------- Stripe client ----------

describe("stripe client", () => {
  test("formEncode writes nested objects and arrays with brackets and drops null and undefined", () => {
    const p = formEncode({ mode: "payment", line_items: [{ price_data: { currency: "usd", unit_amount: 350000, product_data: { name: "A & B" } }, quantity: 1 }],
      allowed_payment_method_types: ["card", "us_bank_account"], payment_intent_data: { setup_future_usage: "off_session" }, skip: null, gone: undefined, flag: true });
    assert.deepEqual([...p.entries()], [
      ["mode", "payment"],
      ["line_items[0][price_data][currency]", "usd"],
      ["line_items[0][price_data][unit_amount]", "350000"],
      ["line_items[0][price_data][product_data][name]", "A & B"],
      ["line_items[0][quantity]", "1"],
      ["allowed_payment_method_types[0]", "card"],
      ["allowed_payment_method_types[1]", "us_bank_account"],
      ["payment_intent_data[setup_future_usage]", "off_session"],
      ["flag", "true"],
    ]);
    assert.ok(p.toString().includes("line_items%5B0%5D%5Bprice_data%5D%5Bproduct_data%5D%5Bname%5D=A+%26+B"));
  });

  test("requests carry the key, the pinned version and form encoding; errors never carry the key", async () => {
    const { st, e } = setup({ stripe: { fail: [[/^GET \/prices$/, 400]] } });
    await stripeCall(e, "POST", "/subscriptions", { params: { customer: "cus_1" }, idempotencyKey: "k-1" });
    const c = st.calls[0];
    assert.equal(c.headers.get("authorization"), `Bearer ${STRIPE_ENV.STRIPE_SECRET_KEY}`);
    assert.equal(c.headers.get("stripe-version"), STRIPE_VERSION);
    assert.equal(STRIPE_VERSION, "2026-09-30.endive");
    assert.equal(c.headers.get("content-type"), "application/x-www-form-urlencoded");
    assert.equal(c.headers.get("idempotency-key"), "k-1");
    await assert.rejects(stripeCall(e, "GET", "/prices", { query: { lookup_keys: ["a"] } }), (err) => {
      assert.equal(err.status, 400);
      assert.ok(!err.message.includes(STRIPE_ENV.STRIPE_SECRET_KEY), err.message);
      return true;
    });
  });

  test("a GET and an idempotent POST get one retry on a 5xx; a plain POST gets none", async () => {
    const { st, e } = setup({ stripe: { fail: [[/^(GET|POST) \/prices$/, 503]] } });
    await assert.rejects(stripeCall(e, "GET", "/prices"));
    assert.equal(st.of("GET", "/prices").length, 2);
    await assert.rejects(stripeCall(e, "POST", "/prices", { params: { a: 1 } }));
    assert.equal(st.of("POST", "/prices").length, 1);
    await assert.rejects(stripeCall(e, "POST", "/prices", { params: { a: 1 }, idempotencyKey: "x" }));
    assert.equal(st.of("POST", "/prices").length, 3);
  });

  test("without STRIPE_SECRET_KEY nothing is sent", async () => {
    const { calls, e } = setup({ env: { STRIPE_SECRET_KEY: "" } });
    await assert.rejects(stripeCall(e, "GET", "/prices"), /not set up/);
    assert.equal(calls.length, 0);
  });
});

// ---------- Signatures ----------

describe("webhook signatures", () => {
  const secret = "whsec_unit_test_secret";
  const payload = '{"id":"evt_1","type":"checkout.session.completed"}';
  const t = Math.floor(NOW / 1000);

  test("matches Stripe's scheme: HMAC-SHA256 of t.payload, hex", async () => {
    const want = await hmacHex(secret, `${t}.${payload}`);
    assert.equal(await signPayload(payload, secret, t), `t=${t},v1=${want}`);
    assert.match(want, /^[0-9a-f]{64}$/);
  });

  test("a good signature passes", async () => {
    assert.deepEqual(await verifySignature(payload, await signPayload(payload, secret, t), secret, { now: NOW }), { ok: true, t });
  });

  test("a wrong secret, a changed body or a changed timestamp fails", async () => {
    const h = await signPayload(payload, secret, t);
    assert.equal((await verifySignature(payload, await signPayload(payload, "whsec_other", t), secret, { now: NOW })).ok, false);
    assert.equal((await verifySignature(payload.replace("evt_1", "evt_2"), h, secret, { now: NOW })).ok, false);
    assert.equal((await verifySignature(payload, h.replace(`t=${t}`, `t=${t + 1}`), secret, { now: NOW })).ok, false);
  });

  test("older or newer than 5 minutes fails, inside 5 minutes passes", async () => {
    const at = (secs) => signPayload(payload, secret, t - secs);
    assert.equal((await verifySignature(payload, await at(299), secret, { now: NOW })).ok, true);
    assert.deepEqual(await verifySignature(payload, await at(301), secret, { now: NOW }), { ok: false, reason: "timestamp outside tolerance" });
    assert.equal((await verifySignature(payload, await at(-301), secret, { now: NOW })).ok, false);
  });

  test("several v1 signatures (a rolled secret): any match passes; v0 alone never does", async () => {
    const good = (await signPayload(payload, secret, t)).split("v1=")[1];
    const old = (await signPayload(payload, "whsec_old", t)).split("v1=")[1];
    assert.equal((await verifySignature(payload, `t=${t},v1=${old},v1=${good}`, secret, { now: NOW })).ok, true);
    assert.equal((await verifySignature(payload, `t=${t},v1=${good},v1=${old}`, secret, { now: NOW })).ok, true);
    assert.equal((await verifySignature(payload, `t=${t},v1=${old},v0=${good}`, secret, { now: NOW })).ok, false);
    assert.equal((await verifySignature(payload, `t=${t},v0=${good}`, secret, { now: NOW })).reason, "malformed header");
  });

  test("a missing or malformed header, or no secret, fails", async () => {
    for (const h of ["", null, "garbage", `v1=${"a".repeat(64)}`, `t=${t}`, `t=abc,v1=${"a".repeat(64)}`]) {
      assert.equal((await verifySignature(payload, h, secret, { now: NOW })).ok, false, String(h));
    }
    assert.equal((await verifySignature(payload, await signPayload(payload, secret, t), "", { now: NOW })).ok, false);
  });
});

// ---------- Status ----------

describe("GET /founding/status", () => {
  test("open with 5 of 5 when live and the key is set", async () => {
    const { e } = setup();
    const res = await get(e, "/founding/status");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), { open: true, spots_left: 5, total: 5, terms_version: "2026-10-20" });
  });

  test("closed when FOUNDING_LIVE is off or the key is missing, and still reports the count", async () => {
    for (const env of [{ FOUNDING_LIVE: "" }, { FOUNDING_LIVE: "no" }, { STRIPE_SECRET_KEY: "" }]) {
      const { e } = setup({ env });
      assert.deepEqual(await (await get(e, "/founding/status")).json(), { open: false, spots_left: 5, total: 5, terms_version: "2026-10-20" });
    }
  });

  test("paid and processing purchases hold spots; full means closed", async () => {
    const { e } = setup();
    await e.AUDITS.put("founding:taken:cs_test_a", "paid");
    await e.AUDITS.put("founding:taken:cs_test_b", "processing");
    assert.equal((await (await get(e, "/founding/status")).json()).spots_left, 3);
    for (const id of ["c", "d", "e"]) await e.AUDITS.put(`founding:taken:cs_test_${id}`, "paid");
    assert.deepEqual(await (await get(e, "/founding/status")).json(), { open: false, spots_left: 0, total: 5, terms_version: "2026-10-20" });
  });

  test("FOUNDING_TOTAL sets the number of spots", async () => {
    const { e } = setup({ env: { FOUNDING_TOTAL: "3" } });
    assert.equal((await (await get(e, "/founding/status")).json()).total, 3);
  });
});

// ---------- Checkout ----------

describe("POST /founding/checkout", () => {
  test("creates one Checkout Session with the server's price and the right shape", async () => {
    const { st, e } = setup();
    const res = await postCheckout(e);
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(st.of("POST", "/checkout/sessions").length, 1);
    const p = st.calls[0].params;
    const expires = Number(p.expires_at);
    delete p.expires_at;
    const agreedAt = p["metadata[agreed_at]"];
    const ipHash = p["metadata[ip_hash]"];
    assert.deepEqual(p, {
      mode: "payment",
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][unit_amount]": "350000",
      "line_items[0][price_data][product_data][name]": "Founding campaign build (includes month 1)",
      "line_items[0][quantity]": "1",
      "allowed_payment_method_types[0]": "card",
      "allowed_payment_method_types[1]": "us_bank_account",
      "payment_method_options[us_bank_account][verification_method]": "instant",
      customer_creation: "always",
      customer_email: "pat@cityreach.example",
      billing_address_collection: "auto",
      "payment_intent_data[setup_future_usage]": "off_session",
      "payment_intent_data[description]": "Founding campaign build (includes month 1): City Reach Church",
      "payment_intent_data[metadata][kind]": "founding",
      "payment_intent_data[metadata][church]": "City Reach Church",
      "payment_intent_data[metadata][term]": "12",
      "metadata[kind]": "founding",
      "metadata[church]": "City Reach Church",
      "metadata[contact_name]": "Pastor Pat Rivera",
      "metadata[role]": "Lead pastor",
      "metadata[phone]": "+15125550142",
      "metadata[website]": "https://cityreachchurch.com/",
      "metadata[term]": "12",
      "metadata[monthly_amount]": "1497",
      "metadata[terms_version]": "2026-10-20",
      "metadata[agreed_at]": agreedAt,
      "metadata[ip_hash]": ipHash,
      "metadata[audit_id]": "city-reach-church-1a2b3c4d",
      "metadata[utm]": FORM.utm,
      success_url: "https://bigsplash.video/church/founding/welcome/?session={CHECKOUT_SESSION_ID}",
      cancel_url: "https://bigsplash.video/church/founding/?canceled=1",
    });
    assert.equal(agreedAt, new Date(NOW).toISOString());
    assert.match(ipHash, /^[0-9a-f]{32}$/);
    assert.ok(!JSON.stringify(st.calls[0].params).includes("203.0.113.9"));
    // Stripe needs at least 30 minutes: 31 leaves room for clock drift.
    assert.equal(expires, Math.floor(NOW / 1000) + 31 * 60);
    assert.ok(st.calls[0].body.includes("success_url=https%3A%2F%2Fbigsplash.video%2Fchurch%2Ffounding%2Fwelcome%2F%3Fsession%3D%7BCHECKOUT_SESSION_ID%7D"));
    assert.deepEqual(body, { ok: true, url: st.sessions.get(body.url.match(/cs_test_\w+/)[0]).url });
  });

  test("saves the agreement record under the session id: statements, version, time, ip hash, browser", async () => {
    const { e } = setup();
    const sid = await checkedOut(e);
    const r = record(e, sid);
    assert.equal(r.status, "open");
    assert.deepEqual(r.agreement, {
      terms_version: "2026-10-20",
      terms_url: "https://bigsplash.video/church/founding/terms/",
      statements: ["I agree to the Founding Partnership Terms", "I'm authorized to sign for City Reach Church"],
      agreed_at: new Date(NOW).toISOString(),
      ip_hash: r.agreement.ip_hash,
      user_agent: "Mozilla/5.0 (iPhone) Safari",
    });
    assert.deepEqual(r.contact, { name: "Pastor Pat Rivera", role: "Lead pastor", email: "pat@cityreach.example", phone: "+15125550142" });
    assert.deepEqual([r.term, r.months, r.monthly_amount, r.amount], ["12", 12, 1497, 3500]);
    assert.match(r.start_token, /^[0-9a-f]{32}$/);
    assert.equal(r.api_origin, BASE);
    assert.ok(!JSON.stringify(r).includes("203.0.113.9"));
  });

  test("the price never comes from the page", async () => {
    const { st, e } = setup();
    await checkedOut(e, { ...FORM, amount: 1, unit_amount: 100, price: "price_cheap", line_items: [{ price: "price_cheap" }], monthly_amount: 1 });
    const p = st.calls[0].params;
    assert.equal(p["line_items[0][price_data][unit_amount]"], "350000");
    assert.equal(p["metadata[monthly_amount]"], "1497");
    assert.ok(!JSON.stringify(p).includes("cheap"));
  });

  test("the 6 month term records $1,697", async () => {
    const { st, e } = setup();
    const sid = await checkedOut(e, { ...FORM, term: "6" });
    assert.equal(st.calls[0].params["metadata[monthly_amount]"], "1697");
    assert.deepEqual([record(e, sid).months, record(e, sid).monthly_amount], [6, 1697]);
  });

  test("on bigsplash.church the pages live at /founding/, and Stripe returns there", async () => {
    const { st, e } = setup();
    await checkedOut(e, FORM, { origin: "https://www.bigsplash.church" });
    assert.equal(st.calls[0].params.success_url, "https://www.bigsplash.church/founding/welcome/?session={CHECKOUT_SESSION_ID}");
    assert.equal(st.calls[0].params.cancel_url, "https://www.bigsplash.church/founding/?canceled=1");
    assert.equal(foundingBase(CHURCH_SITE), "/founding/");
    assert.equal(foundingBase(VIDEO), "/church/founding/");
  });

  test("both checkboxes are required, and nothing reaches Stripe without them", async () => {
    const { st, e } = setup();
    for (const x of [{ agree_terms: false }, { agree_authorized: false }, { agree_terms: undefined }, { agree_authorized: "no" }, { agree_terms: "", agree_authorized: "" }]) {
      const res = await postCheckout(e, { ...FORM, ...x });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, "Please check both boxes to continue.");
    }
    assert.equal(st.calls.length, 0);
    for (const v of [true, "true", "yes", "on", "1"]) {
      assert.equal((await (await postCheckout(e, { ...FORM, email: `p${v}@x.example`, agree_terms: v, agree_authorized: v })).json()).ok, true, String(v));
    }
  });

  test("only the allowed origins may post", async () => {
    const { st, e } = setup();
    for (const origin of [null, "https://evil.example", "https://bigsplash.video.evil.example"]) {
      assert.equal((await postCheckout(e, FORM, { origin })).status, 403);
    }
    assert.equal(st.calls.length, 0);
  });

  test("closed when FOUNDING_LIVE is off, the key is missing, or the spots are full", async () => {
    for (const env of [{ FOUNDING_LIVE: "" }, { STRIPE_SECRET_KEY: "" }]) {
      const { st, e } = setup({ env });
      const res = await postCheckout(e);
      assert.equal(res.status, 409);
      assert.equal((await res.json()).closed, true);
      assert.equal(st.calls.length, 0);
    }
    const { st, e } = setup();
    for (const id of "abcde") await e.AUDITS.put(`founding:taken:cs_test_${id}`, "paid");
    const res = await postCheckout(e);
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), { ok: false, closed: true, spots_left: 0, error: "Founding spots are full. Book a call with our team and we'll find the right fit for your church." });
    assert.equal(st.calls.length, 0);
  });

  test("checks every field and caps lengths", async () => {
    const { st, e } = setup();
    const bad = async (x, msg) => {
      const res = await postCheckout(e, { ...FORM, ...x });
      assert.equal(res.status, 400, JSON.stringify(x));
      assert.equal((await res.json()).error, msg);
    };
    await bad({ church: "" }, "Please fill in your church name, your name, your role, email and cell.");
    await bad({ role: "  " }, "Please fill in your church name, your name, your role, email and cell.");
    await bad({ phone: "" }, "Please fill in your church name, your name, your role, email and cell.");
    await bad({ email: "pat at cityreach" }, "Check the email address.");
    await bad({ phone: "555-0142" }, "Check the cell number.");
    await bad({ website: "http://exa mple .com" }, "Check the church website address.");
    await bad({ term: "24" }, "Choose a 12 month or 6 month partnership.");
    await bad({ term: undefined }, "Choose a 12 month or 6 month partnership.");
    assert.equal(st.calls.length, 0);
    const sid = await checkedOut(e, { ...FORM, church: "C".repeat(500), name: "N​".repeat(300), website: "", audit_id: "../../etc", utm: "u".repeat(900) });
    const r = record(e, sid);
    assert.equal(r.church.name.length, 120);
    assert.equal(r.contact.name.length, 120);
    assert.equal(r.church.website, "");
    assert.equal(r.audit_id, "");
    assert.equal(st.calls[0].params["metadata[utm]"].length, 500);
    assert.ok(Object.values(st.calls[0].params).every((v) => v.length <= 500));
  });

  test("a double click gets the same Stripe page and one session", async () => {
    const { st, e } = setup();
    const a = await (await postCheckout(e)).json();
    const b = await (await postCheckout(e)).json();
    assert.equal(a.url, b.url);
    assert.equal(st.of("POST", "/checkout/sessions").length, 1);
  });

  test("a Stripe failure tells the pastor plainly and saves nothing", async () => {
    const { e } = setup({ stripe: { fail: [[/^POST \/checkout\/sessions$/, 500]] } });
    const res = await postCheckout(e);
    assert.equal(res.status, 502);
    assert.equal((await res.json()).error, "Checkout did not open on our end. Try again in a minute, or email chris@bigsplash.agency.");
    assert.equal([...e.AUDITS.m.keys()].filter((k) => k.startsWith("founding:cs_")).length, 0);
  });

  test("rate limited, not JSON, bad JSON, too large and the honeypot", async () => {
    const limited = setup({ env: { INTAKE_LIMIT: { limit: async ({ key }) => ({ success: !key.startsWith("founding:") }) } } });
    assert.equal((await postCheckout(limited.e)).status, 429);
    const { st, e } = setup();
    assert.equal((await postCheckout(e, "church=x", { type: "application/x-www-form-urlencoded" })).status, 415);
    assert.equal((await postCheckout(e, "{bad")).status, 400);
    assert.equal((await postCheckout(e, { ...FORM, church: "x".repeat(9000) })).status, 413);
    assert.equal((await postCheckout(e, { ...FORM, hp_x7: "bot" })).status, 400);
    assert.equal(st.calls.length, 0);
  });
});

// ---------- Webhook ----------

describe("POST /stripe/webhook", () => {
  test("a bad, stale or missing signature gets 400 and changes nothing", async () => {
    const { st, e, g } = setup();
    const sid = await checkedOut(e);
    const ev = event("checkout.session.completed", sessionObj(st, sid));
    const before = JSON.stringify([...e.AUDITS.m]);
    assert.equal((await signed(e, ev, { secret: "whsec_wrong" })).status, 400);
    assert.equal((await signed(e, ev, { t: Math.floor(NOW / 1000) - 301 })).status, 400);
    assert.equal((await signed(e, ev, { header: "" })).status, 400);
    assert.equal(JSON.stringify([...e.AUDITS.m]), before);
    assert.equal(g.emails.length, 0);
  });

  test("without STRIPE_WEBHOOK_SECRET it answers 503, so Stripe tries again later", async () => {
    const { e } = setup({ env: { STRIPE_WEBHOOK_SECRET: "" } });
    const res = await worker.fetch(req("/stripe/webhook", { method: "POST", body: "{}", headers: { "stripe-signature": "t=1,v1=" + "a".repeat(64) } }), e, ctx);
    assert.equal(res.status, 503);
  });

  test("a card payment is won: KV, GoHighLevel, the welcome email and LeadDesk, once each", async () => {
    const { st, e, g, desk, slack } = setup();
    const sid = await checkedOut(e);
    const res = await signed(e, event("checkout.session.completed", sessionObj(st, sid)));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { received: true });
    const r = record(e, sid);
    assert.equal(r.status, "paid");
    assert.equal(r.paid_by, "card");
    assert.equal(r.customer, "cus_Test123abc");
    assert.equal(r.payment_intent, "pi_test_1");
    assert.equal(e.AUDITS.m.get(`founding:taken:${sid}`), "paid");
    assert.equal(r.clickup_task_id, "cl-1");
    assert.ok(r.won.done);

    // GoHighLevel: the contact, tags that stop the audit follow-ups, and the agreement note.
    assert.equal(g.upserts.length, 1);
    assert.equal(g.upserts[0].source, "Founding checkout");
    assert.equal(g.upserts[0].companyName, "City Reach Church");
    assert.deepEqual(g.tags[0].tags, ["founding-partner", "fd-stop"]);
    assert.equal(g.notes.length, 1);
    assert.ok(g.notes[0].body.includes("Checked: I agree to the Founding Partnership Terms"));
    assert.ok(g.notes[0].body.includes("Checked: I'm authorized to sign for City Reach Church"));
    assert.ok(g.notes[0].body.includes("Terms version: 2026-10-20"));
    // The welcome email from Chris.
    assert.equal(g.emails.length, 1);
    assert.equal(g.emails[0].subject, "Welcome to Big Splash, City Reach Church");
    assert.ok(g.emails[0].message.startsWith("Hi Pat,"));
    assert.ok(g.emails[0].message.includes(`Book your kickoff call: ${KICKOFF_URL}`));
    assert.ok(g.emails[0].html.includes(`<a href="${KICKOFF_URL}">`));
    assert.ok(g.emails[0].message.endsWith("The Big Splash Team\n\n1119 Ascot St., Georgetown, TX 78626."));
    assert.equal(g.texts.length, 0);

    // LeadDesk "won".
    assert.equal(desk.calls.length, 1);
    const w = desk.calls[0];
    assert.equal(w.event, "won");
    assert.equal(w.id, sid);
    assert.deepEqual(w.church, { name: "City Reach Church", website: "https://cityreachchurch.com/" });
    assert.deepEqual(w.contact, { name: "Pastor Pat Rivera", role: "Lead pastor", email: "pat@cityreach.example", phone: "+15125550142" });
    assert.deepEqual([w.term, w.monthly_amount, w.amount_paid, w.paid_by, w.stripe_customer, w.session_id], ["12", 1497, 3500, "card", "cus_Test123abc", sid]);
    assert.equal(w.start_monthly_url, `${BASE}/founding/start?session=${sid}&t=${r.start_token}`);
    assert.ok(w.agreement_summary.includes("Terms version 2026-10-20"));
    assert.deepEqual(w.utm, { source: "facebook", medium: "paid", campaign: "founding", content: "video-a" });
    assert.deepEqual([w.spots_left, w.spots_total, w.emailed, w.audit_id], [4, 5, true, "city-reach-church-1a2b3c4d"]);
    // The desk posted Slack, so the worker did not.
    assert.equal(slack.length, 0);
  });

  test("a repeated event, a second event for the same payment, and the welcome page do nothing twice", async () => {
    const { st, e, g, desk } = setup();
    const sid = await checkedOut(e);
    const ev = event("checkout.session.completed", sessionObj(st, sid));
    await signed(e, ev);
    const again = await signed(e, ev);
    assert.deepEqual(await again.json(), { received: true, duplicate: true });
    // A separate Event object for the same session (Stripe can send two).
    await signed(e, event("checkout.session.completed", sessionObj(st, sid)));
    st.sessions.set(sid, sessionObj(st, sid));
    assert.equal((await (await get(e, `/founding/session?id=${sid}`)).json()).status, "paid");
    await settle();
    assert.equal(g.emails.length, 1);
    assert.equal(g.notes.length, 1);
    assert.equal(desk.calls.length, 1);
    assert.equal(e.AUDITS.m.get(`founding:taken:${sid}`), "paid");
  });

  test("ACH: completed unpaid is processing and holds the spot; async success is won by bank", async () => {
    const { st, e, g, desk } = setup();
    const sid = await checkedOut(e);
    await signed(e, event("checkout.session.completed", sessionObj(st, sid, { payment_status: "unpaid" })));
    let r = record(e, sid);
    assert.equal(r.status, "processing");
    assert.equal(e.AUDITS.m.get(`founding:taken:${sid}`), "processing");
    assert.equal(g.emails.length, 0);
    assert.equal(desk.calls.length, 1);
    assert.deepEqual({ ...desk.calls[0], message: undefined }, { event: "billing", id: `bank_processing-${sid}`, kind: "bank_processing", session_id: sid, church: { name: "City Reach Church" }, clickup_task_id: "", message: undefined, link: "" });
    assert.ok(desk.calls[0].message.includes("processing"));
    assert.deepEqual(await (await get(e, `/founding/session?id=${sid}`)).json(), { church: "City Reach Church", status: "processing" });
    assert.equal((await (await get(e, "/founding/status")).json()).spots_left, 4);

    await signed(e, event("checkout.session.async_payment_succeeded", sessionObj(st, sid)));
    r = record(e, sid);
    assert.equal(r.status, "paid");
    assert.equal(r.paid_by, "bank");
    assert.equal(e.AUDITS.m.get(`founding:taken:${sid}`), "paid");
    assert.equal(g.emails.length, 1);
    assert.equal(desk.calls.at(-1).event, "won");
    assert.equal(desk.calls.at(-1).paid_by, "bank");
  });

  test("ACH failure frees the spot, tells the desk, and never sends the welcome", async () => {
    const { st, e, g, desk } = setup();
    const sid = await checkedOut(e);
    await signed(e, event("checkout.session.completed", sessionObj(st, sid, { payment_status: "unpaid" })));
    await signed(e, event("checkout.session.async_payment_failed", sessionObj(st, sid, { payment_status: "unpaid" })));
    assert.equal(record(e, sid).status, "failed");
    assert.equal(e.AUDITS.m.has(`founding:taken:${sid}`), false);
    assert.equal((await (await get(e, "/founding/status")).json()).spots_left, 5);
    assert.equal(desk.calls.at(-1).kind, "bank_failed");
    assert.ok(desk.calls.at(-1).message.includes("open again"));
    assert.equal(g.emails.length, 0);
    assert.deepEqual(await (await get(e, `/founding/session?id=${sid}`)).json(), { church: "City Reach Church", status: "failed" });
    // A late "completed" never moves a failed payment back to processing.
    await signed(e, event("checkout.session.completed", sessionObj(st, sid, { payment_status: "unpaid" })));
    assert.equal(record(e, sid).status, "failed");
  });

  test("sessions that are not ours (GoHighLevel's own checkouts) and other events are ignored with a 200", async () => {
    const { e, g, desk } = setup();
    const other = { id: "cs_test_ghlOwn123456", object: "checkout.session", mode: "payment", status: "complete", payment_status: "paid", metadata: {}, amount_total: 5000 };
    assert.equal((await signed(e, event("checkout.session.completed", other))).status, 200);
    const ignored = await signed(e, event("charge.refunded", { id: "ch_1" }));
    assert.deepEqual(await ignored.json(), { received: true, ignored: true });
    assert.equal([...e.AUDITS.m.keys()].filter((k) => k.startsWith("founding:")).length, 0);
    assert.equal(g.calls.length + desk.calls.length, 0);
  });

  test("a record lost from KV is rebuilt from the session metadata", async () => {
    const { st, e, g, desk } = setup();
    const sid = await checkedOut(e);
    e.AUDITS.m.delete(`founding:${sid}`);
    await signed(e, event("checkout.session.completed", sessionObj(st, sid)));
    const r = record(e, sid);
    assert.equal(r.rebuilt, true);
    assert.equal(r.status, "paid");
    assert.equal(r.contact.email, "pat@cityreach.example");
    assert.deepEqual(r.agreement.statements, ["I agree to the Founding Partnership Terms", "I'm authorized to sign for City Reach Church"]);
    assert.equal(g.emails.length, 1);
    assert.equal(desk.calls[0].event, "won");
  });

  test("a handler failure answers 500 and leaves the event unmarked, so Stripe retries", async () => {
    const { st, e } = setup();
    const sid = await checkedOut(e);
    const put = e.AUDITS.put;
    e.AUDITS.put = async (k, ...rest) => { if (k.startsWith("founding:taken:")) throw new Error("KV down"); return put.call(e.AUDITS, k, ...rest); };
    const ev = event("checkout.session.completed", sessionObj(st, sid));
    assert.equal((await signed(e, ev)).status, 500);
    assert.equal(e.AUDITS.m.has(`stripe:event:${ev.id}`), false);
    e.AUDITS.put = put;
    assert.equal((await signed(e, ev)).status, 200);
    assert.equal(e.AUDITS.m.get(`founding:taken:${sid}`), "paid");
  });

  test("with the FoundingFlow binding the webhook starts won-<session> once and the Workflow does the work", async () => {
    const made = [];
    const flow = { async create(o) { if (made.some((m) => m.id === o.id)) throw new Error("instance.already_exists"); made.push(o); return { id: o.id }; } };
    const { st, e, g, desk } = setup({ env: { FOUNDING_FLOW: flow } });
    const sid = await checkedOut(e);
    await signed(e, event("checkout.session.completed", sessionObj(st, sid)));
    await signed(e, event("checkout.session.completed", sessionObj(st, sid)));
    assert.deepEqual(made.map((m) => m.id), [`won-${sid}`]);
    assert.deepEqual(Object.keys(made[0].params), ["action", "session", "rec"]);
    assert.deepEqual([made[0].params.action, made[0].params.session, made[0].params.rec.status], ["won", sid, "paid"]);
    assert.equal(g.emails.length, 0);
    const step = replayStep();
    await new FoundingFlow({}, e).run({ payload: made[0].params }, step);
    await new FoundingFlow({}, e).run({ payload: made[0].params }, step);
    assert.equal(g.emails.length, 1);
    assert.equal(desk.calls.length, 1);
    assert.ok(step.names.includes("won welcome email"));
  });

  test("when the desk is missing or its Slack fails, the worker posts Slack itself", async () => {
    const { st, e, slack } = setup({ desk: fakeDesk({ slackOk: false }) });
    const sid = await checkedOut(e);
    await signed(e, event("checkout.session.completed", sessionObj(st, sid)));
    assert.equal(slack.length, 1);
    assert.ok(slack[0].startsWith("*New founding partner:* City Reach Church"));
    assert.ok(slack[0].includes("Welcome email sent through GoHighLevel."));
    assert.ok(slack[0].includes(`/founding/start?session=${sid}`));
    const bare = setup({ desk: null, env: { GHL_TOKEN: "" } });
    const sid2 = await checkedOut(bare.e);
    await signed(bare.e, event("checkout.session.completed", sessionObj(bare.st, sid2)));
    assert.ok(bare.slack[0].includes("GHL_TOKEN is not set"));
    assert.ok(bare.slack[0].includes("LeadDesk is not bound"));
  });
});

// ---------- Monthly invoices and cancel ----------

describe("invoice and subscription events", () => {
  async function started() {
    const s = setup();
    const sid = await checkedOut(s.e);
    await signed(s.e, event("checkout.session.completed", sessionObj(s.st, sid)));
    await s.e.AUDITS.put("founding:subscription:sub_fake_9", sid);
    return { ...s, sid };
  }
  const invoice = (x = {}) => ({ id: "in_1", object: "invoice", amount_paid: 149700, amount_due: 149700, customer: "cus_Test123abc",
    parent: { type: "subscription_details", subscription_details: { subscription: "sub_fake_9", metadata: {} } }, hosted_invoice_url: "https://invoice.stripe.com/i/acct_1/test_1", ...x });

  test("invoice.paid comments on the client task; the trial's $0 invoice is skipped", async () => {
    const { e, desk } = await started();
    const before = desk.calls.length;
    await signed(e, event("invoice.paid", invoice({ id: "in_zero", amount_paid: 0 })));
    assert.equal(desk.calls.length, before);
    await signed(e, event("invoice.paid", invoice()));
    const n = desk.calls.at(-1);
    assert.deepEqual(n, { event: "billing", id: "invoice_paid-in_1", kind: "invoice_paid", session_id: n.session_id, church: { name: "City Reach Church" }, clickup_task_id: "cl-1",
      message: "City Reach Church paid $1,497 for monthly campaign management.", link: "" });
  });

  test("invoice.payment_failed carries the payment page; customer.subscription.deleted says billing ended", async () => {
    const { e, desk } = await started();
    await signed(e, event("invoice.payment_failed", invoice({ id: "in_2", amount_paid: 0 })));
    assert.equal(desk.calls.at(-1).kind, "invoice_failed");
    assert.equal(desk.calls.at(-1).link, "https://invoice.stripe.com/i/acct_1/test_1");
    assert.ok(desk.calls.at(-1).message.startsWith("The $1,497 monthly payment from City Reach Church failed."));
    await signed(e, event("customer.subscription.deleted", { id: "sub_fake_9", object: "subscription", metadata: {} }));
    assert.equal(desk.calls.at(-1).kind, "canceled");
    assert.equal(desk.calls.at(-1).clickup_task_id, "cl-1");
  });

  test("the subscription is found from its metadata when KV has no mapping, and the older top-level field works", async () => {
    const { e, desk, sid } = await started();
    e.AUDITS.m.delete("founding:subscription:sub_fake_9");
    await signed(e, event("invoice.paid", invoice({ id: "in_3", parent: null, subscription: "sub_other", subscription_details: { metadata: { kind: "founding", session: sid } } })));
    assert.equal(desk.calls.at(-1).id, "invoice_paid-in_3");
  });

  test("invoices for subscriptions that are not ours are ignored", async () => {
    const { e, desk } = await started();
    const before = desk.calls.length;
    await signed(e, event("invoice.paid", invoice({ id: "in_4", parent: { subscription_details: { subscription: "sub_ghl", metadata: {} } } })));
    await signed(e, event("customer.subscription.deleted", { id: "sub_ghl", object: "subscription", metadata: {} }));
    assert.equal(desk.calls.length, before);
  });
});

// ---------- Welcome page status ----------

describe("GET /founding/session", () => {
  test("only the church name and the status, never contact details", async () => {
    const { st, e } = setup();
    const sid = await checkedOut(e);
    await signed(e, event("checkout.session.completed", sessionObj(st, sid)));
    const res = await get(e, `/founding/session?id=${sid}`);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.deepEqual(await res.json(), { church: "City Reach Church", status: "paid" });
  });

  test("an open record asks Stripe: open, expired, or paid (and a paid one is settled at once)", async () => {
    const { st, e, g } = setup();
    const sid = await checkedOut(e);
    assert.deepEqual(await (await get(e, `/founding/session?id=${sid}`)).json(), { church: "City Reach Church", status: "open" });
    st.sessions.set(sid, { ...st.sessions.get(sid), status: "expired" });
    assert.equal((await (await get(e, `/founding/session?id=${sid}`)).json()).status, "expired");
    st.sessions.set(sid, sessionObj(st, sid));
    assert.equal((await (await get(e, `/founding/session?id=${sid}`)).json()).status, "paid");
    await settle();
    assert.equal(record(e, sid).status, "paid");
    assert.equal(g.emails.length, 1);
  });

  test("bad ids, unknown ids and sessions that are not ours are 404", async () => {
    const { st, e } = setup();
    assert.equal((await get(e, "/founding/session?id=../../x")).status, 404);
    assert.equal((await get(e, "/founding/session?id=cs_test_nothere12345")).status, 404);
    st.sessions.set("cs_test_ghlOwn123456", { id: "cs_test_ghlOwn123456", object: "checkout.session", mode: "payment", status: "complete", metadata: {} });
    assert.equal((await get(e, "/founding/session?id=cs_test_ghlOwn123456")).status, 404);
  });
});

// ---------- Start monthly billing ----------

describe("start monthly billing", () => {
  async function paid(opts = {}) {
    const s = setup(opts);
    const sid = await checkedOut(s.e, opts.form || FORM);
    await signed(s.e, event("checkout.session.completed", sessionObj(s.st, sid)));
    const r = record(s.e, sid);
    const start = (body) => worker.fetch(req("/founding/start", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() }), s.e, ctx);
    return { ...s, sid, token: r.start_token, start };
  }

  test("trial_end is launch + 30 days at noon Central, across both clock changes", () => {
    const at = (launch) => new Date(trialEnd(launch) * 1000).toISOString();
    assert.equal(at("2026-10-20"), "2026-11-19T18:00:00.000Z"); // CDT launch, CST charge
    assert.equal(at("2026-10-05"), "2026-11-04T18:00:00.000Z"); // the 30 days cross Nov 1
    assert.equal(at("2027-02-20"), "2027-03-22T17:00:00.000Z"); // CST launch, CDT charge
    assert.equal(at("2026-07-01"), "2026-07-31T17:00:00.000Z");
    assert.equal(at("2026-12-15"), "2027-01-14T18:00:00.000Z"); // across the year
    assert.equal(trialEnd("2026-02-30"), null);
    assert.equal(trialEnd("10/20/2026"), null);
    assert.equal(trialEnd(""), null);
    assert.equal(new Date(zonedNoon(2026, 2, 8, "America/Chicago")).toISOString(), "2026-03-08T17:00:00.000Z"); // the spring-forward day
  });

  test("the GET link shows a confirm page and changes nothing", async () => {
    const { st, e, sid, token } = await paid();
    const n = st.calls.length;
    const res = await get(e, `/founding/start?session=${sid}&t=${token}`);
    const html = await res.text();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.ok(html.includes('type="date" name="launch" required'));
    assert.ok(html.includes("Start monthly billing for City Reach Church?"));
    assert.equal(st.calls.length, n);
    assert.equal((await get(e, `/founding/start?session=${sid}&t=${"0".repeat(32)}`)).status, 404);
    assert.equal((await get(e, `/founding/start?session=${sid}`)).status, 404);
  });

  test("POST creates the price once by lookup_key, then one subscription with the saved payment method and trial_end", async () => {
    const { st, e, sid, token, start, desk } = await paid();
    const n = st.calls.length;
    const res = await start({ session: sid, t: token, launch: "2026-10-20" });
    const html = await res.text();
    assert.equal(res.status, 200, html);
    assert.ok(html.includes("monthly billing starts November 19, 2026 at $1,497"));
    const calls = st.calls.slice(n);
    assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["GET /subscriptions", "GET /prices", "POST /prices", "GET /payment_intents/pi_test_1", "POST /subscriptions"]);
    assert.deepEqual(calls[0].query, { customer: "cus_Test123abc", status: "all", limit: "100" });
    assert.deepEqual(calls[1].query, { "lookup_keys[0]": "bs_monthly_1497", "lookup_keys[1]": "bs_monthly_1697", active: "true", limit: "10" });
    assert.deepEqual(calls[2].params, { currency: "usd", unit_amount: "149700", "recurring[interval]": "month", lookup_key: "bs_monthly_1497", nickname: "Monthly campaign management, 12 months", "product_data[name]": "Monthly campaign management", transfer_lookup_key: "true" });
    assert.equal(calls[2].headers.get("idempotency-key"), "bs-price-bs_monthly_1497");
    const price = st.prices[0].id;
    assert.deepEqual(calls[4].params, {
      customer: "cus_Test123abc", "items[0][price]": price, default_payment_method: "pm_saved_card_1", trial_end: String(Date.parse("2026-11-19T18:00:00Z") / 1000),
      description: "Monthly campaign management: City Reach Church",
      "metadata[kind]": "founding", "metadata[church]": "City Reach Church", "metadata[term]": "12", "metadata[session]": sid, "metadata[launch]": "2026-10-20",
    });
    assert.equal(calls[4].headers.get("idempotency-key"), `bs-sub-${sid}`);
    const r = record(e, sid);
    assert.equal(r.subscription.id, st.subs[0].id);
    assert.equal(e.AUDITS.m.get(`founding:subscription:${st.subs[0].id}`), sid);
    const note = desk.calls.at(-1);
    assert.deepEqual(note, { event: "billing", id: `started-${sid}`, kind: "started", session_id: sid, church: { name: "City Reach Church" }, clickup_task_id: "cl-1", message: "Monthly billing starts November 19, 2026 at $1,497", link: "" });
  });

  test("a second click, or a racing one, makes no second subscription", async () => {
    const { st, sid, token, start } = await paid();
    const [a, b] = await Promise.all([start({ session: sid, t: token, launch: "2026-10-20" }), start({ session: sid, t: token, launch: "2026-10-20" })]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(st.subs.length, 1);
    const n = st.calls.length;
    const third = await (await start({ session: sid, t: token, launch: "2026-10-22" })).text();
    assert.ok(third.includes("Already started"));
    assert.equal(st.calls.length, n);
  });

  test("a subscription Stripe already has for this session is reused, even when KV forgot it", async () => {
    const s = await paid();
    s.st.subs.push({ id: "sub_existing_1", customer: "cus_Test123abc", status: "trialing", trial_end: 1795000000, metadata: { session: s.sid } });
    const html = await (await s.start({ session: s.sid, t: s.token, launch: "2026-10-20" })).text();
    assert.ok(html.includes("already set up"));
    assert.equal(s.st.of("POST", "/subscriptions").length, 0);
    assert.equal(record(s.e, s.sid).subscription.id, "sub_existing_1");
  });

  test("an existing price is used as is; a missing one joins the same product", async () => {
    const { st, e } = setup({ stripe: { prices: [{ id: "price_1497", object: "price", lookup_key: "bs_monthly_1497", unit_amount: 149700, product: "prod_monthly", active: true }] } });
    assert.equal(await ensurePrice(e, "12"), "price_1497");
    assert.equal(st.of("POST", "/prices").length, 0);
    const id = await ensurePrice(e, "6");
    const made = st.of("POST", "/prices")[0].params;
    assert.equal(made.product, "prod_monthly");
    assert.equal(made.unit_amount, "169700");
    assert.equal(made.lookup_key, "bs_monthly_1697");
    assert.equal(made["product_data[name]"], undefined);
    assert.equal(id, st.prices[1].id);
    assert.deepEqual(TERMS, { "12": { months: 12, monthly: 1497, lookup: "bs_monthly_1497" }, "6": { months: 6, monthly: 1697, lookup: "bs_monthly_1697" } });
  });

  test("a launch date more than 30 days back, too far out, or not a date asks again and makes nothing", async () => {
    const { st, sid, token, start } = await paid();
    for (const launch of ["2026-09-01", "2028-01-01", "", "2026-13-01"]) {
      const res = await start({ session: sid, t: token, launch });
      assert.equal(res.status, 400, launch);
      assert.ok((await res.text()).includes('type="date"'));
    }
    assert.equal(st.of("POST", "/subscriptions").length, 0);
  });

  test("a wrong token, or a payment still processing, starts nothing", async () => {
    const { st, e, sid, token, start } = await paid();
    assert.equal((await start({ session: sid, t: "f".repeat(32), launch: "2026-10-20" })).status, 404);
    const s2 = setup();
    const sid2 = await checkedOut(s2.e);
    await signed(s2.e, event("checkout.session.completed", sessionObj(s2.st, sid2, { payment_status: "unpaid" })));
    const res = await worker.fetch(req("/founding/start", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ session: sid2, t: record(s2.e, sid2).start_token, launch: "2026-10-20" }).toString() }), s2.e, ctx);
    assert.equal(res.status, 409);
    assert.equal(s2.st.of("POST", "/subscriptions").length, 0);
    assert.equal(st.of("POST", "/subscriptions").length, 0);
    assert.ok(e);
    assert.ok(token);
  });

  test("a 6 month partner is billed $1,697", async () => {
    const { st, sid, token, start, desk } = await paid({ form: { ...FORM, term: "6" } });
    await start({ session: sid, t: token, launch: "2027-02-20" });
    assert.equal(st.prices[0].lookup_key, "bs_monthly_1697");
    assert.equal(st.of("POST", "/subscriptions")[0].params.trial_end, String(Date.parse("2027-03-22T17:00:00Z") / 1000));
    assert.equal(desk.calls.at(-1).message, "Monthly billing starts March 22, 2027 at $1,697");
  });
});

// ---------- Messages, payloads, health and config ----------

describe("welcome email, payloads and config", () => {
  test("the welcome email: thanks, the kickoff link, next steps, the term, the address, and plain words", () => {
    const m = foundingWelcomeEmail({ firstName: "Pat", church: "City Reach <Church>", termMonths: 12, monthly: 1497, address: "1119 Ascot St., Georgetown, TX 78626" });
    assert.equal(m.subject, "Welcome to Big Splash, City Reach <Church>");
    assert.ok(m.text.startsWith("Hi Pat,\n\nThank you for trusting us with City Reach <Church>."));
    assert.ok(m.text.includes(`Book your kickoff call: ${KICKOFF_URL}`));
    assert.ok(m.text.includes("Your 12-month partnership starts the day the campaign launches."));
    assert.ok(m.text.includes("the first monthly charge of $1,497 comes 30 days after launch"));
    assert.ok(m.text.endsWith("The Big Splash Team\n\n1119 Ascot St., Georgetown, TX 78626."));
    assert.ok(m.html.includes("City Reach &lt;Church&gt;"));
    assert.ok(!m.html.includes("<Church>"));
    const six = foundingWelcomeEmail({ firstName: "Pat", church: "X", termMonths: 6, monthly: 1697 });
    assert.ok(six.text.includes("Your 6-month partnership") && six.text.includes("$1,697"));
    const all = m.text + six.text;
    assert.ok(!/[—–]/.test(all), "no dashes");
    assert.ok(!/\b(really|just|actually|simply|honestly|literally|truly|deeply|holy)\b/i.test(all));
    assert.ok(!/(^|[.!?]\s+)(What|When|Where|Which|Who|Why|How)\b/m.test(all));
    assert.ok(!/reply stop/i.test(all));
  });

  test("the won payload and the GoHighLevel note carry the agreement", () => {
    const rec = { session_id: "cs_test_x1y2z3a4b5", church: { name: "C", website: "" }, contact: { name: "N", role: "R", email: "e@x.example", phone: "+15125550142" }, term: "6", months: 6, monthly_amount: 1697,
      paid_by: "bank", customer: "cus_1", start_token: "tok", api_origin: BASE, utm: "", audit_id: "",
      agreement: { terms_version: "2026-10-20", terms_url: "https://bigsplash.video/church/founding/terms/", statements: ["I agree to the Founding Partnership Terms", "I'm authorized to sign for C"], agreed_at: "2026-10-21T15:00:00.000Z", ip_hash: "abc", user_agent: "UA" } };
    const p = wonPayload({ FOUNDING_TOTAL: "5" }, rec, { spotsLeft: 2, emailed: false });
    assert.equal(p.start_monthly_url, `${BASE}/founding/start?session=cs_test_x1y2z3a4b5&t=tok`);
    assert.equal(p.agreement_summary, `Checked "I agree to the Founding Partnership Terms" and "I'm authorized to sign for C" on the founding form. Terms version 2026-10-20, agreed 2026-10-21T15:00:00.000Z, IP hash abc.`);
    assert.deepEqual([p.spots_left, p.spots_total, p.emailed, p.paid_by, p.monthly_amount], [2, 5, false, "bank", 1697]);
    const note = agreementNote(rec);
    assert.ok(note.includes("Term: 6 months at $1,697/month"));
    assert.ok(note.includes("Paid by: bank (ACH)"));
    assert.ok(note.includes("Terms page: https://bigsplash.video/church/founding/terms/"));
    assert.ok(note.includes("Browser: UA"));
  });

  test("an unknown flow action does nothing", async () => {
    assert.equal(await runFlow({}, replayStep(), { action: "nope" }), null);
  });

  test("health reports stripe, stripe_webhook and founding_live", async () => {
    const { e } = setup();
    const h = await (await get(e, "/health")).json();
    assert.deepEqual([h.stripe, h.stripe_webhook, h.founding_live], [true, true, true]);
    const bare = await (await get(fakeEnv(), "/health")).json();
    assert.deepEqual([bare.stripe, bare.stripe_webhook, bare.founding_live], [false, false, false]);
  });

  test("wrangler.toml: founding off, 5 spots, the terms version, the Workflow, and the setup notes", () => {
    const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
    assert.match(toml, /^FOUNDING_LIVE = ""$/m);
    assert.match(toml, /^FOUNDING_TOTAL = "5"$/m);
    assert.match(toml, /^TERMS_VERSION = "2026-10-20"$/m);
    assert.match(toml, /binding = "FOUNDING_FLOW"\nclass_name = "FoundingFlow"/);
    for (const s of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "https://bigsplash-front-door.chris-bc4.workers.dev/stripe/webhook", "checkout.session.async_payment_failed", "customer.subscription.deleted", "2026-09-30.endive"]) {
      assert.ok(toml.includes(s), s);
    }
    assert.ok(!/(sk|rk)_(live|test)_[A-Za-z0-9]{8,}|whsec_[A-Za-z0-9]{8,}/.test(toml));
  });

  test("unknown founding paths fall through to 404", async () => {
    const { e } = setup();
    assert.equal((await get(e, "/founding/nope")).status, 404);
    assert.equal((await get(e, "/stripe/webhook")).status, 404);
  });

  test("json helper sanity for the fake", async () => {
    assert.equal((await json({ a: 1 }).json()).a, 1);
  });
});

// ---------- Review fixes: holds, oversell, stale reads, lookups, IP hash ----------

describe("founding spots under pressure", () => {
  const OTHER = { ...FORM, church: "Hill Country Fellowship", email: "sam@hcf.example" };

  test("a checkout holds a spot, so a second church can't open checkout for the last one", async () => {
    const { st, e } = setup();
    for (const id of "abcd") await e.AUDITS.put(`founding:taken:cs_test_${id}`, "paid");
    const sid = await checkedOut(e);
    const hold = [...e.AUDITS.m.keys()].find((k) => k.startsWith("founding:hold:"));
    assert.ok(hold.endsWith(`:${sid}`));
    assert.equal(record(e, sid).hold_key, hold);
    const res = await postCheckout(e, OTHER);
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.deepEqual([body.ok, body.held, body.spots_left], [false, true, 1]);
    assert.ok(body.error.includes("Book a call with our team") || body.error.includes("book a call with our team"));
    assert.equal(st.of("POST", "/checkout/sessions").length, 1);
    // The status button still counts paid spots only.
    assert.equal((await (await get(e, "/founding/status")).json()).spots_left, 1);
  });

  test("a church's own hold never blocks it after it leaves checkout and comes back", async () => {
    const { st, e } = setup();
    for (const id of "abcd") await e.AUDITS.put(`founding:taken:cs_test_${id}`, "paid");
    await checkedOut(e);
    for (const k of [...e.AUDITS.m.keys()]) if (k.startsWith("founding:pending:")) e.AUDITS.m.delete(k);
    await checkedOut(e);
    assert.equal(st.of("POST", "/checkout/sessions").length, 2);
  });

  test("the hold goes away once the payment lands or fails", async () => {
    const { st, e } = setup();
    const sid = await checkedOut(e);
    const hold = record(e, sid).hold_key;
    await signed(e, event("checkout.session.completed", sessionObj(st, sid)));
    assert.equal(e.AUDITS.m.has(hold), false);
    const s2 = setup();
    const sid2 = await checkedOut(s2.e);
    const hold2 = record(s2.e, sid2).hold_key;
    await signed(s2.e, event("checkout.session.completed", sessionObj(s2.st, sid2, { payment_status: "unpaid" })));
    assert.equal(s2.e.AUDITS.m.has(hold2), false);
  });

  test("a payment past the last spot is flagged OVERSOLD and the church hears nothing yet", async () => {
    const { st, e, g, desk } = setup();
    const sid = await checkedOut(e);
    for (const id of "abcde") await e.AUDITS.put(`founding:taken:cs_test_${id}`, "paid");
    await signed(e, event("checkout.session.completed", sessionObj(st, sid)));
    const r = record(e, sid);
    assert.equal(r.status, "paid");
    assert.equal(r.oversold, true);
    assert.equal(g.emails.length, 0);
    assert.equal(g.upserts.length, 0);
    assert.equal(desk.calls.length, 1);
    assert.deepEqual([desk.calls[0].event, desk.calls[0].kind], ["billing", "oversold"]);
    assert.ok(desk.calls[0].message.includes("after all 5 founding spots were taken"));
    assert.ok(desk.calls[0].message.includes(`/founding/start?session=${sid}`));
    // A repeat delivery sends nothing new.
    await signed(e, event("checkout.session.completed", sessionObj(st, sid)));
    assert.equal(desk.calls.length, 1);
  });

  test("a bank payment past the last spot is flagged when it starts processing", async () => {
    const { st, e, desk } = setup();
    const sid = await checkedOut(e);
    for (const id of "abcde") await e.AUDITS.put(`founding:taken:cs_test_${id}`, "paid");
    await signed(e, event("checkout.session.completed", sessionObj(st, sid, { payment_status: "unpaid" })));
    assert.equal(record(e, sid).oversold, true);
    assert.equal(desk.calls.at(-1).kind, "oversold");
  });

  test("the won Workflow uses the paid snapshot when KV still serves the open record", async () => {
    const made = [];
    const flow = { async create(o) { made.push(o); return { id: o.id }; } };
    const { st, e, g, desk } = setup({ env: { FOUNDING_FLOW: flow } });
    const sid = await checkedOut(e);
    const open = e.AUDITS.m.get(`founding:${sid}`);
    await signed(e, event("checkout.session.completed", sessionObj(st, sid)));
    e.AUDITS.m.set(`founding:${sid}`, open); // a stale edge copy
    await runFlow(e, replayStep(), made[0].params);
    assert.equal(g.emails.length, 1);
    assert.equal(desk.calls[0].event, "won");
  });

  test("with no paid record anywhere the load step throws, so the Workflow retries it", async () => {
    const { e, g } = setup();
    const sid = await checkedOut(e);
    let tries = 0;
    const step = { async do(name, a, b) { const fn = typeof a === "function" ? a : b; if (name === "load") { tries++; assert.equal(a.retries.limit, 5); } return fn(); } };
    assert.equal(await runFlow(e, step, { action: "won", session: sid }), null);
    assert.equal(tries, 1);
    assert.equal(g.emails.length, 0);
  });
});

describe("GET /founding/session protects the Stripe rate limit", () => {
  const fakeId = "cs_live_" + "Q".repeat(40);

  test("a made-up id asks Stripe once, then answers from KV for 5 minutes", async () => {
    const { st, e } = setup();
    assert.equal((await get(e, `/founding/session?id=${fakeId}`)).status, 404);
    assert.equal((await get(e, `/founding/session?id=${fakeId}`)).status, 404);
    assert.equal(st.of("GET", /^\/checkout\/sessions\//).length, 1);
    assert.equal(e.AUDITS.m.has(`founding:miss:${fakeId}`), true);
  });

  test("one address past INTAKE_LIMIT never reaches Stripe", async () => {
    const { st, e } = setup({ env: { INTAKE_LIMIT: { limit: async ({ key }) => ({ success: !key.startsWith("founding-session:") }) } } });
    const sid = await checkedOut(e);
    const res = await get(e, `/founding/session?id=${sid}`);
    assert.deepEqual(await res.json(), { church: "City Reach Church", status: "open" });
    assert.equal((await get(e, `/founding/session?id=${fakeId}`)).status, 404);
    assert.equal(st.of("GET", /^\/checkout\/sessions\//).length, 0);
  });
});

describe("prices and the agreement record", () => {
  test("an archived price that still holds the lookup key hands it to the new price", async () => {
    const { st, e } = setup({ stripe: { prices: [{ id: "price_old", object: "price", lookup_key: "bs_monthly_1497", unit_amount: 149700, product: "prod_monthly", active: false }] } });
    const id = await ensurePrice(e, "12");
    assert.notEqual(id, "price_old");
    assert.equal(st.of("POST", "/prices")[0].params.transfer_lookup_key, "true");
    assert.equal(st.prices.find((p) => p.id === id).lookup_key, "bs_monthly_1497");
  });

  test("the IP hash is keyed with a secret, so hashing every address can't recover it", async () => {
    const { st, e } = setup();
    const sid = await checkedOut(e);
    const h = record(e, sid).agreement.ip_hash;
    const { sha256Hex } = await import("../src/founding.js");
    assert.notEqual(h, (await sha256Hex("bigsplash-founding|203.0.113.9")).slice(0, 32));
    assert.equal(h, (await hmacHex(STRIPE_ENV.STRIPE_SECRET_KEY, "founding-ip|203.0.113.9")).slice(0, 32));
    const keyed = setup({ env: { IP_HASH_SECRET: "a-separate-secret" } });
    const sid2 = await checkedOut(keyed.e);
    assert.notEqual(record(keyed.e, sid2).agreement.ip_hash, h);
    assert.ok(st);
  });

  test("the welcome email links the terms the church agreed to, with the version", async () => {
    const { st, e, g } = setup();
    const sid = await checkedOut(e, FORM, { origin: CHURCH_SITE });
    await signed(e, event("checkout.session.completed", sessionObj(st, sid)));
    assert.ok(g.emails[0].message.includes("Your Founding Partnership Terms (version 2026-10-20): https://bigsplash.church/founding/terms/"));
    assert.ok(g.emails[0].message.includes("Month 1 is part of your $3,500"));
    assert.ok(!g.emails[0].message.includes("paid today"));
  });
});
