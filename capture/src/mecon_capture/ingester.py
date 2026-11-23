"""The observation ingester (contracts/observation-subscription/v1): subscribe, capture, hand on.

It only receives. There is no publish path anywhere in this module or its transports. Every message
becomes a capture stamped at arrival and goes into a bounded in-memory buffer; a flusher thread appends
the buffer to the archive in batches. The network thread never writes to disk and never waits: a full
buffer counts the capture as shed (the ingester's own count, never the archive's) and moves on. A payload
over max_receive_bytes is measured on receipt and handed on as a stub: its size and content hash, no bytes.
"""

from __future__ import annotations

import base64
import collections
import datetime as dt
import itertools
import threading
from typing import Any, Callable

from .archive import Archive, content_hash
from .config import Config, Profile
from .logutil import Log
from .transport import CONNACK_TEXT, Transport, TransportError

Clock = Callable[[], dt.datetime]


def utc_now() -> dt.datetime:
    return dt.datetime.now(dt.timezone.utc)


def iso_ms(t: dt.datetime) -> str:
    """UTC, with milliseconds: YYYY-MM-DDTHH:MM:SS.mmmZ (truncated, not rounded)."""
    t = t.astimezone(dt.timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


class CaptureBuffer:
    """A bounded FIFO and the ingester's counters. put() never blocks and never does I/O: it is called from
    the network thread. One lock covers the queue and every counter, so received = handed_on + buffered +
    shed holds at every instant a reader can see."""

    def __init__(self, bound: int) -> None:
        self.bound = bound
        self._q: collections.deque[dict[str, Any]] = collections.deque()
        self._lock = threading.Lock()
        self._received = self._handed_on = self._shed = self._oversize = 0

    def put(self, capture: dict[str, Any], oversize: bool = False) -> bool:
        """Count the message on arrival; keep it, or count it shed when the buffer is full."""
        with self._lock:
            self._received += 1
            if oversize:
                self._oversize += 1
            if len(self._q) < self.bound:
                self._q.append(capture)
                return True
            self._shed += 1
            return False

    def peek(self, n: int) -> list[dict[str, Any]]:
        with self._lock:
            return list(itertools.islice(self._q, n))

    def hand_on(self, n: int) -> None:
        """The archive answered `available` for the first n captures: they leave the buffer and count as
        handed on, in one step."""
        with self._lock:
            for _ in range(n):
                self._q.popleft()
            self._handed_on += n

    def __len__(self) -> int:
        with self._lock:
            return len(self._q)

    def counters(self, now: dt.datetime) -> dict[str, Any]:
        """ingester.schema.json: the totals and levels, read in one step."""
        with self._lock:
            n = len(self._q)
            first = self._q[0]["received_at"] if n else None
            out = {"received": self._received, "handed_on": self._handed_on, "buffered": n, "bound": self.bound,
                   "shed": self._shed, "oversize": self._oversize, "oldest_buffered_ms": None}
        if first is not None:
            arrived = dt.datetime.strptime(first, "%Y-%m-%dT%H:%M:%S.%fZ").replace(tzinfo=dt.timezone.utc)
            out["oldest_buffered_ms"] = max(0, int((now - arrived).total_seconds() * 1000))
        return out


class SourceSession:
    """One profile: its transport, its status, and the callbacks the transport drives."""

    def __init__(self, profile: Profile, client_id: str, transport: Transport, buffer: CaptureBuffer,
                 clock: Clock, log: Log, max_receive_bytes: int = 65536) -> None:
        self.profile, self.client_id, self.transport = profile, client_id, transport
        self._buffer, self._clock, self._log = buffer, clock, log
        self._max_receive = max_receive_bytes
        self._lock = threading.Lock()
        self._state = "unknown"
        self._last_error: str | None = None
        self._last_connected_at: str | None = None
        self._subscribed: set[str] = set()
        self._refused: set[str] = set()
        self._suback_seen = False
        transport.callbacks = self

    # ---- lifecycle ----

    def start(self) -> None:
        self._set("connecting")
        try:
            self.transport.connect(self.profile, self.client_id)
        except TransportError as e:
            self._set("error", str(e))
            self._log.error("connect_not_started", source=self.profile.name, reason=str(e))

    def stop(self) -> None:
        self.transport.disconnect()
        self._set("disconnected")

    def _set(self, state: str, error: str | None = None) -> None:
        with self._lock:
            self._state = state
            self._last_error = (error or "unspecified error")[:500] if state == "error" else None
            self._subscribed, self._refused, self._suback_seen = set(), set(), False

    # ---- transport callbacks ----

    def on_connack(self, code: int) -> None:
        if code != 0:
            reason = CONNACK_TEXT.get(code, f"connection refused (code {code})")
            self._set("error", reason)
            self._log.warn("connack_refused", source=self.profile.name, code=code, reason=reason)
            return
        with self._lock:
            self._state, self._last_error = "connected", None
            self._last_connected_at = iso_ms(self._clock())
            self._subscribed, self._refused, self._suback_seen = set(), set(), False
        # On every successful connect, every topic, QoS 0. Nothing else is ever sent.
        for topic in self.profile.topics:
            try:
                self.transport.subscribe(topic, 0)
            except TransportError as e:
                self._log.error("subscribe_not_sent", source=self.profile.name, reason=str(e))
        self._log.info("connected", source=self.profile.name, topics=len(self.profile.topics))

    def on_suback(self, granted: list[str], refused: list[str]) -> None:
        with self._lock:
            self._subscribed.update(granted)
            self._refused.update(refused)
            self._suback_seen = True
        if refused:
            self._log.warn("topics_refused", source=self.profile.name, count=len(refused))

    def on_disconnect(self) -> None:
        with self._lock:
            if self._state == "error":
                return  # the library reports the close that follows a refusal; the reason stays visible
        self._set("disconnected")
        self._log.info("disconnected", source=self.profile.name)

    def on_connect_failed(self, reason: str) -> None:
        self._set("error", reason)
        self._log.warn("connect_failed", source=self.profile.name, reason=reason)

    def on_message(self, topic: str, payload: bytes, retain: bool) -> None:
        received_at = iso_ms(self._clock())  # stamped at arrival, here, before anything is queued
        capture: dict[str, Any] = {"source": self.profile.name, "topic": topic,
                                   "retained": bool(retain), "received_at": received_at}
        oversize = len(payload) > self._max_receive
        if oversize:
            # The receive bound: hash it and let the bytes go. Nothing of the payload is kept past here.
            try:
                digest = content_hash(topic, payload)
            except UnicodeEncodeError:  # a topic with no UTF-8 encoding: the archive rejects it as malformed
                digest = "0" * 64
            capture["stub"] = {"size": len(payload), "content_hash": digest}
        else:
            capture["payload_b64"] = base64.b64encode(payload).decode("ascii")
        self._buffer.put(capture, oversize)

    # ---- status (status.schema.json) ----

    def status(self) -> dict[str, Any]:
        with self._lock:
            s: dict[str, Any] = {"name": self.profile.name, "state": self._state, "last_error": self._last_error,
                                 "last_connected_at": self._last_connected_at}
            if self._suback_seen:
                order = self.profile.topics
                s["subscribed"] = [t for t in order if t in self._subscribed]
                s["refused"] = [t for t in order if t in self._refused]
            return s


class Ingester:
    def __init__(self, cfg: Config, archive: Archive, transport_factory: Callable[[Profile], Transport],
                 clock: Clock = utc_now, log: Log | None = None) -> None:
        self.cfg, self.archive = cfg, archive
        self.log = log or Log(level=cfg.log_level)
        self.buffer = CaptureBuffer(cfg.buffer_max)
        self.sessions = [
            SourceSession(p, f"{cfg.client_id_prefix}-{p.name}-{cfg.instance_tag}", transport_factory(p),
                          self.buffer, clock, self.log, cfg.max_receive_bytes)
            for p in cfg.profiles
        ]
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._seq = 0
        self._retry: tuple[str, int] | None = None  # (batch_id, size) of a batch the archive could not take

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name="flusher", daemon=True)
        self._thread.start()
        for s in self.sessions:
            s.start()

    def stop(self, flush_timeout_s: float = 10.0) -> None:
        """Stop receiving, then flush what is buffered. Whatever is still buffered after the timeout
        (the archive unavailable) is lost, as the contract allows for a stop that does not complete."""
        for s in self.sessions:
            s.stop()
        self._stop.set()
        if self._thread is not None:
            self._thread.join(flush_timeout_s + 5)
        deadline = threading.Event()
        timer = threading.Timer(flush_timeout_s, deadline.set)
        timer.start()
        try:
            while len(self.buffer) and not deadline.is_set():
                if not self.flush_once():
                    deadline.wait(0.2)
        finally:
            timer.cancel()
        left = len(self.buffer)
        if left:
            self.log.error("buffer_lost_at_stop", count=left)

    def statuses(self) -> list[dict[str, Any]]:
        return [s.status() for s in self.sessions]

    # ---- flushing ----

    def flush_once(self) -> bool:
        """Append up to batch_max buffered captures. True when the archive answered (even with rejections),
        or there was nothing to append. The captures leave the buffer, and count as handed on, only after an
        `available` answer."""
        batch = self.buffer.peek(self.cfg.batch_max)
        if not batch:
            return True
        if self._retry is not None and self._retry[1] == len(batch):
            batch_id = self._retry[0]  # the same batch, retried
        else:
            self._seq += 1
            batch_id = f"{self.cfg.instance_tag}-{self._seq}"
        result = self.archive.append(batch_id, batch)
        if result["storage"] != "available":
            self._retry = (batch_id, len(batch))
            self.log.warn("archive_unavailable", batch=batch_id, count=len(batch))
            return False
        self._retry = None
        self.buffer.hand_on(len(batch))
        if result["rejected"]:
            self.log.warn("captures_rejected", batch=batch_id, count=len(result["rejected"]))
        return True

    def _run(self) -> None:
        while not self._stop.wait(self.cfg.flush_interval_s):
            while len(self.buffer) and self.flush_once() and not self._stop.is_set():
                pass
