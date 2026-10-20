// Address to coordinates when Google has no listing to give a location. The free Census geocoder goes
// first; OpenStreetMap's Nominatim covers newer roads the Census file has not caught up with.
const UA = "BigSplashFrontDoorAudit/1.0 (chris@bigsplash.agency)";

async function census(address) {
  const qs = new URLSearchParams({ address, benchmark: "Public_AR_Current", format: "json" });
  const res = await fetch(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${qs}`, { signal: AbortSignal.timeout(10000) });
  const m = (await res.json())?.result?.addressMatches?.[0];
  return m ? { lat: m.coordinates.y, lon: m.coordinates.x, matched: m.matchedAddress, from: "census" } : null;
}

async function nominatim(address) {
  const qs = new URLSearchParams({ q: address, format: "jsonv2", limit: "1", countrycodes: "us" });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${qs}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) });
  const m = (await res.json())?.[0];
  return m ? { lat: Number(m.lat), lon: Number(m.lon), matched: m.display_name, from: "openstreetmap" } : null;
}

const STATE_WORDS = new Set(("al ak az ar ca co ct de dc fl ga hi id il in ia ks ky la me md ma mi mn ms mo mt ne nv nh nj nm ny nc nd oh ok or pa ri sc sd tn tx ut vt va wa wv wi wy " +
  "alabama alaska arizona arkansas california colorado connecticut delaware florida georgia hawaii idaho illinois indiana iowa kansas kentucky louisiana maine maryland " +
  "massachusetts michigan minnesota mississippi missouri montana nebraska nevada hampshire jersey mexico york carolina dakota ohio oklahoma oregon pennsylvania island " +
  "tennessee texas utah vermont virginia washington wisconsin wyoming columbia").split(" "));

// The ZIP in an address: five digits after a state, or the last word. Never the first word, which is
// usually a street number ("15800 Crossroads Drive").
export function zipOf(address) {
  const tokens = String(address || "").split(/[\s,]+/).filter(Boolean);
  for (let i = tokens.length - 1; i >= 1; i--) {
    const m = tokens[i].match(/^(\d{5})(?:-\d{4})?$/);
    if (!m) continue;
    const prev = tokens[i - 1].toLowerCase().replace(/\./g, "");
    if (i === tokens.length - 1 || STATE_WORDS.has(prev)) return m[1];
  }
  return null;
}

// Last resort: the center of the ZIP code, close enough for a 5-mile household count.
async function zipCenter(address) {
  const zip = zipOf(address);
  if (!zip) return null;
  const qs = new URLSearchParams({ postalcode: zip, country: "us", format: "jsonv2", limit: "1" });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${qs}`, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10000) });
  const m = (await res.json())?.[0];
  return m ? { lat: Number(m.lat), lon: Number(m.lon), matched: `ZIP ${zip}`, from: "zip" } : null;
}

export async function geocode(address) {
  if (!address) return null;
  for (const fn of [census, nominatim, zipCenter]) {
    try {
      const hit = await fn(address);
      if (hit) return hit;
    } catch {}
  }
  return null;
}
