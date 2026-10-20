// Test helpers: a fetch stub that answers from fixtures, never the network.
export const DAY = 86400000;

// routes: [[match, handler]], match = exact URL string, RegExp or (url, init) => bool;
// handler = (url, init) => Response | Promise<Response>, or an Error to throw.
export function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    calls.push({ url, init });
    for (const [match, handler] of routes) {
      const hit = typeof match === "string" ? url === match : match instanceof RegExp ? match.test(url) : match(url, init);
      if (!hit) continue;
      if (handler instanceof Error) throw handler;
      return handler(url, init);
    }
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
  };
  return calls;
}

export function page(body, status = 200, url, type = "text/html; charset=utf-8") {
  const res = new Response(body, { status, headers: { "content-type": type } });
  if (url) Object.defineProperty(res, "url", { value: url });
  return res;
}

export const jsonRes = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });

export const timeoutError = () => Object.assign(new DOMException("The operation was aborted due to timeout", "TimeoutError"));

// Filler so a fixture page is not mistaken for a JavaScript shell.
export const filler = `<p>${"Our church family gathers to worship, serve the city and love our neighbors well. ".repeat(8)}</p>` +
  ["/about", "/staff", "/give", "/events", "/contact", "/beliefs"].map((h) => `<a href="${h}">${h.slice(1)}</a>`).join("");

export function homePage(inner, head = '<meta name="viewport" content="width=device-width">') {
  return `<!doctype html><html><head>${head}<title>Test Church</title></head><body>${inner}${filler}</body></html>`;
}

export function ytFeed(entries) {
  return `<feed>${entries.map(([title, iso]) => `<entry><title>${title}</title><published>${iso}</published></entry>`).join("")}</feed>`;
}

export function vimeoFeed(items) {
  return `<rss><channel>${items.map(([title, date]) => `<item><title>${title}</title><pubDate>${date}</pubDate></item>`).join("")}</channel></rss>`;
}

export function kv() {
  const m = new Map();
  return {
    m,
    async get(k, type) { const v = m.get(k); return v === undefined ? null : type === "json" ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, String(v)); },
  };
}
