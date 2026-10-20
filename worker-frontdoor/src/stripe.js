// A small Stripe API client for the founding checkout, and the webhook signature check.
// Requests are form-encoded with bracketed keys (line_items[0][price_data][currency]=usd), the way the
// Stripe API reference shows them, and authenticate with env.STRIPE_SECRET_KEY (a restricted key).
// Every request names STRIPE_VERSION. 2026-09-30.endive removed payment_method_types from Checkout
// Sessions and added allowed_payment_method_types, so pinning the version keeps one request shape no
// matter which version the account defaults to. Every function throws on failure; callers catch.
// Error messages never carry the key.

const BASE = "https://api.stripe.com/v1";
export const STRIPE_VERSION = "2026-09-30.endive";
const TIMEOUT = 15000;
// Stripe's libraries accept a signature up to 5 minutes old.
export const SIGNATURE_TOLERANCE = 300;

export const stripeReady = (env) => Boolean(env?.STRIPE_SECRET_KEY);

// { a: { b: [ { c: 1 } ] } } -> "a[b][0][c]=1". Skips undefined and null.
export function formEncode(value, out = new URLSearchParams(), prefix = "") {
  if (value === undefined || value === null) return out;
  if (Array.isArray(value)) {
    value.forEach((v, i) => formEncode(v, out, `${prefix}[${i}]`));
  } else if (typeof value === "object") {
    for (const [k, v] of Object.entries(value)) formEncode(v, out, prefix ? `${prefix}[${k}]` : k);
  } else if (prefix) {
    out.append(prefix, String(value));
  }
  return out;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// One request. GETs, and POSTs with an Idempotency-Key, get one retry on a 429 or 5xx.
export async function stripeCall(env, method, path, { params, query, idempotencyKey } = {}) {
  if (!stripeReady(env)) throw new Error("Stripe is not set up (STRIPE_SECRET_KEY missing)");
  const url = new URL(BASE + path);
  if (query) url.search = formEncode(query).toString();
  const body = params ? formEncode(params).toString() : undefined;
  const init = () => ({
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Stripe-Version": STRIPE_VERSION,
      ...(body !== undefined ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body,
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const retryable = method === "GET" || Boolean(idempotencyKey);
  let res = await fetch(url.href, init());
  if (retryable && (res.status === 429 || res.status >= 500)) {
    await wait(1000);
    res = await fetch(url.href, init());
  }
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!res.ok) {
    const e = data?.error || {};
    const detail = String(e.message || text).replace(/\s+/g, " ").slice(0, 200).split(env.STRIPE_SECRET_KEY).join("[key]");
    throw Object.assign(new Error(`Stripe ${method} ${path} answered ${res.status}: ${detail}`), { status: res.status, code: e.code || e.type || null });
  }
  return data;
}

// ---------- Webhook signatures ----------

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(message)));
}

export function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// The Stripe-Signature header: "t=<unix seconds>,v1=<hex>[,v1=<hex>][,v0=<hex>]". Only v1 counts (the docs
// say to ignore every other scheme). A rolled secret sends one v1 per active secret, so any match passes.
// Returns { ok: true, t } or { ok: false, reason }.
export async function verifySignature(payload, header, secret, { tolerance = SIGNATURE_TOLERANCE, now = Date.now() } = {}) {
  if (!secret) return { ok: false, reason: "no secret" };
  let t = null;
  const sigs = [];
  for (const part of String(header || "").split(",")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === "t" && /^\d{1,12}$/.test(v)) t = Number(v);
    if (k === "v1" && /^[0-9a-f]{64}$/i.test(v)) sigs.push(v.toLowerCase());
  }
  if (t === null || !sigs.length) return { ok: false, reason: "malformed header" };
  const expected = await hmacHex(secret, `${t}.${payload}`);
  // Compare against every signature, so the time taken never says which one matched.
  let match = false;
  for (const s of sigs) if (safeEqual(expected, s)) match = true;
  if (!match) return { ok: false, reason: "no matching signature" };
  if (Math.abs(Math.floor(now / 1000) - t) > tolerance) return { ok: false, reason: "timestamp outside tolerance" };
  return { ok: true, t };
}

// For the tests and the Stripe CLI-style fixtures: the header Stripe would send for this payload.
export async function signPayload(payload, secret, t = Math.floor(Date.now() / 1000)) {
  return `t=${t},v1=${await hmacHex(secret, `${t}.${payload}`)}`;
}
