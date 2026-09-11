"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import AltitudeChart, { clock } from "./components/AltitudeChart";
import { deriveFlight, type FlightPhase } from "./lib/flight";
import type { LinkState } from "./lib/link";
import { parseRecording, receivedBy } from "./lib/recording";
import { DRIFT_ALT_M, deriveRecovery } from "./lib/recovery";
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

/**
 * Recordings shipped in public/flights, so replay works on a fresh checkout
 * with no backend and no flight of your own. Each is a backend recording
 * copied verbatim - the same bytes "open recording" would read.
 */
const BUNDLED_FLIGHTS = [
  { file: "/flights/400m-gps-lost.jsonl", label: "400 m, GPS lost below 60 m" },
];
const SPEEDS = [1, 2, 5, 10, 20];

type Mode = "live" | "replay";
type Pane = "flight" | "recovery";

/** Shown where there is no value yet. Always in muted ink, never white. */
const PLACEHOLDER = "—";

const STATUS: Record<LinkState | "offline", { colour: string; label: string; glyph: string }> = {
  // A status colour never carries the meaning on its own: every one of these
  // ships with a text label and a distinct glyph, because the good/critical
  // pair is close to indistinguishable under deuteranopia.
  waiting: { colour: "#898781", label: "NO SIGNAL", glyph: "○" },
  ok: { colour: "#0ca30c", label: "LINK OK", glyph: "●" },
  degraded: { colour: "#fab219", label: "DEGRADED", glyph: "◐" },
  lost: { colour: "#d03b3b", label: "LINK LOST", glyph: "○" },
  // The browser cannot reach the backend, so it knows nothing about the radio
  // link either way. LINK LOST means the backend is up and packets stopped.
  offline: { colour: "#d03b3b", label: "NO BACKEND", glyph: "○" },
};

// The header's status slot is the one glanced at to ask "is it talking to us
// now?". In replay the answer is no, so it says REPLAY - the link state at the
// playhead is history, and shown there it reads as a claim about the present.
// It moves into the transport bar instead, marked as recorded.
const REPLAY_STATUS = { colour: "#c3c2b7", label: "REPLAY", glyph: "↺" };

const PHASE_LABEL: Record<FlightPhase, string> = {
  waiting: "STANDBY",
  pad: "ON PAD",
  ascent: "ASCENT",
  descent: "DESCENT",
  landed: "LANDED",
};

type PlayClock = { from_s: number; atMs: number; speed: number };

/** Where a running replay clock has got to by `ms` (a performance.now()). */
function playheadAt(c: PlayClock, ms: number): number {
  return c.from_s + ((ms - c.atMs) / 1000) * c.speed;
}

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

function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  format = String,
}: {
  options: readonly T[];
  value: T;
  onChange: (v: T) => void;
  format?: (v: T) => string;
}) {
  return (
    <div className="flex overflow-hidden rounded border border-white/10 text-[11px]">
      {options.map((v) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={`px-2.5 py-1 uppercase tracking-wider ${
            value === v ? "bg-white/10 text-white" : "text-[#898781] hover:text-white"
          }`}
        >
          {format(v)}
        </button>
      ))}
    </div>
  );
}

export default function Home() {
  // Mode is where the packets come from. Everything downstream of that one
  // choice - derivation, chart, map, recovery - is shared by both modes.
  const [mode, setMode] = useState<Mode>("live");

  const [packets, setPackets] = useState<Packet[]>([]);
  const [connected, setConnected] = useState(false);
  const [padOverride, setPadOverride] = useState<number | null>(null);
  const [target_m, setTarget] = useState(400);

  // A view, not a mode. Mode is where the data comes from (live or replay);
  // view is what you are looking at. Keeping them on separate axes is what
  // makes "replay the recovery view" expressible at all.
  const [pane, setPane] = useState<Pane>("flight");

  // Stream clock. `anchor` pins the newest packet's mission time to the wall
  // clock instant it arrived; the interval advances `now_s` between arrivals so
  // staleness keeps climbing while nothing is coming in. Without that the UI
  // would freeze on the last good frame, which is exactly the failure mode a
  // lossy link must not have. Replay sets the time from its playhead instead
  // and feeds the same `deriveFlight`.
  const [anchor, setAnchor] = useState<{ t_s: number; atMs: number } | null>(null);
  const [now_s, setNow_s] = useState(0);

  // Replay holds the whole recording; the playhead picks how much of it had
  // arrived by that point in the flight.
  const [replay, setReplay] = useState<{
    name: string;
    packets: Packet[];
    skipped: number;
  } | null>(null);
  const [replayError, setReplayError] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [speed, setSpeed] = useState(1);
  // The live stream clock again, anchored to the playhead instead of to the
  // newest packet and advancing `speed` seconds per second. Null when paused.
  const [playClock, setPlayClock] = useState<PlayClock | null>(null);

  const start_s = replay ? packetTime(replay.packets[0]) : 0;
  const end_s = replay ? packetTime(replay.packets[replay.packets.length - 1]) : 0;

  useEffect(() => {
    if (anchor === null || mode !== "live") return;
    // The interval does the first update too, within 250 ms. Setting state
    // directly in the effect body would be a render-phase write.
    const id = setInterval(
      () => setNow_s(anchor.t_s + (Date.now() - anchor.atMs) / 1000),
      250
    );
    return () => clearInterval(id);
  }, [anchor, mode]);

  useEffect(() => {
    if (playClock === null) return;
    const id = setInterval(() => {
      const t = playheadAt(playClock, performance.now());
      // Stops on the last packet rather than running on past it. Beyond the
      // end the link would read as lost, which is a fact about the recording
      // stopping, not about the flight.
      if (t >= end_s) {
        setPlayhead(end_s);
        setPlayClock(null);
      } else {
        setPlayhead(t);
      }
    }, 100);
    return () => clearInterval(id);
  }, [playClock, end_s]);

  useEffect(() => {
    // Replay needs nothing from the backend, so it does not even connect.
    // Closing loses nothing: the backend holds the whole flight and replays it
    // to a browser that reconnects.
    if (mode !== "live") return;

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
  }, [mode]);

  function loadRecording(name: string, text: string) {
    try {
      const rec = parseRecording(text);
      setReplay({ name, ...rec });
      setPlayhead(packetTime(rec.packets[0]));
      setPlayClock(null);
      setPadOverride(null);
      setReplayError(null);
    } catch (err) {
      setReplayError(`${name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  function loadBundled(flight: (typeof BUNDLED_FLIGHTS)[number]) {
    fetch(flight.file)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status} fetching ${flight.file}`);
        return r.text();
      })
      .then((text) => loadRecording(flight.label, text))
      .catch((err) => setReplayError(`${flight.label}: ${err.message}`));
  }

  function openFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Cleared so that choosing the same file again still fires a change.
    e.target.value = "";
    if (!file) return;
    file.text().then(
      (text) => loadRecording(file.name, text),
      (err) => setReplayError(`${file.name}: ${err.message}`)
    );
  }

  function switchMode(next: Mode) {
    if (next === mode) return;
    setMode(next);
    // A re-captured pad reference belongs to the packets it was taken from.
    setPadOverride(null);
    setPlayClock(null);
    if (next === "replay" && replay === null) loadBundled(BUNDLED_FLIGHTS[0]);
  }

  function playheadNow(): number {
    return playClock === null
      ? playhead
      : Math.min(playheadAt(playClock, performance.now()), end_s);
  }

  function togglePlay() {
    if (replay === null) return;
    if (playClock !== null) {
      setPlayhead(playheadNow());
      setPlayClock(null);
      return;
    }
    // Play from the end starts the flight again, as any player does.
    const from = playhead >= end_s ? start_s : playhead;
    setPlayhead(from);
    setPlayClock({ from_s: from, atMs: performance.now(), speed });
  }

  function seek(t_s: number) {
    setPlayhead(t_s);
    if (playClock !== null) {
      setPlayClock({ ...playClock, from_s: t_s, atMs: performance.now() });
    }
  }

  function changeSpeed(s: number) {
    setSpeed(s);
    // Re-anchored where the playhead is now, or the new rate would apply to
    // time already played and the playhead would jump.
    if (playClock !== null) {
      const t = playheadNow();
      setPlayhead(t);
      setPlayClock({ from_s: t, atMs: performance.now(), speed: s });
    }
  }

  // The only place the two modes differ: which packets, and what time it is.
  // Replay passes exactly the prefix live mode held at that moment in the
  // flight, so apogee is declared, and the link degrades, when it did live.
  const shown =
    mode === "live"
      ? packets
      : replay
        ? replay.packets.slice(0, receivedBy(replay.packets, playhead))
        : [];
  const view = deriveFlight(shown, mode === "live" ? now_s : playhead, {
    padOverride_pa: padOverride,
  });
  const { latest, link, apogee, samples } = view;

  const linkStatus = STATUS[mode === "live" && !connected ? "offline" : link.state];
  const status = mode === "replay" ? REPLAY_STATUS : linkStatus;
  const stale = link.received > 0 && link.state !== "ok";
  const alt_m = samples.length ? samples[samples.length - 1].alt_m : null;
  const shown_m = apogee?.alt_m ?? view.peak_m;
  const delta_m = shown_m === null ? null : shown_m - target_m;

  const fix =
    view.lastFix?.lat_deg !== undefined && view.lastFix.lon_deg !== undefined
      ? { lat_deg: view.lastFix.lat_deg, lon_deg: view.lastFix.lon_deg }
      : null;
  const rec = deriveRecovery({
    pad: view.padFix,
    fix,
    fixAlt_m: view.lastFixAlt_m,
    age_s: view.lastFixAge_s,
    packetsSinceFix: view.packetsSinceFix,
  });

  return (
    <div className="flex h-screen flex-col bg-[#0d0d0d] font-sans text-white">
      <header className="flex shrink-0 items-center justify-between border-b border-white/10 px-4 py-2.5">
        <h1 className="text-sm font-semibold uppercase tracking-widest">
          CanSat Ground Station
        </h1>
        <div className="flex items-center gap-4 text-xs font-medium">
          <Segmented options={["live", "replay"] as const} value={mode} onChange={switchMode} />
          <Segmented options={["flight", "recovery"] as const} value={pane} onChange={setPane} />
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

      {/* On screen for as long as replay is: a recorded flight that could be
          mistaken for a live one is worse than no replay at all. */}
      {mode === "replay" && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-white/10 bg-[#1a1a19] px-4 py-2 text-xs">
          <button
            onClick={togglePlay}
            disabled={replay === null}
            aria-label={playClock ? "Pause" : "Play"}
            className="w-9 rounded border border-white/15 py-0.5 text-white hover:bg-white/10 disabled:text-white/20"
          >
            {playClock ? "❚❚" : "▶"}
          </button>
          <span className="tabular-nums text-white">
            t+{clock(playhead)}
            <span className="text-[#898781]"> / {clock(end_s)}</span>
          </span>
          {/* What the link was doing at this point in the flight: beside the
              playhead it belongs to, not in the header. */}
          {replay !== null && (
            <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider">
              <span className="text-[#898781]">recorded</span>
              <span className="flex items-center gap-1" style={{ color: linkStatus.colour }}>
                <span aria-hidden>{linkStatus.glyph}</span>
                {linkStatus.label}
              </span>
            </span>
          )}
          <input
            type="range"
            min={start_s}
            max={end_s}
            step="any"
            value={playhead}
            onChange={(e) => seek(Number(e.target.value))}
            disabled={replay === null}
            aria-label="Playhead"
            className="min-w-32 flex-1 accent-[#3987e5]"
          />
          <Segmented options={SPEEDS} value={speed} onChange={changeSpeed} format={(s) => `${s}×`} />
          <select
            value={replay?.name ?? ""}
            onChange={(e) => {
              const flight = BUNDLED_FLIGHTS.find((f) => f.label === e.target.value);
              if (flight) loadBundled(flight);
            }}
            aria-label="Recording"
            className="max-w-64 rounded border border-white/10 bg-[#0d0d0d] px-1.5 py-1 text-xs text-white"
          >
            {replay === null && <option value="">no recording loaded</option>}
            {replay !== null && !BUNDLED_FLIGHTS.some((f) => f.label === replay.name) && (
              <option value={replay.name}>{replay.name}</option>
            )}
            {BUNDLED_FLIGHTS.map((f) => (
              <option key={f.file} value={f.label}>
                {f.label}
              </option>
            ))}
          </select>
          <label className="cursor-pointer text-[11px] text-[#898781] hover:text-white">
            open recording…
            <input type="file" accept=".jsonl" onChange={openFile} className="hidden" />
          </label>
          {replay !== null && replay.skipped > 0 && (
            <span className="text-[11px] text-[#fab219]">
              {replay.skipped} unreadable line{replay.skipped === 1 ? "" : "s"} skipped
            </span>
          )}
          {replayError && (
            <span className="basis-full text-[11px] text-[#fab219]">
              Could not load {replayError}
            </span>
          )}
        </div>
      )}

      <main className="flex min-h-0 flex-1">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 p-3">
          {/* The chart is the primary surface, not the map: a rocket's ground
              track during ascent is a near-vertical line and says almost
              nothing in two dimensions. */}
          {pane === "flight" && (
            <div key="chart" className="flex min-h-0 flex-[2] flex-col">
              <AltitudeChart samples={samples} apogee={apogee} target_m={target_m} />
            </div>
          )}
          {/* Keyed, so toggling the view resizes this element rather than
              unmounting it - remounting would rebuild the map and throw away
              every tile it has already fetched. */}
          <div
            key="map"
            className="min-h-0 flex-1 overflow-hidden rounded-lg border border-white/10"
          >
            <FlightMap
              track={view.track}
              pad={view.padFix}
              position={fix}
              stale={view.lastFixAge_s > 5}
              focus={pane}
            />
          </div>
        </section>

        <aside className="flex w-[340px] shrink-0 flex-col gap-3 overflow-y-auto border-l border-white/10 p-3">
          {pane === "flight" ? (
            <>
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
                    onClick={() => setPadOverride(padReferenceFromLatest(shown))}
                    disabled={shown.length < PAD_SAMPLES}
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
            </>
          ) : rec === null ? (
            <Panel title="Recovery">
              <p className="text-xs text-[#898781]">
                No GPS fix received yet. Bearing and distance need a pad
                position and a payload position.
              </p>
            </Panel>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Panel>
                  <div className="text-[11px] font-medium uppercase tracking-wider text-[#898781]">
                    Distance
                  </div>
                  <div className="text-4xl font-semibold leading-tight text-white">
                    {rec.distance_m < 1000
                      ? rec.distance_m.toFixed(0)
                      : (rec.distance_m / 1000).toFixed(2)}
                    <span className="ml-1 text-sm font-normal text-[#898781]">
                      {rec.distance_m < 1000 ? "m" : "km"}
                    </span>
                  </div>
                  <div className="text-[10px] text-[#898781]">from the pad</div>
                </Panel>
                <Panel>
                  <div className="text-[11px] font-medium uppercase tracking-wider text-[#898781]">
                    Bearing
                  </div>
                  <div className="text-4xl font-semibold leading-tight text-white">
                    {rec.bearing_deg.toFixed(0).padStart(3, "0")}
                    <span className="text-sm font-normal text-[#898781]">
                      &deg;
                    </span>
                  </div>
                  <div className="text-[10px] text-[#898781]">
                    {rec.compass}, true north
                  </div>
                </Panel>
              </div>

              {/* The whole reason this view is careful: a bearing taken from a
                  stale fix, presented as if it were current, is the failure
                  that actually loses the payload. */}
              {rec.suspect && (
                <div className="rounded-lg border border-[#fab219]/40 bg-[#fab219]/10 p-3">
                  <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-[#fab219]">
                    <span aria-hidden>&#9650;</span> Last fix is not the landing
                    site
                  </div>
                  <p className="text-[11px] leading-snug text-[#c3c2b7]">
                    {rec.fixAlt_m !== null && rec.fixAlt_m > DRIFT_ALT_M
                      ? `The payload was still ${rec.fixAlt_m.toFixed(0)} m up when it was last seen, so it drifted further before landing. `
                      : ""}
                    {rec.packetsSinceFix > 0
                      ? `${rec.packetsSinceFix} packet${rec.packetsSinceFix === 1 ? "" : "s"} have arrived since, with no position. `
                      : ""}
                    Treat the distance as a lower bound and search downwind.
                  </p>
                </div>
              )}

              <Panel title="Last known fix">
                {/* Selectable, and in the order every phone map expects. */}
                <div className="select-all rounded border border-white/10 bg-[#0d0d0d] px-2 py-1.5 text-sm tabular-nums text-white">
                  {rec.fix.lat_deg.toFixed(6)}, {rec.fix.lon_deg.toFixed(6)}
                </div>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] tabular-nums">
                  <dt className="text-[#898781]">Fix age</dt>
                  <dd className="text-right text-white">
                    {rec.age_s.toFixed(0)} s
                  </dd>
                  <dt className="text-[#898781]">Packets since</dt>
                  <dd
                    className="text-right"
                    style={{
                      color: rec.packetsSinceFix > 0 ? "#fab219" : "#ffffff",
                    }}
                  >
                    {rec.packetsSinceFix}
                  </dd>
                  <dt className="text-[#898781]">Altitude at fix</dt>
                  <dd className="text-right text-white">
                    {rec.fixAlt_m === null
                      ? PLACEHOLDER
                      : `${rec.fixAlt_m.toFixed(0)} m`}
                  </dd>
                  <dt className="text-[#898781]">Pad</dt>
                  <dd className="text-right text-white">
                    {view.padFix
                      ? `${view.padFix.lat_deg.toFixed(4)}, ${view.padFix.lon_deg.toFixed(4)}`
                      : PLACEHOLDER}
                  </dd>
                </dl>
              </Panel>

              <div className="grid grid-cols-2 gap-3">
                <Tile
                  label="Packet loss"
                  value={
                    link.expected === 0
                      ? PLACEHOLDER
                      : (link.lossRate * 100).toFixed(1)
                  }
                  unit="%"
                />
                <Tile
                  label="Last packet"
                  value={link.lastPacketAge_s.toFixed(0)}
                  unit="s ago"
                  muted={stale}
                />
              </div>
            </>
          )}
        </aside>
      </main>
    </div>
  );
}
