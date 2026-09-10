#!/usr/bin/env python3
"""CanSat flight simulator - stands in for the payload and its radio.

Generates one telemetry packet per second and either prints it, sends it over
UDP, or both. What goes on the wire is only what a real payload would transmit:
pressure, chamber temperature, a GPS fix once locked, and a packet counter.
Altitude is deliberately absent - the ground station derives it from pressure.

The terminal output also shows the simulator's own ground truth (altitude,
vertical speed, phase) to the right of a "|". That is NOT transmitted. It is
there so you can watch the flight happen and check the ground station against
something authoritative.

    python sim.py --preset 400
    python sim.py --preset 2200 --loss 0.1 --noise 2 --udp 127.0.0.1:9000
    python sim.py --preset 2000 --speed 0 --seed 1        # instant, repeatable
"""

import argparse
import json
import math
import random
import socket
import sys
import time
from dataclasses import dataclass

# --- International Standard Atmosphere ------------------------------------
# The simulator turns altitude into pressure with these; the ground station
# does the inverse. Keeping the constants in both places is deliberate - the
# ground has no access to this file, exactly as it would have no access to a
# real payload's firmware.
G = 9.80665            # m/s^2
R = 8.31447            # J/(mol K), universal gas constant
M_AIR = 0.0289644      # kg/mol, molar mass of dry air
LAPSE = 0.0065         # K/m, ISA troposphere temperature lapse rate
PRESSURE_EXP = G * M_AIR / (R * LAPSE)   # ~5.2559

# Flat-earth conversion. Good to well under a metre over the few kilometres a
# CanSat drifts, and it keeps the simulator dependency-free.
M_PER_DEG_LAT = 111320.0

# Sensor noise at --noise 1. These are not datasheet RMS figures: a barometer
# bolted inside a moving airframe sees aerodynamic pressure fluctuation far
# larger than its own electrical noise, and that is what actually makes apogee
# detection hard. 25 Pa is roughly 2 m of altitude near sea level.
SIGMA_PRESSURE_PA = 25.0
SIGMA_TEMP_C = 0.15
SIGMA_GPS_M = 2.5


@dataclass(frozen=True)
class Preset:
    """One flight profile.

    `drag_k` is the whole aerodynamic model: a single ballistic term such that
    deceleration from drag is k * v^2 at sea-level density. Smaller means a
    slicker, heavier vehicle that coasts further, which is why the 2 km
    profiles carry a much smaller k than the 400 m one.

    `boost_a` is not stored - it is solved at startup so the flight actually
    peaks at `target_apogee_m` instead of wherever the parameters happened to
    land. That is what makes "400 m" mean 400 m.
    """

    name: str
    target_apogee_m: float
    burn_s: float
    drag_k: float
    descent_mps: float


PRESETS = {
    "400": Preset("400", 400.0, 1.2, 1.00e-3, 5.5),
    "2000": Preset("2000", 2000.0, 2.5, 3.00e-4, 6.5),
    "2200": Preset("2200", 2200.0, 2.8, 2.70e-4, 6.5),
}


def isa_pressure(h_m: float, pad_pa: float, pad_temp_k: float) -> float:
    """Pressure at `h_m` above the pad, given conditions measured at the pad."""
    return pad_pa * (1.0 - LAPSE * h_m / pad_temp_k) ** PRESSURE_EXP


def density_ratio(h_m: float, pad_temp_k: float) -> float:
    """Air density at `h_m` as a fraction of pad density.

    Drag falls off with it, which is most of the reason a 2 km flight is
    possible at all: by apogee the vehicle is pushing through noticeably
    thinner air than it was at burnout.
    """
    return (1.0 - LAPSE * h_m / pad_temp_k) ** (PRESSURE_EXP - 1.0)


def ambient_temp_c(h_m: float, pad_temp_c: float) -> float:
    return pad_temp_c - LAPSE * h_m


@dataclass
class Sample:
    t_s: float
    alt_m: float
    vert_mps: float
    phase: str


def ascent(preset: Preset, boost_a: float, pad_temp_k: float, dt: float) -> list[Sample]:
    """Integrate boost then coast, stopping at apogee.

    Boost is constant acceleration for `burn_s`; after that the only forces are
    gravity and drag. Euler integration at 10 ms is far finer than the 1 Hz the
    radio samples at, so integration error never reaches the wire.
    """
    t = h = v = 0.0
    out = [Sample(0.0, 0.0, 0.0, "BOOST")]
    while t < 300.0:
        thrust = boost_a if t < preset.burn_s else 0.0
        drag = -preset.drag_k * density_ratio(h, pad_temp_k) * v * abs(v)
        v += (thrust - G + drag) * dt
        h += v * dt
        t += dt
        if v <= 0.0 and t > preset.burn_s:
            break
        out.append(Sample(t, h, v, "BOOST" if t < preset.burn_s else "COAST"))
    out.append(Sample(t, h, 0.0, "COAST"))
    return out


def solve_boost(preset: Preset, pad_temp_k: float, dt: float) -> float:
    """Bisect on boost acceleration until the flight peaks at the target.

    Monotonic - more acceleration always means a higher apogee - so bisection
    is guaranteed to converge and there is no need for anything cleverer.
    """
    lo, hi = G, 3000.0
    for _ in range(50):
        mid = 0.5 * (lo + hi)
        if ascent(preset, mid, pad_temp_k, dt)[-1].alt_m < preset.target_apogee_m:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def build_flight(
    preset: Preset,
    boost_a: float,
    pad_temp_k: float,
    pad_hold_s: float,
    post_land_s: float,
    dt: float,
) -> list[Sample]:
    """Full timeline: pad hold, ascent, descent, then sitting on the ground.

    The pad hold matters more than it looks. It is the only chance the ground
    station gets to measure pad pressure before launch, and every altitude it
    ever reports is relative to that measurement.

    Descent is a steady rate, which is kinematics only - no deployment event
    and no onboard hardware is modelled anywhere in this file.
    """
    flight = [Sample(t * dt, 0.0, 0.0, "PAD") for t in range(int(pad_hold_s / dt))]

    for s in ascent(preset, boost_a, pad_temp_k, dt):
        flight.append(Sample(pad_hold_s + s.t_s, s.alt_m, s.vert_mps, s.phase))

    apogee = flight[-1]
    h, t = apogee.alt_m, apogee.t_s
    while h > 0.0:
        h -= preset.descent_mps * dt
        t += dt
        flight.append(Sample(t, max(h, 0.0), -preset.descent_mps, "DESCENT"))

    t_land = flight[-1].t_s
    while flight[-1].t_s < t_land + post_land_s:
        flight.append(Sample(flight[-1].t_s + dt, 0.0, 0.0, "LANDED"))

    return flight


def main() -> None:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--preset", choices=sorted(PRESETS), default="400")
    p.add_argument("--rate", type=float, default=1.0, help="packets per second (default 1)")
    p.add_argument("--loss", type=float, default=0.0, help="packet loss probability 0-1")
    p.add_argument("--noise", type=float, default=1.0, help="sensor noise multiplier")
    p.add_argument("--seed", type=int, default=None, help="RNG seed, for repeatable runs")
    p.add_argument("--udp", default=None, metavar="HOST:PORT", help="also send over UDP")
    p.add_argument("--quiet", action="store_true", help="suppress the per-packet lines")
    p.add_argument(
        "--speed", type=float, default=1.0,
        help="wall-clock pacing multiplier; 0 runs as fast as possible (default 1)",
    )
    # Pad conditions. The default pad is NOT at sea level, on purpose: assuming
    # 101325 Pa here would put every derived altitude out by about 150 m, which
    # is precisely the mistake the pad-pressure calibration exists to prevent.
    p.add_argument("--pad-pressure", type=float, default=99500.0, help="Pa at the pad")
    p.add_argument(
        "--pad-temp", type=float, default=15.0,
        help="degC at the pad (default 15 = ISA standard, so the pressure/altitude "
             "round trip is exact; raise it to introduce the error a real "
             "barometric solution carries)",
    )
    p.add_argument("--pad-lat", type=float, default=51.200000)
    p.add_argument("--pad-lon", type=float, default=-1.800000)
    p.add_argument("--wind", type=float, default=6.0, help="m/s")
    p.add_argument("--wind-from", type=float, default=250.0, help="compass deg the wind blows FROM")
    p.add_argument("--pad-hold", type=float, default=8.0, help="s on the pad before launch")
    p.add_argument("--post-land", type=float, default=15.0, help="s of transmission after landing")
    p.add_argument("--gps-lock-after", type=int, default=3, help="packets before the first fix")
    args = p.parse_args()

    rng = random.Random(args.seed)
    preset = PRESETS[args.preset]
    pad_temp_k = args.pad_temp + 273.15
    dt = 0.01

    boost_a = solve_boost(preset, pad_temp_k, dt)
    flight = build_flight(
        preset, boost_a, pad_temp_k, args.pad_hold, args.post_land, dt
    )
    apogee = max(flight, key=lambda s: s.alt_m)
    t_land = next(s.t_s for s in flight if s.phase == "LANDED")
    burnout = max(s.vert_mps for s in flight)

    # Wind pushes TOWARD (wind_from + 180). Compass convention: north = cos,
    # east = sin. The payload is assumed to couple to the wind immediately -
    # first-order, and the reason the landing point is an estimate.
    push = math.radians(args.wind_from + 180.0)
    wind_n = args.wind * math.cos(push)
    wind_e = args.wind * math.sin(push)
    m_per_deg_lon = M_PER_DEG_LAT * math.cos(math.radians(args.pad_lat))

    sock = None
    if args.udp:
        host, _, port = args.udp.partition(":")
        dest = (host, int(port))
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    print(f"CanSat flight simulator - preset {preset.name} (target apogee {preset.target_apogee_m:.0f} m)")
    print(f"  boost      {preset.burn_s:.2f} s at {boost_a:.1f} m/s^2 (solved), burnout {burnout:.0f} m/s")
    print(f"  truth      apogee {apogee.alt_m:.1f} m at t={apogee.t_s:.1f} s, landing at t={t_land:.1f} s")
    print(f"  pad        {args.pad_pressure:.1f} Pa, {args.pad_temp:.1f} C, {args.pad_lat:.6f}, {args.pad_lon:.6f}")
    print(f"  wind       {args.wind:.1f} m/s from {args.wind_from:.0f} deg")
    dest_s = f"udp {args.udp}" if sock else "stdout only"
    print(f"  downlink   {args.rate:g} Hz, loss {args.loss * 100:.0f}%, noise x{args.noise:g}  ->  {dest_s}")
    print(f"  launch at  t={args.pad_hold:.1f} s")
    print()
    if not args.quiet:
        print("   id      t        pressure       temp   gps                      | truth alt    vert  phase")

    # Chamber temperature: the payload's own enclosure, not the air outside it.
    # It starts warm because the electronics have been running, keeps gaining
    # heat from them, and leaks toward ambient slowly through insulation. It is
    # a health signal and must never be fed into the altitude derivation.
    chamber_c = args.pad_temp + 3.0
    chamber_gain = 0.02      # degC/s of self-heating
    chamber_tau = 90.0       # s, thermal coupling to outside air

    period = 1.0 / args.rate
    n_packets = int(flight[-1].t_s / period) + 1
    started = time.monotonic()
    sent = dropped = 0

    try:
        for n in range(n_packets):
            t = n * period
            s = flight[min(int(round(t / dt)), len(flight) - 1)]

            # Advance the chamber model over the interval just elapsed.
            steps = max(int(period / 0.1), 1)
            for _ in range(steps):
                outside = ambient_temp_c(s.alt_m, args.pad_temp)
                chamber_c += (period / steps) * (
                    chamber_gain - (chamber_c - outside) / chamber_tau
                )

            true_p = isa_pressure(s.alt_m, args.pad_pressure, pad_temp_k)
            packet = {
                "schema": 1,
                "packet_id": n,
                "pressure_pa": round(true_p + rng.gauss(0, SIGMA_PRESSURE_PA * args.noise), 1),
                "temp_c": round(chamber_c + rng.gauss(0, SIGMA_TEMP_C * args.noise), 2),
            }

            gps_text = "(no fix)"
            if n >= args.gps_lock_after:
                drift_t = min(max(t - args.pad_hold, 0.0), t_land - args.pad_hold)
                north_m = wind_n * drift_t + rng.gauss(0, SIGMA_GPS_M * args.noise)
                east_m = wind_e * drift_t + rng.gauss(0, SIGMA_GPS_M * args.noise)
                packet["lat_deg"] = round(args.pad_lat + north_m / M_PER_DEG_LAT, 7)
                packet["lon_deg"] = round(args.pad_lon + east_m / m_per_deg_lon, 7)
                gps_text = f"{packet['lat_deg']:.6f},{packet['lon_deg']:.6f}"

            # The counter advances whether or not the packet makes it out. That
            # is the whole basis of loss detection on the ground: a gap in the
            # sequence is the only evidence a packet ever existed.
            lost = rng.random() < args.loss
            if lost:
                dropped += 1
                if not args.quiet:
                    print(f"  {n:4d}  {t:6.1f}s   -- dropped --")
            else:
                sent += 1
                if sock:
                    sock.sendto(json.dumps(packet).encode(), dest)
                if not args.quiet:
                    print(
                        f"  {n:4d}  {t:6.1f}s  {packet['pressure_pa']:10.1f} Pa"
                        f"  {packet['temp_c']:6.2f} C  {gps_text:<24}"
                        f" | {s.alt_m:8.1f} m  {s.vert_mps:+7.1f}  {s.phase}"
                    )

            if args.speed > 0:
                target = started + (t + period) / args.speed
                slack = target - time.monotonic()
                if slack > 0:
                    time.sleep(slack)
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)

    total = sent + dropped
    last = flight[-1]
    land_n = wind_n * (t_land - args.pad_hold)
    land_e = wind_e * (t_land - args.pad_hold)
    print()
    print(f"  packets    {total} generated, {sent} transmitted, {dropped} dropped "
          f"({dropped / total * 100 if total else 0:.1f}%)")
    print(f"  apogee     {apogee.alt_m:.1f} m at t={apogee.t_s:.1f} s "
          f"(target {preset.target_apogee_m:.0f} m)")
    print(f"  landed     {math.hypot(land_n, land_e):.0f} m from the pad, "
          f"bearing {math.degrees(math.atan2(land_e, land_n)) % 360:.0f} deg")
    print(f"  duration   {last.t_s:.1f} s")


if __name__ == "__main__":
    main()
