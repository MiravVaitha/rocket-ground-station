/**
 * Pressure to altitude.
 *
 * The payload never transmits altitude. It transmits pressure, and this is
 * where the ground station turns that into a height above the pad. Every
 * altitude in the app, the apogee detection, and the peak-vs-target readout
 * all sit on top of this one function.
 *
 * ---------------------------------------------------------------------------
 * WHAT YOU ARE BUILDING
 *
 * `altitudeFromPressure(p, pad)` returns metres above the pad. It must return
 * 0 when `p` equals `pad.pressure_pa`, a positive number when `p` is lower,
 * and a negative number when `p` is higher (weather moves, and the payload can
 * read slightly below its own launch height).
 *
 * ---------------------------------------------------------------------------
 * THE FACTS IT IS BUILT FROM
 *
 * 1. Pressure at any height is the weight of the air stacked above you. Climb,
 *    and there is less air left above, so pressure falls.
 *
 * 2. The fall is not linear. Air is compressible, so the air low down is dense
 *    and the air high up is thin - each metre you climb removes less mass than
 *    the metre below it did. Two facts pin the shape down:
 *      - hydrostatic balance: dP/dh = -rho * G
 *      - the ideal gas law:   rho = P * M_AIR / (R * T)
 *    Substituting one into the other gives dP/P in terms of dh and T.
 *
 * 3. T is not constant, which is what stops that integrating to a simple
 *    exponential. The ISA troposphere model says air temperature falls
 *    linearly with height: T(h) = T0 - LAPSE * h. Substituting THAT and
 *    integrating gives a power law between the pressure ratio and height.
 *
 * 4. You need the inverse of that power law: you are handed the pressure ratio
 *    and want h. The exponent is assembled from G, M_AIR, R and LAPSE - work
 *    out which way up it goes when you invert.
 *
 * 5. The reference is the PAD, not sea level. `pad.pressure_pa` is measured
 *    from real packets before launch (see `padReference` in telemetry.ts).
 *    Using 101325 Pa instead would report the pad's own height above sea level
 *    as altitude, for the entire flight, on every reading. Referencing the pad
 *    cancels it, and gives height above the pad - which is the number anyone
 *    actually wants.
 *
 * 6. `pad.temp_k` is the air temperature at the pad, and it belongs to the
 *    model, not to the payload. Do NOT reach for `packet.temp_c`: that is the
 *    CHAMBER temperature, measured inside a sealed enclosure that is being
 *    warmed by its own electronics. It reads several degrees above the outside
 *    air and lags it badly. Feeding it in here would bias every altitude in
 *    the flight. Default to the ISA standard below unless you have a real
 *    measurement of outside air at the pad.
 *
 * ---------------------------------------------------------------------------
 * WHERE THIS MODEL BREAKS - state these wherever the numbers are presented
 *
 *   - LAPSE is a standard-day assumption. A real day differs, and the error
 *     grows with height.
 *   - Above the troposphere the lapse rate changes sign entirely, so this is
 *     wrong above ~11 km. Nothing here goes near that.
 *   - Weather moves the pad pressure during a long flight, and this treats it
 *     as fixed.
 *
 * The simulator lets you see the first one directly: it defaults to a pad at
 * ISA standard temperature so the round trip is exact, and `--pad-temp 27`
 * introduces a warm day, which this function will read about 88 m low at
 * 2200 m if you leave `pad.temp_k` at the standard value.
 */

/** Standard gravity, m/s^2. */
export const G = 9.80665;
/** Universal gas constant, J/(mol K). */
export const R = 8.31447;
/** Molar mass of dry air, kg/mol. */
export const M_AIR = 0.0289644;
/** ISA troposphere temperature lapse rate, K/m. */
export const LAPSE = 0.0065;
/** ISA standard sea-level temperature, K (15 degC). */
export const T0_ISA_K = 288.15;

export type PadReference = {
  /** Pressure measured at the pad before launch, Pa. */
  pressure_pa: number;
  /** Assumed air temperature at the pad, K. Not the chamber temperature. */
  temp_k: number;
};

/**
 * Metres above the pad, from a pressure reading and the pad reference.
 *
 * Verified against exact ISA pressures at 0, 100, 400, 1000, 2000, 2200 and
 * 3000 m: error is zero to floating-point precision at every point.
 */
export function altitudeFromPressure(
  pressure_pa: number,
  pad: PadReference
): number {

  const exponent = (G * M_AIR) / (R * LAPSE);
  const ratio = pressure_pa / pad.pressure_pa;
  const bracket = Math.pow(ratio, 1 / exponent);
  const altitude = (1 - bracket) * (pad.temp_k / LAPSE);

  return altitude;

}
