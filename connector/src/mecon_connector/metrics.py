"""Metrics registry. Names are fixed by contracts/connector/v1/mapping.json;
an unknown name or label raises, so a typo cannot create a silent metric."""

from __future__ import annotations

import threading

PREFIX = "mecon_connector_"

# name -> (type, help, label names)
REGISTRY: dict[str, tuple[str, str, tuple[str, ...]]] = {
    "serial_connected": ("gauge", "1 when the serial port is open", ()),
    "broker_connected": ("gauge", "1 when a broker session is established", ()),
    "broker_active_index": ("gauge", "Index in the broker list of the active session, -1 when none", ()),
    "upstream_queue_depth": ("gauge", "Envelopes waiting to be published", ()),
    "upstream_queue_bytes": ("gauge", "Bytes waiting to be published", ()),
    "upstream_inflight": ("gauge", "Publishes sent and not yet acknowledged", ()),
    "downlink_queue_depth": ("gauge", "Broker messages waiting to be written to the serial port", ()),
    "uptime_seconds": ("gauge", "Seconds since the process started", ()),
    "serial_bytes_in_total": ("counter", "Bytes read from the serial port", ()),
    "serial_bytes_out_total": ("counter", "Bytes written to the serial port", ()),
    "serial_frames_total": ("counter", "Complete serial units classified", ("kind",)),
    "serial_discarded_bytes_total": ("counter", "Serial bytes skipped or discarded without forwarding", ("reason",)),
    "serial_anomalies_total": ("counter", "Malformed or unexpected serial units refused", ("kind",)),
    "serial_stall_resets_total": ("counter", "Partial frames dropped after a stall", ()),
    "serial_reconnects_total": ("counter", "Times the serial port was opened after the first", ()),
    "serial_disconnects_total": ("counter", "Times the serial port was lost", ()),
    "upstream_envelopes_total": ("counter", "Complete device envelopes taken from the serial port", ()),
    "upstream_published_total": ("counter", "Envelopes handed to the broker connection", ()),
    "upstream_acked_total": ("counter", "Publishes the broker acknowledged (QoS 1)", ()),
    "upstream_uncertain_total": ("counter", "Publishes whose outcome is unknown; never retried", ()),
    "upstream_dropped_total": ("counter", "Envelopes dropped before publishing", ("reason",)),
    "downlink_gate_open": ("gauge", "1 while downlink is open (the device reported an enrolled record)", ()),
    "downlink_closed_total": ("counter", "Downlink messages refused because the gate was closed; never held", ()),
    "downlink_gate_closes_total": ("counter", "Times an open gate was closed", ("reason",)),
    "downlink_gate_probes_total": ("counter", "Outcomes of the Connector's own deployment.get requests", ("result",)),
    "downlink_received_total": ("counter", "Messages received on the downlink topic", ()),
    "downlink_written_total": ("counter", "Messages written to the serial port", ()),
    "downlink_dropped_total": ("counter", "Downlink messages dropped before writing", ("reason",)),
    "downlink_write_failed_total": ("counter", "Serial writes that failed; outcome unknown, never retried", ()),
    "broker_connect_attempts_total": ("counter", "Broker connection attempts; result=probe counts a failed probe of a better broker", ("result",)),
    "broker_disconnects_total": ("counter", "Established broker sessions that ended", ()),
    "broker_failovers_total": ("counter", "Switches to a different broker profile", ()),
}

REASONS = {
    "serial_discarded_bytes_total": {"garbage", "stall", "native", "unplug"},
    "upstream_dropped_total": {"queue_full", "ttl", "oversize", "shutdown", "unroutable"},
    "downlink_dropped_total": {"queue_full", "ttl", "serial_down", "retained", "invalid", "too_large", "shutdown"},
    "downlink_gate_closes_total": {
        "unsigned_uplink", "not_provisioned", "probe_failed", "epoch_changed", "serial_lost", "reconnect",
    },
    "downlink_gate_probes_total": {"provisioned", "none", "corrupt", "malformed", "refused", "timeout", "late"},
    "serial_frames_total": {"native", "mecon_frame", "console_line"},
    "serial_anomalies_total": {
        "oversize_length", "empty_frame", "malformed_frame", "duplicate_frame",
        "incomplete_discarded", "oversize_message", "console_oversize_line",
    },
    "broker_connect_attempts_total": {"ok", "network", "tls", "auth", "refused", "timeout", "probe"},
}
_LABEL_KEY = {
    "serial_discarded_bytes_total": "reason",
    "upstream_dropped_total": "reason",
    "downlink_dropped_total": "reason",
    "serial_frames_total": "kind",
    "downlink_gate_closes_total": "reason",
    "downlink_gate_probes_total": "result",
    "serial_anomalies_total": "kind",
    "broker_connect_attempts_total": "result",
}


# The hold transport (contracts/connector-hold/v1) reuses the serial and gate metrics above and adds its
# own. They are described in connector/README.md, not in the MQTT contract's mapping.json.
HOLD_SHARED = (
    "serial_connected", "serial_bytes_in_total", "serial_bytes_out_total", "serial_frames_total",
    "serial_discarded_bytes_total", "serial_anomalies_total", "serial_stall_resets_total",
    "serial_reconnects_total", "serial_disconnects_total", "upstream_envelopes_total", "upstream_dropped_total",
    "uptime_seconds", "downlink_gate_open", "downlink_closed_total", "downlink_gate_closes_total",
    "downlink_gate_probes_total", "downlink_received_total", "downlink_written_total", "downlink_dropped_total",
    "downlink_write_failed_total",
)
HOLD_REGISTRY: dict[str, tuple[str, str, tuple[str, ...]]] = {
    "hold_connected": ("gauge", "1 while the WebSocket hold is open", ()),
    "hold_stopped": ("gauge", "1 once the hold was stopped for good (refused, or a rejected token)", ()),
    "hold_connect_attempts_total": ("counter", "Hold connection attempts by outcome", ("result",)),
    "hold_disconnects_total": ("counter", "Open holds that ended", ()),
    "hold_relay_declared_total": ("counter", "iface_relay frames sent (one per connection)", ()),
    "hold_uploads_total": ("counter", "Frames uploaded on the hold, by kind", ("kind",)),
    "hold_acks_total": ("counter", "iface_ack frames by outcome class", ("outcome",)),
    "hold_uploads_uncertain_total": ("counter", "Uploads whose session ended before their ack; never resent", ()),
    "hold_request_timeouts_total": ("counter", "Relayed requests abandoned after the device wait; never resent", ()),
    "hold_frames_ignored_total": ("counter", "Backend frames ignored, by reason", ("reason",)),
    "hold_hello_total": ("counter", "The Connector's own hello requests by outcome", ("result",)),
    "hold_hello_pages_total": ("counter", "Extra hello pages the Connector asked for after the first (cursor requests)", ()),
    "hold_dfu_active": ("gauge", "1 while a bootloader DFU keeps the hold without a device link (section 12 of the hold contract)", ()),
    "hold_dfu_states_total": ("counter", "dfu_state values the Connector reached, by state", ("state",)),
    "hold_dfu_transfer_attempts_total": ("counter", "Bootloader transfer attempts by outcome", ("result",)),
}
HOLD_REASONS = {
    **{k: set(v) for k, v in REASONS.items()},
    "upstream_dropped_total": {"socket_down", "invalid_stream", "invalid", "oversize", "unroutable", "unmatched", "shutdown"},
    "downlink_dropped_total": {"queue_full", "ttl", "serial_down", "invalid", "too_large", "duplicate", "socket_down", "shutdown"},
    "hold_connect_attempts_total": {"ok", "network", "tls", "http", "bad_token", "credential", "timeout"},
    "hold_uploads_total": {"hello", "result", "event"},
    "hold_acks_total": {"accepted", "duplicate", "refused", "unmatched", "malformed"},
    "hold_frames_ignored_total": {"invalid_json", "not_object", "no_type", "unknown_type", "binary", "malformed_req",
                                  "malformed_dfu_job", "dfu_disabled", "dfu_busy", "dfu_no_device"},
    "hold_hello_total": {"ok", "refused", "malformed", "timeout"},
    "hold_dfu_states_total": {"fetching", "ready", "waiting-bootloader", "transferring", "rebooting", "installed-pending-hello",
                              "failed"},
    "hold_dfu_transfer_attempts_total": {"ok", "failed"},
}
_HOLD_LABEL_KEY = {"hold_connect_attempts_total": "result", "hold_uploads_total": "kind", "hold_acks_total": "outcome",
                   "hold_frames_ignored_total": "reason", "hold_hello_total": "result", "hold_dfu_states_total": "state",
                   "hold_dfu_transfer_attempts_total": "result"}


class Metrics:
    def __init__(self, hold: bool = False) -> None:
        self._lock = threading.Lock()
        self._v: dict[tuple[str, tuple[str, ...]], float] = {}
        if hold:
            self._reg = {n: REGISTRY[n] for n in HOLD_SHARED} | HOLD_REGISTRY
            self._reasons = HOLD_REASONS
            self._label_key = _LABEL_KEY | _HOLD_LABEL_KEY
        else:
            self._reg, self._reasons, self._label_key = REGISTRY, REASONS, _LABEL_KEY
        for name, (_, _, labels) in self._reg.items():
            if not labels:
                self._v[(name, ())] = 0
            else:
                for r in sorted(self._reasons[name]):
                    self._v[(name, (r,))] = 0

    def _key(self, name: str, label: str | None) -> tuple[str, tuple[str, ...]]:
        if name not in self._reg:
            raise KeyError(f"unknown metric {name}")
        labels = self._reg[name][2]
        if bool(labels) != (label is not None):
            raise KeyError(f"metric {name} label mismatch")
        if label is not None and label not in self._reasons[name]:
            raise KeyError(f"metric {name} unknown label value {label}")
        return (name, (label,) if label is not None else ())

    def inc(self, name: str, n: float = 1, label: str | None = None) -> None:
        if n == 0:
            return
        with self._lock:
            self._v[self._key(name, label)] += n

    def set(self, name: str, value: float) -> None:
        with self._lock:
            self._v[self._key(name, None)] = value

    def get(self, name: str, label: str | None = None) -> float:
        with self._lock:
            return self._v[self._key(name, label)]

    def total(self, name: str) -> float:
        with self._lock:
            return sum(v for (n, _), v in self._v.items() if n == name)

    def render(self) -> str:
        with self._lock:
            lines: list[str] = []
            for name, (typ, help_, labels) in self._reg.items():
                full = PREFIX + name
                lines.append(f"# HELP {full} {help_}")
                lines.append(f"# TYPE {full} {typ}")
                for (n, lv), v in sorted(self._v.items()):
                    if n != name:
                        continue
                    lab = f'{{{self._label_key[name]}="{lv[0]}"}}' if labels else ""
                    lines.append(f"{full}{lab} {v:g}")
            return "\n".join(lines) + "\n"
