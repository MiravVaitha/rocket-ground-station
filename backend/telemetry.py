"""Decode and validate one telemetry packet off the radio link.

The backend never interprets telemetry. It does not derive altitude, detect
apogee or compute loss rate - all of that happens in the browser, because
replay mode has to work with this process stopped. This module exists only to
reject bytes that are not a well-formed packet, so a corrupt frame from the
link cannot reach the UI as a missing field or a NaN.
"""

import json
import math

SCHEMA = 1
REQUIRED = ("packet_id", "pressure_pa", "temp_c")
OPTIONAL = ("lat_deg", "lon_deg")


def _is_number(value: object) -> bool:
    """True for a real, finite number.

    Two Python details worth knowing here. `bool` is a subclass of `int`, so
    `isinstance(True, int)` is True and a JSON `true` would sail through an
    unguarded type check. And `json.loads` accepts the non-standard literals
    `NaN`, `Infinity` and `-Infinity` by default, either of which would poison
    every chart it reached.
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    return math.isfinite(value)


def decode(data: bytes) -> dict | None:
    """Return a validated packet, or None if the datagram is not one.

    Returns None rather than raising: a radio link delivers corrupt frames as a
    matter of course, and one of them must not be able to stop the receive loop.

    The returned dict is rebuilt field by field rather than passed through, so
    an oversized or attacker-shaped datagram cannot smuggle extra keys into the
    recorded log.
    """
    try:
        packet = json.loads(data)
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    if not isinstance(packet, dict) or packet.get("schema") != SCHEMA:
        return None

    out: dict = {"schema": SCHEMA}
    for field in REQUIRED:
        if not _is_number(packet.get(field)):
            return None
        out[field] = packet[field]
    # GPS is absent until the receiver gets a fix, and may disappear again.
    # Absent is a normal state, not an error.
    for field in OPTIONAL:
        if _is_number(packet.get(field)):
            out[field] = packet[field]
    return out
