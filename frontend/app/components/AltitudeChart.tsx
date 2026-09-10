"use client";

import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AltitudeSample, Apogee } from "../lib/apogee";
import { PACKET_RATE_HZ } from "../lib/telemetry";

/**
 * Altitude against time - the primary surface of the whole application.
 *
 * Three things distinguish it from a general-purpose telemetry chart:
 *
 * - **The whole flight, always.** No sliding window. An ascent lasts ten to
 *   twenty seconds and must never scroll off the left edge.
 * - **Every packet is drawn as a dot.** At 1 Hz the individual packets *are*
 *   the dataset, and showing them makes both the sample density and every
 *   dropout self-evident rather than implied.
 * - **Gaps are drawn as gaps.** A missing packet breaks the line. Interpolating
 *   across a dropout would draw a flight that did not happen.
 */

const SERIES = "#3987e5"; // altitude
const APOGEE = "#d95926"; // the one annotated event
const GRID = "#2c2c2a";
const AXIS = "#383835";
const INK_MUTED = "#898781";
const SURFACE = "#1a1a19";

/** Ladder of round tick spacings; the first giving <= 6 ticks wins. */
const TICK_STEPS = [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 2500];

/** A gap longer than this many packet intervals breaks the line. */
const GAP_INTERVALS = 1.5;

type Point = { t_s: number; alt_m: number | null };

/**
 * Insert a null between samples separated by more than one packet interval.
 *
 * Recharts joins consecutive array entries regardless of their x distance, so
 * without this the line would stride straight over a dropout and read as data.
 */
export function withGaps(samples: AltitudeSample[]): Point[] {
  const maxGap_s = GAP_INTERVALS / PACKET_RATE_HZ;
  const out: Point[] = [];
  for (let i = 0; i < samples.length; i++) {
    if (i > 0 && samples[i].t_s - samples[i - 1].t_s > maxGap_s) {
      out.push({ t_s: (samples[i].t_s + samples[i - 1].t_s) / 2, alt_m: null });
    }
    out.push({ t_s: samples[i].t_s, alt_m: samples[i].alt_m });
  }
  return out;
}

function clock(s: number): string {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

type Props = {
  samples: AltitudeSample[];
  apogee: Apogee | null;
  target_m: number;
};

export default function AltitudeChart({ samples, apogee, target_m }: Props) {
  const data = withGaps(samples);
  const peak = samples.reduce((m, s) => Math.max(m, s.alt_m), 0);

  // Round ticks, chosen from a fixed ladder so the axis reads 0/100/200 rather
  // than whatever the data happened to peak at. Headroom above whichever of the
  // peak and the target is higher, so neither the apogee marker nor the target
  // rule is clipped against the top of the plot.
  const reach = Math.max(peak, target_m, 1);
  const step = TICK_STEPS.find((v) => reach / v <= 6) ?? 5000;
  const top = Math.ceil((reach * 1.12) / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  // The pad reads a metre or two either side of zero, and clipping that would
  // misrepresent the noise. Show it, but do not put a tick on it.
  const floor = Math.min(0, ...samples.map((x) => x.alt_m));

  return (
    <div className="flex min-h-0 flex-1 flex-col rounded-lg border border-white/10 bg-[#1a1a19] p-3">
      <div className="mb-1 flex items-baseline gap-2">
        <span className="inline-block h-[3px] w-4 rounded-full bg-[#3987e5]" />
        <span className="text-xs font-medium uppercase tracking-wider text-[#c3c2b7]">
          Altitude
          <span className="ml-1 normal-case text-[#898781]">
            m above pad, derived from pressure
          </span>
        </span>
      </div>

      <div className="min-h-0 flex-1">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 14, right: 18, bottom: 4, left: -6 }}>
            {/* Solid hairlines: a dashed grid reads as a threshold, and the one
                real threshold on this chart is the target rule below. */}
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis
              dataKey="t_s"
              type="number"
              domain={[0, "dataMax"]}
              tickFormatter={clock}
              stroke={AXIS}
              tick={{ fill: INK_MUTED, fontSize: 11 }}
              tickLine={false}
              interval="preserveStartEnd"
            />
            <YAxis
              domain={[floor, top]}
              ticks={ticks}
              stroke={AXIS}
              tick={{ fill: INK_MUTED, fontSize: 11 }}
              tickLine={false}
              width={52}
              tickFormatter={(v: number) => v.toFixed(0)}
            />
            <Tooltip
              isAnimationActive={false}
              cursor={{ stroke: INK_MUTED, strokeDasharray: "3 3" }}
              contentStyle={{
                backgroundColor: SURFACE,
                border: "1px solid rgba(255,255,255,0.10)",
                borderRadius: 6,
                color: "#ffffff",
                fontSize: 12,
              }}
              labelFormatter={(v) => `t + ${clock(Number(v))}`}
              formatter={(value) => [`${Number(value).toFixed(1)} m`, "altitude"]}
            />

            {target_m > 0 && (
              <ReferenceLine
                y={target_m}
                stroke={INK_MUTED}
                strokeDasharray="4 4"
                label={{
                  value: `target ${target_m} m`,
                  position: "insideTopLeft",
                  fill: INK_MUTED,
                  fontSize: 11,
                }}
              />
            )}

            <Line
              type="linear"
              dataKey="alt_m"
              stroke={SERIES}
              strokeWidth={2}
              dot={{ r: 2, fill: SERIES, strokeWidth: 0 }}
              activeDot={{ r: 4 }}
              isAnimationActive={false}
              connectNulls={false}
            />

            {/* The only direct label on the plot. A value beside every dot would
                be unreadable; the axis and tooltip carry the rest. */}
            {apogee && (
              <ReferenceDot
                x={apogee.t_s}
                y={apogee.alt_m}
                r={5}
                fill={APOGEE}
                stroke={SURFACE}
                strokeWidth={2}
                label={{
                  value: `apogee ${apogee.alt_m.toFixed(0)} m`,
                  position: "top",
                  fill: APOGEE,
                  fontSize: 12,
                  fontWeight: 600,
                }}
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
