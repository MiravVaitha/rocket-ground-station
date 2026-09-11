"""Ground station receiver: telemetry packets in over UDP, out over WebSocket.

Receive-only. There is no endpoint that sends anything to the payload, no CORS
middleware (nothing fetches this server, and browsers do not CORS-check
WebSockets) and no command handshake competing for the socket. The entire job
is receive, fan out, and record.

Two things make this different from a conventional telemetry bridge, and both
come from the same fact: at 1 Hz there are only about ten packets between
launch and apogee.

1. Every packet is broadcast, never sampled. A polled snapshot would either
   send the same packet several times or skip one outright, and a skipped
   packet changes the pressure curve the ground station reads apogee from.

2. The whole flight is kept and replayed to any browser that connects late.
   Altitude is derived against pad pressure measured before launch, so a
   browser that missed the pad packets could not compute altitude at all.

3. Every flight is written to disk as it arrives, one file per flight, in
   exactly the form it was broadcast. The frontend replays those files with
   this process stopped.

    uvicorn app:app
"""

import asyncio
import json
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

import telemetry

UDP_HOST = "127.0.0.1"
UDP_PORT = 9000

# One JSONL file per flight: one packet per line, as broadcast. Gitignored - a
# flight worth shipping for replay is copied into frontend/public/flights.
RECORDINGS = Path(__file__).parent / "recordings"

# One flight is a few hundred packets, so a queue this deep cannot fill at any
# plausible packet rate. It is bounded anyway: an unbounded queue behind a
# stalled browser is a slow memory leak that only shows up during a long flight.
QUEUE_MAX = 2000

# Every packet received for the current flight, oldest first. Replayed to each
# browser on connect. Cleared when the payload restarts.
history: list[dict] = []

# One queue per connected browser. A set, so a disconnect is a cheap discard.
subscribers: set[asyncio.Queue] = set()

# The file the current flight is being written to.
recording: Path | None = None

_stats = {"packets": 0, "bad": 0, "overflow": 0, "unrecorded": 0}


def new_recording() -> Path:
    """A fresh file for a new flight, named for when its first packet arrived.

    UTC so recordings sort in flight order whatever the local clock does, in the
    compact ISO form because colons are not legal in Windows filenames.
    """
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    path = RECORDINGS / f"flight-{stamp}.jsonl"
    n = 2
    while path.exists():  # two flights starting within the same second
        path = RECORDINGS / f"flight-{stamp}-{n}.jsonl"
        n += 1
    return path


def record(packet: dict) -> None:
    """Append one packet to the current flight's recording.

    Opened, appended and closed on every packet. At 1 Hz that costs nothing,
    and it hands each packet to the operating system the moment it arrives:
    stopping the backend mid-flight loses nothing, there is no open handle to
    manage across a flight reset or shutdown, and a directory listing shows the
    real size - Windows reports a stale size for a file held open.
    """
    try:
        with recording.open("a", encoding="utf-8") as f:
            f.write(json.dumps(packet) + "\n")
    except OSError as err:
        # A full disk must not take the live display down with it, but it must
        # not be quiet either: a packet that was not recorded cannot be replayed.
        _stats["unrecorded"] += 1
        print(f"[rec] WARNING packet {packet['packet_id']} not recorded: {err} "
              f"({_stats['unrecorded']} total)")


def publish(packet: dict) -> None:
    """Record a packet into the flight and hand it to every connected browser."""
    global history, recording

    # packet_id going backwards means the payload restarted, so this is a new
    # flight and the old history would corrupt the new one - not least because
    # the pad reference would be measured against the wrong pressure. The same
    # signal rolls the recording over, so every file holds exactly one flight.
    if history and packet["packet_id"] <= history[-1]["packet_id"]:
        print(f"[rx] packet_id reset - new flight (previous: {len(history)} packets)")
        history = []
        _stats["packets"] = 0

    if not history:
        recording = new_recording()
        print(f"[rec] recording to {recording.relative_to(RECORDINGS.parent)}")

    # Recorded before it is fanned out: the file is the durable copy.
    history.append(packet)
    record(packet)
    _stats["packets"] += 1
    n = _stats["packets"]
    if n == 1:
        print(f"[rx] telemetry flowing from udp://{UDP_HOST}:{UDP_PORT}")
    elif n % 25 == 0:
        print(f"[rx] {n} packets, {len(subscribers)} client(s)")

    for queue in subscribers:
        try:
            queue.put_nowait(packet)
        except asyncio.QueueFull:
            # Loudly, once per occurrence. Dropping telemetry silently is the
            # one thing this backend must never do.
            _stats["overflow"] += 1
            print(f"[rx] WARNING queue full, dropped packet {packet['packet_id']} "
                  f"for a stalled client ({_stats['overflow']} total)")


class Receiver(asyncio.DatagramProtocol):
    """Reads the downlink.

    A synchronous callback on the event loop: no thread is needed because
    nothing here blocks. `datagram_received` runs to completion before the loop
    does anything else, which is what makes the subscribe-and-snapshot in
    `stream` below safe without a lock.
    """

    def datagram_received(self, data: bytes, addr) -> None:
        packet = telemetry.decode(data)
        if packet is None:
            _stats["bad"] += 1
            if _stats["bad"] in (1, 10) or _stats["bad"] % 100 == 0:
                print(f"[rx] {_stats['bad']} malformed datagram(s) from {addr[0]}")
            return
        publish(packet)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Here rather than on the first packet: an unwritable directory should stop
    # the backend at startup, not raise inside the receive callback mid-flight.
    RECORDINGS.mkdir(exist_ok=True)
    loop = asyncio.get_running_loop()
    transport, _ = await loop.create_datagram_endpoint(
        Receiver, local_addr=(UDP_HOST, UDP_PORT)
    )
    print(f"[rx] listening on udp://{UDP_HOST}:{UDP_PORT}")
    yield
    transport.close()


app = FastAPI(lifespan=lifespan)


@app.websocket("/ws")
async def stream(ws: WebSocket) -> None:
    await ws.accept()
    queue: asyncio.Queue = asyncio.Queue(QUEUE_MAX)

    # Subscribing and snapshotting the history must happen with no `await`
    # between them. The event loop cannot interleave `datagram_received` inside
    # a synchronous run of statements, so every packet lands in exactly one of
    # the two paths: already in `backlog`, or still to arrive on `queue`. That
    # is why no de-duplication is needed on either side.
    subscribers.add(queue)
    backlog = list(history)

    print(f"[ws] client connected, replaying {len(backlog)} packet(s)")
    try:
        for packet in backlog:
            await ws.send_json(packet)
        while True:
            await ws.send_json(await queue.get())
    except WebSocketDisconnect:
        pass
    finally:
        subscribers.discard(queue)
        print(f"[ws] client disconnected, {len(subscribers)} remaining")
