/**
 * Where the payload is, and how to walk to it.
 *
 * No imports, so this runs directly under Node for testing.
 *
 * The one thing this file exists to get right: **the last known position is
 * not the last packet.** A GPS receiver loses lock long before a radio link
 * does - antenna orientation under a canopy, a low elevation angle near the
 * ground, or simply a receiver that gave up. When that happens the newest
 * position the ground station holds is older, sometimes much older, than its
 * newest packet.
 *
 * A bearing computed from a stale fix that is presented as current is the one
 * failure here that actually loses hardware, so everything below carries its
 * own provenance: how old the fix is, how many packets have arrived since, and
 * how high the payload still was when it was last seen.
 */

/** Mean Earth radius, metres (IUGG). */
const R_EARTH = 6371008.8;
const DEG = Math.PI / 180;

export type LatLon = { lat_deg: number; lon_deg: number };

/**
 * Great-circle distance in metres (haversine).
 *
 * A flat-earth approximation would be accurate to well under a metre over the
 * kilometre or two a CanSat drifts, but haversine costs two more trig calls
 * and stays correct if the wind ever carries one further than expected.
 */
export function distanceM(from: LatLon, to: LatLon): number {
  const dLat = (to.lat_deg - from.lat_deg) * DEG;
  const dLon = (to.lon_deg - from.lon_deg) * DEG;
  const lat1 = from.lat_deg * DEG;
  const lat2 = to.lat_deg * DEG;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Initial great-circle bearing, degrees clockwise from true north.
 *
 * "Initial" matters in principle - a great circle's bearing changes along its
 * path - though over these distances the change is far below what anyone can
 * hold with a handheld compass.
 */
export function bearingDeg(from: LatLon, to: LatLon): number {
  const lat1 = from.lat_deg * DEG;
  const lat2 = to.lat_deg * DEG;
  const dLon = (to.lon_deg - from.lon_deg) * DEG;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

const POINTS = [
  "N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
  "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW",
];

/** Sixteen-point compass label, for reading aloud to someone walking. */
export function compassPoint(bearing_deg: number): string {
  return POINTS[Math.round((bearing_deg % 360) / 22.5) % 16];
}

export type Recovery = {
  fix: LatLon;
  /** Metres from the pad to the last known fix. */
  distance_m: number;
  /** Degrees true from the pad to the last known fix. */
  bearing_deg: number;
  compass: string;
  /** Seconds since that fix, on the stream clock. */
  age_s: number;
  /** Packets received after the last one that carried a fix. */
  packetsSinceFix: number;
  /**
   * Altitude at the last fix. Anything meaningfully above zero means the
   * payload kept drifting after this position was recorded, so the fix is an
   * upper bound on accuracy, not a landing site.
   */
  fixAlt_m: number | null;
  /** True when the fix is old enough or high enough not to be trusted as-is. */
  suspect: boolean;
};

/** Above this altitude at the last fix, the payload clearly drifted further. */
export const DRIFT_ALT_M = 15;
/** Beyond this many packets without a fix, say so prominently. */
export const STALE_PACKETS = 3;

export function deriveRecovery(input: {
  pad: LatLon | null;
  fix: LatLon | null;
  fixAlt_m: number | null;
  age_s: number;
  packetsSinceFix: number;
}): Recovery | null {
  const { pad, fix, fixAlt_m, age_s, packetsSinceFix } = input;
  if (pad === null || fix === null) return null;

  const bearing_deg = bearingDeg(pad, fix);
  return {
    fix,
    distance_m: distanceM(pad, fix),
    bearing_deg,
    compass: compassPoint(bearing_deg),
    age_s,
    packetsSinceFix,
    fixAlt_m,
    suspect:
      packetsSinceFix > STALE_PACKETS ||
      (fixAlt_m !== null && fixAlt_m > DRIFT_ALT_M),
  };
}
