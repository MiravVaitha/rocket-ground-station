"use client";

import { useEffect, useState } from "react";
import { deriveFlight } from "./lib/flight";
import {
  PAD_SAMPLES,
  type Packet,
  packetTime,
  padReferenceFromLatest,
} from "./lib/telemetry";

const WS_URL = "ws://127.0.0.1:8000/ws";

function row(label: string, value: string): string {
  return `${label.padEnd(11)}${value}`;
}

export default function Home() {
  const [packets, setPackets] = useState<Packet[]>([]);
  const [connected, setConnected] = useState(false);
  const [padOverride, setPadOverride] = useState<number | null>(null);

  // Stream clock. `anchor` pins the newest packet's mission time to the wall
  // clock instant it arrived; the interval then advances `now_s` between
  // arrivals so link staleness keeps climbing while nothing is coming in.
  // Without that the UI would freeze on the last good frame, which is exactly
  // the failure mode a lossy link must not have.
  //
  // Replay will set `now_s` straight from the playhead and skip all of this,
  // feeding the same `deriveFlight` below.
  const [anchor, setAnchor] = useState<{ t_s: number; atMs: number } | null>(
    null
  );
  const [now_s, setNow_s] = useState(0);

  useEffect(() => {
    if (anchor === null) return;
    // The interval does the first update too, within 250 ms. Setting state
    // directly in the effect body would be a render-phase write.
    const id = setInterval(
      () => setNow_s(anchor.t_s + (Date.now() - anchor.atMs) / 1000),
      250
    );
    return () => clearInterval(id);
  }, [anchor]);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    function connect() {
      ws = new WebSocket(WS_URL);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (event) => {
        const p: Packet = JSON.parse(event.data);
        setAnchor({ t_s: packetTime(p), atMs: Date.now() });
        setPackets((prev) => {
          // The counter going backwards means the payload restarted. The old
          // flight's pad reference does not apply to the new one, and mixing
          // the two would corrupt every altitude, so start clean.
          const last = prev[prev.length - 1];
          return last && p.packet_id <= last.packet_id ? [p] : [...prev, p];
        });
      };
      ws.onclose = () => {
        setConnected(false);
        if (!stopped) retry = setTimeout(connect, 2000);
      };
    }
    connect();

    return () => {
      stopped = true;
      clearTimeout(retry);
      ws?.close();
    };
  }, []);

  const view = deriveFlight(packets, now_s, { padOverride_pa: padOverride });
  const { latest, link, apogee } = view;

  const readout = [
    row("link", connected ? `${link.state} (ws up)` : "ws down"),
    row("phase", view.phase),
    row(
      "packets",
      link.received === 0
        ? "0"
        : `${link.received} of ${link.expected}  (${link.lost} lost, ` +
          `${(link.lossRate * 100).toFixed(1)}% overall, ` +
          `${(link.windowLossRate * 100).toFixed(0)}% recent)`
    ),
    row("last pkt", `${link.lastPacketAge_s.toFixed(1)} s ago`),
    row(
      "pad ref",
      view.pad_pa === null
        ? `waiting for ${PAD_SAMPLES} packets`
        : `${view.pad_pa.toFixed(1)} Pa${padOverride === null ? "" : "  (manual)"}`
    ),
    "",
    row("packet", latest ? String(latest.packet_id) : "-"),
    row("t", latest ? `${packetTime(latest).toFixed(1)} s` : "-"),
    row("pressure", latest ? `${latest.pressure_pa.toFixed(1)} Pa` : "-"),
    row("chamber", latest ? `${latest.temp_c.toFixed(2)} C` : "-"),
    row(
      "gps",
      view.lastFix?.lat_deg !== undefined && view.lastFix.lon_deg !== undefined
        ? `${view.lastFix.lat_deg.toFixed(6)}, ${view.lastFix.lon_deg.toFixed(6)}` +
          (view.lastFixAge_s > 2 ? `   (${view.lastFixAge_s.toFixed(0)} s old)` : "")
        : "(no fix)"
    ),
    "",
    row(
      "ALTITUDE",
      view.samples.length
        ? `${view.samples[view.samples.length - 1].alt_m.toFixed(1)} m`
        : "-"
    ),
    row("peak", view.peak_m === null ? "-" : `${view.peak_m.toFixed(1)} m`),
    row(
      "APOGEE",
      apogee
        ? `${apogee.alt_m.toFixed(1)} m at t=${apogee.t_s.toFixed(1)} s ` +
          `(declared ${(apogee.detectedAt_s - apogee.t_s).toFixed(1)} s later)`
        : "not detected"
    ),
    "",
    row(
      "events",
      view.events.length
        ? view.events
            .map(
              (e) =>
                `${e.label} t=${e.t_s.toFixed(1)}s` +
                (e.alt_m !== undefined ? ` ${e.alt_m.toFixed(0)}m` : "")
            )
            .join("  |  ")
        : "-"
    ),
  ].join("\n");

  return (
    <main>
      <h1>CanSat Ground Station</h1>
      <p>slice 3 - apogee detection and link health, unstyled</p>
      <pre>{readout}</pre>
      <button
        onClick={() => setPadOverride(padReferenceFromLatest(packets))}
        disabled={packets.length < PAD_SAMPLES}
      >
        re-capture pad reference from the last {PAD_SAMPLES} packets
      </button>{" "}
      <button onClick={() => setPadOverride(null)} disabled={padOverride === null}>
        reset
      </button>
    </main>
  );
}
