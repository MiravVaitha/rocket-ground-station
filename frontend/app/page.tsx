"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import AltitudeChart from "./components/AltitudeChart";
import { deriveFlight, type FlightPhase } from "./lib/flight";
import type { LinkState } from "./lib/link";
import {
  PAD_SAMPLES,
  type Packet,
  packetTime,
  padReferenceFromLatest,
} from "./lib/telemetry";

// MapLibre touches window and WebGL, so the map must never render on the server.
const FlightMap = dynamic(() => import("./components/FlightMap"), { ssr: false });

const WS_URL = "ws://127.0.0.1:8000/ws";
const TARGET_PRESETS = [400, 2000, 2200];

/** Shown where there is no value yet. Always in muted ink, never white. */
const PLACEHOLDER = "—";

const STATUS: Record<LinkState, { colour: string; label: string; glyph: string }> = {
  // A status colour never carries the meaning on its own: every one of these
  // ships with a text label and a distinct glyph, because the good/critical
  // pair is close to indistinguishable under deuteranopia.
  waiting: { colour: "#898781", label: "NO SIGNAL", glyph: "○" },
  ok: { colour: "#0ca30c", label: "LINK OK", glyph: "●" },
  degraded: { colour: "#fab219", label: "DEGRADED", glyph: "◐" },
  lost: { colour: "#d03b3b", label: "LINK LOST", glyph: "○" },
};

const PHASE_LABEL: Record<FlightPhase, string> = {
  waiting: "STANDBY",
  pad: "ON PAD",
  ascent: "ASCENT",
  descent: "DESCENT",
  landed: "LANDED",
};

function Panel({
  title,
  action,
  children,
}: {
  title?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-[#1a1a19] p-3">
      {title && (
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs font-medium uppercase tracking-wider text-[#c3c2b7]">
            {title}
          </span>
          {action}
        </div>
      )}
      {children}
    </div>
  );
}

function Tile({
  label,
  value,
  unit,
  muted,
  note,
}: {
  label: string;
  value: string;
  unit?: string;
  muted?: boolean;
  note?: string;
}) {
  return (
    <div className="rounded-lg border border-white/10 bg-[#1a1a19] px-3 py-2">
      <div className="text-[11px] font-medium uppercase tracking-wider text-[#898781]">
        {label}
      </div>
      {/* tabular-nums here on purpose: these update every second, and digits
          changing width makes a live readout jitter. The hero figure below
          uses proportional figures, where equal-width digits read loose. */}
      <div
        className={`text-xl font-semibold tabular-nums ${
          muted || value === PLACEHOLDER ? "text-[#898781]" : "text-white"
        }`}
      >
        {value}
        {unit && (
          <span className="ml-1 text-xs font-normal text-[#898781]">{unit}</span>
        )}
      </div>
      {note && <div className="text-[10px] text-[#898781]">{note}</div>}
    </div>
  );
}

export default function Home() {
  const [packets, setPackets] = useState<Packet[]>([]);
  const [connected, setConnected] = useState(false);
  const [padOverride, setPadOverride] = useState<number | null>(null);
  const [target_m, setTarget] = useState(400);

  // Stream clock. `anchor` pins the newest packet's mission time to the wall
  // clock instant it arrived; the interval advances `now_s` between arrivals so
  // staleness keeps climbing while nothing is coming in. Without that the UI
  // would freeze on the last good frame, which is exactly the failure mode a
  // lossy link must not have. Replay will set `now_s` from the playhead and
  // skip all of this, feeding the same `deriveFlight`.
  const [anchor, setAnchor] = useState<{ t_s: number; atMs: number } | null>(null);
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
  const { latest, link, apogee, samples } = view;

  const status = STATUS[connected ? link.state : "lost"];
  const stale = link.received > 0 && link.state !== "ok";
  const alt_m = samples.length ? samples[samples.length - 1].alt_m : null;
  const shown_m = apogee?.alt_m ?? view.peak_m;
  const delta_m = shown_m === null ? null : shown_m - target_m;

  return (
    <div className="flex h-screen flex-col bg-[#0d0d0d] font-sans text-white">
      <header className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-2.5">
        <h1 className="text-sm font-semibold uppercase tracking-widest">
          CanSat Ground Station
        </h1>
        <div className="flex items-center gap-4 text-xs font-medium">
          <span className="rounded border border-white/15 px-2 py-0.5 uppercase tracking-wider text-[#c3c2b7]">
            {PHASE_LABEL[view.phase]}
          </span>
          <span
            className="flex items-center gap-1.5"
            style={{ color: status.colour }}
          >
            <span aria-hidden>{status.glyph}</span>
            {status.label}
          </span>
        </div>
      </header>

      <main className="flex min-h-0 flex-1">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-3">
          {/* The chart is the primary surface, not the map: a rocket's ground
              track during ascent is a near-vertical line and says almost
              nothing in two dimensions. */}
          <div className="flex min-h-0 flex-[2] flex-col">
            <AltitudeChart samples={samples} apogee={apogee} target_m={target_m} />
          </div>
          <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-white/10">
            <FlightMap
              track={view.track}
              pad={view.padFix}
              position={
                view.lastFix?.lat_deg !== undefined &&
                view.lastFix.lon_deg !== undefined
                  ? {
                      lat_deg: view.lastFix.lat_deg,
                      lon_deg: view.lastFix.lon_deg,
                    }
                  : null
              }
              stale={view.lastFixAge_s > 5}
            />
          </div>
        </section>

        <aside className="flex w-[340px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-white/10 p-3">
          <Panel>
            <div className="text-[11px] font-medium uppercase tracking-wider text-[#898781]">
              {apogee ? "Apogee" : "Peak so far"}
            </div>
            {/* Proportional figures on the hero: tabular digits read loose at
                display size. */}
            {shown_m === null ? (
              <div className="py-2 text-2xl font-semibold leading-tight text-[#898781]">
                {PLACEHOLDER}
                <span className="ml-1.5 text-base font-normal">m</span>
              </div>
            ) : (
              <div className="text-5xl font-semibold leading-tight text-white">
                {shown_m.toFixed(0)}
                <span className="ml-1.5 text-base font-normal text-[#898781]">m</span>
              </div>
            )}
            {delta_m !== null && shown_m !== null && (
              <div className="mt-0.5 text-xs tabular-nums text-[#c3c2b7]">
                {delta_m >= 0 ? "+" : ""}
                {delta_m.toFixed(0)} m against {target_m} m target
                <span className="ml-1 text-[#898781]">
                  ({((shown_m / target_m) * 100).toFixed(0)}%)
                </span>
              </div>
            )}
            {apogee && (
              <div className="mt-1 text-[11px] tabular-nums text-[#898781]">
                at t+{apogee.t_s.toFixed(1)} s, declared{" "}
                {(apogee.detectedAt_s - apogee.t_s).toFixed(1)} s later
              </div>
            )}
          </Panel>

          <Panel title="Target">
            <div className="flex items-center gap-1.5">
              {TARGET_PRESETS.map((t) => (
                <button
                  key={t}
                  onClick={() => setTarget(t)}
                  className={`rounded px-2 py-1 text-[11px] font-medium tabular-nums ${
                    target_m === t
                      ? "bg-white/10 text-white"
                      : "text-[#898781] hover:text-white"
                  }`}
                >
                  {t} m
                </button>
              ))}
              <input
                type="number"
                value={target_m}
                onChange={(e) => setTarget(Number(e.target.value))}
                className="ml-auto w-20 rounded border border-white/10 bg-[#0d0d0d] px-1.5 py-1 text-right text-xs tabular-nums text-white"
              />
            </div>
            <p className="mt-1.5 text-[10px] leading-snug text-[#898781]">
              Set on the ground. The payload does not transmit what it was
              aiming for.
            </p>
          </Panel>

          <div className="grid grid-cols-2 gap-3">
            <Tile
              label="Altitude"
              value={alt_m === null ? PLACEHOLDER : alt_m.toFixed(0)}
              unit="m"
              muted={stale}
              note={stale ? `${link.lastPacketAge_s.toFixed(0)} s old` : undefined}
            />
            <Tile
              label="Chamber"
              value={latest ? latest.temp_c.toFixed(1) : PLACEHOLDER}
              unit="°C"
              muted={stale}
            />
            <Tile
              label="Packet loss"
              value={link.expected === 0 ? PLACEHOLDER : (link.lossRate * 100).toFixed(1)}
              unit="%"
              note={
                link.expected === 0
                  ? undefined
                  : `${(link.windowLossRate * 100).toFixed(0)}% last 30`
              }
            />
            <Tile
              label="Packets"
              value={link.expected === 0 ? PLACEHOLDER : String(link.received)}
              note={link.expected === 0 ? undefined : `${link.lost} lost`}
            />
          </div>

          <Panel title="Flight events">
            {view.events.length === 0 ? (
              <p className="text-xs text-[#898781]">Waiting for telemetry.</p>
            ) : (
              <ul className="flex flex-col gap-1 text-xs tabular-nums">
                {view.events.map((e) => (
                  <li key={e.label} className="flex items-baseline gap-2">
                    <span
                      className="w-16 font-semibold"
                      style={{
                        color: e.label === "APOGEE" ? "#d95926" : "#c3c2b7",
                      }}
                    >
                      {e.label}
                    </span>
                    <span className="text-[#898781]">t+{e.t_s.toFixed(1)} s</span>
                    {e.alt_m !== undefined && (
                      <span className="ml-auto text-white">
                        {e.alt_m.toFixed(0)} m
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel
            title="Pad reference"
            action={
              <button
                onClick={() => setPadOverride(padReferenceFromLatest(packets))}
                disabled={packets.length < PAD_SAMPLES}
                className="text-[11px] text-[#898781] hover:text-white disabled:text-white/20"
              >
                re-capture
              </button>
            }
          >
            <div className="text-sm tabular-nums text-white">
              {view.pad_pa === null
                ? `waiting for ${PAD_SAMPLES} packets`
                : `${view.pad_pa.toFixed(1)} Pa`}
            </div>
            <p className="mt-1 text-[10px] leading-snug text-[#898781]">
              {padOverride === null
                ? `Median of the first ${PAD_SAMPLES} packets. Every altitude is measured against it.`
                : "Manually re-captured from the most recent packets."}
              {padOverride !== null && (
                <button
                  onClick={() => setPadOverride(null)}
                  className="ml-1 underline hover:text-white"
                >
                  reset
                </button>
              )}
            </p>
          </Panel>
        </aside>
      </main>
    </div>
  );
}
