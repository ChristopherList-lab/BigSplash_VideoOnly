// The founding-church pages: the claim button on the church page, the checkout form at /church/founding/
// and the welcome page after Stripe. Each page script runs in a small fake DOM with fetch stubbed,
// so nothing here reaches the worker or Stripe.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ROOT = new URL("../../", import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), "utf8");
const church = read("church/index.html");
const founding = read("church/founding/index.html");
const welcome = read("church/founding/welcome/index.html");

const API = "https://bigsplash-front-door.chris-bc4.workers.dev";
const inlineScripts = (page) => [...page.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n;\n");
const visible = (page) => page.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "").replace(/<!--[\s\S]*?-->/g, "");
const pixelBlock = (page) => page.match(/window\.BS_TRACK = \{[\s\S]*?\}\)\(window\.BS_TRACK\);/)?.[0].replace(/\s+/g, " ");
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

// Every element with an id, starting hidden when its tag carries the hidden attribute.
function fakeDom(page) {
  const els = {};
  for (const m of page.matchAll(/<(\w+)\b([^>]*)\bid="([^"]+)"([^>]*)>/g)) {
    const attrs = m[2] + m[4];
    els[m[3]] = {
      id: m[3], tag: m[1], hidden: /\shidden(\s|$|>)/.test(attrs + " "), textContent: "", innerHTML: "", value: "", checked: false,
      className: "", disabled: false, focused: 0, on: {}, firstElementChild: { textContent: "" },
      classList: { toggle() {}, add() {}, remove() {} },
      focus() { this.focused++; }, addEventListener(type, fn) { this.on[type] = fn; }, scrollIntoView() {}, play: async () => {}, pause() {}, load() {}, setAttribute() {}, getAttribute: () => null, querySelector: () => ({ textContent: "", setAttribute() {} }),    };
  }
  return els;
}

function storage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

// routes: { "/founding/status": { status, body } | Error }. Unlisted paths reject like a dropped connection.
function run(page, { search = "", hostname = "bigsplash.video", routes = {}, session = {}, local = {}, extra = {} } = {}) {
  const els = fakeDom(page);
  const calls = [], fbq = [], gtag = [], assigned = [];
  const context = {
    document: {
      getElementById: (id) => els[id] || null, querySelector: () => null, querySelectorAll: () => [], addEventListener() {},
      createElement: () => ({ style: {} }), head: { appendChild() {} },
    },
    location: { search, hostname, href: `https://${hostname}/x/${search}`, assign: (u) => assigned.push(u), replace: (u) => assigned.push(u) },
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
      const path = new URL(url).pathname;
      const r = routes[path];
      if (!r || r instanceof Error) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(r.body), { status: r.status || 200 });
    },
    sessionStorage: storage(session), localStorage: storage(local),
    fbq: (...a) => fbq.push(a), gtag: (...a) => gtag.push(a), tailwind: {},
    IntersectionObserver: class { observe() {} unobserve() {} }, addEventListener() {}, scrollY: 0, matchMedia: () => ({ matches: false, addEventListener() {} }),
    URLSearchParams, Response, Promise, Object, String, Number, JSON, Error, TypeError, Date, Math, console, Array, setTimeout: () => 0,
    ...extra,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(inlineScripts(page), context);
  return { els, calls, fbq, gtag, assigned, context };
}

const status = (open, spots_left, total = 5) => ({ "/founding/status": { body: { open, spots_left, total, terms_version: "2026-10-20" } } });

// ---------- Church page ----------
describe("church page founding button", () => {
  test("sits under the founding rate line, hidden by default, with no number in the markup", () => {
    const line = church.indexOf("Our first 5 churches lock in $1,497. New churches after that pay $1,997.");
    const box = church.indexOf('<div id="founding-claim"');
    const audit = church.indexOf('data-cta="price-monthly"');
    assert.ok(line > 0 && box > line && audit > box, "founding rate line, then the claim box, then the audit button");
    assert.match(church, /<div id="founding-claim" class="mt-4" hidden>/);
    assert.match(church, /<a href="\/church\/founding\/\?utm_source=church_page" data-cta="price-founding" class="btn-primary w-full">Claim a founding spot /);
    assert.match(church, /<p id="founding-left"[^>]*><\/p>/);
    assert.match(church, /\[hidden\] \{ display: none !important; \}/);
  });

  test("open with spots left: shows the button and 'N of 5 founding spots left'", async () => {
    const r = run(church, { routes: status(true, 3) });
    await tick();
    assert.deepEqual(r.calls.map((c) => c.url), [`${API}/founding/status`]);
    assert.equal(r.els["founding-claim"].hidden, false);
    assert.equal(r.els["founding-left"].textContent, "3 of 5 founding spots left");
  });

  for (const [label, routes] of [
    ["checkout off", status(false, 5)],
    ["spots full", status(false, 0)],
    ["open but zero left", status(true, 0)],
    ["a count above the total", status(true, 7)],
    ["a count as text", { "/founding/status": { body: { open: true, spots_left: "3", total: 5 } } }],
    ["a server error", { "/founding/status": { status: 500, body: { open: true, spots_left: 3, total: 5 } } }],
    ["no connection", {}],
  ]) {
    test(`stays hidden with no number: ${label}`, async () => {
      const r = run(church, { routes });
      await tick();
      assert.equal(r.els["founding-claim"].hidden, true);
      assert.equal(r.els["founding-left"].textContent, "");
    });
  }

  test("?api= switches the worker on localhost only", async () => {
    let r = run(church, { hostname: "localhost", search: "?api=http://localhost:8787", routes: {} });
    assert.equal(r.calls[0].url, "http://localhost:8787/founding/status");
    r = run(church, { hostname: "bigsplash.video", search: "?api=https://evil.example", routes: {} });
    assert.equal(r.calls[0].url, `${API}/founding/status`);
  });
});

// ---------- Founding page ----------
const filled = { church: "Grace Bible Church", name: "Sam Lee", role: "Lead pastor", email: "sam@gracebible.org", phone: "512-555-0100", website: "gracebible.org" };

// The founding form, with its elements sharing objects with getElementById as in a browser. term is the radio group.
function runFoundingWithForm(opts = {}) {
  const els = fakeDom(founding);
  const elements = {};
  for (const n of ["church", "name", "role", "email", "phone", "website", "hp_x7", "agree_terms", "agree_authorized"]) elements[n] = els[n];
  elements.term = { value: "12" };
  els["founding-form"].elements = elements;
  const calls = [], fbq = [], assigned = [];
  const session = storage(opts.session || {});
  const context = {
    document: { getElementById: (id) => els[id] || null, createElement: () => ({ style: {} }), head: { appendChild() {} } },
    location: { search: opts.search || "", hostname: opts.hostname || "bigsplash.video", assign: (u) => assigned.push(u), replace: (u) => assigned.push(u) },
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
      const r = (opts.routes || {})[new URL(url).pathname];
      if (!r) throw new TypeError("Failed to fetch");
      return new Response(JSON.stringify(r.body), { status: r.status || 200 });
    },
    sessionStorage: session, fbq: (...a) => fbq.push(a), tailwind: {},
    URLSearchParams, Response, Promise, Object, String, Number, JSON, Error, TypeError, Date, console, Array,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(inlineScripts(founding), context);
  const submit = async () => { await els["founding-form"].on.submit({ preventDefault() {} }); await tick(); };
  return { els, elements, calls, fbq, assigned, session, submit };
}

describe("founding page: status", () => {
  test("open: shows the form and the spots left, hides the other panels", async () => {
    const p = runFoundingWithForm({ routes: status(true, 2) });
    assert.equal(p.els["checkout-loading"].hidden, false, "loading line shows first");
    assert.equal(p.els["founding-form"].hidden, true);
    await tick();
    assert.equal(p.els["founding-form"].hidden, false);
    assert.equal(p.els["spots-left"].hidden, false);
    assert.equal(p.els["spots-left-text"].textContent, "2 of 5 founding spots left");
    for (const id of ["checkout-loading", "checkout-full", "checkout-closed"]) assert.equal(p.els[id].hidden, true, id);
  });

  test("no spots left: 'Founding spots are full' with Book a call with our team", async () => {
    const p = runFoundingWithForm({ routes: status(false, 0) });
    await tick();
    assert.equal(p.els["checkout-full"].hidden, false);
    assert.equal(p.els["founding-form"].hidden, true);
    assert.equal(p.els["spots-left"].hidden, true);
    const full = founding.match(/<div id="checkout-full" hidden>([\s\S]*?)<\/div>/)[1];
    assert.match(full, /Founding spots are full/);
    assert.match(full, /<button type="button" data-open-intake data-intake-service="Church" class="btn-primary w-full mt-6">Book a call with our team<\/button>/);
  });

  for (const [label, routes] of [["checkout off", status(false, 5)], ["no connection", {}], ["a bad count", status(true, 9)]]) {
    test(`closed without calling it full: ${label}`, async () => {
      const p = runFoundingWithForm({ routes });
      await tick();
      assert.equal(p.els["checkout-closed"].hidden, false);
      assert.equal(p.els["checkout-full"].hidden, true);
      assert.equal(p.els["founding-form"].hidden, true);
      assert.equal(p.els["spots-left-text"].textContent, "");
    });
  }

  test("?api= switches the worker on localhost only", () => {
    assert.equal(runFoundingWithForm({ hostname: "127.0.0.1", search: "?api=http://localhost:8787" }).calls[0].url, "http://localhost:8787/founding/status");
    assert.equal(runFoundingWithForm({ search: "?api=http://localhost:8787" }).calls[0].url, `${API}/founding/status`);
  });
});

describe("founding page: checkout", () => {
  const ok = { ...status(true, 3), "/founding/checkout": { body: { ok: true, url: "https://checkout.stripe.com/c/pay/cs_test_abc" } } };

  test("posts the form, the term, both agreements, audit_id and utm, then goes to Stripe", async () => {
    const p = runFoundingWithForm({ routes: ok, search: "?audit_id=grace-bible-church-1a2b3c4d&utm_source=church_page&utm_campaign=oct" });
    await tick();
    for (const [k, v] of Object.entries(filled)) p.elements[k].value = `  ${v} `;
    p.elements.agree_terms.checked = true;
    p.elements.agree_authorized.checked = true;
    p.elements.term.value = "6";
    await p.submit();
    const post = p.calls.find((c) => c.method === "POST");
    assert.equal(post.url, `${API}/founding/checkout`);
    assert.deepEqual(post.body, { ...filled, term: "6", agree_terms: "yes", agree_authorized: "yes", audit_id: "grace-bible-church-1a2b3c4d", utm: "utm_source=church_page&utm_campaign=oct" });
    assert.deepEqual(p.assigned, ["https://checkout.stripe.com/c/pay/cs_test_abc"]);
    assert.deepEqual(JSON.parse(p.session.getItem("bs_founding_draft")), { ...filled, term: "6" });
    assert.deepEqual(JSON.parse(JSON.stringify(p.fbq)), [["track", "InitiateCheckout", { value: 3500, currency: "USD" }]]);
    assert.equal(p.els["checkout-button"].disabled, true);
  });

  test("prices never leave the page: the post carries no amount", async () => {
    const p = runFoundingWithForm({ routes: ok });
    await tick();
    for (const [k, v] of Object.entries(filled)) p.elements[k].value = v;
    p.elements.agree_terms.checked = p.elements.agree_authorized.checked = true;
    await p.submit();
    const body = p.calls.find((c) => c.method === "POST").body;
    assert.equal(body.term, "12");
    assert.equal(Object.keys(body).some((k) => /amount|price|total/.test(k)), false);
    assert.equal("audit_id" in body || "utm" in body || "hp_x7" in body, false);
  });

  test("an audit_id with odd characters is cleaned before it is sent", async () => {
    const p = runFoundingWithForm({ routes: ok, search: "?audit_id=abc%3Cscript%3E-12" });
    await tick();
    for (const [k, v] of Object.entries(filled)) p.elements[k].value = v;
    p.elements.agree_terms.checked = p.elements.agree_authorized.checked = true;
    await p.submit();
    assert.equal(p.calls.find((c) => c.method === "POST").body.audit_id, "abcscript-12");
  });

  for (const [label, change, message, focus] of [
    ["the terms box", (e) => { e.agree_terms.checked = false; }, "Check the box to agree to the Founding Partnership Terms.", "agree_terms"],
    ["the authorized box", (e) => { e.agree_authorized.checked = false; }, "Check the box to confirm you can sign for your church.", "agree_authorized"],
    ["a blank church", (e) => { e.church.value = " "; }, "Please fill in every field.", "church"],
    ["no role", (e) => { e.role.value = ""; }, "Please fill in every field.", "role"],
    ["a bad email", (e) => { e.email.value = "sam@"; }, "Check your email address.", "email"],
    ["a short phone", (e) => { e.phone.value = "555-0100"; }, "Add a cell number with the area code.", "phone"],
  ]) {
    test(`stops before posting: ${label}`, async () => {
      const p = runFoundingWithForm({ routes: ok });
      await tick();
      for (const [k, v] of Object.entries(filled)) p.elements[k].value = v;
      p.elements.agree_terms.checked = p.elements.agree_authorized.checked = true;
      change(p.elements);
      await p.submit();
      assert.equal(p.calls.some((c) => c.method === "POST"), false);
      assert.equal(p.els["form-error"].textContent, message);
      assert.equal(p.elements[focus].focused, 1);
      assert.deepEqual(p.assigned, []);
    });
  }

  for (const [label, reply, expect] of [
    ["a server message", { status: 400, body: { ok: false, error: "Please check the church website." } }, "Please check the church website. If it keeps happening, email chris@bigsplash.agency."],
    ["a reply without a Stripe link", { body: { ok: true, url: "javascript:alert(1)" } }, "Something went wrong. If it keeps happening, email chris@bigsplash.agency."],
  ]) {
    test(`shows an error and re-enables the button: ${label}`, async () => {
      const p = runFoundingWithForm({ routes: { ...status(true, 3), "/founding/checkout": reply } });
      await tick();
      for (const [k, v] of Object.entries(filled)) p.elements[k].value = v;
      p.elements.agree_terms.checked = p.elements.agree_authorized.checked = true;
      await p.submit();
      assert.equal(p.els["form-error"].textContent, expect);
      assert.equal(p.els["checkout-button"].disabled, false);
      assert.match(p.els["checkout-button"].innerHTML, /Continue to secure checkout$/);
      assert.deepEqual(p.assigned, []);
    });
  }

  test("a dropped connection gets plain words", async () => {
    const p = runFoundingWithForm({ routes: status(true, 3) });
    await tick();
    for (const [k, v] of Object.entries(filled)) p.elements[k].value = v;
    p.elements.agree_terms.checked = p.elements.agree_authorized.checked = true;
    await p.submit();
    assert.equal(p.els["form-error"].textContent, "We couldn't reach checkout. Check your connection and try again, or email chris@bigsplash.agency.");
  });

  test("a 409 (the last spot went) checks the spots again", async () => {
    const p = runFoundingWithForm({ routes: { ...status(true, 1), "/founding/checkout": { status: 409, body: { ok: false, error: "Founding spots are full" } } } });
    await tick();
    for (const [k, v] of Object.entries(filled)) p.elements[k].value = v;
    p.elements.agree_terms.checked = p.elements.agree_authorized.checked = true;
    await p.submit();
    assert.equal(p.calls.filter((c) => c.url.endsWith("/founding/status")).length, 2);
  });

  test("the authorized box names the church as it is typed", async () => {
    const p = runFoundingWithForm({ routes: ok });
    assert.equal(p.els["authorized-church"].textContent, "");
    p.elements.church.value = "Grace Bible Church";
    p.elements.church.on.input();
    assert.equal(p.els["authorized-church"].textContent, "Grace Bible Church");
    p.elements.church.value = "  ";
    p.elements.church.on.input();
    assert.equal(p.els["authorized-church"].textContent, "my church");
  });

  test("?canceled=1 says nothing was charged and brings the details back", async () => {
    const draft = JSON.stringify({ ...filled, term: "6" });
    const p = runFoundingWithForm({ routes: ok, search: "?canceled=1", session: { bs_founding_draft: draft } });
    assert.equal(p.els["canceled-note"].hidden, false);
    assert.equal(p.elements.church.value, "Grace Bible Church");
    assert.equal(p.elements.term.value, "6");
    assert.equal(p.els["canceled-more"].textContent, "Your details are below whenever you're ready.");
    assert.equal(p.els["authorized-church"].textContent, "Grace Bible Church");
    assert.match(founding, /You left checkout, and nothing was charged\. <span id="canceled-more">Start again below whenever you're ready\.<\/span>/);
    const plain = runFoundingWithForm({ routes: ok });
    assert.equal(plain.els["canceled-note"].hidden, true);
  });
});

describe("founding page: markup", () => {
  test("the two required boxes, the terms link and the checkout button", () => {
    assert.match(founding, /<input type="checkbox" id="agree_terms" name="agree_terms" value="yes" required><span>I agree to the <a href="\/church\/founding\/terms\/" target="_blank" rel="noopener">Founding Partnership Terms<\/a><\/span>/);
    assert.match(founding, /<input type="checkbox" id="agree_authorized" name="agree_authorized" value="yes" required><span>I'm authorized to sign for <span id="authorized-church">my church<\/span><\/span>/);
    assert.match(founding, />Continue to secure checkout<\/button>/);
    assert.match(founding, /<a href="\/church\/founding\/terms\/" class="font-semibold text-ink underline underline-offset-4">Read the full Founding Partnership Terms<\/a>/);
  });

  test("the term choice: 12 months at $1,497 (checked) or 6 at $1,697, month 1 included", () => {
    assert.match(founding, /<input type="radio" name="term" value="12" checked><span><b[^>]*>12 months at \$1,497\/month<\/b>/);
    assert.match(founding, /<input type="radio" name="term" value="6"><span><b[^>]*>6 months at \$1,697\/month<\/b>/);
    assert.equal((founding.match(/Month 1 included in your \$3,500/g) || []).length, 2);
  });

  test("the form fields and their caps", () => {
    for (const [name, max] of [["church", 120], ["name", 80], ["email", 120], ["phone", 30], ["website", 200]]) {
      assert.match(founding, new RegExp(`<input[^>]*name="${name}"[^>]*required maxlength="${max}"`), name);
    }
    assert.match(founding, /<select class="field" id="role" name="role" required><option value="" selected disabled>Choose one<\/option>/);
  });

  test("what a founding church gets, and the church page's one month-to-month price", () => {
    // The church page moved to one price with filming quoted separately (2026-10-20). The founding
    // checkout still sells the old build and term, and stays off until it is reworked to match.
    for (const item of ["A full day of filming at your church", "5 finished videos: your pastor's invitation, a member testimony, the Sunday experience, kids ministry and a first-visit walkthrough",
      "Your own plan-your-visit page", "Follow-up texts and emails, written and loaded", "Your Facebook and Instagram campaign, set up and ready to launch"]) {
      assert.ok(founding.includes(item), item);
    }
    assert.ok(church.includes("Your own plan-your-visit page"));
    assert.match(church, /<s class="price-was tnum"><span class="sr-only">Regular rate <\/span>\$1,997<\/s>/);
    assert.match(church, /Month to month\. Cancel with 30 days notice\./);
    assert.match(church, /Filming at your church<\/h3>\s*<p[^>]*>Custom quote<\/p>/);
    for (const old of ["$4,500", "$3,500", "$2,497", "$1,697", "6 or 12"]) assert.ok(!church.includes(old), `church page still says ${old}`);
    for (const term of ["Your term starts the day your campaign launches.", "can cancel with 30 days notice.", "Everything we build for your church stays yours.", "We never promise a set number of families."]) {
      assert.ok(founding.includes(term), term);
    }
    assert.match(founding, /\$3,500/);
    assert.match(founding, /<s>\$4,500<\/s>/);
  });

  test("Book a call with our team opens the shared modal", () => {
    const labels = [...founding.matchAll(/<button\b[^>]*data-open-intake data-intake-service="Church"[^>]*>([^<]*)<\/button>/g)].map((m) => m[1]);
    assert.ok(labels.length >= 3);
    for (const l of labels) assert.equal(l, "Book a call with our team");
    assert.match(founding, /<script src="\.\.\/\.\.\/js\/intake\.js"><\/script>/);
  });
});

// ---------- Welcome page ----------
describe("welcome page", () => {
  const S = "cs_test_a1B2c3D4e5";
  const session = (status, church = "Grace Bible Church") => ({ "/founding/session": { body: { church, status } } });

  test("paid: names the church, says payment received, fires Purchase once with 3500 USD", async () => {
    const r = run(welcome, { search: `?session=${S}`, routes: session("paid") });
    await tick();
    assert.deepEqual(r.calls.map((c) => c.url), [`${API}/founding/session?id=${S}`]);
    assert.equal(r.els["welcome-title"].textContent, "Welcome to the partnership, Grace Bible Church");
    assert.equal(r.els["pay-status-title"].textContent, "Payment received");
    assert.equal(r.els["pay-status"].className, "status good");
    assert.deepEqual(JSON.parse(JSON.stringify(r.fbq)), [["track", "Purchase", { value: 3500, currency: "USD", content_name: "Founding campaign build" }, { eventID: S }]]);
    assert.deepEqual(JSON.parse(JSON.stringify(r.gtag)), [["event", "purchase", { transaction_id: S, value: 3500, currency: "USD" }]]);
    assert.equal(r.context.localStorage.getItem(`bs_purchase_${S}`), "1");
    assert.equal(r.els.retry.hidden, true);
  });

  test("a reload of the same checkout does not fire Purchase again", async () => {
    const r = run(welcome, { search: `?session=${S}`, routes: session("paid"), local: { [`bs_purchase_${S}`]: "1" } });
    await tick();
    assert.equal(r.els["pay-status-title"].textContent, "Payment received");
    assert.deepEqual(r.fbq, []);
  });

  test("processing: bank payment processing, Purchase fires", async () => {
    const r = run(welcome, { search: `?session=${S}`, routes: session("processing") });
    await tick();
    assert.equal(r.els["pay-status-title"].textContent, "Bank payment processing");
    assert.match(r.els["pay-status-text"].textContent, /Bank payments take a few business days to clear\./);
    assert.equal(r.fbq.length, 1);
  });

  for (const [st, title] of [["open", "Your checkout isn't finished"], ["expired", "This checkout expired"], ["failed", "Your bank payment didn't go through"]]) {
    test(`${st}: offers the way back, no Purchase, no welcome and no kickoff booking`, async () => {
      const r = run(welcome, { search: `?session=${S}`, routes: session(st) });
      await tick();
      assert.equal(r.els["pay-status-title"].textContent, title);
      assert.equal(r.els.retry.hidden, false);
      assert.equal(r.els["welcome-title"].textContent, "Your founding spot isn't claimed yet");
      assert.equal(r.els.lede.textContent, "Finish checkout to hold your spot, or book a call with our team.");
      assert.equal(r.els.next.hidden, true);
      assert.deepEqual(r.fbq, []);
    });
  }

  for (const [label, search, routes] of [
    ["no session", "", session("paid")],
    ["a session id that is not Stripe's", "?session=abc", session("paid")],
    ["a failed lookup", `?session=${S}`, { "/founding/session": { status: 404, body: { error: "not found" } } }],
    ["no connection", `?session=${S}`, {}],
    ["an unknown status", `?session=${S}`, session("weird")],
  ]) {
    test(`no Purchase and a calm note: ${label}`, async () => {
      const r = run(welcome, { search, routes });
      await tick();
      assert.deepEqual(r.fbq, []);
      assert.match(r.els["pay-status-title"].textContent, /^We couldn't (find your checkout|load your payment status)$/);
      if (!search.startsWith(`?session=${S}`)) assert.deepEqual(r.calls, []);
    });
  }

  test("the church name only ever goes in as text", () => {
    const js = inlineScripts(welcome);
    assert.equal(/innerHTML|insertAdjacentHTML|document\.write/.test(js), false);
  });

  test("next steps, the kickoff calendar and noindex", () => {
    assert.match(welcome, /<meta name="robots" content="noindex">/);
    assert.match(welcome, /<a class="btn" id="kickoff" href="https:\/\/api\.leadconnectorhq\.com\/widget\/booking\/YcBm4L2c5a0DNBZyessz" target="_blank" rel="noopener">Book your kickoff call /);
    for (const step of ["Book your kickoff call", "Your filming day", "Gather a few things before the call", "Launch day"]) assert.ok(welcome.includes(`<h3>${step}</h3>`), step);
    assert.match(welcome, /href="\/church\/founding\/terms\/"/);
    assert.match(welcome, /<a class="ghost" href="\/church\/founding\/">Back to founding checkout<\/a>/);
  });
});

// ---------- Shared ----------
describe("founding pages: tracking, theme and words", () => {
  test("both pages carry the church page's Pixel and GA4 block with empty IDs", () => {
    const base = pixelBlock(church);
    assert.ok(base);
    assert.equal(pixelBlock(founding), base);
    assert.equal(pixelBlock(welcome), base);
    assert.match(base, /META_PIXEL_ID: '', GA4_ID: ''/);
  });

  test("both pages use the worker URL and the light church theme", () => {
    for (const page of [founding, welcome]) {
      assert.ok(page.includes(`const PROD_API = '${API}';`));
      assert.match(page, /#f8f5ee/);
      assert.match(page, /logo-bigsplash-dark\.svg/);
      assert.match(page.slice(page.lastIndexOf("<footer")), /href="\/privacy\/"/);
      assert.match(page.slice(page.lastIndexOf("<footer")), /Georgetown, TX/);
    }
  });

  test("pastor-facing words follow Chris's writing rules", () => {
    for (const [name, page] of [["church", church], ["founding", founding], ["welcome", welcome]]) {
      const text = visible(page);
      assert.equal(/—|&mdash;/.test(text), false, `${name}: em dash`);
      assert.equal(/\bholy\b/i.test(text), false, `${name}: holy`);
    }
    for (const [name, page] of [["founding", founding], ["welcome", welcome]]) {
      const text = visible(page) + "\n" + [...inlineScripts(page).matchAll(/'([^'\n]{12,})'|"([^"\n]{12,})"|`([^`\n]{12,})`/g)].map((m) => m[1] || m[2] || m[3]).join("\n");
      assert.equal(/\b(really|just|actually|simply|honestly|literally|genuinely|truly|deeply)\b/i.test(text), false, `${name}: adverb`);
      assert.equal(/(^|[.!?>]\s*)(What|When|Where|Which|Who|Why|How)\b/.test(text), false, `${name}: question-word opener`);
      assert.equal(/\bnot\b[^.]{0,40}\bbut\b/i.test(text), false, `${name}: not X but Y`);
      assert.equal(/Talk to Chris|Message Chris|call with Chris/.test(text), false, `${name}: booking wording`);
    }
  });
});

// ---------- Review fixes: states, billing words and the terms ----------
describe("founding pages: review fixes", () => {
  const terms = read("church/founding/terms/index.html");

  test("the hero claim button shows only while checkout is open; full turns the card into a booking card", async () => {
    assert.match(founding, /<p id="hero-claim" class="mt-6 lg:hidden" hidden>/);
    const open = runFoundingWithForm({ routes: status(true, 2) });
    await tick();
    assert.equal(open.els["hero-claim"].hidden, false);
    assert.equal(open.els["claim-title"].textContent, "Claim your founding spot");
    const full = runFoundingWithForm({ routes: status(false, 0) });
    await tick();
    assert.equal(full.els["hero-claim"].hidden, true);
    assert.equal(full.els["claim-title"].textContent, "Book a call with our team");
    const closed = runFoundingWithForm({ routes: status(false, 5) });
    await tick();
    assert.equal(closed.els["hero-claim"].hidden, true);
  });

  test("billing starts 30 days after launch everywhere, with the payment count on each term", () => {
    for (const page of [founding, welcome]) assert.equal(/one month after/.test(visible(page)), false);
    assert.match(founding, /monthly billing starts 30 days after your campaign launches/);
    assert.match(welcome, /Monthly billing starts 30 days after your campaign launches/);
    assert.match(founding, /12 months at \$1,497\/month<\/b><span[^>]*>Month 1 included in your \$3,500, then 11 monthly payments</);
    assert.match(founding, /6 months at \$1,697\/month<\/b><span[^>]*>Month 1 included in your \$3,500, then 5 monthly payments</);
    assert.match(founding, /Your first monthly payment comes 30 days after your campaign launches\./);
  });

  test("the plain-words summary says how to cancel before filming and that the term is a commitment", () => {
    assert.match(founding, /Before your filming day, you can cancel by email for a refund of the \$3,500, minus Stripe's processing fee\. After filming, your church commits to the full term it chose\./);
  });

  test("the welcome page asks for the Meta ad account too", () => {
    assert.match(welcome, /Admin access to your church's Facebook page and Meta ad account/);
  });

  test("the terms summary covers stopping after the term, and section 9 says what the term costs", () => {
    const short = terms.match(/<h2>In short<\/h2>([\s\S]*?)<\/ul>/)[1];
    assert.match(short, /After your term, the partnership continues month to month at the same rate\. Either side can stop with 30 days notice by email\./);
    assert.match(terms, /commits to the full term it chose and pays each monthly fee through the term's last month\./);
    const text = visible(terms);
    assert.equal(/—|&mdash;/.test(text), false);
    assert.equal(/\bholy\b/i.test(text), false);
    assert.equal(/\b(really|just|actually|simply|honestly|literally|genuinely|truly|deeply)\b/i.test(text), false);
    // The setup note never repeats the tag text, so a search for it finds only the tags on the page.
    assert.equal(/CHRIS TO CONFIRM/.test(terms.match(/<!--[\s\S]*?-->/)[0]), false);
  });
});
