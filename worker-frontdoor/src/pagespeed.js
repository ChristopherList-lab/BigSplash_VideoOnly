// Mobile speed from Google PageSpeed Insights. Works without a key at low volume; pass GOOGLE_API_KEY in production.
// The score is Google's lab test on a simulated slow cell connection. Its load times are simulated too, so the
// only load time returned is the real-visitor one (Chrome field data), when Google has enough visits to report it.
export async function mobileSpeed(url, key) {
  const qs = new URLSearchParams({ url, strategy: "mobile", category: "performance" });
  if (key) qs.set("key", key);
  try {
    const res = await fetch(`https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${qs}`, { signal: AbortSignal.timeout(90000) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data?.error?.message?.slice(0, 160) || `status ${res.status}` };
    const lh = data.lighthouseResult;
    const score = lh?.categories?.performance?.score;
    if (!lh || (lh.runtimeError && lh.runtimeError.code !== "NO_ERROR") || typeof score !== "number") {
      return { ok: false, error: lh?.runtimeError?.code || "No performance score" };
    }
    const field = data.loadingExperience?.metrics?.LARGEST_CONTENTFUL_PAINT_MS?.percentile;
    return { ok: true, url, score: Math.round(score * 100), fieldLcpSeconds: typeof field === "number" ? Math.round(field / 100) / 10 : null };
  } catch (err) {
    return { ok: false, error: err?.name === "TimeoutError" ? "PageSpeed timed out" : "PageSpeed request failed" };
  }
}
