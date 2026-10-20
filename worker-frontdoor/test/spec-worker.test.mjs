// Spec item 9: worker.js intake, caps, dedupe, review tokens, approve, failure handling.
// Needs the cloudflare:workers stub loaded by test/hooks.mjs (see the "test" script).
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { stubFetch, html, json, xml, churchPage, ytFeed, daysAgoIso, fakeEnv, fakeStep } from "./spec-helpers.mjs";
import worker, { FrontDoorAudit } from "../src/worker.js";
import { fakeGhl, GHL_ENV } from "./ghl-fake.mjs";

const ORIGIN = "https://bigsplash.video";
const BASE = "https://bigsplash-front-door.test.workers.dev";
const UC = "UCa1b2c3d4e5f6g7h8i9j0kL";
const CR = { latitude: 30.5156, longitude: -97.8703 };
const GT = { latitude: 30.6327, longitude: -97.6772 };
const ctx = { waitUntil() {}, passThroughOnException() {} };
const form = (x = {}) => ({ church: "City Reach Church", address: "2700 W Whitestone Blvd, Cedar Park, TX 78613", website: "cityreachchurch.com", name: "Pat Rivera",
  role: "Lead pastor", email: "pat@cityreach.example", phone: "", instagram: "", facebook_frequency: "About once a week", hp_x7: "", page_url: "https://bigsplash.video/frontdoor/", utm: "", ...x });

const env = (x = {}) => fakeEnv({ WORKER_ORIGIN: BASE, GOOGLE_API_KEY: "test-places-key", ...x });
const post = (e, body, headers = { origin: ORIGIN }) => worker.fetch(new Request(`${BASE}/audit`, {
  method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9", ...headers }, body: JSON.stringify(body) }), e, ctx);
const get = (e, path) => worker.fetch(new Request(BASE + path, { headers: { "cf-connecting-ip": "203.0.113.9" } }), e, ctx);
// The confirm page's button: a form POST with the id and token.
const approveIt = (e, id, t) => worker.fetch(new Request(`${BASE}/approve`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ id, t }).toString() }), e, ctx);
const start = async (e, body = form()) => { const res = await post(e, body); assert.equal(res.status, 200, await res.clone().text()); return res.json(); };

// Run the Workflow the way Cloudflare would, with the params the intake handed it.
async function runFlow(e, flow, step = fakeStep()) {
  const instance = new FrontDoorAudit({}, e);
  try { await instance.run({ payload: flow.params, instanceId: flow.id, timestamp: new Date() }, step); } catch {}
}

function place(id, name, extra = {}) {
  return { id, displayName: { text: name }, formattedAddress: "2700 W Whitestone Blvd, Cedar Park, TX 78613, USA", location: CR, rating: 4.7, userRatingCount: 264, businessStatus: "OPERATIONAL",
    regularOpeningHours: { periods: [{ open: { day: 0, hour: 8 } }], weekdayDescriptions: ["Sunday: 8:15 AM – 12:45 PM"] }, ...extra };
}
const goodPage = churchPage({
  nav: [["/visit", "Plan a Visit"], ["/kids", "CR Kids"]], body: "<p>SERVICE TIMES SUNDAY | 8:15AM &amp; 10AM &amp; 11:45AM</p>",
  footer: `<a href="https://www.instagram.com/cityreachchurch">ig</a><a href="https://www.facebook.com/CityReachTX">fb</a><a href="https://www.youtube.com/channel/${UC}">yt</a>`,
});

// Fixtures for an audit plus the Slack hook and the GoHighLevel API.
function network({ listings, slack = [], ghl = fakeGhl() }) {
  return stubFetch([
    ["https://hooks.slack.test/T000/B000/xyz", (c) => { slack.push(c.json().text || JSON.stringify(c.json())); return new Response("ok"); }],
    ghl.route,
    [/^https:\/\/places\.googleapis\.com/, (c) => {
      const b = c.json();
      if (b.textQuery === "church") return json({ places: [{ id: "hcbc", displayName: { text: "Hill Country Bible Church" } }, { id: listings[0]?.id, displayName: listings[0]?.displayName }] });
      return json({ places: listings });
    }],
    [/pagespeedonline/, () => json({ lighthouseResult: { categories: { performance: { score: 0.91 } } } })],
    [/geocoding\.geo\.census\.gov/, (c) => json({ result: { addressMatches: /Whitestone/.test(decodeURIComponent(c.url).replace(/\+/g, " ")) ? [{ coordinates: { x: CR.longitude, y: CR.latitude } }] : [] } })],
    [/nominatim/, () => json([])],
    [/feeds\/videos\.xml/, () => xml(ytFeed([["Sunday", daysAgoIso(3.2)]]))],
    [/cityreachchurch\.com/, () => html(goodPage)],
    [/gbcgt\.org/, () => html(goodPage)],
    [/api\.anthropic\.com/, () => json({ error: { message: "no" } }, 401)],
  ]);
}
const hooks = { SLACK_WEBHOOK_URL: "https://hooks.slack.test/T000/B000/xyz", ...GHL_ENV };

describe("intake", () => {
  test("a missing Origin header is 403", async () => {
    const e = env();
    assert.equal((await post(e, form(), {})).status, 403);
    assert.equal(e.flows.length, 0);
  });

  test("a foreign Origin is 403; an allowed one starts the audit", async () => {
    const e = env();
    assert.equal((await post(e, form(), { origin: "https://evil.example" })).status, 403);
    const r = await start(e);
    assert.equal(r.ok, true);
    assert.match(r.id, /^[a-z0-9-]{6,80}$/);
    assert.equal(e.flows.length, 1);
  });

  test("hp_x7 filled starts nothing; the old company_site field no longer drops a lead", async () => {
    let e = env();
    const res = await post(e, form({ hp_x7: "https://spam.example" }));
    assert.ok(res.status < 500);
    assert.equal(e.flows.length, 0);
    e = env();
    await start(e, form({ company_site: "Acme Inc" }));
    assert.equal(e.flows.length, 1, "autofilled company_site must not discard a real pastor");
  });

  test("workflow params carry the church; the record carries a 32-hex reviewToken", async () => {
    const e = env();
    const r = await start(e);
    const params = e.flows[0].params;
    assert.equal(params.church?.name, "City Reach Church");
    assert.match(String(params.church?.website), /cityreachchurch\.com/);
    const rec = e.AUDITS.record(r.id);
    assert.ok(rec, "a KV record with a reviewToken");
    assert.match(rec.reviewToken, /^[0-9a-f]{32}$/);
    assert.equal(JSON.stringify(r).includes(rec.reviewToken), false, "intake response never carries the token");
    const other = await start(e, form({ website: "otherchurch.org" }));
    assert.notEqual(e.AUDITS.record(other.id).reviewToken, rec.reviewToken);
  });

  test("daily cap: per UTC day counter, 429 with Chris's email past the limit", async () => {
    const e = env({ DAILY_LIMIT: "2" });
    await start(e, form({ website: "one.org" }));
    await start(e, form({ website: "two.org" }));
    const res = await post(e, form({ website: "three.org" }));
    assert.equal(res.status, 429);
    assert.match(await res.text(), /We've reached today's limit\. Email chris@bigsplash\.agency and we'll run yours by hand\./);
    assert.equal(e.flows.length, 2);
    const today = new Date().toISOString().slice(0, 10);
    assert.ok([...e.AUDITS.m.keys()].some((k) => k.includes(today) || k.includes(today.replace(/-/g, ""))), [...e.AUDITS.m.keys()].join(", "));
  });

  test("health reports daily_limit, 300 by default", async () => {
    assert.equal(Number((await (await get(env(), "/health")).json()).daily_limit), 300);
    assert.equal(Number((await (await get(env({ DAILY_LIMIT: "25" }), "/health")).json()).daily_limit), 25);
  });

  test("the same website domain within 24 hours returns the existing audit", async () => {
    const e = env();
    const a = await start(e);
    const b = await start(e, form({ website: "https://www.cityreachchurch.com/visit", email: "someone@else.example" }));
    assert.deepEqual([b.id, b.url], [a.id, a.url]);
    assert.equal(e.flows.length, 1);
    assert.ok([...e.AUDITS.ttl.values()].includes(86400), `TTLs: ${[...e.AUDITS.ttl.values()]}`);
    const c = await start(e, form({ website: "gbcgt.org" }));
    assert.notEqual(c.id, a.id);
  });
});

describe("result, review and approve", () => {
  test("ready audit: public result, no token in it, Slack summary lists possible duplicates", async () => {
    const slack = [];
    network({ slack, listings: [place("cr", "City Reach Church", { websiteUri: "https://cityreachchurch.com/" }),
      place("old", "City Reach Church", { websiteUri: "https://cityreachchurch.com/", userRatingCount: 12, formattedAddress: "3501 Hatch Rd, Cedar Park, TX 78613, USA" })] });
    const e = env(hooks);
    const r = await start(e);
    let res = await get(e, `/result?id=${r.id}`);
    assert.equal(res.status, 404);
    assert.equal((await res.json()).status, "running");
    await runFlow(e, e.flows[0]);
    const token = e.AUDITS.record(r.id).reviewToken;
    res = await get(e, `/result?id=${r.id}`);
    assert.equal(res.status, 200, "ready result is public");
    const body = await res.text();
    assert.match(body, /City Reach Church/);
    assert.equal(body.includes(token), false, "reviewToken never in the result");
    assert.equal(/reviewToken/.test(body), false);
    assert.ok(slack.some((t) => /3501 Hatch Rd/.test(t)), slack.join("\n---\n"));
  });

  test("review: Slack lists reasons, not-checked grades, preview and approve links; token gates /result and /approve", async () => {
    const slack = [], ghl = fakeGhl();
    network({ slack, ghl, listings: [place("gb", "Grace Bible Church", { websiteUri: "https://gbcgt.org/", formattedAddress: "1101 Leander Rd, Georgetown, TX 78628, USA", location: GT })] });
    const e = env(hooks);
    const r = await start(e, form({ church: "Grace Bible Church", address: "Georgetown, TX" }));
    await runFlow(e, e.flows[0]);
    const rec = e.AUDITS.record(r.id);
    assert.equal(rec.status, "review");
    const token = rec.reviewToken;

    const text = slack.join("\n");
    assert.ok(rec.result?.reviewReasons?.length > 0, "reviewReasons saved with the result");
    for (const reason of rec.result?.reviewReasons || []) assert.ok(text.includes(reason), `Slack missing reason: ${reason}`);
    assert.ok(text.includes(`https://bigsplash.video/front-door/?id=${r.id}&t=${token}`), "preview link");
    assert.ok(text.includes(`${BASE}/approve?id=${r.id}&t=${token}`), "approve link");
    assert.equal(ghl.sent().length, 0, "no email or text before approval");
    assert.ok(ghl.tags.some((t) => t.tags.includes("fd-held")), "the held contact is in GoHighLevel, tagged fd-held");

    let res = await get(e, `/result?id=${r.id}`);
    assert.deepEqual([res.status, (await res.json()).status], [404, "review"]);
    res = await get(e, `/result?id=${r.id}&t=${"0".repeat(32)}`);
    assert.deepEqual([res.status, (await res.json()).status], [404, "review"]);
    res = await get(e, `/result?id=${r.id}&t=${token}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control") || "", /no-store/);
    assert.equal((await res.text()).includes(token), false);

    res = await get(e, `/approve?id=${r.id}&t=${"0".repeat(32)}`);
    assert.notEqual(res.status, 200);
    assert.equal(e.AUDITS.record(r.id).status, "review");
    res = await get(e, `/approve?id=${r.id}`);
    assert.notEqual(res.status, 200);

    res = await approveIt(e, r.id, "0".repeat(32));
    assert.notEqual(res.status, 200);
    res = await get(e, `/approve?id=${r.id}&t=${token}`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Approve and send/);
    assert.equal(e.AUDITS.record(r.id).status, "review", "the link alone approves nothing");

    res = await approveIt(e, r.id, token);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/html/);
    const page = await res.text();
    assert.match(page, /approved/i);
    assert.equal(e.AUDITS.record(r.id).status, "ready");
    assert.equal(ghl.emails.length, 1, "one email to the pastor");
    assert.match(ghl.emails[0].subject, /sorry for the wait/);
    assert.equal(ghl.upserts.at(-1).email, "pat@cityreach.example");
    assert.match(page, /sorry for the wait/);
    assert.equal((await get(e, `/result?id=${r.id}`)).status, 200, "approved audit is public");
  });

  test("approve without GoHighLevel says the email did not go out", async () => {
    const slack = [];
    network({ slack, listings: [place("gb", "Grace Bible Church", { websiteUri: "https://gbcgt.org/", location: GT })] });
    const e = env({ SLACK_WEBHOOK_URL: hooks.SLACK_WEBHOOK_URL });
    const r = await start(e, form({ church: "Grace Bible Church", address: "Georgetown, TX" }));
    await runFlow(e, e.flows[0]);
    const token = e.AUDITS.record(r.id).reviewToken;
    const res = await approveIt(e, r.id, token);
    assert.equal(res.status, 200);
    const page = await res.text();
    assert.match(page, /approved/i);
    assert.match(page, /not|no email|wasn't|didn't/i);
  });

  test("Slack review text shows not-checked grades when the website could not be checked", async () => {
    const slack = [];
    stubFetch([
      [hooks.SLACK_WEBHOOK_URL, (c) => { slack.push(c.json().text || ""); return new Response("ok"); }],
      [/^https:\/\/places\.googleapis\.com/, (c) => json({ places: c.json().textQuery === "church" ? [] : [place("cr", "City Reach Church", { websiteUri: "https://cityreachchurch.com/" })] })],
      [/cityreachchurch\.com/, () => html("<title>Just a moment...</title><p>Enable JavaScript and cookies to continue</p>", 403)],
      [/geocoding/, () => json({ result: { addressMatches: [{ coordinates: { x: CR.longitude, y: CR.latitude } }] } })],
    ]);
    const e = env({ SLACK_WEBHOOK_URL: hooks.SLACK_WEBHOOK_URL });
    await start(e);
    await runFlow(e, e.flows[0]);
    assert.match(slack.join("\n"), /not checked/i);
  });
});

describe("failures", () => {
  test("a contact read that keeps failing falls back to the contact in the workflow params", async () => {
    const slack = [];
    network({ slack, listings: [] });
    const e = env(hooks);
    const r = await start(e);
    assert.equal(e.flows[0].params.contact.email, "pat@cityreach.example");
    await runFlow(e, e.flows[0], fakeStep({ failOn: /contact/ }));
    assert.notEqual(e.AUDITS.record(r.id).status, "failed");
    assert.match(slack.join("\n"), /pat@cityreach\.example/);
  });

  const cases = [
    ["the audit step throws", { failOn: /audit/i }],
    ["the first step (loading the record) throws", { failAt: 1 }],
    ["the save step throws", { failOn: /^save$/ }],
  ];
  for (const [label, how] of cases) {
    test(`${label}: status failed, short error, Slack alert with church, contact and id`, async () => {
      const slack = [];
      network({ slack, listings: [] });
      const e = env(hooks);
      const r = await start(e);
      await runFlow(e, e.flows[0], fakeStep({ ...how, error: new Error("Places quota exceeded") }));
      const rec = e.AUDITS.record(r.id);
      assert.equal(rec.status, "failed");
      assert.ok(typeof rec.error === "string" && rec.error.length > 0 && rec.error.length < 500, "short error saved");
      const res = await get(e, `/result?id=${r.id}`);
      assert.deepEqual([res.status, (await res.json()).status], [404, "failed"]);
      const alert = slack.find((t) => /Front Door Audit failed/.test(t));
      assert.ok(alert, slack.join("\n---\n"));
      assert.match(alert, /City Reach Church/);
      assert.match(alert, /pat@cityreach\.example|Pat Rivera/);
      assert.ok(alert.includes(r.id));
    });
  }

  test("an unknown id is 404 with no status leak", async () => {
    const res = await get(env(), "/result?id=nope-123456");
    assert.equal(res.status, 404);
  });
});
