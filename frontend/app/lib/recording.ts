/**
 * Reading a recorded flight back in, for replay.
 *
 * The backend writes one JSONL file per flight - one packet per line, exactly
 * as it was broadcast to the browser - so a recording needs no conversion. It
 * parses straight into the same `Packet[]` live mode accumulates, and replay
 * hands that to the same `deriveFlight`.
 *
 * Imports only telemetry.ts, so it runs directly under Node.
 */

import { type Packet, packetTime } from "./telemetry.ts";

export type Recording = {
  packets: Packet[];
  /** Lines that were not a valid packet, skipped rather than fatal. */
  skipped: number;
};

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * The same rule the backend's `telemetry.decode` applies to a datagram, so a
 * line that could never have been broadcast cannot be replayed either. Rebuilt
 * field by field, so nothing else in the line reaches the derivation.
 */
function toPacket(value: unknown): Packet | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (
    v.schema !== 1 ||
    !isFiniteNumber(v.packet_id) ||
    !isFiniteNumber(v.pressure_pa) ||
    !isFiniteNumber(v.temp_c)
  ) {
    return null;
  }
  const p: Packet = {
    schema: 1,
    packet_id: v.packet_id,
    pressure_pa: v.pressure_pa,
    temp_c: v.temp_c,
  };
  if (isFiniteNumber(v.lat_deg)) p.lat_deg = v.lat_deg;
  if (isFiniteNumber(v.lon_deg)) p.lon_deg = v.lon_deg;
  return p;
}

/**
 * Parse a JSONL recording. Throws if there is nothing replayable in it.
 *
 * An unreadable line is skipped and counted, like a corrupt frame on the
 * link: the backend appends one line per packet, so a crash mid-write can
 * leave at most a partial last line, and that must not cost the whole flight.
 *
 * A counter that goes backwards is fatal instead. It means two flights in one
 * file - the backend never writes that - and either flight's pad reference
 * would corrupt every altitude in the other.
 */
export function parseRecording(text: string): Recording {
  const packets: Packet[] = [];
  let skipped = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let p: Packet | null = null;
    try {
      p = toPacket(JSON.parse(line));
    } catch {
      // Not JSON at all. Counted with the rest below.
    }
    if (p === null) {
      skipped++;
      continue;
    }
    const last = packets[packets.length - 1];
    if (last && p.packet_id <= last.packet_id) {
      throw new Error(
        `packet counter goes back from ${last.packet_id} to ${p.packet_id}: ` +
          "this file holds more than one flight"
      );
    }
    packets.push(p);
  }
  if (packets.length === 0) {
    throw new Error(
      skipped ? `none of ${skipped} lines is a packet` : "the file is empty"
    );
  }
  return { packets, skipped };
}

/**
 * How many packets of a recording had arrived by stream time `t_s`.
 *
 * Replay derives from `packets.slice(0, receivedBy(packets, playhead))`, which
 * is exactly the list live mode held at that moment - so seeking backwards is
 * a shorter slice, not a second code path.
 */
export function receivedBy(packets: Packet[], t_s: number): number {
  const i = packets.findIndex((p) => packetTime(p) > t_s);
  return i < 0 ? packets.length : i;
}
