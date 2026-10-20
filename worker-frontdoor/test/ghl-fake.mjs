// A fake GoHighLevel API for the tests, as routes for spec-helpers stubFetch. It answers the shapes the
// HighLevel docs give and records every call. Nothing here reaches the network.
const json = (obj, status = 200, headers = {}) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json", ...headers } });

export const GHL_BASE = "https://services.leadconnectorhq.com";
export const GHL_ENV = { GHL_TOKEN: "pit-test-token-not-real", GHL_LOCATION_ID: "f8RUB78GlgA6lIDz8HB8" };

// opts: contact (what GET /contacts/:id returns), events (appointments), messages (in the one conversation),
// fail: [[RegExp on "METHOD /path", status | Error, times = Infinity]], fields: custom fields list.
export function fakeGhl(opts = {}) {
  const s = {
    calls: [], upserts: [], tags: [], notes: [], emails: [], texts: [], opportunities: [],
    contact: { id: "ghl-contact-1", tags: [], dnd: false, dndSettings: {}, ...(opts.contact || {}) },
    events: opts.events || [],
    messages: opts.messages || [],
    fields: opts.fields || [
      { id: "fld-score", name: "Audit scorecard url", fieldKey: "contact.audit_scorecard_url", dataType: "TEXT", model: "contact" },
      { id: "fld-walk", name: "Audit walkthrough url", fieldKey: "contact.audit_walkthrough_url", dataType: "TEXT", model: "contact" },
      { id: "fld-other", name: "Other", fieldKey: "contact.other", dataType: "TEXT", model: "contact" },
    ],
    fail: (opts.fail || []).map(([re, how, times = Infinity]) => ({ re, how, times })),
    pipelines: opts.pipelines || [{ id: "pipe-1", name: "Churches", stages: [{ id: "stage-new", name: "New" }, { id: "stage-2", name: "Booked" }] }],
  };
  s.sent = () => [...s.emails, ...s.texts];
  const handle = (c) => {
    const u = new URL(c.url);
    const sig = `${c.method} ${u.pathname}`;
    s.calls.push({ ...c, path: u.pathname, query: Object.fromEntries(u.searchParams), sig, body: c.body ? JSON.parse(c.body) : null });
    const f = s.fail.find((x) => x.times > 0 && x.re.test(sig));
    if (f) {
      f.times--;
      if (f.how instanceof Error) throw f.how;
      return json({ message: "fake failure" }, f.how, { "retry-after": "0" });
    }
    const body = c.body ? JSON.parse(c.body) : {};
    if (sig === "GET /locations/f8RUB78GlgA6lIDz8HB8/customFields") return json({ customFields: s.fields });
    if (sig === "POST /contacts/upsert") { s.upserts.push(body); return json({ new: s.upserts.length === 1, contact: { id: s.contact.id, email: body.email, locationId: body.locationId }, traceId: "t" }); }
    let m;
    if ((m = sig.match(/^POST \/contacts\/([^/]+)\/tags$/))) { s.tags.push({ id: m[1], tags: body.tags }); return json({ tags: body.tags }, 201); }
    if ((m = sig.match(/^POST \/contacts\/([^/]+)\/notes$/))) { s.notes.push({ id: m[1], body: body.body }); return json({ note: { id: `note-${s.notes.length}`, body: body.body } }, 201); }
    if ((m = sig.match(/^GET \/contacts\/([^/]+)\/appointments$/))) return json({ events: s.events });
    if ((m = sig.match(/^GET \/contacts\/([^/]+)$/))) return json({ contact: s.contact });
    if (sig === "GET /opportunities/pipelines") return json({ pipelines: s.pipelines });
    if (sig === "POST /opportunities/") { s.opportunities.push(body); return json({ opportunity: { id: "opp-1" } }, 201); }
    if (sig === "POST /conversations/messages") {
      (body.type === "Email" ? s.emails : s.texts).push(body);
      return json({ conversationId: "conv-1", messageId: `msg-${s.calls.length}`, ...(body.type === "Email" ? { emailMessageId: "em-1" } : {}) });
    }
    if (sig === "GET /conversations/search") return json({ conversations: [{ id: "conv-1", contactId: s.contact.id }], total: 1 });
    if (sig === "GET /conversations/conv-1/messages") return json({ messages: { lastMessageId: "x", nextPage: false, messages: s.messages } });
    return json({ message: "not found in fake" }, 404);
  };
  s.route = [(c) => c.url.startsWith(GHL_BASE + "/"), handle];
  return s;
}

// A Workflow step that remembers each finished step by name, the way Cloudflare replays a run:
// a step that already returned gives back its saved value and does not run again.
export function replayStep({ failOn = null, error = new Error("step failed") } = {}) {
  const done = new Map();
  const st = {
    names: [], runs: [], sleeps: [], order: [],
    async do(name, a, b) {
      st.names.push(name);
      st.order.push(name);
      const fn = typeof a === "function" ? a : b;
      if (done.has(name)) return done.get(name);
      st.runs.push(name);
      if (failOn && failOn.test(name)) throw error;
      const v = await fn();
      done.set(name, v === undefined ? null : JSON.parse(JSON.stringify(v)));
      return done.get(name);
    },
    async sleep(name, d) { st.sleeps.push({ name, d }); st.order.push(name); },
    async sleepUntil(name, at) { st.sleeps.push({ name, at: new Date(at).getTime() }); st.order.push(name); },
  };
  return st;
}
