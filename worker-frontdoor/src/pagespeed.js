// Mobile speed from Google PageSpeed Insights. Works without a key at low volume; pass GOOGLE_API_KEY in production.
export async function mobileSpeed(url, key) {
  const qs = new URLSearchParams({ url, strategy: "mobile", category: "performance" });
  if (key) qs.set("key", key);
  try {
    const res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${qs}`);
    const data = await res.json();
    if (!res.ok) return { ok: false, error: data?.error?.message?.slice(0, 160) || `status ${res.status}` };
    const lh = data.lighthouseResult;
    return {
      ok: true,
      score: Math.round((lh?.categories?.performance?.score ?? 0) * 100),
      loadTime: lh?.audits?.["largest-contentful-paint"]?.displayValue || null,
      loadSeconds: lh?.audits?.["largest-contentful-paint"]?.numericValue ? Math.round(lh.audits["largest-contentful-paint"].numericValue / 100) / 10 : null,
    };
  } catch (err) {
    return { ok: false, error: "PageSpeed request failed" };
  }
}
