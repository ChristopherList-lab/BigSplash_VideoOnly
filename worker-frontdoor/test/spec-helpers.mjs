// Shared helpers for the spec tests: a fake network, fake Cloudflare bindings and church page fixtures.
// Nothing here touches the real network.

export const DAY = 86400000;

// Every AbortSignal.timeout(ms) call is recorded, so tests can check the timeout each fetch got.
export const timeouts = [];
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = (ms) => { timeouts.push(ms); return realTimeout(ms); };

// Read a fetch call the way a server would see it, whether the code passed a URL, a string or a Request.
async function readCall(input, init = {}) {
  const req = typeof Request !== "undefined" && input instanceof Request ? input : null;
  const url = req ? req.url : String(input);
  const headers = new Headers(init.headers || (req ? req.headers : undefined));
  let body = init.body;
  if (body === undefined && req) body = await req.clone().text();
  if (body !== undefined && typeof body !== "string") body = String(body);
  const method = (init.method || (req && req.method) || "GET").toUpperCase();
  return { url, method, headers, body, signal: init.signal || (req ? req.signal : undefined), redirect: init.redirect || (req ? req.redirect : "follow"),
    json() { return JSON.parse(body || "{}"); } };
}

const netError = (code = "ENOTFOUND") => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });
export const dnsError = () => netError("ENOTFOUND");
export const resetError = () => netError("ECONNRESET");
export const timeoutError = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

// One permanent global fetch that forwards to the current stub, so a client that saved a reference
// to fetch at import time still hits the fixtures. Before any stub, every request fails like a DNS miss.
let current = async () => { throw dnsError(); };
globalThis.fetch = (input, init) => current(input, init);

// routes: [[match, handler]]; match is a full URL string, a RegExp or (call) => bool.
// handler(call) returns a Response (or a promise of one), or throws. An Error value is thrown as is.
// Unrouted URLs fail like a DNS miss. 3xx with Location is followed unless the caller asked for redirect: "manual".
export function stubFetch(routes) {
  const calls = [];
  current = async (input, init) => {
    let call = await readCall(input, init);
    for (let hop = 0; hop < 10; hop++) {
      calls.push(call);
      const route = routes.find(([m]) => (typeof m === "string" ? call.url === m : m instanceof RegExp ? m.test(call.url) : m(call)));
      if (!route) throw dnsError();
      const h = route[1];
      if (h instanceof Error || h instanceof DOMException) throw h;
      let res = await h(call);
      if (!(res instanceof Response)) throw new Error("fixture returned no Response for " + call.url);
      const loc = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && loc && call.redirect !== "manual") {
        call = { ...call, url: new URL(loc, call.url).href, method: "GET", body: undefined };
        continue;
      }
      Object.defineProperty(res, "url", { value: call.url });
      if (hop > 0) Object.defineProperty(res, "redirected", { value: true });
      return res;
    }
    throw new TypeError("redirect loop");
  };
  return calls;
}

export function html(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
}
export const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
export const xml = (body) => new Response(body, { status: 200, headers: { "content-type": "application/xml; charset=utf-8" } });
export const redirect = (to, status = 301) => new Response(null, { status, headers: { location: to } });

// An iPhone Safari user agent, the way the spec asks the audit to fetch.
export const isIphone = (call) => /iPhone/.test(call.headers.get("user-agent") || "") && /Safari/.test(call.headers.get("user-agent") || "");

// Neutral page content: enough text and links that a page is never mistaken for a JavaScript shell,
// and no words that would trip the plan-visit, kids, times, social or sermon checks.
const NEUTRAL_LINKS = [["/about", "About Us"], ["/staff", "Our Staff"], ["/give", "Give"], ["/events", "Events"], ["/contact", "Contact"], ["/beliefs", "What We Believe"], ["/prayer", "Prayer"]];
const NEUTRAL_TEXT = "We are a church in Georgetown that loves Jesus and our neighbors. Our staff and members serve in local food pantries and nursing homes throughout the year. " +
  "Every gift supports missions here and around the world. Reach out with questions or prayer requests and someone from our staff will answer within a day. ";

// A realistic church home page. nav: [[href, text]] links; body: extra HTML; head: replaces the default viewport tag.
export function churchPage({ title = "Home | Test Church", nav = [], body = "", head = '<meta name="viewport" content="width=device-width, initial-scale=1">', footer = "" } = {}) {
  const navHtml = [...nav, ...NEUTRAL_LINKS].map(([href, text]) => `<li class="menu-item"><a href="${href}">${text}</a></li>`).join("\n        ");
  return `<!DOCTYPE html>
<html lang="en-US">
<head>
  <meta charset="UTF-8">
  ${head}
  <title>${title}</title>
  <link rel="stylesheet" href="/wp-content/themes/church/style.css?ver=6.4">
  <script src="/wp-includes/js/jquery/jquery.min.js"></script>
</head>
<body class="home page-template-default">
  <header class="site-header">
    <a class="logo" href="/"><img src="/logo.png" alt="Test Church"></a>
    <nav class="main-navigation"><ul id="menu-main">
        ${navHtml}
    </ul></nav>
  </header>
  <main>
    <section class="hero"><h2>Love God. Love people.</h2><p>${NEUTRAL_TEXT}</p></section>
    ${body}
    <section class="about"><p>${NEUTRAL_TEXT}</p></section>
  </main>
  <footer class="site-footer"><p>1 Main St, Georgetown, TX 78626</p>${footer}<p>&copy; 2026 Test Church</p></footer>
</body>
</html>`;
}

export function ytFeed(entries) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns="http://www.w3.org/2005/Atom">
 <title>Test Church</title>
 ${entries.map(([title, iso], i) => `<entry><id>yt:video:v${i}</id><yt:videoId>v${i}</yt:videoId><title>${title}</title><published>${iso}</published><updated>${iso}</updated></entry>`).join("\n ")}
</feed>`;
}

export function vimeoFeed(items) {
  return `<?xml version="1.0" encoding="utf-8"?>
<rss version="2.0"><channel><title>Test Church on Vimeo</title>
${items.map(([title, date]) => `<item><title>${title}</title><pubDate>${date}</pubDate><link>https://vimeo.com/1</link></item>`).join("\n")}
</channel></rss>`;
}

export const daysAgoIso = (d) => new Date(Date.now() - d * DAY).toISOString();
export const daysAgoRfc = (d) => new Date(Date.now() - d * DAY).toUTCString();

// Workers KV, in memory. Records expirationTtl so tests can check the 24 h dedupe key.
export function fakeKV() {
  const m = new Map();
  const ttl = new Map();
  return {
    m, ttl,
    async get(k, opt) {
      const v = m.get(k);
      if (v === undefined) return null;
      const type = typeof opt === "string" ? opt : opt?.type;
      return type === "json" ? JSON.parse(v) : v;
    },
    async put(k, v, opts = {}) { m.set(k, typeof v === "string" ? v : JSON.stringify(v)); if (opts.expirationTtl) ttl.set(k, opts.expirationTtl); },
    async delete(k) { m.delete(k); ttl.delete(k); },
    async list({ prefix = "" } = {}) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })), list_complete: true }; },
    // The stored record that carries a reviewToken for this audit id.
    record(id) {
      for (const [k, v] of m) {
        if (!k.includes(id)) continue;
        try { const o = JSON.parse(v); if (o && typeof o === "object" && "reviewToken" in o) return o; } catch {}
      }
      return null;
    },
  };
}

export function fakeEnv(extra = {}) {
  const flows = [];
  return {
    flows,
    AUDITS: fakeKV(),
    AUDIT_FLOW: { create: async (o) => { flows.push(o); return { id: o?.id }; }, get: async () => ({ status: async () => ({ status: "running" }) }) },
    INTAKE_LIMIT: { limit: async () => ({ success: true }) },
    ALLOWED_ORIGIN: "https://bigsplash.video,https://www.bigsplash.video,https://bigsplash.church,https://www.bigsplash.church",
    ...extra,
  };
}

// A Workflow step that runs each callback once. failAt: the step call number (1-based) that throws;
// failOn: a RegExp for the step name that throws (first match only).
export function fakeStep({ failAt = 0, failOn = null, error = new Error("Places quota exceeded") } = {}) {
  let failed = false;
  let n = 0;
  return {
    names: [],
    async do(name, a, b) {
      n++;
      this.names.push(name);
      const fn = typeof a === "function" ? a : b;
      if (n === failAt || (failOn && !failed && failOn.test(name))) { failed = true; throw error; }
      return fn();
    },
    async sleep() {},
    async sleepUntil() {},
  };
}

// All strings anywhere inside a value, joined; for "never says X" checks.
export const allText = (v) => JSON.stringify(v ?? null);
