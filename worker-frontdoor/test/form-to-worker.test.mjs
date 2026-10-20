// The landing form's real script posts to the real worker: every field the pastor fills in (attendance,
// text consent, phone, campaign tags) lands in the saved contact and the audit Workflow's params.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/worker.js";
import { kv } from "./helpers.mjs";
import { runLanding } from "./landing-dom.mjs";

const ORIGIN = "https://bigsplash.video";
const landing = readFileSync(new URL("../../frontdoor/index.html", import.meta.url), "utf8");
const filled = { church: "Grace Bible Church", address: "1 Main St, Georgetown, TX 78626", website: "gracebible.org", attendance: "250 to 499",
  name: "Sam Lee", role: "Lead pastor", email: "sam@gracebible.org", phone: "", instagram: "@gracebible", facebook_frequency: "About once a week" };

// Submits the form in the fake DOM, then hands the exact JSON body to worker.fetch.
async function submitThrough(fields, search) {
  const page = runLanding({ fields, search });
  if (fields.sms_consent) page.toggleConsent(true);
  await page.submit();
  assert.equal(page.posts.length, 1, page.err.textContent);
  const flows = [];
  const env = { AUDITS: kv(), AUDIT_FLOW: { create: async (o) => flows.push(o) }, ALLOWED_ORIGIN: ORIGIN };
  const res = await worker.fetch(new Request("https://front-door.example.workers.dev/audit", {
    method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify(page.posts[0].body) }), env);
  const reply = await res.json();
  assert.equal(reply.ok, true, reply.error);
  return { body: page.posts[0].body, contact: JSON.parse(env.AUDITS.m.get(`contact:${reply.id}`)), flow: flows[0] };
}

test("every named form field is one the worker reads", () => {
  const names = [...landing.matchAll(/<(?:input|select|textarea)[^>]*\bname="([^"]+)"/g)].map((m) => m[1]);
  const src = readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
  const limits = src.match(/const LIMITS = \{([^}]*)\}/)[1];
  const read = new Set([...limits.matchAll(/(\w+):/g)].map((m) => m[1]).concat(["sms_consent", "hp_x7"]));
  assert.deepEqual(names.filter((n) => !read.has(n)), []);
  for (const n of ["attendance", "sms_consent", "phone", "hp_x7"]) assert.ok(names.includes(n), n);
});

test("checked box with a cell: the contact says texts OK, with phone, attendance and campaign tags", async () => {
  const { contact, flow } = await submitThrough({ ...filled, phone: "512-555-0142", sms_consent: true },
    "?utm_source=facebook&utm_medium=paid&utm_campaign=oct30&utm_content=v1");
  assert.equal(contact.sms_consent, true);
  assert.equal(contact.phone, "512-555-0142");
  assert.equal(contact.attendance, "250 to 499");
  assert.equal(contact.role, "Lead pastor");
  assert.equal(contact.facebook_frequency, "About once a week");
  assert.deepEqual(contact.utm, { source: "facebook", medium: "paid", campaign: "oct30", content: "v1" });
  assert.match(contact.page_url, /^https:\/\/bigsplash\.video\/frontdoor\//);
  assert.deepEqual(flow.params.contact, contact);
  assert.equal(flow.params.church.instagram, "gracebible");
});

test("unchecked box: no texts, even with a phone number", async () => {
  const { body, contact } = await submitThrough({ ...filled, phone: "512-555-0142" });
  assert.equal("sms_consent" in body, false);
  assert.equal(contact.sms_consent, false);
  assert.equal(contact.phone, "512-555-0142");
});

test("a campaign name with & or = survives the trip as one value", async () => {
  const { contact } = await submitThrough(filled, "?utm_source=facebook&utm_campaign=" + encodeURIComponent("fall & winter=2026"));
  assert.equal(contact.utm.source, "facebook");
  assert.equal(contact.utm.campaign, "fall & winter=2026");
});
