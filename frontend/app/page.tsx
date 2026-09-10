"use client";

import { useEffect, useState } from "react";
import { altitudeFromPressure, T0_ISA_K } from "./lib/barometric";
import {
  PAD_SAMPLES,
  type Packet,
  packetTime,
  padReference,
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

  useEffect(() => {
    let ws: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    function connect() {
      ws = new WebSocket(WS_URL);
      ws.onopen = () => setConnected(true);
      ws.onmessage = (event) => {
        const p: Packet = JSON.parse(event.data);
        setPackets((prev) => {
          // The counter going backwards means the payload restarted. The old
          // flight's pad reference does not apply to the new one, and mixing
          // the two would corrupt every altitude, so start clean.
          const last = prev[prev.length - 1];
          return last && p.packet_id <= last.packet_id ? [p] : [...prev, p];
        });
      };
      // Reconnect rather than give up: a dropped link is a normal condition
      // here, and the backend replays the whole flight on reconnect.
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

  const latest = packets[packets.length - 1] ?? null;

  // Derived, never stored: the pad reference is a pure function of the first
  // few packets, so it settles once and re-derives identically on every render.
  const pad_pa = padOverride ?? padReference(packets);

  const alt_m =
    latest && pad_pa !== null
      ? altitudeFromPressure(latest.pressure_pa, {
          pressure_pa: pad_pa,
          temp_k: T0_ISA_K,
        })
      : null;

  const readout = [
    row("link", connected ? "connected" : "down"),
    row("packets", String(packets.length)),
    row(
      "pad ref",
      pad_pa === null
        ? `waiting for ${PAD_SAMPLES} packets`
        : `${pad_pa.toFixed(1)} Pa${padOverride === null ? "" : "  (manual)"}`
    ),
    "",
    row("packet", latest ? String(latest.packet_id) : "-"),
    row("t", latest ? `${packetTime(latest).toFixed(1)} s` : "-"),
    row("pressure", latest ? `${latest.pressure_pa.toFixed(1)} Pa` : "-"),
    row("chamber", latest ? `${latest.temp_c.toFixed(2)} C` : "-"),
    row(
      "gps",
      latest?.lat_deg !== undefined && latest.lon_deg !== undefined
        ? `${latest.lat_deg.toFixed(6)}, ${latest.lon_deg.toFixed(6)}`
        : "(no fix)"
    ),
    "",
    row("ALTITUDE", alt_m === null ? "-" : `${alt_m.toFixed(1)} m`),
  ].join("\n");

  return (
    <main>
      <h1>CanSat Ground Station</h1>
      <p>slice 2 - live barometric altitude, unstyled</p>
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
