// The ad landing page (frontdoor/index.html) run in a small fake DOM, so tests can submit the real form
// script and read the JSON it would POST to /audit.
import { readFileSync } from "node:fs";
import vm from "node:vm";

const landing = readFileSync(new URL("../../frontdoor/index.html", import.meta.url), "utf8");
export const inlineScripts = (page) => [...page.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*application\/ld\+json)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n;\n");

export function runLanding({ fields = {}, search = "?utm_source=facebook&utm_campaign=oct30", response = { ok: true, id: "grace-bible-church-1a2b3c4d", url: "/front-door/?id=grace-bible-church-1a2b3c4d" } } = {}) {
  const els = {};
  const el = (id) => (els[id] ||= { id, textContent: "", style: {}, children: [], appendChild(c) { this.children.push(c); } });
  const listeners = {};
  const field = (name, extra = {}) => ({ name, value: "", required: false, focused: 0, focus() { this.focused++; }, ...extra,
    addEventListener(type, fn) { (this.on ||= {})[type] = fn; } });
  const elements = {
    church: field("church"), address: field("address"), website: field("website"), attendance: field("attendance", { type: "select" }),
    name: field("name"), role: field("role", { type: "select" }), email: field("email"), phone: field("phone"),
    sms_consent: field("sms_consent", { type: "checkbox", value: "yes", checked: false }), instagram: field("instagram"),
    facebook_frequency: field("facebook_frequency", { type: "select" }), hp_x7: field("hp_x7"),
  };
  for (const [k, v] of Object.entries(fields)) {
    if (k === "sms_consent") elements.sms_consent.checked = v;
    else elements[k].value = v;
  }
  const button = { disabled: false, textContent: "Run my free audit" };
  const form = { elements, style: {}, querySelector: () => button, addEventListener(type, fn) { listeners[type] = fn; } };
  els["audit-form"] = form;

  // Browser rules: an unchecked box and a select still on its disabled placeholder are left out.
  class FormData {
    constructor(f) { this.f = f; }
    entries() {
      return Object.values(this.f.elements)
        .filter((x) => (x.type === "checkbox" ? x.checked : x.type === "select" ? x.value !== "" : true))
        .map((x) => [x.name, x.value])[Symbol.iterator]();
    }
  }
  const posts = [], fbq = [], gtag = [];
  const context = {
    document: { getElementById: el, createElement: () => ({ style: {} }) },
    location: { search, href: `https://bigsplash.video/frontdoor/${search}` },
    fetch: async (url, init) => { posts.push({ url: String(url), body: JSON.parse(init.body) }); return new Response(JSON.stringify(response), { status: 200 }); },
    setTimeout: () => 0, // polling never fires in these tests
    fbq: (...a) => fbq.push(a), gtag: (...a) => gtag.push(a),
    FormData, URLSearchParams, Response, Promise, Object, String, JSON, Error, Date, console,
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(inlineScripts(landing), context);
  const submit = async () => { await listeners.submit({ preventDefault() {} }); await new Promise((r) => setImmediate(r)); };
  const toggleConsent = (on) => { elements.sms_consent.checked = on; elements.sms_consent.on.change(); };
  return { submit, toggleConsent, elements, posts, fbq, gtag, err: el("err"), hint: el("phone-hint") };
}
