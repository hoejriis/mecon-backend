#!/usr/bin/env python3
"""Mutation check for the capture safety rules.

Each mutant breaks one rule in the source; the unit tests must then fail. A control run of the
unmutated tree comes first and must pass, so a failure is never a broken invocation. For every mutant
the file is compared with its backup to prove the edit changed it, and it is restored afterwards (and
compared again) whatever happens. Run from capture/:   python3 scripts/mutation.py [mutant ids...]

Needs the dev requirements (pytest, jsonschema). Integration tests are not run here; they need mosquitto.
"""
import filecmp
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "src" / "mecon_capture"

MUTANTS = [
    # ---- receive only ----
    ("p1", "a publish call in a transport callback", "paho_transport.py",
     [("            self.callbacks.on_connack(int(rc.value))", '            self.callbacks.on_connack(int(rc.value))\n            cl.publish("x/ack", b"1")')]),
    ("p2", "a publish method exposed on the transport", "paho_transport.py",
     [("    def disconnect(self) -> None:\n        c, self._client", '    def publish(self, topic: str, payload: bytes) -> None:\n        self._client.publish(topic, payload)\n\n    def disconnect(self) -> None:\n        c, self._client')]),
    ("p3", "a publish method on the transport seam", "transport.py",
     [("    def disconnect(self) -> None:\n        \"\"\"Stop receiving", '    def publish(self, topic: str, payload: bytes) -> None: ...\n\n    def disconnect(self) -> None:\n        """Stop receiving')]),
    ("w1", "the subscription asks for QoS 1", "ingester.py",
     [("self.transport.subscribe(topic, 0)", "self.transport.subscribe(topic, 1)")]),
    ("w2", "no re-subscribe after a reconnect (only the first connect subscribes)", "ingester.py",
     [('        with self._lock:\n            self._state, self._last_error = "connected", None',
       '        first_connect = self._last_connected_at is None\n        with self._lock:\n            self._state, self._last_error = "connected", None'),
      ("        for topic in self.profile.topics:\n            try:\n                self.transport.subscribe",
       "        for topic in (self.profile.topics if first_connect else ()):\n            try:\n                self.transport.subscribe")]),
    ("w3", "a persistent session is requested", "paho_transport.py",
     [('"clean_session": True}', '"clean_session": False}')]),
    ("w4", "certificate verification off", "paho_transport.py",
     [("            ctx.verify_mode = ssl.CERT_REQUIRED", "            ctx.verify_mode = ssl.CERT_NONE")]),
    ("w5", "a profile may turn certificate verification off", "config.py",
     [('            if tls.get("verify") is not True:', "            if False:")]),
    ("w6", "reconnect backoff is not capped at about two minutes", "paho_transport.py",
     [("BACKOFF_MAX_S = 120", "BACKOFF_MAX_S = 3600")]),
    ("w7", "last_connected_at moves on a refused connect", "ingester.py",
     [('            self._set("error", reason)\n            self._log.warn("connack_refused"',
       '            self._last_connected_at = iso_ms(self._clock())\n            self._set("error", reason)\n            self._log.warn("connack_refused"')]),
    ("w8", "the retained flag is lost in the transport", "paho_transport.py",
     [("bytes(msg.payload), bool(msg.retain))", "bytes(msg.payload), False)")]),
    ("w9", "the payload is altered on its way into a capture", "ingester.py",
     [('base64.b64encode(payload).decode("ascii")', 'base64.b64encode(payload.rstrip()).decode("ascii")')]),
    # ---- capture ----
    ("c1", "received_at stamped when the row is written, not at arrival", "archive.py",
     [('int(c["retained"]), c["received_at"],', 'int(c["retained"]), time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),')]),
    ("c2", "an oversized payload is stored instead of a stub", "archive.py",
     [("None if stub else payload,", "payload,"), ("int(stub), int(c", "0, int(c")]),
    ("c3", "a partial batch is committed on failure", "archive.py",
     [("            except (sqlite3.Error, OSError):\n                self._rollback()", '            except (sqlite3.Error, OSError):\n                self._conn.execute("COMMIT")')]),
    ("c4", "one malformed capture rejects the whole batch", "archive.py",
     [("                for row in rows:\n", '                if rejected:\n                    rejected = [{"index": j, "reason": "malformed"} for j in range(n)]\n                    stubbed, rows = [], []\n                for row in rows:\n')]),
    ("c5", "received counted before the batch is accepted", "archive.py",
     [('            try:\n                self._conn.execute("BEGIN IMMEDIATE")', '            self._received += n\n            try:\n                self._conn.execute("BEGIN IMMEDIATE")')]),
    ("c6", "the content hash has no separator", "archive.py",
     [('topic.encode("utf-8") + b"\\x00" + payload', 'topic.encode("utf-8") + payload')]),
    ("c7", "a payload exactly at the limit is stubbed", "archive.py",
     [("stub = len(payload) > self.max_payload_bytes", "stub = len(payload) >= self.max_payload_bytes")]),
    ("c8", "a batch may hold more than 500 captures", "archive.py",
     [("MAX_BATCH = 500", "MAX_BATCH = 5000")]),
    ("c9", "an unavailable batch is not counted", "archive.py",
     [("            self._unavailable += 1\n", "            pass\n")]),
    ("c10", "stubbed captures are not counted as committed's subset (stubbed not counted)", "archive.py",
     [("                self._stubbed += len(stubbed)", "                pass")]),
    ("c11", "a malformed capture is committed", "archive.py",
     [("                    if payload is None:\n                        rejected.append", "                    if payload is None and False:\n                        rejected.append")]),
    # ---- the buffer ----
    ("b1", "a full buffer grows past its bound instead of counting dropped", "ingester.py",
     [("            if len(self._q) < self.bound:", "            if True:")]),
    ("b2", "a full buffer drops without counting", "ingester.py",
     [("        self._archive.record_dropped(1)\n        return False", "        return False")]),
    ("b3", "a dropped capture is not counted as received", "archive.py",
     [("            self._received += n\n            self._dropped += n", "            self._dropped += n")]),
    ("b4", "a batch leaves the buffer although the archive was unavailable", "ingester.py",
     [("            self._retry = (batch_id, len(batch))\n", "            self._retry = (batch_id, len(batch))\n            self.buffer.discard(len(batch))\n")]),
    ("b5", "the receive path writes to the archive synchronously", "ingester.py",
     [("        self._buffer.put({", "        self._buffer._archive.append('sync-1', [{'source': 'x'}])\n        self._buffer.put({")]),
    ("b6", "stop does not flush the buffer", "ingester.py",
     [("            while len(self.buffer) and not deadline.is_set():", "            while False:")]),
]


def run_tests():
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    try:
        p = subprocess.run([sys.executable, "-m", "pytest", "-q", "-x", "-p", "no:cacheprovider", "-m", "not integration"],
                           cwd=ROOT, capture_output=True, text=True, env=env, timeout=120)
    except subprocess.TimeoutExpired:  # a mutant that makes the suite hang is caught too
        return 124, "FAILED (timeout: the suite hung under this mutant)"
    return p.returncode, p.stdout + p.stderr


def main():
    rc, out = run_tests()
    if rc != 0:
        print("control run (unmutated) fails; fix the tests first\n" + out[-2000:])
        return 2
    print("control run: unmutated tree passes")
    only = set(sys.argv[1:])
    todo = [m for m in MUTANTS if not only or m[0] in only]
    survivors = []
    with tempfile.TemporaryDirectory() as tmp:
        for mid, desc, fname, edits in todo:
            path = SRC / fname
            backup = pathlib.Path(tmp) / f"{mid}-{fname}"
            shutil.copy2(path, backup)
            try:
                text = original = path.read_text()
                for old, new in edits:
                    if text.count(old) != 1:
                        print(f"{mid}: pattern not found exactly once ({text.count(old)}): {old[:60]!r}")
                        survivors.append(mid)
                        break
                    text = text.replace(old, new)
                else:
                    path.write_text(text)
                    if filecmp.cmp(path, backup, shallow=False):
                        print(f"{mid}: the edit did not change the file")
                        survivors.append(mid)
                        continue
                    rc, out = run_tests()
                    failed = [ln for ln in out.splitlines() if ln.startswith("FAILED")]
                    if rc == 0:
                        survivors.append(mid)
                        print(f"{mid}: SURVIVED  {desc}")
                    else:
                        first = failed[0].split(" - ")[0] if failed else "(collection or crash)"
                        print(f"{mid}: killed    {desc}\n        by {first}")
            finally:
                shutil.copy2(backup, path)
                if not filecmp.cmp(path, backup, shallow=False):
                    print(f"{mid}: RESTORE FAILED for {fname}")
                    survivors.append(mid)
    rc, _ = run_tests()
    print("restored; control run " + ("passes" if rc == 0 else "FAILS"))
    total = len(todo)
    print(f"{total - len(survivors)} of {total} mutants killed")
    return 1 if survivors or rc != 0 else 0


if __name__ == "__main__":
    sys.exit(main())
