#!/usr/bin/env python3
"""Mutation check for the transport-safety rules.

Each mutant breaks one rule in the source; the unit tests must then fail. The file is
restored afterwards whatever happens. Run from connector/:   python3 scripts/mutation.py

Needs the dev requirements (pytest). Integration tests are not run here; they need mosquitto.
"""
import os
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "src" / "mecon_connector"

MUTANTS = [
    ("a1", "payload modified in transit (upstream, trailing whitespace stripped)", "bridge.py",
     [("self._up.append(_Entry(payload, now, topic))", "self._up.append(_Entry(payload.rstrip(), now, topic))")]),
    ("a2", "payload modified in transit (downlink, stripped)", "bridge.py",
     [("self._down.append(_Entry(bytes(payload), now))", "self._down.append(_Entry(bytes(payload).strip(), now))")]),
    ("a3", "payload modified in transit (reassembly drops trailing NULs)", "framing.py",
     [('message = b"".join(self._slots[i] for i in range(self._count))',
       'message = b"".join(self._slots[i] for i in range(self._count)).rstrip(b"\\x00")')]),
    ("b1", "in-doubt publish re-queued after a broker reconnect", "bridge.py",
     [('        self.m.inc("upstream_uncertain_total", len(self._inflight))\n        self._inflight.clear()\n        i = self._active',
       '        self.m.inc("upstream_uncertain_total", len(self._inflight))\n        self._up.extendleft(reversed(list(self._inflight.values())))\n        self._inflight.clear()\n        i = self._active')]),
    ("b2", "last device command written again after a broker reconnect", "bridge.py",
     [("        self.m.inc(\"serial_bytes_out_total\", len(data))\n        self.m.inc(\"downlink_written_total\")",
       "        self.m.inc(\"serial_bytes_out_total\", len(data))\n        self.m.inc(\"downlink_written_total\")\n        self._last_cmd = message"),
      ('        self._last_connected = self._active\n',
       '        self._last_connected = self._active\n        if getattr(self, "_last_cmd", None) and self._link is not None:\n            self._write_down(self._last_cmd, now)\n')]),
    ("c1", "unbounded buffering on an oversize wrapper length", "framing.py",
     [("            elif length > MAX_FRAME_SIZE:", "            elif False:")]),
    ("c2", "unbounded buffering of a console line", "framing.py",
     [("            elif n > CONSOLE_MAX_LINE:", "            elif False:")]),
    ("d1", "duplicate publish when a completed message's frame is repeated", "framing.py",
     [("        if self._done == (xid, count):", "        if False:")]),
    ("d2", "completed message not remembered (a split frame can publish twice)", "framing.py",
     [("        self._done = (xid, count)\n        self._reset()", "        self._reset()")]),
    ("e1", "queue overflow drops silently (upstream, no metric)", "bridge.py",
     [('            self.m.inc("upstream_dropped_total", 1, "queue_full")\n            if now', '            pass\n            if now')]),
    ("e2", "TTL expiry drops silently (upstream)", "bridge.py",
     [('            self.m.inc("upstream_dropped_total", 1, "ttl")', "            pass")]),
    ("e3", "downlink queue overflow drops silently", "bridge.py",
     [('            self.m.inc("downlink_dropped_total", 1, "queue_full")', "            pass")]),
    ("f1", "retained downlink message accepted", "bridge.py",
     [("        if retain:\n", "        if False:\n")]),
    ("f2", "native companion frames forwarded", "bridge.py",
     [("                if frame[0] == CMD_MECON:", "                if True:")]),
    ("f3", "downlink written twice", "bridge.py",
     [("            self._link.write(data)\n        except SerialGone:", "            self._link.write(data)\n            self._link.write(data)\n        except SerialGone:")]),
    ("g1", "old MQTT client left running after its session (library may resend its queue)", "paho_transport.py",
     [("        c.loop_stop()", "        pass")]),
    ("g2", "callbacks from a dead session are accepted", "paho_transport.py",
     [("            if session == self._session:\n                self.callbacks.on_message(", "            if True:\n                self.callbacks.on_message(")]),
    ("i1", "gate opens on a device with no record (state none)", "bridge.py",
     [('        elif state in ("none", "corrupt"):', '        elif state == "provisioned" or state in ("none", "corrupt"):\n            self._gate_result(True, "", now)\n        elif state == "never":'),
      ]),
    ("i2", "gate opens on a corrupt record", "bridge.py",
     [('        elif state == "provisioned":\n            self.m.inc("downlink_gate_probes_total", 1, "provisioned")', '        elif state in ("provisioned", "corrupt"):\n            self.m.inc("downlink_gate_probes_total", 1, "provisioned")')]),
    ("j", "gate opens when the device does not answer", "bridge.py",
     [('                self._gate_result(False, "probe_failed", now)', '                self._gate_result(True, "", now)')]),
    ("k", "an unsigned uplink message does not close the gate", "bridge.py",
     [('        if self._gate_open and (obj is None or "usig" not in obj):', '        if False:')]),
    ("l", "no re-check after a reboot (new epoch)", "bridge.py",
     [('                self._close_gate("epoch_changed", now)  # rebooted: ask again before relaying anything', '                pass')]),
    ("m", "a refused downlink message is held and replayed when the gate reopens", "bridge.py",
     [('            self.m.inc("downlink_closed_total")\n        elif not payload:', '            self.m.inc("downlink_closed_total")\n            self._down.append(_Entry(bytes(payload), now))\n        elif not payload:'),
      ('                self._down.popleft()\n                self.m.inc("downlink_closed_total")\n                continue', '                break'),
      ('        self._down.clear()\n        self.m.inc("downlink_closed_total", n)', '        n = 0')]),
    ("n", "the device's answer to the Connector's own request is published upstream", "bridge.py",
     [('            self._on_probe_reply(obj, mid.group(0), now)  # type: ignore[arg-type]\n            return', '            self._on_probe_reply(obj, mid.group(0), now)  # type: ignore[arg-type]')]),
    ("o", "uplink altered while the gate and routing look at it (re-serialised JSON)", "bridge.py",
     [("        self._on_envelope(payload, now, route_topic(obj, c.topic_resp, c.topic_ev))",
       "        self._on_envelope(json.dumps(obj).encode() if obj is not None else payload, now, route_topic(obj, c.topic_resp, c.topic_ev))")]),
    ("p", "gate not closed when a broker session is re-established", "bridge.py",
     [('        self._close_gate("reconnect", now, abandon=False)', '        pass')]),
    ("q1", "unreadable password_file raises out of the config check (bare read)", "config.py",
     [('    try:\n        return Path(path).read_text(encoding="utf-8").rstrip("\\r\\n")\n    except (OSError, UnicodeDecodeError) as e:\n        raise ConfigError([f"cannot read password_file {path}: {type(e).__name__}"]) from e',
       '    return Path(path).read_text(encoding="utf-8").rstrip("\\r\\n")')]),
    ("q2", "unreadable password_file at reconnect escapes the transport and crashes the bridge", "paho_transport.py",
     [("            except ConfigError as e:\n                raise TransportError(e.problems[0]) from None", "            except ConfigError as e:\n                raise")]),
    ("q3", "startup does not check the password_file", "__main__.py",
     [("        notes = check_secrets(cfg, missing_ok=a.check_config)\n", "        notes = []\n")]),
    ("r1", "return to a better broker is break-before-make again (session ended without a probe)", "bridge.py",
     [("                self._start_probe(now, i)  # at most one probe per cool-down of the better broker", "                self._switch_now(now)")]),
    ("r2", "the probe uses the Connector's own client id (would take over the working session)", "paho_transport.py",
     [('self._new_client(self._client_id + "-probe", broker)', "self._new_client(self._client_id, broker)")]),
    ("r3", "a failed probe is not counted", "bridge.py",
     [('            self.m.inc("broker_connect_attempts_total", 1, "probe")\n', "")]),
    ("r4", "a failed probe does not grow the better broker's backoff", "bridge.py",
     [('            self._fails[i] += 1\n            self._cool[i] = now + self._delay(result.kind, self._fails[i])\n            self.m.inc("broker_connect_attempts_total", 1, "probe")',
       '            self.m.inc("broker_connect_attempts_total", 1, "probe")')]),
    ("r5", "no settle wait: the session ends as soon as the probe succeeds", "bridge.py",
     [("            if not self._inflight or now - self._settle_since >= SETTLE_S:", "            if True:")]),
    ("r6", "new upstream publishes are still taken while settling", "bridge.py",
     [('        if self._state != "connected" or self._settle_since is not None:', '        if self._state != "connected":')]),
    ("s1", "events are routed to the response topic (ev ignored)", "bridge.py",
     [('    if "ev" in obj:\n', '    if False:\n')]),
    ("s2", "an unsafe ev name becomes a topic level (wildcard, slash)", "bridge.py",
     [("if isinstance(name, str) and EVENT_NAME_RE.match(name):", "if isinstance(name, str) and name:")]),
    ("s3", "an unsafe ev falls back to the response topic", "bridge.py",
     [('            return f"{ev_topic}/{name}"\n        return None\n', '            return f"{ev_topic}/{name}"\n')]),
    ("s4", "a message with no route is published to the response topic", "bridge.py",
     [("        return resp_topic\n    return None", "        return resp_topic\n    return resp_topic")]),
    ("s5", "a boolean id counts as a response id", "bridge.py",
     [("isinstance(rid, int) and not isinstance(rid, bool)", "isinstance(rid, int)")]),
    ("s7", "an unroutable message is dropped without a count", "bridge.py",
     [('            self.m.inc("upstream_dropped_total", 1, "unroutable")\n', "")]),
    ("s8", "status says online while the serial port is down", "bridge.py",
     [("status_payload(online and self._link is not None), 0, True", "status_payload(online), 0, True")]),
    ("s9", "the last will says online", "bridge.py",
     [("will = Will(c.topic_status, status_payload(False), 0, True)", "will = Will(c.topic_status, status_payload(True), 0, True)")]),
    ("s10", "the Connector also subscribes to the response topic", "bridge.py",
     [("        subs = [(c.topic_req, 0)]", "        subs = [(c.topic_req, 0), (c.topic_resp, 0)]")]),
    ("s11", "a request arriving on another topic is accepted", "bridge.py",
     [("        if topic != self.cfg.mqtt.topic_req:\n            return", "        if False:\n            return")]),
    ("t1", "a raw kernel tty path is accepted as --port or select.path", "config.py",
     [("    elif RAW_TTY_RE.match(path):", "    elif False:")]),
    ("t2", "a path with '..' is accepted", "config.py",
     [('or ".." in path.split("/")', "")]),
    ("t3", "a path with a wildcard is accepted", "config.py",
     [('or re.search(r"[\\s*?\\[\\]]", path):', ":")]),
    ("t4", "two selector kinds are accepted together", "config.py",
     [("    elif n > 1:\n", "    elif False:\n")]),
    ("t5", "a regular file is opened as the port", "serial_link.py",
     [("    if not stat.S_ISCHR(mode):", "    if False:")]),
    ("t6", "--port is not validated", "__main__.py",
     [('    problems = check_path(port, "--port")', "    problems = []")]),
    ("t7", "--port does not replace the configured selector", "__main__.py",
     [("selector=Selector(path=port)", "selector=cfg.device.selector")]),
    ("u1", "the stand-in builds any request (no allowlist)", "../../scripts/c3_standin.py",
     [("    if op not in READ_ONLY_REQUESTS:", "    if False:")]),
    ("u2", "the stand-in gains a non-read request", "../../scripts/c3_standin.py",
     [('    "deployment.get": "c3-dg-1",\n', '    "deployment.get": "c3-dg-1",\n    "device.reboot": "c3-x-1",\n')]),
    ("u3", "the stand-in uses the Connector's reserved id prefix", "../../scripts/c3_standin.py",
     [('"hello": "c3-hello-1"', '"hello": "cg-77"')]),
    ("u4", "the stand-in publishes retained", "../../scripts/c3_standin.py",
     [("qos=0, retain=False)", "qos=0, retain=True)")]),
    ("u5", "the observer echoes any id, not just the stand-in's", "../../scripts/c3_observer.py",
     [('if isinstance(rid, str) and rid.startswith(OUR_ID_PREFIX):', "if isinstance(rid, str):")]),
    ("u6", "the observer echoes any op", "../../scripts/c3_observer.py",
     [('rec["op"] = op if op in READ_OPS else "other"', 'rec["op"] = op')]),
    ("u7", "the observer accepts an unsigned event", "../../scripts/c3_observer.py",
     [('"usig": bool(obj is not None and "usig" in obj),', '"usig": True,')]),
    ("f4", "command held across an unplug and written after replug", "bridge.py",
     [("            if self._link is None:\n                # A command is never held", "            if self._link is None and False:\n                # A command is never held"),
      ('        self._close_gate("serial_lost", now)\n', "")]),
]

# Mutants of the WebSocket hold transport (hold.py, hold_transport.py, the hold config and exit status). They can
# only change what the hold tests cover, so each runs just those files.
HOLD_TESTS = ["tests/test_hold.py", "tests/test_hold_main.py", "tests/test_hold_contract_fixtures.py", "tests/test_hold_tls.py"]
HOLD_MUTANTS = [
    ("h1", "the wire is re-serialised before it reaches the device", "hold.py",
     [("if self._write_request(r.wire, now):", "if self._write_request(json.dumps(json.loads(r.wire)).encode(), now):")]),
    ("h1b", "the wire is stripped before it reaches the device", "hold.py",
     [("if self._write_request(r.wire, now):", "if self._write_request(r.wire.strip(), now):")]),
    ("h2", "no iface_relay after a reconnect", "hold.py",
     [('        if self._send({"type": "iface_relay"}):\n', '        if self.m.get("hold_connect_attempts_total", "ok") <= 1 and self._send({"type": "iface_relay"}):\n')]),
    ("h3", "the agent reconnects after refused", "hold.py",
     [('            self._stop_hold("refused", self._refused)  # never a takeover, never a retry', "            pass"),
      ("        if self._refused is not None:\n            self._end_session()", "        if False:\n            self._end_session()"),
      ("        elif code == 1008:", "        elif code == 1008 and self._refused is None:")]),
    ("h4", "a rejected token (close 1008, or a 401/403 handshake) is retried", "hold.py",
     [('        if kind == "bad_token":\n            self._stop_hold', '        if False:\n            self._stop_hold'),
      ("        elif code == 1008:", "        elif False:")]),
    ("h5", "the token appears in a log line", "hold_transport.py",
     [("        threading.Thread(target=self._run, args=(session, token)", '        __import__("sys").stderr.write("hold connect with " + token + "\\n")\n        threading.Thread(target=self._run, args=(session, token)')]),
    ("h6", "the Connector's own probe answer is uploaded", "hold.py",
     [("never uploaded\n            return", 'never uploaded\n            self._upload_text(payload, "iface_result", "result", {})\n            return')]),
    ("h7", "a second request is sent before the first is answered", "hold.py",
     [("            if now < s.deadline:\n                return", "            if now < s.deadline:\n                self._dispatch_relay(now)\n                return")]),
    ("h8", "a request is never abandoned (no device wait)", "hold.py",
     [('self._slot = _Slot("relay", r.id, now + self.hc.request_timeout_s)', 'self._slot = _Slot("relay", r.id, now + 1e9)')]),
    ("h9", "a duplicate id in flight is not ignored", "hold.py",
     [("        elif (self._slot is not None and self._slot.kind == \"relay\" and self._slot.id == rid) or any(\n            q.id == rid for q in self._queue\n        ):", "        elif False:")]),
    ("h10", "a refused acknowledgement makes the agent send the same frame again", "hold.py",
     [('        if not self._send({"type": typ, "ref": self._ref, **extra}):', '        self._last = {"type": typ, "ref": self._ref, **extra}\n        if not self._send({"type": typ, "ref": self._ref, **extra}):'),
      ('self.log.warn("hold_ack_refused", of=of, outcome=outcome)', 'self.log.warn("hold_ack_refused", of=of, outcome=outcome)\n            self._send(self._last)')]),
    ("h11", "a duplicate acknowledgement is not told from an accepted one", "hold.py",
     [('        elif outcome == "duplicate":', "        elif False:")]),
    ("h12", "an event whose stream is `result` is forwarded", "hold.py",
     [('STREAM_RE.match(name) and name != "result":', "STREAM_RE.match(name):")]),
    ("h12b", "any event name is forwarded as a stream", "hold.py",
     [('isinstance(name, str) and STREAM_RE.match(name) and name != "result":', 'isinstance(name, str) and name != "result":')]),
    ("h13", "the socket stays open when the device link drops", "hold.py",
     [('        self._close_hold("device_link_lost")\n        self._close_gate("serial_lost", now)', '        self._close_gate("serial_lost", now)'),
      ("            if not keep:\n                self._close_hold", "            if False:\n                self._close_hold")]),
    ("h14", "the socket opens without a device link, a hello or an open gate", "hold.py",
     [("        want = keep and self._gate_open", "        want = True")]),
    ("h15", "the hold is closed with a code other than 1000 on stop", "hold.py",
     [('        self._stopped = True\n        self.transport.close(1000, "stopped")', '        self._stopped = True\n        self.transport.close(1001, "stopped")')]),
    ("h16", "the console's bare CR is written before every request", "hold.py",
     [('if self.cfg.device.mode == "console" and not self._console_primed:', 'if self.cfg.device.mode == "console":')]),
    ("h16b", "the console's bare CR is never written", "hold.py",
     [('if self.cfg.device.mode == "console" and not self._console_primed:', 'if False:')]),
    ("h17", "a console wire with CR or LF is written", "hold.py",
     [('elif self.cfg.device.mode == "console" and (b"\\r" in data or b"\\n" in data):', "elif False:")]),
    ("h18", "an over-long wire is written", "hold.py",
     [("        elif len(data) > self._max_wire:", "        elif False:")]),
    ("h19", "an unsigned uplink message does not close the gate", "hold.py",
     [('        if self._gate_open and (obj is None or "usig" not in obj):', "        if False:")]),
    ("h20", "the gate opens on a device with no record", "hold.py",
     [('        elif state == "provisioned":\n            self.m.inc("downlink_gate_probes_total", 1, "provisioned")', '        elif state in ("provisioned", "none"):\n            self.m.inc("downlink_gate_probes_total", 1, "provisioned")')]),
    ("h21", "the gate opens when the device does not answer", "hold.py",
     [('            self._gate_result(False, "probe_failed", now)', '            self._gate_result(True, "", now)')]),
    ("h22", "the token is sent in the URL query", "hold_transport.py",
     [("                c.ws_url,\n", '                c.ws_url + "?access_token=" + kw.get("additional_headers", {}).get("Authorization", "x x").split(" ")[1],\n')]),
    ("h23", "the subprotocol form leaves out mecon-bridge", "hold_transport.py",
     [('kw["subprotocols"] = [SUBPROTOCOL, f"bearer.{token}"]', 'kw["subprotocols"] = [f"bearer.{token}"]')]),
    ("h24", "a world-readable token file is accepted", "config.py",
     [("if os.stat(path).st_mode & 0o004:", "if os.stat(path).st_mode & 0o000:")]),
    ("h25", "a stopped hold exits 0", "__main__.py",
     [("        return EXIT_HOLD_STOPPED", "        return 0")]),
    ("h26", "systemd restarts a hold that was refused (exit status 3)", "../../deploy/systemd/mecon-connector.service",
     [("RestartPreventExitStatus=2 3", "RestartPreventExitStatus=2")]),
    ("h27", "an uploaded text is re-serialised", "hold.py",
     [('            text = payload.decode("utf-8")', '            text = json.dumps(json.loads(payload.decode("utf-8")))')]),
    ("h28", "iface_hello is not sent after the relay", "hold.py",
     [("        self._upload_hello()\n\n    def _on_failed", "\n    def _on_failed")]),
    ("h29", "an unknown frame type closes the socket", "hold.py",
     [('            self._ignored("unknown_type")  # a Backend may send other types; they are ignored, never a close', '            self._ignored("unknown_type")\n            self.transport.close(1000, "x")')]),
    ("h30", "the backoff is not 1, 2, 4, 8, 15", "hold.py",
     [("BACKOFF_S = (1.0, 2.0, 4.0, 8.0, 15.0)", "BACKOFF_S = (1.0, 2.0, 4.0, 8.0, 16.0)")]),
    ("h31", "the backoff counter is not reset when a socket opens", "hold.py",
     [("        self._attempt = 0\n        self._refused = None", "        self._refused = None")]),
    ("h32", "an event is dropped without a count when the hold is down", "hold.py",
     [('            self.m.inc("upstream_dropped_total", 1, "socket_down")\n            return\n        try:', "            return\n        try:")]),
    ("h33", "the Backend's refusal text is not shown to the operator", "hold.py",
     [('            self._refused = reason if isinstance(reason, str) else "refused"', '            self._refused = "refused"')]),
    ("h34", "a late answer to a request that was not asked is uploaded", "hold.py",
     [('            else:\n                self.m.inc("upstream_dropped_total", 1, "unmatched")', '            else:\n                self._upload_text(payload, "iface_result", "result", {})')]),
]


def run_tests(files=None):
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    args = list(files) if files else ["--deselect", "tests/test_integration_mosquitto.py"]
    p = subprocess.run([sys.executable, "-m", "pytest", "-q", "-x", "-p", "no:cacheprovider", *args],
                       cwd=ROOT, capture_output=True, text=True, env=env)
    return p.returncode, p.stdout + p.stderr


def main():
    rc, out = run_tests()
    if rc != 0:
        print("baseline fails; fix the tests first\n" + out[-2000:])
        return 2
    survivors = []
    only = set(sys.argv[1:])  # optional: run only these mutant ids, for example `h3 h5`
    todo = [(m, None) for m in MUTANTS] + [(m, HOLD_TESTS) for m in HOLD_MUTANTS]
    if only:
        todo = [(m, f) for m, f in todo if m[0] in only]
    for (mid, desc, fname, edits), files in todo:
        path = SRC / fname
        original = path.read_text()
        try:
            text = original
            for old, new in edits:
                if text.count(old) != 1:
                    print(f"{mid}: pattern not found exactly once ({text.count(old)}): {old[:60]!r}")
                    survivors.append(mid)
                    break
                text = text.replace(old, new)
            else:
                path.write_text(text)
                rc, out = run_tests(files)
                failed = [ln for ln in out.splitlines() if ln.startswith("FAILED")]
                if rc == 0:
                    survivors.append(mid)
                    print(f"{mid}: SURVIVED  {desc}")
                else:
                    first = failed[0].split(" - ")[0] if failed else "(collection or crash)"
                    print(f"{mid}: killed    {desc}\n        by {first}")
        finally:
            path.write_text(original)
    rc, _ = run_tests()
    print("restored; baseline " + ("passes" if rc == 0 else "FAILS"))
    total = len(todo)
    print(f"{total - len(survivors)} of {total} mutants killed ({len(MUTANTS)} transport and packaging, {len(HOLD_MUTANTS)} hold)")
    return 1 if survivors or rc != 0 else 0


if __name__ == "__main__":
    sys.exit(main())
