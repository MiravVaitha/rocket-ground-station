/**
 * Scores `detectApogee` against recorded flights with known ground truth.
 *
 *     npm run check:apogee
 *
 * Runs under plain Node - no test framework, no build step, no backend and no
 * simulator. The fixtures in `frontend/fixtures/` were produced by
 * `backend/sim.py --fixture` and carry the simulator's own apogee alongside
 * the packets the ground station would have received, so a derivation can be
 * scored against what actually happened.
 *
 * The naive detector is run on the same data for comparison. Seeing it declare
 * apogee on the launch pad is the point of the exercise.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type AltitudeSample,
  type Apogee,
  DEFAULT_APOGEE_CONFIG,
  detectApogee,
} from "../app/lib/apogee.ts";
import { T0_ISA_K, altitudeFromPressure } from "../app/lib/barometric.ts";
import {
  PACKET_RATE_HZ,
  type Packet,
  packetTime,
  padReference,
} from "../app/lib/telemetry.ts";

// Achievable at 1 Hz with median smoothing, backdating and a parabola fit is
// about 3 m and 1 s across this fixture set. The bar is set looser than that
// so a sound implementation without every refinement still passes.
const ALT_TOL_M = 10;
const T_TOL_S = 1.5;

const FIXTURES = [
  "400-clean",
  "400-typical",
  "400-harsh",
  "2200-clean",
  "2200-typical",
  "2000-harsh",
];

type Fixture = {
  preset: string;
  target_apogee_m: number;
  rate_hz: number;
  noise: number;
  loss: number;
  truth_apogee_m: number;
  truth_apogee_t_s: number;
  pad_pressure_pa: number;
  packets: Packet[];
};

const here = dirname(fileURLToPath(import.meta.url));

function load(name: string): Fixture {
  const fx: Fixture = JSON.parse(
    readFileSync(join(here, "..", "fixtures", `${name}.json`), "utf-8")
  );
  if (fx.rate_hz !== PACKET_RATE_HZ) {
    throw new Error(
      `${name} was recorded at ${fx.rate_hz} Hz but PACKET_RATE_HZ is ${PACKET_RATE_HZ}`
    );
  }
  return fx;
}

/** The same path the app takes: packets -> pad reference -> altitude series. */
function toSamples(fx: Fixture): AltitudeSample[] {
  const pad_pa = padReference(fx.packets);
  if (pad_pa === null) throw new Error("not enough packets for a pad reference");
  const pad = { pressure_pa: pad_pa, temp_k: T0_ISA_K };
  return fx.packets.map((p) => ({
    t_s: packetTime(p),
    alt_m: altitudeFromPressure(p.pressure_pa, pad),
  }));
}

/** The strawman: first sample lower than the one before it. */
function naive(samples: AltitudeSample[]): AltitudeSample | null {
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].alt_m < samples[i - 1].alt_m) return samples[i - 1];
  }
  return null;
}

/**
 * Feeds the detector growing prefixes, the way live mode does, and checks the
 * answer never changes once declared. Catches a detector that re-triggers on
 * descent noise, or one that is not a pure function of its input.
 */
function latchCheck(
  samples: AltitudeSample[]
): { ok: true } | { ok: false; at_s: number; was: Apogee; became: Apogee } {
  let first: Apogee | null = null;
  for (let i = 1; i <= samples.length; i++) {
    const r = detectApogee(samples.slice(0, i), DEFAULT_APOGEE_CONFIG);
    if (r === null) continue;
    if (first === null) {
      first = r;
    } else if (
      Math.abs(r.alt_m - first.alt_m) > 1e-6 ||
      Math.abs(r.t_s - first.t_s) > 1e-6
    ) {
      return { ok: false, at_s: samples[i - 1].t_s, was: first, became: r };
    }
  }
  return { ok: true };
}

const pad = (s: string | number, n: number) => String(s).padStart(n);
const padE = (s: string | number, n: number) => String(s).padEnd(n);

console.log("\napogee detector check\n");
console.log(
  padE("fixture", 16) +
    pad("noise", 6) +
    pad("loss", 6) +
    pad("truth", 20) +
    pad("detected", 20) +
    pad("alt err", 10) +
    pad("t err", 9) +
    pad("lag", 8) +
    "  result"
);

let passed = 0;
const naiveRows: string[] = [];
const latchRows: string[] = [];

for (const name of FIXTURES) {
  const fx = load(name);
  const samples = toSamples(fx);
  const truth = `${fx.truth_apogee_m.toFixed(1)} m @${fx.truth_apogee_t_s.toFixed(1)}s`;

  const got = detectApogee(samples, DEFAULT_APOGEE_CONFIG);

  if (got === null) {
    console.log(
      padE(name, 16) +
        pad(fx.noise, 6) +
        pad(`${(fx.loss * 100).toFixed(0)}%`, 6) +
        pad(truth, 20) +
        pad("not detected", 20) +
        pad("", 10) +
        pad("", 9) +
        pad("", 8) +
        "  FAIL"
    );
  } else {
    const dAlt = got.alt_m - fx.truth_apogee_m;
    const dT = got.t_s - fx.truth_apogee_t_s;
    const ok = Math.abs(dAlt) <= ALT_TOL_M && Math.abs(dT) <= T_TOL_S;
    if (ok) passed++;
    console.log(
      padE(name, 16) +
        pad(fx.noise, 6) +
        pad(`${(fx.loss * 100).toFixed(0)}%`, 6) +
        pad(truth, 20) +
        pad(`${got.alt_m.toFixed(1)} m @${got.t_s.toFixed(1)}s`, 20) +
        pad(`${dAlt >= 0 ? "+" : ""}${dAlt.toFixed(1)} m`, 10) +
        pad(`${dT >= 0 ? "+" : ""}${dT.toFixed(1)} s`, 9) +
        pad(`${(got.detectedAt_s - got.t_s).toFixed(1)} s`, 8) +
        (ok ? "  PASS" : "  FAIL")
    );

    const latch = latchCheck(samples);
    latchRows.push(
      latch.ok
        ? `  ${padE(name, 16)}stable`
        : `  ${padE(name, 16)}CHANGED at t=${latch.at_s.toFixed(1)}s: ` +
          `${latch.was.alt_m.toFixed(1)} m -> ${latch.became.alt_m.toFixed(1)} m`
    );
  }

  const nv = naive(samples);
  naiveRows.push(
    nv === null
      ? `  ${padE(name, 16)}never fires`
      : `  ${padE(name, 16)}fires t=${pad(nv.t_s.toFixed(1), 5)}s  ->  ` +
        `${pad(nv.alt_m.toFixed(1), 7)} m   ` +
        (Math.abs(nv.alt_m - fx.truth_apogee_m) <= ALT_TOL_M
          ? "(right, but only because this fixture has no noise)"
          : `${(nv.alt_m - fx.truth_apogee_m).toFixed(0)} m out` +
            (nv.t_s < 10 ? "  <- ON THE PAD, BEFORE LAUNCH" : ""))
  );
}

console.log(`\ntolerance: |alt| <= ${ALT_TOL_M} m, |t| <= ${T_TOL_S} s`);

if (latchRows.length) {
  console.log("\nlatching - apogee must not change once declared:");
  latchRows.forEach((r) => console.log(r));
}

console.log("\nthe naive detector on the same data, for comparison:");
naiveRows.forEach((r) => console.log(r));

console.log(`\nRESULT  ${passed}/${FIXTURES.length} fixtures pass\n`);
if (passed < FIXTURES.length) process.exitCode = 1;
