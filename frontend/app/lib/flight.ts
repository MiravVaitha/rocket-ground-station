/**
 * The one derivation: raw packets in, everything the UI shows out.
 *
 * Both modes call this. Live folds in each arriving packet and passes a
 * wall-clock-advanced `now_s`; replay passes the packets up to the playhead
 * and the playhead time. One function, so the two modes cannot drift apart.
 *
 * It recomputes the whole flight on every call rather than accumulating
 * incrementally. A flight is a few hundred packets at 1 Hz, so that is free -
 * and it buys two things worth far more than the cycles: re-capturing the pad
 * reference instantly re-derives every altitude in the flight, and seeking
 * backwards in replay is a shorter slice rather than a second code path.
 */

import {
  type Apogee,
  type AltitudeSample,
  DEFAULT_APOGEE_CONFIG,
  type ApogeeConfig,
  detectApogee,
} from "./apogee.ts";
import { T0_ISA_K, altitudeFromPressure } from "./barometric.ts";
import { type LinkStats, linkStats } from "./link.ts";
import { type Packet, packetTime, padReference } from "./telemetry.ts";

/** Climbing past this counts as launch. Well clear of pad sensor noise. */
export const LAUNCH_ALT_M = 10;
/** Back below this after apogee counts as down. */
export const LANDED_ALT_M = 15;

export type FlightPhase = "waiting" | "pad" | "ascent" | "descent" | "landed";

export type FlightEvent = {
  label: "PAD" | "LAUNCH" | "APOGEE" | "LANDED";
  t_s: number;
  alt_m?: number;
};

export type FlightView = {
  /** Altitude series, one point per received packet. Gaps are real gaps. */
  samples: AltitudeSample[];
  /** Pad reference pressure, or null until enough packets have arrived. */
  pad_pa: number | null;
  latest: Packet | null;
  /** Highest altitude seen so far, independent of whether apogee is declared. */
  peak_m: number | null;
  apogee: Apogee | null;
  phase: FlightPhase;
  events: FlightEvent[];
  link: LinkStats;
  /** [lon, lat] pairs, oldest first, for the map. */
  track: [number, number][];
  /**
   * The last packet that carried a GPS fix - NOT necessarily the last packet.
   * GPS can drop out before the link does, and near the ground it often will.
   */
  lastFix: Packet | null;
  /** Mission time of that fix, so the UI can show how stale it is. */
  lastFixAge_s: number;
};

export type DeriveOptions = {
  /** Overrides the automatic pad reference. */
  padOverride_pa?: number | null;
  /** Assumed air temperature at the pad. Not the chamber temperature. */
  padTemp_k?: number;
  apogeeConfig?: ApogeeConfig;
};

const EMPTY_LINK: LinkStats = {
  received: 0,
  expected: 0,
  lost: 0,
  lossRate: 0,
  windowLossRate: 0,
  lastPacketAge_s: 0,
  state: "waiting",
};

export function deriveFlight(
  packets: Packet[],
  now_s: number,
  opts: DeriveOptions = {}
): FlightView {
  const {
    padOverride_pa = null,
    padTemp_k = T0_ISA_K,
    apogeeConfig = DEFAULT_APOGEE_CONFIG,
  } = opts;

  const pad_pa = padOverride_pa ?? padReference(packets);
  const latest = packets[packets.length - 1] ?? null;

  const track: [number, number][] = [];
  let lastFix: Packet | null = null;
  for (const p of packets) {
    if (p.lat_deg !== undefined && p.lon_deg !== undefined) {
      track.push([p.lon_deg, p.lat_deg]);
      lastFix = p;
    }
  }

  const link = packets.length ? linkStats(packets, now_s) : EMPTY_LINK;

  // Without a pad reference there is no altitude to speak of, and saying so is
  // more honest than picking a reference that happens to produce numbers.
  if (pad_pa === null) {
    return {
      samples: [],
      pad_pa: null,
      latest,
      peak_m: null,
      apogee: null,
      phase: "waiting",
      events: [],
      link,
      track,
      lastFix,
      lastFixAge_s: 0,
    };
  }

  const pad = { pressure_pa: pad_pa, temp_k: padTemp_k };
  const samples: AltitudeSample[] = packets.map((p) => ({
    t_s: packetTime(p),
    alt_m: altitudeFromPressure(p.pressure_pa, pad),
  }));

  const apogee = detectApogee(samples, apogeeConfig);
  const peak_m = samples.reduce((m, s) => Math.max(m, s.alt_m), -Infinity);

  const launch = samples.find((s) => s.alt_m >= LAUNCH_ALT_M) ?? null;
  const landed =
    apogee !== null
      ? (samples.find((s) => s.t_s > apogee.t_s && s.alt_m <= LANDED_ALT_M) ??
        null)
      : null;

  const phase: FlightPhase =
    launch === null
      ? "pad"
      : landed !== null
        ? "landed"
        : apogee !== null
          ? "descent"
          : "ascent";

  const events: FlightEvent[] = [{ label: "PAD", t_s: samples[0].t_s }];
  if (launch) events.push({ label: "LAUNCH", t_s: launch.t_s });
  if (apogee)
    events.push({ label: "APOGEE", t_s: apogee.t_s, alt_m: apogee.alt_m });
  if (landed) events.push({ label: "LANDED", t_s: landed.t_s });

  return {
    samples,
    pad_pa,
    latest,
    peak_m: Number.isFinite(peak_m) ? peak_m : null,
    apogee,
    phase,
    events,
    link,
    track,
    lastFix,
    lastFixAge_s: lastFix ? Math.max(now_s - packetTime(lastFix), 0) : 0,
  };
}
