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

export function homesWithin(lat, lon, miles = 5) {
  if (typeof lat !== "number" || typeof lon !== "number") return null;
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
