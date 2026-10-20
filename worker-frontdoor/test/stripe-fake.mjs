// A fake Stripe API for the founding tests, as a route for spec-helpers stubFetch. It answers the shapes
// the Stripe API reference gives, honors Idempotency-Key the way Stripe does, and records every call.
// Nothing here reaches the network.
const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export const STRIPE_BASE = "https://api.stripe.com/v1";
export const STRIPE_ENV = { STRIPE_SECRET_KEY: "rk_test_not_a_real_key_000", STRIPE_WEBHOOK_SECRET: "whsec_test_not_a_real_secret_000" };

// "metadata[church]" -> { church } for one prefix.
export function nested(params, prefix) {
  const out = {};
  for (const [k, v] of Object.entries(params)) {
    const m = k.match(new RegExp(`^${prefix.replace(/[[\]]/g, "\\$&")}\\[([^\\]]+)\\]$`));
    if (m) out[m[1]] = v;
  }
  return out;
}

// opts: prices (existing Price objects), subs (existing Subscriptions), sessions ({ id: session }),
// intents ({ pi_id: { payment_method } }), fail: [[RegExp on "METHOD /path", status]].
export function fakeStripe(opts = {}) {
  const s = {
    calls: [], n: 0, idem: new Map(),
    prices: [...(opts.prices || [])], subs: [...(opts.subs || [])],
    sessions: new Map(Object.entries(opts.sessions || {})),
    intents: opts.intents || { pi_test_1: { id: "pi_test_1", object: "payment_intent", payment_method: "pm_saved_card_1" } },
    fail: opts.fail || [],
  };
  s.of = (method, path) => s.calls.filter((c) => c.method === method && (path instanceof RegExp ? path.test(c.path) : c.path === path));
  const handle = (c) => {
    const u = new URL(c.url);
    const path = u.pathname.replace(/^\/v1/, "");
    const params = c.body ? Object.fromEntries(new URLSearchParams(c.body)) : {};
    const query = Object.fromEntries(u.searchParams);
    const call = { method: c.method, path, params, query, headers: c.headers, body: c.body || "" };
    s.calls.push(call);
    const f = s.fail.find(([re]) => re.test(`${c.method} ${path}`));
    if (f) return json({ error: { type: "api_error", message: `fake failure, auth was ${c.headers.get("authorization")}` } }, f[1]);
    const key = c.headers.get("idempotency-key");
    if (key && s.idem.has(key)) return json(s.idem.get(key));
    let out = null, m;
    if (c.method === "POST" && path === "/checkout/sessions") {
      const id = `cs_test_Fake${++s.n}a1b2c3d4e5`;
      out = { id, object: "checkout.session", mode: params.mode, url: `https://checkout.stripe.com/c/pay/${id}#fake`, status: "open", payment_status: "unpaid",
        amount_total: Number(params["line_items[0][price_data][unit_amount]"]) * Number(params["line_items[0][quantity]"]), currency: "usd",
        customer: null, payment_intent: null, customer_email: params.customer_email, metadata: nested(params, "metadata") };
      s.sessions.set(id, out);
    } else if (c.method === "GET" && (m = path.match(/^\/checkout\/sessions\/([^/]+)$/))) {
      out = s.sessions.get(decodeURIComponent(m[1]));
      if (!out) return json({ error: { type: "invalid_request_error", message: "No such checkout.session" } }, 404);
    } else if (c.method === "GET" && path === "/prices") {
      const keys = Object.entries(query).filter(([k]) => k.startsWith("lookup_keys")).map(([, v]) => v);
      out = { object: "list", data: s.prices.filter((p) => keys.includes(p.lookup_key) && p.active !== false), has_more: false };
    } else if (c.method === "POST" && path === "/prices") {
      const holder = s.prices.find((p) => p.lookup_key === params.lookup_key);
      // transfer_lookup_key=true moves the key off the price that holds it, archived or not.
      if (holder && params.transfer_lookup_key !== "true") return json({ error: { type: "invalid_request_error", message: "A price with this lookup key already exists" } }, 400);
      if (holder) holder.lookup_key = null;
      out = { id: `price_fake_${++s.n}`, object: "price", active: true, currency: params.currency, unit_amount: Number(params.unit_amount), lookup_key: params.lookup_key,
        product: params.product || `prod_fake_${s.n}`, recurring: { interval: params["recurring[interval]"] } };
      s.prices.push(out);
    } else if (c.method === "GET" && (m = path.match(/^\/payment_intents\/([^/]+)$/))) {
      out = s.intents[decodeURIComponent(m[1])];
      if (!out) return json({ error: { type: "invalid_request_error", message: "No such payment_intent" } }, 404);
    } else if (c.method === "GET" && path === "/subscriptions") {
      out = { object: "list", data: s.subs.filter((x) => x.customer === query.customer), has_more: false };
    } else if (c.method === "POST" && path === "/subscriptions") {
      out = { id: `sub_fake_${++s.n}`, object: "subscription", customer: params.customer, status: "trialing", trial_end: Number(params.trial_end),
        default_payment_method: params.default_payment_method, metadata: nested(params, "metadata"), items: { data: [{ price: { id: params["items[0][price]"] } }] } };
      s.subs.push(out);
    } else {
      return json({ error: { type: "invalid_request_error", message: `fake has no ${c.method} ${path}` } }, 404);
    }
    if (key) s.idem.set(key, out);
    return json(out);
  };
  s.route = [(c) => c.url.startsWith(STRIPE_BASE + "/"), handle];
  return s;
}
