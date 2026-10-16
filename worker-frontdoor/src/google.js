// Google checks with the Places API (New): find the church's listing, then see where it ranks when a
// neighbor searches "church" from about 4 miles away. Needs GOOGLE_API_KEY with Places API (New) enabled.
import { domainOf } from "./website.js";
import { milesBetween } from "./reach.js";

const SEARCH = "https://places.googleapis.com/v1/places:searchText";
const LISTING_FIELDS = [
  "places.id", "places.displayName", "places.formattedAddress", "places.location", "places.rating",
  "places.userRatingCount", "places.websiteUri", "places.regularOpeningHours", "places.photos",
  "places.googleMapsUri", "places.primaryType", "places.businessStatus",
].join(",");

async function searchText(key, body, fields) {
  const res = await fetch(SEARCH, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": fields },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Places search failed (${res.status}): ${data?.error?.message || "no detail"}`);
  return data.places || [];
}

function words(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w && !["church", "the", "of", "a"].includes(w));
}

// How sure we are that a listing is this church: a matching website domain settles it,
// otherwise the name has to share its distinctive words.
function matchConfidence(place, church) {
  const siteDomain = domainOf(church.website);
  if (siteDomain && place.websiteUri && domainOf(place.websiteUri) === siteDomain) return "high";
  const want = new Set(words(church.name));
  const got = words(place.displayName?.text);
  const shared = got.filter((w) => want.has(w)).length;
  if (want.size && shared >= Math.min(2, want.size)) return "medium";
  return "low";
}

export async function findListing(key, church) {
  const query = [church.name, church.address || church.city].filter(Boolean).join(", ");
  const places = await searchText(key, { textQuery: query, pageSize: 5 }, LISTING_FIELDS);
  if (!places.length) return { found: false, query };
  const scored = places.map((p) => ({ p, c: matchConfidence(p, church) }));
  const order = { high: 0, medium: 1, low: 2 };
  scored.sort((a, b) => order[a.c] - order[b.c]);
  const { p, c } = scored[0];
  return {
    found: true,
    confidence: c,
    query,
    id: p.id,
    name: p.displayName?.text,
    address: p.formattedAddress,
    lat: p.location?.latitude,
    lon: p.location?.longitude,
    rating: p.rating ?? null,
    reviewCount: p.userRatingCount ?? 0,
    website: p.websiteUri || null,
    hoursListed: Boolean(p.regularOpeningHours?.weekdayDescriptions?.length),
    hours: p.regularOpeningHours?.weekdayDescriptions || [],
    // The API often returns no photos at all, even for famous places, so a missing list means unknown, not zero.
    photoCount: Array.isArray(p.photos) && p.photos.length ? p.photos.length : null,
    mapsUrl: p.googleMapsUri || null,
    status: p.businessStatus || null,
  };
}

// Search "church" from two points about 4 miles north and south of the church and record its best rank.
export async function nearMeRank(key, listing) {
  if (!listing?.found || typeof listing.lat !== "number") return null;
  const offset = 4 / 69; // degrees of latitude in 4 miles
  const points = [
    { label: "north", lat: listing.lat + offset, lon: listing.lon },
    { label: "south", lat: listing.lat - offset, lon: listing.lon },
  ];
  const results = [];
  for (const pt of points) {
    const places = await searchText(key, {
      textQuery: "church",
      pageSize: 20,
      locationBias: { circle: { center: { latitude: pt.lat, longitude: pt.lon }, radius: 3000 } },
    }, "places.id,places.displayName,places.location");
    const idx = places.findIndex((p) => p.id === listing.id);
    results.push({
      from: pt.label,
      milesAway: Math.round(milesBetween(pt.lat, pt.lon, listing.lat, listing.lon) * 10) / 10,
      rank: idx === -1 ? null : idx + 1,
      ahead: places.slice(0, idx === -1 ? 3 : Math.min(idx, 3)).map((p) => p.displayName?.text).filter(Boolean),
    });
  }
  const ranks = results.map((r) => r.rank).filter((r) => r !== null);
  return { best: ranks.length ? Math.min(...ranks) : null, searches: results };
}
