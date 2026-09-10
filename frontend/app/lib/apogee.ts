/**
 * Apogee detection from the altitude curve.
 *
 * This file has no imports on purpose: it is pure numbers in, numbers out, so
 * `npm run check:apogee` can run it directly under Node against recorded
 * flights without starting Next, a backend or a simulator.
 *
 * ---------------------------------------------------------------------------
 * WHY THE OBVIOUS APPROACH FAILS
 *
 * The naive detector is "apogee is the first sample lower than the one before
 * it". Run it on real data and it fires on the launch pad, before the vehicle
 * has moved, reporting an apogee of roughly zero.
 *
 * The reason: while the payload sits on the pad the true altitude change per
 * sample is zero, so the sign of the difference between consecutive samples is
 * decided entirely by sensor noise - a coin flip every second. It takes about
 * two packets to come up tails. `npm run check:apogee` prints exactly this
 * happening on four of the six fixtures.
 *
 * It fails a second way even after launch. Near the peak the vehicle is barely
 * moving, so the true change between samples shrinks towards zero there too,
 * and noise can outvote it.
 *
 * ---------------------------------------------------------------------------
 * WHAT A WORKING DETECTOR NEEDS
 *
 * 1. ARM IT. Do not look for apogee until the payload has actually climbed -
 *    `cfg.armAbove_m` above the pad. This alone kills the pad false-positive,
 *    which is the biggest failure by far.
 *
 * 2. SMOOTH BEFORE DECIDING. One noisy sample must not be able to make the
 *    call. `movingMedian` below is provided - a median rather than an average
 *    because a median discards an outlier completely instead of averaging it
 *    in. But smoothing is expensive here: at 1 Hz there are only about ten
 *    samples between launch and apogee on the 400 m preset, so a wide window
 *    eats a large fraction of the whole ascent. 3 is about the budget.
 *
 * 3. REQUIRE A RUN. Do not declare on one descending sample - require
 *    `cfg.confirmRun` of them in a row. Large is robust but late, small is
 *    fast but fires on noise. At 1 Hz every extra sample you wait for is a
 *    whole second and tens of metres.
 *
 * 4. BACKDATE. You necessarily notice apogee several samples AFTER it
 *    happened. Report the peak of the data, not the sample where your run
 *    completed, or the apogee is always low and always late. Done properly,
 *    this decouples accuracy from detection lag entirely: `confirmRun` then
 *    changes only WHEN you know, not WHAT you report.
 *
 * 5. LATCH IT. Once declared, never withdraw it. Descent noise will otherwise
 *    re-trigger the whole thing repeatedly.
 *
 * ---------------------------------------------------------------------------
 * TWO REFINEMENTS THAT ARE WORTH REAL METRES
 *
 * 6. DECIDE ON SMOOTHED, REPORT FROM RAW. Smoothing biases the peak downward -
 *    a median across the peak and its two lower neighbours is below the peak by
 *    construction. So use the smoothed series to decide WHEN apogee happened,
 *    then go back to the RAW samples to find WHAT the peak was. On the six
 *    fixtures this is the difference between about 8 m of error and about 3 m.
 *
 * 7. YOU PROBABLY NEVER SAMPLED THE TRUE PEAK. At 1 Hz the closest packet can
 *    sit metres below it, so `max()` systematically under-reads. Near the top
 *    the trajectory is a parabola, so fitting a quadratic through the peak
 *    sample and its two neighbours and taking the vertex recovers both a
 *    better altitude and a fractional-second time. Guard it: only when the
 *    three points are equally spaced in time (a dropped packet breaks that),
 *    only when the curvature is negative, and only when the vertex lands
 *    between the outer two points.
 *
 * ---------------------------------------------------------------------------
 * A TRAP WORTH DECIDING ABOUT DELIBERATELY
 *
 * "Consecutive samples" means consecutive RECEIVED packets, which at 1 Hz with
 * 30% loss may span a four-second gap. Whether a gap should reset the run is a
 * judgement call - decide it on purpose rather than by accident.
 */

export type AltitudeSample = {
  /** Mission time, seconds. */
  t_s: number;
  /** Metres above the pad. */
  alt_m: number;
};

export type ApogeeConfig = {
  /** Samples in the smoothing window. Odd numbers only. 1 disables it. */
  smoothWindow: number;
  /** Consecutive descending smoothed samples required to declare apogee. */
  confirmRun: number;
  /** Must climb this far above the pad before detection arms. */
  armAbove_m: number;
};

/** A starting point, not a solved answer. `npm run check:apogee` will tell you. */
export const DEFAULT_APOGEE_CONFIG: ApogeeConfig = {
  smoothWindow: 3,
  confirmRun: 3,
  armAbove_m: 20,
};

export type Apogee = {
  /** Peak altitude above the pad, metres. */
  alt_m: number;
  /** Mission time of the peak, seconds - backdated, not when it was noticed. */
  t_s: number;
  /** Mission time the detector actually declared it. The difference is the lag. */
  detectedAt_s: number;
};

/**
 * Median filter over a sliding window, clamped at both ends.
 *
 * Provided so you can spend your effort on the detection logic rather than on
 * an off-by-one in a windowing loop. A window of 1 returns the input unchanged.
 */
export function movingMedian(
  samples: AltitudeSample[],
  window: number
): AltitudeSample[] {
  if (window <= 1) return samples;
  const half = Math.floor(window / 2);
  return samples.map((s, i) => {
    const slice = samples
      .slice(Math.max(0, i - half), Math.min(samples.length, i + half + 1))
      .map((x) => x.alt_m)
      .sort((a, b) => a - b);
    const mid = slice.length >> 1;
    return {
      t_s: s.t_s,
      alt_m:
        slice.length % 2 ? slice[mid] : (slice[mid - 1] + slice[mid]) / 2,
    };
  });
}

/**
 * Find apogee in an altitude series, or null if it has not happened yet.
 *
 * Called on every render with the whole flight so far, so it must be pure and
 * must give the same answer for the same input every time.
 *
 * TODO(you): implement. Suggested shape:
 *
 *   1. Smooth the series with `movingMedian` and `cfg.smoothWindow`.
 *   2. Walk it. Stay disarmed until a smoothed sample exceeds `cfg.armAbove_m`.
 *   3. Once armed, count consecutive descending smoothed samples; reset the
 *      count on any ascending one.
 *   4. When the count reaches `cfg.confirmRun`, apogee has happened. Find the
 *      highest RAW sample at or before that point - that is your peak.
 *   5. Optionally refine it with a parabola through that sample and its two
 *      neighbours, subject to the guards in note 7 above.
 *   6. Return the peak, its time, and the time you declared it. Returning on
 *      the first detection is what latches it.
 */
export function detectApogee(
  samples: AltitudeSample[],
  cfg: ApogeeConfig = DEFAULT_APOGEE_CONFIG
): Apogee | null {
 
  if (samples.length === 0) return null;
  const smoothed = movingMedian(samples, cfg.smoothWindow);

  // A running state machine, so it has to be a loop: each step depends on the
  // step before it, and `map` cannot see its own previous output.
  let armed = smoothed[0].alt_m > cfg.armAbove_m;
  let run = 0;

  for (let i = 1; i < smoothed.length; i++) {
    const s = smoothed[i];

    // Sticky. Once it has climbed it stays armed - re-testing the threshold
    // every sample would disarm on the way back down through it.
    armed = armed || s.alt_m > cfg.armAbove_m;
    if (!armed) continue;

    run = s.alt_m < smoothed[i - 1].alt_m ? run + 1 : 0;
    if (run < cfg.confirmRun) continue;

    // Apogee has happened, some samples ago. Backdate to the highest RAW
    // sample at or before here: smoothing pulls the peak down, so the smoothed
    // series is the right thing to decide WITH and the wrong thing to report.
    let peak = 0;
    for (let j = 1; j <= i; j++) {
      if (samples[j].alt_m > samples[peak].alt_m) peak = j;
    }

    // Returning on the first detection is what latches it.
    return { ...samples[peak], detectedAt_s: s.t_s };
  }

  return null;
}
