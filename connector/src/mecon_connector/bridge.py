"""The transparent bridge core: serial <-> MQTT, bounded and single-threaded.

All state changes happen inside step(). Broker callbacks (any thread) only append
to an event deque. Time is injected so tests are deterministic.

What the bridge never does: look inside an envelope, change a byte of it, mint
or hold identity or keys, send an acknowledgement of its own, or choose a route.
Retry rules are in contracts/connector/v1/README.md; in short, a publish whose
outcome is unknown is counted and left alone, and a command is written to the
serial port at most once.
"""

from __future__ import annotations

import json
import random
import re
import time
from collections import deque
from dataclasses import dataclass
from typing import Callable

from .config import BrokerConfig, Config
from .framing import (
    CMD_MECON,
    ConsoleLineReader,
    MeconAssembler,
    SerialDeframer,
    encode_console_line,
    encode_mecon_frames,
    encode_serial_frame,
)
from .logutil import Log
from .metrics import Metrics
from .transport import (
    BrokerTransport,
    ConnectResult,
    SerialAmbiguous,
    SerialGone,
    SerialLink,
    SerialOpener,
    SerialUnavailable,
    TransportError,
    Will,
)

GATE_ID_RE = re.compile(r"^cg-(\d+)$")  # ids of the Connector's own deployment.get requests
READ_CHUNK = 1024
SERIAL_RETRY_S = 1.0
SERIAL_AMBIGUOUS_RETRY_S = 5.0


@dataclass
class _Entry:
    payload: bytes
    at: float


def status_payload(online: bool, serial_up: bool | None) -> bytes:
    """The Connector's own state. It says nothing about the device's identity or health."""
    serial = "unknown" if serial_up is None else ("up" if serial_up else "down")
    return json.dumps(
        {"v": 1, "connector": "online" if online else "offline", "serial": serial}, separators=(",", ":")
    ).encode()


class Bridge:
    def __init__(
        self,
        cfg: Config,
        transport: BrokerTransport,
        opener: SerialOpener,
        metrics: Metrics | None = None,
        log: Log | None = None,
        clock: Callable[[], float] = time.monotonic,
        rng: Callable[[], float] = random.random,
    ) -> None:
        self.cfg = cfg
        self.transport = transport
        self.transport.callbacks = self  # type: ignore[assignment]
        self.opener = opener
        self.m = metrics or Metrics()
        self.log = log or Log()
        self.clock = clock
        self.rng = rng
        self._started = clock()
        self._events: deque[tuple] = deque()

        # serial side
        self._link: SerialLink | None = None
        self._next_open = 0.0
        self._opened_before = False
        self._last_rx = 0.0
        self._xid = 0
        self._deframer = SerialDeframer()
        self._assembler = MeconAssembler()
        self._console = ConsoleLineReader()
        self._seen: dict[str, int] = {}
        self._serial_note: str | None = None

        # broker side
        n = len(cfg.mqtt.brokers)
        self._state = "idle"  # idle | connecting | connected
        self._active = -1
        self._last_connected = -1
        self._session = 0
        self._fails = [0] * n
        self._cool = [0.0] * n
        self._connect_started = 0.0
        self._connected_at = 0.0
        self._stopped = False

        # queues
        self._up: deque[_Entry] = deque()
        self._up_bytes = 0
        self._inflight: dict[int, _Entry] = {}
        self._down: deque[_Entry] = deque()
        self._last_drop_log = 0.0

        # enrolment gate: downlink is open only while the device says it holds a Deployment record
        self._status_pending: set[int] = set()
        self._gate_open = False
        self._probe_seq = 0
        self._probe_id: str | None = None  # the request in flight, if any
        self._probe_deadline = 0.0
        self._next_probe = 0.0
        self._epoch: int | None = None

    # ---- broker callbacks (any thread) -------------------------------------------------

    def on_connected(self, session: int, result: ConnectResult) -> None:
        self._events.append(("connected", session, result))

    def on_disconnected(self, session: int) -> None:
        self._events.append(("disconnected", session))

    def on_acked(self, session: int, mid: int) -> None:
        self._events.append(("acked", session, mid))

    def on_message(self, session: int, topic: str, payload: bytes, retain: bool) -> None:
        self._events.append(("message", session, topic, payload, retain, self.clock()))

    # ---- the loop ----------------------------------------------------------------------

    def step(self) -> None:
        now = self.clock()
        self._drain_events(now)
        self._serial_step(now)
        self._gate_step(now)
        self._broker_step(now)
        self._flush_upstream(now)
        self._flush_downlink(now)
        self._update_gauges(now)

    def run(self, stop) -> None:  # type: ignore[no-untyped-def]
        try:
            while not stop.is_set():
                self.step()
                if self._link is None:
                    time.sleep(0.05)
        finally:
            self.stop()  # release the broker session cleanly even if the loop failed

    def stop(self) -> None:
        """Explicit shutdown. Queued envelopes are dropped and counted, never sent late."""
        if self._stopped:
            return
        self._stopped = True
        if self._state == "connected":
            # Release explicitly: the retained status says offline before the session is closed.
            mid = self._publish_status(online=False)
            for _ in range(50):
                self._drain_events(self.clock())
                if mid is None or mid not in self._status_pending:
                    break
                time.sleep(0.02)
        self.transport.disconnect()
        self._state = "idle"
        self._active = -1
        if self._link is not None:
            self._link.close()
            self._link = None
        self.m.inc("upstream_dropped_total", len(self._up), "shutdown")
        self.m.inc("upstream_uncertain_total", len(self._inflight))
        self.m.inc("downlink_dropped_total", len(self._down), "shutdown")
        self._up.clear()
        self._up_bytes = 0
        self._inflight.clear()
        self._down.clear()
        self._update_gauges(self.clock())
        self.m.set("serial_connected", 0)
        self.m.set("broker_connected", 0)

    # ---- events ------------------------------------------------------------------------

    def _drain_events(self, now: float) -> None:
        while self._events:
            ev = self._events.popleft()
            if ev[1] != self._session:
                continue  # from an earlier session: ignore
            kind = ev[0]
            if kind == "connected":
                self._on_connected(now, ev[2])
            elif kind == "disconnected":
                self._on_disconnected(now)
            elif kind == "acked":
                self._status_pending.discard(ev[2])
                if self._inflight.pop(ev[2], None) is not None:
                    self.m.inc("upstream_acked_total")
            elif kind == "message":
                self._on_message(ev[5], ev[2], ev[3], ev[4])

    def _on_connected(self, now: float, result: ConnectResult) -> None:
        if self._state != "connecting":
            return
        if not result.ok:
            self._attempt_failed(now, result.kind)
            return
        self._state = "connected"
        self._connected_at = now
        self.m.inc("broker_connect_attempts_total", 1, "ok")
        if self._last_connected not in (-1, self._active):
            self.m.inc("broker_failovers_total")
        self._last_connected = self._active
        # Re-read the enrolment state on every (re)connect, with downlink closed meanwhile.
        self._close_gate("reconnect", now, abandon=False)
        self.log.info("broker_connected", broker=self.cfg.mqtt.brokers[self._active].name)
        self._publish_status(online=True)

    def _on_disconnected(self, now: float) -> None:
        if self._state == "connecting":
            self._attempt_failed(now, "network")
            return
        if self._state != "connected":
            return
        self.m.inc("broker_disconnects_total")
        # Publishes that were sent and not acknowledged have an unknown outcome. They are
        # counted and forgotten. They are never put back on the queue: that would risk a
        # duplicate of an envelope the broker may already hold.
        self.m.inc("upstream_uncertain_total", len(self._inflight))
        self._inflight.clear()
        i = self._active
        if now - self._connected_at >= self.cfg.mqtt.stable_after_s:
            self._fails[i] = 0
            self._cool[i] = now + self.cfg.mqtt.backoff_base_s
        else:
            self._fails[i] += 1
            self._cool[i] = now + self._delay("network", self._fails[i])
        self.log.warn("broker_disconnected", broker=self.cfg.mqtt.brokers[i].name)
        self._end_session()

    def _on_message(self, now: float, topic: str, payload: bytes, retain: bool) -> None:
        if topic != self.cfg.mqtt.topic_down:
            return
        self.m.inc("downlink_received_total")
        dev = self.cfg.device
        if retain:
            # A retained command would run again at every reconnect.
            self.m.inc("downlink_dropped_total", 1, "retained")
        elif not self._gate_open:
            # Never held and never replayed: the sender re-sends if it still wants it.
            self.m.inc("downlink_closed_total")
        elif not payload:
            self.m.inc("downlink_dropped_total", 1, "invalid")
        elif len(payload) > dev.max_downlink_bytes:
            self.m.inc("downlink_dropped_total", 1, "too_large")
        elif dev.mode == "console" and (b"\r" in payload or b"\n" in payload):
            # A line break would split one request into several console lines.
            self.m.inc("downlink_dropped_total", 1, "invalid")
        elif len(self._down) >= self.cfg.queues.downlink_max_messages:
            self.m.inc("downlink_dropped_total", 1, "queue_full")
        else:
            self._down.append(_Entry(bytes(payload), now))

    # ---- broker connection -------------------------------------------------------------

    def _delay(self, kind: str, failures: int) -> float:
        c = self.cfg.mqtt
        if kind in ("auth", "tls"):
            base, cap = max(60.0, c.backoff_base_s), 3600.0
        else:
            base, cap = c.backoff_base_s, c.backoff_max_s
        d = min(cap, base * (2 ** max(0, failures - 1)))
        return d * (1 + c.backoff_jitter * (2 * self.rng() - 1))

    def _end_session(self) -> None:
        self.transport.disconnect()
        self._state = "idle"
        self._active = -1
        self.m.set("broker_connected", 0)

    def _attempt_failed(self, now: float, kind: str) -> None:
        i = self._active
        self._fails[i] += 1
        self._cool[i] = now + self._delay(kind, self._fails[i])
        self.m.inc("broker_connect_attempts_total", 1, kind if kind in ("network", "tls", "auth", "refused", "timeout") else "network")
        self.log.warn("broker_connect_failed", broker=self.cfg.mqtt.brokers[i].name, kind=kind, failures=self._fails[i])
        self._end_session()

    def _broker_step(self, now: float) -> None:
        if self._stopped:
            return
        c = self.cfg.mqtt
        if self._state == "idle":
            for i, b in enumerate(c.brokers):
                if self._cool[i] <= now:
                    self._start_connect(now, i, b)
                    break
        elif self._state == "connecting":
            if now - self._connect_started >= c.connect_timeout_s:
                self._attempt_failed(now, "timeout")
        elif self._state == "connected" and self._active > 0:
            better = any(self._cool[i] <= now for i in range(self._active))
            if better and now - self._connected_at >= c.hold_down_s:
                # Return to a higher-priority broker, at most once per hold-down.
                self.log.info("broker_return_to_better", broker=c.brokers[self._active].name)
                self._publish_status(online=False)
                self.m.inc("broker_disconnects_total")
                self.m.inc("upstream_uncertain_total", len(self._inflight))
                self._inflight.clear()
                self._end_session()

    def _start_connect(self, now: float, i: int, b: BrokerConfig) -> None:
        c = self.cfg.mqtt
        will = Will(c.topic_status, status_payload(False, None), 1, True)
        subs = [(c.topic_down, 0)]
        self._active = i
        self._state = "connecting"
        self._connect_started = now
        try:
            self._session = self.transport.connect(b, will, subs)
        except TransportError as e:
            # No session was started (for example the password_file cannot be read now). Counted as an
            # auth failure, which backs off for at least a minute: retrying fast changes nothing.
            self.log.warn("broker_credential_unavailable", broker=b.name, reason=str(e))
            self._attempt_failed(now, "auth")

    def _publish_status(self, online: bool) -> int | None:
        if self._state != "connected":
            return None
        try:
            mid = self.transport.publish(
                self.cfg.mqtt.topic_status, status_payload(online, self._link is not None), 1, True
            )
        except TransportError:
            return None
        self._status_pending.add(mid)
        return mid

    # ---- upstream (device -> broker) ---------------------------------------------------

    def _on_envelope(self, payload: bytes, now: float) -> None:
        self.m.inc("upstream_envelopes_total")
        q = self.cfg.queues
        if len(self._up) >= q.upstream_max_messages or self._up_bytes + len(payload) > q.upstream_max_bytes:
            # Newest is dropped: what is queued was accepted first and keeps its order.
            self.m.inc("upstream_dropped_total", 1, "queue_full")
            if now - self._last_drop_log >= 1.0:
                self._last_drop_log = now
                self.log.warn("upstream_queue_full", depth=len(self._up))
            return
        self._up.append(_Entry(payload, now))
        self._up_bytes += len(payload)

    def _flush_upstream(self, now: float) -> None:
        ttl = self.cfg.queues.upstream_ttl_s
        while self._up and now - self._up[0].at > ttl:
            e = self._up.popleft()
            self._up_bytes -= len(e.payload)
            self.m.inc("upstream_dropped_total", 1, "ttl")
        if self._state != "connected":
            return
        qos = self.cfg.mqtt.upstream_qos
        while self._up and (qos == 0 or len(self._inflight) < self.cfg.queues.upstream_max_inflight):
            e = self._up[0]
            try:
                mid = self.transport.publish(self.cfg.mqtt.topic_up, e.payload, qos, False)
            except TransportError:
                break  # refused before anything was sent: it stays queued
            self._up.popleft()
            self._up_bytes -= len(e.payload)
            self.m.inc("upstream_published_total")
            if qos == 1:
                self._inflight[mid] = e

    # ---- downlink (broker -> device) ---------------------------------------------------

    def _flush_downlink(self, now: float) -> None:
        ttl = self.cfg.queues.downlink_ttl_s
        while self._down:
            e = self._down[0]
            if not self._gate_open:
                self._down.popleft()
                self.m.inc("downlink_closed_total")
                continue
            if now - e.at > ttl:
                self._down.popleft()
                self.m.inc("downlink_dropped_total", 1, "ttl")
                continue
            if self._link is None:
                # A command is never held across an unplug: it would run after a replug the sender did not see.
                self._down.popleft()
                self.m.inc("downlink_dropped_total", 1, "serial_down")
                continue
            self._down.popleft()
            self._write_down(e.payload, now)

    def _encode_for_device(self, message: bytes) -> bytes:
        if self.cfg.device.mode == "console":
            return encode_console_line(message)
        self._xid = (self._xid + 1) & 0xFF
        return b"".join(encode_serial_frame(f) for f in encode_mecon_frames(self._xid, message))

    def _write_down(self, message: bytes, now: float) -> None:
        assert self._link is not None
        data = self._encode_for_device(message)
        try:
            self._link.write(data)
        except SerialGone:
            # Outcome unknown: the device may have seen all, part or none of it. Never retried.
            self.m.inc("downlink_write_failed_total")
            self._serial_lost(now)
            return
        self.m.inc("serial_bytes_out_total", len(data))
        self.m.inc("downlink_written_total")

    # ---- serial ------------------------------------------------------------------------

    def _serial_step(self, now: float) -> None:
        if self._stopped:
            return
        if self._link is None:
            if now >= self._next_open:
                self._try_open(now)
            return
        try:
            data = self._link.read(READ_CHUNK)
        except SerialGone:
            self._serial_lost(now)
            return
        if data:
            self._last_rx = now
            self.m.inc("serial_bytes_in_total", len(data))
            self._on_serial_bytes(data, now)
        else:
            self._check_stall(now)

    def _try_open(self, now: float) -> None:
        try:
            link = self.opener()
        except SerialUnavailable:
            self._note_serial("unavailable")
            self._next_open = now + SERIAL_RETRY_S
            return
        except SerialAmbiguous:
            self._note_serial("ambiguous")
            self._next_open = now + SERIAL_AMBIGUOUS_RETRY_S
            return
        except SerialGone:
            self._note_serial("open_failed")
            self._next_open = now + SERIAL_RETRY_S
            return
        self._link = link
        self._last_rx = now
        self._reset_readers()
        if self._opened_before:
            self.m.inc("serial_reconnects_total")
        self._opened_before = True
        self._serial_note = None
        self._epoch = None
        self._next_probe = now
        self.m.set("serial_connected", 1)
        self.log.info("serial_connected")
        self._publish_status(online=True)

    def _note_serial(self, what: str) -> None:
        if self._serial_note != what:
            self._serial_note = what
            self.log.warn("serial_" + what)

    def _serial_lost(self, now: float) -> None:
        if self._link is not None:
            self._link.close()
        self._link = None
        self._next_open = now + 0.5
        self._close_gate("serial_lost", now)
        self._probe_id = None
        lost = self._reset_readers()
        self.m.inc("serial_discarded_bytes_total", lost, "unplug")
        self.m.inc("serial_disconnects_total")
        self.m.set("serial_connected", 0)
        self.log.warn("serial_lost")
        self._publish_status(online=True)

    def _reset_readers(self) -> int:
        n = self._deframer.reset() + self._assembler.reset() + self._console.reset()
        self._sync_stats()
        return n

    def _check_stall(self, now: float) -> None:
        if now - self._last_rx < self.cfg.device.stall_s:
            return
        n = self._deframer.reset() + self._assembler.reset() + self._console.reset()
        if n:
            self.m.inc("serial_stall_resets_total")
            self.m.inc("serial_discarded_bytes_total", n, "stall")
            self._sync_stats()
        self._last_rx = now

    def _on_serial_bytes(self, data: bytes, now: float) -> None:
        if self.cfg.device.mode == "console":
            for line in self._console.feed(data):
                self.m.inc("serial_frames_total", 1, "console_line")
                self._on_device_message(line, now)
        else:
            for frame in self._deframer.feed(data):
                if frame[0] == CMD_MECON:
                    self.m.inc("serial_frames_total", 1, "mecon_frame")
                    message = self._assembler.feed(frame, now)
                    if message is not None:
                        self._on_device_message(message, now)
                else:
                    # Native companion traffic is not interface traffic and is not forwarded.
                    self.m.inc("serial_frames_total", 1, "native")
                    self.m.inc("serial_discarded_bytes_total", len(frame), "native")
            self._assembler.expire(now)
        self._sync_stats()

    def _sync_stats(self) -> None:
        d, a, c = self._deframer.stats, self._assembler.stats, self._console.stats
        cur = {
            ("serial_discarded_bytes_total", "garbage"): d.skipped_bytes + c.skipped_bytes,
            ("serial_anomalies_total", "oversize_length"): d.oversize_lengths,
            ("serial_anomalies_total", "empty_frame"): d.empty_frames,
            ("serial_anomalies_total", "malformed_frame"): a.malformed,
            ("serial_anomalies_total", "duplicate_frame"): a.duplicate_frames,
            ("serial_anomalies_total", "incomplete_discarded"): a.discarded_incomplete,
            ("serial_anomalies_total", "oversize_message"): a.oversize,
            ("serial_anomalies_total", "console_oversize_line"): c.oversize_lines,
        }
        for (name, label), v in cur.items():
            key = f"{name}/{label}"
            delta = v - self._seen.get(key, 0)
            if delta:
                self.m.inc(name, delta, label)
                self._seen[key] = v

    # ---- enrolment gate ----------------------------------------------------------------

    def _close_gate(self, reason: str, now: float, abandon: bool = True) -> None:
        """Closes downlink at once and asks the device again. Anything queued for the device is
        refused and counted, never kept for when the gate reopens."""
        if self._gate_open:
            self._gate_open = False
            self.m.inc("downlink_gate_closes_total", 1, reason)
            self.log.warn("downlink_closed", reason=reason)
        n = len(self._down)
        self._down.clear()
        self.m.inc("downlink_closed_total", n)
        if abandon:
            self._probe_id = None  # an answer to an older request says nothing about now
        self._next_probe = now

    def _gate_step(self, now: float) -> None:
        if self._link is None or self._stopped:
            return
        if self._probe_id is not None:
            if now >= self._probe_deadline:
                self._probe_id = None
                self.m.inc("downlink_gate_probes_total", 1, "timeout")
                self._gate_result(False, "probe_failed", now)
            return
        if now >= self._next_probe:
            self._probe_seq += 1
            pid = f"cg-{self._probe_seq}"
            msg = json.dumps({"v": 1, "id": pid, "op": "deployment.get"}, separators=(",", ":")).encode()
            data = self._encode_for_device(msg)
            try:
                assert self._link is not None
                self._link.write(data)
            except SerialGone:
                self._serial_lost(now)
                return
            self.m.inc("serial_bytes_out_total", len(data))
            self._probe_id = pid
            self._probe_deadline = now + self.cfg.gate.timeout_s

    def _gate_result(self, provisioned: bool, reason: str, now: float) -> None:
        g = self.cfg.gate
        if provisioned:
            if not self._gate_open:
                self.log.info("downlink_open")
            self._gate_open = True
            self._next_probe = now + g.recheck_s
        else:
            self._close_gate(reason, now, abandon=False)
            self._next_probe = now + g.retry_s

    @staticmethod
    def _parse(payload: bytes) -> dict | None:
        try:
            obj = json.loads(payload)
        except (ValueError, RecursionError):
            return None
        return obj if isinstance(obj, dict) else None

    def _on_device_message(self, payload: bytes, now: float) -> None:
        """Looks at an uplink message only for the gate: its own request id, `epoch` and `usig`.
        The message itself is never changed, and is always forwarded, except the device's answer to
        the Connector's own deployment.get, which is the Connector's traffic and not the device's."""
        obj = self._parse(payload)
        mid = GATE_ID_RE.match(obj["id"]) if obj is not None and isinstance(obj.get("id"), str) else None
        if mid is not None and int(mid.group(1)) <= self._probe_seq:
            self._on_probe_reply(obj, mid.group(0), now)  # type: ignore[arg-type]
            return
        epoch = None
        if obj is not None:
            res = obj.get("result")
            for cand in (obj.get("epoch"), res.get("epoch") if isinstance(res, dict) else None, obj.get("usig_boot")):
                if isinstance(cand, int) and not isinstance(cand, bool):
                    epoch = cand
                    break
        if epoch is not None:
            if self._epoch is not None and epoch != self._epoch:
                self._epoch = epoch
                self._close_gate("epoch_changed", now)  # rebooted: ask again before relaying anything
            self._epoch = epoch
        if self._gate_open and (obj is None or "usig" not in obj):
            self._close_gate("unsigned_uplink", now)
        self._on_envelope(payload, now)

    def _on_probe_reply(self, obj: dict, pid: str, now: float) -> None:
        if pid != self._probe_id:
            self.m.inc("downlink_gate_probes_total", 1, "late")
            return
        self._probe_id = None
        res = obj.get("result")
        state = res.get("state") if isinstance(res, dict) else None
        epoch = res.get("epoch") if isinstance(res, dict) else obj.get("epoch")
        if isinstance(obj.get("epoch"), int) and not isinstance(obj.get("epoch"), bool):
            self._epoch = obj["epoch"]
        elif isinstance(epoch, int) and not isinstance(epoch, bool):
            self._epoch = epoch
        if obj.get("status") != "ok":
            self.m.inc("downlink_gate_probes_total", 1, "refused")
            self._gate_result(False, "not_provisioned", now)
        elif state == "provisioned":
            self.m.inc("downlink_gate_probes_total", 1, "provisioned")
            self._gate_result(True, "", now)
        elif state in ("none", "corrupt"):
            self.m.inc("downlink_gate_probes_total", 1, state)
            self._gate_result(False, "not_provisioned", now)
        else:
            self.m.inc("downlink_gate_probes_total", 1, "malformed")
            self._gate_result(False, "not_provisioned", now)

    # ---- observability -----------------------------------------------------------------

    def _update_gauges(self, now: float) -> None:
        m = self.m
        m.set("serial_connected", 1 if self._link is not None else 0)
        m.set("broker_connected", 1 if self._state == "connected" else 0)
        m.set("broker_active_index", self._active if self._state == "connected" else -1)
        m.set("upstream_queue_depth", len(self._up))
        m.set("upstream_queue_bytes", self._up_bytes)
        m.set("upstream_inflight", len(self._inflight))
        m.set("downlink_queue_depth", len(self._down))
        m.set("downlink_gate_open", 1 if self._gate_open else 0)
        m.set("uptime_seconds", now - self._started)

    def snapshot(self) -> dict:
        """What /healthz reports. Distinguishes the stages; none implies a Backend or RF outcome."""
        return {
            "serial": "up" if self._link is not None else "down",
            "broker": self._state,
            "broker_name": self.cfg.mqtt.brokers[self._active].name if self._state == "connected" else None,
            "upstream_queue": len(self._up),
            "downlink": "open" if self._gate_open else "closed",
            "ready": self._link is not None and self._state == "connected",
        }

    def accounting_gap(self) -> int:
        """envelopes taken from serial minus (published + dropped + queued). Always 0."""
        m = self.m
        return int(
            m.get("upstream_envelopes_total")
            - m.get("upstream_published_total")
            - m.total("upstream_dropped_total")
            - len(self._up)
        )
