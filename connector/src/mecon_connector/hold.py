"""The hold transport: serial <-> a Backend's WebSocket hold (contracts/connector-hold/v1).

A second transport beside the MQTT bridge in bridge.py, sharing its framing, serial rules and the
enrolment gate's meaning. Single-threaded like the MQTT bridge: all state changes happen in step(); the
WebSocket thread only appends to an event deque. Time is injected so tests are deterministic.

What it never does: look inside a request's `wire`, change a byte of it, add `auth`, sign, hold keys or
identity, answer for the device, or send a second request before the first is answered or abandoned. It
reads a device message only for its `id`, `ev`, `epoch` and `usig` members. A device text reaches the
Backend exactly as the device sent it (a JSON string value that decodes to the same characters).

Bootloader DFU (section 12 of the contract, only with [dfu] enabled): a `dfu_job` on the live socket arms the
one exception to "close the socket when the device link drops". The package is fetched and checked at once;
if the application port then drops within the arming window, the socket is kept, nothing is relayed, the
bootloader's own port is found and the package is sent to it (nordic_dfu.py), and the normal path resumes when
the application port returns. Without an armed job the bootloader port is never opened.

Stop rules: a `refused` frame, or a close 1008 (or an HTTP 401 or 403 on the handshake) that came without
one, is a stop and not a retry. The process then exits with status 3, which the systemd unit does not
restart. Every other loss reconnects on 1, 2, 4, 8, 15 s (15 s from then on). The one bounded exception
(section 2.5): a refusal "another agent holds this device" within 30 s of the Connector's own socket closing
is most likely the Backend still holding that old socket, so it is retried up to 3 times on the same backoff.
"""

from __future__ import annotations

import json
import re
import threading
import time
from collections import deque
from dataclasses import dataclass
from typing import Callable

from .config import Config
from .framing import (
    CMD_MECON,
    CONSOLE_MAX_WIRE,
    CONSOLE_PREFIX,
    MECON_MAX_MESSAGE,
    ConsoleLineReader,
    MeconAssembler,
    SerialDeframer,
    encode_console_line,
    encode_mecon_frames,
    encode_serial_frame,
)
from .logutil import Log
from .metrics import Metrics
from .nordic_dfu import BAUD as DFU_BAUD
from .nordic_dfu import Package, PackageError, TransferError, make_fetcher, read_package, run_transfer, verify_package
from .serial_link import SelectorOverlap, make_opener
from .transport import (
    SerialAmbiguous,
    SerialGone,
    SerialLink,
    SerialOpener,
    SerialUnavailable,
    TransportError,
)

EXIT_HOLD_STOPPED = 3  # a refusal or a rejected token: the operator must act, so systemd must not loop

BACKOFF_S = (1.0, 2.0, 4.0, 8.0, 15.0)  # then 15 s; the counter resets when a socket opens
# Section 2.5: the one refusal that may be retried, how often, and only within this long of the own close.
REFUSED_RETRY_REASON = "another agent holds this device"
REFUSED_RETRY_MAX = 3
REFUSED_RETRY_WINDOW_S = 30.0
STREAM_RE = re.compile(r"^[a-z][a-z_]{0,31}$")
REQ_ID_RE = re.compile(r"^[0-9A-Za-z._:-]{1,32}$")
GATE_ID_RE = re.compile(r"^cg-(\d+)$")  # ids of the Connector's own deployment.get requests
HELLO_ID_RE = re.compile(r"^ch-(\d+)$")  # ids of the Connector's own hello requests
MAX_UPLOAD_CHARS = 8192
COMPANION_MAX_WIRE = MECON_MAX_MESSAGE  # 4096 bytes
HELLO_RETRY_S = 5.0
MAX_HELLO_PAGES = 40  # hello capability pages the Connector will read (the Reader's channel-list page bound)
READ_CHUNK = 1024
SERIAL_RETRY_S = 1.0
SERIAL_AMBIGUOUS_RETRY_S = 5.0
MAX_PENDING_REFS = 256
CONNECT_GRACE_S = 5.0  # beyond the transport's own connect timeout
JOB_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._:-]{0,63}$")  # a DFU job id: one URL path segment
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
BOOT_LOOK_S = 0.5  # how often the bootloader port is looked for
BOOT_SETTLE_S = 1.0  # before a fresh transfer attempt on the same bootloader
DFU_KEEPS = ("waiting-bootloader", "transferring", "rebooting", "resuming", "failed")  # phases that keep the socket
DFU_RECONNECT = ("waiting-bootloader", "transferring", "rebooting", "failed")  # reconnect a lost socket, no device link


@dataclass
class _Slot:
    """The one request on the device link: the Connector's own, or a relayed one."""

    kind: str  # "hello" | "gate" | "relay"
    id: str
    deadline: float


@dataclass
class _Req:
    id: str
    wire: bytes
    at: float


def _thread_runner(fn: Callable[[], None]) -> None:
    threading.Thread(target=fn, name="dfu", daemon=True).start()


def _is_int(v: object) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _epoch_of(obj: dict) -> int | None:
    """The device's boot epoch: the envelope's top-level `epoch`, carried on every result and event and
    incremented on every boot (device interface contract). Never `result.epoch` (inside an answer it means
    something else, e.g. a Deployment authority epoch) and never `usig_boot` (a separate signing counter):
    mixing them made the gate see a reboot that did not happen."""
    cand = obj.get("epoch")
    return cand if _is_int(cand) else None


class HoldBridge:
    def __init__(
        self,
        cfg: Config,
        transport,  # a HoldTransport
        opener: SerialOpener,
        metrics: Metrics | None = None,
        log: Log | None = None,
        clock: Callable[[], float] = time.monotonic,
        dfu_fetcher: Callable[[str], bytes] | None = None,
        boot_opener: SerialOpener | None = None,
        runner: Callable[[Callable[[], None]], None] | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        assert cfg.hold is not None
        self.cfg = cfg
        self.hc = cfg.hold
        self.transport = transport
        self.transport.callbacks = self
        self.opener = opener
        self.m = metrics or Metrics(hold=True)
        self.log = log or Log()
        self.clock = clock
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
        self._console_primed = False  # the bare CR is written once per link
        self._seen: dict[str, int] = {}
        self._serial_note: str | None = None
        self._max_wire = CONSOLE_MAX_WIRE if cfg.device.mode == "console" else COMPANION_MAX_WIRE

        # the device request slot, the relay queue, and what is known about the device
        self._slot: _Slot | None = None
        self._queue: deque[_Req] = deque()
        self._abandoned: deque[str] = deque(maxlen=16)  # relayed ids given up on; a late answer is still uploaded
        self._late_own: deque[str] = deque(maxlen=8)  # own ids given up on; a late answer is consumed
        self._hello: dict | None = None  # the device's hello result object, read by the Connector itself
        self._need_hello = True
        self._next_hello = 0.0
        self._hello_seq = 0
        self._hello_acc: dict | None = None  # the merged hello so far while later pages are being read
        self._hello_cursor: object = None  # the `next` of the last page: asked for as `hello {cursor}`
        self._hello_pages = 0
        self._epoch: int | None = None

        # enrolment gate: relayed requests are carried only while the device says it holds a Deployment record
        self._gate_open = False
        self._gate_closed_for_good = False  # the last deployment.get said "not enrolled" (not merely "asking")
        self._probe_seq = 0
        self._next_probe = 0.0

        # hold side
        self._state = "idle"  # idle | connecting | connected | stopped
        self._session = 0
        self._attempt = 0
        self._retry_at = 0.0
        self._connect_started = 0.0
        self._ref = 0
        self._pending_refs: dict[int, str] = {}  # ref -> frame type it was sent in
        self._refused: str | None = None
        self._own_close_at: float | None = None  # when a socket of this process last closed other than by refusal
        self._refused_retries = 0  # refusals retried since that close
        self.hold_stop: tuple[str, str] | None = None  # (reason, detail) once stopped for good
        self._stopped = False

        # bootloader DFU (only with [dfu] enabled). Fetches and transfers run off the loop through `runner` and
        # report back through the event deque, tagged with the generation they were started in.
        self._dfu_cfg = cfg.dfu
        dc = cfg.dfu
        self._dfu_fetcher = dfu_fetcher or (make_fetcher(cfg.hold, dc.package_max_bytes) if dc else None)
        self._boot_opener = boot_opener or (make_opener(dc.bootloader, DFU_BAUD) if dc else None)
        self._runner = runner or _thread_runner
        self._sleep = sleep
        self._dfu_phase = "none"  # none | armed | waiting-bootloader | transferring | rebooting | resuming | failed
        self._dfu_job: dict | None = None  # {"job", "sha256", "size"} as the Backend sent them
        self._dfu_armed_at = 0.0
        self._dfu_gen = 0
        self._dfu_fetch_state = "idle"  # idle | running | ok | failed
        self._dfu_pkg: Package | None = None  # held in memory only, and only until the transfer ends
        self._dfu_deadline: float | None = None
        self._dfu_next_look = 0.0
        self._dfu_attempt = 0
        self._dfu_ambiguous_noted = False
        self._dfu_last: dict | None = None  # the last dfu_state sent: sent again once on a new socket
        self._dfu_failed_at = 0.0
        self._dfu_overlap_noted = False

    # ---- transport callbacks (any thread) ----------------------------------------------

    def on_open(self, session: int, subprotocol: str | None) -> None:
        self._events.append(("open", session, subprotocol))

    def on_frame(self, session: int, frame: str | bytes) -> None:
        self._events.append(("frame", session, frame))

    def on_failed(self, session: int, kind: str) -> None:
        self._events.append(("failed", session, kind))

    def on_closed(self, session: int, code: int, reason: str) -> None:
        self._events.append(("closed", session, code, reason))

    # ---- the loop ----------------------------------------------------------------------

    def step(self) -> None:
        now = self.clock()
        self._drain_events(now)
        self._serial_step(now)
        self._device_step(now)
        self._hold_step(now)
        self._update_gauges(now)

    def run(self, stop) -> None:  # type: ignore[no-untyped-def]
        try:
            while not stop.is_set() and self.hold_stop is None:
                self.step()
                if self._link is None:
                    time.sleep(0.05)
        finally:
            self.stop()

    def stop(self) -> None:
        """Explicit shutdown: close the hold with 1000 and release the port. Queued requests are dropped and counted."""
        if self._stopped:
            return
        self._stopped = True
        self._dfu_gen += 1  # a fetch or transfer still running reports into nothing
        self.transport.close(1000, "stopped")
        if self._state != "stopped":
            self._state = "idle"
        self._session = -1
        self._forget_pending()
        if self._link is not None:
            self._link.close()
            self._link = None
        self.m.inc("downlink_dropped_total", len(self._queue), "shutdown")
        self._queue.clear()
        self._slot = None
        self._update_gauges(self.clock())
        self.m.set("serial_connected", 0)
        self.m.set("hold_connected", 0)

    # ---- hold events -------------------------------------------------------------------

    def _drain_events(self, now: float) -> None:
        while self._events:
            ev = self._events.popleft()
            if ev[0] == "dfu":
                if ev[1] == self._dfu_gen:  # a result of a fetch or transfer that is still the current one
                    self._on_dfu_result(now, ev[2], ev[3])
                continue
            if ev[1] != self._session:
                continue  # from a session that has ended: ignore
            kind = ev[0]
            if kind == "open":
                self._on_open(now, ev[2])
            elif kind == "frame":
                self._on_frame(now, ev[2])
            elif kind == "failed":
                self._on_failed(now, ev[2])
            elif kind == "closed":
                self._on_closed(now, ev[2], ev[3])

    def _on_open(self, now: float, subprotocol: str | None) -> None:
        if self._state != "connecting":
            return
        self._state = "connected"
        self._attempt = 0
        self._refused = None
        self._forget_pending()  # normally empty: every way a session ends already settled them
        self.m.inc("hold_connect_attempts_total", 1, "ok")
        self.log.info("hold_connected", subprotocol=subprotocol)
        if self._dfu_phase == "resuming":
            self._dfu_clear()  # a new socket after a DFU: this normal start is the resume
        # Declare first: until iface_relay is sent the Backend never sends a request on this socket.
        if self._send(self._relay_frame()):
            self.m.inc("hold_relay_declared_total")
        self._upload_hello()
        if self._dfu_phase in DFU_RECONNECT and self._dfu_last is not None:
            self._send(self._dfu_last)  # a new socket during a DFU: the Backend hears where the job is, once

    def _relay_frame(self) -> dict:
        """iface_relay, with serial_dfu only when this Connector is configured to run a bootloader DFU: the Backend
        lifts its refusal of a bootloader-dfu offer only for a socket that made this declaration."""
        if self._dfu_cfg is not None:
            return {"type": "iface_relay", "serial_dfu": True}
        return {"type": "iface_relay"}

    def _on_failed(self, now: float, kind: str) -> None:
        if self._state != "connecting":
            return
        self.m.inc("hold_connect_attempts_total", 1, kind if kind in ("network", "tls", "timeout", "http", "bad_token") else "network")
        if kind == "bad_token":
            self._stop_hold("bad_token", "the Backend rejected the connector token at the handshake")
            return
        self.log.warn("hold_connect_failed", kind=kind, attempt=self._attempt + 1)
        self._schedule_retry(now)

    def _on_closed(self, now: float, code: int, reason: str) -> None:
        if self._state != "connected":
            return
        self.m.inc("hold_disconnects_total")
        if self._refused is not None:
            self._end_session()
            self._stop_hold("refused", self._refused)
        elif code == 1008:
            # A policy close with no `refused` frame is how a token the Backend does not accept looks.
            self._end_session()
            self._stop_hold("bad_token", "the Backend closed the hold with 1008 and no refusal")
        else:
            self.log.warn("hold_closed", code=code, close_reason=reason)
            self._note_own_close(now)
            self._schedule_retry(now)  # the attempt counter was reset when the socket opened: 1 s first

    def _note_own_close(self, now: float) -> None:
        """A socket this process held closed other than by a refusal (the network, the Backend, or the Connector
        itself). It was a successful connect, so the refusal retries start again from 0, and the window of
        section 2.5 runs from now: the Backend may not have noticed this close yet."""
        self._own_close_at = now
        self._refused_retries = 0

    def _retry_refusal(self, now: float, reason: str) -> bool:
        """Section 2.5: a refusal "another agent holds this device" within 30 s of this process's own close may
        be the Backend still holding that socket. Retried at most REFUSED_RETRY_MAX times, on the normal backoff,
        each retry due within the window. Any other reason, no own close, or no retry left: False (a stop)."""
        if reason != REFUSED_RETRY_REASON or self._own_close_at is None:
            return False
        if self._refused_retries >= REFUSED_RETRY_MAX:
            return False
        delay = BACKOFF_S[min(self._refused_retries, len(BACKOFF_S) - 1)]
        if now + delay - self._own_close_at > REFUSED_RETRY_WINDOW_S:
            return False
        self._refused_retries += 1
        self.m.inc("hold_refused_retries_total")
        self.log.warn("hold_refused_retry", reason=reason, attempt=self._refused_retries, of=REFUSED_RETRY_MAX,
                      retry_in_s=delay)
        self.transport.close(1000, "refused")  # the Backend closes it 1008 too; that close is of an ended session
        self._end_session()
        self._refused = None
        self._retry_at = now + delay
        return True

    def _schedule_retry(self, now: float) -> None:
        self._end_session()
        self._retry_at = now + BACKOFF_S[min(self._attempt, len(BACKOFF_S) - 1)]
        self._attempt += 1

    def _end_session(self) -> None:
        """Forget the session. Requests queued for it are dropped; a request already on the device runs on."""
        self._state = "idle"
        self._session = 0
        self._forget_pending()
        n = len(self._queue)
        self._queue.clear()
        self.m.inc("downlink_dropped_total", n, "socket_down")
        self.m.set("hold_connected", 0)
        if self._dfu_phase == "armed":
            self._dfu_disarm("socket_ended")  # a job arms one socket; a DFU already under way runs on

    def _forget_pending(self) -> None:
        """Uploads sent on a session that ended before their ack: the Backend may or may not have them.
        Counted as uncertain and never resent, like a publish the MQTT transport lost its PUBACK for."""
        self.m.inc("hold_uploads_uncertain_total", len(self._pending_refs))
        self._pending_refs.clear()

    def _stop_hold(self, reason: str, detail: str) -> None:
        if self.hold_stop is not None:
            return
        detail = "".join(c if " " <= c <= "~" else "?" for c in detail)[:200]  # a Backend's text is data, not markup
        self.hold_stop = (reason, detail)
        self.m.set("hold_stopped", 1)
        self.log.error("hold_stopped", reason=reason, detail=detail)
        self.transport.close(1000, "stopped")
        self._state = "stopped"
        self._session = -1
        self._forget_pending()
        n = len(self._queue)
        self._queue.clear()
        self.m.inc("downlink_dropped_total", n, "socket_down")

    def _close_hold(self, why: str, now: float) -> None:
        """Releases the hold on purpose (the device link dropped, or the device is not enrolled)."""
        if why == "device_link_lost" and self._dfu_keeps_socket():
            return  # the one exception: an armed DFU keeps the socket while the device is in its bootloader
        if self._state in ("connecting", "connected"):
            if self._state == "connected":
                self.m.inc("hold_disconnects_total")
            self.log.info("hold_released", why=why)
            self.transport.close(1000, why)
            if self._state == "connected":
                self._note_own_close(now)
            self._end_session()
            self._retry_at = 0.0

    # ---- connecting --------------------------------------------------------------------

    def _hold_step(self, now: float) -> None:
        if self._stopped or self.hold_stop is not None:
            return
        self._dfu_step(now)
        keep = (self._link is not None and self._hello is not None and not self._gate_closed_for_good) or (
            self._dfu_keeps_socket()
        )
        want = keep and self._gate_open
        want = want or (keep and self._dfu_phase in DFU_RECONNECT)  # a DFU reports on a new socket without a device
        if self._state == "connected":
            if not keep:
                self._close_hold("device_link_lost" if self._link is None else "not_enrolled", now)
        elif self._state == "connecting":
            if now - self._connect_started >= self.hc.connect_timeout_s + CONNECT_GRACE_S:
                self.transport.close(1000, "connect timeout")
                self.m.inc("hold_connect_attempts_total", 1, "timeout")
                self.log.warn("hold_connect_failed", kind="timeout", attempt=self._attempt + 1)
                self._schedule_retry(now)
        elif self._state == "idle" and want and now >= self._retry_at:
            self._connect(now)

    def _connect(self, now: float) -> None:
        self._state = "connecting"
        self._connect_started = now
        try:
            self._session = self.transport.connect()
        except TransportError as e:
            # No session was started (the token file cannot be read now). Retried on the backoff, never a crash.
            self.log.warn("hold_credential_unavailable", reason=str(e))
            self.m.inc("hold_connect_attempts_total", 1, "credential")
            self._schedule_retry(now)

    # ---- frames from the Backend -------------------------------------------------------

    def _ignored(self, reason: str) -> None:
        self.m.inc("hold_frames_ignored_total", 1, reason)

    def _on_frame(self, now: float, frame: str | bytes) -> None:
        if not isinstance(frame, str):
            self._ignored("binary")  # the protocol is JSON text frames only
            return
        try:
            obj = json.loads(frame)
        except (ValueError, RecursionError):
            self._ignored("invalid_json")
            return
        if not isinstance(obj, dict):
            self._ignored("not_object")
            return
        typ = obj.get("type")
        if not isinstance(typ, str):
            self._ignored("no_type")
        elif typ == "refused":
            reason = obj.get("reason")
            self._refused = reason if isinstance(reason, str) else "refused"
            if not self._retry_refusal(now, self._refused):
                self._stop_hold("refused", self._refused)  # never a takeover; retried only as section 2.5 allows
        elif typ == "iface_req":
            self._on_req(now, obj)
        elif typ == "iface_ack":
            self._on_ack(obj)
        elif typ == "dfu_job":
            self._on_dfu_job(now, obj)
        else:
            self._ignored("unknown_type")  # a Backend may send other types; they are ignored, never a close

    def _on_req(self, now: float, obj: dict) -> None:
        rid, wire = obj.get("id"), obj.get("wire")
        if not isinstance(rid, str) or not isinstance(wire, str):
            self._ignored("malformed_req")
            return
        self.m.inc("downlink_received_total")
        if not self._gate_open or self._dfu_blocks_relay():
            # Never held and never replayed: the Backend resends from its own sweeps.
            self.m.inc("downlink_closed_total")
            return
        try:
            data = wire.encode("utf-8")
        except UnicodeEncodeError:
            data = b""
        if not data or not REQ_ID_RE.match(rid):
            self.m.inc("downlink_dropped_total", 1, "invalid")
        elif len(data) > self._max_wire:
            self.m.inc("downlink_dropped_total", 1, "too_large")  # no failure message exists; the Backend resends
        elif self.cfg.device.mode == "console" and (b"\r" in data or b"\n" in data):
            self.m.inc("downlink_dropped_total", 1, "invalid")  # a line break would split one request into several lines
        elif (self._slot is not None and self._slot.kind == "relay" and self._slot.id == rid) or any(
            q.id == rid for q in self._queue
        ):
            self.m.inc("downlink_dropped_total", 1, "duplicate")  # the first one's result still goes
        elif len(self._queue) >= self.cfg.queues.downlink_max_messages:
            self.m.inc("downlink_dropped_total", 1, "queue_full")
        else:
            self._queue.append(_Req(rid, data, now))

    def _on_ack(self, obj: dict) -> None:
        outcome, of, ref = obj.get("outcome"), obj.get("of"), obj.get("ref")
        sent = self._pending_refs.pop(ref, None) if _is_int(ref) else None
        if not isinstance(outcome, str) or not isinstance(of, str):
            self.m.inc("hold_acks_total", 1, "malformed")
        elif sent is None or sent != of:
            self.m.inc("hold_acks_total", 1, "unmatched")
        elif outcome.startswith("refused"):
            # Nothing was recorded. The same bytes are never sent again.
            self.m.inc("hold_acks_total", 1, "refused")
            self.log.warn("hold_ack_refused", of=of, outcome=outcome)
        elif outcome == "duplicate":
            self.m.inc("hold_acks_total", 1, "duplicate")  # already received: success
        else:
            self.m.inc("hold_acks_total", 1, "accepted")

    # ---- uploads (device -> Backend) ---------------------------------------------------

    def _send(self, frame: dict) -> bool:
        try:
            self.transport.send(json.dumps(frame, separators=(",", ":")))
        except TransportError:
            return False
        return True

    def _upload(self, typ: str, kind: str, extra: dict) -> bool:
        if self._state != "connected":
            return False
        self._ref += 1
        if len(self._pending_refs) >= MAX_PENDING_REFS:
            self._pending_refs.pop(next(iter(self._pending_refs)))
        self._pending_refs[self._ref] = typ
        if not self._send({"type": typ, "ref": self._ref, **extra}):
            self._pending_refs.pop(self._ref, None)
            return False
        self.m.inc("hold_uploads_total", 1, kind)
        return True

    def _hello_paging_reset(self) -> None:
        self._hello_acc = None
        self._hello_cursor = None
        self._hello_pages = 0

    def _on_hello_page(self, res: dict) -> None:
        """One ok hello page. A hello without a `next` (the usual one) is kept exactly as the device gave it; a
        paged one is merged page by page (capabilities deduplicated, in order) and kept without `next`."""
        nxt = res.get("next")
        acc = self._hello_acc
        if acc is None:
            if nxt is None:
                self._hello = res
                self._hello_paging_reset()
                self._hello_done()
                return
            acc = {k: v for k, v in res.items() if k != "next"}
            caps = acc.get("capabilities")
            acc["capabilities"] = self._dedupe(caps) if isinstance(caps, list) else []
            self._hello_acc = acc
            self._hello_pages = 1
        else:
            caps = res.get("capabilities")
            if not isinstance(caps, list):
                self._finish_paging("malformed")
                return
            acc["capabilities"] = self._dedupe(acc["capabilities"] + caps)
            self._hello_pages += 1
        if nxt is None:
            self._finish_paging("")
        elif self._hello_pages >= MAX_HELLO_PAGES:
            self._finish_paging("page_cap")
        else:
            self._hello_cursor = nxt
            self.m.inc("hold_hello_pages_total")  # the next page is asked for by _device_step

    @staticmethod
    def _dedupe(items: list) -> list:
        seen: set[str] = set()
        out = []
        for it in items:
            k = json.dumps(it, sort_keys=True)
            if k not in seen:
                seen.add(k)
                out.append(it)
        return out

    def _finish_paging(self, why: str) -> bool:
        """Ends hello paging with what is merged. False when no paging was under way."""
        acc = self._hello_acc
        if acc is None:
            return False
        if why:
            self.log.warn("hello_paging_stopped", reason=why, pages=self._hello_pages)
        self._hello = acc
        self._hello_paging_reset()
        self._hello_done()
        return True

    def _hello_done(self) -> None:
        self._need_hello = False
        self._upload_hello()  # a fresh hello on an open hold (after a reboot) goes up at once

    def _upload_hello(self) -> None:
        if self._hello is not None and self._state == "connected" and self._dfu_phase != "resuming":
            self._upload("iface_hello", "hello", {"hello": self._hello})

    def _upload_text(self, payload: bytes, typ: str, kind: str, extra: dict) -> None:
        """One device message as one frame, its exact text. Dropped and counted if it cannot go."""
        if self._state != "connected":
            self.m.inc("upstream_dropped_total", 1, "socket_down")
            return
        try:
            text = payload.decode("utf-8")
        except UnicodeDecodeError:
            self.m.inc("upstream_dropped_total", 1, "invalid")
            return
        if not text or len(text) > MAX_UPLOAD_CHARS:
            self.m.inc("upstream_dropped_total", 1, "oversize")
            return
        if not self._upload(typ, kind, {**extra, "message": text}):
            self.m.inc("upstream_dropped_total", 1, "socket_down")

    # ---- device requests ---------------------------------------------------------------

    def _device_step(self, now: float) -> None:
        if self._link is None or self._stopped or self.hold_stop is not None:
            return
        s = self._slot
        if s is not None:
            if now < s.deadline:
                return
            self._slot_timeout(s, now)
        if self._need_hello and now >= self._next_hello:
            self._send_own("hello", now)
        elif now >= self._next_probe:
            self._send_own("gate", now)
        else:
            self._dispatch_relay(now)

    def _slot_timeout(self, s: _Slot, now: float) -> None:
        self._slot = None
        if s.kind == "relay":
            # Abandoned: nothing is sent to the Backend, the request is never written again, and the Backend
            # resends from its own sweeps.
            self.m.inc("hold_request_timeouts_total")
            self._abandoned.append(s.id)
        elif s.kind == "hello":
            self._late_own.append(s.id)
            self.m.inc("hold_hello_total", 1, "timeout")
            if not self._finish_paging("timeout"):
                self._next_hello = now + HELLO_RETRY_S
        else:
            self._late_own.append(s.id)
            self.m.inc("downlink_gate_probes_total", 1, "timeout")
            self._gate_result(False, "probe_failed", now)

    def _encode_for_device(self, message: bytes) -> bytes:
        if self.cfg.device.mode == "console":
            return encode_console_line(message)
        self._xid = (self._xid + 1) & 0xFF
        return b"".join(encode_serial_frame(f) for f in encode_mecon_frames(self._xid, message))

    def _write_request(self, message: bytes, now: float) -> bool:
        """Writes one request in the active framing; a console link gets its bare CR first, once per link."""
        assert self._link is not None
        try:
            if self.cfg.device.mode == "console" and not self._console_primed:
                # A bare CR ends whatever partial line the device's buffer holds, so stray bytes never turn
                # the first request into typed text.
                self._link.write(b"\r")
                self._console_primed = True
                self.m.inc("serial_bytes_out_total", 1)
            data = self._encode_for_device(message)
            self._link.write(data)
        except SerialGone:
            # Outcome unknown: the device may have seen all, part or none of it. Never retried.
            self.m.inc("downlink_write_failed_total")
            self._serial_lost(now)
            return False
        self.m.inc("serial_bytes_out_total", len(data))
        return True

    def _send_own(self, kind: str, now: float) -> None:
        if kind == "hello":
            self._hello_seq += 1
            rid = f"ch-{self._hello_seq}"
            op, timeout = "hello", self.hc.request_timeout_s
        else:
            self._probe_seq += 1
            rid = f"cg-{self._probe_seq}"
            op, timeout = "deployment.get", self.cfg.gate.timeout_s
        body: dict = {"v": 1, "id": rid, "op": op}
        if kind == "hello" and self._hello_acc is not None:
            body["args"] = {"cursor": self._hello_cursor}
        msg = json.dumps(body, separators=(",", ":")).encode()
        if self._write_request(msg, now):
            self._slot = _Slot(kind, rid, now + timeout)

    def _dispatch_relay(self, now: float) -> None:
        ttl = self.cfg.queues.downlink_ttl_s
        while self._queue:
            r = self._queue.popleft()
            if not self._gate_open:
                self.m.inc("downlink_closed_total")
            elif now - r.at > ttl:
                self.m.inc("downlink_dropped_total", 1, "ttl")
            else:
                # The bytes the Backend sent, unchanged. One request at a time: the slot stays taken until
                # the device answers or the wait ends.
                if self._write_request(r.wire, now):
                    self.m.inc("downlink_written_total")
                    self._slot = _Slot("relay", r.id, now + self.hc.request_timeout_s)
                return

    # ---- serial ------------------------------------------------------------------------

    def _serial_step(self, now: float) -> None:
        if self._stopped:
            return
        if self._link is None:
            if now >= self._next_open and self._dfu_phase not in ("waiting-bootloader", "transferring"):
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
        if hasattr(self.opener, "avoid"):
            # While a DFU waits on the bootloader, a port that also matches the bootloader's selector is not the
            # application's: it is refused before it is opened, so nothing is written to the bootloader.
            dc = self._dfu_cfg
            self.opener.avoid = dc.bootloader if dc is not None and self._dfu_phase in DFU_RECONNECT else None
        try:
            link = self.opener()
        except SelectorOverlap:
            if not self._dfu_overlap_noted:
                self._dfu_overlap_noted = True
                self.log.warn("dfu_selector_overlap", port="application")
            self._next_open = now + SERIAL_RETRY_S
            return
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
        self._console_primed = False
        self._epoch = None
        self._hello = None
        self._hello_paging_reset()
        self._need_hello = True
        self._next_hello = now
        self._gate_open = False
        self._gate_closed_for_good = False
        self._next_probe = now
        self.m.set("serial_connected", 1)
        self.log.info("serial_connected")
        self._dfu_app_returned(now)

    def _note_serial(self, what: str) -> None:
        if self._serial_note != what:
            self._serial_note = what
            self.log.warn("serial_" + what)

    def _serial_lost(self, now: float) -> None:
        if self._link is not None:
            self._link.close()
        self._link = None
        self._next_open = now + 0.5
        self._dfu_on_link_lost(now)
        # The hold is released with the link, so the Backend never routes to a dead one.
        self._close_hold("device_link_lost", now)
        self._close_gate("serial_lost", now)
        self._slot = None
        self._abandoned.clear()
        self._late_own.clear()
        self._hello = None  # the next device on this port may be a different one
        self._hello_paging_reset()
        lost = self._reset_readers()
        self.m.inc("serial_discarded_bytes_total", lost, "unplug")
        self.m.inc("serial_disconnects_total")
        self.m.set("serial_connected", 0)
        self.log.warn("serial_lost")

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

    def _close_gate(self, reason: str, now: float) -> None:
        """Closes relaying at once and asks the device again. Requests queued are refused and counted."""
        if self._gate_open:
            self._gate_open = False
            self.m.inc("downlink_gate_closes_total", 1, reason)
            self.log.warn("downlink_closed", reason=reason)
        n = len(self._queue)
        self._queue.clear()
        self.m.inc("downlink_closed_total", n)
        self._next_probe = now

    def _gate_result(self, provisioned: bool, reason: str, now: float) -> None:
        g = self.cfg.gate
        if provisioned:
            if not self._gate_open:
                self.log.info("downlink_open")
            self._gate_open = True
            self._gate_closed_for_good = False
            self._next_probe = now + g.recheck_s
        else:
            self._close_gate(reason, now)
            self._gate_closed_for_good = True  # an answer that says not enrolled releases the hold
            self._next_probe = now + g.retry_s

    # ---- messages from the device ------------------------------------------------------

    @staticmethod
    def _parse(payload: bytes) -> dict | None:
        try:
            obj = json.loads(payload)
        except (ValueError, RecursionError):
            return None
        return obj if isinstance(obj, dict) else None

    def _own_reply(self, obj: dict | None) -> str | None:
        """'hello' or 'gate' when this message answers the Connector's own request in flight (or one it gave up
        on), else None. Only the id is read, and only against the one request on the link."""
        if obj is None or "ev" in obj or not isinstance(obj.get("id"), str):
            return None
        rid = obj["id"]
        s = self._slot
        if s is not None and s.id == rid and s.kind in ("hello", "gate"):
            return s.kind
        if s is not None and s.kind == "relay" and s.id == rid:
            return None  # a relayed request with the same id as an own one: it is the Backend's
        if rid in self._late_own:
            return "late"
        return None

    def _on_device_message(self, payload: bytes, now: float) -> None:
        self.m.inc("upstream_envelopes_total")
        obj = self._parse(payload)
        own = self._own_reply(obj)
        if own is not None:
            assert obj is not None
            self._on_own_reply(own, obj, now)  # the Connector's own traffic: consumed, never uploaded
            return
        epoch = _epoch_of(obj) if obj is not None else None
        if epoch is not None:
            if self._epoch is not None and epoch != self._epoch:
                self._epoch = epoch
                self._need_hello = True  # rebooted: read hello again and tell the Backend
                self._hello_paging_reset()  # from the first page
                self._next_hello = now
                self._close_gate("epoch_changed", now)
            self._epoch = epoch
        if self._gate_open and (obj is None or "usig" not in obj):
            self._close_gate("unsigned_uplink", now)
        self._route_upload(payload, obj, now)

    def _route_upload(self, payload: bytes, obj: dict | None, now: float) -> None:
        if obj is None:
            self.m.inc("upstream_dropped_total", 1, "unroutable")
        elif "ev" in obj:
            name = obj["ev"]
            if isinstance(name, str) and STREAM_RE.match(name) and name != "result":
                self._upload_text(payload, "iface_event", "event", {"stream": name})
            else:
                self.m.inc("upstream_dropped_total", 1, "invalid_stream")
        elif isinstance(obj.get("id"), str):
            rid = obj["id"]
            s = self._slot
            if s is not None and s.kind == "relay" and (rid == s.id or rid == ""):
                # An empty id (the device could not read the request's) answers the one waiting.
                self._slot = None
                self._upload_text(payload, "iface_result", "result", {})
            elif rid in self._abandoned:
                self._abandoned.remove(rid)
                self._upload_text(payload, "iface_result", "result", {})  # late, but the device's own answer
            else:
                self.m.inc("upstream_dropped_total", 1, "unmatched")
        else:
            self.m.inc("upstream_dropped_total", 1, "unroutable")

    def _on_own_reply(self, kind: str, obj: dict, now: float) -> None:
        rid = obj["id"]
        if kind == "late":
            self._late_own.remove(rid)
            return
        self._slot = None
        epoch = _epoch_of(obj)
        if epoch is not None:
            self._epoch = epoch
        if kind == "hello":
            res = obj.get("result")
            if obj.get("status") == "ok" and isinstance(res, dict):
                self.m.inc("hold_hello_total", 1, "ok")
                self._on_hello_page(res)
            else:
                why = "refused" if obj.get("status") != "ok" else "malformed"
                self.m.inc("hold_hello_total", 1, why)
                if not self._finish_paging(why):
                    self._next_hello = now + HELLO_RETRY_S
            return
        res = obj.get("result")
        state = res.get("state") if isinstance(res, dict) else None
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

    # ---- bootloader DFU (contracts/connector-hold/v1, section 12) --------------------------------

    def _dfu_keeps_socket(self) -> bool:
        return self._dfu_phase in DFU_KEEPS

    def _dfu_blocks_relay(self) -> bool:
        """From the application port's drop until the resume, no request is written (as with a closed gate)."""
        return self._dfu_phase not in ("none", "armed")

    def _dfu_window_over(self, now: float) -> bool:
        assert self._dfu_cfg is not None
        return now - self._dfu_armed_at > self._dfu_cfg.arm_window_s

    def _on_dfu_job(self, now: float, obj: dict) -> None:
        if self._dfu_cfg is None:
            self._ignored("dfu_disabled")  # never declared serial_dfu: nothing is fetched and nothing is armed
            return
        job, sha, size = obj.get("job"), obj.get("sha256"), obj.get("size")
        if not (isinstance(job, str) and JOB_RE.match(job) and isinstance(sha, str) and SHA256_RE.match(sha)
                and _is_int(size) and size > 0):
            self._ignored("malformed_dfu_job")
            return
        phase = self._dfu_phase
        if phase in ("none", "armed") and self._link is None:
            self._ignored("dfu_no_device")
            self.log.warn("dfu_job_ignored", job=job, phase=phase, why="no_device")
        elif phase in ("none", "armed"):
            self._dfu_begin(now, job, sha, size, "armed")  # a newer job replaces one that is only armed
        elif phase == "failed" and self._dfu_job is not None and self._dfu_job["job"] == job:
            self._dfu_begin(now, job, sha, size, "waiting-bootloader")  # run again: the device is in its bootloader
        else:
            self._ignored("dfu_busy")
            self.log.warn("dfu_job_ignored", job=job, phase=phase)

    def _dfu_begin(self, now: float, job: str, sha: str, size: int, phase: str) -> None:
        assert self._dfu_cfg is not None
        self._dfu_gen += 1
        self._dfu_job = {"job": job, "sha256": sha, "size": size}
        self._dfu_armed_at = now
        self._dfu_pkg = None
        self._dfu_attempt = 0
        self._dfu_deadline = None
        self._dfu_next_look = now
        self._dfu_phase = phase
        self.log.info("dfu_armed" if phase == "armed" else "dfu_rerun", job=job)
        self._dfu_fetch_state = "running"
        self._dfu_state("fetching")
        if size > self._dfu_cfg.package_max_bytes:
            self._on_dfu_result(now, "fetch_failed", ("verify", "too-large"))  # never fetched
            return
        gen, fetch, events = self._dfu_gen, self._dfu_fetcher, self._events
        assert fetch is not None

        def work() -> None:
            try:
                data = fetch(job)
                verify_package(data, size, sha)  # before a byte of it is used
                events.append(("dfu", gen, "fetched", read_package(data)))
            except PackageError as e:
                events.append(("dfu", gen, "fetch_failed", (e.stage, e.error)))
            except Exception:  # noqa: BLE001  reported, never raised into the loop
                events.append(("dfu", gen, "fetch_failed", ("fetch", "internal")))

        self._runner(work)

    def _on_dfu_result(self, now: float, kind: str, payload: object) -> None:
        assert self._dfu_cfg is not None
        if kind == "fetched":
            assert isinstance(payload, Package)
            self._dfu_fetch_state = "ok"
            self._dfu_pkg = payload
            self.log.info("dfu_package_ok", job=self._dfu_job and self._dfu_job["job"], bytes=len(payload.image))
            # ready: fetched, checked and read. The Backend relays the offer only now, and the window starts now.
            self._dfu_armed_at = now
            self._dfu_state("ready")
            if self._dfu_phase == "waiting-bootloader":  # a run again: the device already waits in its bootloader
                self._dfu_deadline = now + self._dfu_cfg.bootloader_wait_s
                self._dfu_state("waiting-bootloader")
        elif kind == "fetch_failed":
            stage, error = payload  # type: ignore[misc]
            self._dfu_fetch_state = "failed"
            self._dfu_pkg = None
            self._dfu_state("failed", stage, error)
            if self._dfu_phase == "waiting-bootloader":
                self._dfu_set_failed(now)  # the device is not touched; it stays recoverable in its bootloader
            else:
                self._dfu_clear()  # never ready: the Backend does not offer, and the device stays up
        elif kind == "transfer":
            self._on_transfer_done(now, payload if isinstance(payload, str) else None)

    def _dfu_on_link_lost(self, now: float) -> None:
        """Called when the application port drops, before the hold would be released."""
        if self._dfu_phase == "armed" and self._dfu_fetch_state == "ok" and not self._dfu_window_over(now):
            assert self._dfu_cfg is not None
            self.log.info("dfu_device_reset", job=self._dfu_job and self._dfu_job["job"])
            self._dfu_phase = "waiting-bootloader"
            self._dfu_next_look = now
            self._dfu_deadline = None  # starts when the package is ready
            self._dfu_state("waiting-bootloader")
        elif self._dfu_phase == "armed":
            self._dfu_disarm("not_ready" if self._dfu_fetch_state != "ok" else "window_over")  # handled as unarmed
        elif self._dfu_phase == "resuming":
            assert self._dfu_cfg is not None
            self._dfu_phase = "rebooting"  # went again before the resume: wait for it as after a transfer
            self._dfu_deadline = now + self._dfu_cfg.app_return_wait_s

    def _dfu_app_returned(self, now: float) -> None:
        """The application port opened again."""
        if self._dfu_phase not in ("rebooting", "failed"):
            return
        assert self._dfu_cfg is not None
        if self._dfu_phase == "rebooting":
            self._dfu_state("installed-pending-hello")
        self._dfu_phase = "resuming"  # hello, gate, then iface_relay and iface_hello (_dfu_step)
        self._dfu_deadline = now + self._dfu_cfg.app_return_wait_s

    def _dfu_step(self, now: float) -> None:
        dc = self._dfu_cfg
        if dc is None or self._dfu_phase == "none":
            return
        ph = self._dfu_phase
        if ph == "armed":
            if self._dfu_fetch_state == "ok" and self._dfu_window_over(now):
                self._dfu_disarm("window_over")
        elif ph == "failed":
            if self._dfu_failed_cap_over(now):
                # Held long enough with no device and no new job: released as on any device link drop.
                self.log.warn("dfu_failed_released", job=self._dfu_job and self._dfu_job["job"])
                self._dfu_clear()
        elif ph == "waiting-bootloader":
            if self._dfu_pkg is None:
                return  # the fetch is still running; a failed one moves the phase on
            if self._dfu_deadline is None:
                self._dfu_deadline = now + dc.bootloader_wait_s
            if now >= self._dfu_deadline:
                self._dfu_fail("bootloader", "not-found")
            elif now >= self._dfu_next_look:
                self._dfu_look_for_bootloader(now)
        elif ph == "rebooting":
            if self._dfu_deadline is not None and now >= self._dfu_deadline:
                self._dfu_fail("app-return", "not-found")  # still waits for the port, without relaying
        elif ph == "resuming":
            if self._link is not None and self._hello is not None and self._gate_open:
                self._dfu_resume()
            elif self._gate_closed_for_good or (self._dfu_deadline is not None and now >= self._dfu_deadline):
                self.log.warn("dfu_resume_abandoned", job=self._dfu_job and self._dfu_job["job"])
                self._dfu_clear()  # the normal rules decide again (a device that is not enrolled releases the hold)

    def _dfu_look_for_bootloader(self, now: float) -> None:
        assert self._boot_opener is not None and self._dfu_pkg is not None
        self._dfu_next_look = now + BOOT_LOOK_S
        if hasattr(self._boot_opener, "avoid"):
            self._boot_opener.avoid = self.cfg.device.selector  # a port the device selector also takes is refused
        try:
            link = self._boot_opener()
        except SelectorOverlap:
            self.log.warn("dfu_selector_overlap", port="bootloader")
            self._dfu_fail("bootloader", "selector-overlap")  # never opened, never written
            return
        except SerialAmbiguous:
            if not self._dfu_ambiguous_noted:
                self._dfu_ambiguous_noted = True
                self.log.warn("dfu_bootloader_ambiguous")
            return
        except (SerialUnavailable, SerialGone):
            return
        self._dfu_ambiguous_noted = False
        self._dfu_attempt += 1
        self._dfu_phase = "transferring"
        self._dfu_state("transferring")
        gen, pkg, events, clock, sleep = self._dfu_gen, self._dfu_pkg, self._events, self.clock, self._sleep

        def work() -> None:
            err: str | None = None
            try:
                run_transfer(link, pkg, clock, sleep)
            except TransferError as e:
                err = str(e) or "transfer"
            except Exception:  # noqa: BLE001
                err = "internal"
            finally:
                link.close()
            events.append(("dfu", gen, "transfer", err if err is not None else ""))

        self._runner(work)

    def _on_transfer_done(self, now: float, err: str | None) -> None:
        dc = self._dfu_cfg
        assert dc is not None
        if not err:
            self.m.inc("hold_dfu_transfer_attempts_total", 1, "ok")
            self._dfu_pkg = None  # held only for the transfer
            self._dfu_phase = "rebooting"
            self._dfu_deadline = now + dc.app_return_wait_s
            self._dfu_state("rebooting")
            return
        self.m.inc("hold_dfu_transfer_attempts_total", 1, "failed")
        self.log.warn("dfu_transfer_failed", attempt=self._dfu_attempt, error=err)
        if self._dfu_attempt < dc.attempts:
            self._dfu_phase = "waiting-bootloader"  # the bootloader takes a fresh start
            self._dfu_deadline = now + dc.bootloader_wait_s
            self._dfu_next_look = now + BOOT_SETTLE_S
        else:
            self._dfu_fail("transfer", err)

    def _dfu_failed_cap_over(self, now: float) -> bool:
        assert self._dfu_cfg is not None
        return now - self._dfu_failed_at >= self._dfu_cfg.failed_hold_s

    def _dfu_set_failed(self, now: float) -> None:
        self._dfu_phase = "failed"
        self._dfu_failed_at = now

    def _dfu_fail(self, stage: str, error: str) -> None:
        self._dfu_set_failed(self.clock())
        self._dfu_pkg = None
        self._dfu_deadline = None
        self._dfu_state("failed", stage, error)

    def _dfu_resume(self) -> None:
        self.log.info("dfu_resumed", job=self._dfu_job and self._dfu_job["job"])
        self._dfu_clear()
        if self._state == "connected":
            if self._send(self._relay_frame()):
                self.m.inc("hold_relay_declared_total")
            self._upload_hello()

    def _dfu_disarm(self, why: str) -> None:
        self.log.info("dfu_disarmed", job=self._dfu_job and self._dfu_job["job"], why=why)
        self._dfu_clear()

    def _dfu_clear(self) -> None:
        self._dfu_gen += 1
        self._dfu_phase = "none"
        self._dfu_job = None
        self._dfu_pkg = None
        self._dfu_fetch_state = "idle"
        self._dfu_deadline = None
        self._dfu_attempt = 0
        self._dfu_last = None
        self._dfu_overlap_noted = False

    def _dfu_state(self, state: str, stage: str | None = None, error: str | None = None) -> None:
        """dfu_state to the Backend, which records it on the job. Not sent while the socket is down."""
        assert self._dfu_job is not None
        self.m.inc("hold_dfu_states_total", 1, state)
        frame: dict = {"type": "dfu_state", "job": self._dfu_job["job"], "state": state}
        if stage is not None:
            frame["stage"] = stage
            frame["error"] = error or "unknown"
        self.log.info("dfu_state", job=self._dfu_job["job"], state=state, stage=stage, error=error)
        self._dfu_last = frame
        if self._state == "connected":
            self._send(frame)

    # ---- observability -----------------------------------------------------------------

    def _update_gauges(self, now: float) -> None:
        m = self.m
        m.set("serial_connected", 1 if self._link is not None else 0)
        m.set("hold_connected", 1 if self._state == "connected" else 0)
        m.set("downlink_gate_open", 1 if self._gate_open else 0)
        m.set("hold_dfu_active", 1 if self._dfu_keeps_socket() else 0)
        m.set("uptime_seconds", now - self._started)

    def snapshot(self) -> dict:
        """What /healthz reports. A stopped hold says why, so the operator does not have to read the journal."""
        snap = {
            "transport": "hold",
            "serial": "up" if self._link is not None else "down",
            "hold": self._state,
            "downlink": "open" if self._gate_open else "closed",
            "ready": self._link is not None and self._state == "connected",
        }
        if self._dfu_phase != "none":
            snap["dfu"] = self._dfu_phase
        if self.hold_stop is not None:
            snap["hold_stop"] = self.hold_stop[0]
            snap["hold_stop_detail"] = self.hold_stop[1][:200]
        return snap
