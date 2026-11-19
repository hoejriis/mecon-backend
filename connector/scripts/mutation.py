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
     [("self._up.append(_Entry(payload, now))", "self._up.append(_Entry(payload.rstrip(), now))")]),
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
     [("            c.loop_stop()", "            pass")]),
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
    ("o", "uplink altered while the gate looks at it (re-serialised JSON)", "bridge.py",
     [('        self._on_envelope(payload, now)\n\n    def _on_probe_reply', '        self._on_envelope(json.dumps(obj).encode() if obj is not None else payload, now)\n\n    def _on_probe_reply')]),
    ("p", "gate not closed when a broker session is re-established", "bridge.py",
     [('        self._close_gate("reconnect", now, abandon=False)', '        pass')]),
    ("q1", "unreadable password_file raises out of the config check (bare read)", "config.py",
     [('    try:\n        return Path(path).read_text(encoding="utf-8").rstrip("\\r\\n")\n    except (OSError, UnicodeDecodeError) as e:\n        raise ConfigError([f"cannot read password_file {path}: {type(e).__name__}"]) from e',
       '    return Path(path).read_text(encoding="utf-8").rstrip("\\r\\n")')]),
    ("q2", "unreadable password_file at reconnect escapes the transport and crashes the bridge", "paho_transport.py",
     [("            except ConfigError as e:\n                raise TransportError(e.problems[0]) from None", "            except ConfigError as e:\n                raise")]),
    ("q3", "startup does not check the password_file", "__main__.py",
     [("        notes = check_secrets(cfg, missing_ok=a.check_config)\n", "        notes = []\n")]),
    ("f4", "command held across an unplug and written after replug", "bridge.py",
     [("            if self._link is None:\n                # A command is never held", "            if self._link is None and False:\n                # A command is never held"),
      ('        self._close_gate("serial_lost", now)\n', "")]),
]


def run_tests():
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    p = subprocess.run([sys.executable, "-m", "pytest", "-q", "-x", "-p", "no:cacheprovider", "--deselect",
                        "tests/test_integration_mosquitto.py"], cwd=ROOT, capture_output=True, text=True, env=env)
    return p.returncode, p.stdout + p.stderr


def main():
    rc, out = run_tests()
    if rc != 0:
        print("baseline fails; fix the tests first\n" + out[-2000:])
        return 2
    survivors = []
    for mid, desc, fname, edits in MUTANTS:
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
                rc, out = run_tests()
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
    print(f"{len(MUTANTS) - len(survivors)} of {len(MUTANTS)} mutants killed")
    return 1 if survivors or rc != 0 else 0


if __name__ == "__main__":
    sys.exit(main())
