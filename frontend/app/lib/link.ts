/**
 * Radio link health, derived entirely from the packet counter.
 *
 * Packet loss is a normal operating condition on a LoRa-style downlink, not an
 * error. The ground station's job is to report how much of it is happening,
 * not to hide it or to stop working when it does.
 *
 * The counter is the only evidence a lost packet ever existed: it advances in
 * the payload whether or not the transmission gets through, so a gap in the
 * received sequence is exactly one missing packet per missing number.
 */

import { PACKET_RATE_HZ, type Packet, packetTime } from "./telemetry.ts";

export type LinkState =
  | "waiting" // nothing received yet
  | "ok"
  | "degraded"
  | "lost";

export type LinkStats = {
  /** Packets actually received. */
  received: number;
  /** Packets the counter says should have arrived. */
  expected: number;
  lost: number;
  /** Fraction lost over the whole flight, 0-1. */
  lossRate: number;
  /** Fraction lost over the trailing window, 0-1. */
  windowLossRate: number;
  /** Seconds since the last packet, on the stream clock. */
  lastPacketAge_s: number;
  state: LinkState;
};

/** Packets in the trailing window used for the "right now" loss figure. */
export const LOSS_WINDOW = 30;

// At 1 Hz the age of the newest packet naturally oscillates between 0 and 1 s.
// One dropped packet takes it to 2 s, two consecutive drops to 3 s. The OK
// threshold sits above that so ordinary loss does not flap the indicator,
// which would be worse than useless during a flight.
const OK_AGE_S = 3.5 / PACKET_RATE_HZ;
const DEGRADED_AGE_S = 12 / PACKET_RATE_HZ;

const EMPTY: LinkStats = {
  received: 0,
  expected: 0,
  lost: 0,
  lossRate: 0,
  windowLossRate: 0,
  lastPacketAge_s: 0,
  state: "waiting",
};

/**
 * Link statistics for the flight so far.
 *
 * `now_s` is on the stream clock, never `Date.now()`. Live mode advances it
 * with the wall clock from the last arrival; replay mode passes the playhead.
 * Same function, so replay reproduces live exactly rather than approximating.
 */
export function linkStats(
  packets: Packet[],
  now_s: number,
  window = LOSS_WINDOW
): LinkStats {
  if (packets.length === 0) return EMPTY;

  const first = packets[0];
  const last = packets[packets.length - 1];

  // Counter-derived, so this counts packets that were transmitted and never
  // arrived - not merely the ones we happened to see.
  const expected = last.packet_id - first.packet_id + 1;
  const received = packets.length;
  const lost = Math.max(expected - received, 0);

  // Trailing window: how the link is behaving *now*, which is the number that
  // tells you it is degrading while there is still time to care.
  const windowStartId = last.packet_id - window + 1;
  const windowExpected = Math.min(window, expected);
  const windowReceived = packets.reduce(
    (n, p) => (p.packet_id >= windowStartId ? n + 1 : n),
    0
  );

  const lastPacketAge_s = Math.max(now_s - packetTime(last), 0);

  return {
    received,
    expected,
    lost,
    lossRate: expected > 0 ? lost / expected : 0,
    windowLossRate:
      windowExpected > 0 ? 1 - windowReceived / windowExpected : 0,
    lastPacketAge_s,
    state:
      lastPacketAge_s <= OK_AGE_S
        ? "ok"
        : lastPacketAge_s <= DEGRADED_AGE_S
          ? "degraded"
          : "lost",
  };
}
