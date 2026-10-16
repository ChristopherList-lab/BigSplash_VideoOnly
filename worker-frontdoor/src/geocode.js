// Address to coordinates when Google has no listing to give a location. The free Census geocoder goes
// first; OpenStreetMap's Nominatim covers newer roads the Census file has not caught up with.
const UA = "BigSplashFrontDoorAudit/1.0 (chris@bigsplash.agency)";

async function census(address) {
  const qs = new URLSearchParams({ address, benchmark: "Public_AR_Current", format: "json" });
  const res = await fetch(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${qs}`);
  const m = (await res.json())?.result?.addressMatches?.[0];
  return m ? { lat: m.coordinates.y, lon: m.coordinates.x, matched: m.matchedAddress, from: "census" } : null;
}

async function nominatim(address) {
  const qs = new URLSearchParams({ q: address, format: "jsonv2", limit: "1", countrycodes: "us" });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${qs}`, { headers: { "User-Agent": UA } });
  const m = (await res.json())?.[0];
  return m ? { lat: Number(m.lat), lon: Number(m.lon), matched: m.display_name, from: "openstreetmap" } : null;
}

// Last resort: the center of the ZIP code, close enough for a 5-mile household count.
async function zipCenter(address) {
  const zip = (String(address).match(/\b(\d{5})(?:-\d{4})?\b(?!.*\b\d{5}\b)/) || [])[1];
  if (!zip) return null;
  const qs = new URLSearchParams({ postalcode: zip, country: "us", format: "jsonv2", limit: "1" });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${qs}`, { headers: { "User-Agent": UA } });
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
