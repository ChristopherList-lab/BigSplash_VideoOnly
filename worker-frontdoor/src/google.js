// Google checks with the Places API (New): find the church's listing, then see where it ranks when a
// neighbor searches "church" from about 4 miles away. Needs GOOGLE_API_KEY with Places API (New) enabled.
import { siteKey } from "./website.js";
import { milesBetween } from "./reach.js";

const SEARCH = "https://places.googleapis.com/v1/places:searchText";
const TIMEOUT_MS = 10000;
const LISTING_FIELDS = [
  "places.id", "places.displayName", "places.formattedAddress", "places.location", "places.rating",
  "places.userRatingCount", "places.websiteUri", "places.regularOpeningHours", "places.regularSecondaryOpeningHours",
  "places.googleMapsUri", "places.primaryType", "places.types", "places.businessStatus",
].join(",");

async function searchText(key, body, fields) {
  const res = await fetch(SEARCH, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": fields },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw Object.assign(new Error(`Places search failed (${res.status}): ${data?.error?.message || "no detail"}`), { status: res.status, apiStatus: data?.error?.status || null });
  }
  // A reply that times out mid-body or will not parse is our failure, never "no places": it throws, and
  // placesFailure names it. Places (New) answers {} for zero results, so a parsed reply with no places key is
  // still an empty answer.
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = null; }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw Object.assign(new Error(`Places reply could not be read (${res.status})`), { status: res.status });
  return { places: Array.isArray(data.places) ? data.places : [], next: data.nextPageToken || null };
}

// Why a Places call failed, as a reason code. Every one of these is our side: the church is never graded on it.
//   quota         Google's daily or per-minute limit (429, RESOURCE_EXHAUSTED)
//   timeout       Google did not answer in time
//   key-rejected  the API key is wrong, restricted or missing Places API (New)
//   api-error     anything else (a 5xx, a network error)
export function placesFailure(err) {
  const text = `${err?.apiStatus || ""} ${err?.message || ""}`;
  if (err?.name === "TimeoutError" || err?.name === "AbortError") return "timeout";
  if (err?.status === 429 || /RESOURCE_EXHAUSTED|quota/i.test(text)) return "quota";
  if (err?.status === 401 || err?.status === 403 || /PERMISSION_DENIED|API key|API_KEY/i.test(text)) return "key-rejected";
  return "api-error";
}

// Words that many church names share, so they never prove two names belong to the same church.
const STOP = ["church", "the", "of", "a", "at", "in", "and"];
const WEAK = new Set([...STOP, "first", "baptist", "methodist", "lutheran", "presbyterian", "bible", "community", "fellowship", "grace",
  "christian", "united", "st", "saint", "catholic", "family", "life", "new", "hope", "assembly", "god"]);
// Listings that often share a church's name or website but are not the church.
const SIDE = ["preschool", "school", "academy", "daycare", "thrift", "cafe", "coffee", "bookstore", "counseling"];
const ORDER = { high: 0, medium: 1, conflict: 2, low: 3 };

export function nameWords(s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
}

// Same name when the names are equal once normalized, or share a distinctive word. Words from the typed
// address (the city, the street) count as weak too, so "Georgetown" never ties two Georgetown churches.
export function namesMatch(typed, listed, extraWeak = []) {
  const x = nameWords(typed), y = nameWords(listed);
  if (!x.length || !y.length) return false;
  const core = (w) => w.filter((t) => !STOP.includes(t)).join("");
  if (x.join(" ") === y.join(" ") || (core(x) && core(x) === core(y))) return true;
  const weak = new Set([...WEAK, ...extraWeak]);
  const strong = new Set(x.filter((t) => t.length > 1 && !weak.has(t)));
  return y.some((t) => strong.has(t));
}

function sameNameHere(church, listed) {
  const local = (s) => nameWords(s).filter((t) => !STOP.includes(t) && !addressWords(church).includes(t)).join("");
  return Boolean(local(church.name)) && local(church.name) === local(listed);
}

const addressWords = (church) => nameWords(church.address || church.city).filter((w) => !/^\d+$/.test(w));

// How sure we are that a listing is this church. sites = the typed website plus where it redirected.
export function matchConfidence(place, church, sites = [church.website]) {
  const keys = [...new Set(sites.map(siteKey).filter(Boolean))];
  const listKey = siteKey(place.websiteUri);
  const listed = place.displayName?.text || "";
  const domainOk = Boolean(listKey && keys.includes(listKey));
  // On the church's own website, "Life.Church Edmond" is "Life.Church" once the typed city comes off.
  const nameOk = namesMatch(church.name, listed, addressWords(church)) || (domainOk && sameNameHere(church, listed));
  if (domainOk && nameOk) return { confidence: "high", nameOk, domainOk, reason: null };
  if (listKey && keys.length && !domainOk) return { confidence: "conflict", nameOk, domainOk, reason: `The listing "${listed}" links to ${listKey}, not ${keys[0]}.` };
  if (nameOk) return { confidence: "medium", nameOk, domainOk, reason: null };
  return { confidence: "low", nameOk, domainOk, reason: domainOk ? `The listing "${listed}" shares the website, but its name does not match "${church.name}".` : `The listing "${listed}" does not match the name "${church.name}".` };
}

const hasPeriods = (h) => Boolean(h?.periods?.length);

const isChurch = (p) => [p.primaryType, ...(Array.isArray(p.types) ? p.types : [])].some((t) => t === "church" || t === "place_of_worship");

// Throws when Places fails (placesFailure() names why). Google having no listing for this church is a real
// finding (listed: false), the way a family searching for it would see: Places answered with nothing, or only
// with places that are not this church and not a church at all (the street address itself, the pizza shop next
// door). A church-typed place that matches neither the name nor the website may be this church under another
// name ("FBC" for First Baptist), so it comes back found with low or conflict confidence and audit.js holds it.
// An answer with only permanently closed listings is found: false, listed: true, closed: true.
export async function findListing(key, church, sites = [church.website]) {
  const query = [church.name, church.address || church.city].filter(Boolean).join(", ");
  const { places: raw } = await searchText(key, { textQuery: query, pageSize: 5 }, LISTING_FIELDS);
  const places = raw.filter((p) => p.businessStatus !== "CLOSED_PERMANENTLY");
  const unlisted = { found: false, listed: false, query, possibleDuplicates: [] };
  if (!raw.length) return unlisted;
  if (!places.length) return { found: false, listed: true, closed: true, query, possibleDuplicates: [] };
  const typedWords = nameWords(church.name);
  const ranked = places.map((p, i) => {
    const words = nameWords(p.displayName?.text);
    const side = SIDE.some((w) => words.includes(w) && !typedWords.includes(w)) ? 1 : 0;
    const m = matchConfidence(p, church, sites);
    // A place that matches nothing and is not a church (the pizza shop next door) ranks last, so a hold names the
    // church-typed place that may be this one.
    const unrelated = !m.nameOk && !m.domainOk && !isChurch(p) ? 1 : 0;
    return { p, i, side, unrelated, m };
  }).sort((a, b) => a.side - b.side || a.unrelated - b.unrelated || ORDER[a.m.confidence] - ORDER[b.m.confidence] || a.i - b.i);
  // Chris's Slack line names what Google did return, so a wrong "no listing" is easy to spot after it sends.
  if (ranked.every((r) => r.unrelated)) return { ...unlisted, returned: places.slice(0, 3).map((x) => x.displayName?.text || x.formattedAddress).filter(Boolean) };
  const { p, m } = ranked[0];

  // Other listings for the same website or name at another address: a second campus, an old building
  // or a duplicate listing. Chris sees these in Slack; the pastor never does.
  const possibleDuplicates = ranked.slice(1)
    .filter(({ p: o, m: om }) => (om.domainOk || om.nameOk || (siteKey(o.websiteUri) && siteKey(o.websiteUri) === siteKey(p.websiteUri))) && o.formattedAddress !== p.formattedAddress)
    .slice(0, 5)
    .map(({ p: o, m: om, side }) => ({
      name: o.displayName?.text || null, address: o.formattedAddress || null, reviewCount: o.userRatingCount ?? 0,
      // Same website, not a preschool or cafe: most likely another campus or a second listing of this church.
      sameSite: Boolean(!side && (om.domainOk || (siteKey(o.websiteUri) && siteKey(o.websiteUri) === siteKey(p.websiteUri)))),
    }));

  const secondary = (p.regularSecondaryOpeningHours || []).find(hasPeriods);
  return {
    found: true,
    confidence: m.confidence,
    conflictReason: m.reason,
    nameMatch: m.nameOk,
    domainMatch: m.domainOk,
    query,
    id: p.id,
    name: p.displayName?.text,
    address: p.formattedAddress,
    lat: p.location?.latitude,
    lon: p.location?.longitude,
    rating: p.rating ?? null,
    reviewCount: p.userRatingCount ?? 0,
    website: p.websiteUri || null,
    hoursListed: hasPeriods(p.regularOpeningHours) || Boolean(secondary),
    hours: p.regularOpeningHours?.weekdayDescriptions || secondary?.weekdayDescriptions || [],
    mapsUrl: p.googleMapsUri || null,
    status: p.businessStatus || null,
    possibleDuplicates,
  };
}

// Search "church" from points about 4 miles north and south of the church. The bias circle is centered on
// the search point and reaches just past the church, the way a phone's location would. Pages through up to
// 60 results, and ranks the church among the places Google types as churches. An API error, an unreadable reply
// or a search with no churches in it marks that one search not checked; this never throws.
export async function nearMeRank(key, listing) {
  if (!listing?.found || typeof listing.lat !== "number") return { checked: false, best: null, searches: [] };
  const offset = 4 / 69; // degrees of latitude in 4 miles
  const searches = [];
  for (const [from, sign] of [["north", 1], ["south", -1]]) {
    const lat = listing.lat + sign * offset, lon = listing.lon;
    const miles = milesBetween(lat, lon, listing.lat, listing.lon);
    const base = { from, milesAway: Math.round(miles * 10) / 10 };
    try {
      const radius = Math.min(50000, Math.round(miles * 1609.34 + 1500));
      const body = { textQuery: "church", pageSize: 20, locationBias: { circle: { center: { latitude: lat, longitude: lon }, radius } } };
      const seen = [];
      let token = null, rank = null, pulled = 0;
      do {
        const page = await searchText(key, token ? { ...body, pageToken: token } : body, "places.id,places.displayName,places.types,nextPageToken");
        pulled += page.places.length;
        // Rank among churches only: a search for "church" also brings back Church's Chicken.
        for (const p of page.places) {
          if (p.id !== listing.id && Array.isArray(p.types) && !p.types.some((t) => t === "church" || t === "place_of_worship")) continue;
          seen.push(p);
          if (rank === null && p.id === listing.id) rank = seen.length;
        }
        token = page.next;
      } while (rank === null && token && pulled < 60);
      // A search that came back with no churches at all says nothing about this church's rank: not checked.
      if (!seen.length) { searches.push({ ...base, checked: false, error: "no results" }); continue; }
      const ahead = seen.slice(0, rank ? Math.min(rank - 1, 3) : 3).map((p) => p.displayName?.text).filter(Boolean);
      searches.push({ ...base, checked: true, rank, scanned: seen.length, ahead });
    } catch (err) {
      searches.push({ ...base, checked: false, error: String(err?.message || err).slice(0, 160) });
    }
  }
  const ranks = searches.filter((s) => s.checked && s.rank).map((s) => s.rank);
  return { checked: searches.some((s) => s.checked), best: ranks.length ? Math.min(...ranks) : null, searches };
}
