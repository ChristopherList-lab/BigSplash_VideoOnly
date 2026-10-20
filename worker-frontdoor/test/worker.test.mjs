import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { FrontDoorAudit, slackText } from "../src/worker.js";
import { kv, stubFetch, jsonRes } from "./helpers.mjs";
import { fakeGhl, GHL_ENV, GHL_BASE } from "./ghl-fake.mjs";

const ORIGIN = "https://bigsplash.video";
const BASE = "https://front-door.example.workers.dev";
const form = { church: "City Reach Church", address: "2700 W Whitestone Blvd, Cedar Park, TX 78613", website: "cityreachchurch.com", name: "Pat", email: "pat@example.org" };

function makeEnv(extra = {}) {
  const flows = [];
  return { flows, AUDITS: kv(), AUDIT_FLOW: { create: async (o) => flows.push(o) }, ALLOWED_ORIGIN: ORIGIN, ...extra };
}
const post = (env, body, headers = { origin: ORIGIN }) => worker.fetch(new Request(`${BASE}/audit`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }), env);
const get = (env, path) => worker.fetch(new Request(BASE + path), env);
// The confirm page's button: a form POST with the id and token.
const approveIt = (env, id, t) => worker.fetch(new Request(`${BASE}/approve`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ id, t }).toString() }), env);

test("intake needs an allowed Origin", async () => {
  const env = makeEnv();
  assert.equal((await post(env, form, {})).status, 403);
  assert.equal((await post(env, form, { origin: "https://evil.example" })).status, 403);
  assert.equal((await post(env, form)).status, 200);
});

test("intake saves a token, passes the church to the workflow, and drops blank selects", async () => {
  const env = makeEnv();
  const r = await (await post(env, { ...form, role: "", facebook_frequency: "" })).json();
  assert.equal(r.ok, true);
  const record = JSON.parse(env.AUDITS.m.get(`audit:${r.id}`));
  assert.match(record.reviewToken, /^[0-9a-f]{32}$/);
  assert.equal(env.flows[0].params.church.name, "City Reach Church");
  const contact = JSON.parse(env.AUDITS.m.get(`contact:${r.id}`));
  assert.equal(contact.role, undefined);
  assert.equal(contact.facebook_frequency, undefined);
});

test("the hp_x7 honeypot starts nothing", async () => {
  const env = makeEnv();
  const r = await (await post(env, { ...form, hp_x7: "x" })).json();
  assert.equal(r.id, "received");
  assert.equal(env.flows.length, 0);
});

test("the same website within a day returns the audit already started", async () => {
  const env = makeEnv();
  const a = await (await post(env, form)).json();
  const b = await (await post(env, { ...form, website: "https://www.cityreachchurch.com/visit" })).json();
  assert.equal(b.id, a.id);
  assert.equal(env.flows.length, 1);
});

test("the daily cap answers 429 with Chris's email", async () => {
  const env = makeEnv({ DAILY_LIMIT: "1" });
  assert.equal((await post(env, form)).status, 200);
  const res = await post(env, { ...form, website: "other.org" });
  assert.equal(res.status, 429);
  assert.match((await res.json()).error, /chris@bigsplash\.agency/);
  assert.equal((await (await get(env, "/health")).json()).daily_limit, 1);
});

test("result: ready is public without Chris's notes; review needs the token; other states say their status", async () => {
  const env = makeEnv();
  const token = "a".repeat(32);
  const result = { church: { name: "X" }, scores: {}, possibleDuplicates: [{ name: "Y" }], reviewReasons: ["r"], google: { found: true, possibleDuplicates: [] } };
  await env.AUDITS.put("audit:x-ready1", JSON.stringify({ status: "ready", reviewToken: token, result }));
  await env.AUDITS.put("audit:x-review", JSON.stringify({ status: "review", reviewToken: token, result }));
  await env.AUDITS.put("audit:x-failed", JSON.stringify({ status: "failed", reviewToken: token }));

  const ready = await (await get(env, "/result?id=x-ready1")).json();
  assert.equal(ready.possibleDuplicates, undefined);
  assert.equal(ready.reviewReasons, undefined);
  assert.equal(ready.google.possibleDuplicates, undefined);

  let res = await get(env, "/result?id=x-review");
  assert.deepEqual([res.status, (await res.json()).status], [404, "review"]);
  res = await get(env, `/result?id=x-review&t=${"b".repeat(32)}`);
  assert.equal(res.status, 404);
  res = await get(env, `/result?id=x-review&t=${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");

  res = await get(env, "/result?id=x-failed");
  assert.deepEqual([res.status, (await res.json()).status], [404, "failed"]);
});

test("approve: right token makes it ready and emails the pastor once through GoHighLevel", async () => {
  const g = fakeGhl();
  stubFetch([[(url) => url.startsWith(GHL_BASE + "/"), (url, init) => g.route[1]({ url, method: init.method || "GET", body: init.body })]]);
  const env = makeEnv({ ...GHL_ENV });
  const token = "c".repeat(32);
  await env.AUDITS.put("audit:x-review", JSON.stringify({ status: "review", reviewToken: token, church: { name: "X", website: "https://x.org/" }, result: { scores: { overall: { grade: "B" } }, notes: { fixes: [{ title: "Do it" }] } } }));
  await env.AUDITS.put("contact:x-review", JSON.stringify({ name: "Pat Lee", email: "pat@example.org" }));

  assert.equal((await get(env, `/approve?id=x-review&t=${"d".repeat(32)}`)).status, 404);
  assert.equal((await approveIt(env, "x-review", "d".repeat(32))).status, 404);
  assert.match(await (await get(env, `/approve?id=x-review&t=${token}`)).text(), /Approve and send/);
  assert.equal(JSON.parse(env.AUDITS.m.get("audit:x-review")).status, "review", "a GET approves nothing");
  const res = await approveIt(env, "x-review", token);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /sorry for the wait/);
  assert.equal(JSON.parse(env.AUDITS.m.get("audit:x-review")).status, "ready");
  assert.deepEqual([g.emails.length, g.upserts[0].email, g.texts.length], [1, "pat@example.org", 0]);
  assert.match(g.emails[0].message, /Overall grade: B\nFirst fix on your list: Do it/);
  assert.match(await (await approveIt(env, "x-review", token)).text(), /already approved/);
  assert.match(await (await get(env, `/approve?id=x-review&t=${token}`)).text(), /already approved/);
  assert.equal(g.emails.length, 1);
});

test("a failed run is saved as failed and Slack hears about it", async () => {
  const posts = [];
  stubFetch([["https://slack.example/hook", (url, init) => { posts.push(JSON.parse(init.body).text); return jsonRes({ ok: true }); }]]);
  const env = makeEnv({ SLACK_WEBHOOK_URL: "https://slack.example/hook" });
  await env.AUDITS.put("audit:x-1", JSON.stringify({ status: "running", reviewToken: "e".repeat(32) })); // no church anywhere
  await env.AUDITS.put("contact:x-1", JSON.stringify({ name: "Pat", email: "pat@example.org" }));
  const step = { do: async (name, opts, fn) => (fn || opts)() };
  await new FrontDoorAudit({}, env).run({ payload: { id: "x-1" } }, step);
  const saved = JSON.parse(env.AUDITS.m.get("audit:x-1"));
  assert.equal(saved.status, "failed");
  assert.match(saved.error, /No church/);
  assert.match(posts[0], /Front Door Audit failed/);
  assert.match(posts[0], /pat@example\.org/);
  assert.match(posts[0], /x-1/);
});

test("Slack review text lists reasons, duplicates, not-checked areas and both links", () => {
  const result = {
    scores: { overall: { grade: null }, areas: { google: { grade: null }, reviews: { grade: null }, website: { grade: "B" }, social: { grade: "A" } } },
    reviewReasons: ["No Google listing came up for this church's name and address."],
    possibleDuplicates: [{ name: "City Reach Church", address: "3501 Hatch Rd", reviewCount: 12 }],
  };
  const text = slackText({ name: "City Reach Church" }, { name: "Pat", email: "p@x.org" }, result, "review", "city-1", "f".repeat(32), BASE);
  assert.match(text, /No Google listing came up/);
  assert.match(text, /3501 Hatch Rd \(12 reviews\)/);
  assert.match(text, /google not checked/);
  assert.match(text, /https:\/\/bigsplash\.video\/front-door\/\?id=city-1&t=f{32}/);
  assert.match(text, new RegExp(`${BASE}/approve\\?id=city-1&t=f{32}`));
});
