/**
 * The downlink packet format, v1 - the only shape the UI ever sees.
 *
 * This is exactly what the radio transmits and nothing more. There is no
 * `alt_m` and no `time_s`: altitude is derived on the ground from pressure,
 * and mission time comes from the packet counter. Live mode receives these
 * over a WebSocket, replay mode reads them from a recorded log, and both feed
 * the same derivation code.
 *
 * The format only ever grows by adding optional fields, never by renaming or
 * re-scaling one, so a log recorded today stays playable.
 */
export type Packet = {
  schema: number;
  packet_id: number;
  pressure_pa: number;
  temp_c: number; // chamber, NOT ambient air - see barometric.ts
  lat_deg?: number; // absent until GPS lock, and can disappear again
  lon_deg?: number;
};

/** Downlink rate. The packet counter is the clock, so this is the conversion. */
export const PACKET_RATE_HZ = 1;

/**
 * Mission time for a packet, in seconds since power-on.
 *
 * Derived from the counter rather than from when the packet arrived. A dropped
 * packet leaves a gap in the counter, which becomes a gap of exactly the right
 * length on the time axis - whereas timestamping on arrival would let radio
 * jitter stretch and squash the flight profile.
 */
export function packetTime(p: Packet): number {
  return p.packet_id / PACKET_RATE_HZ;
}

/** How many packets to average when measuring the pad reference. */
export const PAD_SAMPLES = 6;

/**
 * Reference pressure at the pad, measured from packets while the payload is
 * still on the ground.
 *
 * Every altitude the ground station reports is relative to this number, so
 * getting it from real packets - rather than assuming sea level - is the whole
 * of feature 2. The pad is rarely at sea level; assuming 101325 Pa at a pad
 * 150 m up puts every altitude 150 m out for the entire flight.
 *
 * Median rather than mean, because the pad pressure is noisy and the median
 * discards an outlier completely. A single corrupt reading, or one sample
 * taken a moment after the vehicle actually moved, would drag a mean along
 * with it in proportion to its error.
 *
 * Returns null until enough packets exist to measure anything.
 */
export function padReference(packets: Packet[], count = PAD_SAMPLES): number | null {
  if (packets.length < count) return null;
  const sorted = packets
    .slice(0, count)
    .map((p) => p.pressure_pa)
    .sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The same measurement taken from the most recent packets instead of the first.
 *
 * Used by the manual re-capture control, for when the page was opened after the
 * pad packets had already gone past.
 */
export function padReferenceFromLatest(
  packets: Packet[],
  count = PAD_SAMPLES
): number | null {
  return padReference(packets.slice(-count), count);
}
