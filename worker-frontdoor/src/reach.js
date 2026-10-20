// Reach: households within a radius of the church, from Census tract centers.
// A 10-minute suburban drive covers about 5 miles, so the audit counts tracts whose center sits inside 5 miles.
// A tract center inside the circle counts the whole tract, so the number is an estimate, labeled as one.
import data from "./data/texas-tracts.json" with { type: "json" };

const EARTH_MILES = 3958.8;

export function milesBetween(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_MILES * Math.asin(Math.sqrt(a));
}

const STATES = { alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT", delaware: "DE",
  "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL", indiana: "IN", iowa: "IA", kansas: "KS",
  kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD", massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS",
  missouri: "MO", montana: "MT", nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA", "rhode island": "RI",
  "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT", vermont: "VT", virginia: "VA", washington: "WA",
  "west virginia": "WV", wisconsin: "WI", wyoming: "WY" };
const ABBR = new Set(Object.values(STATES));

// The state at the end of a US address ("..., Cedar Park, TX 78613, USA"), or null when there is none.
export function stateOf(address) {
  const tokens = String(address || "").replace(/\./g, "").split(/[\s,]+/).filter(Boolean);
  while (tokens.length && /^(\d{5}(-\d{4})?|usa?|united|states)$/i.test(tokens.at(-1))) tokens.pop();
  if (tokens.length < 2) return null;
  const last = tokens.at(-1), two = tokens.slice(-2).join(" ").toLowerCase(), three = tokens.slice(-3).join(" ").toLowerCase();
  if (last.length === 2 && ABBR.has(last.toUpperCase())) return last.toUpperCase();
  return STATES[three] || STATES[two] || STATES[last.toLowerCase()] || null;
}

// Counts households only for Texas churches, the only state in the tract file. A church across a state
// line would get a count with its own side missing, so any other state (or no state) returns null.
export function homesWithin(lat, lon, miles = 5, ...addresses) {
  if (typeof lat !== "number" || typeof lon !== "number") return null;
  const state = addresses.map(stateOf).find(Boolean) || null;
  if (state !== "TX") return null;
  let households = 0;
  let tracts = 0;
  for (const [tLat, tLon, hh] of data.tracts) {
    if (Math.abs(tLat - lat) > 0.2 || Math.abs(tLon - lon) > 0.25) continue; // cheap box first
    if (milesBetween(lat, lon, tLat, tLon) <= miles) {
      households += hh;
      tracts += 1;
    }
  }
  // Outside Texas the box finds nothing; report that as unknown rather than zero.
  if (tracts === 0) return null;
  return { miles, households: Math.round(households / 100) * 100, tracts, source: data.source };
}
